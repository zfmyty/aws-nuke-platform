@echo off
rem AWS Nuke platform launcher - logic lives in scripts\start.ps1
rem
rem Elevation flow:
rem   1. Already elevated?  -> start directly.
rem   2. Not elevated       -> relaunch this script as administrator (Windows
rem                            shows the UAC prompt, the user only confirms).
rem   3. UAC declined       -> fall back to a normal launch, so the platform
rem                            still starts and the top bar shows a tag.
rem
rem The elevated copy writes a marker file on entry; the parent treats the
rem marker as proof that UAC was accepted, because Start-Process cannot be
rem trusted to report a decline through errorlevel alone.
rem
rem Launcher arguments (e.g. -Port 3001) are stored in a temp file before
rem elevation and replayed by the elevated copy. They must NOT travel through
rem %* together with /elevated: cmd cannot drop a single token from %*, and
rem start.ps1 would receive "/elevated" as the value of -Port.
chcp 65001 >nul
title AWS Nuke Platform - Running (Ctrl+Enter or close window to stop)
cd /d "%~dp0"

set "NUKE_MARK=%TEMP%\aws-nuke-elevated.flag"
set "NUKE_ELEV_LOG=%TEMP%\aws-nuke-elevate.log"
set "NUKE_ARGS_FILE=%TEMP%\aws-nuke-launch-args.txt"

rem ---- entry of the elevated copy: replay the original launcher arguments ----
if /i "%~1"=="/elevated" (
  > "%NUKE_MARK%" echo ok
  set "NUKE_FORWARD="
  if exist "%NUKE_ARGS_FILE%" set /p NUKE_FORWARD=<"%NUKE_ARGS_FILE%"
  del /q "%NUKE_ARGS_FILE%" >nul 2>&1
  goto launch_elevated
)

rem ---- already elevated? (net session fails for a standard-permission process) ----
net session >nul 2>&1
if not errorlevel 1 goto launch

rem ---- hand over to an elevated copy of this script, in its own window ----
if exist "%NUKE_MARK%" del /q "%NUKE_MARK%" >nul 2>&1
if exist "%NUKE_ELEV_LOG%" del /q "%NUKE_ELEV_LOG%" >nul 2>&1
> "%NUKE_ARGS_FILE%" echo(%*
powershell -NoProfile -ExecutionPolicy Bypass -Command "$a = @('/d','/c','\"\"%~f0\"\" /elevated'); try { $p = Start-Process -FilePath 'cmd.exe' -ArgumentList $a -Verb RunAs -PassThru -WindowStyle Normal -ErrorAction Stop; if (-not $p) { 'no process object' | Out-File -Encoding ASCII '%NUKE_ELEV_LOG%' } } catch { $_.Exception.Message | Out-File -Encoding ASCII '%NUKE_ELEV_LOG%'; exit 1 }" >nul 2>&1
if errorlevel 1 goto fallback

rem ---- wait for the elevated window to confirm it started ----
timeout /t 4 /nobreak >nul 2>&1
if exist "%NUKE_MARK%" (
  del /q "%NUKE_MARK%" >nul 2>&1
  del /q "%NUKE_ARGS_FILE%" >nul 2>&1
  exit /b 0
)

:fallback
if exist "%NUKE_MARK%" del /q "%NUKE_MARK%" >nul 2>&1
del /q "%NUKE_ARGS_FILE%" >nul 2>&1
echo.
echo   [Notice] Administrator rights were not granted.
echo   Starting with standard permissions. Everything works except the one-click
echo   AWS CLI installer; the top bar will show a standard-permission tag.
echo   To switch to administrator mode later, close this window and run
echo   start.bat again, then choose "Yes" in the Windows prompt.
echo.

:launch
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\start.ps1" %*
goto end

:launch_elevated
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\start.ps1" %NUKE_FORWARD%

:end
rem start.ps1 already pauses ("press Enter to close"), no second pause here.
rem Keeping only one prompt makes shutdown feel smooth (no batch Y/N either:
rem the service consumes Ctrl+C in raw mode, cmd never sees the interrupt).
