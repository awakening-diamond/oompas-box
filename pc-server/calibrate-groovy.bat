@echo off
title OOMPAS Box picture calibration
cd /d "%~dp0"
rem Put your MiSTerCast folder here to add each calibration to its presets automatically,
rem e.g.  set MISTERCAST_DIR=C:\Users\you\Downloads\MiSTeRCast
set MISTERCAST_DIR=
echo Close MiSTerCast and the OOMPAS Groovy window first, and load Utility ^> Groovy on the MiSTer.
echo.
if "%MISTERCAST_DIR%"=="" set /p MISTERCAST_DIR=MiSTerCast folder, to add the result to its presets [Enter = skip]: 
echo Modes: 480i (640x480i), 720x480i, 320x480i, 240p, 640p, 480i601
set /p MODE=Mode to calibrate [Enter = 480i]: 
if "%MODE%"=="" set MODE=480i
set /p MISTER=MiSTer address [Enter = MiSTer.mshome.net]: 
if "%MISTER%"=="" set MISTER=MiSTer.mshome.net
node groovy-calibrate.mjs %MISTER% %MODE%
pause
