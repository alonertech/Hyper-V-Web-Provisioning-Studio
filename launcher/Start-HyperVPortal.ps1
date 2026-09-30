#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root 'server\server.js'
$NodeExe = Join-Path $Root 'node\node.exe'
if (-not (Test-Path -LiteralPath $NodeExe)) { $NodeExe = 'node.exe' }

function Test-Administrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
    Write-Host 'Administrative privileges are required. Right-click Start-HyperVPortal.bat and choose Run as administrator.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' Hyper-V VM Provisioning Studio v3 Professional' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

$TargetHost = Read-Host 'Target Hyper-V host (Enter = localhost)'
if ([string]::IsNullOrWhiteSpace($TargetHost)) { $TargetHost = 'localhost' }

if ($TargetHost -notmatch '^[A-Za-z0-9_.:-]+$') {
    Write-Host 'Invalid target host. Use a hostname, FQDN, IPv4 address, or IPv6 literal.' -ForegroundColor Red
    exit 1
}

$AuthMode = 'Integrated'
$CredentialFile = ''
$isRemote = $TargetHost -notin @('localhost','127.0.0.1','.')
# Remove stale protected credential files left by an abnormal previous shutdown.
$staleDir = Join-Path $env:TEMP 'HyperV-Web-V3'
if (Test-Path $staleDir) { Get-ChildItem $staleDir -Filter 'credential-*.xml' -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-4) } | Remove-Item -Force -ErrorAction SilentlyContinue }

if ($isRemote) {
    $isIpTarget = $TargetHost -match '^(?:\d{1,3}\.){3}\d{1,3}$' -or $TargetHost -match '^\[?[0-9A-Fa-f:]+\]?$'
    Write-Host ''
    Write-Host 'Authentication:' -ForegroundColor Yellow
    Write-Host '  1. Integrated Windows authentication (current user)'
    Write-Host '  2. Alternate Windows credential (encrypted DPAPI file)'
    if ($isIpTarget) {
        Write-Host '  NOTE: An IP target requires a credential for WinRM/Negotiate. The launcher will use option 2.' -ForegroundColor Yellow
        $authChoice = '2'
    } else {
        $authChoice = Read-Host 'Select [1/2] (default 1)'
    }
    if ($authChoice -eq '2' -or $isIpTarget) {
        $AuthMode = 'Explicit'
        $sessionDir = Join-Path $env:TEMP 'HyperV-Web-V3'
        New-Item -ItemType Directory -Path $sessionDir -Force | Out-Null
        $CredentialFile = Join-Path $sessionDir ('credential-{0}.xml' -f ([guid]::NewGuid().ToString('N')))
        $cred = Get-Credential -Message "Hyper-V credentials for $TargetHost"
        if (-not $cred) {
            Write-Host 'Credential prompt cancelled.' -ForegroundColor Red
            exit 1
        }
        # SecureString in Export-Clixml is protected with Windows DPAPI for the current user.
        $cred | Export-Clixml -LiteralPath $CredentialFile -Force
    }

    Write-Host ''
    Write-Host 'WinRM transport:' -ForegroundColor Yellow
    Write-Host '  1. HTTP / Kerberos or Negotiate (default)'
    Write-Host '  2. HTTPS / certificate-validated'
    $transportChoice = Read-Host 'Select [1/2] (default 1)'
    $UseSSL = ($transportChoice -eq '2')
} else {
    $UseSSL = $false
}

$env:HYPERV_V3_TARGET_HOST = $TargetHost
$env:HYPERV_V3_AUTH_MODE = $AuthMode
$env:HYPERV_V3_USE_SSL = if ($UseSSL) { '1' } else { '0' }
$env:HYPERV_V3_CREDENTIAL_FILE = $CredentialFile
$env:HYPERV_V3_ROOT = $Root
$env:HYPERV_V3_LAUNCH_TOKEN = [guid]::NewGuid().ToString('N')

Write-Host ''
Write-Host "Starting portal for target [$TargetHost]..." -ForegroundColor Green
Write-Host 'The portal will automatically close this CMD window when all browser sessions are closed.' -ForegroundColor Gray
Write-Host ''

$nodeProcess = $null
$rc = 1
$startupDeadline = (Get-Date).AddSeconds(30)
$zeroClientSince = $null
$serverReady = $false

try {
    $nodeProcess = Start-Process -FilePath $NodeExe -ArgumentList @(("`"$Server`"")) -WorkingDirectory $Root -PassThru -WindowStyle Hidden

    # Wait for the portal health endpoint before opening the browser. This prevents
    # the browser from racing the Node startup and showing an indefinite "Connecting…" state.
    while (-not $serverReady) {
        $nodeProcess.Refresh()
        if ($nodeProcess.HasExited) {
            $rc = $nodeProcess.ExitCode
            throw "Portal process exited during startup with code $rc."
        }
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -Method Get -TimeoutSec 2 -ErrorAction Stop
            $serverReady = [bool]$health.ok
        } catch {
            if ((Get-Date) -gt $startupDeadline) { throw "Portal did not become ready within 30 seconds: $($_.Exception.Message)" }
            Start-Sleep -Seconds 1
        }
    }
    Write-Host 'Portal is ready. Opening Browser ...' -ForegroundColor Green
    Start-Process 'http://127.0.0.1:3000' -WindowStyle Hidden

    while ($true) {
        $nodeProcess.Refresh()
        if ($nodeProcess.HasExited) {
            $rc = $nodeProcess.ExitCode
            break
        }

        $health = $null
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -Method Get -TimeoutSec 2 -ErrorAction Stop
            $serverReady = [bool]$health.ok
        } catch {
            if (-not $serverReady -and (Get-Date) -gt $startupDeadline) {
                Write-Host "Portal did not become ready: $($_.Exception.Message)" -ForegroundColor Red
                try { Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
                $rc = 1
                break
            }
            Start-Sleep -Seconds 2
            continue
        }

        $clients = [int]($health.clients | ForEach-Object { $_ })
        $activeJobs = [int]($health.activeJobs | ForEach-Object { $_ })

        if ($serverReady -and (Get-Date) -ge $startupDeadline -and $clients -eq 0 -and $activeJobs -eq 0) {
            if (-not $zeroClientSince) { $zeroClientSince = Get-Date }
            if (((Get-Date) - $zeroClientSince).TotalSeconds -ge 8) {
                try {
                    Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/launcher/shutdown' -Method Post -Headers @{ 'X-HyperV-Launcher-Token' = $env:HYPERV_V3_LAUNCH_TOKEN } -TimeoutSec 3 -ErrorAction Stop | Out-Null
                } catch {
                    try { Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
                }
                Start-Sleep -Seconds 2
                $nodeProcess.Refresh()
                if (-not $nodeProcess.HasExited) {
                    try { Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
                }
                $rc = 0
                break
            }
        } else {
            $zeroClientSince = $null
        }

        Start-Sleep -Seconds 2
    }
} finally {
    if ($nodeProcess -and -not $nodeProcess.HasExited -and $rc -ne 0) {
        try { Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    if ($CredentialFile -and (Test-Path -LiteralPath $CredentialFile)) {
        Remove-Item -LiteralPath $CredentialFile -Force -ErrorAction SilentlyContinue
    }
    Remove-Item Env:HYPERV_V3_LAUNCH_TOKEN -ErrorAction SilentlyContinue
}

exit $rc
