@echo off
rem AWS Nuke platform - environment check only (does not start the service)
chcp 65001 >nul
title AWS Nuke Platform - Environment Check
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\check.ps1" %*

echo.
pause >nul
