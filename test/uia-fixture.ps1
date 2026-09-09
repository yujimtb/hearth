param([Parameter(Mandatory=$true)][string]$ReadyFile, [Parameter(Mandatory=$true)][string]$ActionFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
$window = New-Object Windows.Window
$window.Title = 'Hearth UIA Fixture'
$window.Width = 320
$window.Height = 160
$button = New-Object Windows.Controls.Button
$button.Name = 'HearthInvokeButton'
$button.Content = 'Invoke me'
$button.Add_Click({ $window.Title = 'Hearth UIA Invoked'; 'invoked' | Set-Content -LiteralPath $ActionFile -Encoding ASCII })
$window.Content = $button
$window.Add_ContentRendered({
  $handle = (New-Object Windows.Interop.WindowInteropHelper($window)).Handle.ToInt64()
  [ordered]@{ pid=$PID; hwnd=$handle } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ReadyFile -Encoding UTF8
})
$window.ShowDialog() | Out-Null
