# OOMPAS Box — cable TV for MiSTer

A 1985–2008-style cable dial of 24/7 Internet Archive channels on a CRT through your MiSTer:
18 OOMPAS Box channels (including a scrolling Guide channel and a Weather channel drawn live on your PC),
plus [spelunkr.tv](https://spelunkr.tv)'s channels further up the dial.
Flip channels with your controller. No Groovy needed.

```
 PC (server.mjs)                                     MiSTer (spelunkr.sh)
 ─────────────────                                    ────────────────────
 schedules (OOMPAS + Spelunkr) ─┐   
 archive.org MP4  ─► ffmpeg ─────┴─► 320x240 ──► mplayer ─► framebuffer ─► CRT
                                       MPEG-2 stream        15 kHz 320x240 mode
```

Your PC does the heavy lifting: it works out the schedule, downloads the video, and shrinks it.
The MiSTer only has to decode a small MPEG-2 stream, which is easy for its ARM CPU.

## The channels

| Dial | Channel | | Dial | Channel |
|---|---|---|---|---|
| 2 | **OOMPAS Guide** (OGD), drawn live | | 20 | Mecha & Action (MCHA) |
| 3 | **Weather** (WTHR), drawn live | | 22 | Anime Theater (ANTH) |
| 4 | Paid Programming (PAID) | | 26 | Classic Movies (FLIX) |
| 6 | Toons (TOON) | | 28 | Reruns (RERN) |
| 7 | Saturday Morning (SAT), Spelunkr's schedule | | 30 | Public Access (PUBA) |
| 9 | Sci-Fi (SCFI) | | 32 | Tech (TECH) |
| 11 | Crime & Noir (NOIR) | | 34 | Discovery (DOCS) |
| 13 | Horror (FEAR) | | 36 | Nature (NATR) |
| 19 | Anime (ANIM) | | 38 | Music Video (MUSC) |
| | | | 100+ | Spelunkr's channels (their dial + 100) |

Every channel is family-safe: adult anime and other explicit tapes are filtered out by tag, title and description
(and a list of well-known adult OVA series that are often uploaded untagged).

- **Guide (2)** scrolls listings for every channel, Prevue-style, under clouds that drift toward you out of a hazy horizon over a pale pool-tile floor, with promos for what's coming up
  and ads for businesses that never existed.
- **Weather (3)** loops made-up forecasts for towns that don't quite exist: current conditions, the region, the days ahead,
  an empty radar, an almanac and "Your Area". New forecasts arrive on the 8s (:08, :18, :28 …), and it rains when the forecast says so.
- **Music for Guide and Weather** comes from the Internet Archive's *Attention K-Mart Shoppers* collection of late-80s/early-90s
  in-store tapes. In the background, a few minutes of each tape is paulstretched (slowed about 10× into slow washes),
  given a long soft reverb and a little tape wobble, and saved in `pc-server/oompas-cache/music`: eight tapes, about 30 minutes each,
  a minute or two of work per tape, done once. Until the first one is ready, a soft chord pad plays.
  Change the collection, the number of tapes or the amount of stretch under `"music"` in `oompas-channels.json`
  (`"music": null` turns it off). Your own audio files (mp3, wav, flac, ogg, m4a) in **`pc-server/music`** play too.
- The other channels are scheduled on your PC from Internet Archive searches, a new shuffled schedule every day.
  Series play two or three episodes in a row, some channels change with the time of day (anime after school on Toons,
  a movie every night on Superstation), and vintage ad breaks run between shows. Channels can share tapes, but the same tape
  never airs on two channels at once. The day's schedule is saved, so restarting the server doesn't change it.

**The first start takes a few minutes** while the server looks up the tapes for every channel. Until then those channels
show a "Finding tapes…" card. The results are saved in `pc-server/oompas-cache` and refreshed weekly in the background.
`http://localhost:8090/oompas.json` shows how many tapes each channel found.

### Changing the channels

Edit **`pc-server/oompas-channels.json`** and restart the server. Each channel has a name, dial, call sign and one or more
searches (archive.org's search syntax). Notes at the top of the file explain the options. If a channel finds too few tapes,
the server says so when it starts; widen its search.

**How programs are listed.** Uploaders' titles are tidied for the guide ("ROBOTECH_episode_05_[VHS Rip] 480p" becomes
"Robotech · Ep 5", "Detour (1945) - Full Movie HD" becomes "Detour", 1945). Every program belongs to a named **block** that
changes through the day (Toons: Morning Cartoons → Afternoon Action → Prime Time Toons → Midnight Animation) and has a
**label** (Movie, Cartoon, Public Access, Documentary…). A series is listed by its name ("Robotech"), with a run of episodes as one listing, and a
stretch of short pieces such as music videos is listed under its block name ("After School Countdown"); the guide's
top panel says which episode or video is on now. Magazine-style channels (Public Access, Music Video, Shop, Home, Discovery, Nature, the game and late-animation blocks)
are listed in the grid by block name ("Hobby Hour", "Prime Time Video Mix"); movies by film title; everything else by series
name, which is also spotted from names that recur in a channel ("Popeye - Goonland" and "Popeye - Little Swee'Pea" list as
"Popeye"). The tape's own title and a one-line synopsis from its archive.org description show in the top panel, the banner,
and the Program Info view. Block names, labels and `"list": "block" | "title" | "series"` are set per search in `oompas-channels.json`.

## The OOMPAS Box app (Windows and Mac)

The easiest way to run everything: one app that **plays the channels on your computer** and
**feeds your MiSTer at the same time**. It has FFmpeg built in, so nothing else needs installing.

- **Windows:** run `OOMPAS-Box-Setup-1.0.0.exe`. If Windows says "Windows protected your PC", click **More info → Run anyway** (the app isn't code-signed).
  When Windows asks, **allow OOMPAS Box on Private networks** so the MiSTer can connect.
- **Mac:** unzip the build for your Mac (`apple-silicon` for M1 and newer, `intel` for older Macs) and move **OOMPAS Box** to Applications.
  The first time, macOS will say it can't check the app: open **System Settings → Privacy & Security** and click **Open Anyway**
  (or right-click the app → Open). The app isn't notarized by Apple.

The app *is* the server: while it's open, your MiSTer finds it like before. Closing the app stops everything.
(If the OOMPAS Server window is already running, the app uses that server instead, so you can keep either.)

**Keys** (a TV remote or a game controller mapped to keys works too):

| Key | What it does |
|---|---|
| ↑ ↓ (or Page Up/Down) | Channel up / down |
| 0–9 | Type a channel number |
| OK / Enter | Show what's on (again to hide) |
| G | Guide (↑↓ channels, ←→ shows, OK to watch; ↑ from the top row picks All / ★ My channels / OOMPAS / Spelunkr / each IPTV list) |
| C | Channel list: browse by category (Classic, Movies, News…), by country, or ★ My channels |
| Hold OK (or \*) | Star the channel (adds it to ★ My channels) |
| Z | Picture shape for this channel: Fit · Trim bars · Fill window · Stretch |
| ← → or + − | Volume · **M** mute |
| Back / Esc / Backspace | Back to the last channel (or close a menu) |
| S | Settings · **F** or F11 full screen |

With a mouse: move it for channel and menu buttons, scroll for volume, double-click for full screen.

**Settings** (press S): widescreen fit, black-bar trimming, a CRT look (scanlines and a softer picture), the channel banner, and IPTV.

- **Picture shape:** *Trim bars* (default) spots black bars inside a picture (a 4:3 show inside a widescreen stream, a letterboxed film)
  and zooms past them, in a window or full screen. *Fit* shows the whole frame, *Fill window* fills the window by cutting edges,
  *Stretch* fills it without cutting. **Z** changes it just for the channel you're on, and it's remembered.
- **Stream resolution:** High (960×720), Standard (640×480) or Low (320×240, the MiSTer's own look and the lightest on your network).
  IPTV channels follow it too, when the stream offers smaller versions (Standard caps at 480 lines, Low takes the smallest).
- **Window size** (also in the menu: **View → Window Size**, or Ctrl/Cmd+1…6): pick 640×480, 800×600, 960×720 and so on
  and the window's picture area is set to exactly that, then **kept**: changing channels doesn't touch it. You can still drag it,
  and it stays where you leave it, including the next time you open the app. *Follow picture ×1/×2/×3* instead resizes the window
  to each channel's own shape (that one does change with the channel).
The app keeps its data (settings, schedules, your music for the Guide channel) in its data folder: **File → Open Data Folder**.

### IPTV (optional)

Settings → IPTV:

- **Free channel lists…**: turn on public, free-to-air channel lists from [iptv-org](https://github.com/iptv-org/iptv), by category
  (Classic TV, Animation, Movies, …) or by country. The adult category isn't offered, and **Hide adult channels** filters the rest.
  These are public streams that come and go, so some won't play.
- **Add your own playlist…**: paste an M3U link (or a file path) from your provider, plus an optional XMLTV guide link
  (if the playlist names its own guide, that's used automatically).

- **Countries…**: only show channels from the countries you pick. The category lists (Classic TV, Movies…) are worldwide,
  so pick your country here if you only want, say, US channels.
- **Categories…**: only show channels in the categories you pick. It combines with Countries: United States + Cooking + Animation
  gives the US channels that are cooking *or* animation, and nothing else. (iptv-org has no separate anime category; anime is under Animation.)

IPTV channels go on the dial from **500** (changeable), show in the guide with their listings, and play in the app at their own size.

**My channels:** hold OK (or press \*) on any channel, in the guide or in the channel list (C), to star it. Starred channels get
their own ★ section in the guide and the channel list, and **Settings → Channel up/down goes through → My channels** makes
channel up/down skip everything else, so you get your own lineup.

**IPTV on the MiSTer:** *All*, *Starred only* (just your own lineup, so the MiSTer's dial doesn't fill with hundreds of channels) or *Off*.
The PC converts IPTV to the MiSTer's format like any other channel.

### Watching from another screen

The TV interface is just a web page the server serves: open `http://<your PC's address>:8090/tv/` in any browser on your network
(a laptop, a tablet, a smart TV's browser). This is also the basis for a TV-box app later (see `desktop/README.md`).

## Keeping it up to date

**The app** checks for new versions by itself (from [GitHub Releases](https://github.com/awakening-diamond/oompas-box/releases)),
and **Help → Check for Updates** checks right away.
- **Windows:** the update downloads in the background and installs when you restart the app (it asks).
- **Mac:** the app isn't signed by Apple, so it can't replace itself. It tells you a new version is out and opens the download page;
  replace the app in Applications. Your settings and channels stay either way.

**The MiSTer scripts** update with **update_all**. Add these two lines to the end of `/media/fat/downloader.ini` on the MiSTer once
(over SSH: `nano /media/fat/downloader.ini`):

```
[oompas_box]
db_url = https://raw.githubusercontent.com/awakening-diamond/oompas-box/main/db.json
```

From then on, each update_all run also brings the OOMPAS Box scripts up to date. Your `spelunkr.ini` settings aren't touched.

## 1. On your PC (without the app)

You need **Node.js 18 or newer** and **FFmpeg**. On Windows, open PowerShell and run:

```
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
```

Close PowerShell. Then double-click **`pc-server/OOMPAS Server.exe`**
(on macOS or Linux, run `pc-server/start-server.sh`; `start-server.bat` still works on Windows too).

- If Windows says "Windows protected your PC", click **More info → Run anyway** (the app isn't code-signed).
- When Windows asks, **allow Node.js on Private networks**. The MiSTer can't connect otherwise.
- The window shows the server's address (like `192.168.137.1:8090`) and who's watching what. The MiSTer finds the server by itself.
- **Stop**, **Start** and **Restart** do what they say. **Closing the window stops the server**, along with every ffmpeg it started, so nothing keeps running hidden. If an old server is still running (say, from `start-server.bat`), the app offers to stop it.
- **Open guide** shows what's on every channel in your browser (any "stream" link also plays in VLC). **Groovy…** opens the Groovy sender, which closes with the app.
- **Widescreen** and **Trim black bars** set how videos are framed (see below). Other server settings go in `OOMPAS Server.ini` under `[env]`, e.g. `MAXRATE=2500`.

Keep the app open while you watch.

### Picture framing

Many archive.org copies have black bars baked in: a 4:3 show inside a widescreen file, or a letterboxed film inside a 4:3 file. On a 4:3 TV that leaves the picture in a small box. Before a video plays, the server checks a few moments of it, trims the bars, and fills the screen. It also shows DVD-style files (720x480 with non-square pixels) at their real shape. Each video is only checked once (remembered in `oompas-cache/framing.json`).

For videos that really are widescreen, **Widescreen** picks:

- **Fit**: the whole picture, with bars top and bottom (default)
- **Zoom**: trims the sides a little, so the bars are thinner
- **Fill**: fills the 4:3 screen, cutting off the sides

## 2. On the MiSTer

1. Copy the contents of the `mister/Scripts` folder into `/media/fat/Scripts` on the SD card.
   You can use the network share (SMB), FTP, or the card itself. Make sure the hidden `.spelunkr` folder comes too.
2. On the MiSTer, open **Scripts → spelunkr**. The first run creates `/media/fat/Scripts/spelunkr.ini`.
3. Nothing to set: with `server = auto` (the default) the MiSTer looks for the server on its network, wired or Wi-Fi,
   including a cable shared from the PC, and saves the address it finds. It looks again whenever that address stops answering.
4. Run **Scripts → oompas_box_install** once. It downloads mplayer (about 8 MB, the same build MiSTer SAM uses, or reuses SAM's copy),
   adds **OOMPAS Box** to the top of the MiSTer main menu, and sets up a small launcher that starts at boot.
5. Pick **OOMPAS Box** from the main menu to watch, like any core. Quitting, or loading another core, goes back to the normal menu.

**Scripts → spelunkr** still works too, if you'd rather start it from the Scripts menu.

## Controls

| | Controller | Keyboard |
|---|---|---|
| Channel up / down | D-pad up / down | ↑ ↓ or PgUp / PgDn |
| **Info banner** (what's on, what's next) | D-pad left | ← |
| Previous channel | `recall_buttons` in spelunkr.ini | Backspace |
| **TV guide** | D-pad right | → , G or Tab |
| **Picture settings** | Guide → last entry | P |
| Go to channel | | type the number (e.g. `1` `3`) |
| Quit | Select / Back (buttons 6 or 8) | Esc or Q |

**The OOMPAS BOX guide** is laid out like a classic cable listings screen, in black with rainbow accents.
The top left shows the highlighted channel's full name, what's on, the time slot and the channel description.
The top right shows a picture of the channel you were watching, refreshed every few seconds.
Below is a grid of two-line rows, one per channel, covering the next 90 minutes. Each row shows the channel number and a short call sign (CMCH for COMPUTER CHRONICLES).
The channel you were watching keeps playing its sound underneath. Browsing is instant, because the next frames are fetched ahead of time.
Up/down browses, right tunes in, and **left shows everything about the highlighted program** (press it again to go back). Back/Select or G closes the guide. **SETUP** (picture settings) is the last row. The guide closes by itself after 90 seconds.

You can preview a still of the guide on your PC at `http://localhost:8090/guide.png?w=640&h=480`.

**The info banner** (Left while watching, and for a few seconds after tuning in) shows the channel number and name, the clock,
what's on and its time slot, and an info box below: the block, the kind of program, the year, the episode, and what's next.
Shows are in blue and movies in purple, here and in the guide. It's laid over the picture by the MiSTer (mplayer's bmovl
filter) so it appears straight away; if that filter isn't available, Left re-tunes the channel and the server draws the banner in.
Preview it at `http://localhost:8090/banner.png?dial=26&w=640&h=240`.

Opening the MiSTer OSD with F12 is fine: the TV ignores keys while the OSD is open and brings the picture back when you close it with F12 or Esc.
Launching any core from the OSD stops the TV cleanly.

If quit doesn't work on your controller, set `learn_buttons = yes` in `spelunkr.ini` and run the script.
Press your buttons and it shows their numbers. Put the one you want in `quit_buttons =`, then set `learn_buttons = no`.

## Adjusting the picture

Open the guide and scroll to **PICTURE SETTINGS** at the bottom (or press **P** on a keyboard).
A test pattern appears with a white border marking the picture's edges, plus colour bars and a grey ramp.
Up/down picks a setting and left/right changes it. The pattern updates as you go.
**Done** saves your choices into `spelunkr.ini` and returns to the channel.

The same values can also be edited directly in `spelunkr.ini`:

| Setting | Default | What it does |
|---|---|---|
| `picture_width` / `picture_height` | 100 | Shrink the picture in from the edges (percent) if your TV cuts them off |
| `picture_x` / `picture_y` | 0 | Move the picture: + is right/down, − is left/up (pixels) |
| `brightness` | 0 | −100 to 100 |
| `contrast` / `saturation` | 100 | Percent. `saturation = 0` gives black and white |

The banner and guide follow these settings too.
Good starting point for an overscanned TV: `picture_width = 94`, `picture_height = 94`.

## Groovy mode (experimental)

Instead of the MiSTer playing a video stream, the PC draws every frame (channel, banner, guide with a live picture box)
and sends it to the **Groovy core**, which shows it at a real 15 kHz mode with almost no delay. Button presses go back to the PC.

1. On the MiSTer, run `oompas_groovy_setup.sh` from Scripts (or `bash /media/fat/Scripts/oompas_groovy_setup.sh` over SSH).
   It downloads the Groovy core and its menu program (pinned and checked), and adds the `[Groovy]` entry to **every**
   `MiSTer*.ini`. That's what the stock instructions miss on a SuperStation One, which boots from `MiSTer_SVID.ini`.
2. Open **Utility > Groovy**. No picture over AV? Flip **DIP switch 3 down** so the SuperStation's own encoder makes
   composite from RGB (the Groovy core doesn't drive the FPGA composite output).
3. In the Groovy core's menu: **Audio > Audio: On**, **Server > Joysticks: Digital**, and turn on the core's
   **keyboard (PS/2) input** so a keyboard plugged into the MiSTer works too.
4. On the PC, with the server running, double-click **`start-groovy.bat`** and enter the MiSTer's address
   (or `node groovy.mjs 192.168.1.60`).

Controls: up/down change channel, right opens the guide (up/down browse, right tunes, left shows program info),
left shows the banner, P opens picture settings (saved in pc-server/groovy-settings.json). The same keys work in the Groovy window on the PC. Runs at 640x240 by default (twice as sharp across as 240p, needs a wired link). `set GROOVY_MODE=480i` gives 640x480 interlaced, the tapes' full detail, but some composite TVs show it in black and white; `480i601` tries broadcast-standard timing for those; `320x480i` is soft across with full detail down; `240p` is the lightest. `set GROOVY_SMOOTH=soft` (or `medium`) softens jagged edges; 480i modes also apply a light flicker filter (`GROOVY_FLICKER=0` turns it off). Colour is 16-bit; on a cable `set GROOVY_RGB=888` sends full 24-bit colour (or `888rgb` if reds and blues come out swapped). On Wi-Fi the normal mode is smoother.
`bash oompas_groovy_setup.sh remove` undoes the MiSTer side.

## If something's off

- **CRT won't sync, or the picture is shifted:** try the alternate `video_mode` line in `spelunkr.ini`.
- **"Could not reach the OOMPAS Box server":** check the PC window is open, the address matches, and the Windows firewall allows Node.js.
- **"Please stand by" on a channel:** archive.org couldn't serve that tape. It retries every minute and moves on at the next program.
- **"Off the air" on an OOMPAS channel:** its searches found nothing, or archive.org couldn't be reached. The server tries again
  after 10 minutes. Check `http://localhost:8090/oompas.json`.
- **Logs:** `/tmp/spelunkr.log` and `/tmp/spelunkr-mplayer.log` on the MiSTer. The PC window logs every program it starts.

Your ini files are never edited. While you're watching, a temporary copy with the 320x240 menu mode is mounted over it.
Quitting removes the copy, and so does rebooting.

## Server settings (optional)

Put these under `[env]` in `pc-server/OOMPAS Server.ini` (the app creates it), or set them as environment variables before starting `server.mjs`:

| Setting | Default | What it does |
|---|---|---|
| `PORT` | 8090 | Port the server listens on |
| `FFMPEG` | `ffmpeg` | Full path to ffmpeg if it isn't on your PATH |
| `VQ` | 5 | MPEG-2 quality (2 = best, 8 = smallest) |
| `MAXRATE` | 1800 | Stream ceiling in kbit/s. 2500 on a wired network; 1200 if Wi-Fi still stutters |
| `SOURCES` | best | `small` plays archive.org's soft 512Kb copies, for a slow internet connection |
| `DENOISE` | on | Light tape-grain clean-up, which makes streams much smaller. `DENOISE=0` turns it off |
| `FONT` | Arial Bold | Use your own font file for on-screen text |
| `LEAD` | 8 | Seconds ahead the next program starts, to avoid gaps |
| `LOUDNESS` | -20 | Loudness (LUFS) that every show, ad and station break is levelled to. -16 is louder, -24 quieter |
| `NORMALIZE` | on | Set to 0 to turn loudness levelling off |
| `SPELUNKR` | on | Set to 0 to leave Spelunkr's channels off the dial |
| `MUSIC_DIR` | `pc-server/music` | Folder of music for the Guide and Weather channels |
| `GUIDE_STYLE` | `dream` | The look of the controller guide: `dream` (pastel sky, like the Guide channel) or `classic` (black and rainbow) |
| `WIDESCREEN` | `fit` | Widescreen videos: `fit` (bars top and bottom), `zoom` (trim the sides a little), `fill` (fill the screen) |
| `BARS` | on | Trim black bars baked into videos. `BARS=0` turns it off |
| `OOMPAS_CHANNELS` | `pc-server/oompas-channels.json` | Channel lineup file |

## Credits

- Spelunkr's channels, schedules and bumpers: [spelunkr.tv](https://spelunkr.tv). Video: the [Internet Archive](https://archive.org).
- Display fonts (Shrikhand, Michroma, Zen Dots, Major Mono Display, VT323, Press Start 2P) from Google Fonts, under the SIL Open Font License; downloaded on first run.
- Spelunkr's scheduler, as extracted by [spelunkr-guide](https://github.com/buddytohelpu/spelunkr-guide).
  On first run, `server.mjs` downloads it from that project, pinned to a specific commit and verified by SHA-256. It isn't bundled here.
- On-screen text uses your PC's Arial Bold (Liberation Sans on Linux). The logo is [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) (SIL Open Font License),
  downloaded on first run from Google Fonts, pinned and checksum-verified.
- mplayer for MiSTer by wizzo ([mrext](https://github.com/wizzomafizzo/mrext)) and `mbc` by pocomane,
  both downloaded from [MiSTer SAM](https://github.com/mrchrisster/MiSTer_SAM).
  The 320x240 CRT mode and framebuffer approach also come from SAM and mister_plex.

This is an unofficial, personal-use client. It isn't affiliated with Spelunkr.

### Picture calibration (Groovy and MiSTerCast)

Run `calibrate-groovy.bat` (close MiSTerCast and the OOMPAS Groovy window first). The TV shows a test
pattern: the white border should just touch every edge of the glass, and the circle should be round.

| Key | Does |
|---|---|
| Arrows | Move the picture |
| A / D (or `[` `]`) | Narrower / wider |
| S / W (or `-` `=`) | Shorter / taller |
| T | Try the adjusted timing for real (one blink); T again goes back |
| R | Back to standard timing |
| Enter | Save |
| Esc / Q | Quit |

The numbers on screen (and in the window) are in MiSTerCast's order: Pclock, Hactive, Hbegin, Hend,
Htotal, Vactive, Vbegin, Vend, Vtotal. Type them into MiSTerCast's Modeline boxes, pick the matching preset first,
then Apply Modeline and Save Settings. Enter also saves them to `pc-server/groovy-calibration.json`, and OOMPAS's
Groovy mode uses them for that mode from then on. Each mode keeps its own calibration. If you give `calibrate-groovy.bat` your MiSTerCast folder (or set `MISTERCAST_DIR` in it), each save is also added to MiSTerCast's `modelines.dat` as a preset named "... OOMPAS calibrated".
