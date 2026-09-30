#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('TargetInfo','Switches','Adapters','Inventory','ValidateProvision','ProvisionVM','CreateSwitch','ModifyVM','ModifySwitch','VMAction','EjectISO')][string]$Action,
    [Parameter(Mandatory=$false)][string]$TargetHost = 'localhost',
    [Parameter(Mandatory=$false)][ValidateSet('Integrated','Explicit')][string]$AuthMode = 'Integrated',
    [Parameter(Mandatory=$false)][switch]$UseSSL,
    [Parameter(Mandatory=$false)][string]$ConfigPath,
    [Parameter(Mandatory=$false)][string]$CredentialFile,
    [Parameter(Mandatory=$false)][string]$CancelFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Event {
    param([ValidateSet('info','success','warn','error')][string]$Level='info', [string]$Message)
    ([ordered]@{type='log';level=$Level;message=$Message;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress)
}

function Write-Result {
    param([bool]$Success, [string]$Message='', [object]$Data=$null)
    ([ordered]@{type='result';success=$Success;message=$Message;data=$Data;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress -Depth 12)
}

function Test-CancelRequested {
    if ($CancelFile -and (Test-Path -LiteralPath $CancelFile)) {
        throw 'Operation cancelled. A cancellation request was received from the portal.'
    }
}

function Get-Config {
    if (-not $ConfigPath) { return $null }
    if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Configuration file not found: $ConfigPath" }
    return (Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8) | ConvertFrom-Json
}

function New-TargetSession {
    if ($TargetHost -in @('localhost','127.0.0.1','.')) { return $null }

    $credential = $null
    if ($AuthMode -eq 'Explicit') {
        if (-not $CredentialFile -or -not (Test-Path -LiteralPath $CredentialFile)) { throw 'Explicit authentication was selected, but the protected credential file is unavailable.' }
        $credential = Import-Clixml -LiteralPath $CredentialFile
        if (-not ($credential -is [System.Management.Automation.PSCredential])) { throw 'Credential file did not contain a PSCredential.' }
    }

    $sessionOption = New-PSSessionOption -OpenTimeout 15000 -OperationTimeout 30000 -CancelTimeout 5000
    $lastError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            # Write connection diagnostics directly to stdout without adding them to the function
            # return value. Returning a log string alongside the PSSession would make
            # `$session = New-TargetSession` become System.Object[] and break Invoke-Command.
            [Console]::Out.WriteLine((Write-Event info "Connecting to target host '$TargetHost' (attempt $attempt of 3)..."))
            # Explicit credentials always use the Negotiate authentication mechanism.
            # Negotiate works for both Integrated Windows authentication and an explicit PSCredential.
            # For IP targets over HTTP, the client must already trust the target (TrustedHosts).
            $wsman = @{ComputerName=$TargetHost; ErrorAction='Stop'; Authentication='Negotiate'}
            if ($UseSSL) { $wsman.UseSSL = $true }
            if ($credential) { $wsman.Credential = $credential }
            Test-WSMan @wsman | Out-Null

            $params = @{ComputerName=$TargetHost; ErrorAction='Stop'; SessionOption=$sessionOption; Authentication='Negotiate'}
            if ($UseSSL) { $params.UseSSL = $true }
            if ($credential) { $params.Credential = $credential }
            return (New-PSSession @params)
        } catch {
            $lastError = $_.Exception.Message
            if ($attempt -lt 3) { Start-Sleep -Milliseconds (500 * $attempt) }
        }
    }
    throw "Unable to connect to '$TargetHost' after 3 attempts. Last error: $lastError"
}

function Invoke-Target {
    param([System.Management.Automation.Runspaces.PSSession]$Session,[scriptblock]$ScriptBlock,[object[]]$ArgumentList=@())
    Test-CancelRequested
    if ($null -eq $Session) { return (& $ScriptBlock @ArgumentList) }
    return (Invoke-Command -Session $Session -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList -ErrorAction Stop)
}

function Prepare-FirstBootWatcherScript {
    param([System.Management.Automation.Runspaces.PSSession]$Session)
    $localWatcher = Join-Path (Split-Path -Parent $PSCommandPath) 'Watch-HyperVFirstBoot.ps1'
    if (-not (Test-Path -LiteralPath $localWatcher)) { throw "First-boot watcher script was not found: $localWatcher" }
    if ($null -eq $Session) {
        $dir = Join-Path $env:ProgramData 'HyperV-Web-V3'
        New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop | Out-Null
        $localTarget = Join-Path $dir 'Watch-HyperVFirstBoot.ps1'
        Copy-Item -LiteralPath $localWatcher -Destination $localTarget -Force -ErrorAction Stop
        return $localTarget
    }
    $commonData = Invoke-Target $Session { [Environment]::GetFolderPath('CommonApplicationData') }
    $dir = Join-Path ([string]$commonData) 'HyperV-Web-V3'
    Invoke-Target $Session { param($d) New-Item -ItemType Directory -Path $d -Force -ErrorAction Stop | Out-Null } @($dir) | Out-Null
    $remoteWatcher = Join-Path $dir 'Watch-HyperVFirstBoot.ps1'
    Copy-Item -LiteralPath $localWatcher -Destination $remoteWatcher -ToSession $Session -Force -ErrorAction Stop
    return $remoteWatcher
}

function Get-Inventory {
    param([System.Management.Automation.Runspaces.PSSession]$Session)
    $script = {
        $ErrorActionPreference='Stop'
        Import-Module Hyper-V -ErrorAction Stop
        if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) { throw 'Hyper-V PowerShell module is not available on the target host.' }

        $warnings = New-Object System.Collections.Generic.List[string]
        $adapterSource = 'NetAdapter'
        $os = $null; $cs = $null
        try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch { $warnings.Add("Operating-system information unavailable: $($_.Exception.Message)") }
        try { $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop } catch { $warnings.Add("Computer-system information unavailable: $($_.Exception.Message)") }

        try { $vms = @(Get-VM -ErrorAction Stop | Sort-Object Name) }
        catch { throw "Get-VM failed on target host '$env:COMPUTERNAME': $($_.Exception.Message)" }

        try {
            $switches = @(Get-VMSwitch -ErrorAction Stop | Sort-Object Name | ForEach-Object {
                [pscustomobject]@{
                    Name=$_.Name
                    SwitchType=$_.SwitchType.ToString()
                    NetAdapterName=$_.NetAdapterName
                    AllowManagementOS=[bool]$_.AllowManagementOS
                    Notes=$_.Notes
                }
            })
        } catch {
            $warnings.Add("Virtual-switch inventory unavailable: $($_.Exception.Message)")
            $switches = @()
        }

        try {
            $adapters = @(Get-NetAdapter -ErrorAction Stop | Sort-Object Status,Name | ForEach-Object {
                [pscustomobject]@{
                    Name=$_.Name
                    InterfaceDescription=$_.InterfaceDescription
                    LinkSpeed=([string]$_.LinkSpeed)
                    Status=$_.Status.ToString()
                    MacAddress=$_.MacAddress
                    Source='NetAdapter'
                }
            })
        } catch {
            $adapters = @()
            try {
                $cimAdapters = @(Get-CimInstance -ClassName Win32_NetworkAdapter -Filter "NetConnectionID IS NOT NULL" -ErrorAction Stop | Sort-Object NetConnectionID)
                $adapters = @($cimAdapters | ForEach-Object {
                    [pscustomobject]@{
                        Name=[string]$_.NetConnectionID
                        InterfaceDescription=[string]$_.Name
                        LinkSpeed=$(if($_.Speed){([int64]$_.Speed / 1MB).ToString('0.##') + ' Mbps'}else{''})
                        Status=$(if($_.NetConnectionStatus -eq 2){'Up'}else{'Down'})
                        MacAddress=[string]$_.MACAddress
                        Source='Win32_NetworkAdapter'
                    }
                })
                $adapterSource = 'Win32_NetworkAdapter'
            } catch {
                $warnings.Add("Physical-adapter inventory unavailable: $($_.Exception.Message)")
                if ($_.Exception.Message -match '(?i)access is denied|access denied') {
                    $warnings.Add('External virtual-switch creation may be unavailable for this account: both NetAdapter and Win32_NetworkAdapter queries were denied.')
                }
            }
        }


        $allVmNics = @()
        try { $allVmNics = @(Get-VMNetworkAdapter -All -ErrorAction Stop | Where-Object { $_.VMName }) }
        catch { $warnings.Add("VM network-adapter inventory unavailable: $($_.Exception.Message)") }

        $allVmDisks = @()
        try {
            $allVmDisks = @(foreach($vmItem in $vms) {
                try { @(Get-VMHardDiskDrive -VMName $vmItem.Name -ErrorAction Stop | ForEach-Object {
                    $vhd = $null
                    try { $vhd = Get-VHD -Path $_.Path -ErrorAction Stop } catch {}
                    [pscustomobject]@{
                        VMName=$vmItem.Name
                        ControllerType=[string]$_.ControllerType
                        ControllerNumber=[int]$_.ControllerNumber
                        ControllerLocation=[int]$_.ControllerLocation
                        Path=[string]$_.Path
                        SizeGB=$(if($vhd){[math]::Round(([double]$vhd.Size / 1GB),2)}else{$null})
                        FileSizeGB=$(if($vhd){[math]::Round(([double]$vhd.FileSize / 1GB),2)}else{$null})
                        VhdType=$(if($vhd){[string]$vhd.VhdType}else{''})
                    }
                }) } catch { $warnings.Add("Virtual-disk inventory unavailable for VM '$($vmItem.Name)': $($_.Exception.Message)") }
            })
        } catch { $warnings.Add("Virtual-disk inventory unavailable: $($_.Exception.Message)") }

        $allDvds = @()
        try { $allDvds = @(Get-VMDvdDrive -VMName * -ErrorAction SilentlyContinue) }
        catch { $warnings.Add("Virtual DVD inventory unavailable: $($_.Exception.Message)") }

        $vmRows = @($vms | ForEach-Object {
            $vm = $_
            $nics = @($allVmNics | Where-Object { $_.VMName -eq $vm.Name })
            $dvd = @($allDvds | Where-Object { $_.VMName -eq $vm.Name } | Select-Object -First 1)
            $disks = @($allVmDisks | Where-Object { $_.VMName -eq $vm.Name })
            $ips = @($nics | ForEach-Object { $_.IPAddresses } | Where-Object { $_ })
            $networkAdapters = @($nics | ForEach-Object {
                [pscustomobject]@{
                    Name=[string]$_.Name
                    SwitchName=[string]$_.SwitchName
                    MacAddress=[string]$_.MacAddress
                    IPAddresses=@($_.IPAddresses | Where-Object { $_ })
                }
            })
            [pscustomobject]@{
                Name=$vm.Name
                State=$vm.State.ToString()
                Status=$vm.Status
                Generation=[int]$vm.Generation
                Version=[string]$vm.Version
                Uptime=$(if($vm.State -eq 'Running'){[string]$vm.Uptime}else{''})
                CPUCount=[int]$vm.ProcessorCount
                CPUUsage=[int]$vm.CPUUsage
                MemoryAssignedMB=[math]::Round(([double]$vm.MemoryAssigned / 1MB),0)
                MemoryStartupMB=[math]::Round(([double]$vm.MemoryStartup / 1MB),0)
                DynamicMemoryEnabled=[bool]$vm.DynamicMemoryEnabled
                MinimumMemoryMB=[math]::Round(([double]$vm.MemoryMinimum / 1MB),0)
                MaximumMemoryMB=[math]::Round(([double]$vm.MemoryMaximum / 1MB),0)
                Path=[string]$vm.Path
                DVDPath=$(if($dvd){[string]$dvd.Path}else{''})
                Disks=$disks
                NetworkAdapters=$networkAdapters
                Switches=@($nics | ForEach-Object { $_.SwitchName } | Where-Object { $_ } | Select-Object -Unique)
                MACAddresses=@($nics | ForEach-Object { $_.MacAddress } | Where-Object { $_ } | Select-Object -Unique)
                IPAddresses=$ips
                IntegrationServices=$(try { @(Get-VMIntegrationService -VMName $vm.Name | Select-Object Name,Enabled,PrimaryStatusDescription,SecondaryStatusDescription) } catch { @() })
            }
        })

        [pscustomobject]@{
            ComputerName=$env:COMPUTERNAME
            OS=if($os){$os.Caption}else{''}
            OSVersion=if($os){$os.Version}else{''}
            Manufacturer=if($cs){$cs.Manufacturer}else{''}
            Model=if($cs){$cs.Model}else{''}
            HyperVModule=$true
            PSVersion=$PSVersionTable.PSVersion.ToString()
            Warnings=@($warnings)
            Switches=$switches
            Adapters=$adapters
            AdapterSource=$adapterSource
            VMs=$vmRows
        }
    }
    return (Invoke-Target $Session $script)
}

function Test-ProvisionConfig {
    param($Config,[System.Management.Automation.Runspaces.PSSession]$Session)
    Write-Output (Write-Event info 'Running pre-flight validation on the target host...')
    Test-CancelRequested
    if (-not $Config.vmName -or $Config.vmName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$') { throw 'VM name is invalid.' }
    if ($Config.generation -notin 1,2) { throw 'Generation must be 1 or 2.' }
    if ([int]$Config.cpuCount -lt 1 -or [int]$Config.cpuCount -gt 64) { throw 'CPU count must be between 1 and 64.' }
    if ([int]$Config.memoryMB -lt 512 -or [int]$Config.memoryMB -gt 1048576) { throw 'Startup memory is outside the supported safety range.' }
    if ([int]$Config.diskSizeGB -lt 10 -or [int]$Config.diskSizeGB -gt 65536) { throw 'Disk size must be between 10 GB and 65536 GB.' }
    if ($Config.diskType -notin @('Dynamic','Fixed')) { throw 'Disk type is invalid.' }
    if ($Config.vlanTagging -and ([int]$Config.vlanId -lt 1 -or [int]$Config.vlanId -gt 4094)) { throw 'VLAN ID must be between 1 and 4094.' }
    if ($Config.generation -eq 1 -and ($Config.secureBoot -or $Config.enableVTPM)) { throw 'Secure Boot and vTPM require Generation 2.' }

    $script = {
        param($Json)
        $c = $Json | ConvertFrom-Json
        $ErrorActionPreference='Stop'
        Import-Module Hyper-V -ErrorAction Stop
        if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) { throw 'Hyper-V PowerShell module is not available on the target host.' }
        if (Get-VM -Name $c.vmName -ErrorAction SilentlyContinue) { throw "A VM named '$($c.vmName)' already exists on the target host." }
        if (-not (Get-VMSwitch -Name $c.vSwitch -ErrorAction SilentlyContinue)) { throw "Virtual switch '$($c.vSwitch)' was not found on the target host." }

        $basePath = $c.storagePath.TrimEnd('\')
        $existing = Get-Item -LiteralPath $basePath -ErrorAction SilentlyContinue
        if ($existing) {
            if (-not $existing.PSIsContainer) { throw "Storage path is not a directory: $basePath" }
            $resolvedBase = $existing.FullName.TrimEnd('\')
        } else {
            $parent = Split-Path -Path $basePath -Parent
            if (-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)) { throw "Storage path does not exist and its parent is unavailable on the target host: $basePath" }
            $resolvedBase = $basePath
        }
        $vmPath = Join-Path $resolvedBase $c.vmName
        if (Test-Path -LiteralPath $vmPath) { throw "The planned VM directory already exists on the target host: $vmPath" }

        $root = [System.IO.Path]::GetPathRoot($resolvedBase)
        if ($root -match '^[A-Za-z]:\\?$') {
            $driveName = $root.Substring(0,1)
            $drive = Get-PSDrive -Name $driveName -ErrorAction SilentlyContinue
            $requiredBytes = [int64]$c.diskSizeGB * 1GB
            if ($drive -and $drive.Free -lt $requiredBytes) { throw "Target storage has less free space than the requested maximum VHDX size." }
        }

        if ($c.isoPath) {
            if ([System.IO.Path]::GetExtension($c.isoPath).ToLowerInvariant() -ne '.iso') { throw 'Installation media must be an .iso file.' }
            if (-not (Test-Path -LiteralPath $c.isoPath -PathType Leaf)) { throw "ISO file was not found on the target host: $($c.isoPath)" }
        }
        if ($c.generation -eq 2 -and $c.secureBoot -and -not (Get-Command Set-VMFirmware -ErrorAction SilentlyContinue)) { throw 'Set-VMFirmware is unavailable; Secure Boot cannot be configured.' }
        if ($c.generation -eq 1 -and $c.isoPath -and -not (Get-Command Set-VMBios -ErrorAction SilentlyContinue)) { throw 'Set-VMBios is unavailable; Generation 1 ISO-first boot cannot be configured.' }
        if ($c.enableVTPM) {
            if (-not (Get-Command Enable-VMTPM -ErrorAction SilentlyContinue)) { throw 'Enable-VMTPM is unavailable on this Hyper-V host.' }
            if (-not (Get-Command Set-VMKeyProtector -ErrorAction SilentlyContinue)) { throw 'Set-VMKeyProtector is unavailable on this Hyper-V host.' }
        }

        [pscustomobject]@{VmPath=$vmPath;StoragePath=$resolvedBase;IsoPath=$c.isoPath;FreeSpaceGB=$(if($root -match '^[A-Za-z]:\\?$' -and $drive){[math]::Round($drive.Free/1GB,1)}else{$null});BootFromIsoFirst=[bool]($c.isoPath -and $c.bootFromIsoFirst)}
    }
    return (Invoke-Target $Session $script @($Config | ConvertTo-Json -Compress -Depth 10))
}

function Invoke-Provision {
    param($Config,[System.Management.Automation.Runspaces.PSSession]$Session,[string]$WatcherScriptPath)
    $script = {
        param($Json, $CancelFileInner, $WatcherScriptPathInner)
        $c = $Json | ConvertFrom-Json
        $ErrorActionPreference='Stop'
        Import-Module Hyper-V -ErrorAction Stop
        function CheckCancel { if ($CancelFileInner -and (Test-Path -LiteralPath $CancelFileInner)) { throw 'Operation cancelled. Rollback will be attempted.' } }
        function Log([string]$level,[string]$message){ @{type='log';level=$level;message=$message;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress }
        function Write-Result {
            param([bool]$Success,[string]$Message='', [object]$Data=$null)
            ([ordered]@{type='result';success=$Success;message=$Message;data=$Data;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress -Depth 12)
        }
        function StartWatcher([string]$scriptPath,[string]$markerPath) {
            if (-not (Test-Path -LiteralPath $scriptPath)) { throw "First-boot watcher script was not found: $scriptPath" }
            $argString='-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}"' -f $scriptPath,$markerPath
            Start-Process -FilePath 'powershell.exe' -ArgumentList $argString -WindowStyle Hidden -WorkingDirectory (Split-Path -Parent $markerPath) -ErrorAction Stop | Out-Null
        }
        function Test-DvdFirstBoot([object]$Firmware,[object]$Dvd) {
            $first = @($Firmware.BootOrder) | Select-Object -First 1
            if ($null -eq $first) { return $false }
            $isDvd = ($first.GetType().FullName -eq 'Microsoft.HyperV.PowerShell.DvdDrive')
            if (-not $isDvd -and ($first.PSObject.Properties.Name -contains 'BootType')) { $isDvd = ([string]$first.BootType -eq 'DvdDrive') }
            if (-not $isDvd) { return $false }
            if (($first.PSObject.Properties.Name -contains 'Path') -and ($Dvd.PSObject.Properties.Name -contains 'Path')) {
                return ([string]$first.Path -eq [string]$Dvd.Path)
            }
            return $true
        }

        $basePath = $c.storagePath.TrimEnd('\')
        $existingBase = Get-Item -LiteralPath $basePath -ErrorAction SilentlyContinue
        if ($existingBase) { $basePath = $existingBase.FullName.TrimEnd('\') }
        else { New-Item -ItemType Directory -Path $basePath -Force -ErrorAction Stop | Out-Null }
        $baseCreated = -not [bool]$existingBase
        $vmRoot = Join-Path $basePath $c.vmName
        $vmRootCreated = $false
        $vhdPath = Join-Path (Join-Path $vmRoot 'Virtual Hard Disks') ($c.vmName + '.vhdx')
        $vmCreated = $false
        $vhdCreated = $false
        $bootMarkerPath = $null

        try {
            CheckCancel
            if (Get-VM -Name $c.vmName -ErrorAction SilentlyContinue) { throw "A VM named '$($c.vmName)' already exists." }
            if (-not (Get-VMSwitch -Name $c.vSwitch -ErrorAction SilentlyContinue)) { throw "Virtual switch '$($c.vSwitch)' does not exist." }
            New-Item -ItemType Directory -Path (Join-Path $vmRoot 'Virtual Hard Disks') -Force -ErrorAction Stop | Out-Null
            $vmRootCreated = $true
            CheckCancel

            Write-Output (Log 'info' "Creating Generation $($c.generation) VM '$($c.vmName)'...")
            New-VM -Name $c.vmName -Generation ([int]$c.generation) -MemoryStartupBytes ([int64]$c.memoryMB * 1MB) -SwitchName $c.vSwitch -Path $basePath -ErrorAction Stop | Out-Null
            $vmCreated = $true
            $createdVm = Get-VM -Name $c.vmName -ErrorAction Stop
            $bootMarkerPath = Join-Path $createdVm.Path '.hyperv-web-v2-firstboot.json'
            Set-VMProcessor -VMName $c.vmName -Count ([int]$c.cpuCount) -ErrorAction Stop
            # Startup memory is static; Dynamic Memory is intentionally not exposed or configured by this version.
            Write-Output (Log 'success' "VM hardware configured: $($c.cpuCount) vCPU, $($c.memoryMB) MB startup RAM.")
            CheckCancel

            $diskParams=@{Path=$vhdPath;SizeBytes=([int64]$c.diskSizeGB * 1GB);ErrorAction='Stop'}
            if ($c.diskType -eq 'Fixed') { $diskParams.Fixed=$true } else { $diskParams.Dynamic=$true }
            New-VHD @diskParams | Out-Null
            $vhdCreated=$true
            Add-VMHardDiskDrive -VMName $c.vmName -Path $vhdPath -ErrorAction Stop | Out-Null
            Write-Output (Log 'success' "VHDX created and attached: $vhdPath")
            CheckCancel

            if ($c.vlanTagging) {
                Set-VMNetworkAdapterVlan -VMName $c.vmName -Access -VlanId ([int]$c.vlanId) -ErrorAction Stop
                Write-Output (Log 'success' "Access VLAN $($c.vlanId) configured.")
            }

            if ($c.generation -eq 2) {
                # Avoid the noisy/non-fatal 'already in the specified state' message
                # by changing Secure Boot only when the current state differs.
                $currentFirmware = Get-VMFirmware -VMName $c.vmName -ErrorAction Stop
                $desiredSecureBoot = if ($c.secureBoot) { 'On' } else { 'Off' }
                $secureBootState = [string]$currentFirmware.SecureBoot
                if ($secureBootState -ne $desiredSecureBoot) {
                    if ($c.secureBoot) { Set-VMFirmware -VMName $c.vmName -EnableSecureBoot On -SecureBootTemplate $c.secureBootTemplate -ErrorAction Stop }
                    else { Set-VMFirmware -VMName $c.vmName -EnableSecureBoot Off -ErrorAction Stop }
                } elseif ($c.secureBoot) {
                    # Secure Boot is already On; ensure the requested Windows template is applied.
                    $template = [string]$currentFirmware.SecureBootTemplate
                    if ($template -ne $c.secureBootTemplate) {
                        Set-VMFirmware -VMName $c.vmName -SecureBootTemplate $c.secureBootTemplate -ErrorAction Stop
                    }
                }
                Write-Output (Log 'success' "Generation 2 firmware configured; Secure Boot: $($c.secureBoot).")
                if ($c.enableVTPM) {
                    Set-VMKeyProtector -VMName $c.vmName -NewLocalKeyProtector -ErrorAction Stop | Out-Null
                    Enable-VMTPM -VMName $c.vmName -ErrorAction Stop | Out-Null
                    Write-Output (Log 'success' 'Virtual TPM enabled.')
                }
            }
            CheckCancel

            $originalBootPrepared = $false
            if ($c.isoPath) {
                if (-not (Test-Path -LiteralPath $c.isoPath -PathType Leaf)) { throw "ISO file is no longer available on the target host: $($c.isoPath)" }
                Write-Output (Log 'info' "Preparing DVD drive and attaching installation ISO...")
                $dvd = Get-VMDvdDrive -VMName $c.vmName -ErrorAction SilentlyContinue | Select-Object -First 1
                if (-not $dvd) {
                    # Add the DVD drive and media in one Hyper-V operation. This follows
                    # Microsoft's documented provisioning pattern and avoids a transient
                    # empty DVD-drive state that can produce 0x80070490 on some hosts.
                    $dvd = Add-VMDvdDrive -VMName $c.vmName -Path $c.isoPath -ErrorAction Stop | Select-Object -First 1
                } else {
                    Set-VMDvdDrive -VMName $c.vmName -Path $c.isoPath -ErrorAction Stop
                }
                # Refresh the DVD object after mounting the ISO. A stale DvdDrive object can
                # otherwise cause FirstBootDevice to be ignored on some Hyper-V builds.
                $dvd = Get-VMDvdDrive -VMName $c.vmName -ErrorAction Stop | Where-Object { [string]$_.Path -eq [string]$c.isoPath } | Select-Object -First 1
                if (-not $dvd) { throw "The ISO was mounted but the VM DVD drive could not be refreshed." }
                if ($c.bootFromIsoFirst) {
                    if ($c.generation -eq 2) {
                        # Hyper-V accepts the DVDDrive object directly for FirstBootDevice.
                        # Do not rebuild the complete BootOrder here: on some Windows/Hyper-V
                        # builds a newly-created VM can reject a mixed/stale VMComponentObject
                        # array with 0x80070490 (Element not found). FirstBootDevice is sufficient.
                        $bootApplied = $false
                        $lastBootError = $null
                        for ($attempt = 1; $attempt -le 2 -and -not $bootApplied; $attempt++) {
                            try {
                                $dvd = Get-VMDvdDrive -VMName $c.vmName -ErrorAction Stop |
                                    Where-Object { $_.Path -and ([string]$_.Path -eq [string]$c.isoPath) } |
                                    Select-Object -First 1
                                if (-not $dvd) { throw "The VM DVD drive with the requested ISO was not found after ISO attachment." }
                                Set-VMFirmware -VMName $c.vmName -FirstBootDevice $dvd -WarningAction SilentlyContinue -ErrorAction Stop
                                $bootApplied = $true
                            } catch {
                                $lastBootError = $_.Exception.Message
                                if ($attempt -lt 2) { Start-Sleep -Milliseconds 750 }
                            }
                        }
                        if (-not $bootApplied) { throw "Unable to set Generation 2 DVD/ISO as the first boot device: $lastBootError" }

                        # Read back the firmware for diagnostics, but do not treat an
                        # unrecognized component shape as a reason to rewrite BootOrder.
                        $verify = Get-VMFirmware -VMName $c.vmName -ErrorAction Stop
                        $first = @($verify.BootOrder) | Select-Object -First 1
                        $firstDescription = if ($first) {
                            if (($first.PSObject.Properties.Name -contains 'Path') -and $first.Path) { "$( $first.GetType().Name ):$($first.Path)" }
                            else { [string]$first.GetType().Name }
                        } else { '<none>' }
                        Write-Output (Log 'success' "Generation 2 firmware set to DVD first for the first power-on. Verified firmware first entry: $firstDescription. The target-side watcher will restore the normal hard-disk-first boot source after the first guest reboot/power-off. The ISO remains mounted until explicitly ejected.")
                    } else {
                        Set-VMBios -VMName $c.vmName -StartupOrder CD,IDE,LegacyNetworkAdapter,Floppy -ErrorAction Stop
                        $bios = Get-VMBios -VMName $c.vmName -ErrorAction Stop
                        $startup = @($bios.StartupOrder)
                        if (-not ($startup.Count -gt 0 -and [string]$startup[0] -eq 'CD')) { throw 'Unable to verify that the Generation 1 CD/DVD is the first boot device.' }
                        Write-Output (Log 'success' 'Generation 1 BIOS verified: CD/DVD is first for the first power-on. The target-side watcher will normalize the IDE boot order after the first guest reboot or VM power-off. The ISO remains mounted until explicitly ejected.')
                    }
                    $marker = [pscustomobject]@{ VmName=[string]$c.vmName; Generation=[int]$c.generation; IsoPath=[string]$c.isoPath; CreatedAt=(Get-Date).ToString('o'); TimeoutMinutes=10080; Status='PendingFirstBoot' }
                    $marker | ConvertTo-Json -Compress | Set-Content -LiteralPath $bootMarkerPath -Encoding UTF8 -Force
                    StartWatcher -scriptPath $WatcherScriptPathInner -markerPath $bootMarkerPath
                    $originalBootPrepared = $true
                    Write-Output (Log 'success' 'First-boot watcher armed on the target host. It monitors guest heartbeat/reboot and VM shutdown so the ISO is only used for the installation boot and the normal VHD/IDE boot order is restored.')
                }
                Write-Output (Log 'success' "Installation ISO attached: $($c.isoPath)")
            }
            CheckCancel

            $vm = Get-VM -Name $c.vmName -ErrorAction Stop
            Write-Output (Log 'success' "VM '$($c.vmName)' is left Off after provisioning. Use Start from the VM inventory to begin installation.")
            Write-Output (Write-Result $true "VM '$($c.vmName)' provisioned successfully; VM is Off." @{vmName=$vm.Name;state=$vm.State.ToString();path=$vm.Path;vhdx=$vhdPath;isoPath=$c.isoPath;bootFromIsoFirst=[bool]($c.isoPath);bootOrderRestored=$false;firstBootMode=$(if($originalBootPrepared){'DVD-first-pending-watcher'}else{'Normal'})})
        } catch {
            $err=$_.Exception.Message
            Write-Output (Log 'error' $err)
            if ($c.rollbackOnFailure -and $vmCreated) {
                try { Stop-VM -Name $c.vmName -Force -ErrorAction SilentlyContinue | Out-Null } catch {}
                try { Remove-VM -Name $c.vmName -Force -ErrorAction SilentlyContinue } catch {}
                if ($vhdCreated -and $vhdPath -and (Test-Path -LiteralPath $vhdPath)) { try { Remove-Item -LiteralPath $vhdPath -Force -ErrorAction SilentlyContinue } catch {} }
                if ($bootMarkerPath -and (Test-Path -LiteralPath $bootMarkerPath)) { try { Remove-Item -LiteralPath $bootMarkerPath -Force -ErrorAction SilentlyContinue } catch {} }
                if ($vmRootCreated -and (Test-Path -LiteralPath $vmRoot)) { try { if (-not (Get-ChildItem -LiteralPath $vmRoot -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $vmRoot -Force -ErrorAction SilentlyContinue } } catch {} }
                if ($baseCreated -and (Test-Path -LiteralPath $basePath)) { try { if (-not (Get-ChildItem -LiteralPath $basePath -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $basePath -Force -ErrorAction SilentlyContinue } } catch {} }
                Write-Output (Log 'warn' 'Rollback attempted for resources created by this job.')
            }
            Write-Output (Write-Result $false $err $null)
            exit 1
        }
    }
    $json = $Config | ConvertTo-Json -Compress -Depth 10
    return (Invoke-Target $Session $script @($json, $CancelFile, $WatcherScriptPath))
}

function Invoke-CreateSwitch {
    param($Config,[System.Management.Automation.Runspaces.PSSession]$Session)
    $script = {
        param($Json,$CancelFileInner)
        $c=$Json|ConvertFrom-Json
        $ErrorActionPreference='Stop'
        if($CancelFileInner -and (Test-Path -LiteralPath $CancelFileInner)){throw 'Operation cancelled before switch creation.'}
        Import-Module Hyper-V -ErrorAction Stop
        function Write-Event {
            param([ValidateSet('info','success','warn','error')][string]$Level='info',[string]$Message)
            ([ordered]@{type='log';level=$Level;message=$Message;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress)
        }
        function Write-Result {
            param([bool]$Success,[string]$Message='', [object]$Data=$null)
            ([ordered]@{type='result';success=$Success;message=$Message;data=$Data;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress -Depth 12)
        }
        if($c.name -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$'){throw 'Switch name contains unsupported characters.'}
        if($c.type -notin @('External','Internal','Private')){throw 'Switch type is invalid.'}
        if(Get-VMSwitch -Name $c.name -ErrorAction SilentlyContinue){throw "A virtual switch named '$($c.name)' already exists."}
        if($c.type -eq 'External'){
            if([string]::IsNullOrWhiteSpace($c.adapter)){throw 'A physical adapter is required for an External switch.'}
            try {
                $adapter=Get-NetAdapter -Name $c.adapter -ErrorAction Stop
                if($adapter.Status -ne 'Up'){throw "Physical adapter '$($c.adapter)' is not currently Up."}
            } catch {
                try {
                    $safeName=$c.adapter.Replace("'","''")
                    $adapterCim = Get-CimInstance -ClassName Win32_NetworkAdapter -Filter ("NetConnectionID = '{0}'" -f $safeName) -ErrorAction Stop | Select-Object -First 1
                    if(-not $adapterCim){throw "Physical adapter '$($c.adapter)' was not found."}
                    if($adapterCim.NetConnectionStatus -ne 2){throw "Physical adapter '$($c.adapter)' is not currently Up."}
                } catch {
                    if ($_.Exception.Message -match '(?i)access is denied|access denied') {
                        throw "Cannot query physical adapter '$($c.adapter)' on target host: Access Denied. The remote account needs host-level network-administration rights to create/manage an External Hyper-V switch."
                    }
                    throw "Unable to query physical adapter '$($c.adapter)': $($_.Exception.Message)"
                }
            }
            New-VMSwitch -Name $c.name -NetAdapterName $c.adapter -AllowManagementOS $true -ErrorAction Stop|Out-Null
        } else { New-VMSwitch -Name $c.name -SwitchType $c.type -ErrorAction Stop|Out-Null }
        Write-Output (Write-Event success "Virtual switch '$($c.name)' created.")
        Write-Output (Write-Result $true "Virtual switch '$($c.name)' created successfully." @{name=$c.name;type=$c.type})
    }
    $json = $Config | ConvertTo-Json -Compress -Depth 5
    return (Invoke-Target $Session $script @($json, $CancelFile))
}

function Invoke-ModifyVM {
    param($Config,[System.Management.Automation.Runspaces.PSSession]$Session)
    $script={
        param($Json,$CancelFileInner)
        $c=$Json|ConvertFrom-Json
        $ErrorActionPreference='Stop'
        Import-Module Hyper-V -ErrorAction Stop
        function Write-Event {
            param([ValidateSet('info','success','warn','error')][string]$Level='info',[string]$Message)
            ([ordered]@{type='log';level=$Level;message=$Message;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress)
        }
        function Write-Result {
            param([bool]$Success,[string]$Message='', [object]$Data=$null)
            ([ordered]@{type='result';success=$Success;message=$Message;data=$Data;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress -Depth 12)
        }
        if($CancelFileInner -and (Test-Path -LiteralPath $CancelFileInner)){throw 'Operation cancelled.'}
        $vm=Get-VM -Name $c.vmName -ErrorAction Stop
        $needsStopped = ($null -ne $c.requestedDiskSizeGB -and [string]$c.requestedDiskSizeGB -ne '') -or -not [string]::IsNullOrWhiteSpace([string]$c.destinationStoragePath)
        if($needsStopped -and $vm.State -ne 'Off') { throw "VM '$($c.vmName)' must be Off before changing disk size or moving VM storage." }

        if($null -ne $c.requestedDiskSizeGB -and [string]$c.requestedDiskSizeGB -ne '') {
            $diskPath=[string]$c.diskPath
            if(-not $diskPath){ throw 'A virtual disk path is required for disk resize.' }
            $vhd=Get-VHD -Path $diskPath -ErrorAction Stop
            $currentGB=[math]::Round(([double]$vhd.Size / 1GB),2)
            $requestedGB=[int64]$c.requestedDiskSizeGB
            if($requestedGB -le $currentGB){ throw "Disk resize is expand-only. Current virtual disk size is $currentGB GB; requested size is $requestedGB GB." }
            Write-Output (Write-Event info "Expanding virtual disk '$diskPath' from $currentGB GB to $requestedGB GB...")
            Resize-VHD -Path $diskPath -SizeBytes ($requestedGB * 1GB) -ErrorAction Stop
            $vhd=Get-VHD -Path $diskPath -ErrorAction Stop
            Write-Output (Write-Event success "Virtual disk expanded to $([math]::Round(([double]$vhd.Size / 1GB),2)) GB.")
        }

        if(-not [string]::IsNullOrWhiteSpace([string]$c.destinationStoragePath)) {
            $destination=[string]$c.destinationStoragePath
            $currentPath=[string]$vm.Path
            $destinationFull=$destination.TrimEnd('\')
            if($destinationFull -eq $currentPath.TrimEnd('\')) { throw 'The destination storage path is already the current VM path.' }
            if(-not (Test-Path -LiteralPath $destinationFull -PathType Container)) {
                $parent=Split-Path -Path $destinationFull -Parent
                if(-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)){ throw "Destination storage path does not exist and its parent is unavailable: $destinationFull" }
                New-Item -ItemType Directory -Path $destinationFull -Force -ErrorAction Stop | Out-Null
            }
            Write-Output (Write-Event info "Moving VM storage to '$destinationFull'...")
            Move-VMStorage -VMName $c.vmName -DestinationStoragePath $destinationFull -ErrorAction Stop
            Write-Output (Write-Event success "VM storage moved to '$destinationFull'.")
            $vm=Get-VM -Name $c.vmName -ErrorAction Stop
        }

        if(-not [string]::IsNullOrWhiteSpace([string]$c.networkAdapterName)) {
            if([string]::IsNullOrWhiteSpace([string]$c.vSwitch)){ throw 'A virtual switch is required for a network change.' }
            $adapter=Get-VMNetworkAdapter -VMName $c.vmName -ErrorAction Stop | Where-Object { [string]$_.Name -eq [string]$c.networkAdapterName } | Select-Object -First 1
            if(-not $adapter){ throw "VM network adapter '$($c.networkAdapterName)' was not found on '$($c.vmName)'." }
            if(-not (Get-VMSwitch -Name $c.vSwitch -ErrorAction SilentlyContinue)){ throw "Virtual switch '$($c.vSwitch)' does not exist." }
            Write-Output (Write-Event info "Connecting network adapter '$($c.networkAdapterName)' to virtual switch '$($c.vSwitch)'...")
            Connect-VMNetworkAdapter -VMNetworkAdapter $adapter -SwitchName $c.vSwitch -ErrorAction Stop
            Write-Output (Write-Event success "Network adapter '$($c.networkAdapterName)' is now connected to '$($c.vSwitch)'.")
        }

        if($CancelFileInner -and (Test-Path -LiteralPath $CancelFileInner)){throw 'Operation cancelled.'}
        $after=Get-VM -Name $c.vmName -ErrorAction Stop
        $diskData=@()
        foreach($hd in @(Get-VMHardDiskDrive -VMName $c.vmName -ErrorAction SilentlyContinue)) {
            $vhd=$null;try{$vhd=Get-VHD -Path $hd.Path -ErrorAction Stop}catch{}
            $diskData += [pscustomobject]@{Path=[string]$hd.Path;SizeGB=$(if($vhd){[math]::Round(([double]$vhd.Size / 1GB),2)}else{$null});VhdType=$(if($vhd){[string]$vhd.VhdType}else{''})}
        }
        $netData=@(Get-VMNetworkAdapter -VMName $c.vmName -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{Name=[string]$_.Name;SwitchName=[string]$_.SwitchName;MacAddress=[string]$_.MacAddress} })
        Write-Output (Write-Result $true "VM '$($c.vmName)' modifications completed successfully." @{vmName=$after.Name;state=$after.State.ToString();path=$after.Path;disks=$diskData;networkAdapters=$netData})
    }
    $json = $Config | ConvertTo-Json -Compress -Depth 8
    return (Invoke-Target $Session $script @($json, $CancelFile))
}

function Invoke-ModifySwitch {
    param($Config,[System.Management.Automation.Runspaces.PSSession]$Session)
    $script={
        param($Json,$CancelFileInner)
        $c=$Json|ConvertFrom-Json
        $ErrorActionPreference='Stop'
        Import-Module Hyper-V -ErrorAction Stop
        function Write-Event {
            param([ValidateSet('info','success','warn','error')][string]$Level='info',[string]$Message)
            ([ordered]@{type='log';level=$Level;message=$Message;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress)
        }
        function Write-Result {
            param([bool]$Success,[string]$Message='', [object]$Data=$null)
            ([ordered]@{type='result';success=$Success;message=$Message;data=$Data;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress -Depth 12)
        }
        if($CancelFileInner -and (Test-Path -LiteralPath $CancelFileInner)){throw 'Operation cancelled.'}
        $sw=Get-VMSwitch -Name $c.name -ErrorAction Stop
        if([string]$c.type -eq 'External') {
            if([string]::IsNullOrWhiteSpace([string]$c.adapter)){throw 'A physical adapter is required for an External switch.'}
            try {
                $adapter=Get-NetAdapter -Name $c.adapter -ErrorAction Stop
                if($adapter.Status -ne 'Up'){throw "Physical adapter '$($c.adapter)' is not currently Up."}
            } catch {
                try {
                    $safeName=$c.adapter.Replace("'","''")
                    $adapterCim=Get-CimInstance -ClassName Win32_NetworkAdapter -Filter ("NetConnectionID = '{0}'" -f $safeName) -ErrorAction Stop | Select-Object -First 1
                    if(-not $adapterCim){throw "Physical adapter '$($c.adapter)' was not found."}
                    if($adapterCim.NetConnectionStatus -ne 2){throw "Physical adapter '$($c.adapter)' is not currently Up."}
                } catch {
                    if ($_.Exception.Message -match '(?i)access is denied|access denied') { throw "Cannot query physical adapter '$($c.adapter)' on target host: Access Denied. The remote account needs host-level network-administration rights to modify an External Hyper-V switch." }
                    throw "Unable to query physical adapter '$($c.adapter)': $($_.Exception.Message)"
                }
            }
        }

        Write-Output (Write-Event info "Updating virtual switch '$($c.name)'...")
        if([string]$c.type -ne [string]$sw.SwitchType) {
            Set-VMSwitch -Name $c.name -SwitchType $c.type -ErrorAction Stop
            Write-Output (Write-Event success "Switch type changed to '$($c.type)'.")
        }

        if([string]$c.type -eq 'External') {
            $currentAdapter=[string]$sw.NetAdapterName
            if($currentAdapter -ne [string]$c.adapter) {
                Set-VMSwitch -Name $c.name -NetAdapterName $c.adapter -ErrorAction Stop
                Write-Output (Write-Event success "External switch is now bound to physical adapter '$($c.adapter)'.")
            }
            Set-VMSwitch -Name $c.name -AllowManagementOS ([bool]$c.allowManagementOS) -ErrorAction Stop
        }

        Set-VMSwitch -Name $c.name -Notes ([string]$c.notes) -ErrorAction Stop
        $after=Get-VMSwitch -Name $c.name -ErrorAction Stop
        Write-Output (Write-Result $true "Virtual switch '$($c.name)' updated successfully." @{name=$after.Name;type=$after.SwitchType.ToString();adapter=$after.NetAdapterName;allowManagementOS=[bool]$after.AllowManagementOS;notes=[string]$after.Notes})
    }
    $json = $Config | ConvertTo-Json -Compress -Depth 5
    return (Invoke-Target $Session $script @($json, $CancelFile))
}

function Invoke-VMAction {
    param($Config,[System.Management.Automation.Runspaces.PSSession]$Session,[string]$WatcherScriptPath)
    $script={
        param($Json,$CancelFileInner,$WatcherScriptPathInner)
        $c=$Json|ConvertFrom-Json
        $ErrorActionPreference='Stop'
        Import-Module Hyper-V -ErrorAction Stop
        function Write-Event {
            param([ValidateSet('info','success','warn','error')][string]$Level='info',[string]$Message)
            ([ordered]@{type='log';level=$Level;message=$Message;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress)
        }
        function Write-Result {
            param([bool]$Success,[string]$Message='', [object]$Data=$null)
            ([ordered]@{type='result';success=$Success;message=$Message;data=$Data;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress -Depth 12)
        }
        function StartWatcher([string]$scriptPath,[string]$markerPath) {
            if (-not (Test-Path -LiteralPath $scriptPath)) { throw "First-boot watcher script was not found: $scriptPath" }
            $argString='-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}"' -f $scriptPath,$markerPath
            Start-Process -FilePath 'powershell.exe' -ArgumentList $argString -WindowStyle Hidden -WorkingDirectory (Split-Path -Parent $markerPath) -ErrorAction Stop | Out-Null
        }
        if($CancelFileInner -and (Test-Path -LiteralPath $CancelFileInner)){throw 'Operation cancelled.'}
        $vm=Get-VM -Name $c.vmName -ErrorAction Stop
        $pendingMarker = Join-Path $vm.Path '.hyperv-web-v2-firstboot.json'
        switch($c.operation){
            'Start' {
                $pending = Test-Path -LiteralPath $pendingMarker
                if ($pending) {
                    StartWatcher -scriptPath $WatcherScriptPathInner -markerPath $pendingMarker
                    Write-Output (Write-Event 'info' 'First-boot watcher armed; normal boot order will be restored after the VM first powers off/reboots.')
                }
                Start-VM -VM $vm -ErrorAction Stop|Out-Null
            }
            'Shutdown' { Stop-VM -VM $vm -ErrorAction Stop|Out-Null }
            'TurnOff' { Stop-VM -VM $vm -TurnOff -Force -ErrorAction Stop|Out-Null }
            'Restart' { Restart-VM -VM $vm -Force -ErrorAction Stop|Out-Null }
            'Pause' { Suspend-VM -VM $vm -ErrorAction Stop|Out-Null }
            'Resume' { Resume-VM -VM $vm -ErrorAction Stop|Out-Null }
            'Save' { Save-VM -VM $vm -ErrorAction Stop|Out-Null }
            default { throw "Unsupported VM operation: $($c.operation)" }
        }
        $after=Get-VM -Name $c.vmName -ErrorAction Stop
        Write-Output (Write-Event success "VM '$($c.vmName)' operation '$($c.operation)' completed. State: $($after.State).")
        Write-Output (Write-Result $true "VM '$($c.vmName)' is now $($after.State)." @{vmName=$after.Name;state=$after.State.ToString()})
    }
    $json = $Config | ConvertTo-Json -Compress -Depth 5
    return (Invoke-Target $Session $script @($json, $CancelFile, $WatcherScriptPath))
}

function Invoke-EjectISO {
    param($Config,[System.Management.Automation.Runspaces.PSSession]$Session)
    $script={
        param($Json,$CancelFileInner)
        $c=$Json|ConvertFrom-Json
        $ErrorActionPreference='Stop'
        Import-Module Hyper-V -ErrorAction Stop
        function Write-Event {
            param([ValidateSet('info','success','warn','error')][string]$Level='info',[string]$Message)
            ([ordered]@{type='log';level=$Level;message=$Message;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress)
        }
        function Write-Result {
            param([bool]$Success,[string]$Message='', [object]$Data=$null)
            ([ordered]@{type='result';success=$Success;message=$Message;data=$Data;timestamp=(Get-Date).ToString('o')} | ConvertTo-Json -Compress -Depth 12)
        }
        if($CancelFileInner -and (Test-Path -LiteralPath $CancelFileInner)){throw 'Operation cancelled.'}
        $dvd=Get-VMDvdDrive -VMName $c.vmName -ErrorAction Stop | Select-Object -First 1
        if(-not $dvd){throw "VM '$($c.vmName)' does not have a DVD drive."}
        Set-VMDvdDrive -VMName $c.vmName -Path $null -ErrorAction Stop
        Write-Output (Write-Event success "ISO ejected from '$($c.vmName)'.")
        Write-Output (Write-Result $true "ISO ejected from '$($c.vmName)'." @{vmName=$c.vmName})
    }
    $json = $Config | ConvertTo-Json -Compress -Depth 5
    return (Invoke-Target $Session $script @($json, $CancelFile))
}

$session=$null
$WatcherScriptPath=$null
try {
    if($TargetHost -in @('localhost','127.0.0.','.')){Import-Module Hyper-V -ErrorAction Stop}
    Write-Output (Write-Event info "Hyper-V engine initialized. Target: $TargetHost")
    $session=New-TargetSession
    if($Action -in @('ProvisionVM','VMAction')) { $WatcherScriptPath=Prepare-FirstBootWatcherScript -Session $session }

    switch($Action){
        'TargetInfo' {
            $targetScript = {
                $ErrorActionPreference='Stop'
                Import-Module Hyper-V -ErrorAction Stop
                $os=Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
                $cs=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
                [pscustomobject]@{
                    ComputerName=$env:COMPUTERNAME
                    OS=$os.Caption
                    OSVersion=$os.Version
                    Manufacturer=$cs.Manufacturer
                    Model=$cs.Model
                    HyperVModule=[bool](Get-Command Get-VM -ErrorAction SilentlyContinue)
                    PSVersion=$PSVersionTable.PSVersion.ToString()
                }
            }
            $d=Invoke-Target $session $targetScript
            Write-Output (Write-Result $true 'Target information retrieved.' $d)
        }
        'Switches' {
            $switchScript = {
                $ErrorActionPreference='Stop'
                Import-Module Hyper-V -ErrorAction Stop
                @(
                    Get-VMSwitch -ErrorAction Stop |
                    Sort-Object Name |
                    ForEach-Object {
                        [pscustomobject]@{
                            Name=$_.Name
                            SwitchType=$_.SwitchType.ToString()
                            NetAdapterName=$_.NetAdapterName
                            AllowManagementOS=[bool]$_.AllowManagementOS
                            Notes=$_.Notes
                        }
                    }
                )
            }
            $d=Invoke-Target $session $switchScript
            Write-Output (Write-Result $true 'Virtual switches retrieved.' @($d))
        }
        'Adapters' {
            $adapterScript = {
                $ErrorActionPreference='Stop'
                $result=@()
                try {
                    Import-Module NetAdapter -ErrorAction Stop
                    $result=@(Get-NetAdapter -ErrorAction Stop | Sort-Object Status,Name | ForEach-Object {
                        [pscustomobject]@{
                            Name=$_.Name
                            InterfaceDescription=$_.InterfaceDescription
                            LinkSpeed=([string]$_.LinkSpeed)
                            Status=([string]$_.Status)
                            MacAddress=$_.MacAddress
                            Source='NetAdapter'
                        }
                    })
                } catch {
                    $result=@(Get-CimInstance -ClassName Win32_NetworkAdapter -Filter "NetConnectionID IS NOT NULL" -ErrorAction Stop | Sort-Object NetConnectionID | ForEach-Object {
                        [pscustomobject]@{
                            Name=[string]$_.NetConnectionID
                            InterfaceDescription=[string]$_.Name
                            LinkSpeed=$(if($_.Speed){([int64]$_.Speed / 1MB).ToString('0.##') + ' Mbps'}else{''})
                            Status=$(if($_.NetConnectionStatus -eq 2){'Up'}else{'Down'})
                            MacAddress=[string]$_.MACAddress
                            Source='Win32_NetworkAdapter'
                        }
                    })
                }
                $result
            }
            $d=Invoke-Target $session $adapterScript
            Write-Output (Write-Result $true 'Network adapters retrieved.' @($d))
        }
        'Inventory' { $d=Get-Inventory -Session $session; Write-Output (Write-Result $true 'Target inventory retrieved.' $d) }
        'ValidateProvision' { $cfg=Get-Config; $d=Test-ProvisionConfig -Config $cfg -Session $session | Where-Object { $_ -isnot [string] } | Select-Object -Last 1; Write-Output (Write-Result $true 'Pre-flight validation passed.' $d) }
        'ProvisionVM' { $cfg=Get-Config; Test-ProvisionConfig -Config $cfg -Session $session | Out-Null; Invoke-Provision -Config $cfg -Session $session -WatcherScriptPath $WatcherScriptPath | ForEach-Object { Write-Output $_ } }
        'CreateSwitch' { $cfg=Get-Config; Invoke-CreateSwitch -Config $cfg -Session $session | ForEach-Object { Write-Output $_ } }
        'ModifyVM' { $cfg=Get-Config; Invoke-ModifyVM -Config $cfg -Session $session | ForEach-Object { Write-Output $_ } }
        'ModifySwitch' { $cfg=Get-Config; Invoke-ModifySwitch -Config $cfg -Session $session | ForEach-Object { Write-Output $_ } }
        'VMAction' { $cfg=Get-Config; Invoke-VMAction -Config $cfg -Session $session -WatcherScriptPath $WatcherScriptPath | ForEach-Object { Write-Output $_ } }
        'EjectISO' { $cfg=Get-Config; Invoke-EjectISO -Config $cfg -Session $session | ForEach-Object { Write-Output $_ } }
    }
} catch {
    Write-Output (Write-Event error $_.Exception.Message)
    Write-Output (Write-Result $false $_.Exception.Message $null)
    exit 1
} finally {
    if($session){Remove-PSSession -Session $session -ErrorAction SilentlyContinue}
}
