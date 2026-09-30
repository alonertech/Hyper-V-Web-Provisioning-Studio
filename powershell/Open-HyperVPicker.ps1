#Requires -Version 5.1
[CmdletBinding()]
param([ValidateSet('Folder','Iso')][string]$Mode)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
if ($Mode -eq 'Folder') {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.ShowNewFolderButton = $true
    $result = $dlg.ShowDialog($owner)
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $dlg.SelectedPath }
} else {
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Filter = 'ISO files (*.iso)|*.iso|All files (*.*)|*.*'
    $dlg.Multiselect = $false
    $result = $dlg.ShowDialog($owner)
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $dlg.FileName }
}
$owner.Dispose()
