Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$saveScript = Join-Path $PSScriptRoot 'save-tunnel-credential.ps1'
$installRuntime = Join-Path $PSScriptRoot 'install-autostart.ps1'
$installTunnel = Join-Path $PSScriptRoot 'install-tunnel-autostart.ps1'
$healthFile = Join-Path $env:APPDATA 'tunnel-client\hearth-local-health.url'

$form = New-Object Windows.Forms.Form
$form.Text = 'Hearth Unattended Setup'
$form.Size = New-Object Drawing.Size(540,270)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$label = New-Object Windows.Forms.Label
$label.Text = 'OpenAI Tunnel runtime key'
$label.Location = New-Object Drawing.Point(20,20)
$label.AutoSize = $true
$form.Controls.Add($label)

$text = New-Object Windows.Forms.TextBox
$text.Location = New-Object Drawing.Point(20,48)
$text.Size = New-Object Drawing.Size(480,25)
$text.UseSystemPasswordChar = $true
$form.Controls.Add($text)

$paste = New-Object Windows.Forms.Button
$paste.Text = 'Paste'
$paste.Location = New-Object Drawing.Point(20,85)
$paste.Size = New-Object Drawing.Size(90,32)
$paste.Add_Click({ try { $text.Text = [Windows.Forms.Clipboard]::GetText() } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message,'Paste failed') } })
$form.Controls.Add($paste)

$start = New-Object Windows.Forms.Button
$start.Text = 'Enable unattended recovery'
$start.Location = New-Object Drawing.Point(120,85)
$start.Size = New-Object Drawing.Size(220,32)
$form.Controls.Add($start)

$status = New-Object Windows.Forms.Label
$status.Text = 'The key will be protected with Windows DPAPI. Plaintext is not written to disk.'
$status.Location = New-Object Drawing.Point(20,135)
$status.Size = New-Object Drawing.Size(480,70)
$form.Controls.Add($status)

$start.Add_Click({
  $key = $text.Text.Trim()
  if (-not $key -or $key.Length -lt 20) { [Windows.Forms.MessageBox]::Show('Paste the runtime key first.','Hearth Setup'); return }
  $start.Enabled = $false; $paste.Enabled = $false
  try {
    $status.Text = 'Encrypting credential with Windows DPAPI...'; $form.Refresh()
    [Windows.Forms.Clipboard]::SetText($key)
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $saveScript | Out-Null
    try { [Windows.Forms.Clipboard]::Clear() } catch {}
    $key = $null; $text.Clear()

    $status.Text = 'Installing periodic Hearth and Tunnel recovery tasks...'; $form.Refresh()
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installRuntime -TaskName 'Hearth-Runtime-Ensure' -StartNow | Out-Null
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installTunnel -StartNow | Out-Null

    $status.Text = 'Waiting for Secure MCP Tunnel readiness...'; $form.Refresh()
    $deadline = [DateTime]::UtcNow.AddSeconds(35); $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 500
      if (Test-Path -LiteralPath $healthFile) {
        $base = (Get-Content -LiteralPath $healthFile -Raw).Trim().TrimEnd('/')
        if ($base) { try { $r=Invoke-WebRequest -UseBasicParsing -Uri ($base+'/readyz') -TimeoutSec 2; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 300){$ready=$true;break} } catch {} }
      }
    }
    if ($ready) {
      $status.Text = 'Ready. Hearth and the Secure MCP Tunnel will now recover automatically after logon.'
      [Windows.Forms.MessageBox]::Show('Unattended recovery is enabled.','Hearth Setup')
    } else {
      $status.Text = 'Credential and tasks were saved. The periodic task will keep retrying the Tunnel.'
      [Windows.Forms.MessageBox]::Show('Setup was saved, but Tunnel readiness was not confirmed yet.','Hearth Setup')
    }
  } catch {
    try { [Windows.Forms.Clipboard]::Clear() } catch {}
    $text.Clear(); $status.Text='Setup failed.'
    [Windows.Forms.MessageBox]::Show($_.Exception.Message,'Hearth Setup')
  } finally {
    $start.Enabled=$true; $paste.Enabled=$true
  }
})
$form.Add_Shown({$form.Activate();$text.Focus()})
[void]$form.ShowDialog()
