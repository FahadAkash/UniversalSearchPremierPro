@echo off
setlocal enabledelayedexpansion
title Universal Search - Installer

echo ============================================
echo   Universal Search - Premiere Pro Installer
echo ============================================
echo.

REM --- Must run as Administrator (writes to Program Files + HKLM-adjacent CEP folder) ---
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo This installer needs to run as Administrator.
    echo Right-click install.bat and choose "Run as administrator".
    echo.
    pause
    exit /b 1
)

REM "%~dp0." (with the trailing dot) is the safe way to reference this
REM script's own folder as a source path -- avoids the trailing-backslash-
REM before-quote bug, and works fine even with spaces or "&" in the path.
set "SRC=%~dp0."
set "DEST=C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\UniversalSearch"

echo [1/3] Enabling CEP debug mode for unsigned extensions...
REM Add PlayerDebugMode for a range of CSXS versions so it works
REM regardless of which Premiere Pro / CEP version is installed.
for %%V in (9 10 11 12 13 14 15 16 17 18) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)
echo       Done.

echo [2/3] Copying extension files to CEP extensions folder...

REM robocopy (not xcopy) -- handles spaces/"&" in paths correctly and its
REM /XF exclude switch takes bare filenames, not a fragile path argument.
robocopy "%SRC%" "%DEST%" /E /XF install.bat uninstall.bat excludes.txt README.md UniversalSearch.zip /NFL /NDL /NJH /NJS >nul

REM robocopy exit codes 0-7 all mean success (see /? for the bitmask);
REM only 8+ indicates a real failure.
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
