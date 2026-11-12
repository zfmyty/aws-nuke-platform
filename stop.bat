@echo off
rem AWS Nuke platform stopper - logic lives in scripts\stop.ps1
chcp 65001 >nul
title AWS Nuke Platform - Stop Service
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\stop.ps1" %*

echo.
pause >nul
