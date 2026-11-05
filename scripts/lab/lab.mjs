// Repeatable survival scenarios in a lab world with commands allowed (Open to LAN -> Allow Commands).
// A game-master player issues the setup commands (/summon, /give, /damage ...) through its own MCP server; the bot
// under test only uses its normal tools, so the scenarios measure what the bot does, not what commands do.
//   game master: node scripts/lab/mcp-http.mjs ClaudeFresh 7777
//   bot:         MCP_EXTRA_ARGS="--backend client" node scripts/lab/mcp-http.mjs ClaudeBot 7778
//   node scripts/lab/lab.mjs setup                          (once per world: arena, frozen night, no natural spawns)
//   node scripts/lab/lab.mjs all | creeper | shield | emergency | drown | lava
// Env: LAB_GM / LAB_BOT (http ports), LAB_BOT_NAME, MC_LOG (the server log that records deaths).
import fs from 'node:fs';

const GM = `http://127.0.0.1:${process.env.LAB_GM ?? 7777}/call`;
const BOT = `http://127.0.0.1:${process.env.LAB_BOT ?? 7778}/call`;
const LOG = process.env.MC_LOG ?? `${process.env.APPDATA}/.minecraft/logs/latest.log`;
const BOTNAME = process.env.LAB_BOT_NAME ?? 'ClaudeBot';
const ARENA = { x: -50, y: 150, z: -50 }; // floor at y=150, stand at y=151
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NL = String.fromCharCode(10);

async function call(url, name, args = {}) {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ name, args }) });
  return (await res.text()).trim();
}
const gm = async (cmd) => { await call(GM, 'send-chat', { message: `/${cmd}` }); await sleep(250); };
const bot = (name, args) => call(BOT, name, args);

/** Lines the server logged since `offset` (bytes), and the new offset. */
function logSince(offset) {
  const buf = fs.readFileSync(LOG);
  return { lines: buf.subarray(offset).toString('utf8').split('\n'), offset: buf.length };
}
const deathsIn = lines => lines.filter(l => l.includes('System chat:') && l.includes(BOTNAME) &&
  /(was slain|was shot|drowned|blew up|blown up|burned|tried to swim|fell|died|suffocated|starved|was killed)/.test(l));

const { x: ax, y: ay, z: az } = ARENA;

async function setup() {
  // freeze time at night, no natural spawns, a walled stone arena in the sky
  for (const c of [
    'gamerule doDaylightCycle false', 'gamerule advance_time false',
    'gamerule doMobSpawning false', 'gamerule spawn_mobs false',
    'difficulty easy',
    `fill ${ax - 12} ${ay} ${az - 12} ${ax + 12} ${ay} ${az + 12} stone`,
    `fill ${ax - 12} ${ay + 1} ${az - 12} ${ax + 12} ${ay + 3} ${az + 12} air`,
    `fill ${ax - 12} ${ay + 1} ${az - 12} ${ax + 12} ${ay + 1} ${az - 12} glass`,
    `fill ${ax - 12} ${ay + 1} ${az + 12} ${ax + 12} ${ay + 1} ${az + 12} glass`,
    `fill ${ax - 12} ${ay + 1} ${az - 12} ${ax - 12} ${ay + 1} ${az + 12} glass`,
    `fill ${ax + 12} ${ay + 1} ${az - 12} ${ax + 12} ${ay + 1} ${az + 12} glass`,
    // drowning pool beside it: glass tank, water inside, open top
    `fill ${ax + 20} ${ay - 6} ${az - 2} ${ax + 24} ${ay + 1} ${az + 2} glass hollow`,
    `fill ${ax + 21} ${ay - 5} ${az - 1} ${ax + 23} ${ay} ${az + 1} water`,
    `fill ${ax + 21} ${ay + 1} ${az - 1} ${ax + 23} ${ay + 1} ${az + 1} air`,
    `tp @s ${ax} ${ay + 1} ${az + 30}` // the game master watches from outside the arena
  ]) await gm(c);
}

/** Fresh start for the bot: arena centre, healed, fed, empty-handed, no mobs, given `items`. */
async function reset(items = [], time = 18000) {
  // only the arena: a bare kill @e also wipes every animal in the loaded world (it did, around spawn)
  await gm(`execute positioned ${ax} ${ay + 1} ${az} run kill @e[type=!player,distance=..20]`);
  await gm(`fill ${ax - 11} ${ay + 1} ${az - 11} ${ax + 11} ${ay + 3} ${az + 11} air`); // clear leftovers (old shelters)
  await gm(`clear ${BOTNAME}`);
  await gm(`effect clear ${BOTNAME}`);
  await gm(`tp ${BOTNAME} ${ax} ${ay + 1} ${az}`);
  await gm(`effect give ${BOTNAME} instant_health 1 10`);
  await gm(`effect give ${BOTNAME} saturation 1 20`);
  await gm(`time set ${time}`);
  for (const i of items) await gm(`give ${BOTNAME} ${i}`);
  await sleep(2500); // let the gear check run (every 2 s)
}

const results = [];
function report(name, pass, details) {
  results.push({ name, pass });
  console.log(`\n=== ${name}: ${pass ? 'PASS' : 'FAIL'}\n${details}`);
}

async function creeper() {
  await reset(['iron_sword', 'shield']);
  const mark = logSince(0).offset;
  await gm(`execute at ${BOTNAME} run summon creeper ~6 ~ ~`);
  const r = await bot('attack-entity', { target: 'creeper', maxDistance: 16, timeoutMs: 40000 });
  const st = await bot('get-status', {});
  const deaths = deathsIn(logSince(mark).lines);
  report('creeper with shield and sword', !deaths.length && /Killed creeper/.test(r), `${r}\n${st.split('\n')[0]}\n${deaths.join('\n')}`);
}

async function shield() {
  await reset(['stone_sword', 'shield']);
  const mark = logSince(0).offset;
  const before = await bot('get-status', {});
  await gm(`execute at ${BOTNAME} run summon skeleton ~10 ~ ~`);
  let alerts = '';
  for (let i = 0; i < 6; i++) { await sleep(5000); alerts += (await bot('get-status', {})).split('\n').filter(l => l.startsWith('[!]')).join(' ') + ' '; }
  const after = await bot('get-status', {});
  const deaths = deathsIn(logSince(mark).lines);
  report('shield guard against a skeleton (idle 30 s)', !deaths.length && /raised shield against skeleton/.test(alerts),
    `before: ${before.split('\n')[0]}\nafter:  ${after.split('\n')[0]}\nalerts: ${alerts.trim()}\n${deaths.join('\n')}`);
}

async function emergency() {
  await reset(['dirt 32', 'cooked_beef 3', 'stone_sword']);
  const mark = logSince(0).offset;
  await gm(`damage ${BOTNAME} 14`);
  await gm(`execute at ${BOTNAME} run summon zombie ~2 ~ ~`);
  let alerts = '';
  for (let i = 0; i < 4; i++) { await sleep(4000); alerts += (await bot('get-status', {})).split('\n').filter(l => l.startsWith('[!]')).join(' ') + ' '; }
  const pos = (await bot('get-position', {})).match(/\((-?\d+), (-?\d+), (-?\d+)\)/).slice(1).map(Number);
  let solid = 0;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [0, 2, 0]]) {
    const b = await bot('get-block-info', { x: pos[0] + dx, y: pos[1] + dy, z: pos[2] + dz });
    if (!/Found air/.test(b)) solid++;
  }
  const deaths = deathsIn(logSince(mark).lines);
  report('emergency cover at 6 HP under attack', !deaths.length && /walled in/.test(alerts) && solid === 9,
    `alerts: ${alerts.trim()}\nshelter cells solid: ${solid}/9\n${(await bot('get-status', {})).split('\n')[0]}\n${deaths.join('\n')}`);
}

async function drown() {
  await reset([]);
  const mark = logSince(0).offset;
  await gm(`tp ${BOTNAME} ${ax + 22} ${ay - 5} ${az}`); // bottom of the tank, 6 blocks of water above
  let alerts = '';
  for (let i = 0; i < 7; i++) { await sleep(5000); alerts += (await bot('get-status', {})).split('\n').filter(l => l.startsWith('[!]')).join(' ') + ' '; }
  const st = await bot('get-status', {});
  const deaths = deathsIn(logSince(mark).lines);
  report('drowning escape (35 s in a 6-deep tank)', !deaths.length && /swimming up/.test(alerts),
    `alerts: ${alerts.trim()}\n${st.split('\n')[0]}  ${(await bot('get-position', {}))}\n${deaths.join('\n')}`);
}

async function lava() {
  await reset([]);
  // a one-deep lava pit in the arena floor (stone under it so it cannot flow away)
  await gm(`fill ${ax + 5} ${ay - 1} ${az + 5} ${ax + 7} ${ay - 1} ${az + 7} stone`);
  await gm(`fill ${ax + 5} ${ay} ${az + 5} ${ax + 7} ${ay} ${az + 7} lava`);
  await gm(`effect give ${BOTNAME} fire_resistance 60 0`); // safe: this only tests getting out
  const mark = logSince(0).offset;
  await gm(`tp ${BOTNAME} ${ax + 6} ${ay} ${az + 6}`);
  let alerts = '';
  for (let i = 0; i < 3; i++) { await sleep(4000); alerts += (await bot('get-status', {})).split('\n').filter(l => l.startsWith('[!]')).join(' ') + ' '; }
  const st = await bot('get-status', {});
  const where = await bot('get-position', {});
  await gm(`fill ${ax + 5} ${ay} ${az + 5} ${ax + 7} ${ay} ${az + 7} stone`); // clean up
  const deaths = deathsIn(logSince(mark).lines);
  report('lava escape (one-deep pit, fire resistance on)', !deaths.length && !/IN LAVA/.test(st) && /jumping out/.test(alerts),
    `alerts: ${alerts.trim()}\n${st.split('\n').find(l => l.startsWith('Backend'))}  ${where}\n${deaths.join('\n')}`);
}

const which = process.argv[2] ?? 'all';
async function defend() {
  // a mining job (on the arena's glass rim, which drops nothing, so it never finishes) and a husk walks up:
  // Baritone should pause the job, the bot should kill it, and the job should carry on
  await reset(['stone_sword', 'stone_pickaxe'], 6000);
  await gm(`fill ${ax - 12} ${ay + 1} ${az - 12} ${ax + 12} ${ay + 1} ${az - 12} glass`);
  const mark = logSince(0).offset;
  const job = bot('mine-blocks', { block: 'glass', count: 200, timeoutMs: 40000 });
  await sleep(4000);
  await gm(`execute at ${BOTNAME} run summon husk ~4 ~ ~`);
  // poll every second: with a sword the fight is over in a few seconds
  const seen = [];
  let alerts = '';
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const st = (await bot('get-status', {})).split(NL);
    seen.push(st.find(l => l.startsWith('Backend')) ?? '');
    alerts += st.filter(l => l.startsWith('[!]')).join(' ');
  }
  await job;
  const husk = await bot('find-entity', { type: 'husk', maxDistance: 32 });
  const deaths = deathsIn(logSince(mark).lines);
  const fought = seen.some(l => /Defend/.test(l)) || /hit husk/.test(alerts);
  report('defend during a job (husk while mining)', !deaths.length && /No husk/.test(husk) && fought && /Mine glass/.test(seen.at(-1)),
    [...new Set(seen), alerts, husk, ...deaths].join(NL));
}

const scenarios = { creeper, shield, emergency, drown, lava, defend };
if (which === 'setup') await setup();
else if (which === 'all') { for (const s of Object.values(scenarios)) await s(); }
else await scenarios[which]();
if (results.length) console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed`);
