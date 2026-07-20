@echo off
setlocal enabledelayedexpansion
title Universal Search - Installer

echo ============================================
echo   Universal Search - Premiere Pro Installer
echo ============================================
echo.

set "SRC=%~dp0."
set "DEST=%APPDATA%\Adobe\CEP\extensions\UniversalSearch"

echo [1/3] Enabling CEP debug mode for unsigned extensions...
for %%V in (9 10 11 12 13 14 15 16 17 18) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)
echo       Done.

echo [2/3] Copying extension files to CEP extensions folder...

robocopy "%SRC%" "%DEST%" /E /XF install.bat uninstall.bat excludes.txt README.md UniversalSearch.zip /NFL /NDL /NJH /NJS >nul

if %errorLevel% geq 8 (
    echo       Copy failed. Check that Premiere Pro is closed and try again.
    pause
    exit /b 1
)
echo       Done. Installed to:
echo       %DEST%

echo [3/3] Finishing up...
echo.
echo ============================================
echo   Install complete!
echo ============================================
echo   1. Make sure Premiere Pro is fully closed, then reopen it.
echo   2. Go to Window - Extensions - Universal Search.
echo ============================================
echo.
pause
