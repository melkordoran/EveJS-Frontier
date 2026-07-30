@echo off
setlocal

for %%I in ("%~dp0..\..") do set "EVEJS_REPO_ROOT=%%~fI"

call "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\EvEJSConfig.bat"
if errorlevel 1 exit /b 1

rem Under the Docker deployment the live game database lives in the evejs-data
rem volume, which has no host path. Pinning EVEJS_GAMESTORE_* to _local\gameStore
rem would be an explicit override, and config-manager-cli.js honours it ahead of
rem its own deployment detection - which is exactly how this launcher used to
rem force the Config Editor onto a stale host copy. Leave the variables unset so
rem the CLI can resolve the live containerized database itself, and skip the
rem local-database build, since there is nothing to build on the host.
set "EVEJS_CONFIG_EDITOR_DOCKER=0"
if exist "%EVEJS_REPO_ROOT%\compose.yaml" call :DetectDockerDeployment
if "%EVEJS_CONFIG_EDITOR_DOCKER%"=="1" goto :DatabaseReady
if "%EVEJS_CONFIG_EDITOR_DOCKER%"=="unknown" goto :DatabaseUnknown

set "EVEJS_LOCAL_DATABASE_ROOT=%EVEJS_REPO_ROOT%\_local\gameStore"
set "EVEJS_GAMESTORE_DATA_DIR=%EVEJS_LOCAL_DATABASE_ROOT%\data"
set "EVEJS_GAMESTORE_SQLITE_PATH=%EVEJS_LOCAL_DATABASE_ROOT%\gamestore.sqlite"

call :EnsureLocalDatabase
if errorlevel 1 exit /b 1
goto :LaunchEditor

:DatabaseReady
echo.
echo   Docker deployment detected. The Config Editor will read the live
echo   containerized game database, not %EVEJS_REPO_ROOT%\_local\gameStore.
echo.
goto :LaunchEditor

rem Docker is installed but did not answer. Deliberately leave EVEJS_GAMESTORE_*
rem unset: setting them would be an explicit override that suppresses the CLI's
rem own check and silently reads a possibly-stale local copy. The CLI reports the
rem condition instead.
:DatabaseUnknown
echo.
echo   Docker is installed but is not responding - is Docker Desktop running?
echo   The Config Editor will report this rather than risk reading a stale copy
echo   of the game database from %EVEJS_REPO_ROOT%\_local\gameStore.
echo.

:LaunchEditor
powershell.exe -Sta -NoProfile -ExecutionPolicy Bypass -File "%~dp0OpenServerConfigV2.ps1"
set "EVEJS_EXIT=%errorlevel%"

if not "%EVEJS_EXIT%"=="0" (
  echo [eve.js] Config manager exited with code %EVEJS_EXIT%.
  pause
)

exit /b %EVEJS_EXIT%

rem Three outcomes, matching the test config-manager-cli.js makes:
rem   0        docker absent, or present with no container for the service - native
rem   1        a container for the service exists in any state - Docker deployment
rem   unknown  docker present but it did not answer - deployment indeterminate
rem The last one must NOT fall back to the local layout: that is how a stale copy
rem gets read silently.
:DetectDockerDeployment
where docker >nul 2>nul
if errorlevel 1 exit /b 0
set "EVEJS_DOCKER_PS_OUT=%TEMP%\evejs-configeditor-docker-ps.txt"
pushd "%EVEJS_REPO_ROOT%"
docker compose ps -a -q server >"%EVEJS_DOCKER_PS_OUT%" 2>nul
if errorlevel 1 (
  set "EVEJS_CONFIG_EDITOR_DOCKER=unknown"
) else (
  for /f "usebackq delims=" %%C in ("%EVEJS_DOCKER_PS_OUT%") do set "EVEJS_CONFIG_EDITOR_DOCKER=1"
)
popd
del "%EVEJS_DOCKER_PS_OUT%" >nul 2>nul
exit /b 0

:EnsureLocalDatabase
set "EVEJS_CONFIG_EDITOR_DATA_READY=1"
if not exist "%EVEJS_GAMESTORE_SQLITE_PATH%" set "EVEJS_CONFIG_EDITOR_DATA_READY=0"
for %%D in (itemTypes shipTypes skillTypes typeDogma corporations stations solarSystems) do (
  if not exist "%EVEJS_GAMESTORE_DATA_DIR%\%%D\data.json" set "EVEJS_CONFIG_EDITOR_DATA_READY=0"
)
if "%EVEJS_CONFIG_EDITOR_DATA_READY%"=="1" exit /b 0

if exist "%EVEJS_GAMESTORE_SQLITE_PATH%" (
  echo.
  echo   [ERROR] The live SQLite player database exists, but required static catalog data is missing.
  echo       Player database: %EVEJS_GAMESTORE_SQLITE_PATH%
  echo       Static catalogs: %EVEJS_GAMESTORE_DATA_DIR%
  echo       The Config Editor will not rebuild or replace an existing live database automatically.
  pause
  exit /b 1
)

if not exist "%EVEJS_REPO_ROOT%\tools\DatabaseCreator\CreateDatabase.bat" (
  echo.
  echo   [ERROR] Generated local database data is missing and DatabaseCreator was not found.
  echo       Expected: %EVEJS_REPO_ROOT%\tools\DatabaseCreator\CreateDatabase.bat
  pause
  exit /b 1
)

set "EVEJS_DATABASE_CREATOR_ARGS="
if exist "%EVEJS_LOCAL_DATABASE_ROOT%\manifest.json" set "EVEJS_DATABASE_CREATOR_ARGS=/force"

echo   Generated local database data is missing.
echo   Running tools\DatabaseCreator\CreateDatabase.bat %EVEJS_DATABASE_CREATOR_ARGS%...
echo.
call "%EVEJS_REPO_ROOT%\tools\DatabaseCreator\CreateDatabase.bat" %EVEJS_DATABASE_CREATOR_ARGS%
set "EVEJS_DB_EXIT=%errorlevel%"
if not "%EVEJS_DB_EXIT%"=="0" (
  echo.
  echo   [ERROR] Database generation failed with code %EVEJS_DB_EXIT%.
  pause
  exit /b %EVEJS_DB_EXIT%
)

set "EVEJS_CONFIG_EDITOR_DATA_READY=1"
if not exist "%EVEJS_GAMESTORE_SQLITE_PATH%" set "EVEJS_CONFIG_EDITOR_DATA_READY=0"
for %%D in (itemTypes shipTypes skillTypes typeDogma corporations stations solarSystems) do (
  if not exist "%EVEJS_GAMESTORE_DATA_DIR%\%%D\data.json" set "EVEJS_CONFIG_EDITOR_DATA_READY=0"
)
if not "%EVEJS_CONFIG_EDITOR_DATA_READY%"=="1" (
  echo.
  echo   [ERROR] Database generation completed, but the SQLite store or static catalogs are still missing.
  echo       Player database: %EVEJS_GAMESTORE_SQLITE_PATH%
  echo       Static catalogs: %EVEJS_GAMESTORE_DATA_DIR%
  pause
  exit /b 1
)

echo.
echo   Live SQLite player database ready: %EVEJS_GAMESTORE_SQLITE_PATH%
echo.
exit /b 0
