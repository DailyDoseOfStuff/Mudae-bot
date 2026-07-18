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
const fireAt = loadStore(); // "uid|key" -> { at, ch }  (epoch ms, channel id)
const lastTu = new Map();   // channelId -> { uid, at }  who ran $tu last, to attribute Mudae's reply
const pending = new Map();  // uid -> { keys: Set, ch, t } batch window per user

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
function arm(uid, key, at, ch) {
  const id = `${uid}|${key}`;
  clearTimeout(timers.get(id));
  // TEST_SECONDS: fire every timer after N seconds instead of the real delay (test only).
  const delay = process.env.TEST_SECONDS ? Number(process.env.TEST_SECONDS) * 1000 : at - Date.now();
  fireAt.set(id, { at, ch }); saveStore();
  timers.set(id, setTimeout(() => queuePing(uid, ch, key), Math.max(delay, 0)));
  console.log(`scheduled ${key} for ${uid} in ${Math.round(Math.max(delay, 0) / 60000)} min`);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.on('messageCreate', (msg) => {
  // Any user typing $tu (or $tuarrange etc.) -> remember them for this channel.
  if (!msg.author.bot && /^\$tu\b/i.test(msg.content ?? '')) {
    lastTu.set(msg.channelId, { uid: msg.author.id, at: Date.now() });
    return;
  }
  if (msg.author.id !== MUDAE_ID) return;
  const text = msg.content || msg.embeds.map(e => `${e.title ?? ''} ${e.description ?? ''}`).join(' ');
  if (!/reset|vote again|react to kakera|\$dk/i.test(text)) return; // not a $tu reply

  // Attribute the reply to whoever ran $tu here in the last 30s.
  const who = lastTu.get(msg.channelId);
  if (!who || Date.now() - who.at > 30_000) return;
  console.log(`[mudae reply] for ${who.uid}: "${text.slice(0, 40)}"`);

  for (const { key, re } of WATCH) {
    const m = re.exec(text);
    if (m) arm(who.uid, key, Date.now() + toMs(m[1]), msg.channelId);
  }
});

client.once('clientReady', () => {
  console.log(`up as ${client.user.tag}. Run $tu in the channel.`);
  for (const [id, { at, ch }] of fireAt) { // reschedule survivors after restart
    const [uid, key] = id.split('|');
    arm(uid, key, Number(at), ch);
  }
});

client.login(process.env.TOKEN).catch(err => { console.error('login failed:', err.message); process.exit(1); });

// Keep-alive HTTP endpoint so Render treats this as a Web Service (free tier).
// An external pinger hitting this every ~10 min stops the service sleeping.
http.createServer((_, res) => res.end('ok')).listen(process.env.PORT || 3000);
