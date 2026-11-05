import type { Goal, GoalContext } from './goals.js';
import { daylightLeft } from './schedule.js';
import { journal, nextMilestone, progressOf, RECIPES, type Milestone } from './progress.js';
import { takeFromChests } from './chests.js';

/**
 * The project goal: works the next milestone of the long game, one step per slot of free daytime, so the bot keeps
 * getting somewhere once its needs are met instead of standing about "idle (day)".
 */

const MINUTE = 60_000;

export function projectGoal(tree: Milestone[]): Goal {
  return {
    name: 'project',
    priority: 25,
    timeoutMs: 9 * MINUTE,
    retryMs: 2 * MINUTE,
    wants: (s, world) => {
      if (s.activity !== 'work' || s.sleeping || s.dimension !== 'overworld' || !s.home || !Number.isFinite(s.distHome)) return null;
      if (daylightLeft(s.timeOfDay) < 2400) return null; // two minutes before the evening: not worth starting
      if (s.health < 12 || s.slotsUsed >= 32) return null;
      const m = nextMilestone(tree, s, world);
      if (!m) return null;
      const cur = progressOf(world).current;
      const step = m.steps[cur?.id === m.id ? cur.step : 0];
      return `${m.title}: ${step?.name ?? 'finishing'}`;
    },
    run: async ctx => {
      const p = progressOf(ctx.world);
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
  };
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
export async function prepare(ctx: GoalContext, item: string, n: number, depth = 0): Promise<Record<string, number>> {
  const match = matcher(item);
  let have = await count(ctx, match);
  if (have >= n) return {};
  // from the chests (any kind of log or planks will do)
  for (const [name] of Object.entries(ctx.world.chestItems ?? {}).flatMap(([, items]) => Object.entries(items)).filter(([nm]) => match(nm))) {
    if (have >= n) break;
    await takeFromChests(ctx, name, n - have);
    have = await count(ctx, match);
  }
  if (have >= n) return {};
  const r = RECIPES[item];
  if (!r || depth > 6) return { [item]: n - have };
  const crafts = Math.ceil((n - have) / r.makes);
  const short: Record<string, number> = {};
  for (const [inp, k] of Object.entries(r.from)) {
    for (const [sk, sv] of Object.entries(await prepare(ctx, inp, k * crafts, depth + 1))) short[sk] = (short[sk] ?? 0) + sv;
  }
  if (Object.keys(short).length) return short;
  const output = item === 'planks' ? await planksFor(ctx) : item;
  const c = await ctx.act('craft-item', { outputItem: output, amount: crafts });
  if (!c.ok) return { [item]: n - have };
  return (await count(ctx, match)) >= n ? {} : { [item]: n - (await count(ctx, match)) };
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
export async function prepareBill(ctx: GoalContext, bill: Record<string, number>): Promise<Record<string, number>> {
  const short: Record<string, number> = {};
  for (const [item, n] of Object.entries(bill)) {
    for (const [k, v] of Object.entries(await prepare(ctx, item, n))) short[k] = (short[k] ?? 0) + v;
  }
  progressOf(ctx.world).need = Object.keys(short).length ? short : undefined;
  return short;
}
