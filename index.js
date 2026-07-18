// Mudae reset pinger, multi-user. Anyone runs $tu -> bot reads Mudae's reply,
// schedules that user's timers, pings them in the same channel when each resets.
// Pings due at the same time are batched into one message.
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

const MUDAE_ID = process.env.MUDAE_ID || '432610292342587392'; // Mudae's user id
const STORE = './timers.json'; // persisted fire times, survives restarts
const GIST_ID = process.env.GIST_ID;   // id of a secret gist containing timers.json
const GH_TOKEN = process.env.GH_TOKEN; // GitHub token with gist scope
// GitHub's API rejects requests with no User-Agent (403); Node's fetch sends none.
const GH_HEADERS = {
  authorization: `Bearer ${GH_TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'mudae-reset-pinger',
};

// Which lines to watch. key = label, re = regex matching that $tu line.
const WATCH = [
  { key: 'claim',  re: /next claim reset is in ([\dhmins ]+?)\./i },
  { key: 'rolls',  re: /rolls reset in ([\dhmins ]+?)\./i },
  { key: 'daily',  re: /\$daily reset in ([\dhmins ]+?)\./i },
  { key: 'kakera', re: /react to kakera for ([\dhmins ]+?)\./i },
  { key: 'dk',     re: /\$dk in ([\dhmins ]+?)\./i },
  { key: 'vote',   re: /vote again in ([\dhmins ]+?)\./i },
];

// "1h 30 min" / "30 min" -> milliseconds
function toMs(s) {
  const h = /(\d+)\s*h/.exec(s)?.[1] ?? 0;
  const m = /(\d+)\s*min/.exec(s)?.[1] ?? 0;
  return (Number(h) * 60 + Number(m)) * 60_000;
}

const timers = new Map();   // "uid|key" -> timeout handle
export const fireAt = await loadStore(); // "uid|key" -> { at, ch, name }  (epoch ms, channel id, display name)
const lastTu = new Map();   // channelId -> [{ uid, names, at }] recent $tu requesters, oldest first
const pending = new Map();  // uid -> { keys: Set, ch, t } batch window per user

const TU_WINDOW = 60_000; // how long a $tu waits for Mudae's reply

// Remember a $tu requester for this channel (queue, so several users can overlap).
export function rememberTu(map, chId, entry) {
  const arr = map.get(chId) ?? [];
  arr.push({ at: Date.now(), ...entry });
  map.set(chId, arr.slice(-10)); // ponytail: cap 10, nobody queues more $tu than that in 60s
}

// Pick the requester for a Mudae reply: match the display name Mudae leads with
// ("lastlimited, you can claim..."), else oldest pending. Consumed once.
export function takeRequester(map, chId, text) {
  const now = Date.now();
  const arr = (map.get(chId) ?? []).filter(e => now - e.at < TU_WINDOW);
  const lower = text.toLowerCase();
  let i = arr.findIndex(e => e.names.some(n => lower.startsWith(n)));
  if (i === -1 && arr.length) i = 0; // no name match -> oldest waiting
  const who = i === -1 ? undefined : arr.splice(i, 1)[0];
  map.set(chId, arr);
  return who;
}

// Render's disk is wiped on every deploy, so the real store is a secret GitHub
// gist (free, survives deploys). Local file is used when gist env vars are absent.
async function loadStore() {
  if (GIST_ID && GH_TOKEN) {
    try {
      const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: GH_HEADERS });
      if (!r.ok) throw new Error(`gist GET ${r.status}`);
      const g = await r.json();
      const map = new Map(Object.entries(JSON.parse(g.files['timers.json'].content)));
      console.log(`gist loaded, ${map.size} timers`);
      return map;
    } catch (err) { console.error('gist load failed, starting empty:', err.message); return new Map(); }
  }
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(STORE, 'utf8')))); }
  catch { return new Map(); }
}

let gistT;
function saveStore() {
  const json = JSON.stringify(Object.fromEntries(fireAt));
  try { fs.writeFileSync(STORE, json); } catch {} // best-effort local cache
  if (!GIST_ID || !GH_TOKEN) return;
  // ponytail: 5s debounce — arm() saves 6x per $tu, gist needs one write. A deploy
  // landing inside the 5s window can lose that batch; fine for a few users.
  clearTimeout(gistT);
  gistT = setTimeout(() => {
    fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: { ...GH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ files: { 'timers.json': { content: json } } }),
    }).then(r => { if (r.ok) console.log('gist saved'); else console.error(`gist save failed: ${r.status}`); })
      .catch(err => console.error('gist save failed:', err.message));
  }, 5_000);
}

// Collect keys firing close together, send ONE message per user after a 3s window.
function queuePing(uid, ch, key) {
  let p = pending.get(uid);
  if (!p) { p = { keys: new Set(), ch, t: null }; pending.set(uid, p); }
  p.keys.add(key);
  clearTimeout(p.t);
  p.t = setTimeout(() => flushPing(uid), 3_000);
}

async function flushPing(uid) {
  const p = pending.get(uid);
  if (!p) return;
  const list = [...p.keys].map(k => `**${k}**`).join(', ');
  try {
    const channel = await client.channels.fetch(p.ch);
    await channel.send(`<@${uid}> ready: ${list}!`);
    for (const k of p.keys) { fireAt.delete(`${uid}|${k}`); }
    pending.delete(uid); saveStore();
  } catch (err) {
    // ponytail: one flat retry in 60s, enough for transient Discord/network blips
    console.error(`ping ${uid} failed, retrying in 60s:`, err.message);
    p.t = setTimeout(() => flushPing(uid), 60_000);
  }
}

// Arm a timer for user `uid`, reset `key`, absolute time `at`, ping channel `ch`.
function arm(uid, key, at, ch, name) {
  const id = `${uid}|${key}`;
  clearTimeout(timers.get(id));
  // TEST_SECONDS: fire every timer after N seconds instead of the real delay (test only).
  const delay = process.env.TEST_SECONDS ? Number(process.env.TEST_SECONDS) * 1000 : at - Date.now();
  fireAt.set(id, { at, ch, name }); saveStore();
  timers.set(id, setTimeout(() => queuePing(uid, ch, key), Math.max(delay, 0)));
  console.log(`scheduled ${key} for ${uid} in ${Math.round(Math.max(delay, 0) / 60000)} min`);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.on('messageCreate', (msg) => {
  // Any user typing $tu (or $tuarrange etc.) -> queue them for this channel.
  if (!msg.author.bot && /^\$tu\b/i.test(msg.content ?? '')) {
    const names = [msg.member?.displayName, msg.author.globalName, msg.author.username]
      .filter(Boolean).map(n => n.toLowerCase());
    rememberTu(lastTu, msg.channelId, { uid: msg.author.id, names });
    console.log(`[$tu] from ${msg.author.id} (${names[0]}) in ${msg.channelId}`);
    return;
  }
  if (msg.author.id !== MUDAE_ID) return;
  const text = msg.content || msg.embeds.map(e => `${e.title ?? ''} ${e.description ?? ''}`).join(' ');
  if (!/reset|vote again|react to kakera|\$dk/i.test(text)) return; // not a $tu reply

  // Attribute the reply: name Mudae leads with, else oldest waiting requester.
  const who = takeRequester(lastTu, msg.channelId, text);
  if (!who) { console.log(`[mudae reply] no pending $tu requester, ignored: "${text.slice(0, 40)}"`); return; }
  console.log(`[mudae reply] for ${who.uid}: "${text.slice(0, 40)}"`);

  for (const { key, re } of WATCH) {
    const m = re.exec(text);
    if (m) arm(who.uid, key, Date.now() + toMs(m[1]), msg.channelId, who.names[0]);
  }
});

client.once('clientReady', () => {
  console.log(`up as ${client.user.tag}. Run $tu in the channel.`);
  for (const [id, { at, ch, name }] of fireAt) { // reschedule survivors after restart
    const [uid, key] = id.split('|');
    arm(uid, key, Number(at), ch, name);
  }
});

// Timer rows as JSON — feeds both the initial page render and /api/timers polling.
export function timersJson() {
  const rows = [...fireAt.entries()].map(([id, v]) => {
    const [uid, key] = id.split('|');
    return { name: v.name || uid, key, at: Number(v.at) };
  });
  return JSON.stringify(rows).replace(/</g, '\\u003c'); // names come from Discord — never let them close the <script>
}

// Dashboard: live table of every armed timer. Client polls /api/timers every 10s,
// so a fresh $tu in Discord appears here within seconds. All rendering uses
// textContent (Discord names are untrusted — never injected as HTML).
export function dashboard() {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mudae timers</title>
<style>
:root{
  --bg:#020617; --surface:#0F172A; --surface2:#1E293B; --border:#334155;
  --fg:#F8FAFC; --muted:#94A3B8; --accent:#22C55E; --mono:ui-monospace,'Cascadia Mono',Consolas,monospace;
}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:1.5rem;min-height:100vh}
main{max-width:40rem;margin:0 auto}
header{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin-bottom:1rem;flex-wrap:wrap}
h1{font-size:1.15rem;margin:0;letter-spacing:.04em}
.live{display:inline-flex;align-items:center;gap:.4rem;color:var(--muted);font-size:.8rem}
.dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--accent);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion: reduce){.dot{animation:none}}
table{border-collapse:collapse;width:100%;background:var(--surface);border:1px solid var(--border);border-radius:.5rem;overflow:hidden}
th,td{padding:.55rem .9rem;text-align:left;border-bottom:1px solid var(--border);font-size:.9rem}
tr:last-child td{border-bottom:none}
th{color:var(--muted);font-weight:600;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;background:var(--surface2)}
td.left{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.badge{display:inline-block;background:var(--surface2);border:1px solid var(--border);border-radius:999px;padding:.1rem .6rem;font-size:.75rem;color:var(--muted)}
tr.ready td.left{color:var(--accent);font-weight:600;text-shadow:0 0 10px rgba(34,197,94,.45)}
tr.ready .badge{border-color:var(--accent);color:var(--accent)}
tr{transition:background .2s ease}
tbody tr:hover{background:var(--surface2)}
#empty{color:var(--muted);text-align:center;padding:2rem 1rem;border:1px dashed var(--border);border-radius:.5rem;margin:0}
#empty code{font-family:var(--mono);color:var(--fg)}
footer{color:var(--muted);font-size:.75rem;margin-top:.9rem;text-align:center}
</style>
<main>
<header><h1>Mudae reset timers</h1><span class="live"><span class="dot"></span><span id="stat">live</span></span></header>
<table id="tbl" hidden><thead><tr><th scope="col">User</th><th scope="col">Reset</th><th scope="col" style="text-align:right">Time left</th></tr></thead><tbody id="tb"></tbody></table>
<p id="empty" hidden>No timers armed — run <code>$tu</code> in Discord and this fills in.</p>
<footer>refreshes every 10s</footer>
</main>
<script>
let data = ${timersJson()};
function fmt(ms) {
  if (ms <= 0) return 'ready';
  const m = Math.ceil(ms / 60000);
  return (m >= 60 ? Math.floor(m / 60) + 'h ' : '') + (m % 60) + 'm';
}
function draw() {
  const tb = document.getElementById('tb');
  tb.innerHTML = '';
  document.getElementById('tbl').hidden = data.length === 0;
  document.getElementById('empty').hidden = data.length > 0;
  for (const r of data.slice().sort((a, b) => a.at - b.at)) {
    const left = r.at - Date.now();
    const tr = tb.insertRow();
    tr.className = left <= 0 ? 'ready' : '';
    tr.insertCell().textContent = r.name;
    const badge = document.createElement('span');
    badge.className = 'badge'; badge.textContent = r.key;
    tr.insertCell().appendChild(badge);
    const c = tr.insertCell();
    c.className = 'left'; c.textContent = fmt(left);
  }
}
async function poll() {
  try {
    data = await (await fetch('/api/timers')).json();
    document.getElementById('stat').textContent = 'live';
  } catch { document.getElementById('stat').textContent = 'reconnecting…'; }
  draw();
}
draw();
setInterval(poll, 10000);
</script>`;
}

if (!process.env.TEST) { // TEST=1: import for unit tests without connecting
  client.login(process.env.TOKEN).catch(err => { console.error('login failed:', err.message); process.exit(1); });

  // Doubles as the keep-alive endpoint for Render free tier: the external
  // pinger hitting this every ~10 min stops the service sleeping.
  http.createServer((req, res) => {
    if (req.url === '/api/timers') {
      res.setHeader('content-type', 'application/json');
      res.end(timersJson());
    } else {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(dashboard());
    }
  }).listen(process.env.PORT || 3000);
}
