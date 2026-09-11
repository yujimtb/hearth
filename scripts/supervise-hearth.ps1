[CmdletBinding()]
param(
  [int]$Port = 0,
  [int]$RestartDelaySeconds = 2,
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
$dataDir = Join-Path $root '.hearth'
$logDir = Join-Path $dataDir 'logs'
$stopFile = Join-Path $dataDir 'stop-supervisor'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$node = (Get-Command node.exe -ErrorAction Stop).Source
$server = Join-Path $root 'src\server.js'
if (-not (Test-Path -LiteralPath $server)) { throw "Hearth server not found: $server" }
if ($ConfigPath) { $env:HEARTH_CONFIG = $ConfigPath }

function Write-SupervisorLog([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath (Join-Path $logDir 'supervisor.log') -Value $line -Encoding UTF8
}

function Get-PortOwner {
  try {
    return Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1
  } catch { return $null }
}

Write-SupervisorLog "supervisor started pid=$PID root=$root port=$Port"
while ($true) {
  if (Test-Path -LiteralPath $stopFile) {
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    Write-SupervisorLog 'stop marker consumed; supervisor exiting'
    break
  }

  $listener = Get-PortOwner
  if ($listener) {
    $owner = $null
    try { $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop } catch {}
    $isHearth = $owner -and $owner.Name -ieq 'node.exe' -and $owner.CommandLine -match 'src[\\/]server\.js'
    if ($isHearth) {
      Start-Sleep -Milliseconds 750
      continue
    }
    Write-SupervisorLog "port conflict port=$Port pid=$($listener.OwningProcess); waiting"
    Start-Sleep -Seconds 2
    continue
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $logDir "server-$stamp.stdout.log"
  $stderr = Join-Path $logDir "server-$stamp.stderr.log"
  $child = Start-Process -FilePath $node -ArgumentList @('src/server.js') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  Write-SupervisorLog "server started pid=$($child.Id)"
  $child.WaitForExit()
  Write-SupervisorLog "server exited pid=$($child.Id) code=$($child.ExitCode)"

  if (Test-Path -LiteralPath $stopFile) { continue }
  Start-Sleep -Seconds ([Math]::Max(1, $RestartDelaySeconds))
}
