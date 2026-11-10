#!/bin/bash
# OOMPAS Box for MiSTer — cable-style Internet Archive channels on your CRT.
# Needs the OOMPAS Box server (pc-server/server.mjs) running on your PC.
# Settings: /media/fat/Scripts/spelunkr.ini

BASE=/media/fat/Scripts/.spelunkr
INI=/media/fat/Scripts/spelunkr.ini
SAM=/media/fat/Scripts/.MiSTer_SAM
# mplayer (built for MiSTer by wizzo) and mbc (by pocomane), as distributed by MiSTer SAM.
SAM_RAW=https://raw.githubusercontent.com/mrchrisster/MiSTer_SAM/main/.MiSTer_SAM

mkdir -p "$BASE"

fetch() {  # url dest
    curl -sfL --connect-timeout 15 -o "$2" "$1" && return 0
    [ -f /etc/ssl/certs/cacert.pem ] && curl -sfL --connect-timeout 15 --cacert /etc/ssl/certs/cacert.pem -o "$2" "$1"
}

MODE="$1"
if [ ! -f "$INI" ]; then
    cp "$BASE/spelunkr.ini.default" "$INI"
    echo "Created $INI (server = auto: it finds your PC on the network)"
    echo
fi

# (spelunkr_tv.py --check below validates the server setting)

# --- player components -------------------------------------------------
if [ ! -x "$BASE/mplayer" ]; then
    if [ -f "$SAM/mplayer" ]; then
        echo "Using MiSTer SAM's mplayer..."
        cp "$SAM/mplayer" "$BASE/"; cp "$SAM"/libtinfo.so.6 "$BASE/" 2>/dev/null
    else
        echo "Downloading mplayer (about 8 MB)..."
        if [ -f "$SAM/mplayer.zip" ]; then cp "$SAM/mplayer.zip" /tmp/spelunkr-mplayer.zip
        else fetch "$SAM_RAW/mplayer.zip" /tmp/spelunkr-mplayer.zip || { echo "Download failed. Check the MiSTer's internet connection."; exit 1; }
        fi
        unzip -ojq /tmp/spelunkr-mplayer.zip -d "$BASE" && rm -f /tmp/spelunkr-mplayer.zip
    fi
    chmod +x "$BASE/mplayer"
fi
if [ ! -x "$BASE/mbc" ]; then
    if [ -f "$SAM/mbc" ]; then cp "$SAM/mbc" "$BASE/mbc"
    else echo "Downloading mbc..."; fetch "$SAM_RAW/mbc" "$BASE/mbc" || { echo "Download failed."; exit 1; }
    fi
    chmod +x "$BASE/mbc"
fi

# --- learn controller buttons -------------------------------------------
if grep -Eiq '^[[:space:]]*learn_buttons[[:space:]]*=[[:space:]]*yes' "$INI"; then
    python3 "$BASE/spelunkr_tv.py" --learn
    echo
    echo "Put the numbers in $INI and set learn_buttons=no"
    exit 0
fi

# --- install as a core ---------------------------------------------------------
if [ "$MODE" = install ]; then
    cp "$BASE/OOMPAS Box.mgl" "/media/fat/OOMPAS Box.mgl" || { echo "Couldn't create the core entry."; exit 1; }
    STARTUP=/media/fat/linux/user-startup.sh
    [ -f "$STARTUP" ] || printf '#!/bin/sh\n' > "$STARTUP"
    if ! grep -q oompas_daemon.py "$STARTUP"; then
        echo '[ -f /media/fat/Scripts/.spelunkr/oompas_daemon.py ] && (setsid python3 /media/fat/Scripts/.spelunkr/oompas_daemon.py > /tmp/oompas_daemon.log 2>&1 < /dev/null &)  # OOMPAS Box' >> "$STARTUP"
    fi
    pgrep -f oompas_daemon.py >/dev/null || (setsid python3 "$BASE/oompas_daemon.py" > /tmp/oompas_daemon.log 2>&1 < /dev/null &)
    echo "OOMPAS Box is installed."
    echo
    echo "Pick \"OOMPAS Box\" from the main menu to watch."
    echo "Quitting, or loading another core, goes back"
    echo "to the normal menu."
    echo
    python3 "$BASE/spelunkr_tv.py" --check || echo "(The PC server isn't reachable yet; start it before watching.)"
    exit 0
fi

# --- go ---------------------------------------------------------------------
python3 "$BASE/spelunkr_tv.py" --check || exit 1

# Stop MiSTer SAM if it's running so it doesn't fight over the screen.
[ -x /media/fat/Scripts/MiSTer_SAM_on.sh ] && pgrep -f MiSTer_SAM_on >/dev/null && /media/fat/Scripts/MiSTer_SAM_on.sh stop >/dev/null 2>&1

echo "Tuning in..."
setsid python3 "$BASE/spelunkr_tv.py" > /tmp/spelunkr.log 2>&1 < /dev/null &
sleep 1
exit 0
