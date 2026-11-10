@echo off
title OOMPAS Box server for MiSTer
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js is not installed. Open PowerShell and run:  winget install OpenJS.NodeJS.LTS
  echo Then close this window and start it again.
  pause & exit /b 1
)
where ffmpeg >nul 2>nul || (
  echo FFmpeg is not installed. Open PowerShell and run:  winget install Gyan.FFmpeg
  echo Then close this window and start it again.
  pause & exit /b 1
)
node server.mjs
pause
