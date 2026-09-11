[CmdletBinding()]
param(
  [string]$Profile = 'hearth-local',
  [string]$CredentialPath = '',
  [string]$TunnelClient = '',
  [string]$HealthUrlFile = '',
  [int]$StaleProcessSeconds = 90
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $CredentialPath) { $CredentialPath = Join-Path $root '.hearth\secrets\hearth-tunnel.dpapi' }
if (-not $HealthUrlFile) { $HealthUrlFile = Join-Path $env:APPDATA "tunnel-client\$Profile-health.url" }
$logDir = Join-Path $root '.hearth\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'tunnel-ensure.log'

function Log([string]$Message) {
  Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

function Test-Ready {
  if (-not (Test-Path -LiteralPath $HealthUrlFile)) { return $false }
  try {
    $base = (Get-Content -LiteralPath $HealthUrlFile -Raw).Trim().TrimEnd('/')
    if (-not $base) { return $false }
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$base/readyz" -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch { return $false }
}

if (Test-Ready) { exit 0 }

if (-not $TunnelClient) {
  $command = Get-Command tunnel-client.exe -ErrorAction SilentlyContinue
  if ($command) { $TunnelClient = $command.Source }
  elseif (Test-Path -LiteralPath 'D:\userdata\tools\tunnel-client\tunnel-client.exe') { $TunnelClient = 'D:\userdata\tools\tunnel-client\tunnel-client.exe' }
  else { throw 'tunnel-client.exe was not found; pass -TunnelClient explicitly.' }
}
if (-not (Test-Path -LiteralPath $CredentialPath)) { throw "DPAPI tunnel credential not found: $CredentialPath" }

$existing = @(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'run\s+--profile\s+' + [regex]::Escape($Profile) })
if ($existing.Count -gt 0) {
  $young = $false
  foreach ($process in $existing) {
    $created = if ($process.CreationDate -is [datetime]) { [datetime]$process.CreationDate } else { [Management.ManagementDateTimeConverter]::ToDateTime([string]$process.CreationDate) }
    $age = ((Get-Date) - $created).TotalSeconds
    if ($age -lt $StaleProcessSeconds) { $young = $true }
    elseif (-not (Test-Ready)) {
      Log "terminating stale tunnel pid=$($process.ProcessId) age_seconds=$([math]::Round($age,1))"
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  if ($young) { exit 0 }
  Start-Sleep -Milliseconds 300
  if (Test-Ready) { exit 0 }
}

$protected = (Get-Content -LiteralPath $CredentialPath -Raw).Trim()
$secure = $protected | ConvertTo-SecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if (-not $plain) { throw 'DPAPI tunnel credential decrypted to an empty value.' }
$env:CONTROL_PLANE_API_KEY = $plain
$plain = $null
$secure = $null
$protected = $null
Remove-Item -LiteralPath $HealthUrlFile -Force -ErrorAction SilentlyContinue

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stdout = Join-Path $logDir "tunnel-$stamp.stdout.log"
$stderr = Join-Path $logDir "tunnel-$stamp.stderr.log"
try {
  $child = Start-Process -FilePath $TunnelClient -ArgumentList @('run','--profile',$Profile) -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
} finally {
  Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
}
Log "launched tunnel pid=$($child.Id) profile=$Profile credential_scope=CurrentUser"

$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ([DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 300
  if (Test-Ready) {
    Log "ready tunnel pid=$($child.Id)"
    exit 0
  }
  if ($child.HasExited) {
    Log "tunnel exited before ready pid=$($child.Id) code=$($child.ExitCode)"
    exit 1
  }
}
Log "tunnel did not become ready pid=$($child.Id)"
exit 1
