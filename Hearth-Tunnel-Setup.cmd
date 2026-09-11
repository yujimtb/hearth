@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0scripts\setup-tunnel-ui.ps1"
endlocal
