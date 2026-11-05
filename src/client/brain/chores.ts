import { AVOID_UNLESS_ASKED } from '../../food.js';
import { foodsFor26 } from '../tools.js';
import type { Goal, GoalContext, Snapshot } from './goals.js';
import { COOKS_TO } from './food.js';
import { chestTotals, key, peekChest, rememberReply, storeInChests, takeFromChests } from './chests.js';
import { assignChests, CATEGORIES, depositPlan, misplaced, type ChestAssign } from './storage.js';
import { kitNeeds, stashPlan, type KitNeed, type PlanStep } from './kit.js';
import { planTorches, spawnableCells, yardBox } from './lighting.js';
import { daylightLeft } from './schedule.js';
import { farmCentre, type Pos, type WorldMemory } from './memory.js';
import type { Box } from '../survey.js';

/**
 * The chores that keep the bot equipped and its home in order: emptying its pockets into the chests, smelting ore,
 * replacing worn tools and armour, fetching materials, and keeping the yard lit so nothing spawns in it.
 */

/** Near enough home for chores at the chests and furnace. */
const NEAR_HOME = 10;
const MINUTE = 60_000;

const awakeAtHome = (s: Snapshot) => !s.sleeping && s.dimension === 'overworld' && !!s.home && s.distHome <= NEAR_HOME;
const since = (world: WorldMemory, chore: string, now: number) => now - (world.lastDone?.[chore] ?? 0);
const done = (world: WorldMemory, chore: string, now: number) => { world.lastDone ??= {}; world.lastDone[chore] = now; };

let foodNames: Set<string> | undefined;
/** Everything edible worth carrying, raw food that cooks included. */
function foods(): Set<string> {
  foodNames ??= new Set(Object.keys(foodsFor26()).filter(n => !AVOID_UNLESS_ASKED.has(n)).concat(Object.keys(COOKS_TO)));
  return foodNames;
}

/** What the project in hand is gathering and building with: stays carried (the stash put a trip's logs away). */
function projectCarry(world: WorldMemory): Set<string> {
  return new Set(world.progress?.carry ?? []);
}

/** Look in every home chest not looked in for a while (plans use what they hold). */
async function refreshChests(ctx: GoalContext, maxAgeMs = 10 * MINUTE): Promise<void> {
  if (since(ctx.world, 'chests', ctx.s.now) < maxAgeMs && ctx.world.landmarks.chests.every(c => ctx.world.chestItems?.[key(c)])) return;
  for (const c of ctx.world.landmarks.chests) await peekChest(ctx, c).catch(e => ctx.progress(`chest at ${key(c)}: ${(e as Error).message}`));
  done(ctx.world, 'chests', ctx.s.now);
}

// ------------------------------------------------------------------------------------------------ stash

/** Empty the pockets into the home chests: when nearly full, and once in a while when home anyway. */
export const stash: Goal = {
  name: 'stash',
  priority: 55,
  timeoutMs: 6 * MINUTE,
  retryMs: 10 * MINUTE,
  wants: (s, world) => {
    if (!awakeAtHome(s) || !world.landmarks.chests.length) return null;
    const plan = stashPlan(s.items, { foods: foods(), keep: projectCarry(world) });
    if (!plan.deposit.length && !plan.drop.length) return null;
    if (s.slotsUsed >= 27) return `${s.slotsUsed}/36 slots used`;
    if (since(world, 'stash', s.now) > 30 * MINUTE && plan.deposit.length >= 3) return `${plan.deposit.length} kinds of things to put away`;
    return null;
  },
  run: async ctx => {
    const plan = stashPlan(ctx.s.items, { foods: foods(), keep: projectCarry(ctx.world) });
    const names = (n: string) => ctx.s.items.filter(i => i.name === n && i.slot < 36).length;
    let stored = 0;
    const deposit = plan.deposit.filter(e => e.slot === undefined || names(e.name) <= 1);
    // a worse duplicate of a kept tool shares its name: store-in-chest can't tell them apart, so it stays carried
    if (ctx.world.landmarks.chests.length >= 3) {
      // sorted: each kind of thing to its own chest
      const assign = chestAssignment(ctx.world);
      const want = new Map(deposit.map(e => [e.name, e.count] as const));
      const total = (n: string) => ctx.s.items.filter(i => i.name === n && i.slot < 36).reduce((a, i) => a + i.count, 0);
      const sorted = depositPlan(ctx.s.items, item => (want.has(item.name) ? total(item.name) - want.get(item.name)! : item.count), assign, ctx.world.chestItems ?? {});
      for (const m of sorted.moves) {
        const [x, y, z] = m.chest.split(',').map(Number);
        const r = await ctx.act('store-in-chest', { x, y, z, item: m.name, count: m.count });
        rememberReply(ctx.world, { x, y, z }, r.text);
        stored += Number(/^Stored (\d+)/.exec(r.text)?.[1] ?? 0);
      }
      ctx.world.storageFull = sorted.full;
      for (const u of sorted.unplaced) stored += await storeInChests(ctx, u.name, u.count);
    } else {
      for (const e of deposit) stored += await storeInChests(ctx, e.name, e.count);
    }
    done(ctx.world, 'stash', ctx.s.now);
    let dropped = 0;
    if (plan.drop.length) {
      // thrown where the bot stands it picks them straight back up: throw them at the edge of the yard, on the side
      // away from the farm (the farm round collected the leaf litter thrown by it a minute before), and walk off
      const home = ctx.s.home!;
      const f = farmCentre(ctx.world);
      const dx = f ? home.x - f.x : -1, dz = f ? home.z - f.z : -1;
      const len = Math.hypot(dx, dz) || 1;
      const dump = { x: Math.round(home.x + dx / len * 14), y: home.y, z: Math.round(home.z + dz / len * 14) };
      await ctx.act('move-to-position', { ...dump, range: 2, timeoutMs: 60_000 });
      for (const e of plan.drop) {
        const r = await ctx.act('drop-item', { item: e.name, count: e.count });
        const m = /^Dropped (\d+)/.exec(r.text);
        if (m) dropped += Number(m[1]);
      }
      await ctx.act('go-home', { name: 'home', timeoutMs: 120_000 });
    }
    ctx.progress(`stored ${stored}, dropped ${dropped}`);
    return `put ${stored} item(s) in the chests${dropped ? `, threw away ${dropped} junk` : ''}`;
  }
};

/** Which home chest holds which kind of thing: kept, extended to new chests. */
export function chestAssignment(world: WorldMemory): ChestAssign {
  world.chestAssign = assignChests(world.landmarks.chests, CATEGORIES, world.chestItems ?? {}, world.chestAssign ?? {});
  return world.chestAssign;
}

/** Now and then, by day at home: move things sitting in the wrong chest to their own. */
export const sortStorage: Goal = {
  name: 'sort',
  priority: 20,
  timeoutMs: 6 * MINUTE,
  retryMs: 20 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || !awakeAtHome(s) || world.landmarks.chests.length < 3 || s.slotsUsed > 28) return null;
    if (since(world, 'sort', s.now) < 30 * MINUTE) return null;
    const moves = misplaced(chestAssignment(world), world.chestItems ?? {});
    return moves.length ? `${moves.length} kind(s) of things in the wrong chest` : null;
  },
  run: async ctx => {
    done(ctx.world, 'sort', ctx.s.now);
    await refreshChests(ctx, 0);
    let moved = 0;
    for (const m of misplaced(chestAssignment(ctx.world), ctx.world.chestItems ?? {})) {
      const [fx, fy, fz] = m.from.split(',').map(Number);
      const [tx, ty, tz] = m.to.split(',').map(Number);
      const t = await ctx.act('take-from-chest', { x: fx, y: fy, z: fz, item: m.name, count: m.count });
      rememberReply(ctx.world, { x: fx, y: fy, z: fz }, t.text);
      if (!/^Took/.test(t.text)) continue;
      const r = await ctx.act('store-in-chest', { x: tx, y: ty, z: tz, item: m.name, count: m.count });
      rememberReply(ctx.world, { x: tx, y: ty, z: tz }, r.text);
      if (/^Stored/.test(r.text)) moved++;
    }
    return `moved ${moved} kind(s) of things to their own chest`;
  }
};

// ------------------------------------------------------------------------------------------------ smelt

const ORES: Record<string, string> = { raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot' };
const FUELS = ['coal', 'charcoal', 'oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log', 'cherry_log', 'mangrove_log', 'oak_planks', 'birch_planks', 'spruce_planks'];

/** Raw ore carried home: smelt it at the home furnace. */
export const smelt: Goal = {
  name: 'smelt',
  priority: 50,
  timeoutMs: 10 * MINUTE,
  retryMs: 10 * MINUTE,
  wants: (s, world) => {
    if (!awakeAtHome(s) || !world.landmarks.furnace) return null;
    const ore = Object.keys(ORES).find(o => (s.counts.get(o) ?? 0) > 0);
    if (!ore || !FUELS.some(f => (s.counts.get(f) ?? 0) > 0)) return null;
    return `${s.counts.get(ore)} ${ore} to smelt`;
  },
  run: async ctx => {
    const did: string[] = [];
    for (const ore of Object.keys(ORES)) {
      const n = ctx.s.counts.get(ore) ?? 0;
      const fuel = FUELS.find(f => (ctx.s.counts.get(f) ?? 0) > 0);
      if (!n || !fuel) continue;
      const r = await ctx.act('smelt-item', { ...ctx.world.landmarks.furnace!, inputItem: ore, inputCount: n, fuelItem: fuel, takeOutput: true, timeoutMs: n * 10_500 + 15_000 });
      did.push(r.ok ? `smelted ${n} ${ore}` : `could not smelt ${ore}: ${r.text}`);
      ctx.progress(did.at(-1)!);
    }
    return did.join('; ') || 'nothing to smelt';
  }
};

// ------------------------------------------------------------------------------------------------ kit

const doable = (n: KitNeed) => n.plan.some(st => 'take' in st || 'craft' in st);
const label = (n: KitNeed) => `${'spare' in n && n.spare ? 'spare ' : ''}${n.kind} (${n.why})`;

/** Tools and armour worn out or missing, torches or throwaway blocks short: take from the chests or craft. */
export const kit: Goal = {
  name: 'kit',
  priority: 60,
  timeoutMs: 8 * MINUTE,
  retryMs: 10 * MINUTE,
  wants: (s, world) => {
    if (!awakeAtHome(s)) return null;
    if (world.landmarks.chests.some(c => !world.chestItems?.[key(c)])) return 'look in the home chests';
    const needs = kitNeeds(s.items, chestTotals(world)).filter(doable);
    return needs.length ? `needs ${needs.map(label).join(', ')}` : null;
  },
  run: async ctx => {
    await refreshChests(ctx, 0);
    const inv = await ctx.call<{ items: Snapshot['items'] }>('inventory');
    const needs = kitNeeds(inv.items, chestTotals(ctx.world));
    const did: string[] = [];
    for (const need of needs.filter(doable)) {
      for (const step of need.plan) {
        const r = await runStep(ctx, step);
        if (r) { did.push(r); ctx.progress(`${label(need)}: ${r}`); }
      }
    }
    return did.join('; ') || 'nothing could be done (materials ran short)';
  }
};

async function runStep(ctx: GoalContext, step: PlanStep): Promise<string | undefined> {
  if ('gather' in step) return undefined; // the stock goal fetches materials
  if ('take' in step) {
    const got = await takeFromChests(ctx, step.take, step.count);
    return got ? `took ${got} ${step.take}` : `no ${step.take} in the chests after all`;
  }
  for (const [item, n] of Object.entries(step.fromChest ?? {})) await takeFromChests(ctx, item, n);
  for (const pre of step.first ?? []) {
    const r = await ctx.act('craft-item', { outputItem: pre.craft, amount: pre.times });
    if (!r.ok) return `could not craft ${pre.craft}: ${r.text}`;
  }
  const r = await ctx.act('craft-item', { outputItem: step.craft, amount: step.times });
  return r.ok ? `crafted ${step.craft}${step.times > 1 ? ` x${step.times}` : ''}` : `could not craft ${step.craft}: ${r.text}`;
}

// ------------------------------------------------------------------------------------------------ stock

/** Keep at least this much of each at home (carried and in the chests together). */
export const STOCK: { name: string; want: number; mine: string; counts: RegExp }[] = [
  { name: 'log', want: 32, mine: 'oak_log,birch_log,spruce_log,dark_oak_log,acacia_log,jungle_log,cherry_log', counts: /_log$/ },
  { name: 'cobblestone', want: 64, mine: 'stone,cobblestone', counts: /^(cobblestone|cobbled_deepslate)$/ },
  { name: 'coal', want: 16, mine: 'coal_ore,deepslate_coal_ore', counts: /^(coal|charcoal)$/ },
  { name: 'iron_ingot', want: 16, mine: 'iron_ore,deepslate_iron_ore', counts: /^(iron_ingot|raw_iron)$/ }
];

/** After a trip that found none of something, leave it this long (try the next thing; what's near may be out of reach). */
const FRUITLESS_WAIT = 30 * MINUTE;

/** How short the home is of each stock item (kit gathering needs on top), most urgent first. */
export function stockShort(s: Snapshot, world: WorldMemory): { name: string; short: number; mine: string; counts: RegExp }[] {
  const chest = chestTotals(world);
  const have = (re: RegExp) => [...s.counts].filter(([n]) => re.test(n)).reduce((a, [, k]) => a + k, 0) +
    Object.entries(chest).filter(([n]) => re.test(n)).reduce((a, [, k]) => a + k, 0);
  const extra: Record<string, number> = {};
  for (const n of kitNeeds(s.items, chest)) {
    for (const st of n.plan) if ('gather' in st) for (const [k, v] of Object.entries(st.gather)) extra[k] = (extra[k] ?? 0) + v;
  }
  // what the project in hand is short of (its bill broken down to raw materials)
  const project = world.progress?.need ?? {};
  // a project short of a particular wood's logs mines that wood
  const woods = Object.keys(project).filter(k => /_log$/.test(k)).map(k => ({ name: k, want: 0, mine: k, counts: new RegExp(`^${k}$`) }));
  const out = [...STOCK, ...woods].map(t => ({ ...t, short: Math.max(extra[t.name] ?? 0, t.want - have(t.counts), project[t.name] ?? 0) }))
    .filter(t => t.short > 0 && since(world, `fruitless:${t.name}`, s.now) > FRUITLESS_WAIT);
  // what the kit is waiting for first
  return out.sort((a, b) => Number(!!extra[b.name]) - Number(!!extra[a.name]));
}

/**
 * A materials trip by day: mine what the home is shortest of near home, timeboxed to be back before the evening, and
 * home again afterwards. Never with the pockets nearly full, low food or hurt.
 */
export const stock: Goal = {
  name: 'stock',
  priority: 40,
  timeoutMs: 12 * MINUTE,
  retryMs: 8 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || s.sleeping || s.dimension !== 'overworld' || !s.home || s.distHome > world.leash) return null;
    if (s.slotsUsed >= 30 || s.health < 14 || s.food < 10) return null;
    if (daylightLeft(s.timeOfDay) < 3000) return null; // under 2.5 minutes of daylight: not worth setting out
    if (world.landmarks.chests.some(c => !world.chestItems?.[key(c)])) return null; // the kit goal looks in them first
    const short = stockShort(s, world);
    return short.length ? `short of ${short.map(t => `${t.short} ${t.name}`).join(', ')}` : null;
  },
  run: async ctx => {
    const [t] = stockShort(ctx.s, ctx.world);
    if (!t) return 'nothing short';
    const carried = [...ctx.s.counts].filter(([n]) => t.counts.test(n)).reduce((a, [, k]) => a + k, 0);
    // back home by the evening: daylight left less a 90 s walk home
    const budget = Math.min(6 * MINUTE, daylightLeft(ctx.s.timeOfDay) * 50 - 90_000);
    if (budget < 60_000) return 'too late in the day';
    ctx.progress(`mining ${t.mine.split(',')[0]} for ${Math.round(budget / 1000)}s`);
    const r = await ctx.act('mine-blocks', { block: t.mine, count: carried + Math.min(t.short, 64), timeoutMs: budget });
    ctx.progress(r.text.slice(0, 160));
    if (/nothing gained|in sight outside the home area/.test(r.text)) done(ctx.world, `fruitless:${t.name}`, ctx.s.now);
    const back = await ctx.act('go-home', { name: 'home', timeoutMs: 300_000 });
    if (!back.ok) throw new Error(`mined, but could not get home: ${back.text}`);
    if (!r.ok) throw new Error(r.text);
    return `${r.text.slice(0, 120)}; back home`;
  }
};

// ------------------------------------------------------------------------------------------------ lights

/** How far around home the yard is kept lit. */
export const YARD_RADIUS = 16;

type Io = Pick<GoalContext, 'call' | 'act'> & { progress?: (t: string) => void };
export interface LightReport { box: Box; dark: Pos[]; placed: Pos[]; undone: Pos[]; left: Pos[] }
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * The dark spots (block light 0, where monsters spawn since 1.18) a mob could stand on around a point, and with
 * `place`, torches for them as the plan puts them, each one checked against the real light: the plan's light model
 * goes through walls, and the daily round kept putting two torches by an enclosed air pocket that they never lit,
 * every day. A torch that lights no dark spot is taken back up. `ignore` holds spots to leave out ("x,y,z").
 */
export async function lightArea(io: Io, centre: Pos, radius: number, opts: { place: boolean; max: number; ignore: Set<string> }): Promise<LightReport> {
  const box = yardBox(centre, radius);
  const mask = (p: Pos) => !opts.ignore.has(key(p));
  const read = async () => {
    const { blocks } = await io.call<{ blocks: (string | null)[] }>('world.region', { ...box }, 60_000);
    const { block } = await io.call<{ block: number[] }>('world.light', { ...box }, 60_000);
    return { blocks, block, dark: spawnableCells(box, blocks, block, { mask }) };
  };
  let now = await read();
  const report: LightReport = { box, dark: now.dark, placed: [], undone: [], left: now.dark };
  if (!opts.place || !now.dark.length) return report;
  const plan = planTorches(box, now.blocks, now.block, { prefer: centre, max: opts.max, mask });
  for (const t of plan.torches) {
    if (!now.dark.length) break;
    const r = await io.act('place-block', { ...t, faceDirection: 'down', item: 'torch' });
    if (!/^Placed/.test(r.text)) { io.progress?.(`torch at ${key(t)}: ${r.text}`); continue; }
    await pause(500); // the client relights a moment after the block update
    const after = await read();
    if (after.dark.length >= now.dark.length) {
      await io.act('dig-block', { ...t, collect: true });
      report.undone.push(t);
      io.progress?.(`torch at ${key(t)} lit nothing dark: took it back`);
      now = await read();
    } else {
      report.placed.push(t);
      now = after;
    }
  }
  report.left = now.dark;
  return report;
}

/**
 * Once a day: put torches where a monster could spawn in the yard, as few as do any good. Spots a torch didn't reach
 * are remembered and left out from then on.
 */
export const lights: Goal = {
  name: 'lights',
  priority: 30,
  timeoutMs: 10 * MINUTE,
  retryMs: 15 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || !awakeAtHome(s) || (s.counts.get('torch') ?? 0) === 0) return null;
    return since(world, 'lights', s.now) > 20 * MINUTE ? 'daily round: dark spots in the yard' : null;
  },
  run: async ctx => {
    done(ctx.world, 'lights', ctx.s.now);
    const ignore = new Set(ctx.world.darkIgnore ?? []);
    const r = await lightArea(ctx, ctx.s.home!, YARD_RADIUS, { place: true, max: ctx.s.counts.get('torch') ?? 0, ignore });
    // what no torch reached is out of reach for this plan (enclosed, or out of the bot's reach): leave it be
    ctx.world.darkIgnore = [...new Set([...(ctx.world.darkIgnore ?? []), ...r.left.map(key)])].slice(-500);
    if (!r.dark.length) return 'the yard is lit';
    return `placed ${r.placed.length} torch(es)${r.undone.length ? `, took back ${r.undone.length} that lit nothing` : ''}; ` +
      `${r.left.length} of ${r.dark.length} dark spot(s) left${r.left.length ? ' (left out from now on)' : ''}`;
  }
};


// ------------------------------------------------------------------------------------------------ farm

/** Each morning: harvest what's ripe and replant (crops left ripe just sit there), and bake the wheat. */
export const farm: Goal = {
  name: 'farm',
  priority: 45,
  timeoutMs: 6 * MINUTE,
  retryMs: 15 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || !awakeAtHome(s) || !world.landmarks.farmland.length) return null;
    return since(world, 'farm', s.now) > 20 * MINUTE ? 'daily round: the farm' : null;
  },
  run: async ctx => {
    done(ctx.world, 'farm', ctx.s.now);
    const centre = farmCentre(ctx.world)!;
    await ctx.act('move-to-position', { ...centre, range: 3, timeoutMs: 90_000 });
    const r = await ctx.act('farm', { range: 16, timeoutMs: 180_000 });
    ctx.progress(r.text.slice(0, 160));
    const inv = await ctx.call<{ items: { name: string; count: number }[] }>('inventory');
    const wheat = inv.items.filter(i => i.name === 'wheat').reduce((a, i) => a + i.count, 0);
    let baked = '';
    if (wheat >= 3) {
      const b = await ctx.act('craft-item', { outputItem: 'bread', amount: Math.floor(wheat / 3) });
      if (b.ok) baked = `; baked ${Math.floor(wheat / 3)} bread`;
    }
    if (!r.ok) throw new Error(r.text);
    return `${r.text.slice(0, 120)}${baked}`;
  }
};
