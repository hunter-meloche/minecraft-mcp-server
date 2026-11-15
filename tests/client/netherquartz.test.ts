import test from 'ava';
import type { InventoryItem } from '../../src/client/tools.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import {
  HUT_GAP, ORE, QUARTZ_DEPTH, QUARTZ_RADIUS, QUARTZ_TRIP, QUARTZ_WAITS, digStance, dropReach, quartzFault, quartzGround, quartzOpen, quartzReady, quartzRun, quartzSurvey,
  takesAt, type QuartzView
} from '../../src/client/brain/netherquartz.js';
import { BARTER_WAITS, LAVA_GAP, barterReady, lavaBy, overDrop } from '../../src/client/brain/netherbarter.js';
import { FROM_BUILDS, PLACED_GAP, SETUP_WAITS, boxGap, boxOf, footing, setOpen, walkFrom, zoneBox, type Box } from '../../src/client/brain/nethersetup.js';
import { NETHER, NETHER_STOCK, OVERWORLD, barterHold, netherOf, peekNether, portalCells, type PortalShape } from '../../src/client/brain/nether.js';
import { LADDER, NETHER_WORK } from '../../src/client/brain/worktasks.js';
import { workGoals } from '../../src/client/brain/work.js';
import { T0, liveWorld, lookAt } from '../helpers/homestead.js';
import { KIT, ROOM_ZONE, game, gridOf, k, netherGround, setupWorld, type Mob } from '../helpers/netherworld.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
SETUP_WAITS.pollMs = 0;
SETUP_WAITS.loadMs = 0;
BARTER_WAITS.pollMs = 0;
QUARTZ_WAITS.pollMs = 0;

/** Its own Nether-side portal where the setup trip builds it in the test Nether (dug into the cliff, along z, its door east at z 267). */
const OWN: PortalShape = { x: -79, y: 70, z: 266, axis: 'z', width: 2, height: 3 };
const OWN_BOX = boxOf(portalCells(OWN));
const ORES = '-547,63,2180';
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });
const at = (x: number, y: number, z: number): Pos => ({ x, y, z });

/** The nether rung's goal on the real ladder, its clock at `now`. */
const rung = (now = T0) => workGoals(() => undefined, LADDER, () => now).find(g => g.name === 'work: nether')!;

type Game = ReturnType<typeof game>;
type Blocks = [Pos, string][];

/**
 * The test Nether's quartz (the cliff west of x -77 is netherrack, the floor is y 69, the community's room's zone at x
 * -63..-48, z 278..292; its own hut at x -79..-76, z 265..268 with its door east at z 267):
 * - three it may mine: two in the cliff's face (one at the feet's height, one at the head's), one in the floor;
 * - one it would not, though the ground would let it: high in the cliff's face, 3 over the floor (its quartz would stay
 *   up in the hole);
 * - and seven it may not: one buried in the cliff, one with lava a block behind it, one 26 from its portal, one 7 from
 *   the community's room, one in its own hut's wall (the room's side, open to the room), one under gravel, one by
 *   the cobblestone of its hut's front.
 */
const GOOD: Pos[] = [at(-77, 70, 255), at(-77, 71, 258), at(-72, 69, 252)];
const HIGH = at(-77, 73, 256);
const BAD: Record<string, Pos> = {
  buried: at(-80, 72, 250), lava: at(-77, 71, 245), far: at(-77, 71, 240), community: at(-68, 69, 272), hut: at(-78, 71, 265), gravel: at(-77, 73, 250), cobble: at(-77, 74, 262)
};
const QUARTZ_FIELD: Blocks = [
  ...GOOD.map((p): [Pos, string] => [p, ORE]), [HIGH, ORE], ...Object.values(BAD).map((p): [Pos, string] => [p, ORE]),
  [at(-78, 71, 245), 'lava'], [at(-77, 74, 250), 'gravel'], [at(-76, 73, 262), 'cobblestone']
];

/**
 * The setup trip run through (its hut built, its portal lit, linked), then stage 1 as two clean trips open it (the
 * setup's and the look's), on game day 7, no gold over the barter's reserve (so the rung's turn is the quartz's); and
 * a game of the world as it left it, two hours on, with `blocks` put in the Nether and `opts`.
 */
async function afterSetup(blocks: Blocks = QUARTZ_FIELD, opts: Parameters<typeof game>[1] = {}) {
  const w = setupWorld();
  const first = game(w);
  await rung().run(first.ctx);
  const n = netherOf(w);
  n.stage = 1;
  n.stageTrips = 2;
  n.cleanTrips = 3;
  w.idle = { today: { day: 7 } as never, days: [] };
  const later = T0 + 2 * HOUR;
  const changed = [...first.changed, ...blocks.map(([p, to]) => ({ dim: NETHER as typeof NETHER, at: p, to, how: 'test' }))];
  const f = game(w, { items: first.inv, after: { changed, lit: first.lit }, now: later, ...opts });
  return { w, first, later, f };
}

const netherWalks = (f: Game) => f.walks.filter(x => x.dim === NETHER);
const carried = (f: Game, n: string) => f.inv.filter(i => i.slot < 36 && i.name === n).reduce((a, i) => a + i.count, 0);
/** What the trip dug: the cells it changed down there (the setup's own excepted). */
const dugCells = (f: Game) => f.changed.filter(c => c.dim === NETHER).map(c => `${k(c.at)} ${c.to}`);
/** A hook for the fake's looks: `then` once the trip's did shows `after`, the look it first does. */
const once = (get: () => Game | undefined, after: RegExp, then: (f: Game) => void) => {
  let done = false;
  return () => { const f = get(); if (!done && f && f.did.some(d => after.test(d))) { done = true; then(f); } };
};

// ------------------------------------------------------------------------------------------------ a trip end to end

test.serial('a quartz trip: through to its own hut, out on foot, the ore with a face open to air dug by its own hand from a careful walk, the quartz picked up; back through its own portal; said as `nether: mined N quartz ore: M quartz picked up`', async (t) => {
  const { w, later, f } = await afterSetup();
  // (no gold over the barter's reserve: the rung's turn goes to the quartz)
  t.like(barterReady(lookAt(f.inv, 1000, { now: later }), w), { cause: 'kit' });
  t.is(rung(later).wants(lookAt(f.inv, 1000, { now: later }), w), 'quartz: in the nether');
  const text = await rung(later).run(f.ctx);
  t.is(text, '[quartz] mined 3 quartz ore: 6 quartz; no more quartz ore it may mine within 24 of its portal; back at overworld (-562, 65, 2191); back home');
  t.deepEqual(f.said.filter(l => l.startsWith('nether: ')), ['nether: through the portal at overworld (-562, 63, 2191) -> nether (-79, 70, 267)', 'nether: mined 3 quartz ore: 6 quartz picked up']);
  // the three good ones dug, nothing else: none of the seven it may not, not the one high in the wall, nothing placed
  t.deepEqual(dugCells(f).sort(), GOOD.map(p => `${k(p)} air`).sort());
  t.deepEqual(f.did.filter(d => d.startsWith('dig ')).map(d => d.replace(/ \(.*/, '')), ['dig nether_quartz_ore', 'dig nether_quartz_ore', 'dig nether_quartz_ore']);
  t.false(f.did.some(d => d.startsWith('place ')));
  // every walk careful, within 24 of its portal, 16 from the community's room, none by lava within 2
  t.true(netherWalks(f).length > 3);
  for (const x of netherWalks(f)) {
    t.true(x.careful, k(x.to));
    t.true(boxGap(OWN_BOX, cellBox(x.to)) <= QUARTZ_RADIUS, k(x.to));
    t.true(boxGap(zoneBox(ROOM_ZONE), cellBox(x.to)) >= FROM_BUILDS, k(x.to));
    t.true(Math.max(Math.abs(x.to.x + 78), Math.abs(x.to.z - 245)) > LAVA_GAP, `${k(x.to)} by the lava`);
  }
  // home with the quartz; a clean trip, the third for the stages
  t.is(carried(f, 'quartz'), 6);
  t.false(f.drops.some(d => d.item === 'quartz'), 'every drop picked up');
  t.like(peekNether(w), { stageTrips: 3, linked: true, lastTrip: { end: 'clean' } });
  t.is(f.state.dim, OVERWORLD);
  t.is(w.work?.last?.gain, 6);
});

test.serial('no tunnelling: an ore a dig bares behind another is left in the rock', async (t) => {
  // a vein of three into the cliff from its face: only the first has a face open to air as the Nether left it
  const vein: Blocks = [[at(-77, 71, 253), ORE], [at(-78, 71, 253), ORE], [at(-79, 71, 253), ORE]];
  const { f, later } = await afterSetup(vein);
  const r = await quartzRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'mined 1 quartz ore: 2 quartz; no more quartz ore it may mine within 24 of its portal; back at overworld (-562, 65, 2191)');
  t.deepEqual(dugCells(f), ['-77,71,253 air']);
});

test.serial('at most 32 ore a trip: a floor full of it, 32 dug and the trip ends there', async (t) => {
  const floor: Blocks = [];
  for (let x = -75; x <= -70; x++) for (let z = 246; z <= 252; z++) floor.push([at(x, 69, z), ORE]);
  t.true(floor.length > QUARTZ_TRIP);
  // (one quartz an ore: the target's 64 is not met first)
  const { f } = await afterSetup(floor, { quartz: 1 });
  const r = await quartzRun(f.ctx, HOUR, () => T0 + 2 * HOUR);
  t.is(r.text, `mined ${QUARTZ_TRIP} quartz ore: ${QUARTZ_TRIP} quartz; the trip's ${QUARTZ_TRIP} ore mined; back at overworld (-562, 65, 2191)`);
  t.is(f.did.filter(d => d.startsWith('dig ')).length, QUARTZ_TRIP);
  t.like(r, { gain: QUARTZ_TRIP, cameBack: true });
});

test.serial('the target: it stops once the quartz carried and stored is at 64, and with 64 stored it does not set out', async (t) => {
  const { w, f, later } = await afterSetup();
  w.chestItems![ORES].quartz = 60;
  const r = await quartzRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'mined 2 quartz ore: 4 quartz; quartz at its target (64/64); back at overworld (-562, 65, 2191)');
  t.deepEqual(quartzReady(lookAt(f.inv, 1000, { now: later }), w), { cause: 'stocked', text: 'quartz at its target (64/64)' });
  w.chestItems![ORES].quartz = 64;
  t.deepEqual(quartzReady(lookAt(KIT, 1000, { now: later }), w), { cause: 'stocked', text: 'quartz at its target (64/64)' });
});

test.serial('no ore it may mine round its portal: no quartz, and the line says what the ore it saw fell to, the most first; home again, nothing touched', async (t) => {
  // two buried in the cliff, one with lava behind it
  const { f, later } = await afterSetup([[BAD.buried, ORE], [at(-81, 75, 251), ORE], [BAD.lava, ORE], [at(-78, 71, 245), 'lava']]);
  const r = await quartzRun(f.ctx, HOUR, () => later);
  t.deepEqual(r, { gain: 0, text: 'no quartz mined; no quartz ore it may mine within 24 of its portal (2 no face open to air, 1 lava or fire within 2); back at overworld (-562, 65, 2191)', cameBack: true });
  t.deepEqual(dugCells(f), []);
  t.false(f.said.some(l => l.startsWith('nether: mined')));
});

test.serial('an ore the bridge will not dig (out of sight after all): said once, let be, and the next one dug', async (t) => {
  const { f, later } = await afterSetup();
  const call = f.ctx.call;
  let refuse = 1;
  (f.ctx as { call: typeof call }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'dig.here' && refuse-- > 0) return { dug: false, reason: 'out of reach or out of sight', block: ORE };
    return call(m, p);
  }) as typeof call;
  const r = await quartzRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'mined 2 quartz ore: 4 quartz (1 it could not dig); no more quartz ore it may mine within 24 of its portal; back at overworld (-562, 65, 2191)');
  t.is(f.said.filter(l => l.startsWith('quartz: could not dig the ore at nether (')).length, 1);
  t.regex(f.said.find(l => l.startsWith('quartz: could not dig'))!, /: out of reach or out of sight$/);
});

test.serial('F4: the quartz fetches its kit before it checks it: a golden helmet and a flint and steel not where the chests\' memory has them (a stone chest holds them) are looked for in the chests, the gear chests first, and taken; then it sets out', async (t) => {
  const GEAR2 = '-547,64,2182', STONE5 = '-549,65,2185';
  const w = setupWorld();
  const first = game(w);
  await rung().run(first.ctx);
  Object.assign(netherOf(w), { stage: 1, stageTrips: 2, cleanTrips: 3 });
  w.idle = { today: { day: 7 } as never, days: [] };
  const stone = { ...w.chestItems![STONE5] };
  Object.assign(w.chestItems![STONE5], { golden_helmet: 1, flint_and_steel: 1 });
  const later = T0 + 2 * HOUR;
  const changed = [...first.changed, ...QUARTZ_FIELD.map(([p, to]) => ({ dim: NETHER as typeof NETHER, at: p, to, how: 'test' }))];
  const f = game(w, { items: first.inv.filter(i => i.name !== 'golden_helmet' && i.name !== 'flint_and_steel'), after: { changed, lit: first.lit }, now: later });
  // (the fake's chests are made: the memory has the kit in the gear chest, which holds neither)
  w.chestItems![STONE5] = stone;
  Object.assign(w.chestItems![GEAR2], { golden_helmet: 1, flint_and_steel: 1 });
  const r = await quartzRun(f.ctx, HOUR, () => later);
  t.regex(r.text, /^mined 3 quartz ore: 6 quartz/);
  t.deepEqual(f.did.filter(d => d.startsWith('look in ')), [GEAR2, '-551,63,2181', '-551,63,2183', '-547,63,2182', '-547,63,2184', STONE5].map(c => `look in ${c}`));
  const portal = f.did.findIndex(d => d.startsWith('portal '));
  for (const name of ['golden_helmet', 'flint_and_steel']) t.true(f.did.indexOf(`take ${name} x1`) >= 0 && f.did.indexOf(`take ${name} x1`) < portal, name);
});

// ------------------------------------------------------------------------------------------------ the stop rules

test.serial('a hoglin near stops it: back to its portal and through at once, the quartz it has kept, no hold', async (t) => {
  let g: Game | undefined;
  const { w, f, later } = await afterSetup(QUARTZ_FIELD, {
    onLook: once(() => g, /^picked up/, x => x.mobs.push({ id: 30, name: 'hoglin', position: { x: x.state.pos.x + 6, y: 70, z: x.state.pos.z - 8 } }))
  });
  g = f;
  const r = await quartzRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'mined 1 quartz ore: 2 quartz; a hoglin near (10 off); back at overworld (-562, 65, 2191)');
  t.is(barterHold(w, later), undefined);
  t.is(f.state.dim, OVERWORLD);
});

test.serial('a piglin turned aggressive near it: back to its portal at once, the barter and the quartz held for the rest of the game day', async (t) => {
  let g: Game | undefined;
  const P: Mob = { id: 12, name: 'piglin', position: { x: -70.5, y: 70, z: 258.5 } };
  const { w, f, later } = await afterSetup(QUARTZ_FIELD, { mobs: [P], onLook: once(() => g, /^picked up/, x => { x.mobs.find(m => m.id === 12)!.aggressive = true; }) });
  g = f;
  const r = await quartzRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'mined 1 quartz ore: 2 quartz; a piglin turned aggressive at nether (-71, 70, 258), the barter and the quartz held for the day; back at overworld (-562, 65, 2191)');
  t.true(f.said.includes('nether: a piglin turned aggressive at nether (-71, 70, 258): back to its portal, the barter and the quartz held for the day'), f.said.join(' | '));
  const s = lookAt(f.inv, 1000, { now: later + 10 * MINUTE });
  t.deepEqual(quartzReady(s, w), { cause: 'hold', text: 'quartz held for the day: a piglin turned aggressive at nether (-71, 70, 258)' });
  t.like(barterReady(s, w), { cause: 'hold' });
  // the next game day: free again
  w.idle!.today.day = 8;
  t.is(quartzReady(s, w), null);
});

test.serial('on fire it goes back to its portal, as on a hit', async (t) => {
  let burning = false;
  let g: Game | undefined;
  const { f, later } = await afterSetup(QUARTZ_FIELD, { onLook: once(() => g, /^picked up/, () => { burning = true; }) });
  g = f;
  const status = f.ctx.status;
  (f.ctx as { status: GoalContext['status'] }).status = async () => ({ ...(await status()), ...(burning ? { onFire: true } : {}) });
  const r = await quartzRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'mined 1 quartz ore: 2 quartz; on fire; back at overworld (-562, 65, 2191)');
});

test.serial('a hoglin come near in the middle of a walk out to an ore is seen at the next leg: not a leg more, back to its portal; nothing dug, and the place not marked dry as an empty one is', async (t) => {
  // one ore, some 16 steps from its hut
  const { f, later } = await afterSetup([[at(-77, 70, 248), ORE]]);
  const call = f.ctx.call;
  const seq: string[] = [];
  let legs = 0;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    const r = await call(m, p);
    if (m === 'goto' && f.state.dim === NETHER) {
      seq.push('goto');
      if (++legs === 2) { f.mobs.push({ id: 30, name: 'hoglin', position: { x: f.state.pos.x + 6, y: 70, z: f.state.pos.z } }); seq.push('hoglin'); }
    }
    if (m === 'world.entities') seq.push('look');
    return r;
  }) as GoalContext['call'];
  const r = await quartzRun(f.ctx, HOUR, () => later);
  t.like(r, { gain: 0, text: 'no quartz mined; a hoglin near (6 off); back at overworld (-562, 65, 2191)', mark: 'same', cameBack: true });
  t.is(seq[seq.indexOf('hoglin') + 1], 'look', seq.join(' '));
  t.deepEqual(dugCells(f), []);
});

test.serial('the zones down there are asked once the ground is read: an ore by a build whose chunk came in while it was read is let be; no word of them at all, and it goes straight back', async (t) => {
  const { f, later } = await afterSetup([[BAD.community, ORE]]);
  const call = f.ctx.call;
  let read = false;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'world.region' && f.state.dim === NETHER) read = true;
    // (the bridge's scan reads loaded chunks only: the community's room shows once the ground round the portal is in)
    if (m === 'foreign.zones' && f.state.dim === NETHER) return { dimension: NETHER, zones: read ? [{ ...ROOM_ZONE }] : [] };
    return call(m, p);
  }) as GoalContext['call'];
  const r = await quartzRun(f.ctx, HOUR, () => later);
  t.is(r.text, `no quartz mined; no quartz ore it may mine within 24 of its portal (1 within ${FROM_BUILDS} of someone's build); back at overworld (-562, 65, 2191)`);
  t.deepEqual(dugCells(f), []);
  const none = await afterSetup();
  const call2 = none.f.ctx.call;
  (none.f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'foreign.zones' && none.f.state.dim === NETHER) throw new Error('the bridge timed out');
    return call2(m, p);
  }) as GoalContext['call'];
  const r2 = await quartzRun(none.f.ctx, HOUR, () => none.later);
  t.deepEqual(r2, { gain: 0, text: 'no quartz mined: the bridge did not say where the builds down there are; back at overworld (-562, 65, 2191)', mark: 'same', cameBack: true });
  t.deepEqual(netherWalks(none.f), []);
  t.deepEqual(dugCells(none.f), []);
});

test.serial('the quartz trip\'s time: it stops with what the way back needs left (45 s), and goes home through its own portal', async (t) => {
  const { f } = await afterSetup();
  // (half a minute a look at the clock: the kit, the arrival, then each ore's turn)
  let clock = T0 + 2 * HOUR;
  const r = await quartzRun(f.ctx, 3 * MINUTE, () => (clock += 30_000));
  t.is(r.text, 'mined 2 quartz ore: 4 quartz; the quartz trip\'s time is up; back at overworld (-562, 65, 2191)');
  t.like(r, { cameBack: true });
});

test.serial('a quartz trip whose home portal comes out at someone else\'s: not linked, straight back through it, the setup held a day; nothing dug', async (t) => {
  const { w, f, later } = await afterSetup();
  f.lit.push({ x: -71, y: 70, z: 273, axis: 'x', width: 2, height: 3, dim: NETHER });
  const r = await quartzRun(f.ctx, HOUR, () => later);
  t.deepEqual(r, { gain: 0, text: 'the home portal came out at nether (-71, 70, 273), not at its own: not linked; back at overworld (-562, 65, 2191); setup held a day', cameBack: true });
  t.like(peekNether(w), { linked: false });
  t.deepEqual(netherWalks(f), []);
  t.deepEqual(dugCells(f), []);
});

// ------------------------------------------------------------------------------------------------ the rules, pure

/** The test Nether as the trip reads it, with `blocks` put in, and the view of it from its own portal. */
function readOf(blocks: Blocks): { g: ReturnType<typeof gridOf>; v: QuartzView } {
  const base = netherGround();
  const extra = new Map(blocks.map(([p, b]) => [k(p), b]));
  // its hut as the setup leaves it: the room dug into the cliff, the cobblestone front with its door
  for (let x = -79; x <= -77; x++) for (let y = 70; y <= 72; y++) for (const z of [266, 267]) extra.set(k(at(x, y, z)), x === -79 ? 'nether_portal' : 'air');
  for (const [x, y, z] of [[-76, 70, 266], [-76, 71, 266], [-76, 72, 266], [-76, 72, 267]]) extra.set(k(at(x, y, z)), 'cobblestone');
  const g = gridOf(p => extra.get(k(p)) ?? base(p), { x1: -107, y1: 60, z1: 239, x2: -52, y2: 84, z2: 294 });
  return { g, v: { portal: OWN_BOX, floor: OWN.y - 1, zones: [zoneBox(ROOM_ZONE)], placed: [[-76, 70, 266], [-76, 71, 266], [-76, 72, 266], [-76, 72, 267], [-76, 73, 262]].map(([x, y, z]) => at(x, y, z)) } };
}

test('which ore: within 24 of its portal, not its hut\'s, not more than 4 under the portal\'s floor, 16 from anyone\'s build, 2 from a placed block, no lava within 2, a face open to air, nothing that falls over it, no floor over a hole', (t) => {
  const { g, v } = readOf(QUARTZ_FIELD);
  for (const p of GOOD) t.is(quartzFault(g, p, v), null, k(p));
  t.is(quartzFault(g, BAD.buried, v), 'no face open to air');
  t.is(quartzFault(g, BAD.lava, v), `lava or fire within ${LAVA_GAP}`);
  t.is(quartzFault(g, BAD.far, v), `more than ${QUARTZ_RADIUS} from its portal`);
  t.is(quartzFault(g, BAD.community, v), `within ${FROM_BUILDS} of someone's build`);
  t.is(quartzFault(g, BAD.hut, v), 'its own hut\'s, or the ground its portal stands on');
  t.is(quartzFault(g, BAD.gravel, v), 'under a block that falls');
  t.is(quartzFault(g, BAD.cobble, v), `within ${PLACED_GAP} of a block someone placed`);
  t.is(quartzFault(g, at(-70, 70, 250), v), 'no quartz ore');
  // the lava's 2 every way, diagonals and over and under too; 3 off is none
  for (const [dx, dy, dz] of [[2, 2, 2], [-2, 0, 1], [0, -2, 0]]) {
    const ore = at(-77, 75, 254);
    const r = readOf([[ore, ORE], [at(ore.x - 1, ore.y, ore.z), 'air'], [at(ore.x + dx, ore.y + dy, ore.z + dz), 'lava[level=3]']]);
    t.is(quartzFault(r.g, ore, r.v), `lava or fire within ${LAVA_GAP}`, `${dx},${dy},${dz}`);
  }
  const three = readOf([[at(-77, 75, 254), ORE], [at(-74, 75, 254), 'lava']]);
  t.is(quartzFault(three.g, at(-77, 75, 254), three.v), null);
  // the hut's 4 round its portal, and what is past it
  t.true(boxGap(OWN_BOX, cellBox(BAD.hut)) <= HUT_GAP);
  // a pit in the floor down to y 60, an ore in its wall at each height: down to 4 under the portal's floor (y 69) it
  // may, lower not; and a floor ore over a cave (open under it) not, over the ground it may
  const pit: Blocks = [];
  for (let y = 60; y <= 69; y++) pit.push([at(-70, y, 250), 'air']);
  const deep = readOf([...pit, [at(-71, 65, 250), ORE], [at(-71, 64, 250), ORE]]);
  t.is(quartzFault(deep.g, at(-71, 65, 250), deep.v), null);
  t.is(quartzFault(deep.g, at(-71, 64, 250), deep.v), `more than ${QUARTZ_DEPTH} under its portal's floor`);
  t.is(OWN.y - 1 - QUARTZ_DEPTH, 65);
  const cave = readOf([[at(-72, 69, 248), ORE], [at(-72, 68, 248), 'air'], [at(-72, 67, 248), 'air']]);
  t.is(quartzFault(cave.g, at(-72, 69, 248), cave.v), 'a floor over a hole');
  // the ground there not read (an unloaded chunk): none
  const edge = readOf([]);
  t.is(quartzFault(edge.g, at(-105, 70, 241), { ...edge.v, portal: { ...OWN_BOX, x1: -100, x2: -100 } }), 'no quartz ore');
  const unread = gridOf(p => (p.x === -77 && p.y === 71 && p.z === 230 ? ORE : p.x <= -78 ? 'netherrack' : 'air'), { x1: -78, y1: 69, z1: 229, x2: -76, y2: 73, z2: 231 });
  t.is(quartzFault(unread, at(-77, 71, 230), { ...v, portal: { x1: -79, y1: 70, z1: 236, x2: -79, y2: 72, z2: 237 } }), 'the ground round it not all read');
  // the survey: the four of the field it may, and the rest by why
  const survey = quartzSurvey(g, v);
  t.deepEqual(survey.ores.map(k).sort(), [...GOOD, HIGH].map(k).sort());
  t.is([...survey.faults.values()].reduce((a, b) => a + b, 0), Object.keys(BAD).length);
});

test('where it stands to dig: a cell a walk reaches whose eye sees an open face within 4.4, never on top of the ore; the fewest steps; none for one buried; the ground it walks keeps from lava, drops and the depth', (t) => {
  const { g, v } = readOf(QUARTZ_FIELD);
  const ground = quartzGround(g, v);
  const start = footing(g, { x: -77.5, y: 70, z: 267.5 })!;
  const reach = walkFrom(g, [start], ground.may);
  for (const ore of GOOD) {
    const st = digStance(g, reach, ore);
    t.truthy(st, k(ore));
    const eye = { x: st!.at.x + 0.5, y: st!.at.y + 1.62, z: st!.at.z + 0.5 };
    t.true(Math.hypot(eye.x - ore.x - 0.5, eye.y - ore.y - 0.5, eye.z - ore.z - 0.5) <= 4.4 + 0.5, k(ore));
    t.false(st!.at.x === ore.x && st!.at.z === ore.z && st!.at.y === ore.y + 1, 'not on top of it');
  }
  t.is(digStance(g, reach, BAD.buried), undefined);
  // what each drops: in reach of the ground it walks (the floor's from the pit it leaves), but for the one high in the
  // wall, whose face it sees and reaches all the same
  for (const ore of GOOD) t.true(dropReach(g, reach, ore), k(ore));
  t.truthy(digStance(g, reach, HIGH));
  t.false(dropReach(g, reach, HIGH));
  // two over the floor in front of it, the pickup box takes it; and an ore in a ceiling drops to the floor under it
  const two = readOf([[at(-77, 72, 256), ORE]]);
  t.true(dropReach(two.g, walkFrom(two.g, [start], quartzGround(two.g, two.v).may), at(-77, 72, 256)));
  const roof = readOf([[at(-72, 74, 252), ORE], [at(-72, 75, 252), 'netherrack'], [at(-72, 76, 252), 'netherrack']]);
  t.true(dropReach(roof.g, walkFrom(roof.g, [start], quartzGround(roof.g, roof.v).may), at(-72, 74, 252)));
  // the floor ore: from beside it, not on it, even where on it is the nearest
  const floorOre = digStance(g, reach, at(-72, 69, 252))!;
  t.not(k(floorOre.at), k(at(-72, 70, 252)));
  const onTop = new Map([[k(at(-72, 70, 252)), { from: null, n: 0 }], [k(at(-74, 70, 252)), { from: k(at(-72, 70, 252)), n: 2 }]]);
  t.deepEqual(digStance(g, onTop, at(-72, 69, 252)), { at: at(-74, 70, 252), n: 2 });
  // a wall between: a cliff ore round a corner is dug from where the eye sees its face
  const nook = readOf([[at(-77, 71, 256), ORE], [at(-76, 71, 255), 'netherrack'], [at(-76, 70, 255), 'netherrack']]);
  const nr = walkFrom(nook.g, [start], quartzGround(nook.g, nook.v).may);
  const ns = digStance(nook.g, nr, at(-77, 71, 256))!;
  t.truthy(ns);
  // no cell it walks has lava within 2 or stands at a drop's edge or lower than 4 under the portal's floor, or within
  // 16 of the community's room (which the open floor reaches, the rule let go)
  for (const key of reach.keys()) {
    const [x, y, z] = key.split(',').map(Number);
    if (x === start.x && y === start.y && z === start.z) continue;
    t.true(y - 1 >= OWN.y - 1 - QUARTZ_DEPTH, key);
    t.true(Math.max(Math.abs(x + 78), Math.abs(z - 245)) > LAVA_GAP || Math.abs(y - 71) > 3, `${key} by the lava`);
    t.true(boxGap(OWN_BOX, cellBox({ x, y, z })) <= QUARTZ_RADIUS, key);
    t.true(boxGap(zoneBox(ROOM_ZONE), cellBox({ x, y, z })) >= FROM_BUILDS, key);
  }
  const open = walkFrom(g, [start], quartzGround(g, { ...v, zones: [] }).may);
  t.true([...open.keys()].some(key => { const [x, y, z] = key.split(',').map(Number); return boxGap(zoneBox(ROOM_ZONE), cellBox({ x, y, z })) < FROM_BUILDS; }));
  // a pit 6 deep in the floor within reach (its bottom firm, at y 63): its rim is a drop's edge, never walked
  const pitted = readOf([...QUARTZ_FIELD, ...[64, 65, 66, 67, 68, 69].map((y): [Pos, string] => [at(-70, y, 258), 'air'])]);
  const pr = walkFrom(pitted.g, [start], quartzGround(pitted.g, pitted.v).may);
  for (const key of pr.keys()) {
    const [x, y, z] = key.split(',').map(Number);
    if (x === start.x && y === start.y && z === start.z) continue;
    t.false(overDrop(pitted.g, { x, y, z }), key);
  }
  t.false(pr.has(k(at(-71, 70, 258))), 'the rim');
  t.true(pr.has(k(at(-72, 70, 258))));
  // a pit's floor 9 under the portal's: never stood on
  const pit: Blocks = [];
  for (let y = 61; y <= 69; y++) for (const z of [250, 251]) pit.push([at(-70, y, z), 'air']);
  const deep = readOf(pit);
  t.false(quartzGround(deep.g, deep.v).may(at(-70, 61, 250)));
  t.true(quartzGround(deep.g, deep.v).may(at(-74, 70, 250)));
  // one 7 deep (its floor at y 62, 3 over the read's bottom: nothing unread by it), 5 under the portal's floor: never
  // stood on; one 4 deep (its floor at y 65, 4 under the portal's): stood on
  const below = (top: number) => readOf([...Array(70 - top).keys()].flatMap(i => [250, 251].map((z): [Pos, string] => [at(-70, top + i, z), 'air'])));
  const low = below(63);
  t.false(lavaBy(low.g, at(-70, 63, 250)));
  t.false(quartzGround(low.g, low.v).may(at(-70, 63, 250)));
  const four = below(66);
  t.true(quartzGround(four.g, four.v).may(at(-70, 66, 250)));
});

test('what a dig opens is judged again in every cell over it: a column dug into goes on down, to lava', (t) => {
  // a cell on a pillar at y 80 with, 2 across, a column open from its feet down to an ore at y 72, and under the ore
  // an open hole to lava at y 65 (no rule of the quartz's lets it dig such an ore: the map of the ground goes by what
  // the trip did all the same)
  const ore = at(2, 72, 0);
  const g = gridOf(p => {
    if (p.x === 2 && p.z === 0) return p.y === 72 ? ORE : p.y === 65 ? 'lava' : p.y < 65 ? 'netherrack' : 'air';
    if (p.x === 1 && p.z === 0) return 'netherrack';
    return p.y < 80 ? 'netherrack' : 'air';
  }, { x1: -8, y1: 60, z1: -8, x2: 8, y2: 90, z2: 8 });
  const portal = { x1: -4, y1: 80, z1: 0, x2: -4, y2: 82, z2: 1 };
  const ground = quartzGround(g, { portal, floor: 79, zones: [], placed: [] });
  const cell = at(0, 80, 0);
  t.true(ground.may(cell));
  setOpen(g, ore);
  ground.forget(ore);
  t.false(ground.may(cell));
});

test('what the bot takes up where it stands: the game\'s pickup box (1 across, half a block under its feet, up to its head and more)', (t) => {
  const feet = { x: -75.5, y: 70, z: 255.5 };
  t.true(takesAt(feet, { x: -76.5, y: 70, z: 255.5 }), 'a block across at its feet');
  t.true(takesAt(feet, { x: -76.5, y: 71, z: 255.5 }), 'in a hole at its head');
  t.false(takesAt(feet, { x: -76.5, y: 69, z: 255.5 }), 'down in a pit a block under its feet');
  t.false(takesAt(feet, { x: -77.5, y: 70, z: 255.5 }), 'two across');
  t.false(takesAt(feet, { x: -76.5, y: 73, z: 255.5 }), 'three up');
});

// ------------------------------------------------------------------------------------------------ the gate

test('the quartz\'s gate: nothing before stage 1, before the link or without its own portal; at stage 1 the rung\'s work beside the barter, ready while the quartz is under 64 and the kit is whole; its gates write nothing', (t) => {
  t.deepEqual(NETHER_WORK.map(v => `${v.id} ${v.stage}`), ['setup 0', 'look 0', 'barter 1', 'quartz 1']);
  t.is(NETHER_STOCK.quartz, 64);
  const w = setupWorld();
  const n = netherOf(w);
  n.portal = { x: OWN.x, y: OWN.y, z: OWN.z };
  n.linked = true;
  const s = lookAt(KIT, 1000);
  t.false(quartzOpen(w), 'stage 0');
  t.is(rung().wants(s, w), 'look: in the nether');
  n.stage = 1;
  n.stageTrips = 2;
  n.cleanTrips = 3;
  t.true(quartzOpen(w));
  for (const off of [{ linked: false }, { portal: undefined }]) {
    const x = structuredClone(w);
    Object.assign(netherOf(x), off);
    t.false(quartzOpen(x));
  }
  // (no gold in these chests for the barter: the quartz is the rung's work)
  t.is(quartzReady(s, w), null);
  t.is(rung().wants(lookAt(KIT, 1000), w), 'quartz: in the nether');
  // carried and stored together
  const items: InventoryItem[] = [...KIT, { slot: 30, name: 'quartz', count: 40 }];
  w.chestItems![ORES].quartz = 23;
  t.is(quartzReady(lookAt(items, 1000), w), null);
  w.chestItems![ORES].quartz = 24;
  t.deepEqual(quartzReady(lookAt(items, 1000), w), { cause: 'stocked', text: 'quartz at its target (64/64)' });
  w.chestItems![ORES].quartz = 0;
  const bare = structuredClone(w);
  delete bare.chestItems!['-547,64,2182'].golden_helmet;
  t.deepEqual(quartzReady(s, bare), { cause: 'kit', text: 'quartz: short of a golden helmet (carried or in the chests)' });
  t.like(quartzReady(lookAt(KIT, 1000, { health: 14 }), w), { cause: 'health', text: 'health 14, food 20 (the quartz needs 16 and 10)' });
  t.like(rung().declines!(lookAt(KIT, 3900), w), { cause: 'late' });
  // the gates write nothing, at any hour
  for (const x of [w, bare, setupWorld(), liveWorld()]) {
    const before = JSON.stringify(x);
    for (const tod of [0, 1000, 3900, 6000, 12_000]) { const look = lookAt(KIT, tod); quartzOpen(x); quartzReady(look, x); rung().wants(look, x); rung().declines!(look, x); }
    t.is(JSON.stringify(x), before);
  }
});

test('with the switch off (the live world) the quartz never wants, at any hour', (t) => {
  for (const tod of [0, 1000, 6000, 12_500]) t.is(rung().wants(lookAt(KIT, tod), liveWorld()), null);
  const w: WorldMemory = liveWorld();
  t.false(quartzOpen(w));
});
