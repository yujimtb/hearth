param([Parameter(Mandatory=$true)][string]$RequestBase64)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HearthInput {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@

function Text($value) { if ($null -eq $value) { return '' }; return [string]$value }
function Get-Safe($element, [scriptblock]$getter, $fallback) { try { return & $getter } catch { return $fallback } }
function Type-Name($element) {
  $value = Get-Safe $element { $element.Current.ControlType.ProgrammaticName } ''
  if ($value -match 'ControlType\.(.+)$') { return $Matches[1].ToLowerInvariant() }
  return $value.ToLowerInvariant()
}
function Patterns($element) {
  $result = @()
  try {
    foreach ($pattern in $element.GetSupportedPatterns()) {
      $name = $pattern.ProgrammaticName -replace 'Identifiers.Pattern','' -replace 'Pattern$',''
      if ($name) { $result += $name.ToLowerInvariant() }
    }
  } catch {}
  return @($result)
}
function Node($element, [int]$depth, [string]$pathKey) {
  $script:count++
  $rect = Get-Safe $element { $element.Current.BoundingRectangle } $null
  $node = [ordered]@{
    id = "n$($script:count)"
    locator = $pathKey
    name = Get-Safe $element { Text $element.Current.Name } ''
    automationId = Get-Safe $element { Text $element.Current.AutomationId } ''
    className = Get-Safe $element { Text $element.Current.ClassName } ''
    controlType = Type-Name $element
    processId = Get-Safe $element { [int]$element.Current.ProcessId } 0
    enabled = Get-Safe $element { [bool]$element.Current.IsEnabled } $false
    offscreen = Get-Safe $element { [bool]$element.Current.IsOffscreen } $true
    focusable = Get-Safe $element { [bool]$element.Current.IsKeyboardFocusable } $false
    focused = Get-Safe $element { [bool]$element.Current.HasKeyboardFocus } $false
    bounds = if ($rect) { [ordered]@{ x=[math]::Round($rect.X); y=[math]::Round($rect.Y); width=[math]::Round($rect.Width); height=[math]::Round($rect.Height) } } else { $null }
    patterns = @(Patterns $element)
    children = @()
  }
  if ($depth -ge $script:maxDepth -or $script:count -ge $script:maxNodes) { $script:truncated = $true; return $node }
  try {
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $walker.GetFirstChild($element); $index = 0
    while ($child -and $script:count -lt $script:maxNodes) {
      $node.children += Node $child ($depth + 1) "$pathKey/$index"
      $child = $walker.GetNextSibling($child); $index++
    }
    if ($child) { $script:truncated = $true }
  } catch { $script:errors += $_.Exception.Message }
  return $node
}
function Root($request) {
  if ($request.hwnd) {
    $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$request.hwnd)
    if (-not $root) { throw 'UIA root HWND not found' }; return $root
  }
  if ($request.process_id) {
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$request.process_id)
    $root = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children, $condition)
    if (-not $root) { throw 'UIA process window not found' }; return $root
  }
  return [Windows.Automation.AutomationElement]::RootElement
}
function Find-Target($root, $target) {
  $conditions = New-Object 'System.Collections.Generic.List[Windows.Automation.Condition]'
  if ($target.automation_id) { $conditions.Add([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$target.automation_id)) }
  if ($target.name) { $conditions.Add([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, [string]$target.name)) }
  if ($target.control_type) {
    $property = [Windows.Automation.ControlType].GetProperty(([string]$target.control_type), [Reflection.BindingFlags]'Public,Static,IgnoreCase')
    if (-not $property) { throw 'unknown control_type' }
    $conditions.Add([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $property.GetValue($null, $null)))
  }
  if ($conditions.Count -eq 0) { throw 'target requires automation_id, name, or control_type' }
  $condition = if ($conditions.Count -eq 1) { $conditions[0] } else { [Windows.Automation.AndCondition]::new($conditions.ToArray()) }
  $element = $root.FindFirst([Windows.Automation.TreeScope]::Subtree, $condition)
  if (-not $element) { throw 'UIA target not found' }
  return $element
}

try {
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json
  $root = Root $request
  if ($request.operation -eq 'snapshot' -or $request.operation -eq 'query') {
    $script:maxDepth = [math]::Min([math]::Max([int]$(if ($request.max_depth) {$request.max_depth} else {8}),0),12)
    $script:maxNodes = [math]::Min([math]::Max([int]$(if ($request.max_nodes) {$request.max_nodes} else {2000}),1),5000)
    $script:count = 0; $script:truncated = $false; $script:errors = @()
    if ($request.operation -eq 'query') {
      $element = Find-Target $root $request.target
      $script:maxDepth = 0
      $tree = Node $element 0 'query'
    } else { $tree = Node $root 0 'root' }
    $state = if ($script:errors.Count -gt 0 -or $script:truncated) {'partial'} else {'completed'}
    [ordered]@{ state=$state; tree=$tree; node_count=$script:count; truncated=$script:truncated; errors=@($script:errors) } | ConvertTo-Json -Depth 30 -Compress
    exit 0
  }
  if ($request.operation -eq 'action') {
    $element = Find-Target $root $request.target
    if (-not $element.Current.IsEnabled -or $element.Current.IsOffscreen) { throw 'target is disabled or offscreen' }
    $method = $null
    if ($request.action -eq 'invoke') {
      try { $pattern = $element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern); $pattern.Invoke(); $method='uia.invoke' } catch {}
    } elseif ($request.action -eq 'focus') { $element.SetFocus(); $method='uia.focus' }
    elseif ($request.action -eq 'set_value') {
      $pattern = $element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern); $pattern.SetValue([string]$request.value); $method='uia.value'
    }
    if (-not $method -and $request.allow_fallback) {
      $window = $root.Current.NativeWindowHandle
      if ($window -and -not [HearthInput]::SetForegroundWindow([IntPtr]$window)) { throw 'could not foreground target window' }
      $rect = $element.Current.BoundingRectangle
      if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { throw 'target has invalid bounds' }
      if ($request.action -eq 'click' -or $request.action -eq 'invoke') {
        [HearthInput]::SetCursorPos([int]($rect.X + $rect.Width/2), [int]($rect.Y + $rect.Height/2)) | Out-Null
        [HearthInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [HearthInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero); $method='input.mouse'
      } elseif ($request.action -eq 'key') {
        $vk = [byte][int]$request.virtual_key
        [HearthInput]::keybd_event($vk,0,0,[UIntPtr]::Zero); [HearthInput]::keybd_event($vk,0,2,[UIntPtr]::Zero); $method='input.keyboard'
      }
    }
    if (-not $method) { throw 'semantic action unavailable; fallback was not allowed or action is unsupported' }
    [ordered]@{ state='completed'; method=$method; target=[ordered]@{ name=Text $element.Current.Name; automationId=Text $element.Current.AutomationId; controlType=Type-Name $element } } | ConvertTo-Json -Depth 8 -Compress
    exit 0
  }
  throw "unsupported ui operation: $($request.operation)"
} catch {
  [ordered]@{ state='blocked'; error=$_.Exception.Message; limitation='UI Automation requires the same interactive Windows desktop and cannot cross integrity boundaries' } | ConvertTo-Json -Compress
  exit 0
}
