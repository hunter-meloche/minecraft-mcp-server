import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ClientRuntime, InventoryItem } from '../../src/client/tools.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import { Brain } from '../../src/client/brain/brain.js';
import {
  BASTION_CROWD, BASTION_LEAVE, BASTION_LOOT, BASTION_WAITS, BRUTE_WAITS, PLAYER_NEAR, bastionChest, bastionGuard, bastionOpen, bastionReady, bastionRun, bastionStop, bastionWant, bastionWay, chestHalf,
  refuseBastion, strengthToDrink, treasureChest
} from '../../src/client/brain/netherbastion.js';
import { FIGHT_BOUT } from '../../src/client/brain/netherfortress.js';
import { BARTER_WAITS, LAVA_GAP } from '../../src/client/brain/netherbarter.js';
import { FROM_BUILDS, SETUP_WAITS, boxGap, zoneBox, type Box, type NetherZone } from '../../src/client/brain/nethersetup.js';
import { BEARINGS, FIRE_POTIONS, NETHER, OVERWORLD, leaveWhy, netherLine, netherOf, netherTick, noteSites, peekNether, stageNeeds, type Bearing } from '../../src/client/brain/nether.js';
import { LADDER, NETHER_WORK } from '../../src/client/brain/worktasks.js';
import { DRY_WAIT, workGoals, workOf } from '../../src/client/brain/work.js';
import { HOME, T0, lookAt } from '../helpers/homestead.js';
import { ROOM_ZONE, game, gridOf, k, setupWorld, type Mob } from '../helpers/netherworld.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
SETUP_WAITS.pollMs = 0;
SETUP_WAITS.loadMs = 0;
BARTER_WAITS.pollMs = 0;
BASTION_WAITS.bruteMs = 0;

const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });
const rung = (now = T0) => workGoals(() => undefined, LADDER, () => now).find(g => g.name === 'work: nether')!;
type Game = ReturnType<typeof game>;
type Blocks = [Pos, string][];

// ------------------------------------------------------------------------------------------------ the test bastion

/**
 * A bastion in the test Nether, north-east of its hut where the fortress tests have their fortress (the floor is
 * netherrack at y 69, open air over it): its zone as Foreign makes it (natural, nothing of a player's within 16), the
 * treasure room's chest on its polished blackstone bricks with a gold block in the floor by it, another chest on
 * blackstone; two piglins about, calm (the golden helmet worn).
 */
const BASTION: NetherZone & { strays: string[] } = { x1: -50, y1: 66, z1: 226, x2: -38, y2: 76, z2: 240, markers: 400, surface: false, natural: 'bastion', sample: 'polished_blackstone_bricks', strays: [] };
const SITE = at(-44, 71, 233);
const TREASURE = at(-42, 70, 236);
const OTHER = at(-46, 70, 230);
const BASTION_BLOCKS: Blocks = [
  [at(-42, 69, 236), 'polished_blackstone_bricks'], [at(-41, 69, 238), 'gold_block'], [TREASURE, 'chest'],
  [at(-46, 69, 230), 'blackstone'], [OTHER, 'chest']
];
const TREASURE_LOOT = [
  { name: 'netherite_upgrade_smithing_template', count: 1 }, { name: 'netherite_ingot', count: 1 }, { name: 'gold_block', count: 3 }, { name: 'ancient_debris', count: 2 },
  { name: 'arrow', count: 12 }, { name: 'string', count: 4 }
];
const OTHER_LOOT = [{ name: 'gold_ingot', count: 6 }, { name: 'iron_chain', count: 2 }];
/** The north leg's way, as the scouting keeps it (the fortress tests' own). */
const WAY: Pos[] = [at(-77, 70, 267), at(-76, 70, 259), at(-76, 70, 251), at(-76, 70, 243), at(-72, 70, 237), at(-68, 70, 233)];
const PIGLINS: Mob[] = [{ id: 81, name: 'piglin', position: { x: -40.5, y: 70, z: 232.5 } }, { id: 82, name: 'piglin', position: { x: -44.5, y: 70, z: 238.5 } }];

/** The fire gear worn (D1): the golden helmet with fire protection 4 over the main set's protection 4 (20 EPF against fire). */
const SET: InventoryItem[] = ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'golden_helmet'].map((name, i) =>
  ({ slot: 36 + i, name, count: 1, enchantments: [{ name: name === 'golden_helmet' ? 'fire_protection' : 'protection', level: 4 }] }));
const dressed = (items: InventoryItem[]): InventoryItem[] => [...items.filter(i => i.slot < 36 || i.slot === 40), ...SET.map(i => ({ ...i }))];

/** The chests the tests use: the gear chest (the potions put here), the ores. */
const GEAR = '-547,64,2182';
const ORES = '-547,63,2180';

/** Potions (by their contents) in the gear chest, by their stacks as the memory has them. */
function stock(w: WorldMemory, potions: string[]) {
  w.chestStacks = { ...(w.chestStacks ?? {}), [GEAR]: potions.map((potion, i) => ({ slot: 40 + i, name: 'potion', count: 1, potion })) };
  if (potions.length) w.chestItems![GEAR].potion = potions.length;
  else delete w.chestItems![GEAR].potion;
}

/** Every bearing scouted an hour before `when` (the scouting declines), the north one along WAY. */
function scouted(w: WorldMemory, when: number) {
  netherOf(w).legs = BEARINGS.map((b, i) => ({ bearing: b.name as Bearing, at: when - HOUR + i, reach: 96, end: "the leg's 96 walked", way: (b.name === 'north' ? WAY : []).map(p => ({ ...p })) }));
}

const POTIONS = ['long_fire_resistance', 'long_fire_resistance', 'long_strength'];

/**
 * The setup trip run through, then stage 3 as six clean trips open it, on game day 7, the quartz at its target, no
 * gold over the barter's reserve, the blaze rods and the wart at the fortress's stock and 16 debris home (the fortress
 * and the tunnel unneeded), the open-face debris dry, every bearing scouted an hour ago, the bastion a scouting leg found
 * by the north way, `potions` in the gear chest; and a game of the world as it left it, two hours on, the Nether set
 * worn, with the bastion (and `blocks`) in the Nether, its zone, the piglins, and `opts`.
 */
async function atStage3(opts: Parameters<typeof game>[1] = {}, blocks: Blocks = [], potions = POTIONS) {
  const w = setupWorld();
  const first = game(w);
  await rung().run(first.ctx);
  Object.assign(netherOf(w), { stage: 3, stageTrips: 6, cleanTrips: 6 });
  w.idle = { today: { day: 7 } as never, days: [] };
  Object.assign(w.chestItems![ORES], { quartz: 64, blaze_rod: 8, nether_wart: 8, ancient_debris: 16 });
  const later = T0 + 2 * HOUR;
  scouted(w, later);
  noteSites(w, [{ kind: 'bastion', ...SITE, leg: 'north' }], later - HOUR);
  stock(w, potions);
  workOf(w).dry['nether:debris'] = { n: 6, at: later - MINUTE };
  const changed = [...first.changed, ...[...BASTION_BLOCKS, ...blocks].map(([p, to]) => ({ dim: NETHER as typeof NETHER, at: p, to, how: 'test' }))];
  const f = game(w, { items: dressed(first.inv), after: { changed, lit: first.lit }, now: later, zones: [ROOM_ZONE, { ...BASTION }], mobs: PIGLINS.map(m => ({ ...m, position: { ...m.position } })), ...opts });
  f.chests.set(k(TREASURE), TREASURE_LOOT.map(x => ({ ...x })));
  f.chests.set(k(OTHER), OTHER_LOOT.map(x => ({ ...x })));
  return { w, first, later, f };
}

const netherWalks = (f: Game) => f.walks.filter(x => x.dim === NETHER);
const carried = (f: Game, n: string) => f.inv.filter(i => i.slot < 36 && i.name === n).reduce((a, i) => a + i.count, 0);
const once = (get: () => Game | undefined, after: RegExp, then: (f: Game) => void) => {
  let done = false;
  return () => { const f = get(); if (!done && f && f.did.some(d => after.test(d))) { done = true; then(f); } };
};
/** The piglins turn on the bot as the treasure chest opens (26.3 PiglinAi: golden helmet or not). */
const turnAtOpen = (get: () => Game | undefined, more: (f: Game) => void = () => undefined) => once(get, /^look in -42,70,236$/, f => {
  for (const m of f.mobs) if (m.name === 'piglin') m.aggressive = true;
  more(f);
});

/** Every walk down there careful, 16 from the community's room; the way out none by lava within 2 (it is all floor here). */
function walkedKindly(t: { true: (v: boolean, m?: string) => void }, f: Game) {
  for (const x of netherWalks(f)) {
    t.true(x.careful, k(x.to));
    t.true(boxGap(zoneBox(ROOM_ZONE), cellBox(x.to)) >= FROM_BUILDS, `${k(x.to)} by the room`);
    for (let dx = -LAVA_GAP; dx <= LAVA_GAP; dx++) for (let dz = -LAVA_GAP; dz <= LAVA_GAP; dz++) for (let dy = -1; dy <= 1; dy++) {
      t.true(!/^lava/.test(f.get(NETHER, { x: x.to.x + dx, y: x.to.y + dy, z: x.to.z + dz })), `${k(x.to)} by lava`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ the stage, the choice, the gate

test.serial('the stage gate: the bastion opens at stage 3, its ready asking 2 potions of fire resistance; not before stage 3, the link or its own portal; its gates write nothing', async (t) => {
  t.deepEqual(stageNeeds('bastion'), { stage: 3, potions: FIRE_POTIONS });
  t.is(FIRE_POTIONS, 2);
  t.true(NETHER_WORK.some(v => v.id === 'bastion' && v.stage === 3));
  const { w, later, f } = await atStage3();
  t.true(bastionOpen(w));
  const s = lookAt(f.inv, 1000, { now: later });
  t.is(bastionReady(s, w), null);
  t.is(rung(later).wants(s, w), 'bastion: in the nether', 'the template wanted, the rest unneeded or dry: the bastion is the work');
  for (const [what, edit] of [['stage 2', (x: WorldMemory) => { netherOf(x).stage = 2; }], ['not linked', (x: WorldMemory) => { netherOf(x).linked = false; }],
    ['no portal of its own', (x: WorldMemory) => { delete netherOf(x).portal; }]] as const) {
    const c = structuredClone(w);
    edit(c);
    t.false(bastionOpen(c), what);
  }
  const before = JSON.stringify(w);
  for (const tod of [0, 1000, 3900]) { const look = lookAt(f.inv, tod, { now: later }); bastionOpen(w); bastionReady(look, w); bastionWay(w); bastionWant(look, w); rung(later).wants(look, w); rung(later).declines!(look, w); }
  t.is(JSON.stringify(w), before);
});

test.serial('the bastion choice: only a natural bastion a scouting leg found by its way (a fortress, a build, one with no leg or none within 48 of its way: none), never one refused, the shortest way first', async (t) => {
  const { w, later } = await atStage3();
  t.like(bastionWay(w), { bearing: 'north', to: 5, site: SITE, blocks: 37 });
  const only = (sites: ReturnType<typeof peekNether>['sites']) => { const c = structuredClone(w); netherOf(c).sites = sites; return bastionWay(c); };
  t.is(only([{ kind: 'fortress', ...SITE, leg: 'north' }]), undefined, 'a fortress is the fortress trip\'s');
  t.is(only([{ kind: 'build', ...SITE, leg: 'north' }]), undefined, 'someone\'s build');
  t.is(only([{ kind: 'bastion', ...SITE }]), undefined, 'no leg: no known way');
  t.is(only([{ kind: 'bastion', ...at(20, 71, 160), leg: 'north' }]), undefined, 'more than 48 from the way');
  t.like(only([{ kind: 'bastion', ...at(-50, 71, 255), leg: 'north' }, { kind: 'bastion', ...SITE, leg: 'north' }]), { to: 1, site: at(-50, 71, 255), blocks: 8 });
  const c = structuredClone(w);
  refuseBastion(c, SITE, 'torch within 16 of it', later, zoneBox(BASTION));
  t.is(bastionWay(c), undefined);
  t.is(only([{ kind: 'bastion', ...at(-44, 71, 220), leg: 'north' }]) !== undefined, true);
  const c2 = structuredClone(c);
  netherOf(c2).sites = [{ kind: 'bastion', ...at(-44, 71, 220), leg: 'north' }];
  t.is(bastionWay(c2), undefined, 'another site of the same bastion, within 16 of the refused one\'s box');
  t.like(bastionReady(lookAt(dressed([]), 1000, { now: later }), c), { cause: 'unneeded', text: 'bastion: no natural bastion known by a scouted way' });
});

test.serial('its ready: off after a death (until the lead switches it back), the barter\'s hold, the template wanted (none at home, a piece still to smith), the fire gear, the potions of fire resistance and strength in stock, the health, the kit', async (t) => {
  const { w, later, f } = await atStage3();
  const s = lookAt(f.inv, 1000, { now: later });
  t.is(bastionReady(s, w), null);
  const off = structuredClone(w);
  netherOf(off).bastion = { off: { at: later - MINUTE, why: 'a death on a bastion trip at nether (-44, 70, 233)' } };
  t.deepEqual(bastionReady(s, off), { cause: 'hold', text: 'bastion trips off: a death on a bastion trip at nether (-44, 70, 233) (until the lead switches them back)' });
  const h = structuredClone(w);
  netherOf(h).barter = { held: { day: 7, at: later - MINUTE, why: 'a piglin turned aggressive at nether (-73, 70, 256)' } };
  t.deepEqual(bastionReady(s, h), { cause: 'hold', text: 'bastion held for the day: a piglin turned aggressive at nether (-73, 70, 256)' });
  // a template at home: the copies make the rest
  const tpl = structuredClone(w);
  tpl.chestItems![ORES].netherite_upgrade_smithing_template = 1;
  t.deepEqual(bastionReady(s, tpl), { cause: 'unneeded', text: 'bastion: a netherite_upgrade_smithing_template at home (the copies make the rest)' });
  t.is(bastionWant(lookAt([...f.inv, { slot: 30, name: 'netherite_upgrade_smithing_template', count: 1 }], 1000), w), 'bastion: a netherite_upgrade_smithing_template at home (the copies make the rest)');
  // every piece netherite: no template wanted
  const all = ['netherite_boots', 'netherite_leggings', 'netherite_chestplate', 'netherite_helmet'].map((name, i) => ({ slot: 36 + i, name, count: 1 }));
  t.is(bastionWant(lookAt(all, 1000), w), 'bastion: every armour piece is netherite');
  // the fire gear short
  const plain = f.inv.map(i => (i.slot === 36 ? { ...i, enchantments: [] } : i));
  t.deepEqual(bastionReady(lookAt(plain, 1000, { now: later }), w),
    { cause: 'kit', text: 'bastion: the fire gear is short: fire EPF 16 < 20 (the diamond_boots has protection 0 (4 wanted)) (the bastion goes only in it)' });
  // the potions: one of fire resistance (two wanted), none of strength
  const one = structuredClone(w);
  stock(one, ['long_fire_resistance', 'long_strength']);
  t.deepEqual(bastionReady(s, one), { cause: 'kit', text: 'bastion: 1 of the 2 potions of fire resistance it takes in stock (carried or in the chests)' });
  const weak = structuredClone(w);
  stock(weak, ['long_fire_resistance', 'fire_resistance', 'long_swiftness']);
  t.deepEqual(bastionReady(s, weak), { cause: 'kit', text: 'bastion: no potion of strength in stock (carried or in the chests): it drinks one before the piglins\' fight' });
  // a strength potion carried counts (by its contents, never by its name)
  t.is(bastionReady(lookAt([...f.inv, { slot: 31, name: 'potion', count: 1, potion: 'strength' }], 1000, { now: later }), weak), null);
  t.like(bastionReady(lookAt(f.inv, 1000, { now: later, health: 14 }), w), { cause: 'health' });
});

// ------------------------------------------------------------------------------------------------ the strict rules, pure

test('the strict rules: under 14 health, the wither, any hold; two brutes near, a second after the one killed, one on it within 12 before the potions; a hoglin near; more than 3 foes on it, turned piglins and the brute (3 is the fight), a zombified piglin turned; the ghast rule b; a hit with no foe about; the potions run short once drunk', (t) => {
  const w = setupWorld();
  Object.assign(netherOf(w), { linked: true, portal: { x: -79, y: 70, z: 266 }, stage: 3 });
  const look = (over: Partial<Parameters<typeof bastionStop>[0]> = {}) => bastionStop({ health: 20, was: 20, ents: [], ...over }, w, T0);
  const e = (name: string, distance: number, extra: Partial<Mob> = {}) => ({ id: distance * 10 + (extra.id ?? 0), name, position: { x: 0, y: 70, z: distance }, distance, ...extra });
  const mad = (n: number) => Array.from({ length: n }, (_, i) => e('piglin', 6 + i, { aggressive: true }));
  t.is(look(), null);
  t.is(BASTION_LEAVE, 14);
  t.deepEqual(look({ health: 13, was: 13 }), { why: 'health 13, under 14' });
  t.is(look({ health: 14, was: 14 }), null, '14 is not under 14');
  t.deepEqual(look({ effects: [{ name: 'wither', amplifier: 0, seconds: 8 }] }), { why: 'the wither on it' });
  // the brute (the user's choice of Nov 18: one a trip is fought): one with the potions on it is the fight; one on it
  // within 12 before them, two together, or one more after the one killed, and it leaves; a hoglin: leave (avoided by
  // going); further off they are let be
  const on = [{ name: 'fire_resistance', amplifier: 0, seconds: 300 }, { name: 'strength', amplifier: 0, seconds: 300 }];
  const drunk = { effects: on, drunk: { fireNeedS: 120 } };
  t.is(look({ ...drunk, ents: [e('piglin_brute', 12)] }), null, 'one brute, the potions on it: the fight');
  t.is(look({ ents: [e('piglin_brute', 12)] }), null, 'a calm brute 12 off before the potions: the fight once they are drunk');
  t.deepEqual(look({ ents: [e('piglin_brute', 12, { aggressive: true })] }), { why: 'a piglin brute on it (12 off), the potions not drunk' });
  t.is(look({ ents: [e('piglin_brute', 13, { aggressive: true })] }), null, 'one on it 13 off: drunk before it is there');
  t.deepEqual(look({ ...drunk, ents: [e('piglin_brute', 12), e('piglin_brute', 15, { id: 1 })] }), { why: '2 piglin brutes near (the nearest 12 off): it fights one' });
  t.deepEqual(look({ ents: [e('piglin_brute', 12), e('piglin_brute', 15, { id: 1 })] }), { why: '2 piglin brutes near (the nearest 12 off): it fights one' });
  t.deepEqual(look({ ...drunk, brutesKilled: 1, ents: [e('piglin_brute', 9)] }), { why: 'a second piglin brute near (9 off), one killed: it fights one a trip' });
  t.is(look({ ...drunk, brutesKilled: 1 }), null, 'the one killed, none more: on');
  t.is(look({ ents: [e('piglin_brute', 20), e('piglin_brute', 22, { id: 1 })] }), null);
  t.is(look({ ...drunk, ents: [e('piglin_brute', 12), e('piglin_brute', 20, { id: 1 })] }), null, 'the second 20 off');
  t.deepEqual(look({ ents: [e('hoglin', 10)] }), { why: 'a hoglin near (10 off)' });
  t.deepEqual(look({ ents: [e('zoglin', 15)] }), { why: 'a zoglin near (15 off)' });
  // turned piglins: up to BASTION_CROWD are the fight, one more and it leaves; calm ones are nothing
  t.is(BASTION_CROWD, 3);
  t.is(look({ ents: mad(3) }), null);
  t.deepEqual(look({ ents: mad(4) }), { why: '4 piglins turned on it (more than 3)' });
  t.is(look({ ents: Array.from({ length: 6 }, (_, i) => e('piglin', 5 + i)) }), null, 'calm ones (the golden helmet)');
  t.is(look({ ents: [...mad(3), e('piglin', 20, { aggressive: true })] }), null, 'one turned 20 off does not count');
  t.like(look({ ents: [e('zombified_piglin', 8, { aggressive: true })] }), { why: 'a zombified_piglin turned aggressive at nether (0, 70, 8) (its pack comes)' });
  // the brute is one of the crowd: with 3 turned piglins it is 4
  t.is(look({ ...drunk, ents: [...mad(2), e('piglin_brute', 10)] }), null, 'two turned and the brute: 3, the fight');
  t.deepEqual(look({ ...drunk, ents: [...mad(3), e('piglin_brute', 10)] }), { why: '3 piglins turned on it and a piglin brute (4, more than 3)' });
  // the ghast rule b
  t.deepEqual(look({ ents: [e('ghast', 14)] }), { why: 'a ghast in sight (14 off)' });
  t.is(look({ ents: [e('ghast', 20)] }), null);
  t.deepEqual(look({ ents: [e('fireball', 10)] }), { why: "a ghast's fireball coming at it (10 off)" });
  // a hit: the fight's while a turned piglin is about, else home
  t.deepEqual(look({ health: 17, was: 20 }), { why: 'a hit taken (health 20 -> 17)' });
  t.is(look({ health: 17, was: 20, ents: mad(1) }), null);
  t.is(look({ ...drunk, health: 15, was: 20, ents: [e('piglin_brute', 3)] }), null, 'a hit while the brute is on it: the fight\'s (the health rule bounds it)');
  t.deepEqual(look({ ...drunk, health: 17, was: 20 }), { why: 'a hit taken (health 20 -> 17)' });
  t.deepEqual(look({ onFire: true }), { why: 'on fire, with no fire resistance on it' });
  // the potions drunk: the fire resistance must outlast the way back, the strength must be on it
  t.is(look({ effects: on, drunk: { fireNeedS: 120 } }), null);
  t.deepEqual(look({ effects: on, drunk: { fireNeedS: 300 } }), { why: 'the fire resistance drunk now lasts only the way back' });
  t.deepEqual(look({ effects: [on[1]], drunk: { fireNeedS: 60 } }), { why: 'the fire resistance drunk now lasts only the way back' });
  t.deepEqual(look({ effects: [on[0]], drunk: { fireNeedS: 60 } }), { why: 'the strength drunk has worn off' });
  t.is(look({ effects: [on[0]] }), null, 'not drunk yet: nothing asked of them');
  // the holds: the switch, a death hold, the bastion trips off
  const off = structuredClone(w); netherOf(off).trips = false;
  t.deepEqual(bastionStop({ health: 20, was: 20, ents: [] }, off, T0), { why: 'nether trips are off' });
  const died = structuredClone(w); netherOf(died).deaths = [{ at: T0 - 10 * MINUTE, where: at(0, 70, 0) }];
  t.regex(bastionStop({ health: 20, was: 20, ents: [] }, died, T0)!.why, /^a death in the nether: held until /);
  const bo = structuredClone(w); netherOf(bo).bastion = { off: { at: T0, why: 'switched off by the lead' } };
  t.deepEqual(bastionStop({ health: 20, was: 20, ents: [] }, bo, T0), { why: 'bastion trips off: switched off by the lead' });
});

test('a bastion\'s own chest: a single one or a pair on its blocks with nothing but its blocks, air and lava round it; a third chest by a pair, one a corner away, one with a torch or a crafting table by it, one on cobblestone is someone\'s; the treasure room\'s has gold blocks by it', (t) => {
  const base = new Map<string, string>(BASTION_BLOCKS.map(([p, b]) => [k(p), b]));
  const ground = (over: Blocks = []) => { const m = new Map(base); for (const [p, b] of over) m.set(k(p), b); return (p: Pos) => m.get(k(p)) ?? (p.y <= 69 ? 'netherrack' : 'air'); };
  const box = { x1: -50, y1: 66, z1: 226, x2: -38, y2: 76, z2: 240 };
  t.true(bastionChest(gridOf(ground(), box), TREASURE));
  t.true(bastionChest(gridOf(ground([[at(-43, 70, 236), 'lava'], [at(-42, 71, 237), 'iron_chain']]), box), TREASURE), 'lava and a chain by it: the bastion\'s');
  // the bastion's own double chests (10 of the 37 chests of 26.3's bastion templates are halves of a pair)
  const pair: Blocks = [[at(-41, 70, 236), 'chest'], [at(-41, 69, 236), 'blackstone']];
  t.true(bastionChest(gridOf(ground(pair), box), TREASURE), 'a double chest on the bastion\'s blocks');
  t.true(bastionChest(gridOf(ground(pair), box), at(-41, 70, 236)), 'its other half');
  t.deepEqual(chestHalf(gridOf(ground(pair), box), TREASURE), at(-41, 70, 236));
  t.is(chestHalf(gridOf(ground(), box), TREASURE), undefined);
  t.false(bastionChest(gridOf(ground([...pair, [at(-40, 71, 236), 'torch']]), box), TREASURE), 'a pair with a torch by its other half');
  t.false(bastionChest(gridOf(ground([...pair, [at(-41, 69, 236), 'cobblestone']]), box), TREASURE), 'a pair with its other half on cobblestone');
  const row: Blocks = [...pair, [at(-40, 70, 236), 'chest'], [at(-40, 69, 236), 'blackstone']];
  t.false(bastionChest(gridOf(ground(row), box), TREASURE), 'a row of three: the end');
  t.false(bastionChest(gridOf(ground(row), box), at(-41, 70, 236)), 'a row of three: the middle');
  t.is(chestHalf(gridOf(ground(row), box), at(-41, 70, 236)), null);
  t.false(bastionChest(gridOf(ground([[at(-41, 70, 237), 'chest']]), box), TREASURE), 'a chest a corner away');
  t.false(bastionChest(gridOf(ground([[at(-42, 71, 236), 'chest']]), box), TREASURE), 'a chest on top');
  t.false(bastionChest(gridOf(ground([[at(-41, 71, 236), 'torch']]), box), TREASURE), 'a torch by it');
  t.false(bastionChest(gridOf(ground([[at(-42, 70, 237), 'crafting_table']]), box), TREASURE), 'a crafting table by it');
  t.false(bastionChest(gridOf(ground([[at(-42, 69, 236), 'cobblestone']]), box), TREASURE), 'on cobblestone');
  t.false(bastionChest(gridOf(ground(), box), at(-42, 70, 235)), 'no chest there');
  t.true(treasureChest(gridOf(ground(), box), TREASURE));
  t.false(treasureChest(gridOf(ground(), box), OTHER));
  // the potion of strength drunk: by its contents, the longest
  t.like(strengthToDrink([{ slot: 3, name: 'potion', count: 1, potion: 'strength' }, { slot: 5, name: 'potion', count: 1, potion: 'long_strength' }, { slot: 2, name: 'potion', count: 1, potion: 'long_swiftness' }]),
    { slot: 5, potion: 'long_strength' });
  t.is(strengthToDrink([{ slot: 2, name: 'splash_potion', count: 1, potion: 'strength' }]), undefined);
  t.deepEqual(BASTION_LOOT, ['netherite_upgrade_smithing_template', 'netherite_ingot', 'netherite_scrap', 'ancient_debris', 'gold_block', 'gold_ingot', 'diamond']);
});

// ------------------------------------------------------------------------------------------------ a trip end to end

test.serial('a bastion trip: the potions fetched, out along the scouted way, fire resistance and strength drunk at its edge; the treasure chest first (its template, netherite, debris and gold blocks taken, the junk left), the piglins it turned fought from the shield by their ids, the other chest after; back along the way and through its own portal; a clean trip', async (t) => {
  let g: Game | undefined;
  const a = await atStage3({ onLook: turnAtOpen(() => g) });
  g = a.f;
  const text = await rung(a.later).run(a.f.ctx);
  t.is(text, '[bastion] bastion at nether (-44, 71, 233): 6 gold_ingot, 3 gold_block, 2 ancient_debris, 1 netherite_ingot, 1 netherite_upgrade_smithing_template (2 foes killed); ' +
    'nothing more it may take by the way in; back at overworld (-562, 65, 2191); back home');
  t.deepEqual(a.f.said.filter(l => /^(nether|bastion): /.test(l)), [
    'nether: through the portal at overworld (-562, 63, 2191) -> nether (-79, 70, 267)',
    'bastion: out along the north way (37 blocks) to nether (-68, 70, 233) for the bastion at nether (-44, 71, 233)',
    'bastion: drank a potion of long_fire_resistance: 480 s of fire resistance',
    'bastion: drank a potion of long_strength: 480 s of strength',
    'bastion: the netherite_upgrade_smithing_template from the chest at nether (-42, 70, 236)',
    'bastion: killed piglin',
    'bastion: killed piglin',
    'nether: bastion at nether (-44, 71, 233): 6 gold_ingot, 3 gold_block, 2 ancient_debris, 1 netherite_ingot, 1 netherite_upgrade_smithing_template (2 foes killed)'
  ]);
  // the potions out of the chests (one with the Nether kit, the rest by the bastion's own kit), drunk before any chest
  const drank = a.f.did.filter(d => d.startsWith('drink '));
  t.deepEqual(drank, ['drink potion of long_fire_resistance', 'drink potion of long_strength']);
  t.true(a.f.did.indexOf('drink potion of long_strength') < a.f.did.indexOf('look in -42,70,236'), 'drunk before the first chest');
  t.true(a.f.did.indexOf('look in -42,70,236') < a.f.did.indexOf('look in -46,70,230'), 'the treasure room\'s first');
  // the piglins fought by their ids from the shield (no retreat walk, the fight ends under 14)
  t.true(a.f.did.includes('fight piglin #81 (min health 14, retreat false)'));
  t.true(a.f.did.includes('fight piglin #82 (min health 14, retreat false)'));
  // what it wants taken, the junk left; each chest looted once
  t.deepEqual(a.f.chests.get(k(TREASURE)), [{ name: 'arrow', count: 12 }, { name: 'string', count: 4 }]);
  t.deepEqual(a.f.chests.get(k(OTHER)), [{ name: 'iron_chain', count: 2 }]);
  t.deepEqual(peekNether(a.w).bastion?.looted, [TREASURE, OTHER]);
  for (const [n, c] of [['netherite_upgrade_smithing_template', 1], ['netherite_ingot', 1], ['gold_block', 3], ['ancient_debris', 2], ['gold_ingot', 6]] as const) t.is(carried(a.f, n), c, n);
  t.is(carried(a.f, 'arrow'), 0);
  // nothing of the bastion dug or placed (its gold blocks anger every piglin within 16), every walk careful
  t.false(a.f.did.some(d => d.startsWith('dig ') || d.startsWith('place ')), 'nothing dug or placed');
  walkedKindly(t, a.f);
  t.like(peekNether(a.w), { stageTrips: 7, lastTrip: { end: 'clean' }, bastion: { trip: { from: a.later, to: a.later } } });
  t.is(a.f.state.dim, OVERWORLD);
  // its own health rule bounds the run while it runs; after it, leave nether's 12 again
  t.is(leaveWhy({ ...lookAt(a.f.inv, 1000, { now: a.later }), dimension: NETHER, health: 11 }, a.w), 'health 11: home from the nether');
  // the template home: the bastion is not wanted again
  t.like(bastionReady(lookAt(a.f.inv, 1000, { now: a.later + HOUR }), a.w), { cause: 'unneeded' });
});

test.serial('a fight in bouts of 4 s, a look between them; under 14 health at the bastion: home at once, from wherever it is (the other chest left)', async (t) => {
  let g: Game | undefined;
  const hurt = once(() => g, /^fight piglin/, f => { f.state.health = 12; });
  const turn = turnAtOpen(() => g);
  const a = await atStage3({ onLook: () => { turn(); hurt(); } });
  g = a.f;
  const asked: Record<string, unknown>[] = [];
  const call = a.f.ctx.call.bind(a.f.ctx);
  (a.f.ctx as { call: typeof call }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'fight') asked.push({ ...p });
    return call(m, p);
  }) as typeof call;
  const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
  t.true(asked.length >= 1 && asked.every(p => p.timeoutMs === FIGHT_BOUT.ms && p.minHealth === BASTION_LEAVE && p.retreat === false && p.crowdStop === false && p.careful === true), JSON.stringify(asked));
  t.regex(r.text, /^bastion at nether \(-44, 71, 233\): .*1 netherite_upgrade_smithing_template.*; health 12, under 14; back at overworld \(-562, 65, 2191\)$/);
  t.false(a.f.did.includes('look in -46,70,230'), 'the other chest not opened');
  t.is(a.f.state.dim, OVERWORLD);
});

test.serial('more than 3 piglins turned on it: home at once with what it has; more than 3 adult piglins by a chest: it is not opened (they would all turn)', async (t) => {
  let g: Game | undefined;
  const a = await atStage3({
    onLook: turnAtOpen(() => g, f => { f.mobs.push({ id: 83, name: 'piglin', position: { x: -39.5, y: 70, z: 236.5 }, aggressive: true }, { id: 84, name: 'piglin', position: { x: -45.5, y: 70, z: 235.5 }, aggressive: true }); })
  });
  g = a.f;
  const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
  t.regex(r.text, /^bastion at nether \(-44, 71, 233\): 3 gold_block, 2 ancient_debris, 1 netherite_ingot, 1 netherite_upgrade_smithing_template; 4 piglins turned on it \(more than 3\); back at overworld/);
  t.is(carried(a.f, 'netherite_upgrade_smithing_template'), 1, 'the chest emptied before the look after it');
  t.false(a.f.did.some(d => d.startsWith('fight ')), 'none fought: too many');
  t.is(a.f.state.dim, OVERWORLD);

  const crowd: Mob[] = [0, 1, 2, 3, 4].map(i => ({ id: 90 + i, name: 'piglin', position: { x: -43.5 + i, y: 70, z: 233.5 } }));
  const b = await atStage3({ mobs: crowd });
  const r2 = await bastionRun(b.f.ctx, HOUR, () => b.later);
  t.false(b.f.did.some(d => /^look in -4[26],70,2(36|30)$/.test(d)), 'no chest of the bastion opened');
  t.true(b.f.said.includes('bastion: 5 piglins within 16 of the chest at nether (-42, 70, 236): not opened (they would all turn)'));
  t.regex(r2.text, /^nothing from the bastion at nether \(-44, 71, 233\); more than 3 piglins by every chest it may open: let be; back at overworld/);
  // babies keep their distance: they do not count
  const babies = crowd.map(m => ({ ...m, position: { ...m.position }, baby: true }));
  const c = await atStage3({ mobs: babies });
  await bastionRun(c.f.ctx, HOUR, () => c.later);
  t.true(c.f.did.includes('look in -42,70,236'));
});

test.serial('two piglin brutes together or a hoglin by the bastion\'s ground (by its chests, as 26.3\'s pieces put brutes): seen from its edge, not gone into, no potion drunk, the dry mark doubling; two in rooms apart: gone in, one fought; a hoglin come near once in: home at once, nothing more opened, the mark doubling too', async (t) => {
  // (two brutes in the bastion 11 apart, one 27 from the waypoint by the treasure chest, as the real treasure rooms have; a hoglin)
  const BY_TREASURE = { x: -41.5, y: 70, z: 239.5 };
  for (const [what, mobs, why] of [
    ['two brutes', [{ id: 98, name: 'piglin_brute', position: { x: -40.5, y: 70, z: 228.5 } }, { id: 99, name: 'piglin_brute', position: { ...BY_TREASURE } }],
      '2 piglin brutes together by the bastion, the nearest at nether \\(-42, 70, 239\\) \\(it fights one\\)'],
    ['a hoglin', [{ id: 99, name: 'hoglin', position: { x: -40.5, y: 70, z: 228.5 } }], 'a hoglin by the bastion at nether \\(-41, 70, 228\\)']] as const) {
    const a = await atStage3({ mobs: [...PIGLINS, ...mobs.map(m => ({ ...m, position: { ...m.position } }))] });
    const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
    t.regex(r.text, new RegExp(`^nothing from the bastion at nether \\(-44, 71, 233\\); ${why}: not going in; back at overworld`), what);
    t.false(a.f.did.some(d => d.startsWith('look in -4')), `${what}: no chest opened`);
    t.false(a.f.did.some(d => d.startsWith('drink ')), `${what}: no potion drunk for it`);
    t.false(a.f.did.some(d => d.startsWith('fight ')), `${what}: none fought`);
    t.is(r.mark, undefined, `${what}: the place's own mark (markDry doubles it), not the flat 20 min of 'same'`);
    t.is(r.worked, undefined);
    t.is(a.f.state.dim, OVERWORLD);
  }
  // one brute alone is the fight (the user's choice of Nov 18): the guard lets it by
  const into = { x1: -10, y1: 60, z1: -10, x2: -7, y2: 80, z2: 10 };
  t.is(bastionGuard([{ id: 1, name: 'piglin_brute', position: { x: -5.5, y: 70, z: 0.5 }, distance: 20 }], into), null, 'one brute');
  t.is(bastionGuard([{ id: 1, name: 'piglin_brute', position: { x: -5.5, y: 70, z: 0.5 }, distance: 20 }, { id: 2, name: 'piglin_brute', position: { x: 10.5, y: 70, z: 0.5 }, distance: 30 }], into), null,
    'the second further off the ground it would go into: let be');
  t.is(bastionGuard([{ id: 1, name: 'piglin_brute', position: { x: -5.5, y: 70, z: 0.5 }, distance: 20 }, { id: 2, name: 'piglin_brute', position: { x: 8.5, y: 70, z: 0.5 }, distance: 30 }], into),
    '2 piglin brutes together by the bastion, the nearest at nether (-6, 70, 0) (it fights one)');
  // (two by the ground it goes into but in rooms 19 apart: never on it together, one a trip)
  t.is(bastionGuard([{ id: 1, name: 'piglin_brute', position: { x: -5.5, y: 70, z: -9.5 }, distance: 20 }, { id: 2, name: 'piglin_brute', position: { x: -5.5, y: 70, z: 9.5 }, distance: 22 }], into), null,
    'two 19 apart: one a trip');
  t.is(bastionGuard([{ id: 1, name: 'piglin_brute', position: { x: -5.5, y: 70, z: -9.5 }, distance: 20 }, { id: 2, name: 'piglin_brute', position: { x: -5.5, y: 70, z: 9.5 }, distance: 22 },
    { id: 3, name: 'piglin_brute', position: { x: -5.5, y: 70, z: 20.5 }, distance: 30 }], into), '2 piglin brutes together by the bastion, the nearest at nether (-6, 70, 9) (it fights one)',
  'the third 11 from the second: those two together');
  // two brutes 19.6 apart, one 16 from the ground it would go into (the old guard's whole read box): gone in, the potions
  // drunk, the one by the chests fought and the chests looted (the second-brute rule bounds it, had the other come near)
  {
    const a = await atStage3({ mobs: [...PIGLINS, { id: 98, name: 'piglin_brute', position: { x: -40.5, y: 70, z: 228.5 } }, { id: 99, name: 'piglin_brute', position: { x: -21.5, y: 70, z: 233.5 } }] });
    const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
    t.regex(r.text, /^bastion at nether \(-44, 71, 233\): .*1 netherite_upgrade_smithing_template \(1 foe killed\); nothing more it may take by the way in; back at overworld/, 'the second never within 16: both chests looted');
    t.true(a.f.did.includes('drink potion of long_strength'), 'gone in');
    t.true(a.f.did.includes('fight piglin_brute #98 (min health 14, retreat false)'), a.f.did.join('\n'));
    t.false(a.f.did.some(d => d.startsWith('fight piglin_brute #99')), 'one a trip');
    t.is(r.worked, true);
    t.is(a.f.state.dim, OVERWORLD);
  }
  t.is(bastionGuard([{ id: 1, name: 'zoglin', position: { x: 8.5, y: 70, z: 0.5 }, distance: 30 }], into), 'a zoglin by the bastion at nether (8, 70, 0)');

  // a hoglin come near once it is in (after the drinks): home at once, its mark learnt too
  {
    let g: Game | undefined;
    const come = once(() => g, /^drink potion of long_strength$/, f => { f.mobs.push({ id: 99, name: 'hoglin', position: { x: f.state.pos.x + 6, y: 70, z: f.state.pos.z } }); });
    const a = await atStage3({ onLook: come });
    g = a.f;
    const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
    t.regex(r.text, /^nothing from the bastion at nether \(-44, 71, 233\); a hoglin near \(\d+ off\); back at overworld/);
    t.false(a.f.did.some(d => d.startsWith('look in -4')), 'no chest opened');
    t.is(r.mark, undefined);
  }
  // two brutes come near once it is in: home at once, the mark doubling
  {
    let g: Game | undefined;
    const come = once(() => g, /^drink potion of long_strength$/, f => {
      f.mobs.push({ id: 98, name: 'piglin_brute', position: { x: f.state.pos.x + 6, y: 70, z: f.state.pos.z } }, { id: 99, name: 'piglin_brute', position: { x: f.state.pos.x + 9, y: 70, z: f.state.pos.z + 2 } });
    });
    const a = await atStage3({ onLook: come });
    g = a.f;
    const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
    t.regex(r.text, /^nothing from the bastion at nether \(-44, 71, 233\); 2 piglin brutes near \(the nearest 6 off\): it fights one; back at overworld/);
    t.false(a.f.did.some(d => d.startsWith('look in -4') || d.startsWith('fight ')), 'none fought, no chest opened');
    t.is(r.mark, undefined);
  }

  // through the rung: the second dry try at a bastion of two brutes waits 40 min, not 20 again (it went every 20 min of
  // daylight, two potions a go); no potion drunk
  const b = await atStage3({ mobs: [...PIGLINS, { id: 98, name: 'piglin_brute', position: { x: -40.5, y: 70, z: 228.5 } }, { id: 99, name: 'piglin_brute', position: { ...BY_TREASURE } }] });
  workOf(b.w).dry['nether:bastion'] = { n: 1, at: b.later - 30 * MINUTE };
  await rung(b.later).run(b.f.ctx);
  t.like(workOf(b.w).dry['nether:bastion'], { n: 2 });
  t.is(DRY_WAIT[1], 40 * MINUTE);
  t.false(b.f.did.some(d => d.startsWith('drink ')));
});

test.serial('one piglin brute (the user\'s choice of Nov 18): gone in with it by the treasure chest, the potions drunk; the walk stops where it comes, it is fought from the shield by its id (careful, no crowd stop), before any chest; then the chests looted', async (t) => {
  let g: Game | undefined;
  const BRUTE: Mob = { id: 99, name: 'piglin_brute', position: { x: -41.5, y: 70, z: 239.5 } };
  const a = await atStage3({ mobs: [...PIGLINS, BRUTE].map(m => ({ ...m, position: { ...m.position } })), onLook: turnAtOpen(() => g) });
  g = a.f;
  const asked: Record<string, unknown>[] = [];
  const call = a.f.ctx.call.bind(a.f.ctx);
  (a.f.ctx as { call: typeof call }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'fight') asked.push({ ...p });
    return call(m, p);
  }) as typeof call;
  const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
  t.is(r.text, 'bastion at nether (-44, 71, 233): 6 gold_ingot, 3 gold_block, 2 ancient_debris, 1 netherite_ingot, 1 netherite_upgrade_smithing_template (3 foes killed); ' +
    'nothing more it may take by the way in; back at overworld (-562, 65, 2191)');
  const fightAt = a.f.did.indexOf('fight piglin_brute #99 (min health 14, retreat false)');
  t.true(fightAt >= 0, a.f.did.join('\n'));
  t.true(a.f.did.indexOf('drink potion of long_strength') < fightAt, 'the potions on it first');
  t.true(fightAt < a.f.did.indexOf('look in -42,70,236'), 'the brute before the chest by it');
  t.like(asked[0], { target: '#99', minHealth: BASTION_LEAVE, retreat: false, crowdStop: false, careful: true });
  t.true(a.f.said.some(l => /^bastion: the piglin brute #99 at nether \(-42, 70, 239\), (\d+) off: fought from the shield \(one a trip\)$/.test(l)), a.f.said.join('\n'));
  t.true(a.f.said.includes('bastion: killed piglin_brute'));
  t.true(a.f.said.some(l => /^bastion: the piglin brute #99 .*comes: it waits for it$/.test(l)), 'stood for it once in sight within 16');
  // the chests after it: both looted, the turned piglins fought too
  t.deepEqual(peekNether(a.w).bastion?.looted, [TREASURE, OTHER]);
  t.is(carried(a.f, 'netherite_upgrade_smithing_template'), 1);
  t.true(a.f.did.includes('fight piglin #81 (min health 14, retreat false)'));
  t.false(a.f.did.some(d => d.startsWith('dig ') || d.startsWith('place ')), 'nothing dug or placed');
  walkedKindly(t, a.f);
  t.is(a.f.state.dim, OVERWORLD);
  t.like(peekNether(a.w), { lastTrip: { end: 'clean' } });
});

test.serial('the brute just killed is no second brute: its body still listed with health 0 for the look after the kill (the game keeps it about 1 s), the chests are looted', async (t) => {
  let g: Game | undefined;
  const BRUTE: Mob = { id: 99, name: 'piglin_brute', position: { x: -41.5, y: 70, z: 239.5 } };
  const a = await atStage3({ mobs: [...PIGLINS, BRUTE].map(m => ({ ...m, position: { ...m.position } })), corpseLooks: 1, onLook: turnAtOpen(() => g) });
  g = a.f;
  const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
  t.true(a.f.did.includes('fight piglin_brute #99 (min health 14, retreat false)'));
  t.is(r.text, 'bastion at nether (-44, 71, 233): 6 gold_ingot, 3 gold_block, 2 ancient_debris, 1 netherite_ingot, 1 netherite_upgrade_smithing_template (3 foes killed); ' +
    'nothing more it may take by the way in; back at overworld (-562, 65, 2191)');
  t.deepEqual(peekNether(a.w).bastion?.looted, [TREASURE, OTHER]);
});

test.serial('a lone brute by the way\'s end, on it 13 off: no stop before the potions (drunk first, then it is fought there), the chests looted; one on it within 12 on the way out: home before any potion, the flat mark (not the doubling)', async (t) => {
  // (13 off the waypoint at nether (-68, 70, 233), seen and coming: it used to turn the trip back here every time)
  const BRUTE: Mob = { id: 99, name: 'piglin_brute', position: { x: -54.5, y: 70, z: 233.5 }, aggressive: true };
  let g: Game | undefined;
  const a = await atStage3({ mobs: [...PIGLINS, BRUTE].map(m => ({ ...m, position: { ...m.position } })), onLook: turnAtOpen(() => g) });
  g = a.f;
  const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
  const fightAt = a.f.did.indexOf('fight piglin_brute #99 (min health 14, retreat false)');
  t.true(fightAt >= 0, a.f.did.join('\n'));
  t.true(a.f.did.indexOf('drink potion of long_strength') < fightAt, 'the potions on it first');
  t.regex(r.text, /^bastion at nether \(-44, 71, 233\): .*1 netherite_upgrade_smithing_template \(3 foes killed\); nothing more it may take by the way in; back at overworld/);

  // one on it 6 off on the way out: home, nothing drunk; the flat mark, as for a ghast gone by
  let h: Game | undefined;
  let done = false;
  const come = () => {
    const f = h;
    if (done || !f || f.state.dim !== NETHER || netherWalks(f).length < 2) return;
    done = true;
    f.mobs.push({ id: 100, name: 'piglin_brute', position: { x: f.state.pos.x + 6, y: 70, z: f.state.pos.z }, aggressive: true });
  };
  const b = await atStage3({ onLook: come });
  h = b.f;
  const r2 = await bastionRun(b.f.ctx, HOUR, () => b.later);
  t.regex(r2.text, /^nothing from the bastion at nether \(-44, 71, 233\); a piglin brute on it \(6 off\), the potions not drunk; back at overworld/);
  t.false(b.f.did.some(d => d.startsWith('drink ') || d.startsWith('look in -4')), 'nothing drunk, no chest opened');
  t.is(r2.mark, 'same', 'the flat mark: once drunk, a lone brute is the fight');
});

test.serial('a brute that comes is stood for: the walk stops where it is seen within 16, the bot waits where it stands (no step toward it) and fights it there; one that never comes into reach is waited for BRUTE_WAITS looks at most', async (t) => {
  let g: Game | undefined;
  const BRUTE: Mob = { id: 99, name: 'piglin_brute', position: { x: -41.5, y: 70, z: 239.5 } };
  const a = await atStage3({ mobs: [...PIGLINS, BRUTE].map(m => ({ ...m, position: { ...m.position } })), brutesCome: 1, onLook: turnAtOpen(() => g) });
  g = a.f;
  /** the walks down there when it started waiting, and when it fought */
  let atWait = -1, atFight = -1;
  const progress = a.f.ctx.progress.bind(a.f.ctx);
  (a.f.ctx as { progress: typeof progress }).progress = (x: string) => { if (/comes: it waits for it$/.test(x)) atWait = netherWalks(a.f).length; progress(x); };
  const call = a.f.ctx.call.bind(a.f.ctx);
  (a.f.ctx as { call: typeof call }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'fight' && p?.target === '#99') atFight = netherWalks(a.f).length;
    return call(m, p);
  }) as typeof call;
  const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
  t.true(atWait > 0 && atFight === atWait, `waited at walk ${atWait}, fought at walk ${atFight}`);
  t.true(a.f.said.includes('bastion: killed piglin_brute'));
  t.regex(r.text, /^bastion at nether \(-44, 71, 233\): .*1 netherite_upgrade_smithing_template.*\(3 foes killed\)/);

  // one that stays in its room, in sight 13-16 off: stood for BRUTE_WAITS looks, then the walk goes on and it is met where it comes within 12
  t.is(BRUTE_WAITS, 4);
  let h: Game | undefined;
  const b = await atStage3({ mobs: [...PIGLINS, BRUTE].map(m => ({ ...m, position: { ...m.position } })), onLook: turnAtOpen(() => h) });
  h = b.f;
  const r2 = await bastionRun(b.f.ctx, HOUR, () => b.later);
  t.true(b.f.did.includes('fight piglin_brute #99 (min health 14, retreat false)'));
  t.true(b.f.did.includes('look in -42,70,236'));
  t.regex(r2.text, /\(3 foes killed\)/);
});

test.serial('a brute fight that drops the health under 14: home at once, no chest opened; a second brute seen after the one killed: home, nothing more opened; a brute with three turned piglins on it is the crowd: home; a brute let be counts in the crowd by a chest (not opened)', async (t) => {
  const BRUTE: Mob = { id: 99, name: 'piglin_brute', position: { x: -41.5, y: 70, z: 239.5 } };
  const mobs = () => [...PIGLINS, BRUTE].map(m => ({ ...m, position: { ...m.position } }));
  // the brute's axe through the bout: the bridge's fight stops at 14 (minHealth), the brute alive
  const a = await atStage3({ mobs: mobs() });
  const call = a.f.ctx.call.bind(a.f.ctx);
  (a.f.ctx as { call: typeof call }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'fight' && p?.target === '#99') {
      a.f.did.push('fight the brute');
      a.f.state.health = 12;
      return { outcome: 'low_health', kills: [], health: 12 };
    }
    return call(m, p);
  }) as typeof call;
  const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
  t.is(a.f.did.filter(d => d === 'fight the brute').length, 1, 'one bout, then home');
  t.regex(r.text, /^nothing from the bastion at nether \(-44, 71, 233\); health 12, at 14 in the fight; back at overworld \(-562, 65, 2191\)$/);
  t.false(a.f.did.some(d => d.startsWith('look in -4')), 'no chest opened');
  t.is(a.f.state.dim, OVERWORLD);
  // the bout killed it, but at a cost the look after it finds under 14
  let g2: Game | undefined;
  const hurt = once(() => g2, /^fight piglin_brute/, f => { f.state.health = 13; });
  const a2 = await atStage3({ mobs: mobs(), onLook: hurt });
  g2 = a2.f;
  const r2 = await bastionRun(a2.f.ctx, HOUR, () => a2.later);
  t.regex(r2.text, /^bastion at nether \(-44, 71, 233\): nothing brought \(1 foe killed\); health 13, under 14; back at overworld/);
  t.false(a2.f.did.some(d => d.startsWith('look in -4')));

  // a second brute after the first is killed: one a trip
  let g: Game | undefined;
  const second = once(() => g, /^fight piglin_brute #99/, f => { f.mobs.push({ id: 100, name: 'piglin_brute', position: { x: f.state.pos.x + 8, y: 70, z: f.state.pos.z } }); });
  const b = await atStage3({ mobs: mobs(), onLook: second });
  g = b.f;
  const r3 = await bastionRun(b.f.ctx, HOUR, () => b.later);
  t.regex(r3.text, /; a second piglin brute near \(8 off\), one killed: it fights one a trip; back at overworld/);
  t.false(b.f.did.some(d => d.startsWith('look in -4') || d.startsWith('fight piglin_brute #100')));
  t.is(r3.worked, true, 'the brute killed: worked');
  t.is(r3.mark, undefined, 'a second brute: the place\'s own mark, doubling');

  // the brute and three turned piglins: four on it, more than it takes on
  let h: Game | undefined;
  const crowd = once(() => h, /^drink potion of long_strength$/, f => {
    // (three piglins turned on it about the waypoint, and the brute come within 16)
    f.mobs.push({ id: 83, name: 'piglin', position: { x: -50.5, y: 70, z: 236.5 } });
    for (const [i, m] of f.mobs.filter(x => x.name === 'piglin').entries()) { m.aggressive = true; m.position = { x: f.state.pos.x + 6 + i, y: 70, z: f.state.pos.z + 3 }; }
    f.mobs.find(m => m.id === 99)!.position = { x: f.state.pos.x + 14, y: 70, z: f.state.pos.z };
  });
  const c = await atStage3({ mobs: mobs(), onLook: crowd });
  h = c.f;
  const r4 = await bastionRun(c.f.ctx, HOUR, () => c.later);
  t.regex(r4.text, /; 3 piglins turned on it and a piglin brute \(4, more than 3\); back at overworld/);
  t.false(c.f.did.some(d => d.startsWith('look in -4')));

  // a brute let be (fought twice for nothing) is one of the crowd by a chest: with three calm piglins, four would be
  // on it as the chest opens, so it is not opened
  const d = await atStage3({ mobs: [...mobs(), { id: 83, name: 'piglin', position: { x: -47.5, y: 70, z: 234.5 } }], fightMisses: true });
  const r5 = await bastionRun(d.f.ctx, HOUR, () => d.later);
  t.true(d.f.said.includes('bastion: the piglin_brute #99 fought 2 times for nothing (unreachable): let be'), d.f.said.join('\n'));
  t.true(d.f.said.includes('bastion: 4 piglins within 16 of the chest at nether (-42, 70, 236): not opened (they would all turn)'), d.f.said.join('\n'));
  t.false(d.f.did.some(d2 => d2.startsWith('look in -4')), 'no chest opened');
  t.regex(r5.text, /more than 3 piglins by every chest it may open: let be/);
});

test.serial('the potions\' empty bottles are no loot: a trip that drank and turned back brought nothing (gain 0, not worked); a full trip says only the bastion\'s loot', async (t) => {
  let g: Game | undefined;
  // (a hoglin come: one brute would be the fight now)
  const come = once(() => g, /^drink potion of long_strength$/, f => { f.mobs.push({ id: 99, name: 'hoglin', position: { x: f.state.pos.x + 6, y: 70, z: f.state.pos.z } }); });
  const a = await atStage3({ bottles: true, onLook: come });
  g = a.f;
  const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
  t.is(carried(a.f, 'glass_bottle'), 2, 'the two bottles came home');
  t.is(r.gain, 0);
  t.is(r.worked, undefined);
  t.regex(r.text, /^nothing from the bastion at nether \(-44, 71, 233\); a hoglin near/);
  t.false(a.f.said.some(l => /glass_bottle/.test(l)));

  let h: Game | undefined;
  const b = await atStage3({ bottles: true, onLook: turnAtOpen(() => h) });
  h = b.f;
  const r2 = await bastionRun(b.f.ctx, HOUR, () => b.later);
  t.regex(r2.text, /^bastion at nether \(-44, 71, 233\): 6 gold_ingot, 3 gold_block, 2 ancient_debris, 1 netherite_ingot, 1 netherite_upgrade_smithing_template \(2 foes killed\);/);
  t.is(r2.gain, 13);
});

test.serial('a fight won at a cost: the bout that kills the last piglin turned on it took health (20 -> 17, over 14): no "hit taken", it goes on to the other chest', async (t) => {
  let g: Game | undefined;
  const a = await atStage3({ onLook: turnAtOpen(() => g) });
  g = a.f;
  const call = a.f.ctx.call.bind(a.f.ctx);
  (a.f.ctx as { call: typeof call }).call = (async (m: string, p?: Record<string, unknown>) => {
    const r = await call(m, p);
    // (the bout's own cost: the piglin's swings while the bot fought it)
    if (m === 'fight') a.f.state.health -= 1.5;
    return r;
  }) as typeof call;
  const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
  t.is(a.f.state.health, 17);
  t.false(/a hit taken/.test(r.text), r.text);
  t.true(a.f.did.includes('look in -46,70,230'), 'the other chest opened');
  t.regex(r.text, /^bastion at nether \(-44, 71, 233\): 6 gold_ingot, .*\(2 foes killed\); nothing more it may take by the way in; back at overworld/);
});

test.serial('a fight at 15-18 health with a second piglin by: the bridge\'s outnumbered stop (4 over, every Enemy within 12 counted, calm piglins and the victim too) is off, so the turned piglins are fought, not let be; the chase careful (a gold block broken turns every piglin); a fight that does stop at 14: home at once, no foe let be', async (t) => {
  let g: Game | undefined;
  const a = await atStage3({ onLook: turnAtOpen(() => g, f => { f.state.health = 17; }) });
  g = a.f;
  const asked: Record<string, unknown>[] = [];
  /** the bridge's Combat.fight stop, as 26.3's: minHealth, 4 over it with two Enemy within 12 unless crowdStop is false */
  const bridge = (f: Game, call: GoalContext['call']) => (async (m: string, p: Record<string, unknown> = {}) => {
    if (m === 'fight') {
      asked.push({ ...p });
      const near = f.mobs.filter(x => x.name === 'piglin' && Math.hypot(x.position.x - f.state.pos.x, x.position.y - f.state.pos.y, x.position.z - f.state.pos.z) <= 12).length;
      const stopAt = p.crowdStop !== false && near >= 2 ? Number(p.minHealth) + 4 : Number(p.minHealth);
      if (f.state.health <= stopAt) {
        f.did.push(`fight stopped at health ${f.state.health}`);
        return { outcome: 'low_health', kills: [], health: f.state.health };
      }
    }
    return call(m, p);
  }) as GoalContext['call'];
  (a.f.ctx as { call: GoalContext['call'] }).call = bridge(a.f, a.f.ctx.call.bind(a.f.ctx));
  const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
  t.true(asked.length >= 2 && asked.every(p => p.crowdStop === false && p.careful === true && p.minHealth === BASTION_LEAVE), JSON.stringify(asked));
  t.false(a.f.did.some(d => d.startsWith('fight stopped')), 'no bout stopped at 17');
  t.false(a.f.said.some(l => /let be/.test(l)), a.f.said.join('\n'));
  t.regex(r.text, /\(2 foes killed\)/);

  // the fight's own stop at 14 (the health rule's floor): home at once, the foe not booked as fought for nothing
  let h: Game | undefined;
  const b = await atStage3({ onLook: turnAtOpen(() => h, f => { f.state.health = 14; }) });
  h = b.f;
  (b.f.ctx as { call: GoalContext['call'] }).call = bridge(b.f, b.f.ctx.call.bind(b.f.ctx));
  const r2 = await bastionRun(b.f.ctx, HOUR, () => b.later);
  t.is(b.f.did.filter(d => d.startsWith('fight stopped')).length, 1, 'one bout, then home');
  t.false(b.f.said.some(l => /let be/.test(l)));
  t.false(b.f.did.includes('look in -46,70,230'), 'the other chest not opened');
  t.regex(r2.text, /; health 14, at 14 in the fight; back at overworld/);
});

test('the bridge\'s fight takes the bastion\'s two asks: crowdStop false drops the stop 4 over minHealth (every Enemy within 12 counted), careful holds Baritone\'s breaking and placing off for the chase and ends it however the fight ends', (t) => {
  const java = fs.readFileSync(path.join(process.cwd(), 'client-mod', 'src', 'claudebridge', 'Combat.java'), 'utf8');
  t.regex(java, /float stopAt = crowdStop && hostilesNear\(12\)\.size\(\) >= 2 \? minHealth \+ 4 : minHealth;/);
  // (as before by default: the overworld's fights keep the outnumbered stop, and break as they did)
  t.regex(java, /!p\.has\("crowdStop"\) \|\| p\.get\("crowdStop"\)\.getAsBoolean\(\), p\.has\("careful"\) && p\.get\("careful"\)\.getAsBoolean\(\)\);/);
  t.regex(java, /if \(careful\) Careful\.begin\(\);\s+Ticker\.add\(/);
  const end = java.slice(java.indexOf('boolean end(String outcome)'));
  t.true(end.indexOf('uncareful();') >= 0 && end.indexOf('uncareful();') < end.indexOf('c.ok('), 'ended before the reply');
  // a tick that throws is dropped by the Ticker without end: the careful hold must not outlive it
  t.regex(java, /try \{\s+return step\(m\);\s+\} catch \(RuntimeException e\) \{\s+uncareful\(\);/);
  t.regex(java, /if \(carefulOn\) \{ carefulOn = false; Careful\.end\(\); \}/);
});

test.serial('a double chest of the bastion\'s: opened by one half, both halves remembered looted', async (t) => {
  const half = at(-46, 70, 231);
  const a = await atStage3({}, [[at(-46, 69, 231), 'blackstone'], [half, 'chest']]);
  await bastionRun(a.f.ctx, HOUR, () => a.later);
  t.is(a.f.did.filter(d => d === 'look in -46,70,230' || d === 'look in -46,70,231').length, 1, 'one look into the pair');
  const looted = peekNether(a.w).bastion?.looted ?? [];
  for (const p of [OTHER, half]) t.true(looted.some(x => x.x === p.x && x.y === p.y && x.z === p.z), k(p));
});

test.serial('the potions: drunk only at the bastion\'s edge; one that does not take: not gone into (nothing opened, the mark as for a danger); none of strength carried or in stock: it does not set out', async (t) => {
  const a = await atStage3({ drinkFails: true });
  const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
  t.regex(r.text, /^nothing from the bastion at nether \(-44, 71, 233\); the potion of long_fire_resistance did not take \(not drunk\): not going into the bastion; back at overworld/);
  t.is(r.mark, 'same');
  t.false(a.f.did.some(d => d.startsWith('look in -4') || d.startsWith('fight')));

  const b = await atStage3({}, [], ['long_fire_resistance', 'long_fire_resistance']);
  const r2 = await bastionRun(b.f.ctx, HOUR, () => b.later);
  t.deepEqual(r2, { gain: 0, text: 'not setting out for the bastion: no potion of strength came out of the chests', untried: true });
  t.deepEqual(netherWalks(b.f), []);

  // the strength worn off in the bastion (a long fight): home
  let g: Game | undefined;
  const weak = once(() => g, /^look in -42,70,236$/, f => { f.state.strength = 0; });
  const c = await atStage3({ onLook: weak });
  g = c.f;
  const r3 = await bastionRun(c.f.ctx, HOUR, () => c.later);
  t.regex(r3.text, /; the strength drunk has worn off; back at overworld/);
  t.false(c.f.did.includes('look in -46,70,230'));
});

test.serial('the time bound at the bastion\'s edge: too little left to go in before the drinks: none drunk, home', async (t) => {
  const a = await atStage3();
  const WP = WAY[WAY.length - 1];
  let late = false;
  // (the clock jumps as it reaches the waypoint by the bastion: a minute of the 9 left, the way back over a minute)
  const now = () => { if (!late && Math.hypot(a.f.state.pos.x - WP.x - 0.5, a.f.state.pos.z - WP.z - 0.5) < 2) late = true; return late ? a.later + 8 * MINUTE : a.later; };
  const r = await bastionRun(a.f.ctx, HOUR, now);
  t.true(late);
  t.regex(r.text, /^nothing from the bastion at nether \(-44, 71, 233\); too little of the bastion trip's time left to go in; back at overworld \(-562, 65, 2191\)$/);
  t.false(a.f.did.some(d => d.startsWith('drink ')), 'no potion drunk');
  t.false(a.f.did.some(d => d.startsWith('look in -4')));
  t.is(r.mark, 'same', 'the time, not the place');
  t.is(a.f.state.dim, OVERWORLD);
});

test.serial('the time bound: out of time at the bastion (its 9 min nearly gone once the potions are drunk), it turns back at once and walks home through its own portal', async (t) => {
  const a = await atStage3();
  let late = false;
  const now = () => { if (!late && a.f.did.includes('drink potion of long_strength')) late = true; return late ? a.later + 8.5 * MINUTE : a.later; };
  const r = await bastionRun(a.f.ctx, HOUR, now);
  t.regex(r.text, /^nothing from the bastion at nether \(-44, 71, 233\); the bastion trip's time is up; back at overworld \(-562, 65, 2191\)$/);
  t.false(a.f.did.some(d => d.startsWith('look in -4')));
  t.is(a.f.state.dim, OVERWORLD);
});

test.serial('the strict rules at home: not at full health or food, the fire gear not worn, or no shield: it does not set out (untried)', async (t) => {
  const a = await atStage3();
  a.f.state.health = 18;
  const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
  t.deepEqual(r, { gain: 0, text: 'not setting out: health 18 < 20', untried: true });
  const b = await atStage3();
  b.f.inv.find(i => i.slot === 38)!.enchantments = [];
  const r2 = await bastionRun(b.f.ctx, HOUR, () => b.later);
  t.deepEqual(r2, { gain: 0, text: 'not setting out for the bastion: fire EPF 16 < 20 (the diamond_chestplate has protection 0 (4 wanted))', untried: true });
  t.deepEqual(netherWalks(b.f), []);
  t.is(peekNether(b.w).bastion?.trip, undefined, 'no trip under way: a death at home is no bastion death');
  const c = await atStage3();
  c.f.state.food = 19;
  const r3 = await bastionRun(c.f.ctx, HOUR, () => c.later);
  t.deepEqual(r3, { gain: 0, text: 'not setting out for the bastion: food 19 < 20', untried: true });
  const d = await atStage3();
  // (none carried and none in the chests: the kit fetches none)
  for (let i = d.f.inv.length - 1; i >= 0; i--) if (d.f.inv[i].name === 'shield') d.f.inv.splice(i, 1);
  for (const [key, list] of d.f.chests) d.f.chests.set(key, list.filter(x => x.name !== 'shield'));
  for (const x of Object.values(d.w.chestItems ?? {})) delete (x as Record<string, number>).shield;
  const r4 = await bastionRun(d.f.ctx, HOUR, () => d.later);
  t.true(r4.untried);
  t.regex(r4.text, /^not setting out.*shield/);
  t.deepEqual(netherWalks(d.f), []);
});

test.serial('courtesy: a bastion with a player\'s block within 16 (the bridge\'s strays) or a player seen within 64: refused for good, nothing taken, no potion drunk for it', async (t) => {
  const a = await atStage3({ zones: [ROOM_ZONE, { ...BASTION, strays: ['torch', 'oak_sign'] } as NetherZone] });
  const r = await bastionRun(a.f.ctx, HOUR, () => a.later);
  t.regex(r.text, /^nothing from the bastion at nether \(-44, 71, 233\); the bastion at nether \(-44, 71, 233\) has torch, oak_sign within 16 of it \(a player's\): refused for good, nothing taken; back at overworld/);
  t.false(a.f.did.some(d => d.startsWith('look in -4') || d.startsWith('fight') || d.startsWith('drink ')));
  t.like(peekNether(a.w).bastion?.refused?.[0], { ...SITE, why: 'torch, oak_sign within 16 of it' });
  t.is(bastionWay(a.w), undefined, 'never chosen again');

  const player: Mob = { id: 90, name: 'player', position: { x: -30.5, y: 70, z: 233.5 } };
  t.true(boxGap(zoneBox(BASTION), cellBox(at(-31, 70, 233))) <= PLAYER_NEAR);
  const b = await atStage3({ mobs: [player] });
  const r2 = await bastionRun(b.f.ctx, HOUR, () => b.later);
  t.regex(r2.text, /a player seen by the bastion \(nether \(-31, 70, 233\)\): refused for good; back at overworld/);
  t.like(peekNether(b.w).bastion?.refused?.[0], { why: 'a player seen by it at nether (-31, 70, 233)' });
  t.false(b.f.did.some(d => d.startsWith('look in -4')));
});

// ------------------------------------------------------------------------------------------------ a death there

test('a death on a bastion trip (between its start and its end) turns the bastion trips off for good, on top of the death ladder; one after it ended does not; brain-status says so; brain.json keeps it', (t) => {
  const w = setupWorld();
  Object.assign(netherOf(w), { linked: true, portal: { x: -79, y: 70, z: 266 }, stage: 3, stageTrips: 6 });
  netherOf(w).bastion = { trip: { from: T0 - 10 * MINUTE } };
  const lines = netherTick(lookAt([], 1000), w, { at: { x: -44, y: 70, z: 233 }, time: T0 - 2 * MINUTE, dimension: NETHER });
  t.deepEqual(lines, [
    'nether: a death at nether (-44, 70, 233): no trips until 17:38',
    'nether: stage 3 -> 2 after the death: 4/6 clean trips to stage 3',
    'nether: a death on a bastion trip: bastion trips off until the lead switches them back'
  ]);
  t.like(peekNether(w).bastion, { off: { at: T0 - 2 * MINUTE, why: 'a death on a bastion trip at nether (-44, 70, 233)' } });
  t.is(peekNether(w).fortress?.off, undefined, 'the fortress trips stay on');
  t.regex(netherLine(w, T0), /; bastion trips off \(a death on a bastion trip at nether \(-44, 70, 233\), 16:38\) until the lead switches them back/);
  Object.assign(netherOf(w), { stage: 3, stageTrips: 6 });
  t.deepEqual(bastionReady(lookAt(dressed([]), 1000, { now: T0 + 2 * HOUR }), w), { cause: 'hold', text: 'bastion trips off: a death on a bastion trip at nether (-44, 70, 233) (until the lead switches them back)' });
  // as brain.json holds it (the fortress's shape): kept whole, the half-written parts let go
  const raw = setupWorld();
  raw.nether = { stage: 3, bastion: { off: { at: T0, why: 'x' }, trip: { from: T0, to: 'later' }, looted: [TREASURE, { x: 'a' }], refused: [{ ...SITE, why: 'torch', at: T0 }] } } as unknown as WorldMemory['nether'];
  t.deepEqual(netherOf(raw).bastion, { off: { at: T0, why: 'x' }, trip: { from: T0 }, looted: [TREASURE], refused: [{ ...SITE, why: 'torch', at: T0 }] });

  // a death after the trip ended: the bastion trips stay on; a trip left open ends at its first look home
  const v = setupWorld();
  Object.assign(netherOf(v), { linked: true, portal: { x: -79, y: 70, z: 266 }, stage: 3, stageTrips: 6 });
  netherOf(v).bastion = { trip: { from: T0 - 30 * MINUTE, to: T0 - 20 * MINUTE } };
  t.false(netherTick(lookAt([], 1000), v, { at: { x: -44, y: 70, z: 233 }, time: T0 - 2 * MINUTE, dimension: NETHER }).some(l => /bastion/.test(l)));
  t.is(peekNether(v).bastion?.off, undefined);
  const u = setupWorld();
  Object.assign(netherOf(u), { linked: true, portal: { x: -79, y: 70, z: 266 }, stage: 3, enteredAt: T0 - 5 * MINUTE });
  netherOf(u).bastion = { trip: { from: T0 - 6 * MINUTE } };
  netherTick(lookAt([], 1000, { now: T0 }), u, undefined);
  t.deepEqual(peekNether(u).bastion?.trip, { from: T0 - 6 * MINUTE, to: T0 });
});

test('the bastion switch on the brain: the lead turns it back on after a death (or off by hand), said in the log, saved', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-brain-')), 'brain.json');
  const rt = {
    actions: {}, call: async (m: string) => (m === 'inventory' ? { items: [] } : {}),
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...HOME }, block: { ...HOME }, timeOfDay: 1000, hashedSeed: '7', dimension: 'overworld', health: 20, food: 20 }),
    home: () => ({ ...HOME, dimension: 'overworld' }), lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => T0, goals: [], memoryFile: file });
  t.throws(() => brain.setBastionTrips(true, 'the lead'), { message: 'not in a world yet' });
  brain.setEnabled(true);
  await brain.tick();
  brain.setBastionTrips(false, 'the lead');
  t.like(brain.worldMemory()!.nether!.bastion, { off: { at: T0, why: 'switched off by the lead' } });
  t.regex(brain.status(), /nether bastion trips off \(by the lead\)/);
  brain.setBastionTrips(true, 'the lead');
  t.is(brain.worldMemory()!.nether!.bastion?.off, undefined);
  t.regex(brain.status(), /nether bastion trips on \(by the lead\)/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, WorldMemory>;
  t.is(Object.values(saved)[0].nether?.bastion?.off, undefined);
  brain.setEnabled(false);
});
