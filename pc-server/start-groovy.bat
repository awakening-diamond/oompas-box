@echo off
title OOMPAS Box over Groovy
cd /d "%~dp0"
set MISTER=%1
if "%MISTER%"=="" set /p MISTER=MiSTer address [Enter = MiSTer.mshome.net, for a shared cable]: 
if "%MISTER%"=="" set MISTER=MiSTer.mshome.net
node groovy.mjs %MISTER% %2
pause
