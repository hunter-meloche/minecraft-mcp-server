import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { brainRun, type ClientRuntime, type InventoryItem } from '../../src/client/tools.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import { Brain } from '../../src/client/brain/brain.js';
import {
  BLAZE_WAIT_LOOKS, FIGHT_BOUT, FORTRESS_LEAVE, FORTRESS_STOCK, FORTRESS_WAITS, PLAYER_NEAR, brewingGate, fortressOpen, fortressReady, fortressRun, fortressStop, fortressWant,
  fortressWay, fortressWart, naturalChest, refuseFortress
} from '../../src/client/brain/netherfortress.js';
import { BARTER_WAITS, LAVA_GAP } from '../../src/client/brain/netherbarter.js';
import { FROM_BUILDS, SETUP_WAITS, boxGap, zoneBox, type Box, type NetherZone } from '../../src/client/brain/nethersetup.js';
import { BEARINGS, FORTRESS_TRIP_CAP_MS, NETHER, OVERWORLD, leaveWhy, netherLine, netherOf, netherTick, noteSites, peekNether, stageNeeds, type Bearing, type NetherMemory } from '../../src/client/brain/nether.js';
import { LADDER, NETHER_WORK } from '../../src/client/brain/worktasks.js';
import { workGoals } from '../../src/client/brain/work.js';
import { HOME, T0, lookAt } from '../helpers/homestead.js';
import { ROOM_ZONE, game, gridOf, k, setupWorld, type Mob } from '../helpers/netherworld.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
SETUP_WAITS.pollMs = 0;
SETUP_WAITS.loadMs = 0;
BARTER_WAITS.pollMs = 0;
FORTRESS_WAITS.pollMs = 0;

const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });
const rung = (now = T0) => workGoals(() => undefined, LADDER, () => now).find(g => g.name === 'work: nether')!;
type Game = ReturnType<typeof game>;
type Blocks = [Pos, string][];

// ------------------------------------------------------------------------------------------------ the test fortress

/**
 * A fortress in the test Nether, north-east of its hut (the floor is netherrack at y 69, open air over it): its zone
 * as Foreign makes it (natural, nothing of a player's within 16), a corridor's chest on its nether bricks (walled at
 * its back, roofed), a patch of nether wart on soul sand.
 */
const FORT: NetherZone & { strays: string[] } = { x1: -50, y1: 66, z1: 226, x2: -38, y2: 76, z2: 240, markers: 300, surface: false, natural: 'fortress', sample: 'nether_bricks', strays: [] };
const SITE = at(-44, 71, 233);
const CHEST = at(-42, 70, 236);
const WART = [at(-46, 70, 230), at(-45, 70, 230), at(-44, 70, 230)];
const FORT_BLOCKS: Blocks = [
  ...[-43, -42, -41].flatMap(x => [235, 236, 237].map((z): [Pos, string] => [at(x, 69, z), 'nether_bricks'])),
  ...[-43, -42, -41].map((x): [Pos, string] => [at(x, 70, 237), 'nether_bricks']),
  [at(-42, 73, 236), 'nether_bricks'],
  [CHEST, 'chest'],
  ...WART.flatMap((p): [Pos, string][] => [[at(p.x, 69, p.z), 'soul_sand'], [p, 'nether_wart']])
];
/** The north leg's way, as the scouting keeps it: from its hut's front room north along the cliff, then east toward the fortress (18 from its zone). */
const WAY: Pos[] = [at(-77, 70, 267), at(-76, 70, 259), at(-76, 70, 251), at(-76, 70, 243), at(-72, 70, 237), at(-68, 70, 233)];
const LOOT = [{ name: 'diamond', count: 3 }, { name: 'gold_ingot', count: 5 }, { name: 'nether_wart', count: 4 }];
const BLAZE: Mob = { id: 71, name: 'blaze', position: { x: -40.5, y: 71, z: 233.5 } };

/** The Nether set worn: fire protection on every piece, the golden helmet its helmet (D1), the shield in the off hand. */
const SET: InventoryItem[] = ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'golden_helmet'].map((name, i) => ({ slot: 36 + i, name, count: 1, enchantments: [{ name: 'fire_protection', level: 4 }] }));
const dressed = (items: InventoryItem[]): InventoryItem[] => [...items.filter(i => i.slot < 36 || i.slot === 40), ...SET.map(i => ({ ...i }))];

/** Every bearing scouted an hour before `when` (the scouting declines), the north one along WAY. */
function scouted(w: WorldMemory, when: number) {
  netherOf(w).legs = BEARINGS.map((b, i) => ({ bearing: b.name as Bearing, at: when - HOUR + i, reach: 96, end: "the leg's 96 walked", way: (b.name === 'north' ? WAY : []).map(p => ({ ...p })) }));
}

/**
 * The setup trip run through (its hut built, its portal lit, linked), then stage 3 as six clean trips open it, on game
 * day 7, the quartz at its target, no gold over the barter's reserve, no potion in stock (the debris shut), every
 * bearing scouted an hour ago, the fortress a scouting leg found by the north way; and a game of the world as it left
 * it, two hours on, the Nether set worn, with the fortress (and `blocks`) in the Nether, its zone, the blaze, and `opts`.
 */
async function atStage3(opts: Parameters<typeof game>[1] = {}, blocks: Blocks = []) {
  const w = setupWorld();
  const first = game(w);
  await rung().run(first.ctx);
  Object.assign(netherOf(w), { stage: 3, stageTrips: 6, cleanTrips: 6 });
  w.idle = { today: { day: 7 } as never, days: [] };
  w.chestItems!['-547,63,2180'].quartz = 64;
  const later = T0 + 2 * HOUR;
  scouted(w, later);
  noteSites(w, [{ kind: 'fortress', ...SITE, leg: 'north' }], later - HOUR);
  const changed = [...first.changed, ...[...FORT_BLOCKS, ...blocks].map(([p, to]) => ({ dim: NETHER as typeof NETHER, at: p, to, how: 'test' }))];
  const f = game(w, { items: dressed(first.inv), after: { changed, lit: first.lit }, now: later, zones: [ROOM_ZONE, { ...FORT }], mobs: [{ ...BLAZE, position: { ...BLAZE.position } }], ...opts });
  f.chests.set(k(CHEST), LOOT.map(x => ({ ...x })));
  return { w, first, later, f };
}

const netherWalks = (f: Game) => f.walks.filter(x => x.dim === NETHER);
const carried = (f: Game, n: string) => f.inv.filter(i => i.slot < 36 && i.name === n).reduce((a, i) => a + i.count, 0);
const once = (get: () => Game | undefined, after: RegExp, then: (f: Game) => void) => {
  let done = false;
  return () => { const f = get(); if (!done && f && f.did.some(d => after.test(d))) { done = true; then(f); } };
};

/** Every walk down there careful, 16 from the community's room, none by lava within 2. */
function walkedKindly(t: { true: (v: boolean, m?: string) => void }, f: Game) {
  for (const x of netherWalks(f)) {
    t.true(x.careful, k(x.to));
    t.true(boxGap(zoneBox(ROOM_ZONE), cellBox(x.to)) >= FROM_BUILDS, `${k(x.to)} by the room`);
    for (let dx = -LAVA_GAP; dx <= LAVA_GAP; dx++) for (let dz = -LAVA_GAP; dz <= LAVA_GAP; dz++) for (let dy = -1; dy <= 1; dy++) {
      t.true(!/^lava/.test(f.get(NETHER, { x: x.to.x + dx, y: x.to.y + dy, z: x.to.z + dz })), `${k(x.to)} by lava`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ the stage and the gate

test.serial('the stage gate: the fortress opens at stage 3 with no potion in stock (the bastion would want 2: its own gate\'s); not before stage 3, the link or its own portal', async (t) => {
  t.deepEqual(stageNeeds('fortress'), { stage: 3, potions: 0 });
  t.deepEqual(stageNeeds('bastion'), { stage: 3, potions: 2 });
  t.true(NETHER_WORK.some(v => v.id === 'fortress' && v.stage === 3));
  const { w, later, f } = await atStage3();
  t.true(fortressOpen(w));
  const s = lookAt(f.inv, 1000, { now: later });
  t.is(rung(later).wants(s, w), 'fortress: in the nether', 'no potion in stock: the fortress is the work');
  for (const [what, edit] of [['stage 2', (x: WorldMemory) => { netherOf(x).stage = 2; }], ['not linked', (x: WorldMemory) => { netherOf(x).linked = false; }],
    ['no portal of its own', (x: WorldMemory) => { delete netherOf(x).portal; }]] as const) {
    const c = structuredClone(w);
    edit(c);
    t.false(fortressOpen(c), what);
  }
  // its gates write nothing
  const before = JSON.stringify(w);
  for (const tod of [0, 1000, 3900]) { const look = lookAt(f.inv, tod, { now: later }); fortressOpen(w); fortressReady(look, w); rung(later).wants(look, w); rung(later).declines!(look, w); }
  t.is(JSON.stringify(w), before);
});

test.serial('the fortress choice: only a natural fortress a scouting leg found by its way (a bastion, a build, a fortress with no leg or none within 48 of its way: none), never one refused, the shortest way first', async (t) => {
  const { w, later } = await atStage3();
  t.like(fortressWay(w), { bearing: 'north', to: 5, site: SITE, blocks: 37 });
  const only = (sites: NetherMemory['sites']) => { const c = structuredClone(w); netherOf(c).sites = sites; return fortressWay(c); };
  t.is(only([{ kind: 'bastion', ...SITE, leg: 'north' }]), undefined, 'a bastion is P6\'s');
  t.is(only([{ kind: 'build', ...SITE, leg: 'north' }]), undefined, 'someone\'s build');
  t.is(only([{ kind: 'fortress', ...SITE }]), undefined, 'no leg: no known way');
  t.is(only([{ kind: 'fortress', ...at(20, 71, 160), leg: 'north' }]), undefined, 'more than 48 from the way');
  t.is(only([{ kind: 'fortress', ...SITE, leg: 'east' }]), undefined, 'the east leg has no way kept');
  // two: the shorter way first
  t.like(only([{ kind: 'fortress', ...at(-50, 71, 255), leg: 'north' }, { kind: 'fortress', ...SITE, leg: 'north' }]), { to: 1, site: at(-50, 71, 255), blocks: 8 });
  // refused (a player's block by it, a player seen by it): never chosen again
  const c = structuredClone(w);
  refuseFortress(c, SITE, 'torch within 16 of it', later);
  t.is(fortressWay(c), undefined);
  t.like(fortressReady(lookAt(dressed([]), 1000, { now: later }), c), { cause: 'unneeded', text: 'fortress: no natural fortress known by a scouted way' });
});

test.serial('its ready: off after a death (until the lead switches it back), the barter\'s hold, the rods and the wart wanted, the Nether set whole, the kit', async (t) => {
  const { w, later, f } = await atStage3();
  const s = lookAt(f.inv, 1000, { now: later });
  t.is(fortressReady(s, w), null);
  t.deepEqual(fortressWant(s, w).map(x => `${x.kind} ${x.have}/${x.want}`), ['blaze_rod 0/8', 'nether_wart 0/8']);
  const c = structuredClone(w);
  netherOf(c).fortress = { off: { at: later - MINUTE, why: 'a death on a fortress trip at nether (-44, 70, 233)' } };
  t.deepEqual(fortressReady(s, c), { cause: 'hold', text: 'fortress trips off: a death on a fortress trip at nether (-44, 70, 233) (until the lead switches them back)' });
  // both met: nothing wanted
  const stocked = lookAt([...f.inv, { slot: 30, name: 'blaze_rod', count: FORTRESS_STOCK.blaze_rod }, { slot: 31, name: 'nether_wart', count: FORTRESS_STOCK.nether_wart }], 1000, { now: later });
  t.deepEqual(fortressReady(stocked, w), { cause: 'unneeded', text: 'fortress: 8 blaze rods and 8 nether wart at home' });
  // the Nether set not whole: plain boots worn and none with fire protection anywhere
  const plain = f.inv.map(i => (i.slot === 36 ? { ...i, enchantments: [] } : i));
  t.deepEqual(fortressReady(lookAt(plain, 1000, { now: later }), w), { cause: 'kit', text: 'fortress: the nether set has no boots with fire protection yet (the fortress goes only in it)' });
  t.like(fortressReady(lookAt(f.inv, 1000, { now: later, health: 14 }), w), { cause: 'health' });
  // a piglin turned on it by its hut today: held with the barter
  const h = structuredClone(w);
  netherOf(h).barter = { held: { day: 7, at: later - MINUTE, why: 'a piglin turned aggressive at nether (-73, 70, 256)' } };
  t.deepEqual(fortressReady(s, h), { cause: 'hold', text: 'fortress held for the day: a piglin turned aggressive at nether (-73, 70, 256)' });
});

// ------------------------------------------------------------------------------------------------ the strict rules, pure

test('the strict rules: under 10 health, the wither, any hold; the ghast rule b (within 16 in sight, a fireball coming, a hit) and a hit while a blaze is about is the fight\'s; alight by a blaze is the fight\'s, alight alone is not', (t) => {
  const w = setupWorld();
  Object.assign(netherOf(w), { linked: true, portal: { x: -79, y: 70, z: 266 }, stage: 3 });
  const look = (over: Partial<Parameters<typeof fortressStop>[0]> = {}) => fortressStop({ health: 20, was: 20, ents: [], ...over }, w, T0);
  const e = (name: string, distance: number, extra: Partial<Mob> = {}) => ({ id: distance, name, position: { x: 0, y: 70, z: distance }, distance, ...extra });
  t.is(look(), null);
  t.deepEqual(look({ health: FORTRESS_LEAVE - 1, was: 12 }), { why: 'health 9, under 10' });
  t.is(look({ health: FORTRESS_LEAVE, was: FORTRESS_LEAVE, ents: [e('blaze', 6)] }), null, '10 is not under 10');
  t.deepEqual(look({ effects: [{ name: 'wither', amplifier: 0, seconds: 8 }] }), { why: 'the wither on it' });
  // the ghast rule b: one within 16 that sees it (no ground read: every one that near sees it), one at 20 watched only
  t.deepEqual(look({ ents: [e('ghast', 14)] }), { why: 'a ghast in sight (14 off)' });
  t.is(look({ ents: [e('ghast', 20)] }), null);
  t.deepEqual(look({ ents: [e('fireball', 10)] }), { why: "a ghast's fireball coming at it (10 off)" });
  t.deepEqual(look({ health: 17, was: 20 }), { why: 'a hit taken (health 20 -> 17)' });
  t.is(look({ health: 17, was: 20, ents: [e('blaze', 9)] }), null, 'a blaze about: the hit is the fight\'s');
  t.is(look({ health: 17, was: 20, ents: [e('wither_skeleton', 5)] }), null);
  t.is(look({ onFire: true, ents: [e('blaze', 9)] }), null, 'alight by its fire');
  t.deepEqual(look({ onFire: true }), { why: 'on fire, with no fire resistance on it' });
  t.is(look({ onFire: true, effects: [{ name: 'fire_resistance', amplifier: 0, seconds: 60 }] }), null);
  // the holds: the switch, a death hold, the fortress trips off
  const off = structuredClone(w); netherOf(off).trips = false;
  t.deepEqual(fortressStop({ health: 20, was: 20, ents: [] }, off, T0), { why: 'nether trips are off' });
  const died = structuredClone(w); netherOf(died).deaths = [{ at: T0 - 10 * MINUTE, where: at(0, 70, 0) }];
  t.regex(fortressStop({ health: 20, was: 20, ents: [] }, died, T0)!.why, /^a death in the nether: held until /);
  const fo = structuredClone(w); netherOf(fo).fortress = { off: { at: T0, why: 'switched off by the lead' } };
  t.deepEqual(fortressStop({ health: 20, was: 20, ents: [] }, fo, T0), { why: 'fortress trips off: switched off by the lead' });
  // a piglin turned: back, and the barter held
  t.like(look({ ents: [e('zombified_piglin', 8, { aggressive: true })] }), { angry: true });
});

test('a natural chest: a single one on the fortress\'s nether bricks in its corridor; one on an open bridge, one of a pair, one with a torch by it is someone\'s', (t) => {
  const base = new Map<string, string>(FORT_BLOCKS.map(([p, b]) => [k(p), b]));
  const ground = (over: Blocks = []) => { const m = new Map(base); for (const [p, b] of over) m.set(k(p), b); return (p: Pos) => m.get(k(p)) ?? (p.y <= 69 ? 'netherrack' : 'air'); };
  const box = { x1: -46, y1: 66, z1: 232, x2: -38, y2: 76, z2: 240 };
  t.true(naturalChest(gridOf(ground(), box), CHEST));
  t.false(naturalChest(gridOf(ground([[at(-42, 73, 236), 'air']]), box), CHEST), 'no roof: a bridge');
  t.false(naturalChest(gridOf(ground([[at(-41, 70, 236), 'chest']]), box), CHEST), 'a double chest');
  t.false(naturalChest(gridOf(ground([[at(-41, 71, 236), 'torch']]), box), CHEST), 'a torch by it');
  t.false(naturalChest(gridOf(ground([[at(-42, 69, 236), 'cobblestone']]), box), CHEST), 'on cobblestone');
  t.true(fortressWart(gridOf(ground(), { x1: -47, y1: 68, z1: 229, x2: -43, y2: 71, z2: 231 }), WART[0]));
});

test('the brewing milestone\'s gate (P4\'s, only its gate): open with a blaze rod home, carried or in the chests', (t) => {
  const w = setupWorld();
  t.deepEqual(brewingGate(lookAt([], 1000), w), { cause: 'unneeded', text: 'brewing waits on a blaze rod (the fortress trips bring them)' });
  t.is(brewingGate(lookAt([{ slot: 3, name: 'blaze_rod', count: 1 }], 1000), w), null);
  w.chestItems!['-547,63,2180'].blaze_rod = 2;
  t.is(brewingGate(lookAt([], 1000), w), null);
});

// ------------------------------------------------------------------------------------------------ a trip end to end

test.serial('a fortress trip: out along the scouted way, the blaze fought from where it stands (its rod picked up), the natural chest emptied, a few wart harvested and the soul sand under them dug; back along the way and through its own portal; a clean trip', async (t) => {
  const { w, first, later, f } = await atStage3();
  const text = await rung(later).run(f.ctx);
  t.is(text, '[fortress] fortress at nether (-44, 71, 233): 8 nether_wart, 5 gold_ingot, 3 diamond, 2 soul_sand, 1 blaze_rod (1 foe killed); nothing more it may take by the way in; back at overworld (-562, 65, 2191); back home');
  t.deepEqual(f.said.filter(l => /^(nether|fortress): /.test(l)), [
    'nether: through the portal at overworld (-562, 63, 2191) -> nether (-79, 70, 267)',
    'fortress: out along the north way (37 blocks) to nether (-68, 70, 233) for the fortress at nether (-44, 71, 233)',
    'fortress: killed blaze',
    'nether: fortress at nether (-44, 71, 233): 8 nether_wart, 5 gold_ingot, 3 diamond, 2 soul_sand, 1 blaze_rod (1 foe killed)'
  ]);
  // the fight from the shield (no retreat walk, under 10 the bridge's fight ends), the chest's loot, two wart and the sand under them
  t.true(f.did.includes('fight blaze #71 (min health 10, retreat false)'));
  t.deepEqual(f.chests.get(k(CHEST)), []);
  t.deepEqual(peekNether(w).fortress?.looted, [CHEST]);
  const dug = f.changed.filter(c => c.dim === NETHER && !first.changed.some(o => k(o.at) === k(c.at))).map(c => k(c.at)).sort();
  t.deepEqual(dug, [k(WART[0]), k(WART[1]), k(at(-46, 69, 230)), k(at(-45, 69, 230))].sort());
  t.is(f.get(NETHER, WART[2]), 'nether_wart', 'the rest of the patch left');
  // home with it all, every walk careful, 16 from the room, none by lava
  for (const [n, c] of [['blaze_rod', 1], ['nether_wart', 8], ['soul_sand', 2], ['diamond', 3]] as const) t.is(carried(f, n), c, n);
  t.false(f.did.some(d => d.startsWith('place ') || d.startsWith('drink ')), 'nothing placed, no potion drunk');
  walkedKindly(t, f);
  t.like(peekNether(w), { stageTrips: 7, lastTrip: { end: 'clean' }, fortress: { trip: { from: later, to: later } } });
  t.is(f.state.dim, OVERWORLD);
  // the rods short still, it waited for another blaze a while (looks a pollMs apart)
  t.true(BLAZE_WAIT_LOOKS > 0);
});

test.serial('a wither skeleton in sight within 8 is fought (the bridge\'s fight: the sword, no retreat walk, the fight ends at 10 health), a blaze within 16; one further off is let be', async (t) => {
  const skel: Mob = { id: 72, name: 'wither_skeleton', position: { x: -43.5, y: 70, z: 232.5 } };
  const far: Mob = { id: 73, name: 'blaze', position: { x: -10.5, y: 72, z: 233.5 } };
  const { f, later } = await atStage3({ mobs: [skel, { ...BLAZE, position: { ...BLAZE.position } }, far] });
  const r = await fortressRun(f.ctx, HOUR, () => later);
  t.true(f.did.includes('fight wither_skeleton #72 (min health 10, retreat false)'));
  t.true(f.did.includes('fight blaze #71 (min health 10, retreat false)'));
  t.false(f.did.some(d => d.startsWith('fight blaze #73')), '33 off: not gone after');
  t.regex(r.text, /\(2 foes killed\)/);
  t.true(f.said.includes('fortress: killed wither_skeleton'));
});

test.serial('a blaze that never comes into reach: fought twice for nothing, then let be (the trip goes on to its chest and wart, the wait bounded)', async (t) => {
  const { f, later } = await atStage3({ fightMisses: true });
  const r = await fortressRun(f.ctx, HOUR, () => later);
  t.is(f.did.filter(d => d.startsWith('fight blaze')).length, 2);
  t.regex(r.text, /^fortress at nether \(-44, 71, 233\): 8 nether_wart, 5 gold_ingot, 3 diamond, 2 soul_sand; nothing more it may take by the way in; back at overworld/);
});

test.serial('the strict rules at home: not at full health, or the Nether set not worn: it does not set out (untried)', async (t) => {
  const a = await atStage3();
  a.f.state.health = 18;
  const r = await fortressRun(a.f.ctx, HOUR, () => a.later);
  // (the kit's own check says it first: it reads the bot's health as it is now since Nov 17, pockets.ts look, and asks
  // the same 20; before, it read the run's start and left the hurt to the fortress's rule)
  t.deepEqual(r, { gain: 0, text: 'not setting out: health 18 < 20', untried: true });
  t.is(a.f.state.dim, OVERWORLD);
  const b = await atStage3();
  const plain = b.f.inv.find(i => i.slot === 38)!;
  plain.enchantments = [];
  const r2 = await fortressRun(b.f.ctx, HOUR, () => b.later);
  t.deepEqual(r2, { gain: 0, text: 'not setting out for the fortress: the diamond_chestplate worn is not the nether set\'s', untried: true });
  t.deepEqual(netherWalks(b.f), []);
});

test.serial('under 10 health at the fortress: home at once, from wherever it is; the wither on it: the same', async (t) => {
  let g: Game | undefined;
  const hurt = once(() => g, /^fight blaze/, f => { f.state.health = 8; });
  const a = await atStage3({ onLook: hurt });
  g = a.f;
  const r = await fortressRun(a.f.ctx, HOUR, () => a.later);
  t.regex(r.text, /^fortress at nether \(-44, 71, 233\): 5 gold_ingot, 4 nether_wart, 3 diamond \(1 foe killed\); health 8, under 10; back at overworld \(-562, 65, 2191\)$/);
  t.false(a.f.did.some(d => d.startsWith('dig nether_wart')), 'nothing more after it');
  t.is(a.f.state.dim, OVERWORLD);

  let h: Game | undefined;
  const wither = once(() => h, /^fight blaze/, f => { f.state.wither = true; });
  const b = await atStage3({ onLook: wither });
  h = b.f;
  const r2 = await fortressRun(b.f.ctx, HOUR, () => b.later);
  t.regex(r2.text, /; the wither on it; back at overworld/);
  t.false(b.f.did.some(d => d.startsWith('dig ')));
});

test.serial('at the fortress its own health rule bounds the trip: leave nether\'s 12 waits while the run is under way (down to the Guardian\'s 6), so a fight that takes it to 11 goes on and the run walks back the way it came; after the run, 12 again', async (t) => {
  const a = await atStage3();
  const hurt = (h: number) => leaveWhy({ ...lookAt(a.f.inv, 1000, { now: a.later }), dimension: NETHER, health: h }, a.w);
  const during: (string | null)[] = [];
  const call = a.f.ctx.call.bind(a.f.ctx);
  (a.f.ctx as { call: typeof call }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'fight') { during.push(hurt(11), hurt(5)); a.f.state.health = 11; }
    return call(m, p);
  }) as typeof call;
  const text = await rung(a.later).run(a.f.ctx);
  t.deepEqual(during.slice(0, 2), [null, 'health 5: home from the nether']);
  t.regex(text, /^\[fortress\] fortress at nether \(-44, 71, 233\): .*\(1 foe killed\); .*back at overworld \(-562, 65, 2191\)/);
  t.is(a.f.state.dim, OVERWORLD);
  t.is(hurt(11), 'health 11: home from the nether', 'the run over: 12 again');
});

test.serial('a fight is fought in bouts of 4 s with a look between them: one that times out goes on to the kill (one fight, not two let-be tries); the wither come on it in a bout ends the trip at the look after it', async (t) => {
  t.deepEqual(FIGHT_BOUT, { ms: 4_000, bouts: 5 });
  const skel: Mob = { id: 72, name: 'wither_skeleton', position: { x: -43.5, y: 70, z: 232.5 } };
  /** the fight's first `n` bouts end on the bridge's timeout with no kill (`then` at the first) */
  const bouts = (f: Game, n: number, then?: () => void) => {
    const asked: Record<string, unknown>[] = [];
    const call = f.ctx.call.bind(f.ctx);
    (f.ctx as { call: typeof call }).call = (async (m: string, p?: Record<string, unknown>) => {
      if (m !== 'fight' || p?.target !== '#72') return call(m, p);
      asked.push({ ...p });
      if (asked.length === 1) then?.();
      return asked.length <= n ? { outcome: 'timeout', kills: [] } : call(m, p);
    }) as typeof call;
    return asked;
  };
  const a = await atStage3({ mobs: [skel] });
  const asked = bouts(a.f, 2);
  const r = await fortressRun(a.f.ctx, HOUR, () => a.later);
  t.is(asked.length, 3);
  t.true(asked.every(p => p.timeoutMs === FIGHT_BOUT.ms && p.minHealth === FORTRESS_LEAVE), JSON.stringify(asked));
  t.true(a.f.said.includes('fortress: killed wither_skeleton'));
  t.false(a.f.said.some(l => /wither_skeleton #72 .*let be/.test(l)));
  t.regex(r.text, /\(1 foe killed\)/);

  const b = await atStage3({ mobs: [{ ...skel, position: { ...skel.position } }] });
  const asked2 = bouts(b.f, 5, () => { b.f.state.wither = true; });
  const r2 = await fortressRun(b.f.ctx, HOUR, () => b.later);
  t.is(asked2.length, 1, 'no second bout with the wither on it');
  t.regex(r2.text, /; the wither on it; back at overworld/);
});

test.serial('a way on only by lava within 2: fire resistance would be needed and none is drunk: home, nothing taken past it (the chest, round the lava, still emptied)', async (t) => {
  // lava round the wart patch (nothing of it it may reach but by the lava) and a moat before the chest's corridor (a way
  // round it on the east)
  const lava: Blocks = [...[-48, -47, -43, -42].flatMap(x => [228, 229, 230, 231, 232].map((z): [Pos, string] => [at(x, 69, z), 'lava'])),
    ...[-44, -43, -42, -41, -40].map((x): [Pos, string] => [at(x, 69, 233), 'lava'])];
  const { f, later } = await atStage3({ mobs: [] }, lava);
  const r = await fortressRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'fortress at nether (-44, 71, 233): 5 gold_ingot, 4 nether_wart, 3 diamond; fire resistance would be needed (lava within 2 of the way to the wart at nether (-46, 70, 230)) and none is drunk; back at overworld (-562, 65, 2191)');
  t.false(f.did.some(d => d.startsWith('dig ') || d.startsWith('drink ')), 'no wart dug, no potion drunk');
  t.like(r, { gain: 12, worked: true });
  walkedKindly(t, f);
});

test.serial('courtesy: a fortress with a player\'s block within 16 (the bridge\'s strays) or a player seen within 64: refused for good, nothing taken', async (t) => {
  const a = await atStage3({ zones: [ROOM_ZONE, { ...FORT, strays: ['torch', 'oak_sign'] } as NetherZone] });
  const r = await fortressRun(a.f.ctx, HOUR, () => a.later);
  t.regex(r.text, /^nothing from the fortress at nether \(-44, 71, 233\); the fortress at nether \(-44, 71, 233\) has torch, oak_sign within 16 of it \(a player's\): refused for good, nothing taken; back at overworld/);
  t.false(a.f.did.some(d => d.startsWith('dig ') || d.startsWith('look in -42') || d.startsWith('fight')));
  t.like(peekNether(a.w).fortress?.refused?.[0], { ...SITE, why: 'torch, oak_sign within 16 of it' });
  t.is(fortressWay(a.w), undefined, 'never chosen again');

  const player: Mob = { id: 90, name: 'player', position: { x: -30.5, y: 70, z: 233.5 } };
  t.true(boxGap(zoneBox(FORT), cellBox(at(-31, 70, 233))) <= PLAYER_NEAR);
  const b = await atStage3({ mobs: [player] });
  const r2 = await fortressRun(b.f.ctx, HOUR, () => b.later);
  t.regex(r2.text, /a player seen by the fortress \(nether \(-31, 70, 233\)\): refused for good; back at overworld/);
  t.like(peekNether(b.w).fortress?.refused?.[0], { why: 'a player seen by it at nether (-31, 70, 233)' });
  t.false(b.f.did.some(d => d.startsWith('dig ')));
});

// ------------------------------------------------------------------------------------------------ a death there

test('a death on a fortress trip (between its start and its end) turns the fortress trips off for good, on top of the death ladder; one after it ended, or another trip\'s, does not; brain-status says so', (t) => {
  const w = setupWorld();
  Object.assign(netherOf(w), { linked: true, portal: { x: -79, y: 70, z: 266 }, stage: 3, stageTrips: 6 });
  netherOf(w).fortress = { trip: { from: T0 - 10 * MINUTE, to: T0 - MINUTE } };
  const lines = netherTick(lookAt([], 1000), w, { at: { x: -44, y: 70, z: 233 }, time: T0 - 2 * MINUTE, dimension: NETHER });
  t.deepEqual(lines, [
    'nether: a death at nether (-44, 70, 233): no trips until 17:38',
    'nether: stage 3 -> 2 after the death: 4/6 clean trips to stage 3',
    'nether: a death on a fortress trip: fortress trips off until the lead switches them back'
  ]);
  t.like(peekNether(w).fortress, { off: { at: T0 - 2 * MINUTE, why: 'a death on a fortress trip at nether (-44, 70, 233)' } });
  t.regex(netherLine(w, T0), /; fortress trips off \(a death on a fortress trip at nether \(-44, 70, 233\), 16:38\) until the lead switches them back/);
  // the hour's hold runs out and the stage comes back: the fortress stays off
  Object.assign(netherOf(w), { stage: 3, stageTrips: 6 });
  t.deepEqual(fortressReady(lookAt(dressed([]), 1000, { now: T0 + 2 * HOUR }), w), { cause: 'hold', text: 'fortress trips off: a death on a fortress trip at nether (-44, 70, 233) (until the lead switches them back)' });

  // a death after the trip ended (another trip's): the fortress trips stay on
  const v = setupWorld();
  Object.assign(netherOf(v), { linked: true, portal: { x: -79, y: 70, z: 266 }, stage: 3, stageTrips: 6 });
  netherOf(v).fortress = { trip: { from: T0 - 30 * MINUTE, to: T0 - 20 * MINUTE } };
  t.false(netherTick(lookAt([], 1000), v, { at: { x: -44, y: 70, z: 233 }, time: T0 - 2 * MINUTE, dimension: NETHER }).some(l => /fortress/.test(l)));
  t.is(peekNether(v).fortress?.off, undefined);
});

test('the fortress switch on the brain: the lead turns it back on after a death (or off by hand), said in the log, saved', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fortress-brain-')), 'brain.json');
  const rt = {
    actions: {}, call: async (m: string) => (m === 'inventory' ? { items: [] } : {}),
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...HOME }, block: { ...HOME }, timeOfDay: 1000, hashedSeed: '7', dimension: 'overworld', health: 20, food: 20 }),
    home: () => ({ ...HOME, dimension: 'overworld' }), lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => T0, goals: [], memoryFile: file });
  t.throws(() => brain.setFortressTrips(true, 'the lead'), { message: 'not in a world yet' });
  brain.setEnabled(true);
  await brain.tick();
  brain.setFortressTrips(false, 'the lead');
  t.like(brain.worldMemory()!.nether!.fortress, { off: { at: T0, why: 'switched off by the lead' } });
  t.regex(brain.status(), /nether fortress trips off \(by the lead\)/);
  brain.setFortressTrips(true, 'the lead');
  t.is((brain.worldMemory()!.nether as { fortress?: { off?: unknown } }).fortress?.off, undefined);
  t.regex(brain.status(), /nether fortress trips on \(by the lead\)/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, WorldMemory>;
  t.is((Object.values(saved)[0].nether as { fortress?: { off?: unknown } }).fortress?.off, undefined);
  brain.setEnabled(false);
});

// ------------------------------------------------------------------------------------------------ the fixer's cases

test.serial('a blaze holds off out of reach while it sees the bot (the bridge never walks after one): the trip walks in to it over ground it may walk, within 3 and in sight, and fights it there; one in the air, or with no ground it may walk by it, is let be and said so', async (t) => {
  const a = await atStage3();
  // where the bot stands as it asks for the fight
  const from: Pos[] = [];
  const call = a.f.ctx.call.bind(a.f.ctx);
  (a.f.ctx as { call: typeof call }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'fight') from.push({ ...a.f.state.pos });
    return call(m, p);
  }) as typeof call;
  const r = await fortressRun(a.f.ctx, HOUR, () => a.later);
  t.regex(r.text, /\(1 foe killed\)/);
  // one fight, from within 3 of it (the fake's fight, as the bridge's, kills a blaze only within 3.2), after a walk in
  t.is(from.length, 1);
  t.true(Math.hypot(from[0].x - BLAZE.position.x, from[0].y - BLAZE.position.y, from[0].z - BLAZE.position.z) <= 3, JSON.stringify(from[0]));
  t.true(a.f.did.includes('fight blaze #71 (min health 10, retreat false)'));
  t.is(carried(a.f, 'blaze_rod'), 1);
  walkedKindly(t, a.f);

  // in the air: 5 over the fortress's floor, never walked in to, never fought
  const high: Mob = { id: 75, name: 'blaze', position: { x: -40.5, y: 75, z: 233.5 } };
  const b = await atStage3({ mobs: [high] });
  const r2 = await fortressRun(b.f.ctx, HOUR, () => b.later);
  t.false(b.f.did.some(d => d.startsWith('fight ')));
  t.true(b.f.said.includes('fortress: the blaze #75 at nether (-41, 75, 233) is in the air: let be'));
  t.regex(r2.text, /^fortress at nether \(-44, 71, 233\): 8 nether_wart, 5 gold_ingot, 3 diamond, 2 soul_sand; nothing more it may take by the way in; back at overworld/);

  // on the ground, but lava round it: no cell within 3 of it the trip may walk (lava within 2 of each)
  const ringed: Mob = { id: 74, name: 'blaze', position: { x: -36.5, y: 70, z: 228.5 } };
  const lava: Blocks = [];
  for (let x = -40; x <= -34; x++) for (let z = 225; z <= 231; z++) if (x !== -37 || z !== 228) lava.push([at(x, 69, z), 'lava']);
  const c = await atStage3({ mobs: [ringed] }, lava);
  await fortressRun(c.f.ctx, HOUR, () => c.later);
  t.false(c.f.did.some(d => d.startsWith('fight ')));
  t.true(c.f.said.includes('fortress: the blaze #74 at nether (-37, 70, 228) has no ground it may walk within 3 of it: let be'), c.f.said.join('\n'));
  walkedKindly(t, c.f);
});

test.serial('the foe fought is the one the brain saw in sight, by its id: a nearer wither skeleton out of sight (under the floor) is not the one the bridge goes after', async (t) => {
  const seen: Mob = { id: 72, name: 'wither_skeleton', position: { x: -43.5, y: 70, z: 232.5 } };
  const hidden: Mob = { id: 76, name: 'wither_skeleton', position: { x: -43.5, y: 66, z: 233.5 } };
  const { f, later } = await atStage3({ mobs: [seen, hidden] });
  await fortressRun(f.ctx, HOUR, () => later);
  t.true(f.did.includes('fight wither_skeleton #72 (min health 10, retreat false)'), f.did.filter(d => d.startsWith('fight')).join('\n'));
  t.false(f.did.some(d => d.startsWith('fight wither_skeleton #76')));
  t.true(f.mobs.some(m => m.id === 76), 'the one out of sight let be');
});

test.serial('the fortress zone grows as the bridge scans more of it: the latest answer\'s is the fortress (a stray it now shows refuses it; clean, it is looted); a zone grown past the scouted way\'s last waypoints does not close the way in', async (t) => {
  const grow = (stray: string[]) => {
    let g: Game | undefined;
    const zones: NetherZone[] = [ROOM_ZONE, { ...FORT }];
    const onLook = () => { if (g?.state.dim === NETHER) zones[1] = { ...FORT, x2: FORT.x2 + 1, strays: stray } as NetherZone; };
    return { zones, onLook, set: (f: Game) => { g = f; } };
  };
  const dirty = grow(['torch']);
  const a = await atStage3({ zones: dirty.zones, onLook: dirty.onLook });
  dirty.set(a.f);
  const r = await fortressRun(a.f.ctx, HOUR, () => a.later);
  t.regex(r.text, /has torch within 16 of it \(a player's\): refused for good, nothing taken/);
  t.false(a.f.did.some(d => d.startsWith('dig ') || d.startsWith('look in')));
  t.like(peekNether(a.w).fortress?.refused?.[0], { why: 'torch within 16 of it', box: { x1: -50, x2: -37 } });

  const clean = grow([]);
  const b = await atStage3({ zones: clean.zones, onLook: clean.onLook });
  clean.set(b.f);
  const r2 = await fortressRun(b.f.ctx, HOUR, () => b.later);
  t.regex(r2.text, /^fortress at nether \(-44, 71, 233\): 8 nether_wart, 5 gold_ingot, 3 diamond, 2 soul_sand, 1 blaze_rod/);
  t.deepEqual(b.f.chests.get(k(CHEST)), []);

  // grown west to 8 from the way's last waypoint (the scouting kept 16 from it as it saw it then)
  const wide = { ...FORT, x1: -60 };
  t.true(boxGap(zoneBox(wide), cellBox(WAY[WAY.length - 1])) < FROM_BUILDS);
  const c = await atStage3({ zones: [ROOM_ZONE, wide] });
  const r3 = await fortressRun(c.f.ctx, HOUR, () => c.later);
  t.notRegex(r3.text, /way closed/);
  t.deepEqual(c.f.chests.get(k(CHEST)), []);
});

test.serial('an older jar says no strays of a natural fortress: nothing taken, not refused (it is not known clean), the dry mark kept as it was', async (t) => {
  const { strays: _strays, ...old } = FORT;
  t.deepEqual(_strays, []);
  const a = await atStage3({ zones: [ROOM_ZONE, old] });
  const r = await fortressRun(a.f.ctx, HOUR, () => a.later);
  t.regex(r.text, /the bridge does not say what of a player's stands within 16 of the fortress at nether \(-44, 71, 233\) \(an older jar\): nothing taken; back at overworld/);
  t.like(r, { gain: 0, mark: 'same' });
  t.false(a.f.did.some(d => d.startsWith('dig ') || d.startsWith('look in') || d.startsWith('fight')));
  t.is(peekNether(a.w).fortress?.refused, undefined);
  t.truthy(fortressWay(a.w), 'still chosen once the jar says');
});

test.serial('courtesy at every look: a stray the scan takes in after the first take refuses the fortress then (nothing more taken); the fortress turned no natural one (merged with someone\'s build) is refused too', async (t) => {
  let g: Game | undefined;
  const zones: NetherZone[] = [ROOM_ZONE, { ...FORT }];
  const a = await atStage3({ zones, onLook: () => { if (g?.did.some(d => d.startsWith('look in -42'))) zones[1] = { ...FORT, strays: ['rail'] } as NetherZone; } });
  g = a.f;
  const r = await fortressRun(a.f.ctx, HOUR, () => a.later);
  t.true(a.f.did.some(d => d.startsWith('look in -42')), 'the chest first');
  t.false(a.f.did.some(d => d.startsWith('dig ')), 'no wart after it');
  t.regex(r.text, /the fortress at nether \(-44, 71, 233\) has rail within 16 of it \(a player's\): refused for good, nothing taken; back at overworld/);
  t.like(peekNether(a.w).fortress?.refused?.[0], { ...SITE, why: 'rail within 16 of it' });

  // natural, then no longer (a player's block within 8 of it: Foreign makes it a build): refused for good
  let h: Game | undefined;
  const zones2: NetherZone[] = [ROOM_ZONE, { ...FORT }];
  const built: NetherZone = { ...FORT };
  delete built.natural;
  delete (built as { strays?: string[] }).strays;
  const b = await atStage3({ zones: zones2, onLook: () => { if (h?.did.some(d => d.startsWith('look in -42'))) zones2[1] = { ...built, surface: true }; } });
  h = b.f;
  const r2 = await fortressRun(b.f.ctx, HOUR, () => b.later);
  t.regex(r2.text, /someone's build by the fortress at nether \(-44, 71, 233\) \(the bridge's zone by it is no natural one\): refused for good, nothing taken; back at overworld/);
  t.false(b.f.did.some(d => d.startsWith('dig ')));
  t.like(peekNether(b.w).fortress?.refused?.[0], { why: "someone's build by it" });

  // no natural one by the site when it comes there, a build there instead: refused (the trips do not keep going back)
  const c = await atStage3({ zones: [ROOM_ZONE, { ...built, surface: true }] });
  const r3 = await fortressRun(c.f.ctx, HOUR, () => c.later);
  t.regex(r3.text, /someone's build by the fortress at nether \(-44, 71, 233\)/);
  t.is(fortressWay(c.w), undefined);
  // nothing by the site at all (the scan let go of): not refused
  const d = await atStage3({ zones: [ROOM_ZONE] });
  const r4 = await fortressRun(d.f.ctx, HOUR, () => d.later);
  t.regex(r4.text, /no natural fortress by nether \(-44, 71, 233\) in the bridge's scan/);
  t.truthy(fortressWay(d.w));
});

test.serial('a refusal holds for the fortress\'s extent: a later leg\'s site for the same fortress 20 off is not chosen, and a trip to a fortress within 16 of one refused before (an older entry, by its point) takes nothing', async (t) => {
  const { w, later } = await atStage3();
  const c = structuredClone(w);
  refuseFortress(c, SITE, 'a player seen by it at nether (-31, 70, 233)', later, zoneBox(FORT));
  const other = at(-44, 71, 255);
  t.true(Math.hypot(other.x - SITE.x, other.y - SITE.y, other.z - SITE.z) > 16);
  netherOf(c).sites = [{ kind: 'fortress', ...other, leg: 'north' }];
  t.is(fortressWay(c), undefined, 'the same fortress under another site');

  // an older entry, its point only, 23 from the site: the site is chosen, but the trip sees the fortress within 16 of it
  const a = await atStage3();
  netherOf(a.w).fortress = { refused: [{ ...at(-44, 71, 210), why: 'torch within 16 of it', at: a.later - HOUR }] };
  t.truthy(fortressWay(a.w));
  const r = await fortressRun(a.f.ctx, HOUR, () => a.later);
  t.regex(r.text, /the fortress at nether \(-44, 71, 233\) was refused before by nether \(-44, 71, 210\) \(torch within 16 of it\): nothing taken/);
  t.false(a.f.did.some(d => d.startsWith('dig ') || d.startsWith('look in') || d.startsWith('fight')));
  t.is(fortressWay(a.w), undefined);
});

test.serial('the time bound: out of time on the way out, or at the fortress, it turns back at once and walks home through its own portal', async (t) => {
  // the clock jumps 7.5 min at the first walk down there: the way's rest there and back (some 2 min) no longer fits
  const a = await atStage3();
  let now = a.later;
  const call = a.f.ctx.call.bind(a.f.ctx);
  (a.f.ctx as { call: typeof call }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'goto' && a.f.state.dim === NETHER && now === a.later) now += 7.5 * MINUTE;
    return call(m, p);
  }) as typeof call;
  const r = await fortressRun(a.f.ctx, HOUR, () => now);
  t.regex(r.text, /the fortress trip's time is up on the north way; back at overworld \(-562, 65, 2191\)$/);
  t.false(a.f.did.some(d => d.startsWith('look in') || d.startsWith('dig ')));
  t.is(a.f.state.dim, OVERWORLD);

  // the clock jumps at the chest: nothing more taken, home
  const b = await atStage3({ mobs: [] });
  let now2 = b.later;
  const call2 = b.f.ctx.call.bind(b.f.ctx);
  (b.f.ctx as { call: typeof call2 }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'chest.open') now2 += 8 * MINUTE;
    return call2(m, p);
  }) as typeof call2;
  const r2 = await fortressRun(b.f.ctx, HOUR, () => now2);
  t.regex(r2.text, /^fortress at nether \(-44, 71, 233\): 5 gold_ingot, 4 nether_wart, 3 diamond; the fortress trip's time is up; back at overworld \(-562, 65, 2191\)$/);
  t.false(b.f.did.some(d => d.startsWith('dig ')));
  t.is(b.f.state.dim, OVERWORLD);
});

test.serial('the strict rules at home, the rest: food under 20, or no shield carried: it does not set out (untried)', async (t) => {
  const a = await atStage3();
  a.f.state.food = 19;
  const r = await fortressRun(a.f.ctx, HOUR, () => a.later);
  t.deepEqual(r, { gain: 0, text: 'not setting out for the fortress: food 19 < 20', untried: true });
  t.is(a.f.state.dim, OVERWORLD);
  const b = await atStage3();
  // (none carried and none in the chests: the kit fetches none)
  for (let i = b.f.inv.length - 1; i >= 0; i--) if (b.f.inv[i].name === 'shield') b.f.inv.splice(i, 1);
  for (const [key, list] of b.f.chests) b.f.chests.set(key, list.filter(x => x.name !== 'shield'));
  for (const c of Object.values(b.w.chestItems ?? {})) delete (c as Record<string, number>).shield;
  const r2 = await fortressRun(b.f.ctx, HOUR, () => b.later);
  t.true(r2.untried);
  t.regex(r2.text, /^not setting out/);
  t.regex(r2.text, /shield/);
  t.deepEqual(netherWalks(b.f), []);
});

test('a fortress trip left open (a restart mid-trip wrote no end): a death down there hours on is not the fortress\'s; one inside its cap still is; the first look home after it went in ends it', (t) => {
  const v = setupWorld();
  Object.assign(netherOf(v), { linked: true, portal: { x: -79, y: 70, z: 266 }, stage: 3, stageTrips: 6 });
  netherOf(v).fortress = { trip: { from: T0 - 3 * HOUR } };
  const late = netherTick(lookAt([], 1000, { now: T0 }), v, { at: { x: -70, y: 70, z: 260 }, time: T0 - MINUTE, dimension: NETHER });
  t.false(late.some(l => /fortress/.test(l)), late.join('\n'));
  t.is(peekNether(v).fortress?.off, undefined);
  t.is(peekNether(v).fortress?.trip?.to, T0 - 3 * HOUR + FORTRESS_TRIP_CAP_MS, 'ended at its cap');

  const u = setupWorld();
  Object.assign(netherOf(u), { linked: true, portal: { x: -79, y: 70, z: 266 }, stage: 3, stageTrips: 6 });
  netherOf(u).fortress = { trip: { from: T0 - 20 * MINUTE } };
  const lines = netherTick(lookAt([], 1000, { now: T0 }), u, { at: { x: -44, y: 70, z: 233 }, time: T0 - 2 * MINUTE, dimension: NETHER });
  t.true(lines.includes('nether: a death on a fortress trip: fortress trips off until the lead switches them back'));

  // in the Nether since the trip set out, then a look home: the trip ends there
  const x = setupWorld();
  Object.assign(netherOf(x), { linked: true, portal: { x: -79, y: 70, z: 266 }, stage: 3, stageTrips: 6 });
  netherOf(x).fortress = { trip: { from: T0 - 10 * MINUTE } };
  netherTick({ ...lookAt([], 1000, { now: T0 - 8 * MINUTE }), dimension: NETHER }, x, undefined);
  t.is(peekNether(x).fortress?.trip?.to, undefined, 'down there: still open');
  netherTick(lookAt([], 1000, { now: T0 }), x, undefined);
  t.is(peekNether(x).fortress?.trip?.to, T0);
});

test.serial('cut short down there (leave nether\'s abort: the dusk, under 6 health): the trip stays open on the walk home, and a death on it turns the fortress trips off', async (t) => {
  const ac = new AbortController();
  let g: Game | undefined;
  const a = await atStage3({ onLook: () => { if (g?.did.some(d => d.startsWith('look in -42'))) ac.abort(); } });
  g = a.f;
  (a.f.ctx as { signal: AbortSignal }).signal = ac.signal;
  await t.throwsAsync(() => fortressRun(a.f.ctx, HOUR, () => a.later), { message: 'aborted' });
  t.is(a.f.state.dim, NETHER);
  t.like(peekNether(a.w).fortress?.trip, { from: a.later, to: undefined });
  const lines = netherTick(lookAt([], 1000, { now: a.later + 4 * MINUTE }), a.w, { at: { x: -60, y: 70, z: 250 }, time: a.later + 3 * MINUTE, dimension: NETHER });
  t.true(lines.includes('nether: a death on a fortress trip: fortress trips off until the lead switches them back'), lines.join('\n'));
  t.like(peekNether(a.w).fortress, { off: { why: 'a death on a fortress trip at nether (-60, 70, 250)' } });
});

test.serial('a run cut short at home before its portal (every call of its own refused from then on): the trip\'s end is still written, and a death on the next trip down there is not the fortress\'s', async (t) => {
  const a = await atStage3();
  const ac = new AbortController();
  const refused = () => brainRun.getStore()?.signal.aborted;
  const call = a.f.ctx.call.bind(a.f.ctx);
  const status = a.f.ctx.status.bind(a.f.ctx);
  // (as tools.ts has it: a call in an aborted run rejects)
  (a.f.ctx as { call: typeof call }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (refused()) throw new Error('aborted: the brain gave this job up');
    if (m === 'portal.enter' && a.f.state.dim === OVERWORLD) { ac.abort(); throw new Error('aborted: the brain gave this job up'); }
    return call(m, p);
  }) as typeof call;
  (a.f.ctx as { status: typeof status }).status = async () => { if (refused()) throw new Error('aborted: the brain gave this job up'); return status(); };
  (a.f.ctx as { signal: AbortSignal }).signal = ac.signal;
  await brainRun.run({ signal: ac.signal }, () => fortressRun(a.f.ctx, HOUR, () => a.later)).catch(() => undefined);
  t.is(a.f.state.dim, OVERWORLD);
  t.like(peekNether(a.w).fortress?.trip, { from: a.later, to: a.later });
  // the next trip, a barter's, goes in 10 min on; a death on it
  netherOf(a.w).enteredAt = a.later + 10 * MINUTE;
  netherTick({ ...lookAt([], 1000, { now: a.later + 11 * MINUTE }), dimension: NETHER }, a.w, undefined);
  const lines = netherTick(lookAt([], 1000, { now: a.later + 16 * MINUTE }), a.w, { at: { x: -60, y: 70, z: 250 }, time: a.later + 15 * MINUTE, dimension: NETHER });
  t.false(lines.some(l => /a death on a fortress trip/.test(l)), lines.join('\n'));
  t.is(peekNether(a.w).fortress?.off, undefined);
});

test('a refused fortress as brain.json may hold it: its zone\'s box kept where it is whole, an older entry by its point alone', (t) => {
  const w = setupWorld();
  w.nether = {
    stage: 3, fortress: {
      refused: [{ ...SITE, why: 'torch within 16 of it', at: T0, box: { x1: -50, y1: 66, z1: 226, x2: -38, y2: 76, z2: 240 } }, { x: 1, y: 2, z: 3, why: 'old', at: T0, box: { x1: 'a' } }],
      trip: { from: T0 }
    }
  } as unknown as WorldMemory['nether'];
  t.deepEqual(netherOf(w).fortress, {
    refused: [{ ...SITE, why: 'torch within 16 of it', at: T0, box: { x1: -50, y1: 66, z1: 226, x2: -38, y2: 76, z2: 240 } }, { x: 1, y: 2, z: 3, why: 'old', at: T0 }],
    trip: { from: T0 }
  });
});
