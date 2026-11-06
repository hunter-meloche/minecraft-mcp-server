import { AVOID_UNLESS_ASKED } from '../../food.js';
import { foodsFor26 } from '../tools.js';
import type { Goal, GoalContext, Snapshot } from './goals.js';
import { COOKS_TO } from './food.js';
import { chestTotals, key, peekChest, rememberReply, storeInChests, takeFromChests } from './chests.js';
import { assignChests, CATEGORIES, depositPlan, misplaced, type ChestAssign } from './storage.js';
import { kitNeeds, stashPlan, type KitNeed, type PlanStep } from './kit.js';
import { planTorches, spawnableCells, yardBox } from './lighting.js';
import { HeatMap, pathTorchSpots } from './paths.js';
import { fuelFor } from './project.js';
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
  priority: 60,
  timeoutMs: 6 * MINUTE,
  retryMs: 10 * MINUTE,
  wants: (s, world) => {
    if (!awakeAtHome(s) || !world.landmarks.chests.length) return null;
    const plan = stashPlan(s.items, { foods: foods(), keep: projectCarry(world) });
    // only what can really go: a worse duplicate of a kept tool can't be told apart, and a project's materials stay
    // (a full pocket of planks for the storage house had the stash stop the build over and over, storing nothing)
    const dupes = (n: string) => s.items.filter(i => i.name === n && i.slot < 36).length > 1;
    plan.deposit = plan.deposit.filter(e => e.slot === undefined || !dupes(e.name));
    if (!plan.deposit.length && !plan.drop.length) return null;
    // a project carrying its materials fills the pockets on purpose: only stop it when really full
    if (s.slotsUsed >= (world.progress?.carry ? 33 : 27)) return `${s.slotsUsed}/36 slots used`;
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
      // thrown where the bot stands it picks them straight back up, and anything it walks over it picks up too (the
      // farm round, then a fishing walk, brought back hundreds of dirt and leaf litter thrown minutes before): throw
      // them 8 blocks out from the fence on the side it walks least (the heat map), where they despawn in 5 minutes
      const yard = ctx.world.yard;
      const dump = yard ? dumpSpot(yard, ctx.world.heat ? HeatMap.fromJSON(ctx.world.heat) : undefined) : (() => {
        const home = ctx.s.home!;
        const f = farmCentre(ctx.world);
        const dx = f ? home.x - f.x : -1, dz = f ? home.z - f.z : -1;
        const len = Math.hypot(dx, dz) || 1;
        return { x: Math.round(home.x + dx / len * 14), y: home.y, z: Math.round(home.z + dz / len * 14) };
      })();
      try {
        await ctx.act('move-to-position', { ...dump, range: 2, timeoutMs: 60_000 });
      } catch (e) {
        // near enough will do, as long as it's well outside the fence
        const me = (await ctx.status()).position;
        if (!me || !yard || outsideBy(yard, me) < 4) throw e;
      }
      for (const e of plan.drop) {
        const r = await ctx.act('drop-item', { item: e.name, count: e.count });
        const m = /^Dropped (\d+)/.exec(r.text);
        if (m) dropped += Number(m[1]);
      }
      await ctx.act('go-home', { name: 'home', timeoutMs: 120_000 });
    }
    ctx.progress(`stored ${stored}, dropped ${dropped}`);
    if (!stored && !dropped) throw new Error('nothing could be put away');
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

/** Take whatever the home furnace has finished; how much (as "16 iron_ingot"), or '' when nothing. */
async function collectFurnace(ctx: GoalContext): Promise<string> {
  const at = ctx.world.landmarks.furnace;
  if (!at) return '';
  type Slot = { name: string; count: number } | null;
  const open = () => ctx.call<{ open: boolean; output: Slot; input: Slot; lit: boolean }>('furnace.open', { ...at });
  let f = await open().catch(() => undefined);
  if (!f) { await ctx.act('move-to-position', { ...at, range: 2, timeoutMs: 60_000 }); f = await open().catch(() => undefined); }
  if (!f) return '';
  try {
    const took: string[] = [];
    if (f.output) {
      const r = await ctx.call<{ took: Slot }>('furnace.take');
      if (r.took) took.push(`${r.took.count} ${r.took.name}`);
    }
    // what sits in the input unlit (no fuel left) blocks every other smelt ("input slot occupied"): take it back
    if (f.input && !f.lit) {
      const r = await ctx.call<{ took: Slot }>('furnace.take', { slot: 'input' });
      if (r.took) took.push(`${r.took.count} ${r.took.name} (not cooked)`);
    }
    return took.join(', ');
  } finally {
    await ctx.call('container.close').catch(() => undefined);
  }
}

/** Ingots wanted at home: a full iron kit's worth. */
const INGOTS_KEPT = 24;
/** Raw iron in the chests to smelt now: while the home has fewer than INGOTS_KEPT ingots. */
function storedIronToSmelt(s: Snapshot, world: WorldMemory): number {
  const chest = chestTotals(world);
  const ingots = (s.counts.get('iron_ingot') ?? 0) + (chest.iron_ingot ?? 0);
  return Math.min(chest.raw_iron ?? 0, Math.max(0, INGOTS_KEPT - ingots), 16);
}

/** Logs to burn into charcoal: when coal (carried and stored) is under 8 and it carries 10 or more of one kind. */
function charcoalLogs(s: Snapshot, world: WorldMemory): { name: string; count: number } | undefined {
  const chest = chestTotals(world);
  const coal = (s.counts.get('coal') ?? 0) + (s.counts.get('charcoal') ?? 0) + (chest.coal ?? 0) + (chest.charcoal ?? 0);
  if (coal >= 8) return undefined;
  const best = [...s.counts].filter(([n]) => /^(?!stripped_)[a-z_]+_log$/.test(n)).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 10 ? { name: best[0], count: best[1] } : undefined;
}

/** Raw ore carried home: smelt it at the home furnace; charcoal when coal runs low. */
export const smelt: Goal = {
  name: 'smelt',
  priority: 66,
  timeoutMs: 10 * MINUTE,
  retryMs: 10 * MINUTE,
  wants: (s, world) => {
    if (!awakeAtHome(s) || !world.landmarks.furnace) return null;
    const ore = Object.keys(ORES).find(o => (s.counts.get(o) ?? 0) > 0);
    if (ore && FUELS.some(f => (s.counts.get(f) ?? 0) > 0)) return `${s.counts.get(ore)} ${ore} to smelt`;
    if (storedIronToSmelt(s, world) > 0) return `${storedIronToSmelt(s, world)} raw iron in the chests to smelt for the gear`;
    if (since(world, 'furnace', s.now) > 30 * MINUTE) return 'check the furnace for finished smelting';
    return charcoalLogs(s, world) ? 'low on coal: charcoal from logs' : null;
  },
  run: async ctx => {
    const did: string[] = [];
    // a smelt stopped midway (something more urgent) leaves its output in the furnace: take it out
    done(ctx.world, 'furnace', ctx.s.now);
    const took = await collectFurnace(ctx);
    if (took) { did.push(`took ${took} out of the furnace`); ctx.progress(did.at(-1)!); }
    // raw iron the stash put away, while the home is short of ingots (the gear wants them)
    const fromChest = storedIronToSmelt(ctx.s, ctx.world);
    if (fromChest > 0) {
      const got = await takeFromChests(ctx, 'raw_iron', fromChest);
      if (got) {
        const fuel = await fuelFor(ctx);
        if (fuel) {
          const r = await ctx.act('smelt-item', { ...ctx.world.landmarks.furnace!, inputItem: 'raw_iron', inputCount: got, fuelItem: fuel, takeOutput: true, timeoutMs: got * 10_500 + 15_000 });
          did.push(r.ok ? `smelted ${got} raw_iron from the chests` : `could not smelt raw_iron: ${r.text}`);
          ctx.progress(did.at(-1)!);
        }
      }
    }
    // charcoal when coal runs low (torches, cooking and smelting all burn it): logs in, planks or a log to burn
    const logs = charcoalLogs(ctx.s, ctx.world);
    if (logs) {
      const fuel = [...ctx.s.counts].find(([n, k]) => /_planks$/.test(n) && k > 0)?.[0] ?? logs.name;
      const n = Math.min(8, logs.count - (fuel === logs.name ? 2 : 0));
      if (n > 0) {
        const r = await ctx.act('smelt-item', { ...ctx.world.landmarks.furnace!, inputItem: logs.name, inputCount: n, fuelItem: fuel, takeOutput: true, timeoutMs: n * 10_500 + 15_000 });
        did.push(r.ok ? `made ${n} charcoal` : `could not make charcoal: ${r.text}`);
        ctx.progress(did.at(-1)!);
      }
    }
    for (const ore of Object.keys(ORES)) {
      const n = ctx.s.counts.get(ore) ?? 0;
      const fuel = FUELS.find(f => (ctx.s.counts.get(f) ?? 0) > 0);
      if (!n || !fuel) continue;
      const r = await ctx.act('smelt-item', { ...ctx.world.landmarks.furnace!, inputItem: ore, inputCount: n, fuelItem: fuel, takeOutput: true, timeoutMs: n * 10_500 + 15_000 });
      // smelted means the ore went: a reply like "input slot is occupied" is no error, and counted as done it had
      // the bot "smelt" the same 7 raw copper every 5 seconds
      const left = (await ctx.call<{ items: { name: string; count: number }[] }>('inventory')).items.filter(i => i.name === ore).reduce((a, i) => a + i.count, 0);
      if (left >= n) throw new Error(`could not smelt ${ore}: ${r.text.slice(0, 120)}`);
      did.push(r.ok ? `smelted ${n - left} ${ore}` : `could not smelt ${ore}: ${r.text}`);
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
  priority: 70,
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

/** The kit is waiting on a stock trip (iron for iron gear, coal for torches, ...), and raw ore at home won't do. */
const gearShort = (s: Snapshot, world: WorldMemory) => stockShort(s, world).some(t => t.gear);

/** How short the home is of each stock item (kit gathering needs on top), most urgent first. */
export function stockShort(s: Snapshot, world: WorldMemory): { name: string; short: number; mine: string; counts: RegExp; gear: boolean }[] {
  const chest = chestTotals(world);
  const have = (re: RegExp) => [...s.counts].filter(([n]) => re.test(n)).reduce((a, [, k]) => a + k, 0) +
    Object.entries(chest).filter(([n]) => re.test(n)).reduce((a, [, k]) => a + k, 0);
  const extra: Record<string, number> = {};
  for (const n of kitNeeds(s.items, chest)) {
    for (const st of n.plan) if ('gather' in st) for (const [k, v] of Object.entries(st.gather)) extra[k] = (extra[k] ?? 0) + v;
  }
  // raw iron at home is iron the smelter turns into ingots: not a reason to mine more
  if (extra.iron_ingot) {
    const raw = (s.counts.get('raw_iron') ?? 0) + (chest.raw_iron ?? 0);
    extra.iron_ingot = Math.max(0, extra.iron_ingot - raw);
    if (!extra.iron_ingot) delete extra.iron_ingot;
  }
  // what the project in hand is short of (its bill broken down to raw materials)
  const project = world.progress?.need ?? {};
  // a project short of a particular wood's logs mines that wood
  const woods = Object.keys(project).filter(k => /_log$/.test(k)).map(k => ({ name: k, want: 0, mine: k, counts: new RegExp(`^${k}$`) }));
  const out = [...STOCK, ...woods].map(t => ({ ...t, gear: (extra[t.name] ?? 0) > 0, short: Math.max(extra[t.name] ?? 0, t.want - have(t.counts), project[t.name] ?? 0) }))
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
  priority: 33,
  // materials for the gear go with the gear (second only to staying alive); the rest is home upkeep
  urgency: (s, world) => (gearShort(s, world) ? 64 : 33),
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
    // a project's shortfall is served once per trip: the project works out what's still short when it next runs
    // (left standing, it had the bot fetch 22 more birch logs trip after trip)
    const need = ctx.world.progress?.need;
    if (need && t.name in need) { delete need[t.name]; if (!Object.keys(need).length) ctx.world.progress!.need = undefined; }
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
export async function lightArea(io: Io, centre: Pos, radius: number, opts: { place: boolean; max: number; ignore: Set<string>; only?: (p: Pos) => boolean }): Promise<LightReport> {
  const box = yardBox(centre, radius);
  const mask = (p: Pos) => !opts.ignore.has(key(p)) && (opts.only?.(p) ?? true);
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

/** Torches kept back for the mine and the trips (the kit's own count). */
const TORCH_RESERVE = 16;
/** A day's torches for the band outside the fence, and for the routes. */
const BAND_PER_DAY = 8;
const PATH_PER_DAY = 6;
/** The band outside the fence: 2 to 12 blocks out. */
const BAND = { from: 2, to: 12 };

/** Where to throw junk: 8 out from the middle of the yard's least walked side (heat summed within 6 of each spot). */
export function dumpSpot(yard: { x1: number; z1: number; x2: number; z2: number; y: number }, heat?: HeatMap): { x: number; y: number; z: number } {
  const mx = Math.round((yard.x1 + yard.x2) / 2), mz = Math.round((yard.z1 + yard.z2) / 2), out = 8;
  const spots = [{ x: mx, z: yard.z1 - out }, { x: mx, z: yard.z2 + out }, { x: yard.x1 - out, z: mz }, { x: yard.x2 + out, z: mz }];
  const warmth = (p: { x: number; z: number }) => {
    let h = 0;
    for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) h += heat?.get(p.x + dx, p.z + dz) ?? 0;
    return h;
  };
  const best = spots.map(p => ({ p, h: warmth(p) })).sort((a, b) => a.h - b.h)[0].p;
  return { ...best, y: yard.y + 1 };
}

/** How far a point is outside a yard box (0 inside), in the larger of the two directions. */
export function outsideBy(yard: { x1: number; z1: number; x2: number; z2: number }, p: { x: number; z: number }): number {
  return Math.max(yard.x1 - p.x, 0, p.x - yard.x2, yard.z1 - p.z, p.z - yard.z2);
}

/**
 * Once a day, in order, while torches last: the yard (none dark, spots no torch reached are left out from then on);
 * a band 2 to 12 blocks outside the fence, nearest first, a few a day, so mobs don't spawn right at the fence; and
 * the dark stretches of the routes the bot walks most (the heat map the brain keeps), a torch every 10 blocks.
 */
export const lights: Goal = {
  name: 'lights',
  priority: 36,
  timeoutMs: 12 * MINUTE,
  retryMs: 15 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || !awakeAtHome(s) || (s.counts.get('torch') ?? 0) === 0) return null;
    return since(world, 'lights', s.now) > 20 * MINUTE ? 'daily round: dark spots in the yard' : null;
  },
  run: async ctx => {
    done(ctx.world, 'lights', ctx.s.now);
    const ignore = new Set(ctx.world.darkIgnore ?? []);
    const yard = ctx.world.yard;
    const centre = yard ? { x: Math.round((yard.x1 + yard.x2) / 2), y: yard.y + 1, z: Math.round((yard.z1 + yard.z2) / 2) } : ctx.s.home!;
    const radius = yard ? Math.ceil(Math.max(yard.x2 - yard.x1, yard.z2 - yard.z1) / 2) + 1 : YARD_RADIUS;
    let torches = ctx.s.counts.get('torch') ?? 0;
    const out: string[] = [];

    const r = await lightArea(ctx, centre, radius, { place: true, max: torches, ignore, only: yard ? p => outsideBy(yard, p) === 0 : undefined });
    torches -= r.placed.length;
    // what no torch reached is out of reach for this plan (enclosed, or out of the bot's reach): leave it be
    ctx.world.darkIgnore = [...new Set([...(ctx.world.darkIgnore ?? []), ...r.left.map(key)])].slice(-500);
    out.push(!r.dark.length ? 'the yard is lit' : `yard: placed ${r.placed.length} torch(es)${r.undone.length ? `, took back ${r.undone.length} that lit nothing` : ''}; ` +
      `${r.left.length} of ${r.dark.length} dark spot(s) left${r.left.length ? ' (left out from now on)' : ''}`);
    if (!yard || ctx.signal.aborted) return out.join('; ');

    // the band outside the fence (not remembered as left out: there's always more of it than a day's torches)
    if (torches > TORCH_RESERVE) {
      ctx.progress('lighting the band outside the fence');
      const b = await lightArea(ctx, centre, Math.min(radius + BAND.to, 34), {
        place: true, max: Math.min(BAND_PER_DAY, torches - TORCH_RESERVE), ignore,
        only: p => { const d = outsideBy(yard, p); return d >= BAND.from && d <= BAND.to; }
      });
      torches -= b.placed.length;
      out.push(`outside the fence: ${b.placed.length} torch(es), ${b.left.length} dark spot(s) to go`);
    }

    // the routes beyond the band
    if (torches > TORCH_RESERVE && ctx.world.heat && !ctx.signal.aborted) {
      const spots = pathTorchSpots(HeatMap.fromJSON(ctx.world.heat), () => true, 10, (x, z) => outsideBy(yard, { x, z }) <= BAND.to, 3);
      let lit = 0, tried = 0;
      for (const spot of spots) {
        if (lit >= PATH_PER_DAY || torches <= TORCH_RESERVE || tried >= 3 * PATH_PER_DAY || ctx.signal.aborted) break;
        tried++;
        const y = Math.floor(ctx.s.position.y);
        const p = await lightArea(ctx, { x: spot.x, y: Math.min(y, yard.y + 1), z: spot.z }, 3, { place: true, max: 1, ignore });
        if (p.placed.length) { lit++; torches--; ctx.progress(`a torch on the route at (${spot.x}, ${spot.z})`); }
      }
      if (tried) out.push(`routes: ${lit} torch(es) (${tried} of ${spots.length} spot(s) looked at)`);
    }
    return out.join('; ');
  }
};


// ------------------------------------------------------------------------------------------------ farm

/**
 * Harvest and replant every plot (the farm tool works around where the bot stands): each crop plot from its middle,
 * and the farmland outside the plots from its own middle.
 */
export async function farmAll(ctx: GoalContext): Promise<{ ok: boolean; text: string }> {
  const plots = ctx.world.zones?.plot ?? [];
  const inPlot = (f: Pos) => plots.some(p => f.x >= p.x && f.x < p.x + (p.width ?? 9) && f.z >= p.z && f.z < p.z + (p.length ?? 9));
  const loose = ctx.world.landmarks.farmland.filter(f => !inPlot(f));
  // each plot from just outside its north edge (Baritone won't path onto farmland), far enough to reach its far side
  const spots: { at: Pos; range: number }[] = plots.map(p => ({ at: { x: p.x + Math.floor((p.width ?? 9) / 2), y: p.y + 1, z: p.z - 1 }, range: (p.length ?? 9) + 2 }));
  if (loose.length) spots.push({ at: farmCentre({ ...ctx.world, landmarks: { ...ctx.world.landmarks, farmland: loose } })!, range: 12 });
  const out: string[] = [];
  let ok = true;
  for (const sp of spots) {
    if (ctx.signal.aborted) break;
    // short of the spot but near it will do: the farm works around wherever the bot ends up
    await ctx.act('move-to-position', { ...sp.at, range: 3, timeoutMs: 90_000 }).catch(() => undefined);
    const r = await ctx.act('farm', { range: sp.range, timeoutMs: 180_000 });
    ctx.progress(r.text.slice(0, 160));
    out.push(r.text.slice(0, 100));
    ok &&= r.ok;
  }
  return { ok, text: out.join(' | ') || 'no farmland' };
}

/** Each morning: harvest what's ripe and replant (crops left ripe just sit there), and bake the wheat. */
export const farm: Goal = {
  name: 'farm',
  priority: 47,
  timeoutMs: 6 * MINUTE,
  retryMs: 15 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || !awakeAtHome(s) || !world.landmarks.farmland.length) return null;
    return since(world, 'farm', s.now) > 20 * MINUTE ? 'daily round: the farm' : null;
  },
  run: async ctx => {
    done(ctx.world, 'farm', ctx.s.now);
    const r = await farmAll(ctx);
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
