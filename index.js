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
// Patterns run on markdown-stripped text (Mudae bolds the times: "**1h 39** min").
// `[^.]*?` between the keyword and the duration is period-scoped (. never matches
// a newline here), so each pattern stays on its own $tu line while tolerating the
// wording variants Mudae uses ("for another" / "reset in" / "back in" / "in").
const WATCH = [
  { key: 'claim',  re: /claim[^.]*?(?:for another|reset(?: is)? in) ([\dhmins ]+?)\./i },
  { key: 'rolls',  re: /rolls?[^.]*?(?:reset|back)(?: in)? ([\dhmins ]+?)\./i },
  { key: 'daily',  re: /\$?daily[^.]*?(?:for another|reset in|back in|in) ([\dhmins ]+?)\./i },
  { key: 'kakera', re: /kakera[^.]*?(?:for another|reset in|back in|in) ([\dhmins ]+?)\./i },
  { key: 'dk',     re: /\$?dk[^.]*?(?:for another|ready in|reset in|in) ([\dhmins ]+?)\./i },
  { key: 'vote',   re: /vote[^.]*?(?:again in|for another|reset in|in) ([\dhmins ]+?)\./i },
];

// Strip Discord bold/italic so "**1h 39** min" reads as "1h 39 min" and the
// name Mudae leads with ("**shdaolee**,") matches the requester.
export const stripMd = (s) => s.replace(/[*_]/g, '');

// Parse a markdown-stripped $tu reply into [{ key, ms }] for each reset on cooldown.
export function matchResets(text) {
  const out = [];
  for (const { key, re } of WATCH) {
    const m = re.exec(text);
    if (m) out.push({ key, ms: toMs(m[1]) });
  }
  return out;
}

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
  const raw = msg.content || msg.embeds.map(e => `${e.title ?? ''} ${e.description ?? ''}`).join(' ');
  handleMudaeReply(raw, msg.channelId, lastTu, arm);
});

// Handle one Mudae message: parse timers, attribute to a $tu requester, arm.
// Exported (with armFn injectable) so tests exercise the real ordering.
export function handleMudaeReply(raw, chId, tuMap, armFn) {
  const text = stripMd(raw); // drop ** bold ** so patterns and name-match see plain text

  // Parse BEFORE attributing. Mudae messages like the roulette rate-limit
  // ("...reset the timer: $vote. 16 min left.") trip the loose "reset" wording
  // but schedule nothing; consuming the $tu requester on those would drop the
  // real reply that follows and leave stale timers firing at the wrong times.
  const resets = matchResets(text);
  if (!resets.length) {
    // ponytail: temporary — dump reply-looking-but-unmatched text so new cooldown wordings can be added.
    if (/reset|vote again|react to kakera|\$dk/i.test(raw)) console.log(`[mudae reply] NO MATCH, full text:\n${raw}`);
    return;
  }

  // Attribute the reply: name Mudae leads with, else oldest waiting requester.
  const who = takeRequester(tuMap, chId, text);
  if (!who) { console.log(`[mudae reply] no pending $tu requester, ignored: "${text.slice(0, 40)}"`); return; }
  console.log(`[mudae reply] for ${who.uid}: "${text.slice(0, 40)}"`);
  for (const { key, ms } of resets) armFn(who.uid, key, Date.now() + ms, chId, who.names[0]);
}

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
  --bg:#060911; --surface:#0F172A; --surface2:#1A2438; --border:#26324a;
  --fg:#F1F5F9; --muted:#8b98ad; --accent:#34D399; --mono:ui-monospace,'Cascadia Mono',Consolas,monospace;
}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--fg);margin:0;padding:2.5rem 1.5rem;min-height:100vh;
  background:radial-gradient(1200px 600px at 50% -10%,#141d33 0%,var(--bg) 60%)}
main{max-width:54rem;margin:0 auto}
.scroll{overflow-x:auto;border:1px solid var(--border);border-radius:.85rem;background:var(--surface);
  box-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 20px 40px -24px rgba(0,0,0,.8)}
header{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:0 .25rem 1.1rem;flex-wrap:wrap}
h1{font-size:1.35rem;margin:0;font-weight:700;letter-spacing:-.01em}
.live{display:inline-flex;align-items:center;gap:.45rem;color:var(--muted);font-size:.8rem;font-weight:500}
.dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.dot{animation:none}}
table{border-collapse:collapse;width:100%}
th,td{padding:.7rem 1rem;font-size:.9rem;white-space:nowrap;border-bottom:1px solid var(--border)}
tbody tr:last-child td{border-bottom:none}
th{color:var(--muted);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.09em;
  text-align:center;background:var(--surface2);position:sticky;top:0}
th:first-child,td.u{text-align:left}
td.u{font-weight:600;color:var(--fg)}
td.t{text-align:center;font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--fg)}
td.none{color:#3a465c}
td.ready{color:var(--accent);font-weight:700;letter-spacing:.02em;text-shadow:0 0 12px rgba(52,211,153,.5)}
tbody tr{transition:background .15s ease}
tbody tr:nth-child(even){background:rgba(255,255,255,.015)}
tbody tr:hover{background:var(--surface2)}
#empty{color:var(--muted);text-align:center;padding:2.5rem 1rem;border:1px dashed var(--border);border-radius:.85rem;margin:0;font-size:.9rem}
#empty code{font-family:var(--mono);color:var(--accent)}
footer{color:var(--muted);font-size:.72rem;margin-top:1rem;text-align:center;letter-spacing:.03em}
</style>
<main>
<header><h1>Mudae reset timers</h1><span class="live"><span class="dot"></span><span id="stat">live</span></span></header>
<div class="scroll"><table id="tbl" hidden><thead id="th"></thead><tbody id="tb"></tbody></table></div>
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
// Preferred column order; any reset type not listed is appended so nothing is dropped.
const ORDER = ['rolls', 'claim', 'daily', 'dk', 'kakera', 'vote'];
function draw() {
  const tbl = document.getElementById('tbl');
  tbl.hidden = data.length === 0;
  document.getElementById('empty').hidden = data.length > 0;
  if (!data.length) return;

  // columns = only reset types actually present, in preferred order
  const present = new Set(data.map(r => r.key));
  const keys = [...ORDER.filter(k => present.has(k)), ...[...present].filter(k => !ORDER.includes(k))];

  // pivot: user -> {key -> at}, and track each user's soonest timer for sorting
  const users = new Map();
  for (const r of data) {
    let u = users.get(r.name);
    if (!u) users.set(r.name, u = { cells: {}, min: Infinity });
    u.cells[r.key] = r.at;
    u.min = Math.min(u.min, r.at);
  }

  const th = document.getElementById('th');
  th.innerHTML = '';
  const hr = th.insertRow();
  hr.insertCell().outerHTML = '<th scope="col">User</th>';
  for (const k of keys) { const c = hr.insertCell(); c.outerHTML = '<th scope="col">' + k + '</th>'; }

  const tb = document.getElementById('tb');
  tb.innerHTML = '';
  const now = Date.now();
  for (const [name, u] of [...users].sort((a, b) => a[1].min - b[1].min)) {
    const tr = tb.insertRow();
    const nc = tr.insertCell(); nc.className = 'u'; nc.textContent = name;
    for (const k of keys) {
      const c = tr.insertCell(); c.className = 't';
      if (!(k in u.cells)) { c.classList.add('none'); c.textContent = '—'; continue; }
      const left = u.cells[k] - now;
      if (left <= 0) c.classList.add('ready');
      c.textContent = fmt(left);
    }
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
