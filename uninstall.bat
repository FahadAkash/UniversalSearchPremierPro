@echo off
title Universal Search - Uninstaller

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo This needs to run as Administrator.
    echo Right-click uninstall.bat and choose "Run as administrator".
    pause
    exit /b 1
)

set "DEST=C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\UniversalSearch"

echo Removing Universal Search...
if exist "%DEST%" (
    rmdir /s /q "%DEST%"
    echo Removed: %DEST%
) else (
    echo Nothing installed at: %DEST%
)

echo.
echo Note: PlayerDebugMode was left enabled in the registry, since other
echo unsigned CEP panels you use may depend on it. To turn it off:
echo   reg delete "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /f
echo (repeat for whichever CSXS version number applies to you)
echo.
pause
