[CmdletBinding()]
param(
  [int]$Port = 0,
  [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configFile = if ($ConfigPath) { $ConfigPath } else { Join-Path $root 'config.json' }
if ($Port -le 0 -and (Test-Path -LiteralPath $configFile)) {
  try {
    $configured = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    if ($configured.port) { $Port = [int]$configured.port }
  } catch {}
}
if ($Port -le 0) { $Port = 3000 }

$logDir = Join-Path $root '.hearth\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'runtime-ensure.log'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$server = Join-Path $root 'src\server.js'
if (-not (Test-Path -LiteralPath $server)) { throw "Hearth server not found: $server" }
if ($ConfigPath) { $env:HEARTH_CONFIG = $ConfigPath }

function Log([string]$Message) {
  Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

function Get-Listener {
  try { return Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1 }
  catch { return $null }
}

function Get-Owner($Listener) {
  if (-not $Listener) { return $null }
  try { return Get-CimInstance Win32_Process -Filter "ProcessId=$($Listener.OwningProcess)" -ErrorAction Stop }
  catch { return $null }
}

$listener = Get-Listener
if ($listener) {
  $owner = Get-Owner $listener
  if ($owner -and $owner.Name -ieq 'node.exe' -and $owner.CommandLine -match 'src[\\/]server\.js') { exit 0 }
  Log "blocked: port=$Port owner_pid=$($listener.OwningProcess) is not Hearth"
  exit 2
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stdout = Join-Path $logDir "server-$stamp.stdout.log"
$stderr = Join-Path $logDir "server-$stamp.stderr.log"
$child = Start-Process -FilePath $node -ArgumentList @('src/server.js') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Log "launched server pid=$($child.Id)"

$deadline = [DateTime]::UtcNow.AddSeconds(12)
while ([DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 250
  $listener = Get-Listener
  $owner = Get-Owner $listener
  if ($owner -and $owner.ProcessId -eq $child.Id -and $owner.CommandLine -match 'src[\\/]server\.js') {
    Log "ready server pid=$($child.Id)"
    exit 0
  }
  if ($child.HasExited) {
    Log "server exited before ready pid=$($child.Id) code=$($child.ExitCode)"
    exit 1
  }
}
Log "server did not become ready pid=$($child.Id)"
exit 1
