[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [string]$TaskName = 'Hearth-Runtime',
  [switch]$Uninstall,
  [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows Task Scheduler is required.' }
$root = Split-Path -Parent $PSScriptRoot
$supervisor = Join-Path $PSScriptRoot 'supervise-hearth.ps1'
$stopFile = Join-Path $root '.hearth\stop-supervisor'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if ($Uninstall) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'stop and unregister Hearth autostart task')) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stopFile) | Out-Null
    New-Item -ItemType File -Force -Path $stopFile | Out-Null
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
  }
  return
}

if (-not (Test-Path -LiteralPath $supervisor)) { throw "Supervisor script not found: $supervisor" }
$argument = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$supervisor`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $argument -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

if ($PSCmdlet.ShouldProcess($TaskName, 'register Hearth interactive autostart task')) {
  Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Keeps the Hearth MCP runtime available in the interactive user session.' -Force | Out-Null
  if ($StartNow) { Start-ScheduledTask -TaskName $TaskName }
  Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State,@{n='UserId';e={$_.Principal.UserId}},@{n='LogonType';e={$_.Principal.LogonType}}
}
