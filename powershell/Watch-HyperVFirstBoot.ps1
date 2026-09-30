#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

function Write-WatcherLog {
    param([string]$Message)
    try {
        $logPath=[System.IO.Path]::ChangeExtension($ConfigPath,'.log')
        Add-Content -LiteralPath $logPath -Value ("{0} {1}" -f (Get-Date).ToString('o'),$Message) -Encoding UTF8
    } catch {}
}
function Is-HealthyHeartbeat([object]$Heartbeat) {
    if($null -eq $Heartbeat){ return $false }
    $s=([string]$Heartbeat.PrimaryStatusDescription).Trim()
    return $s -match '(?i)\bOK\b|operational|healthy'
}
function Restore-NormalBoot([string]$Name,[int]$Generation) {
    if($Generation -eq 2) {
        $disk=Get-VMHardDiskDrive -VMName $Name -ErrorAction Stop | Sort-Object ControllerType,ControllerNumber,ControllerLocation | Select-Object -First 1
        if(-not $disk){ throw "No VM hard disk was found for '$Name'." }
        # Use the actual hard-disk component as FirstBootDevice instead of rebuilding
        # the entire BootOrder from potentially stale VMComponentObject instances.
        # This preserves Hyper-V's other firmware entries while making the installed
        # OS disk the normal first boot source.
        Set-VMFirmware -VMName $Name -FirstBootDevice $disk -WarningAction SilentlyContinue -ErrorAction Stop
    } else {
        Set-VMBios -VMName $Name -StartupOrder IDE,CD,LegacyNetworkAdapter,Floppy -ErrorAction Stop
    }
}

$lockStream=$null
try {
    if(-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)){ return }
    $cfg=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Import-Module Hyper-V -ErrorAction Stop
    $lockPath="$ConfigPath.lock"
    try { $lockStream=[System.IO.File]::Open($lockPath,[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None) } catch { return }

    $vmName=[string]$cfg.VmName
    $generation=[int]$cfg.Generation
    $deadline=(Get-Date).AddMinutes([int]($cfg.TimeoutMinutes | ForEach-Object { if($_ -gt 0){$_}else{10080} }))
    $seenRunning=$false
    $heartbeatHealthySeen=$false
    $guestRebootObserved=$false
    [TimeSpan]$lastUptime=[TimeSpan]::Zero
    $haveUptime=$false
    Write-WatcherLog "Watcher started for VM '$vmName' (Generation $generation). ISO will remain mounted; watcher only restores normal boot order after the first guest reboot/power-off."

    while((Get-Date) -lt $deadline) {
        try { $vm=Get-VM -Name $vmName -ErrorAction Stop } catch { Write-WatcherLog "VM '$vmName' is unavailable; watcher will exit."; break }

        if($vm.State -eq 'Running') {
            if(-not $seenRunning) { $seenRunning=$true; Write-WatcherLog "VM '$vmName' reached Running state." }
            try {
                $hb=Get-VMIntegrationService -VMName $vmName -Name 'Heartbeat' -ErrorAction Stop
                $healthy=Is-HealthyHeartbeat $hb
                if($healthy -and -not $heartbeatHealthySeen) { $heartbeatHealthySeen=$true; Write-WatcherLog "Guest heartbeat is healthy; monitoring for the first reboot transition." }

                # Hyper-V's VM Uptime resets when the guest OS reboots even though the
                # VM remains in the Running state. This is more reliable than waiting
                # for Heartbeat to become unhealthy, which can be missed on fast reboots.
                $uptimeReset=$false
                try {
                    $currentUptime=$vm.Uptime
                    if($heartbeatHealthySeen -and $haveUptime -and $currentUptime -lt $lastUptime) { $uptimeReset=$true }
                    if($currentUptime -is [TimeSpan]) { $lastUptime=$currentUptime; $haveUptime=$true }
                } catch {}

                if($heartbeatHealthySeen -and ((-not $healthy) -or $uptimeReset) -and -not $guestRebootObserved) {
                    $guestRebootObserved=$true
                    Write-WatcherLog "First guest reboot transition detected." 
                    # Some Hyper-V versions allow boot-order changes while the guest is
                    # running; attempt normalization immediately after the reboot signal.
                    # If the host rejects the change while Running, the same watcher will
                    # retry safely after the next VM power-off.
                    try {
                        Restore-NormalBoot -Name $vmName -Generation $generation
                        Write-WatcherLog "Normal boot order restored immediately after the first guest reboot transition."
                        Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue
                        break
                    } catch {
                        Write-WatcherLog "Immediate boot-order normalization deferred until VM power-off: $($_.Exception.Message)"
                    }
                }
            } catch {
                # Heartbeat is optional; state-based restoration below remains available.
            }
        } elseif($seenRunning -and $vm.State -eq 'Off') {
            try {
                Restore-NormalBoot -Name $vmName -Generation $generation
                Write-WatcherLog "Normal boot order restored for '$vmName'."
                Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue
                break
            } catch {
                Write-WatcherLog "Boot-order restoration failed: $($_.Exception.Message)"
                Start-Sleep -Seconds 2
            }
        }
        Start-Sleep -Milliseconds 500
    }
    if(Test-Path -LiteralPath $ConfigPath){ Write-WatcherLog 'Watcher reached its timeout or ended before normal boot restoration could be finalized. The marker was retained for manual recovery.' }
} catch { Write-WatcherLog "Fatal watcher error: $($_.Exception.Message)" }
finally {
    if($lockStream){try{$lockStream.Dispose()}catch{}}
    try{if($lockPath -and (Test-Path -LiteralPath $lockPath)){Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue}}catch{}
    Write-WatcherLog 'Watcher exited.'
}
