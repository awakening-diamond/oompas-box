#!/bin/bash
# OOMPAS Box: set up the Groovy core on this MiSTer (tested setup for the SuperStation One).
#
# Groovy_MiSTer (github.com/psakhis/Groovy_MiSTer) turns the MiSTer into a screen for the PC:
# the PC draws every frame and the core shows it at a real 15 kHz mode, with almost no delay.
#
# Why the stock instructions don't work on a SuperStation One:
#   * They add "[Groovy] main=MiSTer_groovy" to MiSTer.ini, but a SuperStation boots from
#     another ini (MiSTer_SVID.ini for composite/S-Video), which never gets the entry, so the
#     Groovy core starts with the wrong menu program and does nothing. This script adds the
#     entry to every MiSTer*.ini.
#   * The Groovy core is built on the standard MiSTer framework, which doesn't drive the
#     SuperStation's FPGA composite output. If you get no picture over AV, flip DIP switch 3
#     DOWN: the SuperStation's own video encoder then makes composite/S-Video from RGB, which
#     works for every core. (Flip it back up if you prefer the FPGA composite for other cores.)
#
#   bash /media/fat/Scripts/oompas_groovy_setup.sh          install
#   bash /media/fat/Scripts/oompas_groovy_setup.sh remove   remove Groovy (this or any earlier install)
set -e
FAT=${FAT:-/media/fat}
REV=109908c9ddbd4397ba7aadb193de61fdb8cb34e6
BASE=https://raw.githubusercontent.com/psakhis/Groovy_MiSTer/$REV/hps_linux
MAIN_SHA=99e5e76b0303a46f78b3685a3cb0f132b8e2d696a1c10d01ce3ab9ccfc9c598c
CORE=Groovy_20240922.rbf
CORE_SHA=73d366a326db35d5490c53cc3c389a21262de88a7dbbadfc29e374ed0b55828f
MARK='; added by OOMPAS Box (oompas_groovy_setup.sh)'

if [ "$1" = "remove" ]; then
  # Removes any Groovy install, this script's or an older manual one.
  for ini in "$FAT"/MiSTer*.ini; do
    [ -f "$ini" ] || continue
    if grep -qi '^\[Groovy\]' "$ini"; then
      cp "$ini" "$ini.before-groovy-remove.bak"
      # drop the [Groovy] section (up to the next [section]) and our marker line
      awk -v m="$MARK" '$0==m{next} /^\[/{skip=(tolower($0) ~ /^\[groovy\]/)} !skip' "$ini" > "$ini.tmp" && mv "$ini.tmp" "$ini"
      echo "Removed the [Groovy] section from $(basename "$ini") (backup: $(basename "$ini").before-groovy-remove.bak)"
    fi
  done
  rm -fv "$FAT"/MiSTer_groovy "$FAT"/MiSTer_groovy_XDP "$FAT"/_Utility/Groovy*.rbf "$FAT"/Groovy*.rbf 2>/dev/null | sed 's/^/Deleted /' || true
  echo "Groovy removed. (Its menu settings in $FAT/config are kept; delete $FAT/config/Groovy* to reset them.)"
  exit 0
fi

fetch() {   # url, file, sha256
  local tmp="$2.download" ca
  echo "Downloading $(basename "$2")..."
  if ! curl -fsSL --retry 3 -o "$tmp" "$1" 2>/dev/null; then
    # Many MiSTer images ship without a CA bundle curl can find. Try the usual spots,
    # then fall back to skipping TLS checks: safe here because the file is
    # rejected below unless its sha256 matches the pinned value exactly.
    for ca in /etc/ssl/certs/cacert.pem /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem; do
      [ -f "$ca" ] && curl -fsSL --retry 3 --cacert "$ca" -o "$tmp" "$1" 2>/dev/null && break
    done
    if [ ! -s "$tmp" ]; then
      echo "  (no usable certificate bundle; downloading without TLS check, verifying by checksum)"
      curl -fsSLk --retry 3 -o "$tmp" "$1" || { rm -f "$tmp"; echo "Download failed. Is the MiSTer online? (ping github.com)"; exit 1; }
    fi
  fi
  echo "$3  $tmp" | sha256sum -c --status || { rm -f "$tmp"; echo "Checksum mismatch for $(basename "$2"); not installed."; exit 1; }
  mv "$tmp" "$2"
}

mkdir -p "$FAT/_Utility"
fetch "$BASE/MiSTer_groovy" "$FAT/MiSTer_groovy" "$MAIN_SHA"
chmod +x "$FAT/MiSTer_groovy"
fetch "$BASE/_Utility/$CORE" "$FAT/_Utility/$CORE" "$CORE_SHA"

for ini in "$FAT"/MiSTer*.ini; do
  [ -f "$ini" ] || continue
  if grep -qi '^\[Groovy\]' "$ini"; then
    echo "$(basename "$ini") already has a [Groovy] section; left as it is."
    continue
  fi
  cp "$ini" "$ini.oompas-groovy.bak"
  printf '\n%s\n[Groovy]\nmain=MiSTer_groovy\n' "$MARK" >> "$ini"
  echo "Added the Groovy entry to $(basename "$ini")"
done

IP=$(ip -4 addr show 2>/dev/null | awk '/inet / && $2 !~ /^127/ {sub(/\/.*/, "", $2); print $2; exit}')
[ -n "$IP" ] || IP="<this MiSTer's address>"
cat <<EOF

Done. Next:
  1. Open the Groovy core: main menu > Utility > Groovy.
     (No picture over AV? Flip DIP switch 3 down; see the note at the top of this script.)
  2. In its menu (F12 or the OSD button): Audio > Audio: On, and Server > Joysticks: Digital.
  3. On your PC, with server.mjs running:   node groovy.mjs $IP
A wired network connection is best (it needs about 30 Mbit/s).
EOF
