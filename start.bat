@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel% equ 0 (
  py -3 app.py
  goto :end
)

where python >nul 2>nul
if %errorlevel% equ 0 (
  python app.py
  goto :end
)

echo Python 3 was not found. Install Python 3.10 or later first.
pause

:end
endlocal
