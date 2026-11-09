import type { Goal, GoalContext, Snapshot } from './goals.js';
import type { WorldMemory } from './memory.js';
import { freeChestTotals, key } from './chests.js';
import { toTheWoods } from './chores.js';
import { daylightLeft } from './schedule.js';

/**
 * Spare time by day: with nothing else to do, stockpile what the home will want, instead of standing about till
 * dusk. On the friend's server the bot was idle 104 of 221 daytime minutes once its plan was done or blocked: the
 * stock trips only top up their minimums, deep trips only run for its own missing gear, and the idle watchdog's
 * forage (6 minutes in) only fetches what's short. Now, a run at a time, in turn and up to a cap each: iron, coal and
 * logs. What's beyond what the bot keeps of the precious ones goes to the community chest (the donate goal).
 */

const MINUTE = 60_000;
/** A run that brought nothing back: that task waits this long (what's near may be mined out or out of reach). */
const FRUITLESS_WAIT = 40 * MINUTE;

export interface SpareTask { name: string; mine: string; counts: RegExp; cap: number; wood?: boolean }

export const SPARE_TASKS: SpareTask[] = [
  { name: 'iron', mine: 'iron_ore,deepslate_iron_ore', counts: /^(iron_ingot|raw_iron)$/, cap: 96 },
  { name: 'coal', mine: 'coal_ore,deepslate_coal_ore', counts: /^(coal|charcoal)$/, cap: 64 },
  { name: 'log', mine: 'oak_log,birch_log,spruce_log,dark_oak_log,acacia_log,jungle_log,cherry_log', counts: /_log$/, cap: 64, wood: true }
];

/** What the home has of a task's items: carried and in its chests (beyond what jobs and missions hold). */
function haveOf(s: Pick<Snapshot, 'counts'>, world: WorldMemory, re: RegExp): number {
  let n = 0;
  for (const [k, v] of s.counts) if (re.test(k)) n += v;
  for (const [k, v] of Object.entries(freeChestTotals(world))) if (re.test(k)) n += v;
  return n;
}

/** The task for a spare run: under its cap and not fruitless lately, the one done longest ago first. */
export function spareTask(s: Pick<Snapshot, 'counts' | 'now'>, world: WorldMemory): SpareTask | undefined {
  const last = world.lastDone ?? {};
  return SPARE_TASKS
    .filter(t => haveOf(s, world, t.counts) < t.cap && s.now - (last[`fruitless:spare:${t.name}`] ?? 0) > FRUITLESS_WAIT)
    .sort((a, b) => (last[`spare:${a.name}`] ?? 0) - (last[`spare:${b.name}`] ?? 0))[0];
}

export const spareGoal: Goal = {
  name: 'spare time',
  // the lowest of the real goals: anything else wanting to run comes first, and may stop it
  priority: 3,
  timeoutMs: 8 * MINUTE,
  retryMs: 5 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || s.sleeping || s.dimension !== 'overworld' || !s.home || s.distHome > 16) return null;
    // room as the stock trips want it (the stash empties the pockets at home from 27: at 26 neither ran, and it idled)
    // 32: at 30 (the stock trips' limit) it sat idle with exactly 30 used, the stash having nothing more to put away
    if (s.health < 14 || s.food < 12 || s.slotsUsed >= 32) return null;
    if (daylightLeft(s.timeOfDay) < 3000) return null; // under 2.5 minutes of daylight: not worth setting out (as the stock trips)
    if (world.landmarks.chests.some(c => !world.chestItems?.[key(c)])) return null; // the kit looks in them first
    const t = spareTask(s, world);
    return t ? `spare time: stockpile ${t.name}` : null;
  },
  run: async (ctx: GoalContext) => {
    const t = spareTask(ctx.s, ctx.world);
    if (!t) return 'nothing to stockpile';
    const last = (ctx.world.lastDone ??= {});
    last[`spare:${t.name}`] = ctx.s.now;
    const budget = Math.min(5 * MINUTE, daylightLeft(ctx.s.timeOfDay) * 50 - 90_000);
    if (budget < 60_000) return 'too late in the day';
    const before = haveOf(ctx.s, ctx.world, t.counts);
    const carried = [...ctx.s.counts].filter(([n]) => t.counts.test(n)).reduce((a, [, k]) => a + k, 0);
    const want = Math.min(t.cap - before, t.wood ? 32 : 24);
    if (t.wood) {
      const woods = await toTheWoods(ctx, t.mine.split(','));
      if (!woods.ok) { last[`fruitless:spare:${t.name}`] = ctx.s.now; return `spare time: no trees in reach (${woods.text.slice(0, 80)})`; }
      if (woods.text) ctx.progress(woods.text);
    }
    ctx.progress(`spare time: mining ${t.mine.split(',')[0]} for up to ${want} (${Math.round(budget / 1000)} s)`);
    const r = await ctx.act('mine-blocks', { block: t.mine, count: carried + want, timeoutMs: budget });
    const inv = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
    const after = inv.items.filter(i => i.slot < 36 && t.counts.test(i.name)).reduce((a, i) => a + i.count, 0);
    const got = Math.max(0, after - carried);
    if (!got) last[`fruitless:spare:${t.name}`] = ctx.s.now;
    await ctx.act('go-home', { name: 'home', timeoutMs: 240_000 }).catch(() => undefined);
    return `spare time: ${got} ${t.name}${got ? '' : ` (${r.text.split('\n')[0].slice(0, 100)})`}; back home`;
  }
};
