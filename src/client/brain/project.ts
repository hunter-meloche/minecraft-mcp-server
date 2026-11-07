import type { Goal, GoalContext } from './goals.js';
import { daylightLeft } from './schedule.js';
import { journal, nextMilestone, progressOf, recipeFor, type Milestone } from './progress.js';
import { chestTotals, reservedCount, takeFromChests } from './chests.js';

/**
 * The project goal: works the next milestone of the long game, one step per slot of free daytime, so the bot keeps
 * getting somewhere once its needs are met instead of standing about "idle (day)".
 */

const MINUTE = 60_000;

export function projectGoal(tree: Milestone[]): Goal {
  // while a step runs it keeps the raised urgency: a stock trip for 1 cobblestone stopped the yard's leveling midway
  let running = false;
  return {
    name: 'project',
    priority: 28,
    // chores (stock trips, sorting, the farm round) can fill a short day: after 4 minutes of waiting the project goes
    // ahead of them, below food, kit and the stash (a whole day went by with the storage house never touched)
    urgency: (s, world) => (running || s.now - (world.lastDone?.project ?? 0) > 4 * MINUTE ? 39 : 28),
    timeoutMs: 9 * MINUTE,
    retryMs: 2 * MINUTE,
    wants: (s, world) => {
      if (s.activity !== 'work' || s.sleeping || s.dimension !== 'overworld' || !s.home || !Number.isFinite(s.distHome)) return null;
      if (s.distHome > 64) return null; // its work is in and around the yard (it ran while the bot was out on a deep trip)
      if (daylightLeft(s.timeOfDay) < 2400) return null; // two minutes before the evening: not worth starting
      if (s.health < 12 || s.slotsUsed >= 35) return null; // its own materials can fill the pockets
      const m = nextMilestone(tree, s, world);
      if (!m) return null;
      const cur = progressOf(world).current;
      const step = m.steps[cur?.id === m.id ? cur.step : 0];
      return `${m.title}: ${step?.name ?? 'finishing'}`;
    },
    run: async ctx => {
      running = true;
      try { return await runStep(ctx); } finally { running = false; }
    }
  };

  async function runStep(ctx: GoalContext): Promise<string> {
      const p = progressOf(ctx.world);
      (ctx.world.lastDone ??= {}).project = ctx.s.now;
      const m = nextMilestone(tree, ctx.s, ctx.world);
      if (!m) return 'nothing left to do';
      if (p.current?.id !== m.id) { p.current = { id: m.id, step: 0, data: {} }; journal(ctx.world, ctx.s.now, `started: ${m.title}`); }
      const cur = p.current;
      const step = m.steps[cur.step];
      if (!step) return finish(ctx, m);
      ctx.progress(`${m.title} - ${step.name}`);
      const r = await step.run(ctx, cur);
      if (r.status === 'done') {
        journal(ctx.world, ctx.s.now, `${m.title}: ${step.name} done (${r.text})`);
        cur.step++;
        p.need = undefined;
        if (cur.step >= m.steps.length) return finish(ctx, m);
      } else if (r.status === 'blocked') {
        p.blockedUntil ??= {};
        p.blockedUntil[m.id] = ctx.s.now + (r.retryMs ?? 10 * MINUTE);
        journal(ctx.world, ctx.s.now, `${m.title}: ${step.name} blocked (${r.text})`);
      }
      return `${m.title} - ${step.name}: ${r.text}`;
  }
}

function finish(ctx: GoalContext, m: Milestone): string {
  const p = progressOf(ctx.world);
  if (!p.done.includes(m.id)) p.done.push(m.id);
  p.current = undefined;
  p.need = undefined;
  journal(ctx.world, ctx.s.now, `done: ${m.title}`);
  return `${m.title} complete`;
}

// ------------------------------------------------------------------------------------------------ materials

const count = async (ctx: GoalContext, match: (name: string) => boolean) =>
  (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items
    .filter(i => i.slot < 36 && match(i.name)).reduce((a, i) => a + i.count, 0);
const matcher = (item: string) => item === 'log' ? (n: string) => /_log$/.test(n) && !/^stripped_/.test(n)
  : item === 'planks' ? (n: string) => /_planks$/.test(n)
  : item === 'coal' ? (n: string) => n === 'coal' || n === 'charcoal'
  : item === 'cobblestone' ? (n: string) => n === 'cobblestone' || n === 'cobbled_deepslate'
  : (n: string) => n === item;

/**
 * Get `n` of an item into the inventory: from the home chests, else crafted (planks from logs, sticks from planks,
 * and so on down RECIPES). Returns what's still short, as raw materials for the stock trips; {} when all is there.
 */
export async function prepare(ctx: GoalContext, item: string, n: number, depth = 0, reserve: Record<string, number> = {}): Promise<Record<string, number>> {
  const match = matcher(item);
  // what the bill needs as it is (a house's log corners) isn't there to be crafted into something else
  const held = depth ? reserve[item] ?? 0 : 0;
  const counted = async () => Math.max(0, (await count(ctx, match)) - held);
  let have = await counted();
  if (have >= n) return {};
  // from the chests (any kind of log or planks will do)
  for (const [name] of Object.entries(ctx.world.chestItems ?? {}).flatMap(([, items]) => Object.entries(items)).filter(([nm]) => match(nm))) {
    if (have >= n) break;
    await takeFromChests(ctx, name, n - have);
    have = await counted();
  }
  if (have >= n) return {};
  // ingots: smelted from the raw ore carried or in the chests (14 raw iron sat in a chest while the trips mined more)
  const raw = SMELTED[item];
  if (raw && ctx.world.landmarks.furnace) {
    const want = n - have;
    // what the bill places as it is (a wall's cobblestone) isn't there to be smelted into something else
    const spareOre = async () => Math.max(0, (await count(ctx, x => x === raw)) - (reserve[raw] ?? 0));
    let ore = await spareOre();
    if (ore < want) { await takeFromChests(ctx, raw, want - ore); ore = await spareOre(); }
    // not enough of what it smelts from: get that first (cobblestone for stone, stone for smooth stone...); with none
    // at all, what that's short of is what's short
    if (ore < want && depth < 6) {
      const sub = await prepare(ctx, raw, want, depth + 1, reserve);
      ore = await spareOre();
      if (!ore) return Object.keys(sub).length ? sub : { [item]: want };
    }
    if (ore) {
      const fuel = await fuelFor(ctx, reserve);
      if (!fuel) return { coal: Math.max(1, Math.ceil(Math.min(ore, want, SMELT_BATCH) / 8)) };
      // a batch at a time (a stack of glass is 11 minutes at the furnace): the rest next run
      const k = Math.min(ore, want, SMELT_BATCH);
      // fuel the bill places (its logs, its planks) burns only beyond what the bill needs
      const fuelCount = reserve[fuel] ? Math.max(1, (await count(ctx, x => x === fuel)) - reserve[fuel]) : undefined;
      await ctx.act('smelt-item', { ...ctx.world.landmarks.furnace, inputItem: raw, inputCount: k, fuelItem: fuel, ...(fuelCount ? { fuelCount } : {}), takeOutput: true, timeoutMs: k * 10_500 + 15_000 });
      have = await counted();
      if (have >= n) return {};
      return { [item]: n - have };
    }
  }
  const r = recipeFor(item);
  if (!r || depth > 6) return { [item]: n - have };
  const crafts = Math.ceil((n - have) / r.makes);
  const short: Record<string, number> = {};
  for (const [inp, k] of Object.entries(r.from)) {
    for (const [sk, sv] of Object.entries(await prepare(ctx, inp, k * crafts, depth + 1, reserve))) short[sk] = (short[sk] ?? 0) + sv;
  }
  if (Object.keys(short).length) return short;
  const output = item === 'planks' ? await planksFor(ctx) : item;
  const c = await ctx.act('craft-item', { outputItem: output, amount: crafts });
  if (!c.ok) return { [item]: n - have };
  const now = await counted();
  return now >= n ? {} : { [item]: n - now };
}

/** What smelts into what: the ingots, and the building blocks (glass from sand, stone from cobblestone, ...). */
export const SMELTED: Record<string, string> = {
  iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper',
  glass: 'sand', stone: 'cobblestone', smooth_stone: 'stone', brick: 'clay_ball', terracotta: 'clay',
  cracked_stone_bricks: 'stone_bricks', smooth_sandstone: 'sandstone', deepslate: 'cobbled_deepslate'
};
/** Most to smelt in one go (about 4 minutes at the furnace): a bigger bill is smelted over several runs. */
export const SMELT_BATCH = 24;
const FUEL = /^(coal|charcoal|(?!stripped_)[a-z_]+_log|[a-z_]+_planks)$/;

/**
 * Something to burn: carried (coal first), else coal or logs from the chests. `keep` is what a bill places as it is: a
 * kind carried only that many times over isn't fuel (a build's logs went into the furnace that smelted its stone).
 */
export async function fuelFor(ctx: GoalContext, keep: Record<string, number> = {}): Promise<string | undefined> {
  const inv = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
  const carried = new Map<string, number>();
  for (const i of inv.items) if (i.slot < 36 && FUEL.test(i.name)) carried.set(i.name, (carried.get(i.name) ?? 0) + i.count);
  const coalFirst = ([a]: [string, number], [b]: [string, number]) => Number(!/coal/.test(a)) - Number(!/coal/.test(b));
  const spare = [...carried].filter(([n, k]) => k > (keep[n] ?? 0)).sort(coalFirst)[0]?.[0];
  if (spare) return spare;
  // what a build job has secured isn't fuel
  const stored = Object.entries(chestTotals(ctx.world)).filter(([n, k]) => k > reservedCount(ctx.world, n) && FUEL.test(n)).sort(coalFirst)[0]?.[0];
  if (stored && await takeFromChests(ctx, stored, 8)) return stored;
  return undefined;
}

/** Planks of the kind of log carried most. */
async function planksFor(ctx: GoalContext): Promise<string> {
  const inv = await ctx.call<{ items: { name: string; count: number }[] }>('inventory');
  const logs = new Map<string, number>();
  for (const i of inv.items) if (/_log$/.test(i.name) && !/^stripped_/.test(i.name)) logs.set(i.name, (logs.get(i.name) ?? 0) + i.count);
  const best = [...logs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'oak_log';
  return best.replace(/_log$/, '_planks');
}

/** Prepare a whole bill; what's short goes to the stock trips (progress.need) and comes back. */
export async function prepareBill(ctx: GoalContext, bill: Record<string, number>, opts: { record?: boolean } = {}): Promise<Record<string, number>> {
  const short: Record<string, number> = {};
  // raw items first (they can't be crafted); everything the bill places is kept back from the making of the rest (its
  // logs and planks out of the stairs, its cobblestone out of the furnace, none of them burnt as fuel)
  const raw = Object.entries(bill).filter(([item]) => !recipeFor(item));
  const reserve = { ...bill };
  for (const [item, n] of [...raw, ...Object.entries(bill).filter(([item]) => recipeFor(item))]) {
    for (const [k, v] of Object.entries(await prepare(ctx, item, n, 0, reserve))) short[k] = (short[k] ?? 0) + v;
  }
  // the project's shortfall is the stock trips' to fetch; a build job keeps its own (opts.record false)
  if (opts.record !== false) progressOf(ctx.world).need = Object.keys(short).length ? short : undefined;
  return short;
}
