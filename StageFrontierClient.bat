@echo off
setlocal
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0StageFrontierClient.ps1" %*
exit /b %ERRORLEVEL%
