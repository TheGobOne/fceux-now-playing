@echo off
rem Drag a DWR ROM onto this file: it reads the song list beside the ROM, then opens FCEUX with the now-playing script.
rem FCEUX: put the full path to fceux64.exe in fceux-path.txt (or leave it out if fceux64.exe is on your PATH).
cd /d "%~dp0"
set FCEUX=fceux64.exe
if exist fceux-path.txt set /p FCEUX=<fceux-path.txt
node make-dwr-lua.js "%~1"
if errorlevel 1 (
  echo.
  echo Could not read the song list for this ROM. Press a key to open it without the script.
  pause >nul
  start "" "%FCEUX%" "%~1"
  exit /b
)
start "" "%FCEUX%" -lua "%~dp0music-now-dwr.lua" "%~1"
