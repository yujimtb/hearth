[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [string]$TaskName = 'Hearth-Tunnel',
  [string]$Profile = 'hearth-local',
  [string]$CredentialPath = '',
  [switch]$Uninstall,
  [switch]$StartNow,
  [switch]$RemoveCredential,
  [int]$IntervalSeconds = 60
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows Task Scheduler is required.' }
$root = Split-Path -Parent $PSScriptRoot
$ensure = Join-Path $PSScriptRoot 'ensure-tunnel.ps1'
if (-not $CredentialPath) { $CredentialPath = Join-Path $root '.hearth\secrets\hearth-tunnel.dpapi' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$IntervalSeconds = [Math]::Max(60, $IntervalSeconds)

if ($Uninstall) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'unregister Hearth tunnel ensure task')) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    if ($RemoveCredential) { Remove-Item -LiteralPath $CredentialPath -Force -ErrorAction SilentlyContinue }
  }
  return
}

if (-not (Test-Path -LiteralPath $ensure)) { throw "Tunnel ensure script not found: $ensure" }
if (-not (Test-Path -LiteralPath $CredentialPath)) { throw "DPAPI tunnel credential not found: $CredentialPath. Run scripts\save-tunnel-credential.ps1 first." }
$argument = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ensure`" -Profile `"$Profile`" -CredentialPath `"$CredentialPath`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $argument -WorkingDirectory $root
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $user),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds($IntervalSeconds) -RepetitionInterval (New-TimeSpan -Seconds $IntervalSeconds))
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -RestartCount 1 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

if ($PSCmdlet.ShouldProcess($TaskName, 'register Hearth periodic tunnel ensure task')) {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Checks the Hearth Secure MCP Tunnel every minute and starts it from the DPAPI credential when missing.' -Force | Out-Null
  if ($StartNow) { Start-ScheduledTask -TaskName $TaskName }
  Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State,@{n='UserId';e={$_.Principal.UserId}},@{n='LogonType';e={$_.Principal.LogonType}},@{n='TriggerCount';e={$_.Triggers.Count}}
}
