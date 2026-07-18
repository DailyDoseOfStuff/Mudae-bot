// Mudae reset pinger, multi-user. Anyone runs $tu -> bot reads Mudae's reply,
// schedules that user's timers, pings them in the same channel when each resets.
// Pings due at the same time are batched into one message.
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

const MUDAE_ID = process.env.MUDAE_ID || '432610292342587392'; // Mudae's user id
const STORE = './timers.json'; // persisted fire times, survives restarts

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
export const fireAt = loadStore(); // "uid|key" -> { at, ch, name }  (epoch ms, channel id, display name)
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

function loadStore() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(STORE, 'utf8')))); }
  catch { return new Map(); }
}
function saveStore() {
  fs.writeFileSync(STORE, JSON.stringify(Object.fromEntries(fireAt)));
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

// Dashboard: live table of every armed timer. Data embedded as JSON, rendered
// client-side with textContent (names come from Discord — never inject as HTML).
export function dashboard() {
  const rows = [...fireAt.entries()].map(([id, v]) => {
    const [uid, key] = id.split('|');
    return { name: v.name || uid, key, at: Number(v.at) };
  });
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mudae timers</title>
<style>
body{font-family:system-ui,sans-serif;background:#1e1f22;color:#dbdee1;padding:2rem;margin:0}
table{border-collapse:collapse;min-width:22rem}
td,th{padding:.45rem .9rem;border-bottom:1px solid #3f4147;text-align:left}
th{color:#949ba4;font-weight:600}
.ready{color:#57f287;font-weight:600}
p{color:#949ba4}
</style>
<h2>Mudae reset timers</h2>
<table><thead><tr><th>User</th><th>Reset</th><th>Time left</th></tr></thead><tbody id="tb"></tbody></table>
<p id="empty" hidden>No timers armed. Run $tu in Discord.</p>
<script>
const data = ${JSON.stringify(rows).replace(/</g, '\\u003c')};
function fmt(ms) {
  if (ms <= 0) return 'ready';
  const m = Math.ceil(ms / 60000);
  return (m >= 60 ? Math.floor(m / 60) + 'h ' : '') + (m % 60) + ' min';
}
function draw() {
  const tb = document.getElementById('tb');
  tb.innerHTML = '';
  document.getElementById('empty').hidden = data.length > 0;
  for (const r of data.sort((a, b) => a.at - b.at)) {
    const tr = tb.insertRow();
    tr.insertCell().textContent = r.name;
    tr.insertCell().textContent = r.key;
    const c = tr.insertCell();
    c.textContent = fmt(r.at - Date.now());
    c.className = r.at - Date.now() <= 0 ? 'ready' : '';
  }
}
draw();
setInterval(draw, 15000);                       // recount locally
setTimeout(() => location.reload(), 120000);    // refetch fresh data
</script>`;
}

if (!process.env.TEST) { // TEST=1: import for unit tests without connecting
  client.login(process.env.TOKEN).catch(err => { console.error('login failed:', err.message); process.exit(1); });

  // Doubles as the keep-alive endpoint for Render free tier: the external
  // pinger hitting this every ~10 min stops the service sleeping.
  http.createServer((_, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(dashboard());
  }).listen(process.env.PORT || 3000);
}
