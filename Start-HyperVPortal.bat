@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\Start-HyperVPortal.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo [ERROR] Hyper-V Web Provisioning Studio stopped with exit code %RC%.
    timeout /t 5 /nobreak >nul
)
endlocal & exit /b %RC%
