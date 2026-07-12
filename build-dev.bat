@echo off
title MQZN Build (one-shot)

cd /d "%~dp0"

echo Compiling source (development mode)...
echo.

call pnpm build:dev

if errorlevel 1 (
    echo.
    echo [ERROR] Build failed. See output above.
    pause
    exit /b 1
)

echo.
echo [OK] Build complete. Refresh the tavern page to load latest script.
echo.
pause