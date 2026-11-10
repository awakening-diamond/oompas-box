## OOMPAS Box 1.3.5 (engine update)

- Channels 69 and 420 can now follow one **shared video list** published in the repo, so everyone with OOMPAS Box gets the
  same videos at the same times. A daily GitHub Action makes the list with the YouTube Data API (all uploads, not just the
  200 the player hands over). Until its API key is set up, each app reads the list itself as before.

## OOMPAS Box 1.3.4 (engine update)

- Safety net for 1.3.3's list reading in case YouTube's player doesn't say which video it's on.

## OOMPAS Box 1.3.3 (engine update)

- Fix: YouTube channels could play a different video than the guide said, and loop it. Reading a playlist sometimes took a
  video's length and title from the one before it; it now waits until the player is really on each video. Lists read by
  older versions are read again automatically.
- If a video turns out shorter or longer than listed, the schedule corrects itself, and a video that ends early is never
  replayed; the channel waits for the next one.
- The shuffle keeps its order when a video is added or dropped.
- Captions (CC) now come on by themselves on every video and channel when the setting is on.

## OOMPAS Box 1.3.2

- Safer engine updates: a new engine is downloaded in the background and starts the next time OOMPAS Box opens, instead of
  switching while you watch. Help → Check for Updates offers to restart right away.
- The log is now kept on disk (`oompas.log` in the data folder; the run before is `oompas-previous.log`), with a memory line
  every 5 minutes and a note if the window stops responding. Help → Show Log File.

## OOMPAS Box 1.3.1 (engine update)

- New: **captions (CC).** Press **T**, click the **CC** button (move the mouse to show it), or Settings → Picture → Captions.
  Works on YouTube channels (English captions when the video has them) and IPTV channels whose streams carry subtitles or TV
  closed captions. The old-tape channels don't have captions to show.

## OOMPAS Box 1.3.0

- **Updates without reinstalling.** The engine (channels, guide, YouTube, IPTV, the TV screens) now updates itself from GitHub
  in the background and switches over in a couple of seconds, no installer and no restart. The installer is only needed when the
  app around it changes. Help → About shows both versions.

## OOMPAS Box 1.2.3

- Fix: YouTube channels made from a channel (`youtube.com/@name`) couldn't find their videos. The channel lookup is more careful
  (the page also names other channels), the video list gets a second way to load, and if YouTube still won't list them, the
  channel starts with its newest 15 videos.

## OOMPAS Box 1.2.2

- The built-in channel lists (channels 69 and 420, the 2000s Cable lineup) now update themselves from GitHub every few hours,
  so fixes to them no longer need a new version.
- Releases are now built and published automatically.

## OOMPAS Box 1.2.1

- New: **channels 69 and 420**, built in: Hungrybear9562's videos, shuffled, each channel on its own schedule.

## OOMPAS Box 1.2.0

- New: **YouTube channels.** Make a channel from any YouTube playlist or YouTube channel; it plays on a schedule like TV, with
  real titles and times in the guide. Settings → YouTube → Add a YouTube channel.

## OOMPAS Box 1.1.1

- New: **TV guides for IPTV.** Real show listings from the free Pluto TV, Samsung TV Plus, Plex and Roku guides, matched to your
  channels automatically (94 of the 100 2000s Cable channels). Settings → IPTV → Free TV guides.

## OOMPAS Box 1.1.0

- New: **2000s Cable**, 100 hand-picked national channels (official free sources only) on 100–199. Settings → IPTV → Free channel lists.
- OOMPAS Box's own channels are off by default (Settings → Channels: Off / Guide & Weather / All); Spelunkr's stay.
- English filter also drops networks iptv-org mislabels as English (Telemundo, Univision, Vevo Latino, …).
- A PC/Mac app now: everything for running the MiSTer directly (scripts, Groovy sender, MPEG-2 streams) is gone. To watch on a CRT, cast the window with OOMPAS Cast.
- The engine only listens on this computer, so there's no firewall prompt.
- Updates itself: checks GitHub for new versions (Windows installs on restart; Mac shows a download link). Help → Check for Updates.
- IPTV: Languages filter (from iptv-org's language data), combines with Countries and Categories.
- IPTV: "Check which channels play" tests every channel from your PC; "Hide channels that don't play".
- IPTV: cleaner channel names ("(720p)", "[Geo-blocked]" shown as tags).
- Picture shapes (Z): Fit, Trim bars, Fill window, Stretch. View → Window Size; the window keeps its size.
- File → Edit Channel Lineup: your own copy of the channel list.
