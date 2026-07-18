// Mudae reset pinger. Reads Mudae's $tu reply, schedules a ping per timer.
// You run $tu in the channel -> bot sees Mudae's reply -> pings you when each resets.
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

const MUDAE_ID = process.env.MUDAE_ID || '432610292342587392'; // Mudae's user id
const USER_ID = process.env.USER_ID;   // you (who to ping)
const CHANNEL_ID = process.env.CHANNEL_ID; // where to ping

// Which lines to watch. key = label, test = regex that matches that $tu line.
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

const timers = new Map(); // key -> timeout, so a fresh $tu reschedules instead of stacking

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.on('messageCreate', async (msg) => {
  if (msg.author.id !== MUDAE_ID) return;
  const text = msg.content || msg.embeds.map(e => `${e.title ?? ''} ${e.description ?? ''}`).join(' ');
  if (!/reset|vote again|react to kakera|\$dk/i.test(text)) return; // not a $tu reply

  const ch = await client.channels.fetch(CHANNEL_ID);
  for (const { key, re } of WATCH) {
    const m = re.exec(text);
    if (!m) continue;
    const ms = toMs(m[1]);
    clearTimeout(timers.get(key));
    if (ms <= 0) { ch.send(`<@${USER_ID}> **${key}** ready now!`); continue; }
    timers.set(key, setTimeout(() => ch.send(`<@${USER_ID}> **${key}** reset ready!`), ms));
    console.log(`scheduled ${key} in ${Math.round(ms / 60000)} min`);
  }
});

client.once('clientReady', () => console.log(`up as ${client.user.tag}. Run $tu in the channel.`));
client.login(process.env.TOKEN);
