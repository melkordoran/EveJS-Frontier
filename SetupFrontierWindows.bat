@echo off
setlocal
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo [evejs-frontier] PowerShell 7 is missing; installing it with winget ...
  winget install --exact --id Microsoft.PowerShell --accept-package-agreements --accept-source-agreements --disable-interactivity
  if errorlevel 1 exit /b %ERRORLEVEL%
)
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0SetupFrontierWindows.ps1" %*
exit /b %ERRORLEVEL%
