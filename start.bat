@echo off
chcp 65001 >nul
title 明月秋青脚本 - 本地服务器

echo ================================
echo   明月秋青脚本 本地服务器
echo ================================
echo.

cd /d "%~dp0"

:: 检查 Node.js 是否安装
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] 未检测到 Node.js，请先安装！
    echo.
    echo     下载地址：https://nodejs.org
    echo     推荐安装 LTS 版本，安装后重启此脚本。
    echo.
    goto :end
)
echo [*] Node.js 已检测到
echo.

:: 杀掉占用 8888 端口的旧进程
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8888" ^| findstr "LISTENING"') do (
    echo [*] 关闭旧进程 PID: %%a
    taskkill /F /PID %%a >nul 2>&1
    timeout /t 1 /nobreak >nul
)

echo [*] 正在启动服务器...
echo.

node server.js

:end
pause
