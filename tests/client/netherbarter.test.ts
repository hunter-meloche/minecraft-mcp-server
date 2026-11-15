import test from 'ava';
import type { InventoryItem } from '../../src/client/tools.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import {
  BARTER_FOR, BARTER_RADIUS, BARTER_WAITS, CROWD, GOLD, GOLD_RESERVE, HOGLIN_GAP, LAVA_GAP, NEAR, PLAYER_GAP, STANCE, TOSS_FAILS, barterDanger, barterGround,
  barterOpen, barterReady, barterRun, barterable, goldGoal, goldWant, lavaBy, lootWords, overDrop, spareGold, stanceFor, throwClear, type Seen
} from '../../src/client/brain/netherbarter.js';
import { quartzGround } from '../../src/client/brain/netherquartz.js';
import { FROM_BUILDS, SETUP_WAITS, boxGap, boxOf, footing, walkFrom, zoneBox, type Box, type NetherZone } from '../../src/client/brain/nethersetup.js';
import {
  NETHER, NETHER_STOCK, OVERWORLD, barterHold, netherLine, netherOf, netherShort, netherStock, peekNether, portalCells, type PortalShape
} from '../../src/client/brain/nether.js';
import { KEEP } from '../../src/client/brain/community.js';
import { LADDER, NETHER_WORK } from '../../src/client/brain/worktasks.js';
import { workGoals } from '../../src/client/brain/work.js';
import { MINUTE, T0, liveWorld, lookAt, realGoals } from '../helpers/homestead.js';
import { KIT, ROOM_ZONE, game, gridOf, k, netherGround, setupWorld, type Loot, type Mob } from '../helpers/netherworld.js';

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
SETUP_WAITS.pollMs = 0;
SETUP_WAITS.loadMs = 0;
BARTER_WAITS.pollMs = 0;

/** Its own Nether-side portal where the setup trip builds it in the test Nether (dug into the cliff, along z). */
const OWN: PortalShape = { x: -79, y: 70, z: 266, axis: 'z', width: 2, height: 3 };
const OWN_BOX = boxOf(portalCells(OWN));
const ORES = '-547,63,2180';
const DROPS = '-547,65,2179';
const STONE2 = '-547,64,2180';
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });

/** The nether rung's goal on the real ladder, its clock at `now`. */
const rung = (now = T0) => workGoals(() => undefined, LADDER, () => now).find(g => g.name === 'work: nether')!;

type Game = ReturnType<typeof game>;

/**
 * The setup trip run through (its hut built, its portal lit, linked), then stage 1 as two clean trips open it (the
 * setup's and the look's), on game day 7, with `gold` ingots in the ores chest (the chore smelted them); and a game of
 * the world as it left it, two hours on, with `opts` (the mobs down there, the loot).
 */
async function afterSetup(opts: Parameters<typeof game>[1] = {}, gold = 60) {
  const w = setupWorld();
  const first = game(w);
  await rung().run(first.ctx);
  const n = netherOf(w);
  n.stage = 1;
  n.stageTrips = 2;
  n.cleanTrips = 3;
  w.idle = { today: { day: 7 } as never, days: [] };
  w.chestItems![ORES].gold_ingot = gold;
  const later = T0 + 2 * HOUR;
  const f = game(w, { items: first.inv, after: first, now: later, ...opts });
  return { w, first, later, f };
}

/** Every barter target met but soul sand (none): 4 potions of fire resistance carried, the rest in the chests. */
function onlySoulSand(w: WorldMemory, inv: InventoryItem[]) {
  inv.push({ slot: 33, name: 'potion', count: 4, potion: 'fire_resistance' });
  Object.assign(w.chestItems![DROPS], { leather: 16, ender_pearl: 16 });
  w.chestItems![STONE2].obsidian = 20;
}

/** A piglin south of its hut on the open floor, 16 and more from the community's room. */
const P1: Mob = { id: 11, name: 'piglin', position: { x: -70.5, y: 70, z: 255.5 } };

const netherWalks = (f: Game) => f.walks.filter(x => x.dim === NETHER);
const carried = (f: Game, n: string) => f.inv.filter(i => i.slot < 36 && i.name === n).reduce((a, i) => a + i.count, 0);
/** A hook for the fake's looks: `then` once the trip's did shows `after`, the look it first does. */
const once = (get: () => Game | undefined, after: RegExp, then: (f: Game) => void) => {
  let done = false;
  return () => { const f = get(); if (!done && f && f.did.some(d => after.test(d))) { done = true; then(f); } };
};
/** Every walk down there careful, within 48 of its portal and 16 from the community's room. */
function walkedKindly(t: { true: (v: boolean, m?: string) => void }, f: Game) {
  for (const x of netherWalks(f)) {
    t.true(x.careful, k(x.to));
    t.true(boxGap(OWN_BOX, cellBox(x.to)) <= BARTER_RADIUS, k(x.to));
    t.true(boxGap(zoneBox(ROOM_ZONE), cellBox(x.to)) >= FROM_BUILDS, k(x.to));
  }
}

// ------------------------------------------------------------------------------------------------ a trip end to end

test.serial('a barter trip: through to its own hut, out on foot to a piglin, an ingot tossed to its feet, its admiring waited out, what it threw picked up; till the targets are met, back through its own portal; said as `nether: bartered N gold: ...`', async (t) => {
  const { w, later, f } = await afterSetup({ mobs: [P1], loot: [{ name: 'soul_sand', count: 8 }] });
  onlySoulSand(w, f.inv);
  // (the rung's turn at the barter: the barter and the quartz take turns, and the setup trip moved it on)
  w.work!.next.nether = 0;
  t.is(rung(later).wants(lookAt(f.inv, 1000, { now: later }), w), 'barter: in the nether');
  const text = await rung(later).run(f.ctx);
  t.is(text, '[barter] bartered 2 gold with 1 piglin: 16 soul_sand; every barter target met; back at overworld (-562, 65, 2191); back home');
  t.deepEqual(f.said.filter(l => l.startsWith('nether: ')), ['nether: through the portal at overworld (-562, 63, 2191) -> nether (-79, 70, 267)', 'nether: bartered 2 gold: 16 soul_sand']);
  // the gold taken: 32 of the 39 over the reserve's 21
  t.true(f.did.includes('take gold_ingot x32'));
  // two tosses from 3 to 4 out, each taken, admired, its loot thrown and picked up; the order of it
  const seq = f.did.filter(d => /^(toss|piglin|picked|portal)/.test(d));
  t.deepEqual(seq.map(d => d.replace(/ -> .*| from .*/, '')), [
    'portal overworld (-562, 63, 2191)', 'toss gold_ingot', 'piglin #11 took the gold', 'piglin #11 threw 8 soul_sand', 'picked up 8 soul_sand',
    'toss gold_ingot', 'piglin #11 took the gold', 'piglin #11 threw 8 soul_sand', 'picked up 8 soul_sand', 'portal the_nether (-79, 70, 267)'
  ]);
  for (const d of f.did.filter(x => x.startsWith('toss '))) {
    const [, x, z] = /from \((-?\d+), \d+, (-?\d+)\)/.exec(d)!.map(Number);
    const off = Math.hypot(x + 0.5 - P1.position.x, z + 0.5 - P1.position.z);
    t.true(off >= STANCE.near && off <= STANCE.far, `${d}: ${off}`);
  }
  // nothing dug or placed down there; every walk careful, within 48 of its portal, 16 from the community's room
  t.deepEqual(f.changed, []);
  t.true(netherWalks(f).length > 3);
  walkedKindly(t, f);
  // home with the rest of the gold, the loot; a clean trip, the third for the stages
  t.is(carried(f, 'gold_ingot'), 30);
  t.is(carried(f, 'soul_sand'), 16);
  t.like(peekNether(w), { stageTrips: 3, linked: true, lastTrip: { end: 'clean', text: '[barter] bartered 2 gold with 1 piglin: 16 soul_sand; every barter target met; back at overworld (-562, 65, 2191)' } });
  t.is(f.state.dim, OVERWORLD);
  t.is(w.work?.last?.gain, 16);
});

test.serial('the loot in the log: every kind it picked up, the most first, a potion by its contents', async (t) => {
  const loot: Loot[] = [{ name: 'gravel', count: 12 }, { name: 'potion', count: 1, potion: 'fire_resistance' }, { name: 'soul_sand', count: 8 }, { name: 'leather', count: 3 }, { name: 'soul_sand', count: 8 }];
  const { w, f } = await afterSetup({ mobs: [P1], loot });
  onlySoulSand(w, f.inv);
  const r = await barterRun(f.ctx, HOUR, () => T0 + 2 * HOUR);
  t.true(f.said.includes('nether: bartered 5 gold: 16 soul_sand, 12 gravel, 3 leather, 1 potion of fire_resistance'), f.said.join(' | '));
  t.like(r, { gain: 32, cameBack: true });
  t.is(lootWords(new Map([['b', 2], ['a', 2], ['c', 5], ['d', 0]])), '5 c, 2 a, 2 b');
});

// ------------------------------------------------------------------------------------------------ the stop rules

test.serial('a hoglin near stops it: back to its portal and through at once, what it picked up kept, no hold', async (t) => {
  let g: Game | undefined;
  const { w, f } = await afterSetup({
    mobs: [P1],
    onLook: once(() => g, /^picked up/, x => x.mobs.push({ id: 30, name: 'hoglin', position: { x: x.state.pos.x - 6, y: 70, z: x.state.pos.z - 8 } }))
  });
  g = f;
  const r = await barterRun(f.ctx, HOUR, () => T0 + 2 * HOUR);
  t.is(r.text, 'bartered 1 gold with 1 piglin: 4 soul_sand; a hoglin near (10 off); back at overworld (-562, 65, 2191)');
  t.is(f.did.filter(d => d.startsWith('toss ')).length, 1);
  t.is(barterHold(w, T0 + 2 * HOUR), undefined);
  t.is(f.state.dim, OVERWORLD);
});

test.serial('a hit taken stops it (health down since the last look), and so does a ghast within 32', async (t) => {
  let g: Game | undefined;
  const hit = await afterSetup({ mobs: [P1], onLook: once(() => g, /^picked up/, x => { x.state.health = 15; }) });
  g = hit.f;
  const r = await barterRun(hit.f.ctx, HOUR, () => T0 + 2 * HOUR);
  t.is(r.text, 'bartered 1 gold with 1 piglin: 4 soul_sand; a hit taken (health 20 -> 15); back at overworld (-562, 65, 2191)');
  let h: Game | undefined;
  const ghast = await afterSetup({ mobs: [P1], onLook: once(() => h, /took the gold/, x => x.mobs.push({ id: 31, name: 'ghast', position: { x: x.state.pos.x, y: 85, z: x.state.pos.z - 20 } })) });
  h = ghast.f;
  const r2 = await barterRun(ghast.f.ctx, HOUR, () => T0 + 2 * HOUR);
  // (sent back as the piglin admired: nothing thrown yet to pick up)
  t.regex(r2.text, /^bartered 1 gold with 1 piglin: nothing picked up; a ghast near \(25 off\); back at overworld/);
  t.true(ghast.f.said.includes('nether: bartered 1 gold: nothing picked up'));
});

test.serial('on fire it goes back to its portal, as on a hit', async (t) => {
  let burning = false;
  let g: Game | undefined;
  const { f, later } = await afterSetup({ mobs: [P1], onLook: once(() => g, /^picked up/, () => { burning = true; }) });
  g = f;
  const status = f.ctx.status;
  (f.ctx as { status: GoalContext['status'] }).status = async () => ({ ...(await status()), ...(burning ? { onFire: true } : {}) });
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'bartered 1 gold with 1 piglin: 4 soul_sand; on fire; back at overworld (-562, 65, 2191)');
});

test.serial('a hoglin come near in the middle of a walk out is seen at the next leg: not a leg more toward the piglin, back to its portal', async (t) => {
  const far: Mob = { id: 11, name: 'piglin', position: { x: -70.5, y: 70, z: 230.5 } };
  const { f, later } = await afterSetup({ mobs: [far] });
  const call = f.ctx.call;
  const seq: string[] = [];
  let legs = 0;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    const r = await call(m, p);
    if (m === 'goto' && f.state.dim === NETHER) {
      seq.push('goto');
      // (it comes 6 off at the walk's second leg)
      if (++legs === 2) { f.mobs.push({ id: 30, name: 'hoglin', position: { x: f.state.pos.x, y: 70, z: f.state.pos.z - 6 } }); seq.push('hoglin'); }
    }
    if (m === 'world.entities') seq.push('look');
    return r;
  }) as GoalContext['call'];
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.regex(r.text, /^no barter; a hoglin near \(6 off\); back at overworld/);
  t.is(seq[seq.indexOf('hoglin') + 1], 'look', seq.join(' '));
  t.false(f.did.some(d => d.startsWith('toss ')));
});

test.serial('turned back by a danger before any barter (a ghast near on arrival): the place is not marked dry as an empty one is, its mark stays at the first (20 min) trip after trip', async (t) => {
  const ghast: Mob = { id: 31, name: 'ghast', position: { x: -76.5, y: 80, z: 245.5 } };
  const { w, first, later, f } = await afterSetup({ mobs: [P1, ghast] });
  // (the quartz at its target: the rung's turn is the barter's)
  w.chestItems![ORES].quartz = 64;
  t.regex(await rung(later).run(f.ctx), /^\[barter\] no barter; a ghast near \(\d+ off\); back at overworld .*; back home$/);
  t.like(w.work!.dry['nether:barter'], { n: 1, at: later });
  const again = later + 30 * MINUTE;
  // (the fake's chests as the trip left them in world memory)
  w.chestItems![ORES].quartz = 64;
  const g = game(w, { items: f.inv, after: { changed: [...first.changed, ...f.changed], lit: f.lit }, now: again, mobs: [P1, ghast] });
  t.regex(await rung(again).run(g.ctx), /^\[barter\] no barter; a ghast near/);
  t.like(w.work!.dry['nether:barter'], { n: 1, at: again });
  // (on the next game day, past the day's two trips: the barter waits its first mark's 20 min, no more)
  w.idle!.today.day = 8;
  t.like(rung(again + MINUTE).declines!(lookAt(g.inv, 1000, { now: again + MINUTE }), w), { cause: 'dry', until: again + 20 * MINUTE });
});

test('what sends it back: a piglin of any kind aggressive within 16 (the anger: held), a hit, a brute or a hoglin within 16, a ghast within 32; nothing further off', (t) => {
  const at = (name: string, distance: number, extra: Partial<Seen> = {}): Seen => ({ id: distance, name, position: { x: distance, y: 70, z: 0 }, distance, ...extra });
  t.deepEqual(barterDanger([at('piglin', 12, { aggressive: true })], 20, 20), { why: 'a piglin turned aggressive at nether (12, 70, 0)', angry: true });
  t.deepEqual(barterDanger([at('zombified_piglin', 15, { aggressive: true })], 20, 20), { why: 'a zombified_piglin turned aggressive at nether (15, 70, 0)', angry: true });
  t.is(barterDanger([at('piglin', 20, { aggressive: true })], 20, 20), null);
  t.deepEqual(barterDanger([], 17, 20), { why: 'a hit taken (health 20 -> 17)' });
  t.is(barterDanger([], 20, 19), null, 'healing is no hit');
  t.deepEqual(barterDanger([at('piglin_brute', 14)], 20, 20), { why: 'a piglin brute near (14 off)' });
  t.deepEqual(barterDanger([at('hoglin', NEAR.hoglin)], 20, 20), { why: `a hoglin near (${NEAR.hoglin} off)` });
  t.deepEqual(barterDanger([at('zoglin', 9)], 20, 20), { why: 'a zoglin near (9 off)' });
  t.deepEqual(barterDanger([at('ghast', 30)], 20, 20), { why: 'a ghast near (30 off)' });
  t.is(barterDanger([at('ghast', 40), at('hoglin', 17), at('piglin_brute', 17), at('piglin', 5)], 20, 20), null);
  // the anger first, whatever else
  t.like(barterDanger([at('hoglin', 5), at('piglin', 10, { aggressive: true })], 12, 20), { angry: true });
});

test.serial('a piglin turned aggressive: back to its portal at once and the barter held for the rest of the game day (brain-status says it); the next game day it may go again', async (t) => {
  let g: Game | undefined;
  const P2: Mob = { id: 12, name: 'piglin', position: { x: -66.5, y: 70, z: 250.5 } };
  const { w, later, f } = await afterSetup({ mobs: [P1, P2], onLook: once(() => g, /^picked up/, x => { x.mobs.find(m => m.id === 12)!.aggressive = true; }) });
  g = f;
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'bartered 1 gold with 1 piglin: 4 soul_sand; a piglin turned aggressive at nether (-67, 70, 250), the barter held for the day; back at overworld (-562, 65, 2191)');
  t.true(f.said.includes('nether: a piglin turned aggressive at nether (-67, 70, 250): back to its portal, the barter held for the day'), f.said.join(' | '));
  t.like(peekNether(w).barter, { held: { day: 7, at: later, why: 'a piglin turned aggressive at nether (-67, 70, 250)' } });
  const s = lookAt(f.inv, 1000, { now: later + 10 * MINUTE });
  t.deepEqual(barterReady(s, w), { cause: 'hold', text: 'barter held for the day: a piglin turned aggressive at nether (-67, 70, 250)' });
  t.regex(netherLine(w, later + 10 * MINUTE), /\(linked\); barter held for the day: a piglin turned aggressive at nether \(-67, 70, 250\); others' portals seen/);
  // the next game day: free again (and never past a real day, should the tally stand still)
  w.idle!.today.day = 8;
  t.is(barterReady(s, w), null);
  t.false(netherLine(w, later + 10 * MINUTE).includes('barter held'));
  w.idle!.today.day = 7;
  t.is(barterReady(lookAt(f.inv, 1000, { now: later + DAY }), w), null);
});

test.serial('the barter\'s time: it stops with what the way back and through needs left (45 s), and goes home through its own portal', async (t) => {
  const { w, f } = await afterSetup({ mobs: [P1], loot: [{ name: 'soul_sand', count: 2 }] });
  onlySoulSand(w, f.inv);
  // (half a minute a look at the clock: the kit, the arrival, then each barter's turn)
  let clock = T0 + 2 * HOUR;
  const r = await barterRun(f.ctx, 3 * MINUTE, () => (clock += 30_000));
  t.is(r.text, 'bartered 2 gold with 1 piglin: 4 soul_sand; the barter\'s time is up; back at overworld (-562, 65, 2191)');
  t.like(r, { cameBack: true });
});

test.serial('a barter whose home portal comes out at someone else\'s: not linked, straight back through it (nothing touched, not a step down there), the setup held a day; no barter', async (t) => {
  const { w, f, later } = await afterSetup({ mobs: [P1] });
  f.lit.push({ x: -71, y: 70, z: 273, axis: 'x', width: 2, height: 3, dim: NETHER });
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.deepEqual(r, { gain: 0, text: 'the home portal came out at nether (-71, 70, 273), not at its own: not linked; back at overworld (-562, 65, 2191); setup held a day', cameBack: true });
  t.like(peekNether(w), { linked: false, setupHold: { until: later + DAY } });
  t.true(f.said.includes('nether: not linked: the home portal came out at nether (-71, 70, 273), not at its own at nether (-79, 70, 266): setup held a day'));
  t.deepEqual(netherWalks(f), []);
  t.false(f.did.some(d => d.startsWith('toss ')));
  t.false(barterOpen(w), 'the setup sees to the link first');
});

// ------------------------------------------------------------------------------------------------ which piglin

test('which piglin: an adult (no brute, no baby), not aggressive or admiring, within 48 of its portal, 16 from anyone\'s build, no hoglin within 16 of it, no other piglin by its feet, on ground the read holds', (t) => {
  const g = gridOf(netherGround(), { x1: -130, y1: 60, z1: 215, x2: -28, y2: 82, z2: 318 });
  const zones = [zoneBox(ROOM_ZONE)];
  const pig = (id: number, x: number, z: number, extra: Partial<Seen> = {}): Seen => ({ id, name: 'piglin', position: { x, y: 70, z }, distance: 5, ...extra });
  const ok = pig(1, -70.5, 255.5);
  const why = (e: Seen, others: Seen[] = []) => barterable(e, [e, ...others], g, OWN_BOX, zones);
  t.is(why(ok), null);
  t.is(why({ ...ok, name: 'piglin_brute' }), 'no piglin');
  t.is(why({ ...ok, name: 'zombified_piglin' }), 'no piglin');
  t.is(why({ ...ok, baby: true }), 'a baby');
  t.is(why({ ...ok, aggressive: true }), 'aggressive');
  t.is(why({ ...ok, admiring: true, offhand: 'gold_ingot' }), 'admiring gold_ingot already');
  t.is(why(pig(2, -70.5, 210.5)), `more than ${BARTER_RADIUS} from its portal`);
  t.is(why(pig(3, -60.5, 270.5)), `within ${FROM_BUILDS} of someone's build`, 'by the community\'s room');
  t.is(why({ ...ok, foreign: true }), `within ${FROM_BUILDS} of someone's build`, 'in a build by the bridge\'s word');
  t.is(why({ ...ok, buildDistance: 10 }), `within ${FROM_BUILDS} of someone's build`);
  t.is(why(ok, [{ id: 9, name: 'hoglin', position: { x: -70.5, y: 70, z: 255.5 - (HOGLIN_GAP - 1) }, distance: 20 }]), `a hoglin ${HOGLIN_GAP - 1} from it`);
  t.is(why(ok, [{ id: 9, name: 'hoglin', position: { x: -70.5, y: 70, z: 255.5 - HOGLIN_GAP }, distance: 20 }]), null);
  t.is(why(ok, [pig(4, -70.5 + CROWD - 0.5, 255.5, { baby: true })]), 'a baby by it');
  t.is(why(ok, [pig(4, -70.5, 255.5 + 1)]), 'another piglin by it');
  t.is(why(ok, [pig(4, -70.5, 255.5 + CROWD)]), null);
  t.is(why({ ...ok, position: { x: -70.5, y: 75, z: 255.5 } }), 'on no ground the read holds', 'in the air');
});

test('where it stands: 3 to 4 from the piglin\'s feet along the ground, on its level or a step from it, the throw\'s way clear, the fewest steps; the ground it walks keeps from lava and drops', (t) => {
  // lava in the floor; a pit 6 deep in the floor (its bottom firm, at y 63: a fall, no lava); lava 2 under the floor
  const lava: Record<string, string> = { [k({ x: -60, y: 69, z: 250 })]: 'lava', [k({ x: -66, y: 67, z: 250 })]: 'lava' };
  for (let y = 64; y <= 69; y++) lava[k({ x: -70, y, z: 240 })] = 'air';
  const ground = (extra: Record<string, string> = {}) => { const base = netherGround(); return (p: Pos) => extra[k(p)] ?? base(p); };
  const g = gridOf(ground(lava), { x1: -130, y1: 60, z1: 215, x2: -28, y2: 82, z2: 318 });
  const may = barterGround(g, OWN_BOX, [zoneBox(ROOM_ZONE)]);
  const start = footing(g, { x: -76.5, y: 70, z: 267.5 })!;
  const reach = walkFrom(g, [start], may);
  const st = stanceFor(g, reach, P1.position)!;
  const off = Math.hypot(st.x + 0.5 - P1.position.x, st.z + 0.5 - P1.position.z);
  t.true(off >= STANCE.near && off <= STANCE.far, `${off}`);
  t.is(st.y, 70);
  // every cell it may walk: 16 from the room, 48 from its portal, no lava within 2, no drop's edge
  for (const key of reach.keys()) {
    const [x, y, z] = key.split(',').map(Number);
    const p = { x, y, z };
    if (x === start.x && z === start.z) continue;
    t.false(lavaBy(g, p), key);
    t.false(overDrop(g, p), key);
    t.true(boxGap(zoneBox(ROOM_ZONE), cellBox(p)) >= FROM_BUILDS, key);
  }
  t.true(lavaBy(g, { x: -60 + LAVA_GAP, y: 70, z: 250 }));
  t.false(lavaBy(g, { x: -60 + LAVA_GAP + 1, y: 70, z: 250 }));
  // the pit's rim is a drop's edge (the pit's bottom firm, no lava down it), a block back from it is none
  t.false(reach.has(k({ x: -71, y: 70, z: 240 })), 'the rim');
  t.false(lavaBy(g, { x: -71, y: 70, z: 240 }));
  t.true(reach.has(k({ x: -72, y: 70, z: 240 })));
  // lava 2 under the floor (3 under the feet) is by the cell; 3 under the floor is not
  t.true(lavaBy(g, { x: -66, y: 70, z: 250 }));
  t.false(reach.has(k({ x: -66, y: 70, z: 250 })));
  t.true(reach.has(k({ x: -66, y: 70, z: 253 })));
  const deeper = gridOf(ground({ [k({ x: -66, y: 66, z: 250 })]: 'lava' }), { x1: -80, y1: 60, z1: 240, x2: -55, y2: 80, z2: 260 });
  t.false(lavaBy(deeper, { x: -66, y: 70, z: 250 }));
  // a pit by a cell: its edge; a step down of 3 is none
  const pit: Record<string, string> = {};
  for (let y = 60; y <= 69; y++) pit[k({ x: -70, y, z: 240 })] = 'air';
  const step: Record<string, string> = {};
  for (let y = 67; y <= 69; y++) step[k({ x: -70, y, z: 240 })] = 'air';
  const box = { x1: -80, y1: 55, z1: 230, x2: -60, y2: 80, z2: 250 };
  t.true(overDrop(gridOf(ground(pit), box), { x: -71, y: 70, z: 240 }));
  t.false(overDrop(gridOf(ground(step), box), { x: -71, y: 70, z: 240 }));
  // a wall between: no throw that way
  const wall: Record<string, string> = { [k({ x: -72, y: 71, z: 255 })]: 'netherrack' };
  t.false(throwClear(gridOf(ground(wall), box2()), { x: -74, y: 70, z: 255 }, { x: -70.5, y: 70, z: 255.5 }));
  t.true(throwClear(gridOf(ground(), box2()), { x: -74, y: 70, z: 255 }, { x: -70.5, y: 70, z: 255.5 }));
});
const box2 = () => ({ x1: -80, y1: 60, z1: 245, x2: -60, y2: 80, z2: 265 });

test('a ledge over a lava lake: the cells within 2 of the edge are lava by them however deep the lake lies, for the barter and the quartz alike; and so is a chasm whose bottom is past the ground read', (t) => {
  // a ledge, its floor at y 90, for x <= 0; past it an open pit down to a lake at y 85 (as the look saw by its portal:
  // lakes 6 under its floor)
  const ledge = (lake: string) => gridOf(p => (p.x <= 0 ? (p.y <= 90 ? 'netherrack' : 'air') : p.y <= 84 ? 'netherrack' : p.y === 85 ? lake : 'air'), { x1: -10, y1: 80, z1: -10, x2: 10, y2: 99, z2: 10 });
  const portal = { x1: -6, y1: 91, z1: 0, x2: -5, y2: 93, z2: 0 };
  const g = ledge('lava');
  const may = barterGround(g, portal, []);
  const quartz = quartzGround(g, { portal, floor: 90, zones: [], placed: [] });
  const cell = (x: number): Pos => ({ x, y: 91, z: 0 });
  // the edge, and a block back from it (no drop's edge there: one knock-back from it is over the lake)
  for (const x of [0, -1]) {
    t.true(lavaBy(g, cell(x)), `${x}`);
    t.false(may(cell(x)), `${x}`);
    t.false(quartz.may(cell(x)), `${x}`);
  }
  t.false(overDrop(g, cell(-1)));
  // three across from the open column: none
  t.false(lavaBy(g, cell(-2)));
  t.true(may(cell(-2)));
  t.true(quartz.may(cell(-2)));
  // the same pit with a floor of netherrack at its bottom: a fall, no lava (the edge stays out as a drop's)
  const dry = ledge('netherrack');
  t.false(lavaBy(dry, cell(-1)));
  t.true(barterGround(dry, portal, [])(cell(-1)));
  t.false(barterGround(dry, portal, [])(cell(0)));
  // a chasm 2 across that goes on past the read's bottom (y 80): not known, so as lava
  const chasm = gridOf(p => (p.x === 1 ? 'air' : p.y <= 90 ? 'netherrack' : 'air'), { x1: -10, y1: 80, z1: -10, x2: 10, y2: 99, z2: 10 });
  t.true(lavaBy(chasm, cell(-1)));
  t.false(lavaBy(chasm, cell(-2)));
});

test.serial('courtesy: a piglin by the community\'s room is never bartered with (and none else: no barter, home again); nothing tossed, nothing touched', async (t) => {
  const near: Mob = { id: 13, name: 'piglin', position: { x: -64.5, y: 70, z: 268.5 } };
  const { f } = await afterSetup({ mobs: [near] });
  const r = await barterRun(f.ctx, HOUR, () => T0 + 2 * HOUR);
  t.is(r.text, 'no barter; no piglin to barter with within 48 of its portal (1 within 16 of someone\'s build); back at overworld (-562, 65, 2191)');
  t.like(r, { gain: 0, cameBack: true });
  t.false(f.did.some(d => d.startsWith('toss ')));
  t.deepEqual(f.changed, []);
  walkedKindly(t, f);
});

test.serial('no piglin to barter with: the line says what each it saw fell to, or that it saw none', async (t) => {
  const none = await afterSetup();
  const r = await barterRun(none.f.ctx, HOUR, () => none.later);
  t.is(r.text, 'no barter; no piglin to barter with within 48 of its portal (none seen); back at overworld (-562, 65, 2191)');
  const mobs: Mob[] = [{ id: 21, name: 'piglin', baby: true, position: { x: -72.5, y: 70, z: 258.5 } }, { id: 13, name: 'piglin', position: { x: -64.5, y: 70, z: 268.5 } }];
  const some = await afterSetup({ mobs });
  const r2 = await barterRun(some.f.ctx, HOUR, () => some.later);
  t.regex(r2.text, /^no barter; no piglin to barter with within 48 of its portal \((1 a baby, 1 within 16 of someone's build|1 within 16 of someone's build, 1 a baby)\); back at/);
});

test.serial('courtesy: no barter with a piglin a player is near (someone else\'s barter, and its loot would go to them), and what lies with a player by it is not picked up', async (t) => {
  const pig = (id: number, x: number, z: number): Seen => ({ id, name: 'piglin', position: { x, y: 70, z }, distance: 5 });
  const g = gridOf(netherGround(), { x1: -130, y1: 60, z1: 215, x2: -28, y2: 82, z2: 318 });
  const ok = pig(1, -70.5, 255.5);
  const player = (dz: number): Seen => ({ id: 9, name: 'player', position: { x: -70.5, y: 70, z: 255.5 - dz }, distance: 20 });
  t.is(barterable(ok, [ok, player(PLAYER_GAP - 1)], g, OWN_BOX, [zoneBox(ROOM_ZONE)]), `a player within ${PLAYER_GAP} of it`);
  t.is(barterable(ok, [ok, player(PLAYER_GAP)], g, OWN_BOX, [zoneBox(ROOM_ZONE)]), null);
  // someone comes up to the piglin as it admires: what it throws is theirs to take, and it is not bartered with again
  let h: Game | undefined;
  const { f, later } = await afterSetup({
    mobs: [P1], onLook: once(() => h, /took the gold/, x => x.mobs.push({ id: 50, name: 'player', position: { x: P1.position.x + 3, y: 70, z: P1.position.z } }))
  });
  h = f;
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.is(r.text, `bartered 1 gold with 1 piglin: nothing picked up; no piglin to barter with within 48 of its portal (1 a player within ${PLAYER_GAP} of it); back at overworld (-562, 65, 2191)`);
  t.true(f.drops.some(d => d.item === 'soul_sand'), 'left lying');
  t.is(f.did.filter(d => d.startsWith('toss ')).length, 1);
});

/** The fake's answer to foreign.zones down there replaced by `zones()` (a build its scan shows only later). */
function zonesBy(f: Game, zones: () => NetherZone[] | 'throw') {
  const call = f.ctx.call;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m !== 'foreign.zones' || f.state.dim !== NETHER) return call(m, p);
    const z = zones();
    if (z === 'throw') throw new Error('the bridge timed out');
    return { dimension: NETHER, zones: z.map(x => ({ ...x })) };
  }) as GoalContext['call'];
}

test.serial('the zones down there are asked once the ground is read: a build whose chunk came in while it was read keeps its 16 (the piglin by the community\'s room is let be)', async (t) => {
  const near: Mob = { id: 13, name: 'piglin', position: { x: -64.5, y: 70, z: 268.5 } };
  const { f, later } = await afterSetup({ mobs: [near] });
  // (the bridge's scan reads loaded chunks only: the room's shows once the ground round the portal is in)
  const call = f.ctx.call;
  let read = false;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'world.region' && f.state.dim === NETHER) read = true;
    return call(m, p);
  }) as GoalContext['call'];
  zonesBy(f, () => (read ? [ROOM_ZONE] : []));
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'no barter; no piglin to barter with within 48 of its portal (1 within 16 of someone\'s build); back at overworld (-562, 65, 2191)');
  t.false(f.did.some(d => d.startsWith('toss ')));
  walkedKindly(t, f);
});

test.serial('a build the bridge\'s scan shows only once the bot is out (its scan reaches 48 round the bot, the barter 48 from its portal and 16 past): kept 16 from from that look on, the piglin by it let be', async (t) => {
  const P2: Mob = { id: 12, name: 'piglin', position: { x: -70.5, y: 70, z: 236.5 } };
  const FAR: NetherZone = { x1: -76, y1: 66, z1: 214, x2: -64, y2: 76, z2: 222, markers: 40, surface: true, sample: 'stone_bricks' };
  let shown = false;
  let g: Game | undefined;
  // (the first piglin bartered with walks off as the bot picks up what it threw; the build comes in at that look)
  const { f, later } = await afterSetup({ mobs: [P1, P2], onLook: once(() => g, /^picked up/, x => { shown = true; x.mobs.splice(x.mobs.findIndex(m => m.id === P1.id), 1); }) });
  g = f;
  zonesBy(f, () => (shown ? [ROOM_ZONE, FAR] : [ROOM_ZONE]));
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'bartered 1 gold with 1 piglin: 4 soul_sand; no piglin to barter with within 48 of its portal (1 within 16 of someone\'s build); back at overworld (-562, 65, 2191)');
  t.false(f.did.includes(`piglin #${P2.id} took the gold`));
  for (const x of netherWalks(f)) t.true(boxGap(zoneBox(FAR), cellBox(x.to)) >= FROM_BUILDS, k(x.to));
});

test.serial('a build that shows in the middle of a walk out: the rest of the way is planned again round its 16, not walked through it', async (t) => {
  const far: Mob = { id: 11, name: 'piglin', position: { x: -70.5, y: 70, z: 230.5 } };
  // (17.9 from the piglin; its 16 leave a lane a block wide by the cliff at x -76)
  const NEW: NetherZone = { x1: -60, y1: 66, z1: 245, x2: -56, y2: 76, z2: 250, markers: 30, surface: true, sample: 'stone_bricks' };
  const { f, later } = await afterSetup({ mobs: [far] });
  let legs = 0;
  let shownAt = -1;
  const call = f.ctx.call;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    const r = await call(m, p);
    if (m === 'goto' && f.state.dim === NETHER && ++legs === 2) shownAt = netherWalks(f).length;
    return r;
  }) as GoalContext['call'];
  zonesBy(f, () => (shownAt >= 0 ? [ROOM_ZONE, NEW] : [ROOM_ZONE]));
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.regex(r.text, /^bartered \d+ gold with 1 piglin/);
  const after = netherWalks(f).slice(shownAt);
  t.true(after.length > 3);
  for (const x of after) t.true(boxGap(zoneBox(NEW), cellBox(x.to)) >= FROM_BUILDS, k(x.to));
});

test.serial('no word of the zones from the bridge on arrival: no barter, straight back through its own portal from where it stands by it', async (t) => {
  const { f, later } = await afterSetup({ mobs: [P1] });
  zonesBy(f, () => 'throw');
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.deepEqual(r, { gain: 0, text: 'no barter: the bridge did not say where the builds down there are; back at overworld (-562, 65, 2191)', mark: 'same', cameBack: true });
  t.deepEqual(netherWalks(f), []);
  t.false(f.did.some(d => d.startsWith('toss ')));
});

test.serial('a brute, a baby, one admiring already: none of them; the adult behind them is the one', async (t) => {
  const mobs: Mob[] = [
    { id: 20, name: 'piglin_brute', position: { x: -74.5, y: 70, z: 230.5 } },
    { id: 21, name: 'piglin', baby: true, position: { x: -72.5, y: 70, z: 258.5 } },
    { id: 22, name: 'piglin', offhand: 'gold_ingot', position: { x: -66.5, y: 70, z: 258.5 } },
    { ...P1, id: 23, position: { x: -70.5, y: 70, z: 248.5 } }
  ];
  const { w, f } = await afterSetup({ mobs, loot: [{ name: 'soul_sand', count: 16 }] });
  onlySoulSand(w, f.inv);
  const r = await barterRun(f.ctx, HOUR, () => T0 + 2 * HOUR);
  t.is(r.text, 'bartered 1 gold with 1 piglin: 16 soul_sand; every barter target met; back at overworld (-562, 65, 2191)');
  t.deepEqual(f.did.filter(d => /^piglin #/.test(d)), ['piglin #23 took the gold', 'piglin #23 threw 16 soul_sand']);
});

test.serial('a toss the bridge refuses (lava where it would come down): that piglin is let be, said, and the next one bartered with', async (t) => {
  const byLava: Mob = { id: 14, name: 'piglin', position: { x: -70.5, y: 70, z: 255.5 } };
  const other: Mob = { id: 15, name: 'piglin', position: { x: -68.5, y: 70, z: 240.5 } };
  const { w, first, later } = await afterSetup();
  // lava in the floor by the first, a block off its feet (the walk keeps 2 from it: the stance is further off)
  const f = game(w, { items: first.inv, after: { changed: [...first.changed, { dim: NETHER, at: { x: -71, y: 69, z: 254 }, to: 'lava', how: 'test' }], lit: first.lit }, now: later, mobs: [byLava, other], loot: [{ name: 'soul_sand', count: 16 }] });
  onlySoulSand(w, f.inv);
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.true(f.said.includes('barter: no toss to the piglin at nether (-71, 70, 255): the throw might come to rest by lava at (-71, 69, 254)'), f.said.join(' | '));
  t.regex(r.text, /^bartered 1 gold with 1 piglin: 16 soul_sand; every barter target met/);
  t.deepEqual(f.did.filter(d => /^piglin #/.test(d)), ['piglin #15 took the gold', 'piglin #15 threw 16 soul_sand']);
});

test.serial('a piglin in mid-jump (no floor under its feet for the toss): tried again from a fresh look, not let be', async (t) => {
  const { w, f, later } = await afterSetup({ mobs: [P1], loot: [{ name: 'soul_sand', count: 16 }] });
  onlySoulSand(w, f.inv);
  const call = f.ctx.call;
  let jumps = 1;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'item.toss' && jumps-- > 0) throw new Error('nothing to land on under the point (air at -71, 70, 255): give a mob\'s feet');
    return call(m, p);
  }) as GoalContext['call'];
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.regex(r.text, /^bartered 1 gold with 1 piglin: 16 soul_sand; every barter target met/);
  t.false(f.said.some(l => l.startsWith('barter: no toss')));
});

test.serial('never by lava: what lands by it is left lying, and no walk goes within 2 of it', async (t) => {
  const { w, first, later } = await afterSetup({}, GOLD_RESERVE + 1);
  // the loot comes down 2 to the side of the piglin, over lava in the floor there
  const hot = { x: -72, y: 69, z: 253 };
  const f = game(w, { items: first.inv, after: { changed: [...first.changed, { dim: NETHER, at: hot, to: 'lava', how: 'test' }], lit: first.lit }, now: later, mobs: [P1], lootAt: 'side' });
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'bartered 1 gold with 1 piglin: nothing picked up; the trip\'s 1 gold given; back at overworld (-562, 65, 2191)');
  t.is(f.drops.filter(d => d.item === 'soul_sand').length, 1, 'left lying');
  for (const x of netherWalks(f)) t.true(Math.max(Math.abs(x.to.x - hot.x), Math.abs(x.to.z - hot.z)) > LAVA_GAP, k(x.to));
});

test.serial('loot come down a step under where it stands (a block under its feet: out of the game\'s pickup box) is walked down to and picked up, not left lying', async (t) => {
  const { w, first, later } = await afterSetup({}, GOLD_RESERVE + 1);
  // the piglin in a hole 4 across at the foot of a step a block high north of it, walls round the rest: every place
  // 3 to 4 from it to toss from is on the step, a block over its feet
  const hole = (x: number, z: number) => x >= -72 && x <= -69 && z >= 254 && z <= 257;
  const step: { dim: typeof NETHER; at: Pos; to: string; how: string }[] = [];
  for (let x = -76; x <= -60; x++) for (let z = 240; z <= 262; z++) for (let y = 70; y <= (z >= 258 ? 70 : 72); y++) {
    if (!hole(x, z)) step.push({ dim: NETHER, at: { x, y, z }, to: 'netherrack', how: 'test' });
  }
  let g: Game | undefined;
  // (what it threw comes to rest against the step, in the hole as near the bot's feet as it goes: within a block of
  // them across, a block under them)
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const f = game(w, {
    items: first.inv, after: { changed: [...first.changed, ...step], lit: first.lit }, now: later, mobs: [P1],
    onLook: once(() => g, /threw/, x => {
      x.drops.find(d => d.item === 'soul_sand')!.position = { x: clamp(x.state.pos.x, -71.9, -68.1), y: 70, z: clamp(x.state.pos.z, 254.1, 257.9) };
    })
  });
  g = f;
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.true(f.did.some(d => /^toss gold_ingot -> .* from \(-7\d, 71, 258\)$/.test(d)), f.did.filter(d => d.startsWith('toss')).join(' | '));
  t.is(r.text, 'bartered 1 gold with 1 piglin: 4 soul_sand; the trip\'s 1 gold given; back at overworld (-562, 65, 2191)');
  t.false(f.drops.some(d => d.item === 'soul_sand'));
});

// ------------------------------------------------------------------------------------------------ the gold given

test.serial('mobGriefing off: a tossed ingot lies untaken, so it is given by hand (a right click) and the lying one picked up again; after three such the gold goes by hand first', async (t) => {
  const { w, f } = await afterSetup({ mobs: [P1], griefing: false, loot: [{ name: 'soul_sand', count: 2 }] });
  onlySoulSand(w, f.inv);
  const r = await barterRun(f.ctx, HOUR, () => T0 + 2 * HOUR);
  t.regex(r.text, /^bartered 8 gold with 1 piglin: 16 soul_sand; every barter target met; back at overworld/);
  t.is(f.did.filter(d => d.startsWith('toss ')).length, TOSS_FAILS);
  t.is(f.did.filter(d => d.startsWith('hand gold_ingot')).length, 8);
  t.true(f.said.includes(`barter: ${TOSS_FAILS} tossed ingots in a row lay untaken (the server's mobGriefing off?): the gold goes by hand from now on`));
  t.is(peekNether(w).barter?.untaken, TOSS_FAILS);
  // the tossed ones are its own again: 32 taken, 8 given
  t.is(carried(f, 'gold_ingot'), 32 - 8);
  t.false(f.drops.some(d => d.item === 'gold_ingot'));
  // a toss taken again (the gamerule turned on) puts the count back
  const g = await afterSetup({ mobs: [P1], loot: [{ name: 'soul_sand', count: 16 }] });
  onlySoulSand(g.w, g.f.inv);
  netherOf(g.w).barter = { untaken: 2 };
  await barterRun(g.f.ctx, HOUR, () => T0 + 2 * HOUR);
  t.is(peekNether(g.w).barter?.untaken, 0);
});

test.serial('the trip\'s gold: 32 at most of what is over the reserve of 21, never the reserve; none over it and it does not set out', async (t) => {
  const few = await afterSetup({ mobs: [P1], loot: [{ name: 'gravel', count: 10 }] }, GOLD_RESERVE + 3);
  const r = await barterRun(few.f.ctx, HOUR, () => T0 + 2 * HOUR);
  t.true(few.f.did.includes('take gold_ingot x3'));
  t.regex(r.text, /^bartered 3 gold with 1 piglin: 30 gravel; the trip's 3 gold given; back at overworld/);
  const none = await afterSetup({ mobs: [P1] }, GOLD_RESERVE);
  t.deepEqual(barterReady(lookAt(none.f.inv, 1000, { now: none.later }), none.w), {
    cause: 'kit', text: `no gold to barter: ${GOLD_RESERVE} gold ingots, ${GOLD_RESERVE} kept (the netherite's 16, the golden helmet's repairs 5)`
  });
  const r2 = await barterRun(none.f.ctx, HOUR, () => T0 + 2 * HOUR);
  t.like(r2, { untried: true, text: `not setting out: no gold to barter (${GOLD_RESERVE} ingots kept)` });
  t.false(none.f.did.some(d => d.startsWith('portal ')));
});

/** A pocket slot nothing is in. */
const freeSlot = (f: Game) => [...Array(36).keys()].find(i => !f.inv.some(x => x.slot === i))!;

test.serial('the reserve carried (the gold chore smelts into the pockets) is put back before it sets out: down there it carries the trip\'s gold and no more', async (t) => {
  const { w, f, later } = await afterSetup({ mobs: [P1], loot: [{ name: 'soul_sand', count: 8 }] }, 0);
  onlySoulSand(w, f.inv);
  f.inv.push({ slot: freeSlot(f), name: 'gold_ingot', count: GOLD_RESERVE + GOLD.trip });
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.regex(r.text, /^bartered 2 gold with 1 piglin: 16 soul_sand; every barter target met; back at overworld/);
  t.true(f.did.includes(`store gold_ingot x${GOLD_RESERVE}`), f.did.filter(d => /gold/.test(d)).join(' | '));
  t.is(carried(f, 'gold_ingot'), GOLD.trip - 2);
});

test.serial('ingots tossed and lost (burnt, or taken by a piglin off to the side) count against the trip\'s gold: with the reserve along (no room for it in the chests), none of it is given', async (t) => {
  const pigs: Mob[] = [0, 1, 2, 3].map(i => ({ id: 40 + i, name: 'piglin', position: { x: -72.5 + 4 * i, y: 70, z: 252.5 } }));
  const { f, later } = await afterSetup({ mobs: pigs }, 0);
  f.inv.push({ slot: freeSlot(f), name: 'gold_ingot', count: GOLD_RESERVE + 3 });
  const act = f.ctx.act;
  (f.ctx as { act: GoalContext['act'] }).act = async (tool: string, a: Record<string, unknown> = {}) =>
    (tool === 'store-in-chest' && a.item === 'gold_ingot' ? { ok: false, text: 'the chest is full' } : act(tool, a));
  const call = f.ctx.call;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'entity.use') return { result: 'Pass', success: false };
    const r = await call(m, p);
    // (each throw lost: it came down in lava)
    if (m === 'item.toss') f.drops.splice(f.drops.findIndex(d => d.from === 'toss'), 1);
    return r;
  }) as GoalContext['call'];
  const r = await barterRun(f.ctx, HOUR, () => later);
  t.regex(r.text, /^no barter; the trip's 3 gold gone \(0 given, 3 lost\); back at overworld/);
  t.is(f.did.filter(d => d.startsWith('toss ')).length, 3);
  t.is(carried(f, 'gold_ingot'), GOLD_RESERVE);
});

// ------------------------------------------------------------------------------------------------ the targets and the gate

test('the Nether stock: fire resistance 4 (any form, by its contents), soul sand 16, leather 16, obsidian 20, ender pearls 16, quartz 64; carried and stored together', (t) => {
  t.deepEqual({ ...NETHER_STOCK }, { fire_resistance: 4, soul_sand: 16, leather: 16, obsidian: 20, ender_pearl: 16, quartz: 64 });
  t.deepEqual(BARTER_FOR, ['fire_resistance', 'soul_sand', 'leather', 'obsidian', 'ender_pearl']);
  const w = setupWorld();
  w.chestStacks = { [DROPS]: [{ slot: 3, name: 'splash_potion', count: 1, potion: 'fire_resistance' }, { slot: 4, name: 'potion', count: 2, potion: 'water' }] };
  Object.assign(w.chestItems![DROPS], { soul_sand: 10, splash_potion: 1, potion: 2 });
  const items: InventoryItem[] = [...KIT, { slot: 30, name: 'soul_sand', count: 6 }, { slot: 31, name: 'lingering_potion', count: 1, potion: 'long_fire_resistance' }, { slot: 32, name: 'potion', count: 1, potion: 'strength' }];
  const s = lookAt(items, 1000);
  t.is(netherStock('fire_resistance', s, w), 2);
  t.is(netherStock('soul_sand', s, w), 16);
  t.is(netherStock('leather', s, w), 7);
  t.deepEqual(netherShort(s, w, BARTER_FOR).map(x => `${x.kind} ${x.have}/${x.want}`), ['fire_resistance 2/4', 'leather 7/16', 'obsidian 10/20', 'ender_pearl 0/16']);
  // what a build job holds in the chests is not the home's
  w.reserved = { 1: { soul_sand: 10 } } as never;
  t.true(netherStock('soul_sand', s, w) <= 16);
});

test('the stage gate: nothing of the barter before stage 1, before the link or without its own portal; at stage 1 the rung\'s work, ready only while a target is short, gold is over the reserve and the kit is whole; its gates write nothing', (t) => {
  const w = setupWorld();
  const n = netherOf(w);
  n.portal = { x: OWN.x, y: OWN.y, z: OWN.z };
  n.linked = true;
  w.chestItems![ORES].gold_ingot = 60;
  const s = lookAt(KIT, 1000);
  t.false(barterOpen(w), 'stage 0');
  t.is(rung().wants(s, w), 'look: in the nether');
  n.stage = 1;
  n.stageTrips = 2;
  n.cleanTrips = 3;
  t.true(barterOpen(w));
  // (a fresh look: the rung's answer is kept for the look it was asked with)
  t.is(rung().wants(lookAt(KIT, 1000), w), 'barter: in the nether');
  for (const off of [{ linked: false }, { portal: undefined }]) {
    const x = structuredClone(w);
    Object.assign(netherOf(x), off);
    t.false(barterOpen(x));
  }
  // ready: the targets, the gold, the kit, the health
  t.is(barterReady(s, w), null);
  const full = structuredClone(w);
  Object.assign(full.chestItems![DROPS], { leather: 16, ender_pearl: 16, soul_sand: 16 });
  full.chestItems![STONE2].obsidian = 20;
  full.chestStacks = { [DROPS]: [{ slot: 0, name: 'potion', count: 4, potion: 'long_fire_resistance' }] };
  t.deepEqual(barterReady(s, full), { cause: 'stocked', text: 'every barter target met (fire resistance 4/4, soul_sand 16/16, leather 16/16, obsidian 20/20, ender_pearl 16/16)' });
  // (the rung stocked once the quartz work, beside the barter at stage 1, is at its target too)
  full.chestItems![ORES].quartz = 64;
  t.like(rung().declines!(s, full), { cause: 'stocked' });
  const bare = structuredClone(w);
  delete bare.chestItems!['-547,64,2182'].golden_helmet;
  t.deepEqual(barterReady(s, bare), { cause: 'kit', text: 'barter: short of a golden helmet (carried or in the chests)' });
  t.like(barterReady(lookAt(KIT, 1000, { health: 14 }), w), { cause: 'health' });
  t.like(rung().declines!(lookAt(KIT, 3900), w), { cause: 'late' });
  t.is(spareGold(s, w), 60 - GOLD_RESERVE);
  // the gates write nothing, at any hour
  for (const x of [w, full, bare, setupWorld()]) {
    const before = JSON.stringify(x);
    for (const tod of [0, 1000, 3900, 6000, 12_000]) { const look = lookAt(KIT, tod); barterOpen(x); barterReady(look, x); rung().wants(look, x); rung().declines!(look, x); goldWant(look, x); goldGoal.wants(look, x); }
    t.is(JSON.stringify(x), before);
  }
});

test.serial('the barter and the quartz take turns on the rung: a barter that brought loot home gives the next morning to the quartz, though the gold is back', async (t) => {
  const { w, later, f } = await afterSetup({ mobs: [P1] }, GOLD_RESERVE + 2);
  w.work!.next.nether = 0;
  t.regex(await rung(later).run(f.ctx), /^\[barter\] bartered 2 gold with 1 piglin: 8 soul_sand; the trip's 2 gold given; back at overworld .*; back home$/);
  t.like(w.work!.last, { variant: 'barter', gain: 8 });
  // the next morning: the gold chore brought the spare back; both are ready, and the turn is the quartz's
  const next = later + DAY;
  w.idle!.today.day = 8;
  w.chestItems![ORES].gold_ingot = 60;
  const s = lookAt(f.inv, 1000, { now: next });
  t.is(barterReady(s, w), null);
  t.is(rung(next).wants(s, w), 'quartz: in the nether');
});

test('the gold kept from the donations: the barter\'s reserve and a trip\'s worth (53 ingots)', (t) => {
  t.is(GOLD_RESERVE, 21);
  t.is(KEEP.gold_ingot.keep, GOLD_RESERVE + GOLD.trip);
});

// ------------------------------------------------------------------------------------------------ the gold chore

/** The live world at stage 1 with the switch on, every chest looked into, the ores chest holding `raw` raw gold and `ingots` ingots. */
function goldWorld(raw: number, ingots: number): WorldMemory {
  const w = setupWorld();
  const n = netherOf(w);
  n.portal = { x: OWN.x, y: OWN.y, z: OWN.z };
  n.linked = true;
  n.stage = 1;
  w.idle = { today: { day: 7 } as never, days: [] };
  Object.assign(w.chestItems![ORES], { raw_gold: raw, gold_ingot: ingots });
  return w;
}

test('the gold chore: raw gold smelted for bartering while a target is short, up to a trip\'s 32 over the reserve of 21, 64 raw kept, 64 a game day; never in the morning a deep or a Nether trip may still take', (t) => {
  const pm = lookAt(KIT, 6000);
  t.deepEqual(goldWant(pm, goldWorld(990, 41)), { n: 12, text: '12 raw gold to smelt for bartering (41 gold ingots, 21 kept; 0/64 smelted today)' });
  t.like(goldWant(pm, goldWorld(990, 0)), { n: 32 }, 'a trip\'s worth a run');
  t.is(goldWant(pm, goldWorld(990, GOLD_RESERVE + GOLD.trip)), null, 'a trip\'s worth ready');
  t.like(goldWant(pm, goldWorld(GOLD.rawKept + 5, 41)), { n: 5 }, 'the 64 raw kept');
  t.is(goldWant(pm, goldWorld(GOLD.rawKept, 0)), null);
  // the day's 64
  const w = goldWorld(990, 0);
  netherOf(w).barter = { smelted: { day: 7, n: 60 } };
  t.like(goldWant(pm, w), { n: 4 });
  netherOf(w).barter = { smelted: { day: 7, n: 64 } };
  t.is(goldWant(pm, w), null);
  netherOf(w).barter = { smelted: { day: 6, n: 64 } };
  t.like(goldWant(pm, w), { n: 32 }, 'yesterday\'s');
  // the morning is the trips' (a Nether trip's until tod 3800, a deep trip's until 5000), the evening the furnace's too
  t.is(goldWant(lookAt(KIT, 1000), goldWorld(990, 0)), null);
  t.is(goldWant(lookAt(KIT, 3900), goldWorld(990, 0)), null, 'the deep rung may still set out');
  t.is(goldWant(lookAt(KIT, 5000), goldWorld(990, 0)), null);
  t.like(goldWant(lookAt(KIT, 5100), goldWorld(990, 0)), { n: 32 });
  t.like(goldWant(lookAt(KIT, 12_500), goldWorld(990, 0)), { n: 32 });
  // nothing to barter for, the barter not open, the switch off, away from home: none
  const full = goldWorld(990, 0);
  Object.assign(full.chestItems![DROPS], { leather: 16, ender_pearl: 16, soul_sand: 16 });
  full.chestItems![STONE2].obsidian = 20;
  full.chestStacks = { [DROPS]: [{ slot: 0, name: 'potion', count: 4, potion: 'fire_resistance' }] };
  t.is(goldWant(pm, full), null);
  const early = goldWorld(990, 0);
  netherOf(early).stage = 0;
  t.is(goldWant(pm, early), null);
  const off = goldWorld(990, 0);
  netherOf(off).trips = false;
  t.is(goldWant(pm, off), null);
  t.is(goldWant(lookAt(KIT, 6000, { distHome: 40, position: { x: -509, y: 63, z: 2183 } }), goldWorld(990, 0)), null);
  t.is(goldWant(lookAt(KIT, 6000, { slotsUsed: 35 }), goldWorld(990, 0)), null, 'no room for the raw gold and the ingots');
  t.is(goldGoal.priority, 67);
});

test.serial('the gold chore\'s run: the raw gold out of the chests and into the furnace, the ingots out; booked for the game day; the 64 a day held to over two runs', async (t) => {
  const w = goldWorld(990, 0);
  const f = game(w);
  const act = f.ctx.act;
  (f.ctx as { act: GoalContext['act'] }).act = async (tool: string, a: Record<string, unknown> = {}) => {
    if (tool !== 'smelt-item') return act(tool, a);
    const n = Number(a.inputCount);
    const raw = f.inv.find(i => i.slot < 36 && i.name === a.inputItem)!;
    raw.count -= n;
    if (raw.count <= 0) f.inv.splice(f.inv.indexOf(raw), 1);
    const has = f.inv.find(i => i.slot < 36 && i.name === 'gold_ingot');
    if (has) has.count += n;
    else f.inv.push({ slot: [...Array(36).keys()].find(i => !f.inv.some(x => x.slot === i))!, name: 'gold_ingot', count: n });
    f.did.push(`smelt ${a.inputItem} x${n} with ${a.fuelItem}`);
    return { ok: true, text: `Smelted ${n} ${a.inputItem}` };
  };
  const run = async () => goldGoal.run({ ...f.ctx, s: lookAt(f.inv, 6000) });
  t.is(await run(), 'smelted 32 raw_gold into ingots for bartering (32/64 today; 21 ingots and 64 raw gold kept)');
  t.true(f.did.includes('take raw_gold x32'));
  t.true(f.did.includes('smelt raw_gold x32 with oak_log'));
  t.true(f.said.includes('gold: smelted 32 raw_gold into ingots for bartering (32/64 today; 21 ingots and 64 raw gold kept)'));
  t.like(peekNether(w).barter, { smelted: { day: 7, n: 32 } });
  // 32 carried: 11 short of a trip over the reserve; then the day's 64 is met
  t.like(goldWant(lookAt(f.inv, 6000), w), { n: 21 });
  await run();
  t.like(peekNether(w).barter, { smelted: { day: 7, n: 53 } });
  t.is(goldWant(lookAt(f.inv, 6000), w), null, 'a trip\'s worth over the reserve');
  carriedTo(f, 'gold_ingot', 0);
  t.like(goldWant(lookAt(f.inv, 6000), w), { n: 11 }, 'the rest of the day\'s 64');
});
/** Take the carried stack of a kind down to `n`. */
function carriedTo(f: Game, name: string, n: number) {
  const i = f.inv.find(x => x.slot < 36 && x.name === name);
  if (i) i.count = n;
  if (i && n <= 0) f.inv.splice(f.inv.indexOf(i), 1);
}

test('the gold chore and the barter on the brain\'s own list: the chore at 67 (above smelt), and with the switch off (the live world) neither ever wants', (t) => {
  const goals = realGoals();
  const gold = goals.find(g => g.name === 'gold for bartering')!;
  t.is(gold.priority, 67);
  t.true(gold.priority > goals.find(g => g.name === 'smelt')!.priority);
  t.false(gold.cuts!(lookAt(KIT, 6000), liveWorld()));
  for (const tod of [0, 1000, 6000, 12_500]) {
    t.is(gold.wants(lookAt(KIT, tod), liveWorld()), null);
    t.is(rung().wants(lookAt(KIT, tod), liveWorld()), null);
  }
  // (P3a's quartz beside the barter)
  t.deepEqual(NETHER_WORK.map(v => `${v.id} ${v.stage}`), ['setup 0', 'look 0', 'barter 1', 'quartz 1']);
});

test('the barter\'s memory as brain.json may hold it: made whole, the rest let go', (t) => {
  const w = liveWorld();
  w.nether = { trips: true, barter: { held: { day: 3, at: T0, why: 'x'.repeat(400) }, smelted: { day: 'x', n: 5 }, untaken: -2 } } as never;
  const b = netherOf(w).barter!;
  t.deepEqual(Object.keys(b), ['held']);
  t.is(b.held!.why.length, 200);
  const v = liveWorld();
  v.nether = { trips: true, barter: { smelted: { day: 3, n: 10.7 }, untaken: 2 } } as never;
  t.deepEqual(netherOf(v).barter, { smelted: { day: 3, n: 10 }, untaken: 2 });
  const z = liveWorld();
  z.nether = { trips: true, barter: 'nonsense' } as never;
  t.is(netherOf(z).barter, undefined);
});
