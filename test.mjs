// Run: TEST=1 node test.mjs   (TEST=1 stops index.js from logging into Discord)
import assert from 'node:assert';
import { matchResets, handleMudaeReply, rememberTu, stripMd } from './index.js';

// --- parsing -----------------------------------------------------------
// Roulette rate-limit reply (real screenshot): trips loose "reset" wording,
// carries NO schedulable timer.
const ROULETTE =
  'lastlimited, the roulette is limited to 11 uses per hour. **16** min left.\n' +
  'Upvote Mudae to reset the timer: **$vote**.';

// Real $tu shape captured from logs earlier.
const TU =
  '**lastlimited**, you can\'t claim for another **1h 39** min.\n' +
  'Your **rolls** reset in **39** min.';

assert.deepStrictEqual(matchResets(stripMd(ROULETTE)), [], 'roulette msg must yield no resets');
const tu = matchResets(stripMd(TU));
assert.deepStrictEqual(tu.map(r => r.key).sort(), ['claim', 'rolls'], 'tu must yield claim+rolls');
assert.strictEqual(tu.find(r => r.key === 'claim').ms, 99 * 60_000, 'claim = 99 min');
assert.strictEqual(tu.find(r => r.key === 'rolls').ms, 39 * 60_000, 'rolls = 39 min');

// --- handler ordering (the bug) ----------------------------------------
// A no-timer Mudae message must NOT consume the pending $tu requester;
// the real $tu reply that follows must still be attributed and armed.
function freshMap() {
  const m = new Map();
  rememberTu(m, 'chan', { uid: 'u1', names: ['lastlimited'] });
  return m;
}

{ // roulette first, then real reply -> real reply still arms for u1
  const map = freshMap();
  const armed = [];
  handleMudaeReply(ROULETTE, 'chan', map, (...a) => armed.push(a));
  assert.strictEqual(armed.length, 0, 'roulette must arm nothing');
  assert.strictEqual(map.get('chan').length, 1, 'roulette must not consume requester');

  handleMudaeReply(TU, 'chan', map, (...a) => armed.push(a));
  assert.strictEqual(armed.length, 2, 'real reply arms claim+rolls');
  assert.ok(armed.every(a => a[0] === 'u1'), 'armed for the requester');
  assert.strictEqual(map.get('chan').length, 0, 'real reply consumes requester');
}

{ // reply with timers but nobody pending -> ignored, no arm, no crash
  const armed = [];
  handleMudaeReply(TU, 'chan', new Map(), (...a) => armed.push(a));
  assert.strictEqual(armed.length, 0, 'no requester -> nothing armed');
}

{ // unrelated Mudae chatter (character roll text) -> ignored silently
  const map = freshMap();
  const armed = [];
  handleMudaeReply('**Rem** is now claimed!', 'chan', map, (...a) => armed.push(a));
  assert.strictEqual(armed.length, 0);
  assert.strictEqual(map.get('chan').length, 1, 'chatter must not consume requester');
}

console.log('ok — parsing + handler ordering verified against real handler');
