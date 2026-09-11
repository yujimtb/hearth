[CmdletBinding()]
param(
  [string]$CredentialPath = '',
  [switch]$KeepClipboard
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $CredentialPath) { $CredentialPath = Join-Path $root '.hearth\secrets\hearth-tunnel.dpapi' }
$dir = Split-Path -Parent $CredentialPath
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$clipboard = Get-Clipboard -Raw -ErrorAction Stop
$key = if ($null -eq $clipboard) { '' } else { ([string]$clipboard).Trim() }
$clipboard = $null
$secure = $null
$roundSecure = $null
$round = $null

try {
  if (-not $key -or $key.Length -lt 20) { throw 'Clipboard does not contain a plausible tunnel runtime key.' }

  $secure = ConvertTo-SecureString $key -AsPlainText -Force
  $blob = $secure | ConvertFrom-SecureString
  $temp = "$CredentialPath.tmp"
  [IO.File]::WriteAllText($temp,$blob,[Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $CredentialPath -Force

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetOwner($identity)
  $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow')))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system,'FullControl','Allow')))
  Set-Acl -LiteralPath $CredentialPath -AclObject $acl

  $roundSecure = (Get-Content -LiteralPath $CredentialPath -Raw) | ConvertTo-SecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($roundSecure)
  try { $round = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  $verified = [string]::Equals($key,$round,[StringComparison]::Ordinal)
  if (-not $verified) { throw 'DPAPI credential round-trip verification failed.' }

  [pscustomobject]@{ state='completed'; path=$CredentialPath; dpapi_scope='CurrentUser'; verified=$verified; plaintext_persisted=$false }
} finally {
  $key = $null
  $round = $null
  $secure = $null
  $roundSecure = $null
  if (-not $KeepClipboard) { try { Set-Clipboard -Value '' } catch {} }
}
