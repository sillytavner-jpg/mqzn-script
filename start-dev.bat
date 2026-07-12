@echo off
title MQZN Dev Server (HTTP 8889)

cd /d "%~dp0"

echo Starting HTTP server on port 8889...
echo Run build-dev.bat to compile after editing source.
echo.

node serve-dev.mjs

if errorlevel 1 (
    echo.
    echo [ERROR] Server exited with error.
    pause
)