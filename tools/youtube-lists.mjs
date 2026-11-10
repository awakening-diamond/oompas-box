// Makes pc-server/lineups/youtube-videos.json: the video lists of the built-in YouTube channels
// (pc-server/lineups/youtube.json), from the YouTube Data API. Run daily by the "YouTube lists"
// GitHub Action; installed apps read the file from GitHub, so everyone gets the same schedule.
//   YOUTUBE_API_KEY=... node tools/youtube-lists.mjs
import fs from 'node:fs';

const KEY = process.env.YOUTUBE_API_KEY;
const DIR = new URL('../pc-server/lineups/', import.meta.url);
const OUT = new URL('youtube-videos.json', DIR);
if (!KEY) { console.log('::warning::No YOUTUBE_API_KEY secret yet; the apps keep reading the lists themselves.'); process.exit(0); }

async function api(path, params) {
  const u = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) u.searchParams.set(k, v);
  const r = await fetch(u);
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error?.message || r.status}`);
  return j;
}
// "PT1H2M3S" -> 3723
const seconds = d => { const m = String(d).match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/) || []; return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0); };

const builtins = JSON.parse(fs.readFileSync(new URL('youtube.json', DIR), 'utf8')).channels;
const handles = [...new Set(builtins.map(b => b.handle))];
const out = {};
for (const handle of handles) {
  const ch = (await api('channels', { part: 'contentDetails,snippet', forHandle: handle })).items?.[0];
  if (!ch) throw new Error(`No YouTube channel ${handle}`);
  const list = ch.contentDetails.relatedPlaylists.uploads;
  const ids = [];
  let page = '';
  do {
    const j = await api('playlistItems', { part: 'contentDetails', playlistId: list, maxResults: 50, ...(page ? { pageToken: page } : {}) });
    ids.push(...j.items.map(i => i.contentDetails.videoId));
    page = j.nextPageToken || '';
  } while (page && ids.length < 5000);
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const j = await api('videos', { part: 'contentDetails,snippet,status', id: ids.slice(i, i + 50).join(',') });
    const byId = new Map(j.items.map(v => [v.id, v]));
    for (const id of ids.slice(i, i + 50)) {
      const v = byId.get(id);
      if (!v) continue;                                                     // removed
      const rr = v.contentDetails.regionRestriction;
      const blockedUS = rr && ((rr.blocked || []).includes('US') || (rr.allowed && !rr.allowed.includes('US')));
      const dur = seconds(v.contentDetails.duration);
      if (v.status.privacyStatus !== 'public' || !v.status.embeddable || v.snippet.liveBroadcastContent !== 'none' || blockedUS || dur < 5) continue;
      videos.push({ id, title: v.snippet.title, dur });
    }
  }
  out[handle] = { list, title: ch.snippet.title, videos };
  console.log(`${handle}: ${videos.length} of ${ids.length} uploads can play`);
}

const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
if (old && JSON.stringify(old.channels) === JSON.stringify(out)) { console.log('No changes.'); process.exit(0); }
fs.writeFileSync(OUT, JSON.stringify({ name: 'Built-in YouTube channel videos', updated: new Date().toISOString(), source: 'YouTube Data API', channels: out }, null, 1) + '\n');
console.log('Updated', OUT.pathname);
