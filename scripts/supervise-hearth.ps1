[CmdletBinding()]
param(
  [int]$Port = 0,
  [int]$RestartDelaySeconds = 2,
  [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'
$ensure = Join-Path $PSScriptRoot 'ensure-hearth.ps1'
if (-not (Test-Path -LiteralPath $ensure)) { throw "Hearth ensure script not found: $ensure" }

# Backward-compatible entrypoint for older Hearth-Runtime tasks.
# Recovery is now performed by short periodic ensure tasks; this wrapper runs one check and exits.
& $ensure -Port $Port -ConfigPath $ConfigPath
