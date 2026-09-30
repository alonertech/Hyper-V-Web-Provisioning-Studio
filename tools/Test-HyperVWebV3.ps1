#Requires -Version 5.1
[CmdletBinding()]
param([string]$TargetHost='localhost')
$ErrorActionPreference='Stop'
$Root=Split-Path -Parent $PSScriptRoot
$ok=$true
Write-Host 'Hyper-V Web Provisioning Studio v3.1.0 Professional prerequisite check' -ForegroundColor Cyan
Write-Host "Root: $Root"
Write-Host "Target: $TargetHost"

function Pass([string]$m){Write-Host "[PASS] $m" -ForegroundColor Green}
function Fail([string]$m){Write-Host "[FAIL] $m" -ForegroundColor Red; $script:ok=$false}
function Warn([string]$m){Write-Host "[WARN] $m" -ForegroundColor Yellow}
function Test-PowerShellSyntax([string]$p){
  $tokens=$null;$errors=$null
  [System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$tokens,[ref]$errors)|Out-Null
  if($errors.Count -eq 0){Pass "PowerShell syntax: $p";return $true}
  Fail "PowerShell syntax: $p";foreach($e in $errors){Write-Host "       $($e.Message)" -ForegroundColor Red};return $false
}

$id=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=New-Object Security.Principal.WindowsPrincipal($id)
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){Pass 'Running elevated.'}else{Fail 'Run as Administrator.'}
$node=Join-Path $Root 'node\node.exe';if(Test-Path $node){Pass 'Bundled Node runtime found.'}else{Fail 'Bundled Node runtime missing.'}
if($PSVersionTable.PSVersion.Major -ge 5){Pass "Windows PowerShell $($PSVersionTable.PSVersion)"}else{Fail 'Windows PowerShell 5.1+ is required.'}
try{Import-Module Hyper-V -ErrorAction Stop;Pass 'Hyper-V PowerShell module available locally.'}catch{Fail "Hyper-V module unavailable locally: $($_.Exception.Message)"}

foreach($rel in @('launcher\Start-HyperVPortal.ps1','powershell\Invoke-HyperVAction.ps1','powershell\Watch-HyperVFirstBoot.ps1','powershell\Open-HyperVConsole.ps1','powershell\Open-HyperVPicker.ps1')){
  Test-PowerShellSyntax (Join-Path $Root $rel)|Out-Null
}

$engine=Get-Content -LiteralPath (Join-Path $Root 'powershell\Invoke-HyperVAction.ps1') -Raw
$server=Get-Content -LiteralPath (Join-Path $Root 'server\server.js') -Raw
$app=Get-Content -LiteralPath (Join-Path $Root 'public\app.js') -Raw
$ui=Get-Content -LiteralPath (Join-Path $Root 'public\index.html') -Raw
$store=Get-Content -LiteralPath (Join-Path $Root 'server\database.js') -Raw

if($engine -match '(?m)-Depth\s+\d+\s*,'){Fail 'ConvertTo-Json -Depth argument-binding regression detected.'}else{Pass 'PowerShell JSON Depth argument binding check.'}
if(([regex]::Matches($engine,"Authentication='Negotiate'")).Count -ge 2 -and $engine -notmatch "Authentication='None'"){Pass 'WinRM authentication explicitly uses Negotiate.'}else{Fail 'Remote WinRM authentication must explicitly use Negotiate.'}
if($engine -match 'FirstBootDevice \$dvd' -and $engine -notmatch 'AutoEjectAfterGuestReboot|autoEjectIsoAfterFirstGuestReboot' -and $engine -match 'Get-VMHardDiskDrive'){Pass 'ISO-first and normal hard-disk boot restoration logic present; ISO remains mounted for manual eject.'}else{Fail 'ISO/boot-order behavior regression detected.'}
if($engine -match '\$remoteWatcher = Join-Path \$dir ''Watch-HyperVFirstBoot.ps1''' -and $engine -match 'Copy-Item -LiteralPath \$localWatcher -Destination \$localTarget'){Pass 'Target-side first-boot watcher wiring present.'}else{Fail 'First-boot watcher wiring missing.'}
if($engine -match 'Get-CimInstance -ClassName Win32_NetworkAdapter' -and $engine -match "Source='Win32_NetworkAdapter'"){Pass 'Physical NIC CIM fallback present.'}else{Fail 'Physical NIC fallback missing.'}
if($app -notmatch 'dynamicMemory|minimumMemoryMB|maximumMemoryMB|memoryBufferPercent' -and $ui -notmatch 'dynamicMemory|minimumMemoryMB|maximumMemoryMB|memoryBufferPercent'){Pass 'Dynamic Memory remains removed.'}else{Fail 'Dynamic Memory references remain.'}
if($ui -notmatch 'bootFromIsoFirst|autoStart'){Pass 'Boot-first/start-after-provisioning user controls remain removed.'}else{Fail 'Removed boot/start controls detected in UI.'}
if($ui -match 'data-op="TurnOff"[^>]*>TurnOff<'){Pass 'VM action label uses TurnOff.'}else{Fail 'TurnOff label not found.'}
if($server -match 'EmbeddedStore' -and $server -match '/api/templates' -and $server -match '/api/policies' -and $server -match '/api/rbac' -and $server -match '/api/audit'){Pass 'Professional embedded store, templates, policies, RBAC and audit APIs present.'}else{Fail 'Professional management APIs are incomplete.'}
if($store -match 'sha256' -and $store -match 'verifyAudit'){Pass 'Tamper-evident SHA-256 audit chain present.'}else{Fail 'Audit integrity mechanism missing.'}
if($app -match '/api/professional/summary' -and $ui -match 'Dashboard'){Pass 'Professional dashboard present.'}else{Fail 'Professional dashboard missing.'}
if($app -match 'Save as template' -and $ui -match 'VM Templates'){Pass 'Template workflow present.'}else{Fail 'Template workflow missing.'}
if($server -match "type==='modify-vm'" -and $server -match "type==='modify-switch'" -and $server -match "vm.modify" -and $server -match "switch.modify"){Pass 'V3.1 VM and virtual-switch modification job APIs present.'}else{Fail 'V3.1 modification job APIs are incomplete.'}
if($engine -match "ValidateSet\('TargetInfo'.*'ModifyVM'.*'ModifySwitch'" -and $engine -match 'function Invoke-ModifyVM' -and $engine -match 'function Invoke-ModifySwitch'){Pass 'V3.1 Hyper-V modification actions present.'}else{Fail 'V3.1 Hyper-V modification actions missing.'}
if($app -match "modify-action" -and $app -match "submitJob\('modify-vm'" -and $app -match 'jobLabel'){Pass 'V3.1 VM Modify and readable job/audit presentation present.'}else{Fail 'V3.1 VM Modify or readable job presentation missing.'}
if($ui -match 'data-tab="switches"' -and $ui -match 'id="createSwitchForm"' -and $ui -match 'id="modifySwitchForm"' -and $ui -match 'id="modifyVmForm"'){Pass 'V3.1 Virtual Switch tab and VM Modify UI present.'}else{Fail 'V3.1 management UI changes are incomplete.'}


if($TargetHost -ne 'localhost'){
  try{
    $cred=Get-Credential -Message "Credential for $TargetHost"
    $p=New-PSSession -ComputerName $TargetHost -Authentication Negotiate -Credential $cred -ErrorAction Stop
    $info=Invoke-Command -Session $p -ScriptBlock { [pscustomobject]@{ComputerName=$env:COMPUTERNAME;HyperV=[bool](Get-Command Get-VM -ErrorAction SilentlyContinue)} } -ErrorAction Stop
    $info|Format-List
    Pass 'Remote PowerShell session and Hyper-V module check succeeded.'
    try{
      Invoke-Command -Session $p -ScriptBlock { Get-NetAdapter -ErrorAction Stop | Select-Object -First 1 Name,Status } -ErrorAction Stop|Out-Null;Pass 'Remote physical NIC query available through Get-NetAdapter.'
    }catch{Warn "Remote Get-NetAdapter unavailable: $($_.Exception.Message)"}
    Remove-PSSession $p
  }catch{Fail "Remote PowerShell session failed: $($_.Exception.Message)"}
}else{
  try{Get-NetAdapter -ErrorAction Stop|Select-Object -First 1 Name,Status|Out-Null;Pass 'Local physical NIC query available.'}catch{Fail "Local physical NIC query failed: $($_.Exception.Message)"}
}

if($ok){Write-Host 'All required V3 Professional checks passed.' -ForegroundColor Green;exit 0}
Write-Host 'One or more V3 Professional checks failed.' -ForegroundColor Red;exit 2