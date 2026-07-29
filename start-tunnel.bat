@echo off
setlocal
set CLOUDFLARED=C:\Program Files (x86)\cloudflared\cloudflared.exe
set CONFIG_DIR=%USERPROFILE%\.cloudflared

rem When called with a name (e.g. "start-tunnel.bat mic"), run that tunnel directly.
if not "%~1"=="" goto run_direct

:menu
echo ============================
echo   Cloudflare Tunnel Launcher
echo ============================
echo   1. mic     (config.yml   - ai / mic.haitang000.cn)
echo   2. hosting (hosting.yml  - hosting.haitang000.cn)
echo   3. gravity (gravity.yml  - gravity.haitang000.cn / ai.haitang000.cn)
echo   4. mcsm    (mcsm.yml     - mcsm.haitang000.cn)
echo   5. sac     (sac.yml      - sac.haitang000.cn)
echo   6. Start ALL (each in its own window)
echo ============================
set /p CHOICE=Choose a tunnel to start [1-6]:

if "%CHOICE%"=="1" set NAME=mic
if "%CHOICE%"=="2" set NAME=hosting
if "%CHOICE%"=="3" set NAME=gravity
if "%CHOICE%"=="4" set NAME=mcsm
if "%CHOICE%"=="5" set NAME=sac
if "%CHOICE%"=="6" goto all

if not defined NAME goto bad_choice
goto resolve

:run_direct
set NAME=%~1

:resolve
if "%NAME%"=="mic"     set CFG=config.yml
if "%NAME%"=="hosting" set CFG=hosting.yml
if "%NAME%"=="gravity" set CFG=gravity.yml
if "%NAME%"=="mcsm"    set CFG=mcsm.yml
if "%NAME%"=="sac"     set CFG=sac.yml
if not defined CFG goto bad_choice

:run
echo.
echo Starting tunnel "%NAME%" using %CONFIG_DIR%\%CFG%
echo Press Ctrl+C to stop.
echo.
"%CLOUDFLARED%" tunnel --config "%CONFIG_DIR%\%CFG%" run
echo.
echo [cloudflared exited, code: %errorlevel% - window stays open]
goto end

:all
start "cloudflared-mic"     "%~f0" mic
start "cloudflared-hosting" "%~f0" hosting
start "cloudflared-gravity" "%~f0" gravity
start "cloudflared-mcsm"    "%~f0" mcsm
start "cloudflared-sac"     "%~f0" sac
echo.
echo Started all 5 tunnels in separate windows. Each stays open on exit.
goto end

:bad_choice
echo.
echo Invalid choice.

:end
pause
