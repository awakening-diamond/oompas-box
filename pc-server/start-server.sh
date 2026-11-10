#!/bin/sh
# macOS / Linux launcher for the Spelunkr server.
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js 18+ first (nodejs.org, or: brew install node)"; exit 1; }
command -v ffmpeg >/dev/null || { echo "Install FFmpeg first (brew install ffmpeg / sudo apt install ffmpeg)"; exit 1; }
exec node server.mjs
