#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$TargetHost,
    [Parameter(Mandatory=$false)][ValidateSet('Integrated','Explicit')][string]$AuthMode='Integrated',
    [Parameter(Mandatory=$false)][switch]$UseSSL,
    [Parameter(Mandatory=$false)][string]$CredentialFile,
    [Parameter(Mandatory=$true)][string]$VMName,
    [Parameter(Mandatory=$true)][string]$VMConnectPath
)
$ErrorActionPreference='Stop'

function Out-Json([bool]$ok,[string]$message,[string]$error='',[string]$target='',[string]$mode='') {
    ([ordered]@{ok=$ok;message=$message;error=$error;consoleTarget=$target;launchMode=$mode} | ConvertTo-Json -Compress)
}

function Get-CandidateReachability {
    param([Parameter(Mandatory=$true)][string]$Candidate)
    $isIp = $false
    $parsedIp = $null
    try {
        $isIp = [System.Net.IPAddress]::TryParse($Candidate.Trim('[]'), [ref]$parsedIp)
    } catch { $isIp = $false }
    if (-not $isIp) {
        try {
            [void][System.Net.Dns]::GetHostAddresses($Candidate)
        } catch {
            return [pscustomobject]@{Candidate=$Candidate;Resolvable=$false;Port2179=$false;Reason='Name does not resolve from the operator workstation.'}
        }
    }
    try {
        $probe = Test-NetConnection -ComputerName $Candidate -Port 2179 -InformationLevel Quiet -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
        return [pscustomobject]@{Candidate=$Candidate;Resolvable=$true;Port2179=[bool]$probe;Reason=if($probe){'TCP 2179 reachable.'}else{'TCP 2179 is not reachable.'}}
    } catch {
        return [pscustomobject]@{Candidate=$Candidate;Resolvable=$true;Port2179=$false;Reason='TCP 2179 probe failed: ' + $_.Exception.Message}
    }
}

if (-not (Test-Path -LiteralPath $VMConnectPath)) { Out-Json $false '' "VMConnect.exe was not found at $VMConnectPath"; exit 1 }
if ($VMName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$') { Out-Json $false '' 'VM name is invalid.'; exit 1 }

$credential=$null
if ($AuthMode -eq 'Explicit') {
    if (-not $CredentialFile -or -not (Test-Path -LiteralPath $CredentialFile)) { Out-Json $false '' 'The protected credential file is unavailable.'; exit 1 }
    $credential=Import-Clixml -LiteralPath $CredentialFile
    if (-not ($credential -is [System.Management.Automation.PSCredential])) { Out-Json $false '' 'Credential file did not contain a PSCredential.'; exit 1 }
}

if ($TargetHost -in @('localhost','127.0.0.1','.')) {
    try {
        Start-Process -FilePath $VMConnectPath -ArgumentList @('localhost',$VMName) -WindowStyle Normal -ErrorAction Stop | Out-Null
        Out-Json $true "Opened VMConnect for '$VMName'." '' 'localhost' 'current-user'
        exit 0
    } catch {
        Out-Json $false '' $_.Exception.Message; exit 1
    }
}

$session=$null
try {
    # Use the same successful WinRM/Negotiate path as the rest of the portal, but do
    # not replace the operator's requested console target with the remote FQDN.
    # The remote identity is used only to build additional fallback candidates.
    $sessionOption=New-PSSessionOption -OpenTimeout 15000 -OperationTimeout 30000 -CancelTimeout 5000
    $ps=@{ComputerName=$TargetHost;Authentication='Negotiate';SessionOption=$sessionOption;ErrorAction='Stop'}
    if($UseSSL){$ps.UseSSL=$true}
    if($credential){$ps.Credential=$credential}
    $session=New-PSSession @ps
    $identity=Invoke-Command -Session $session -ScriptBlock {
        $short=$env:COMPUTERNAME
        $fqdn=$null
        try {$fqdn=[System.Net.Dns]::GetHostEntry($short).HostName} catch {}
        [pscustomobject]@{ShortName=$short;Fqdn=$fqdn}
    } -ErrorAction Stop

    $candidates = New-Object System.Collections.Generic.List[string]
    foreach($candidate in @($TargetHost,$identity.ShortName,$identity.Fqdn)) {
        if([string]::IsNullOrWhiteSpace([string]$candidate)){ continue }
        $value=[string]$candidate
        if(-not ($candidates | Where-Object { $_.Equals($value,[System.StringComparison]::OrdinalIgnoreCase) })) {
            [void]$candidates.Add($value)
        }
    }

    $checks = @()
    foreach($candidate in $candidates) {
        $checks += Get-CandidateReachability -Candidate $candidate
    }

    $targetIsIp = $false
    $parsedTargetIp = $null
    try { $targetIsIp = [System.Net.IPAddress]::TryParse($TargetHost.Trim('[]'), [ref]$parsedTargetIp) } catch { $targetIsIp = $false }

    # For an IP target, prefer a locally usable server name when one is available
    # because VMConnect can use normal Windows/SPN authentication with a hostname.
    # If no name is usable, fall back to the original IP. For hostname/FQDN input,
    # preserve the operator's target as the first choice.
    $preferredNames = if($targetIsIp) { @($identity.ShortName,$identity.Fqdn,$TargetHost) } else { @($TargetHost,$identity.ShortName,$identity.Fqdn) }
    $selected = $null
    foreach($preferred in $preferredNames) {
        if([string]::IsNullOrWhiteSpace([string]$preferred)){ continue }
        $selected = $checks | Where-Object { $_.Candidate.Equals([string]$preferred,[System.StringComparison]::OrdinalIgnoreCase) -and $_.Port2179 } | Select-Object -First 1
        if($selected){ break }
    }
    if(-not $selected) {
        foreach($preferred in $preferredNames) {
            if([string]::IsNullOrWhiteSpace([string]$preferred)){ continue }
            $selected = $checks | Where-Object { $_.Candidate.Equals([string]$preferred,[System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
            if($selected){ break }
        }
    }
    if(-not $selected) { throw "No usable VMConnect target was found for '$TargetHost'." }

    $consoleTarget=[string]$selected.Candidate
    $reachSummary = ($checks | ForEach-Object { "$($_.Candidate): $($_.Reason)" }) -join ' | '

    # Preserve the existing current-user-first behavior. If the process cannot be
    # started under the current account, use the protected alternate credential.
    try {
        Start-Process -FilePath $VMConnectPath -ArgumentList @($consoleTarget,$VMName) -WindowStyle Normal -ErrorAction Stop | Out-Null
        Out-Json $true "Opened VMConnect for '$VMName' using target '$consoleTarget'." '' $consoleTarget 'current-user'
        exit 0
    } catch {
        $currentError=$_.Exception.Message
    }

    if($credential) {
        try {
            Start-Process -FilePath $VMConnectPath -ArgumentList @($consoleTarget,$VMName) -Credential $credential -LoadUserProfile -WindowStyle Normal -ErrorAction Stop | Out-Null
            Out-Json $true "Opened VMConnect for '$VMName' using supplied credential and target '$consoleTarget'." '' $consoleTarget 'explicit-credential'
            exit 0
        } catch {
            $credentialError=$_.Exception.Message
        }
    }

    $hint="VMConnect could not be launched successfully. Requested target '$TargetHost' selected '$consoleTarget'. $reachSummary. Current-user launch error: $currentError"
    if($credentialError){$hint += " Alternate-credential launch error: $credentialError"}
    $hint += " WinRM connectivity can be healthy while VMConnect/console access still fails; verify TCP 2179 and Hyper-V Microsoft Virtual Console Service SPNs/authorization for the selected target."
    Out-Json $false '' $hint $consoleTarget ''
    exit 1
} catch {
    Out-Json $false '' $_.Exception.Message; exit 1
} finally {
    if($session){Remove-PSSession -Session $session -ErrorAction SilentlyContinue}
}
