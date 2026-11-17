import test from 'ava';
import type { InventoryItem } from '../../src/client/tools.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import {
  DEBRIS, DEBRIS_DEPTH, DEBRIS_POTIONS, DEBRIS_RADIUS, DEBRIS_TRIP, DEBRIS_WAITS, EFFECT_LEAST_S, PICK_LEAST_USES, debrisFault, debrisGround, debrisOpen, debrisPick,
  debrisReady, debrisRun, debrisSurvey, debrisWay, exposedDebrisIn, fireOf, placeBox, potionToDrink, type DebrisView
} from '../../src/client/brain/netherdebris.js';
import { BARTER_WAITS, KNOCK_GAP, LAVA_GAP, overDrop } from '../../src/client/brain/netherbarter.js';
import { scoutRun } from '../../src/client/brain/netherscout.js';
import { FROM_BUILDS, SETUP_WAITS, boxGap, boxOf, walkFrom, zoneBox, type Box } from '../../src/client/brain/nethersetup.js';
import { BEARINGS, NETHER, OVERWORLD, SITES, netherOf, noteSites, peekNether, portalCells, type Bearing, type PortalShape } from '../../src/client/brain/nether.js';
import { LADDER, NETHER_WORK } from '../../src/client/brain/worktasks.js';
import { workGoals } from '../../src/client/brain/work.js';
import { T0, liveWorld, lookAt } from '../helpers/homestead.js';
import { KIT, ROOM_ZONE, game, gridOf, k, netherGround, setupWorld, type Mob } from '../helpers/netherworld.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
SETUP_WAITS.pollMs = 0;
SETUP_WAITS.loadMs = 0;
BARTER_WAITS.pollMs = 0;
DEBRIS_WAITS.pollMs = 0;

/** Its own Nether-side portal where the setup trip builds it in the test Nether (dug into the cliff, along z, its door east at z 267). */
const OWN: PortalShape = { x: -79, y: 70, z: 266, axis: 'z', width: 2, height: 3 };
const OWN_BOX = boxOf(portalCells(OWN));
/** The chests the tests use: the gear chest (the golden helmet; the potions put here), the ores (the quartz), the tools. */
const GEAR = '-547,64,2182';
const ORES = '-547,63,2180';
const TOOLS = '-551,63,2181';
const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });

/** The nether rung's goal on the real ladder, its clock at `now`. */
const rung = (now = T0) => workGoals(() => undefined, LADDER, () => now).find(g => g.name === 'work: nether')!;

type Game = ReturnType<typeof game>;
type Blocks = [Pos, string][];

/** Potions of fire resistance (by their contents) put in the gear chest, by their stacks as the memory has them. */
function stock(w: WorldMemory, potions: string[], name = 'potion') {
  const stacks = potions.map((potion, i) => ({ slot: 40 + i, name, count: 1, potion }));
  w.chestStacks = { ...(w.chestStacks ?? {}), [GEAR]: stacks };
  if (potions.length) w.chestItems![GEAR][name] = potions.length;
  else delete w.chestItems![GEAR][name];
}

/** Every bearing scouted an hour before `when`, along `ways` where given (the scouting declines: nothing is due). */
function scouted(w: WorldMemory, when: number, ways: Partial<Record<Bearing, Pos[]>> = {}) {
  netherOf(w).legs = BEARINGS.map((b, i) => ({ bearing: b.name, at: when - HOUR + i, reach: 96, end: "the leg's 96 walked", way: (ways[b.name] ?? []).map(p => ({ ...p })) }));
}

/**
 * The setup trip run through (its hut built, its portal lit, linked), then stage 2 as four clean trips open it, on
 * game day 7, the quartz at its target, no gold over the barter's reserve and every bearing scouted an hour ago (so
 * the rung's turn is the debris's), `potions` in the gear chest; and a game of the world as it left it, two hours on,
 * with `blocks` put in the Nether and `opts`.
 */
async function afterSetup(blocks: Blocks = FIELD, opts: Parameters<typeof game>[1] = {}, potions = ['long_fire_resistance', 'fire_resistance']) {
  const w = setupWorld();
  const first = game(w);
  await rung().run(first.ctx);
  Object.assign(netherOf(w), { stage: 2, stageTrips: 4, cleanTrips: 4 });
  w.idle = { today: { day: 7 } as never, days: [] };
  w.chestItems![ORES].quartz = 64;
  const later = T0 + 2 * HOUR;
  scouted(w, later);
  stock(w, potions);
  const changed = [...first.changed, ...blocks.map(([p, to]) => ({ dim: NETHER as typeof NETHER, at: p, to, how: 'test' }))];
  const f = game(w, { items: first.inv, after: { changed, lit: first.lit }, now: later, ...opts });
  return { w, first, later, f };
}

const netherWalks = (f: Game) => f.walks.filter(x => x.dim === NETHER);
const carried = (f: Game, n: string) => f.inv.filter(i => i.slot < 36 && i.name === n).reduce((a, i) => a + i.count, 0);
const potionsCarried = (f: Game) => f.inv.filter(i => i.slot < 36 && i.name === 'potion').map(i => i.potion).sort();
/** What the trip dug down there (the setup's own excepted). */
const dugHere = (f: Game, first: Game) => f.changed.filter(c => c.dim === NETHER && !first.changed.some(o => k(o.at) === k(c.at))).map(c => `${k(c.at)} ${c.to}`);
/** A hook for the fake's looks: `then` once the trip's did shows `after`, the look it first does. */
const once = (get: () => Game | undefined, after: RegExp, then: (f: Game) => void) => {
  let done = false;
  return () => { const f = get(); if (!done && f && f.did.some(d => after.test(d))) { done = true; then(f); } };
};

/**
 * The test Nether's debris round its portal (the cliff west of x -77 is netherrack, the floor is y 69, the community's
 * room's zone at x -63..-48, z 278..292; its own hut at x -79..-76, z 265..268 with its door east at z 267):
 * - three it may mine, each with a face open to air: two in the cliff's face (one at the feet's height, one at the
 *   head's), one in the floor;
 * - and six it may not: one buried in the cliff, one with lava a block behind it, one 26 from its portal, one under
 *   gravel, one 7 from the community's room, one in its own hut's wall.
 */
const GOOD: Pos[] = [at(-77, 70, 255), at(-77, 71, 258), at(-72, 69, 252)];
const BAD: Record<string, Pos> = {
  buried: at(-80, 72, 250), lava: at(-77, 71, 245), far: at(-77, 71, 240), gravel: at(-77, 73, 250), community: at(-68, 69, 272), hut: at(-78, 71, 265)
};
const FIELD: Blocks = [
  ...GOOD.map((p): [Pos, string] => [p, DEBRIS]), ...Object.values(BAD).map((p): [Pos, string] => [p, DEBRIS]),
  [at(-78, 71, 245), 'lava'], [at(-77, 74, 250), 'gravel']
];

/** Every walk down there careful, 16 from the community's room, none by lava within 2, each within 24 of its portal or of one of `ways`' cells. */
function walkedKindly(t: { true: (v: boolean, m?: string) => void }, f: Game, ways: Pos[] = []) {
  for (const x of netherWalks(f)) {
    t.true(x.careful, k(x.to));
    t.true(boxGap(zoneBox(ROOM_ZONE), cellBox(x.to)) >= FROM_BUILDS, `${k(x.to)} by the room`);
    t.true(boxGap(OWN_BOX, cellBox(x.to)) <= DEBRIS_RADIUS || ways.some(w => boxGap(cellBox(w), cellBox(x.to)) <= DEBRIS_RADIUS + 8), `${k(x.to)} off its ground`);
    for (let dx = -LAVA_GAP; dx <= LAVA_GAP; dx++) for (let dz = -LAVA_GAP; dz <= LAVA_GAP; dz++) for (let dy = -1; dy <= 1; dy++) {
      t.true(!/^lava/.test(f.get(NETHER, { x: x.to.x + dx, y: x.to.y + dy, z: x.to.z + dz })), `${k(x.to)} by lava`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ a trip end to end

test.serial('a debris trip: through to its own hut, a potion of fire resistance drunk there (the long one first), the debris with a face open to air dug by its own hand with the diamond pickaxe in hand, picked up; back through its own portal; said as `nether: mined N ancient debris: M picked up`; a clean trip', async (t) => {
  const { w, first, later, f } = await afterSetup();
  t.is(rung(later).wants(lookAt(f.inv, 1000, { now: later }), w), 'debris: in the nether');
  const text = await rung(later).run(f.ctx);
  t.is(text, '[debris] mined 3 ancient debris: 3 picked up; no more ancient debris it may mine within 24 of its portal; back at overworld (-562, 65, 2191); back home');
  t.deepEqual(f.said.filter(l => /^(nether|debris): /.test(l)), [
    'nether: through the portal at overworld (-562, 63, 2191) -> nether (-79, 70, 267)',
    'debris: drank a potion of long_fire_resistance at its portal at nether (-79, 70, 266): 8:00 of fire resistance',
    'nether: mined 3 ancient debris: 3 picked up'
  ]);
  // the drink before any dig, in its hut; the three good ones dug and nothing else, each with the diamond pickaxe in hand
  const drank = f.did.indexOf('drink potion of long_fire_resistance');
  t.true(drank >= 0 && drank < f.did.findIndex(d => d.startsWith('dig ')));
  t.deepEqual(dugHere(f, first).sort(), GOOD.map(p => `${k(p)} air`).sort());
  t.deepEqual(f.dugWith.sort(), GOOD.map(p => `${DEBRIS} ${k(p)} with diamond_pickaxe`).sort());
  t.false(f.did.some(d => d.startsWith('place ')));
  // every walk careful, within 24 of its portal, 16 from the community's room, none by lava within 2
  t.true(netherWalks(f).length > 3);
  walkedKindly(t, f);
  // home with the debris and the plain potion (the second, for the Guardian's hook: the chest had two)
  t.is(carried(f, DEBRIS), 3);
  t.deepEqual(potionsCarried(f), ['fire_resistance']);
  t.deepEqual(f.chests.get(GEAR)!.filter(st => st.name === 'potion'), []);
  t.false(f.drops.some(d => d.item === DEBRIS), 'every drop picked up');
  t.like(peekNether(w), { stageTrips: 5, linked: true, lastTrip: { end: 'clean' } });
  t.is(f.state.dim, OVERWORLD);
  t.is(w.work?.last?.gain, 3);
});

test.serial('at most 4 a trip: a cliff face of six, 4 dug and the trip ends there', async (t) => {
  const face: Blocks = [254, 256, 258, 260, 252, 250].map((z): [Pos, string] => [at(-77, 70, z), DEBRIS]);
  const { f, first, later } = await afterSetup(face);
  const r = await debrisRun(f.ctx, HOUR, () => later);
  t.is(r.text, `mined ${DEBRIS_TRIP} ancient debris: ${DEBRIS_TRIP} picked up; the trip's ${DEBRIS_TRIP} debris mined; back at overworld (-562, 65, 2191)`);
  t.is(dugHere(f, first).length, DEBRIS_TRIP);
  t.like(r, { gain: DEBRIS_TRIP, worked: true, cameBack: true });
});

test.serial('lava within 2 of it: refused, and with nothing it may mine no potion is drunk: home as it came, the trip turned back (its trip of the day given back), a dry mark as for a place found empty', async (t) => {
  const { w, first, later, f } = await afterSetup([[BAD.lava, DEBRIS], [at(-78, 71, 245), 'lava'], [BAD.buried, DEBRIS]]);
  const text = await rung(later).run(f.ctx);
  t.is(text, '[debris] no ancient debris mined; no ancient debris it may mine within 24 of its portal (1 lava or fire within 2, 1 no face open to air), and none known by a scouted way; back at overworld (-562, 65, 2191); back home');
  t.deepEqual(dugHere(f, first), []);
  t.false(f.did.some(d => d.startsWith('drink ')), 'no potion drunk for nothing');
  t.deepEqual(potionsCarried(f), ['fire_resistance', 'long_fire_resistance']);
  const n = peekNether(w);
  t.like(n, { stageTrips: 4, lastTrip: { end: 'turned back' } });
  t.is(n.tripsToday, undefined);
  t.like(w.work!.dry['nether:debris'], { n: 1, at: later });
});

test.serial('only with the effect on it: a potion that does not take leaves every debris where it is (the mark as for a danger); the effect run low after the first stops the digging', async (t) => {
  const a = await afterSetup(FIELD, { drinkFails: true });
  const r = await debrisRun(a.f.ctx, HOUR, () => a.later);
  t.is(r.text, 'no ancient debris mined; the potion of fire resistance did not take (not drunk); back at overworld (-562, 65, 2191)');
  t.deepEqual(dugHere(a.f, a.first), []);
  t.like(r, { gain: 0, mark: 'same', cameBack: true });
  t.false('worked' in r);

  // the effect at 10 s once the first is dug: no dig with less than 20 s of it
  let b: Game | undefined;
  const low = once(() => b, /^dig ancient_debris/, f => { f.state.fire = 10; });
  const x = await afterSetup(FIELD, { onLook: low });
  b = x.f;
  const r2 = await debrisRun(x.f.ctx, HOUR, () => x.later);
  t.true(10 < EFFECT_LEAST_S);
  t.is(r2.text, 'mined 1 ancient debris: 1 picked up; the fire resistance running out (10 s left); back at overworld (-562, 65, 2191)');
  t.is(dugHere(x.f, x.first).length, 1);
  t.like(r2, { worked: true });
});

test.serial('the pickaxe: none but iron carried, a diamond one taken from the chests and held for each dig; with none at all it does not set out (untried)', async (t) => {
  const iron = (items: InventoryItem[]) => items.map(i => (i.name === 'diamond_pickaxe' ? { ...i, name: 'iron_pickaxe' } : i));
  const a = await afterSetup([[GOOD[0], DEBRIS]]);
  a.f.inv.splice(0, a.f.inv.length, ...iron(a.f.inv));
  a.w.chestItems![TOOLS].diamond_pickaxe = 1;
  a.f.chests.get(TOOLS)!.push({ name: 'diamond_pickaxe', count: 1 });
  const r = await debrisRun(a.f.ctx, HOUR, () => a.later);
  t.is(r.text, 'mined 1 ancient debris: 1 picked up; no more ancient debris it may mine within 24 of its portal; back at overworld (-562, 65, 2191)');
  t.true(a.f.did.includes('take diamond_pickaxe x1'));
  t.deepEqual(a.f.dugWith, [`${DEBRIS} ${k(GOOD[0])} with diamond_pickaxe`]);

  const b = await afterSetup([[GOOD[0], DEBRIS]]);
  b.f.inv.splice(0, b.f.inv.length, ...iron(b.f.inv));
  const r2 = await debrisRun(b.f.ctx, HOUR, () => b.later);
  t.deepEqual(r2, { gain: 0, text: 'not setting out: no diamond or netherite pickaxe (ancient debris drops nothing to any other)', untried: true });
  t.is(b.f.state.dim, OVERWORLD);
  t.deepEqual(netherWalks(b.f), []);
});

test.serial('a ghast about its hut (behind its wall, within 32): no potion drunk for a trip it may cut short, home with both, the mark as for a danger, the trip turned back; one come in sight once it has drunk and gone out: back at once', async (t) => {
  const near: Mob = { id: 31, name: 'ghast', position: { x: -72.5, y: 74, z: 262.5 } };
  const { w, later, f } = await afterSetup(FIELD, { mobs: [near] });
  const text = await rung(later).run(f.ctx);
  t.is(text, '[debris] no ancient debris mined; a ghast about (8 off): no potion drunk for a trip it may cut short; back at overworld (-562, 65, 2191); back home');
  t.deepEqual(f.did.filter(d => d.startsWith('drink ') || d.startsWith('dig ')), []);
  t.deepEqual(potionsCarried(f), ['fire_resistance', 'long_fire_resistance']);
  t.like(peekNether(w), { stageTrips: 4, lastTrip: { end: 'turned back' } });
  t.like(w.work!.dry['nether:debris'], { n: 1, at: later });

  // drunk with no ghast about, then one come in sight as it goes out to the first: back with nothing mined
  let g: Game | undefined;
  const come = once(() => g, /^drink /, x => { x.mobs.push({ ...near }); });
  const b = await afterSetup(FIELD, { onLook: come });
  g = b.f;
  const r = await debrisRun(b.f.ctx, HOUR, () => b.later);
  t.regex(r.text, /^no ancient debris mined; a ghast in sight \(\d+ off\); back at overworld \(-562, 65, 2191\)$/);
  t.deepEqual(b.f.did.filter(d => d.startsWith('dig ')), []);
  t.like(r, { gain: 0, mark: 'same' });
});

test.serial('a piglin turned aggressive by its hut: back at once, and the barter, the quartz, the scouting and the debris held for the day', async (t) => {
  let g: Game | undefined;
  const turn = once(() => g, /^dig ancient_debris/, f => { f.mobs.push({ id: 41, name: 'piglin', position: { x: -72.5, y: 70, z: 256.5 }, aggressive: true }); });
  const { w, later, f } = await afterSetup(FIELD, { onLook: turn });
  g = f;
  const r = await debrisRun(f.ctx, HOUR, () => later);
  // (back at once: the debris it had just dug left where it fell)
  t.is(r.text, 'mined 1 ancient debris: 0 picked up; a piglin turned aggressive at nether (-73, 70, 256), the barter, the quartz, the scouting and the debris held for the day; back at overworld (-562, 65, 2191)');
  t.true(f.said.includes('nether: mined 1 ancient debris: nothing picked up'));
  t.true(f.said.includes('nether: a piglin turned aggressive at nether (-73, 70, 256): back to its portal, the barter, the quartz, the scouting and the debris held for the day'));
  t.deepEqual(debrisReady(lookAt(f.inv, 1000, { now: later + MINUTE }), w), { cause: 'hold', text: 'debris held for the day: a piglin turned aggressive at nether (-73, 70, 256)' });
});

// ------------------------------------------------------------------------------------------------ by a known way

/** The north leg's way as a scouting leg keeps it: from its hut's front room, a waypoint every 8 cells walked, north along x -76 to 96 out. */
const NORTH: Pos[] = [at(-77, 70, 267), ...Array.from({ length: 12 }, (_, i) => at(-76, 70, 259 - 8 * i))];
/** An ancient debris in the cliff's face by the way, 47 from its portal (past the read round it), a block from the waypoint at z 219. */
const BY_WAY = at(-77, 71, 219);

test.serial('by a known way: nothing round its portal, a debris a scouting leg saw by its way: the potion drunk at its portal, out along the waypoints (every walk by the rules), the debris mined, the site let go, back along the cells it walked and through its own portal', async (t) => {
  const { w, first, later, f } = await afterSetup([[BY_WAY, DEBRIS]]);
  scouted(w, later, { north: NORTH });
  noteSites(w, [{ kind: DEBRIS, ...BY_WAY, leg: 'north' }], later - HOUR);
  const dw = debrisWay(w, OWN_BOX);
  t.like(dw, { bearing: 'north', to: 6, site: BY_WAY, blocks: 48 });
  const text = await rung(later).run(f.ctx);
  t.is(text, "[debris] mined 1 ancient debris: 1 picked up; no more ancient debris it may mine within 24 of the north way's waypoint; back at overworld (-562, 65, 2191); back home");
  t.deepEqual(f.said.filter(l => /^(nether|debris): /.test(l)), [
    'nether: through the portal at overworld (-562, 63, 2191) -> nether (-79, 70, 267)',
    'debris: drank a potion of long_fire_resistance at its portal at nether (-79, 70, 266): 8:00 of fire resistance',
    'debris: out along the north way (48 blocks) to nether (-76, 70, 219) for the ancient debris at nether (-77, 71, 219)',
    'nether: mined 1 ancient debris: 1 picked up'
  ]);
  t.deepEqual(dugHere(f, first), [`${k(BY_WAY)} air`]);
  t.false(f.did.some(d => d.startsWith('place ')));
  walkedKindly(t, f, NORTH);
  // out to the waypoint by it, and back the same way to its hut's front room
  const walks = netherWalks(f).map(x => x.to);
  t.true(walks.some(p => k(p) === k(NORTH[6])));
  t.true(walks.every(p => p.z >= 219 - DEBRIS_RADIUS));
  t.deepEqual(walks.at(-1), NORTH[0]);
  // the site mined out: let go
  t.false(peekNether(w).sites.some(s => s.kind === DEBRIS));
  t.like(peekNether(w), { stageTrips: 5, lastTrip: { end: 'clean' } });
  t.is(carried(f, DEBRIS), 1);
});

test.serial('by a known way: too far for the time left, it is not gone to (and with nothing round its portal, no potion is drunk); refused on a fresh look out there, the site is let go', async (t) => {
  // (a debris by the way's last waypoint, 96 blocks of way: there and back at 750 ms a block, a dig and the 45 s kept
  // for the way back are 209 s, and the trip has 3 min)
  const end = at(-77, 71, 172);
  const a = await afterSetup([[end, DEBRIS]]);
  scouted(a.w, a.later, { north: NORTH });
  noteSites(a.w, [{ kind: DEBRIS, ...end, leg: 'north' }], a.later - HOUR);
  t.like(debrisWay(a.w, OWN_BOX), { to: 12, blocks: 96 });
  const r = await debrisRun(a.f.ctx, 3 * MINUTE, () => a.later);
  t.is(r.text, 'no ancient debris mined; no ancient debris it may mine within 24 of its portal; the ancient debris by the north way at nether (-77, 71, 172) too far for the time left; back at overworld (-562, 65, 2191)');
  t.false(a.f.did.some(d => d.startsWith('drink ')));
  t.true(peekNether(a.w).sites.some(s => s.kind === DEBRIS), 'kept for a trip with the time');

  // lava come by it since the scouting saw it: out there, refused, and the site let go
  const b = await afterSetup([[BY_WAY, DEBRIS], [at(-78, 72, 219), 'lava']]);
  scouted(b.w, b.later, { north: NORTH });
  noteSites(b.w, [{ kind: DEBRIS, ...BY_WAY, leg: 'north' }], b.later - HOUR);
  const r2 = await debrisRun(b.f.ctx, HOUR, () => b.later);
  t.is(r2.text, "no ancient debris mined; no ancient debris it may mine within 24 of the north way's waypoint (1 lava or fire within 2); back at overworld (-562, 65, 2191)");
  t.deepEqual(dugHere(b.f, b.first), []);
  t.false(peekNether(b.w).sites.some(s => s.kind === DEBRIS));
  t.deepEqual(netherWalks(b.f).at(-1)?.to, NORTH[0]);
});

test.serial('the scouting notes the debris it reads with a face open to air by its way (not one buried, by lava, or within 24 of its portal), and the next debris trip goes out to it by that way', async (t) => {
  const seen = at(-77, 70, 211);
  const blocks: Blocks = [[seen, DEBRIS], [at(-80, 72, 215), DEBRIS], [at(-77, 71, 230), DEBRIS], [at(-78, 71, 230), 'lava'], [GOOD[1], DEBRIS]];
  const { w, first, later, f } = await afterSetup(blocks);
  // (the north due: never scouted)
  netherOf(w).legs = netherOf(w).legs!.filter(l => l.bearing !== 'north');
  const r = await scoutRun(f.ctx, HOUR, () => later);
  t.is(r.text, "scouted 96 to the north: 1 ancient debris with a face open (the nearest at nether (-77, 70, 211)); the leg's 96 walked; back at overworld (-562, 65, 2191)");
  const n = peekNether(w);
  t.deepEqual(n.sites.filter(s => s.kind === DEBRIS).map(s => `${k(s)} ${s.leg}`), [`${k(seen)} north`]);
  t.deepEqual(dugHere(f, first), []);

  // the debris trip after it: the one round its portal first, then out by the north way to the one the leg saw
  const g = game(w, { items: f.inv, after: { changed: [...first.changed, ...blocks.map(([p, to]) => ({ dim: NETHER as typeof NETHER, at: p, to, how: 'test' }))], lit: first.lit }, now: later + HOUR });
  stock(w, ['fire_resistance']);
  const r2 = await debrisRun(g.ctx, HOUR, () => later + HOUR);
  t.regex(r2.text, /^mined 2 ancient debris: 2 picked up; no more ancient debris it may mine within 24 of its portal; no more ancient debris it may mine within 24 of the north way's waypoint; back at overworld \(-562, 65, 2191\)$/);
  t.deepEqual(g.dugWith.map(d => d.split(' ')[1]).sort(), [k(GOOD[1]), k(seen)].sort());
  t.false(peekNether(w).sites.some(s => s.kind === DEBRIS));
});

test.serial('P3b: a known way closed since the leg walked it (lava come across it): out there once, the potion drunk for it, and every debris site of that leg let go (another leg\'s kept); the next trip drinks none for it', async (t) => {
  const channel: Blocks = Array.from({ length: 27 }, (_, i): [Pos, string] => [at(-76 + i, 69, 236), 'lava']);
  const blocks: Blocks = [[BY_WAY, DEBRIS], ...channel];
  const { w, first, later, f } = await afterSetup(blocks, {}, ['long_fire_resistance', 'fire_resistance', 'fire_resistance', 'fire_resistance']);
  scouted(w, later, { north: NORTH });
  noteSites(w, [{ kind: DEBRIS, ...BY_WAY, leg: 'north' }, { kind: DEBRIS, x: -77, y: 71, z: 199, leg: 'north' }, { kind: DEBRIS, x: -40, y: 70, z: 230, leg: 'east' }], later - HOUR);
  const stockOf = (x: Game) => potionsCarried(x).length + (w.chestStacks?.[GEAR] ?? []).filter(st => st.potion).reduce((a, st) => a + st.count, 0);
  const r = await debrisRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'no ancient debris mined; the north way closed by nether (-76, 70, 235); back at overworld (-562, 65, 2191)');
  t.deepEqual(f.did.filter(d => d.startsWith('drink ')), ['drink potion of long_fire_resistance']);
  t.deepEqual(peekNether(w).sites.filter(s => s.kind === DEBRIS).map(s => s.leg), ['east']);
  t.is(stockOf(f), 3);
  // the next trip: nothing round its portal, and no debris known by a scouted way it could go to: no potion drunk
  const g = game(w, { items: f.inv, after: { changed: [...first.changed, ...blocks.map(([p, to]) => ({ dim: NETHER as typeof NETHER, at: p, to, how: 'test' }))], lit: first.lit }, now: later + HOUR });
  const r2 = await debrisRun(g.ctx, HOUR, () => later + HOUR);
  t.is(r2.text, 'no ancient debris mined; no ancient debris it may mine within 24 of its portal, and none known by a scouted way; back at overworld (-562, 65, 2191)');
  t.false(g.did.some(d => d.startsWith('drink ')));
  t.is(stockOf(g), 3, 'one potion for the two trips');
});

test.serial('P3b: by a known way, out of the time for the rest of it (the way there, a dig and the way back from there): back from where it is before its time is gone, the site kept, the mark as for a danger', async (t) => {
  // (20 s a look at the clock, 4 minutes for the trip: the walk out takes looks the time it set out with did not foresee)
  let clock = T0 + 2 * HOUR;
  const { w, later, f } = await afterSetup([[BY_WAY, DEBRIS]], { onLook: () => { clock += 20_000; } });
  scouted(w, later, { north: NORTH });
  noteSites(w, [{ kind: DEBRIS, ...BY_WAY, leg: 'north' }], later - HOUR);
  const r = await debrisRun(f.ctx, 4 * MINUTE, () => clock);
  t.is(r.text, "no ancient debris mined; the debris trip's time is up on the north way; back at overworld (-562, 65, 2191)");
  t.like(r, { gain: 0, mark: 'same', cameBack: true });
  t.false('worked' in r);
  t.true(f.did.includes('drink potion of long_fire_resistance'));
  t.false(netherWalks(f).some(x => x.to.z <= NORTH[6].z + 8), 'turned back short of the waypoint');
  t.deepEqual(netherWalks(f).at(-1)?.to, NORTH[0]);
  t.true(peekNether(w).sites.some(s => s.kind === DEBRIS && s.leg === 'north'));
  t.true(clock - later <= 4 * MINUTE);
});

/** A trench 6 deep at x `x` from z `z1` to `z2`. */
const trench = (x: number, z1: number, z2: number): Blocks => {
  const out: Blocks = [];
  for (let z = z1; z <= z2; z++) for (let y = 64; y <= 69; y++) out.push([at(x, y, z), 'air']);
  return out;
};
/** Of `cells`, those within KNOCK_GAP of a drop's edge on the ground as the game has it. */
const knockEdges = (f: Game, cells: Pos[]) => {
  const g = gridOf(p => f.get(NETHER, p), { x1: -100, y1: 55, z1: 160, x2: -50, y2: 95, z2: 280 });
  return cells.filter(p => overDrop(g, p, KNOCK_GAP)).map(k);
};
/** The cell the bot stood on as it dug at `p`. */
const dugFrom = (f: Game, p: Pos): Pos | undefined => {
  const c = f.changed.find(x => x.dim === NETHER && k(x.at) === k(p) && x.how.startsWith('dug from '));
  if (!c) return undefined;
  const [x, y, z] = /\((-?\d+), (-?\d+), (-?\d+)\)/.exec(c.how)!.slice(1).map(Number);
  return { x, y, z };
};

test.serial('P3b: by a known way, 2 from every drop\'s edge wherever the ground lets it (its way back is the cells walked out, walked blind): round a trench beside the way out; a ghast come about once it has dug out there (behind the cliff: watched): the walk back to the waypoint keeps from the edge of a trench there, and so does the way home', async (t) => {
  const site = at(-66, 69, 211);
  const ghast: Mob = { id: 31, name: 'ghast', position: { x: -95.5, y: 80, z: 212.5 } };
  let g: Game | undefined;
  let came = -1;
  const { w, later, f } = await afterSetup([[site, DEBRIS], ...trench(-74, 246, 248), ...trench(-71, 209, 213)], {
    onLook: () => { if (g && came < 0 && g.did.some(d => /^dig ancient_debris/.test(d))) { g.mobs.push({ ...ghast }); came = netherWalks(g).length; } }
  });
  g = f;
  scouted(w, later, { north: NORTH });
  noteSites(w, [{ kind: DEBRIS, ...site, leg: 'north' }], later - HOUR);
  const r = await debrisRun(f.ctx, HOUR, () => later);
  t.is(r.text, "mined 1 ancient debris: 1 picked up; no more ancient debris it may mine within 24 of the north way's waypoint; back at overworld (-562, 65, 2191)");
  t.true(came > 0);
  const walks = netherWalks(f).map(x => x.to);
  const there = walks.findIndex(p => k(p) === k(NORTH[7]));
  t.true(there > 0);
  t.deepEqual(knockEdges(f, walks.slice(0, there + 1)), [], 'the way out');
  t.deepEqual(knockEdges(f, walks.slice(came)), [], 'with the ghast about');
  // (round the trench by the way out, and the way home the same)
  t.true(walks.slice(0, there).some(p => p.x > -73 && p.z >= 244 && p.z <= 250));
  t.deepEqual(walks.at(-1), NORTH[0]);
});

test.serial('P3b: by a known way, a ghast watched (come once it has drunk) with the way on only by a drop\'s edge (a ledge by a chasm across the floor): back as from a danger, the site kept (the ghast closed the way, not the ground), the mark as for a danger; with none about it goes along the ledge', async (t) => {
  const ledge: Blocks = [];
  for (let x = -74; x <= -40; x++) for (let z = 250; z <= 255; z++) for (let y = 64; y <= 69; y++) ledge.push([at(x, y, z), 'air']);
  const blocks: Blocks = [[BY_WAY, DEBRIS], ...ledge];
  let g: Game | undefined;
  const a = await afterSetup(blocks, { onLook: once(() => g, /^drink /, x => { x.mobs.push({ id: 31, name: 'ghast', position: { x: -55.5, y: 82, z: 252.5 } }); }) });
  g = a.f;
  scouted(a.w, a.later, { north: NORTH });
  noteSites(a.w, [{ kind: DEBRIS, ...BY_WAY, leg: 'north' }], a.later - HOUR);
  const r = await debrisRun(a.f.ctx, HOUR, () => a.later);
  t.is(r.text, "no ancient debris mined; a ghast about (24 off): the north way on only by a drop's edge; back at overworld (-562, 65, 2191)");
  t.like(r, { gain: 0, mark: 'same', cameBack: true });
  t.true(peekNether(a.w).sites.some(s => s.kind === DEBRIS && s.leg === 'north'));
  t.deepEqual(knockEdges(a.f, netherWalks(a.f).map(x => x.to)), []);
  const b = await afterSetup(blocks);
  scouted(b.w, b.later, { north: NORTH });
  noteSites(b.w, [{ kind: DEBRIS, ...BY_WAY, leg: 'north' }], b.later - HOUR);
  const r2 = await debrisRun(b.f.ctx, HOUR, () => b.later);
  t.regex(r2.text, /^mined 1 ancient debris: 1 picked up; /);
});

test.serial('P3b: a ghast watched with the debris only from a drop\'s edge (a trench 2 off the cliff\'s face): back as from a danger (the ghast keeps it off, not the ground), the mark as for a danger: by its hut on arrival (no potion drunk), or come once it has drunk; with none about it mines it', async (t) => {
  const blocks: Blocks = [[GOOD[0], DEBRIS], ...trench(-74, 250, 260)];
  const behind: Mob = { id: 31, name: 'ghast', position: { x: -92.5, y: 74, z: 262.5 } };
  const a = await afterSetup(blocks, { mobs: [behind] });
  const r = await debrisRun(a.f.ctx, HOUR, () => a.later);
  t.is(r.text, "no ancient debris mined; a ghast about (17 off): the ancient debris only from a drop's edge; back at overworld (-562, 65, 2191)");
  t.like(r, { gain: 0, mark: 'same', cameBack: true });
  t.false(a.f.did.some(d => d.startsWith('drink ')));
  let g: Game | undefined;
  const b = await afterSetup(blocks, { onLook: once(() => g, /^drink /, x => { x.mobs.push({ ...behind }); }) });
  g = b.f;
  const r2 = await debrisRun(b.f.ctx, HOUR, () => b.later);
  t.regex(r2.text, /^no ancient debris mined; a ghast about \(\d+ off\): the ancient debris only from a drop's edge; back at overworld \(-562, 65, 2191\)$/);
  t.like(r2, { gain: 0, mark: 'same' });
  t.deepEqual(dugHere(b.f, b.first), []);
  const c = await afterSetup(blocks);
  const r3 = await debrisRun(c.f.ctx, HOUR, () => c.later);
  t.regex(r3.text, /^mined 1 ancient debris: 1 picked up; /);
});

test.serial('P3b: a ghast come about as it steps onto the place it would dig from, at a drop\'s edge: no dig from there, a place off the edge first', async (t) => {
  const blocks: Blocks = [[GOOD[0], DEBRIS], ...trench(-73, 250, 260)];
  // with none about, the place it digs from (the fewest steps) is at the trench's 2
  const calm = await afterSetup(blocks);
  await debrisRun(calm.f.ctx, HOUR, () => calm.later);
  const edge = dugFrom(calm.f, GOOD[0])!;
  t.deepEqual(knockEdges(calm.f, [edge]), [k(edge)]);
  // the ghast comes as the walk there arrives (no leg after it, so no look on the way saw it)
  const { f, later } = await afterSetup(blocks);
  const call = f.ctx.call;
  let came = false;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    const r = await call(m, p);
    if (m === 'goto' && f.state.dim === NETHER && !came && k(p as unknown as Pos) === k(edge)) { came = true; f.mobs.push({ id: 31, name: 'ghast', position: { x: -92.5, y: 74, z: 258.5 } }); }
    return r;
  }) as GoalContext['call'];
  const r = await debrisRun(f.ctx, HOUR, () => later);
  t.true(came);
  t.is(r.text, 'mined 1 ancient debris: 1 picked up; no more ancient debris it may mine within 24 of its portal; back at overworld (-562, 65, 2191)');
  const from = dugFrom(f, GOOD[0])!;
  t.deepEqual(knockEdges(f, [from]), [], `dug from ${k(from)}`);
});

// ------------------------------------------------------------------------------------------------ the gate

test('the debris\'s gate: nothing before stage 2, before the link or without its own portal; with no potion of fire resistance in stock it stays shut and says so (a splash one or another kind none); a diamond or netherite pickaxe; held with the barter for the day; its gates write nothing', (t) => {
  t.deepEqual(NETHER_WORK.map(v => `${v.id} ${v.stage}`), ['setup 0', 'look 0', 'barter 1', 'quartz 1', 'scout 2', 'debris 2', 'fortress 3', 'tunnel 3']);
  const w = setupWorld();
  const n = netherOf(w);
  Object.assign(n, { portal: { x: OWN.x, y: OWN.y, z: OWN.z }, linked: true, stage: 1, stageTrips: 2, cleanTrips: 3 });
  w.chestItems![ORES].quartz = 64;
  scouted(w, T0);
  stock(w, ['fire_resistance']);
  const s = lookAt(KIT, 1000);
  t.false(debrisOpen(w), 'stage 1');
  t.false(String(rung().wants(s, w)).startsWith('debris'));
  n.stage = 2;
  t.true(debrisOpen(w));
  t.is(rung().wants(lookAt(KIT, 1000), w), 'debris: in the nether');
  for (const off of [{ linked: false }, { portal: undefined }]) {
    const x = structuredClone(w);
    Object.assign(netherOf(x), off);
    t.false(debrisOpen(x));
  }
  const switchedOff = structuredClone(w);
  netherOf(switchedOff).trips = false;
  t.is(rung().wants(s, switchedOff), null);
  t.is(debrisReady(s, w), null);
  // no potion: shut, and it says so; a splash potion carried, a potion of swiftness stored: still none to drink
  const none = structuredClone(w);
  stock(none, []);
  const shut = { cause: 'kit', text: 'debris shut: no potion of fire resistance in stock (carried or in the chests)' };
  t.deepEqual(debrisReady(s, none), shut);
  t.deepEqual(debrisReady(lookAt([...KIT, { slot: 30, name: 'splash_potion', count: 1, potion: 'fire_resistance' }], 1000), none), shut);
  const swift = structuredClone(w);
  stock(swift, ['swiftness']);
  t.deepEqual(debrisReady(s, swift), shut);
  t.is(rung().wants(s, none), null);
  // one carried will do
  t.is(debrisReady(lookAt([...KIT, { slot: 30, name: 'potion', count: 1, potion: 'long_fire_resistance' }], 1000), none), null);
  // the pickaxe: only iron carried and none stored
  const irons = KIT.map(i => (i.name === 'diamond_pickaxe' ? { ...i, name: 'iron_pickaxe' } : i));
  t.deepEqual(debrisReady(lookAt(irons, 1000), w), { cause: 'kit', text: 'debris: no diamond or netherite pickaxe (carried or in the chests): ancient debris drops nothing to any other' });
  const tools = structuredClone(w);
  tools.chestItems![TOOLS].netherite_pickaxe = 1;
  t.is(debrisReady(lookAt(irons, 1000), tools), null);
  t.like(debrisReady(lookAt(KIT, 1000, { health: 14 }), w), { cause: 'health', text: 'health 14, food 20 (the debris needs 16 and 10)' });
  const bare = structuredClone(w);
  delete bare.chestItems![GEAR].golden_helmet;
  t.deepEqual(debrisReady(s, bare), { cause: 'kit', text: 'debris: short of a golden helmet (carried or in the chests)' });
  const held = structuredClone(w);
  held.idle = { today: { day: 7 } as never, days: [] };
  netherOf(held).barter = { held: { day: 7, at: T0 - MINUTE, why: 'a piglin turned aggressive at nether (-70, 70, 255)' } };
  t.deepEqual(debrisReady(s, held), { cause: 'hold', text: 'debris held for the day: a piglin turned aggressive at nether (-70, 70, 255)' });
  t.like(rung().declines!(lookAt(KIT, 3900), w), { cause: 'late' });
  // the gates write nothing, at any hour
  for (const x of [w, none, swift, tools, bare, held, switchedOff, setupWorld(), liveWorld()]) {
    const before = JSON.stringify(x);
    for (const tod of [0, 1000, 3900, 6000, 12_000]) { const look = lookAt(KIT, tod); debrisOpen(x); debrisReady(look, x); debrisWay(x, OWN_BOX); rung().wants(look, x); rung().declines!(look, x); }
    t.is(JSON.stringify(x), before);
  }
});

test('with the switch off (the live world) the debris never wants, at any hour', (t) => {
  for (const tod of [0, 1000, 6000, 12_500]) t.is(rung().wants(lookAt(KIT, tod), liveWorld()), null);
  t.false(debrisOpen(liveWorld()));
});

// ------------------------------------------------------------------------------------------------ the rules, pure

test('which debris it may mine: a face open to air, no lava within 2, within 24 of the place, none of its hut\'s, 16 from the zones, 2 from a placed block, none under gravel, no floor over a hole, none more than 4 under the floor', (t) => {
  const base = netherGround();
  const extra = new Map<string, string>([...FIELD.map(([p, b]): [string, string] => [k(p), b]),
    [k(at(-74, 69, 262)), DEBRIS], [k(at(-73, 70, 262)), 'cobblestone'],
    [k(at(-74, 69, 247)), DEBRIS], [k(at(-74, 68, 247)), 'air'], [k(at(-74, 67, 247)), 'air'], [k(at(-74, 66, 247)), 'air'],
    [k(at(-70, 64, 250)), DEBRIS], [k(at(-70, 65, 250)), 'air'], [k(at(-70, 66, 250)), 'air'], [k(at(-70, 67, 250)), 'air'], [k(at(-70, 68, 250)), 'air'], [k(at(-70, 69, 250)), 'air']
  ]);
  const get = (p: Pos) => extra.get(k(p)) ?? base(p);
  const box = placeBox(OWN_BOX, OWN_BOX.y1 - 1);
  t.deepEqual(box, { x1: -106, y1: 62, z1: 239, x2: -52, y2: 84, z2: 294 });
  const g = gridOf(get, box);
  const v: DebrisView = { centre: OWN_BOX, floor: OWN_BOX.y1 - 1, where: 'its portal', portal: OWN_BOX, zones: [zoneBox(ROOM_ZONE)], placed: [at(-73, 70, 262)] };
  for (const p of GOOD) t.is(debrisFault(g, p, v), null, k(p));
  t.is(debrisFault(g, BAD.buried, v), 'no face open to air');
  t.is(debrisFault(g, BAD.lava, v), `lava or fire within ${LAVA_GAP}`);
  t.is(debrisFault(g, BAD.far, v), `more than ${DEBRIS_RADIUS} from its portal`);
  t.is(debrisFault(g, BAD.gravel, v), 'under a block that falls');
  t.is(debrisFault(g, BAD.community, v), `within ${FROM_BUILDS} of someone's build`);
  t.is(debrisFault(g, BAD.hut, v), "its own hut's, or the ground its portal stands on");
  t.is(debrisFault(g, at(-74, 69, 262), v), 'within 2 of a block someone placed');
  t.is(debrisFault(g, at(-74, 69, 247), v), 'a floor over a hole');
  t.is(debrisFault(g, at(-70, 64, 250), v), `more than ${DEBRIS_DEPTH} under the floor of its portal`);
  t.is(debrisFault(g, at(-75, 71, 255), v), 'no ancient debris');
  const survey = debrisSurvey(g, v);
  t.deepEqual(survey.ores.map(k).sort(), GOOD.map(k).sort());
  t.is(survey.faults.get('no face open to air'), 1);
  // what the ground alone lets it mine (the scouting's note): the place's own rules aside (the hut's one is buried in
  // this read, no hut dug; the far one by the read's edge, the ground round it not all read)
  t.deepEqual(exposedDebrisIn(g).map(k).sort(), [...GOOD, BAD.community, at(-70, 64, 250)].map(k).sort());
  // the ground it walks: within 24, 16 from the room, no lava by it, at no drop's edge, no floor more than 4 down
  const ground = debrisGround(g, v);
  t.true(ground.may(at(-76, 70, 255)));
  t.false(ground.may(at(-76, 70, 240)), '26 from its portal');
  t.false(ground.may(at(-76, 70, 246)), 'by the lava');
  t.false(ground.may(at(-66, 70, 272)), 'by the room');
  t.false(ground.may(at(-70, 65, 250)), 'down the shaft');
  t.true(walkFrom(g, [at(-76, 70, 262)], ground.may).has(k(at(-76, 70, 256))));
});

test('the potions and the pickaxe: the longest potion of fire resistance drunk first (by its contents: a splash one or another kind none); the effect as the status says it; netherite before diamond, a worn one not taken', (t) => {
  const items: InventoryItem[] = [
    { slot: 3, name: 'splash_potion', count: 1, potion: 'long_fire_resistance' }, { slot: 4, name: 'potion', count: 1, potion: 'swiftness' },
    { slot: 5, name: 'potion', count: 1, potion: 'fire_resistance' }, { slot: 6, name: 'potion', count: 1, potion: 'long_fire_resistance' }
  ];
  t.like(potionToDrink(items), { slot: 6, potion: 'long_fire_resistance' });
  t.like(potionToDrink(items.slice(0, 3)), { slot: 5 });
  t.is(potionToDrink(items.slice(0, 2)), undefined);
  t.is(DEBRIS_POTIONS, 2);
  t.is(fireOf({ effects: [{ name: 'fire_resistance', amplifier: 0, seconds: 95 }] }), 95);
  t.is(fireOf({ effects: [{ name: 'fire_resistance', amplifier: 0, seconds: -1 }] }), Infinity);
  t.is(fireOf({ effects: [{ name: 'speed', amplifier: 1, seconds: 95 }] }), 0);
  t.is(fireOf(undefined), 0);
  const picks: InventoryItem[] = [
    { slot: 0, name: 'iron_pickaxe', count: 1 }, { slot: 1, name: 'diamond_pickaxe', count: 1, damage: 1000, maxDamage: 1561 },
    { slot: 2, name: 'diamond_pickaxe', count: 1, damage: 1555, maxDamage: 1561 }, { slot: 40, name: 'netherite_pickaxe', count: 1 }
  ];
  t.like(debrisPick(picks), { slot: 1 }, 'the offhand one is not carried in the pockets; the worn one has 6 uses left');
  t.true(1561 - 1555 < PICK_LEAST_USES);
  t.like(debrisPick([...picks, { slot: 7, name: 'netherite_pickaxe', count: 1, damage: 10, maxDamage: 2031 }]), { slot: 7 });
  t.is(debrisPick(picks.slice(0, 1)), undefined);
});

test('the known way to a debris site: the leg\'s waypoint nearest it, the shortest way of all; none within 24 of its portal, none of a leg not kept, none further than 24 from every waypoint', (t) => {
  const w = setupWorld();
  Object.assign(netherOf(w), { portal: { x: OWN.x, y: OWN.y, z: OWN.z }, linked: true, stage: 2, stageTrips: 4 });
  const EAST: Pos[] = [at(-77, 70, 267), ...Array.from({ length: 10 }, (_, i) => at(-69 + 8 * i, 70, 268))];
  scouted(w, T0, { north: NORTH, east: EAST });
  t.is(debrisWay(w, OWN_BOX), undefined, 'no debris site');
  noteSites(w, [
    { kind: DEBRIS, ...GOOD[0], leg: 'north' }, { kind: DEBRIS, x: -40, y: 70, z: 150, leg: 'north' }, { kind: DEBRIS, x: -30, y: 70, z: 290, leg: 'south' },
    { kind: 'lava', ...BY_WAY, leg: 'north' }
  ], T0);
  t.is(debrisWay(w, OWN_BOX), undefined, 'round its portal, far off every waypoint, a leg not kept (its way gone), a lake');
  noteSites(w, [{ kind: DEBRIS, ...BY_WAY, leg: 'north' }, { kind: DEBRIS, x: -20, y: 71, z: 262, leg: 'east' }], T0);
  t.like(debrisWay(w, OWN_BOX), { bearing: 'north', to: 6, blocks: 48, site: BY_WAY });
  // nearer by the east way: that one
  noteSites(w, [{ kind: DEBRIS, x: -50, y: 71, z: 262, leg: 'east' }], T0);
  t.like(debrisWay(w, OWN_BOX), { bearing: 'east', to: 3, blocks: 24, site: at(-50, 71, 262) });
});

test('brain.json keeps a debris site with its leg; when the sites are full, lava lakes and biomes go before the debris', (t) => {
  const w = liveWorld();
  w.nether = { trips: true, stage: 2, sites: [{ kind: DEBRIS, x: -77, y: 71, z: 219, at: T0, leg: 'north' }] };
  t.deepEqual(netherOf(w).sites, [{ kind: DEBRIS, x: -77, y: 71, z: 219, at: T0, leg: 'north' }]);
  const lakes = Array.from({ length: SITES }, (_, i) => ({ kind: 'lava', x: 100 + 20 * i, y: 40, z: 0 }));
  noteSites(w, lakes, T0 + 1);
  const sites = peekNether(w).sites;
  t.is(sites.length, SITES);
  t.true(sites.some(s => s.kind === DEBRIS && s.leg === 'north'));
});
