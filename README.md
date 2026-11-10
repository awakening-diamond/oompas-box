# OOMPAS Box — retro cable TV for your computer

A 1985–2008-style cable dial of 24/7 Internet Archive channels, as a desktop app for Windows and Mac:
18 OOMPAS Box channels (including a scrolling Guide channel and a Weather channel drawn live),
[spelunkr.tv](https://spelunkr.tv)'s channels further up the dial, and your own IPTV channels if you want them.
Flip channels with the keyboard, a remote, or the mouse; pull up the guide; star channels to make your own lineup.

## Installing

Download the latest version from [Releases](https://github.com/awakening-diamond/oompas-box/releases/latest).
FFmpeg is built in, so nothing else needs installing.

- **Windows:** run `OOMPAS-Box-Setup-<version>.exe`. If Windows says "Windows protected your PC", click **More info → Run anyway** (the app isn't code-signed).
- **Mac:** unzip the build for your Mac (`mac-arm64` for Apple Silicon, M1 and newer; `mac-x64` for older Intel Macs) and move **OOMPAS Box** to Applications.
  The first time, macOS will say it can't check the app: open **System Settings → Privacy & Security** and click **Open Anyway**
  (or right-click the app → Open). The app isn't notarized by Apple.

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
- **Stream resolution:** High (960×720), Standard (640×480) or Low (320×240, a soft vintage look and the lightest on your PC).
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



### Watching from another screen

The TV interface is a web page the app serves to this computer only (so there's no firewall prompt). To watch from a
laptop, tablet or a smart TV's browser on your network, set the environment variable `LISTEN=0.0.0.0` before starting
OOMPAS Box, then open `http://<this PC's address>:8090/tv/` there. This is also the basis for a TV-box app later
(see `desktop/README.md`).

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
  given a long soft reverb and a little tape wobble, and saved in the app's data folder: eight tapes, about 30 minutes each,
  a minute or two of work per tape, done once. Until the first one is ready, a soft chord pad plays.
  Change the collection, the number of tapes or the amount of stretch under `"music"` in `oompas-channels.json`
  (`"music": null` turns it off). Your own audio files (mp3, wav, flac, ogg, m4a) in the **Music folder** (File → Open Music Folder) play too.
- The other channels are scheduled on your PC from Internet Archive searches, a new shuffled schedule every day.
  Series play two or three episodes in a row, some channels change with the time of day (anime after school on Toons,
  a movie every night on Superstation), and vintage ad breaks run between shows. Channels can share tapes, but the same tape
  never airs on two channels at once. The day's schedule is saved, so restarting the app doesn't change it.

**The first start takes a few minutes** while OOMPAS Box looks up the tapes for every channel. Until then those channels
show a "Finding tapes…" card. The results are saved in the app's data folder and refreshed weekly in the background.

### Changing the channels

**File → Edit Channel Lineup** opens your own copy of the lineup (`oompas-channels.json`); save it and restart the app.
Each channel has a name, dial, call sign and one or more searches (archive.org's search syntax). Notes at the top of the file
explain the options. If a channel finds too few tapes, the server log (Help → Server Log) says so; widen its search.
Delete your copy to go back to the built-in lineup.

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

## Keeping it up to date

OOMPAS Box checks for new versions by itself ([Releases](https://github.com/awakening-diamond/oompas-box/releases)), and
**Help → Check for Updates** checks right away.
- **Windows:** the update downloads in the background and installs when you restart the app (it asks).
- **Mac:** the app isn't signed by Apple, so it can't replace itself. It tells you a new version is out and opens the download page;
  replace the app in Applications. Your settings and channels stay either way.

## Casting to a CRT

OOMPAS Box itself is a PC/Mac app. To watch it on a CRT through a MiSTer, cast the OOMPAS Box window with **OOMPAS Cast**
(a separate app, using the Groovy_MiSTer core). With Window size set to 640×480 and the picture shape on *Trim bars*, the window
matches what goes to the TV.

## Settings for advanced users

Environment variables read by the engine (`pc-server/server.mjs`) when the app starts:

| Setting | Default | What it does |
|---|---|---|
| `OOMPAS_PORT` | 8090 | Port the app's engine uses (on this computer) |
| `LISTEN` | 127.0.0.1 | `0.0.0.0` lets other devices on your network open the TV interface |
| `SOURCES` | best | `small` plays archive.org's soft 512Kb copies, for a slow internet connection |
| `DENOISE` | on | Light tape-grain clean-up. `DENOISE=0` turns it off |
| `LEAD` | 8 | Seconds ahead the next program starts, to avoid gaps |
| `LOUDNESS` | -20 | Loudness (LUFS) every show, ad and station break is levelled to. -16 is louder, -24 quieter |
| `NORMALIZE` | on | Set to 0 to turn loudness levelling off |
| `SPELUNKR` | on | Set to 0 to leave Spelunkr's channels off the dial |
| `WIDESCREEN` | `fit` | Archive videos that are truly widescreen: `fit`, `zoom` (trim the sides a little), `fill` (the app's Settings set this too) |
| `BARS` | on | Trim black bars baked into archive videos (the app's Settings set this too) |

## Building it yourself

See [`desktop/README.md`](desktop/README.md): `npm install` in `desktop/`, add FFmpeg builds, then `npm run dist:win` / `npm run dist:mac`.
`npm run release` builds both and publishes a GitHub release.

## Credits

- Spelunkr's channels, schedules and bumpers: [spelunkr.tv](https://spelunkr.tv). Video: the [Internet Archive](https://archive.org).
- Free IPTV lists: [iptv-org](https://github.com/iptv-org/iptv) (public, free-to-air streams).
- Display fonts (Shrikhand, Michroma, Zen Dots, Major Mono Display, VT323, Press Start 2P) from Google Fonts, under the SIL Open Font License.
- Spelunkr's scheduler, as extracted by [spelunkr-guide](https://github.com/buddytohelpu/spelunkr-guide).
  On first run it's downloaded from that project, pinned to a specific commit and verified by SHA-256. It isn't bundled here.
- Player libraries: [mpegts.js](https://github.com/xqq/mpegts.js) and [hls.js](https://github.com/video-dev/hls.js) (Apache 2.0).
  FFmpeg (GPL) is included as a separate program; see `desktop/ffmpeg/LICENSE-ffmpeg.txt`.

This is an unofficial, personal-use app. It isn't affiliated with Spelunkr or the Internet Archive.
