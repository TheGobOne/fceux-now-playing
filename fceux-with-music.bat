@echo off
rem Drag a ZORA ROM onto this file: it finds the ROM's songs in your packs, then opens FCEUX with the now-playing script.
rem FCEUX: put the full path to fceux64.exe in fceux-path.txt (or leave it out if fceux64.exe is on your PATH).
cd /d "%~dp0"
set FCEUX=fceux64.exe
if exist fceux-path.txt set /p FCEUX=<fceux-path.txt
node make-music-lua.js "%~1"
if errorlevel 1 (
  echo.
  echo Could not match this ROM to your packs. Press a key to open it without the script.
  pause >nul
  start "" "%FCEUX%" "%~1"
  exit /b
)
start "" "%FCEUX%" -lua "%~dp0music-now.lua" "%~1"
