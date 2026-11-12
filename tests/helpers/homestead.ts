import type { ClientRuntime, InventoryItem } from '../../src/client/tools.js';
import { Brain, decide } from '../../src/client/brain/brain.js';
import type { Decline, Goal, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import { taskOf, workGoals, type WorkTask } from '../../src/client/brain/work.js';
import { LADDER } from '../../src/client/brain/worktasks.js';
import { explainIdle, type IdleCause } from '../../src/client/brain/idlelog.js';
import { pockets, room } from '../../src/client/brain/pockets.js';
import { activityAt } from '../../src/client/brain/schedule.js';
import { chestTotals } from '../../src/client/brain/chests.js';
import { readyFoodPoints } from '../../src/client/brain/food.js';

/**
 * The live homestead, as brain.json had it for the world `seed:5742536800344526386` at 16:40 UTC on 2026-11-12 (the
 * step-3 build, the enchanting room blocked on cane and leather for 86 tries), copied by hand: what the gates read and
 * nothing else (no heat map, no build jobs: none is going; no torch spots: the lights round is a stand-in in the
 * tests that use this). Its times are kept as they stood against that moment, `T0`. Tests that use it run in the
 * world `seed:1`: the structure store would read the live world's own structure files from the home folder.
 */

export const MINUTE = 60_000;
/** 16:40:00 UTC, Nov 12: three minutes after the copy's newest mark (every time below reads from here). */
export const T0 = Date.UTC(2026, 10, 12, 16, 40, 0);
export const HOME: Pos = { x: -549, y: 63, z: 2183 };
export const BED: Pos = { x: -537, y: 63, z: 2193 };

const at = (x: number, y: number, z: number): Pos => ({ x, y, z });

/** The 14 chests of the storage house, on three layers round the home cell. */
const CHESTS: Pos[] = [
  at(-551, 63, 2183), at(-547, 63, 2182), at(-547, 63, 2184), at(-547, 64, 2182), at(-551, 63, 2181), at(-549, 65, 2185), at(-551, 65, 2184),
  at(-551, 65, 2181), at(-547, 65, 2181), at(-547, 63, 2180), at(-547, 64, 2180), at(-551, 63, 2179), at(-551, 65, 2179), at(-547, 65, 2179)
];

/** The farm plot's farmland, row by row (z), the cells of each row by x: 62 of the plot's 81. */
const FARMLAND: Pos[] = ([
  [2161, -545, -537], [2162, -545, -537], [2163, -545, -537], [2164, -545, -537], [2165, -545, -542], [2165, -540, -537],
  [2166, -545, -543], [2166, -538, -537], [2167, -545, -544], [2167, -538, -537], [2168, -545, -544], [2168, -538, -537],
  [2169, -545, -543], [2169, -538, -537]
] as const).flatMap(([z, x1, x2]) => Array.from({ length: x2 - x1 + 1 }, (_, i) => at(x1 + i, 62, z)));

const CHEST_ITEMS: Record<string, Record<string, number>> = {
  '-551,63,2181': {
    wooden_hoe: 1, wooden_axe: 1, wooden_shovel: 1, wooden_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_hoe: 1, bow: 2, iron_hoe: 1, iron_shovel: 2,
    crossbow: 2, iron_sword: 1, iron_helmet: 1, iron_leggings: 1, iron_chestplate: 1, iron_boots: 1
  },
  '-547,63,2182': { wheat: 1046, egg: 9, sugar_cane: 34 },
  '-547,63,2180': { coal: 74, iron_ingot: 24, charcoal: 6, iron_nugget: 4, copper_ingot: 16, diamond: 2, raw_iron: 69, raw_copper: 10 },
  '-551,63,2179': { oak_log: 1216, birch_log: 10, stick: 378, oak_planks: 1 },
  '-551,63,2183': { bread: 860, cooked_beef: 3, apple: 10 },
  '-547,63,2184': { andesite: 154, granite: 111, gravel: 120, flint: 13, diorite: 68, smooth_basalt: 2, cobblestone: 491, cobbled_deepslate: 212, tuff: 44 },
  '-551,65,2179': {
    gray_wool: 1, ominous_bottle: 11, white_banner: 11, white_wool: 2, oak_stairs: 2, poppy: 1, birch_sign: 2, ladder: 1, enchanting_table: 1, birch_fence: 95,
    sunflower: 61, oak_fence: 5, crafting_table: 1, furnace: 1, glass_pane: 4, oak_leaves: 128, oak_sign: 4, cobblestone_wall: 5, rail: 3, chest: 1, birch_fence_gate: 2
  },
  '-547,65,2179': { leather: 7, arrow: 46, bone: 44, string: 14, glow_ink_sac: 2, feather: 10, spider_eye: 5, slime_ball: 9 },
  '-549,65,2185': { diorite: 37 },
  '-547,64,2180': { cobblestone: 422 },
  '-551,65,2181': { oak_log: 1728 },
  '-547,65,2181': {},
  '-547,64,2182': { stone_shovel: 1, bucket: 8, lead: 2 },
  '-551,65,2184': { oak_log: 540 }
};

const CHEST_ASSIGN: Record<string, string> = {
  '-551,63,2183': 'food', '-547,63,2182': 'farming', '-547,63,2184': 'stone', '-547,64,2182': 'gear', '-551,63,2181': 'gear', '-549,65,2185': 'stone',
  '-551,65,2184': 'wood', '-551,65,2181': 'wood', '-547,65,2181': 'stone', '-547,63,2180': 'ores', '-547,64,2180': 'stone', '-551,63,2179': 'wood',
  '-551,65,2179': 'misc', '-547,65,2179': 'mobdrops'
};
const CHEST_SIGNS: Record<string, string> = {
  '-551,63,2181': 'tools1', '-547,63,2180': 'ore1', '-551,63,2179': 'wood1', '-551,63,2183': 'food1', '-547,63,2182': 'seeds1', '-547,63,2184': 'stone1',
  '-549,65,2185': 'stone5', '-551,65,2179': 'misc1', '-547,65,2179': 'drops1', '-547,64,2180': 'stone2', '-551,65,2181': 'wood2', '-547,65,2181': 'stone3',
  '-547,64,2182': 'tools2', '-551,65,2184': 'wood3'
};

/** The zones the gates read (pens, plot, cane, trees, storage, fence, the mine start, the woods), as they stood. */
const ZONES = (): NonNullable<WorldMemory['zones']> => ({
  woods: [at(-388, 73, 2152)],
  mine: [at(-549, 63, 2127)],
  'storage:door': [at(-549, 63, 2186)],
  storage: [{ x: -552, y: 62, z: 2178, width: 7, length: 9 }],
  plot: [{ x: -545, y: 62, z: 2161, width: 9, length: 9 }],
  'pen:cow:gate': [at(-555, 63, 2171)],
  'pen:cow': [{ x: -558, y: 62, z: 2165, width: 7, length: 7 }],
  'pen:sheep:gate': [at(-539, 63, 2196)],
  'pen:sheep': [{ x: -542, y: 62, z: 2196, width: 7, length: 7 }],
  'fence:gate': [at(-549, 63, 2119), at(-533, 63, 2183), at(-549, 63, 2215), at(-565, 63, 2183)],
  fence: [{ x: -565, y: 62, z: 2119, width: 33, length: 97 }],
  trees: [{ x: -546, y: 62, z: 2133, width: 15, length: 11 }],
  'trees:sapling': [2134, 2138, 2142].flatMap(z => [-545, -541, -537, -533].map(x => at(x, 63, z))),
  // the five cells by the lake east of the yard (they have lost their water: the round cuts nothing)
  cane: [at(-519, 63, 2202), at(-520, 63, 2203), at(-518, 63, 2204), at(-526, 63, 2205), at(-524, 63, 2205)],
  'obsidian:cast': [at(-556, 62, 2180)],
  'lava:pool': [at(-415, 63, 1955)]
});

/** The chores' marks as they stood, in ms before T0 (the sort two days back, the signs 14 h: neither has been due since). */
const LAST_DONE_AGO: Record<string, number> = {
  chests: 23_612_269, project: 1_593_390, tidy: 2_378_990, repair: 3_164_391, lights: 3_159_791, stash: 2_498_790, furnace: 2_548_890, deep: 161_575_563,
  signs: 51_173_398, sort: 174_246_914, structures: 2_401_790, farm: 2_449_190, pens: 948_690, storage: 2_804_091, trees: 1_913_690, 'spare:iron': 3_196_291,
  cane: 2_378_490, 'spare:coal': 140_473_128, 'fruitless:spare:iron': 3_196_291, 'pens-fetch': 4_711_202, 'fruitless:sugar_cane': 2_545_090
};

/** The home rounds and the chores with a time of their own: what "done a minute ago" or "overdue" sets. */
export const ROUNDS = ['stash', 'tidy', 'sort', 'repair', 'lights', 'signs', 'furnace', 'farm', 'structures', 'storage', 'trees', 'pens', 'cane', 'chests', 'pens-fetch'];
/** What the stock trips and spare time found nothing of lately, and when they last went: the same for them. */
export const TRIES = ['fruitless:sugar_cane', 'spare:iron', 'fruitless:spare:iron'];

/** The live world, fresh each call. */
export function liveWorld(): WorldMemory {
  return {
    landmarks: { chests: CHESTS.map(p => ({ ...p })), farmland: FARMLAND.map(p => ({ ...p })), bed: { ...BED }, furnace: at(-542, 63, 2193), table: at(-543, 63, 2193), foundAt: T0 - 728_381 },
    leash: 96,
    yard: { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 },
    zones: ZONES(),
    chestItems: structuredClone(CHEST_ITEMS),
    chestAssign: { ...CHEST_ASSIGN },
    chestSigns: { ...CHEST_SIGNS },
    lastDone: Object.fromEntries(Object.entries(LAST_DONE_AGO).map(([k, ago]) => [k, T0 - ago])),
    progress: {
      done: ['storage-more', 'storage', 'fence-clear', 'yard-level', 'plot1', 'pen-cow', 'pen-sheep', 'home', 'perimeter', 'trees', 'cane'],
      journal: [{ at: T0 - 1_593_390, text: 'an enchanting room: build the enchanting room blocked (gathering for the enchanting room: short of 96 sugar_cane, 38 leather)' }],
      current: { id: 'enchanting', step: 2, data: { obsidianTurn: 3, site: { x: -547, z: 2206, width: 7, length: 7, rotated: false, y: 62 }, door: 'north', wood: 'oak' } },
      // (the step's 86th try was 26 min ago, and its wait, the longest back-off of 24 min, ran out 2.6 min ago)
      blocked: { id: 'enchanting/2', n: 86, at: T0 - 1_593_390, need: { sugar_cane: 135, leather: 45 } },
      blockedUntil: { storage: T0 - 412_451_390, perimeter: T0 - 351_987_648, plot1: T0 - 389_802_109, trees: T0 - 353_524_346, 'pen-cow': T0 - 369_715_805, cane: T0 - 339_143_483, 'pen-sheep': T0 - 368_955_204, enchanting: T0 - 153_390 },
      need: { sugar_cane: 96, leather: 38 }
    },
    community: {
      chests: { community1: at(-437, 68, 2134) }, nextId: 2,
      missions: [{ id: 1, item: 'diamond', count: 8, chest: 'community1', gathered: 8, delivered: 8, status: 'done', createdAt: T0 - 396_164_501, updatedAt: T0 - 375_481_363, note: 'all 8 delivered' }]
    },
    lavaCasting: true,
    storageFull: [],
    reserved: {},
    fenceClearFor: '-565,2167,-533,2199',
    yardLevelFor: '-565,2167,-533,2199'
  } as WorldMemory;
}

/**
 * The project as it can or cannot go on: `blocked` as it stood (the enchanting room short of cane and leather, its
 * next try 24 min after the last); not blocked, the same step free to try now and nothing remembered short.
 */
export function withProject(world: WorldMemory, blocked: boolean): WorldMemory {
  const p = world.progress!;
  if (blocked) {
    p.blocked = { ...p.blocked!, at: T0 - MINUTE };
    p.blockedUntil = { ...p.blockedUntil, enchanting: T0 + 23 * MINUTE };
  } else {
    delete p.blocked;
    delete p.need;
    p.blockedUntil = {};
  }
  return world;
}

/** The rounds and the trips' tries done `ago` ms before T0. */
export function roundsAt(world: WorldMemory, ago: number, keys = [...ROUNDS, ...TRIES]): WorldMemory {
  for (const k of keys) world.lastDone![k] = T0 - ago;
  return world;
}

/**
 * The depleted home: no string, under 8 raw iron, 64 coal, the cane patch grown to its 24 cells, and every far variant
 * dry (the marks of `far`, written a minute ago). Level 30 is the snapshot's.
 */
export function depletedWorld(far: string[] = ['surface:coal']): WorldMemory {
  const w = liveWorld();
  const c = w.chestItems!;
  delete c['-547,65,2179'].string;
  c['-547,63,2180'].raw_iron = 5;
  c['-547,63,2180'].coal = 64;
  delete c['-547,63,2180'].charcoal;
  // 19 more cells along the same shore, east of the five
  w.zones!.cane = [...w.zones!.cane, ...Array.from({ length: 19 }, (_, i) => at(-517 + i % 10, 63, 2206 + Math.floor(i / 10)))];
  w.work = { dry: Object.fromEntries(far.map(k => [k, { n: 1, at: T0 - MINUTE }])), next: {}, sites: {}, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } };
  return w;
}

// ---- the pockets ----

/** The live kept kit (Nov 11, A13): 20 slots, the diamond armour and the shield worn. Its 2 oak logs are all the stash would take. */
export const KEPT: readonly (readonly [string, number])[] = [
  ['diamond_pickaxe', 1], ['diamond_shovel', 1], ['diamond_sword', 1], ['diamond_hoe', 1], ['iron_pickaxe', 1], ['iron_pickaxe', 1], ['iron_axe', 1],
  ['torch', 19], ['bread', 62], ['apple', 64], ['cobblestone', 22], ['cobblestone', 10], ['dirt', 39], ['dirt', 25], ['rotten_flesh', 8], ['oak_sapling', 7],
  ['wheat_seeds', 18], ['wheat_seeds', 14], ['bucket', 1], ['oak_log', 2]
];
/** The deep kit in ten slots: every tool once and the spare pickaxe, a stack of torches, 32 blocks, food. */
const SMALL: readonly (readonly [string, number])[] = [
  ['diamond_pickaxe', 1], ['iron_pickaxe', 1], ['iron_axe', 1], ['diamond_shovel', 1], ['diamond_sword', 1], ['diamond_hoe', 1], ['torch', 19], ['cobblestone', 32],
  ['bread', 62], ['apple', 64]
];
export const WORN: InventoryItem[] = ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'diamond_helmet', 'shield'].map((name, i) => ({ slot: 36 + i, name, count: 1 }));
/** What a tree or farm round brings home: the stash puts all of it away. */
const HAUL = ['oak_log', 'wheat', 'oak_log', 'wheat', 'stick', 'birch_log'];
/** Food the stash leaves carried, one kind a slot under its stack: nothing in it is loose. */
const MEALS = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'baked_potato', 'cooked_cod', 'cooked_salmon', 'cookie', 'melon_slice', 'dried_kelp',
  'carrot', 'pumpkin_pie', 'cooked_rabbit', 'beetroot', 'sweet_berries', 'glow_berries', 'honey_bottle'];

export type Filling = 'a round\'s haul' | 'kept things only';

/**
 * Pockets of `slots` used: the ten-slot kit below 20, else the live kept kit and then a round's haul (all of it for the
 * chests) or food the stash keeps (nothing loose: the kit's two logs left out as well). `kit` false: the lights round
 * took the torches down to 4 (the deep kit wants 16; the chests hold the coal and sticks for more).
 */
export function pocketsOf(slots: number, kit: boolean, fill: Filling): InventoryItem[] {
  const base = slots < 20 ? SMALL.slice(0, slots) : fill === 'kept things only' ? KEPT.slice(0, 19) : KEPT;
  const kept = base.map(([name, count]) => [name, !kit && name === 'torch' ? 4 : count] as const);
  const extra = Array.from({ length: Math.max(0, slots - kept.length) }, (_, i) => (fill === 'a round\'s haul' ? [HAUL[i % HAUL.length], 64] as const : [MEALS[i], 16] as const));
  return [...kept, ...extra].map(([name, count], slot): InventoryItem => ({ slot, name, count })).concat(WORN.map(i => ({ ...i })));
}

/** A look at home by day (the time of day `tod`), awake, well and fed, carrying `items`. */
export function lookAt(items: InventoryItem[], tod: number, over: Partial<Snapshot> = {}): Snapshot {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return {
    now: T0, timeOfDay: tod, activity: activityAt(tod), health: 20, food: 20, position: { ...HOME }, dimension: 'overworld', sleeping: false, raining: false,
    thundering: false, process: null, items, counts, slotsUsed: items.filter(i => i.slot < 36).length, home: { ...HOME, dimension: 'overworld' }, distHome: 0,
    xpLevel: 12, ...over
  };
}

// ---- the rungs of steps 5 and 6, as the design's table has their ready() ----

const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const SIDES = ['north', 'east', 'south', 'west'];
/** Carried and in the chests. */
const have = (s: Snapshot, world: WorldMemory, item: string) => (s.counts.get(item) ?? 0) + (chestTotals(world)[item] ?? 0);
/** What the blocked step still waits for of `item` (its totals less what the home has). */
const stillShortOf = (s: Snapshot, world: WorldMemory, item: string) => Math.max(0, (world.progress?.blocked?.need?.[item] ?? 0) - have(s, world, item));
const unneeded = (text: string): Decline => ({ cause: 'unneeded', text });
export const CANE_CELLS = 24;
export const SCOUT_TARGETS = ['sugar_cane', 'lava', 'cow', 'sheep', 'iron_ore', 'coal_ore'];

/**
 * The six rungs of steps 5 and 6 (design section 5, rows 1-3 and 7-9), as stand-ins: their variants and ready() are
 * the table's, their runs a test's own (`run`). Nothing else of theirs is modelled.
 */
export function laterRungs(run: (name: string) => WorkTask['run'] = () => async () => ({ gain: 0, text: 'not modelled' })): WorkTask[] {
  return [
    {
      name: 'cane patch', rank: 1, reach: 'near', room: 'yard', budgetMs: 4 * MINUTE,
      variants: (s, world) => {
        const cells = world.zones?.cane ?? [];
        const mid = cells.length ? { x: cells.reduce((a, c) => a + c.x, 0) / cells.length, z: cells.reduce((a, c) => a + c.z, 0) / cells.length } : s.home!;
        return [{ id: 'shore', dist: Math.round(horiz(mid, s.home ?? mid)) }];
      },
      ready: (s, world) => ((world.zones?.cane?.length ?? 0) >= CANE_CELLS ? unneeded(`${world.zones!.cane!.length} cells`)
        : have(s, world, 'sugar_cane') < 1 ? unneeded('no cane to plant') : null),
      run: run('cane patch')
    },
    {
      name: 'cows', rank: 2, reach: 'far', room: 'trip', budgetMs: 6 * MINUTE, terrain: true,
      variants: (_s, world) => SIDES.map(id => ({ id, dist: world.leash })),
      ready: (s, world) => {
        if (!stillShortOf(s, world, 'leather')) return unneeded('no leather wanted');
        const pen = world.work?.pen?.cow;
        return pen && s.now - pen.at < 30 * MINUTE && pen.adults >= 2 ? unneeded(`${pen.adults} cows in the pen`) : null;
      },
      run: run('cows')
    },
    {
      name: 'cane', rank: 3, reach: 'far', room: 'trip', budgetMs: 6 * MINUTE, terrain: true,
      variants: (s, world) => [...(world.work?.sites?.cane ?? []).filter(p => s.home && horiz(p, s.home) <= world.leash).map(p => ({ id: `${p.x},${p.z}`, dist: Math.round(horiz(p, s.home!)) })),
        ...SIDES.map(id => ({ id, dist: world.leash }))],
      ready: (s, world) => (stillShortOf(s, world, 'sugar_cane') ? null : unneeded('no cane wanted')),
      run: run('cane')
    },
    {
      name: 'scout', rank: 7, reach: 'far', room: 'trip', budgetMs: 4 * MINUTE, terrain: true,
      variants: (_s, world) => SIDES.map(id => ({ id, dist: world.leash })),
      ready: (_s, world) => (SCOUT_TARGETS.every(t => (world.work?.sites?.[t]?.length ?? 0) >= 4) ? unneeded('4 sites of each') : null),
      run: run('scout')
    },
    {
      name: 'yard', rank: 8, reach: 'yard', room: 'yard', budgetMs: 4 * MINUTE,
      variants: () => [{ id: 'plot', dist: 0 }],
      ready: (_s, world) => ((chestTotals(world).wheat ?? 0) >= 128 ? unneeded(`${chestTotals(world).wheat} wheat stored`) : null),
      run: run('yard')
    },
    {
      name: 'fish', rank: 9, reach: 'near', room: 'yard', budgetMs: 4 * MINUTE,
      variants: () => [{ id: 'water', dist: 30 }],
      ready: (s, world) => {
        const stored = readyFoodPoints(new Map(Object.entries(chestTotals(world))));
        const why = readyFoodPoints(s.counts) + stored < 60 || (!!world.zones?.['enchanting:table']?.length && (s.xpLevel ?? 0) < 30);
        if (!why) return unneeded('larder stocked, no levels wanted');
        const rod = (s.counts.get('fishing_rod') ?? 0) > 0 || (have(s, world, 'stick') >= 3 && have(s, world, 'string') >= 2);
        return rod ? null : unneeded('no rod, and no string for one');
      },
      run: run('fish')
    }
  ];
}

// ---- the grid: the real goal list asked over the homestead's states ----

const RT = {
  actions: {}, call: async () => ({}), status: async () => ({ inWorld: true, username: 'Bot', screen: null }), home: () => ({ ...HOME, dimension: 'overworld' }),
  lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
  restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
} as unknown as ClientRuntime;
/** The goal list as the brain builds it. */
export const realGoals = (): Goal[] => (new Brain(RT, { tickMs: 1e9, now: () => T0 }) as unknown as { goals: Goal[] }).goals;
/** The same with the rungs of steps 5 and 6 on the ladder beside this step's three, in their ranks. */
export const wholeGoals = (): Goal[] => realGoals().flatMap(g => (!taskOf(g) ? [g] : g.name === 'work: trip kit' ? workGoals(() => undefined, [...LADDER, ...laterRungs()], () => T0) : []));

export const SLOTS = [10, 26, 27, 30, 31, 33, 34, 35, 36];
export const TIMES = [0, 3000, 5000, 6000, 6800, 8000, 8520, 9000, 9800, 10400, 10700];
export const FILLS: Filling[] = ['a round\'s haul', 'kept things only'];
/** Every rung of the later steps that goes out to the leash: the depleted home has each of their variants dry. */
export const FAR_LATER = ['cows', 'cane', 'scout'].flatMap(t => ['north', 'east', 'south', 'west'].map(side => `${t}:${side}`));

export interface Cell {
  home: 'live' | 'depleted'; rounds: 'done a minute ago' | 'overdue'; fill: Filling; slots: number; tod: number; blocked: boolean; kit: boolean;
  /** the goal chosen and its urgency, or the lead cause and its text */
  chose?: string; urgency?: number; lead?: IdleCause; why?: string;
  /** what the stash would empty, and the deep rung's room */
  loose: number; deepRoom: 'ok' | 'stash' | 'no';
  /** the deep rung's urgency in this cell */
  deep: number;
}

/**
 * Every cell: the live and the depleted home (its far variants `far` dry), the home rounds done a minute ago or an
 * hour ago (the stock trips' and spare time's tries a minute ago either way: they are not rounds), a round's haul or
 * kept things only, the pockets, the hour, the project blocked or not, the kit ready or short of torches. At home.
 */
export function grid(goals: Goal[], far: string[]): Cell[] {
  const cells: Cell[] = [];
  const urgency = (g: Goal, s: Snapshot, w: WorldMemory) => g.urgency?.(s, w) ?? g.priority;
  const deep = goals.find(g => g.name === 'work: deep')!;
  for (const home of ['live', 'depleted'] as const) for (const rounds of ['done a minute ago', 'overdue'] as const) for (const fill of FILLS)
    for (const slots of SLOTS) for (const tod of TIMES) for (const blocked of [true, false]) for (const kit of [true, false]) {
      const world = (): WorldMemory => {
        const w = withProject(home === 'live' ? liveWorld() : depletedWorld(far), blocked);
        roundsAt(w, MINUTE, TRIES);
        return roundsAt(w, rounds === 'overdue' ? 61 * MINUTE : MINUTE, ROUNDS);
      };
      const s = lookAt(pocketsOf(slots, kit, fill), tod, { xpLevel: home === 'live' ? 12 : 30 });
      const w = world();
      const cell: Cell = { home, rounds, fill, slots, tod, blocked, kit, loose: pockets(s, w, 'deep').loose, deepRoom: room('deep', s, w), deep: urgency(deep, s, w) };
      const d = decide(s, w, goals, new Map());
      if (d) { cell.chose = d.goal.name; cell.urgency = urgency(d.goal, s, w); } else {
        // (a fresh world: the project's gate writes down a milestone it finds in place, when the brain decides)
        const why = explainIdle(s, world(), goals, new Map(), new Map())[0];
        cell.lead = why.cause;
        cell.why = why.text;
      }
      cells.push(cell);
    }
  return cells;
}

export const showCell = (c: Cell) => `${c.home}, rounds ${c.rounds}, ${c.fill}, ${c.slots}/36 (${c.loose} loose), tod ${c.tod}, project ${c.blocked ? 'blocked' : 'free'}, kit ${c.kit ? 'ready' : 'short'}`;

/** The idle cells by home, lead cause and text (the slot count left out): how many. */
export function idleCount(cells: Cell[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cells.filter(x => !x.chose)) {
    const k = `${c.home}: ${c.lead}: ${c.why?.replace(/^\d+\/36/, 'N/36')}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** The idle cells by home, lead cause and text, with where they are (rounds, fillings, slots, hours): for the report. */
export function idleTable(cells: Cell[]): string {
  const by = new Map<string, Cell[]>();
  for (const c of cells.filter(x => !x.chose)) {
    const k = `${c.home}: ${c.lead}: ${c.why?.replace(/^\d+\/36/, 'N/36')}`;
    by.set(k, [...(by.get(k) ?? []), c]);
  }
  const span = (xs: (string | number)[]) => [...new Set(xs)].sort((a, b) => Number(a) - Number(b)).join(',');
  return [...by].sort((a, b) => b[1].length - a[1].length).map(([k, cs]) => `${String(cs.length).padStart(4)}  ${k}\n      rounds ${span(cs.map(c => c.rounds))}; ` +
    `${span(cs.map(c => c.fill))}; slots ${span(cs.map(c => c.slots))}; tod ${span(cs.map(c => c.tod))}; project ${span(cs.map(c => (c.blocked ? 'blocked' : 'free')))}; kit ${span(cs.map(c => (c.kit ? 'ready' : 'short')))}`).join('\n');
}
