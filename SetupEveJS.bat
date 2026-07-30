@echo off
setlocal EnableDelayedExpansion
title EvEJS - Setup

rem One entry point for first-time setup. Every step checks what is already done
rem before doing anything, so this is safe to run again after an interruption or
rem after pulling an update.
rem
rem Deliberately a PowerShell script rather than a Node script: Docker users do
rem not need Node.js installed, and this has to be able to run before anything
rem is installed at all.

for %%I in ("%~dp0.") do set "EVEJS_REPO_ROOT=%%~fI"
set "EVEJS_SETUP_PS1=%EVEJS_REPO_ROOT%\tools\Setup\Setup-EvEJS.ps1"

if not exist "%EVEJS_SETUP_PS1%" (
  echo.
  echo   [ERROR] Setup script not found:
  echo       %EVEJS_SETUP_PS1%
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_SETUP_PS1%" %*
set "EVEJS_SETUP_EXIT=%errorlevel%"

if not "%EVEJS_SETUP_EXIT%"=="0" (
  echo.
  echo   Setup did not finish. Nothing was left half-installed --
  echo   run SetupEveJS.bat again after fixing the problem above.
  echo.
)

pause
exit /b %EVEJS_SETUP_EXIT%
