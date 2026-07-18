// Mudae reset pinger. Reads Mudae's $tu reply, schedules a ping per timer.
// You run $tu in the channel -> bot sees Mudae's reply -> pings you when each resets.
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

const MUDAE_ID = process.env.MUDAE_ID || '432610292342587392'; // Mudae's user id
const USER_ID = process.env.USER_ID;   // you (who to ping)
const CHANNEL_ID = process.env.CHANNEL_ID; // where to ping
const STORE = './timers.json'; // persisted fire times, survives restarts

// Which lines to watch. key = label, re = regex matching that $tu line.
const WATCH = [
  { key: 'claim',  re: /next claim reset is in ([\dhm\s]+?)\./i },
  { key: 'rolls',  re: /rolls reset in ([\dhm\s]+?)\./i },
  { key: 'daily',  re: /\$daily reset in ([\dhm\s]+?)\./i },
  { key: 'kakera', re: /react to kakera for ([\dhm\s]+?)\./i },
  { key: 'dk',     re: /\$dk in ([\dhm\s]+?)\./i },
  { key: 'vote',   re: /vote again in ([\dhm\s]+?)\./i },
];

// "1h 30 min" / "30 min" -> milliseconds
function toMs(s) {
  const h = /(\d+)\s*h/.exec(s)?.[1] ?? 0;
  const m = /(\d+)\s*min/.exec(s)?.[1] ?? 0;
  return (Number(h) * 60 + Number(m)) * 60_000;
}

const timers = new Map();          // key -> timeout handle
const fireAt = loadStore();        // key -> absolute epoch ms it should ping

function loadStore() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(STORE, 'utf8')))); }
  catch { return new Map(); }
}
function saveStore() {
  fs.writeFileSync(STORE, JSON.stringify(Object.fromEntries(fireAt)));
}

async function ping(key) {
  const ch = await client.channels.fetch(CHANNEL_ID);
  await ch.send(`<@${USER_ID}> **${key}** reset ready!`);
  fireAt.delete(key); saveStore();
}

// Arm a setTimeout for `key` at absolute time `at`. Reschedules if already armed.
function arm(key, at) {
  clearTimeout(timers.get(key));
  const delay = at - Date.now();
  if (delay <= 0) { ping(key); return; }
  fireAt.set(key, at); saveStore();
  timers.set(key, setTimeout(() => ping(key), delay));
  console.log(`scheduled ${key} in ${Math.round(delay / 60000)} min`);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.on('messageCreate', (msg) => {
  if (msg.author.id !== MUDAE_ID) return;
  const text = msg.content || msg.embeds.map(e => `${e.title ?? ''} ${e.description ?? ''}`).join(' ');
  if (!/reset|vote again|react to kakera|\$dk/i.test(text)) return; // not a $tu reply
  for (const { key, re } of WATCH) {
    const m = re.exec(text);
    if (m) arm(key, Date.now() + toMs(m[1]));
  }
});

client.once('clientReady', () => {
  console.log(`up as ${client.user.tag}. Run $tu in the channel.`);
  for (const [key, at] of fireAt) arm(key, Number(at)); // reschedule survivors after restart
});

client.login(process.env.TOKEN);

// Keep-alive HTTP endpoint so Render treats this as a Web Service (free tier).
// An external pinger hitting this every ~10 min stops the service sleeping.
http.createServer((_, res) => res.end('ok')).listen(process.env.PORT || 3000);
