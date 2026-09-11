[CmdletBinding()]
param(
  [string]$Profile = 'hearth-local',
  [string]$TunnelClient = '',
  [switch]$KeepClipboard
)

$ErrorActionPreference = 'Stop'
if (-not $TunnelClient) {
  $command = Get-Command tunnel-client.exe -ErrorAction SilentlyContinue
  if ($command) { $TunnelClient = $command.Source }
  elseif (Test-Path -LiteralPath 'D:\userdata\tools\tunnel-client\tunnel-client.exe') { $TunnelClient = 'D:\userdata\tools\tunnel-client\tunnel-client.exe' }
  else { throw 'tunnel-client.exe was not found; pass -TunnelClient explicitly.' }
}

$clipboard = Get-Clipboard -Raw
$key = if ($null -eq $clipboard) { '' } else { ([string]$clipboard).Trim() }
$clipboard = $null
if (-not $key) { throw 'Clipboard does not contain a runtime key.' }
if (-not $KeepClipboard) { try { Set-Clipboard -Value '' } catch {} }
$env:CONTROL_PLANE_API_KEY = $key
$key = $null

try {
  & $TunnelClient doctor --profile $Profile --explain
  if ($LASTEXITCODE -ne 0) { throw "tunnel-client doctor failed with exit code $LASTEXITCODE" }

  $delay = 1
  while ($true) {
    & $TunnelClient run --profile $Profile
    $code = $LASTEXITCODE
    if ($code -eq 0) { break }
    Write-Warning "tunnel-client exited with code $code; retrying in $delay second(s)"
    Start-Sleep -Seconds $delay
    $delay = [Math]::Min($delay * 2, 30)
  }
} finally {
  Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
}
