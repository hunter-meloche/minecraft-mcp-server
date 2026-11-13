import { nearHome, type Goal } from './goals.js';
import type { WorldMemory } from './memory.js';
import { growStep, yardOf } from './milestones.js';

/**
 * The yard grown on request: the LLM (the daily design run, or the user through it) wants room for something the yard
 * has none for. The same growth the projects use (growYard: a strip along the cheapest dry side, clear of others'
 * builds, levelled; the fence then moves out to the new edge), run by the autopilot at its own pace.
 */

export interface YardGrowRequest {
  /** the footprint it needs room for (with 2 clear round it) */
  width: number;
  length: number;
  /** what for ("a wheat farm") */
  why: string;
  at: number;
  /** the last thing that happened */
  note?: string;
}

const MINUTE = 60_000;

export function requestYardGrowth(world: WorldMemory, r: Omit<YardGrowRequest, 'at'>, now = Date.now()): YardGrowRequest {
  world.yardGrow = { ...r, at: now };
  return world.yardGrow;
}

/** Just under the community missions: a request from the user's side, after staying alive, the gear and the food. */
export const yardGrowGoal: Goal = {
  name: 'grow yard',
  priority: 41,
  timeoutMs: 10 * MINUTE,
  retryMs: 15 * MINUTE,
  wants: (s, world) => {
    const r = world.yardGrow;
    if (!r || s.activity !== 'work' || s.sleeping || s.dimension !== 'overworld' || !s.home || !nearHome(s, 32)) return null;
    // the fence still moving out after the last growth: that first (the perimeter project sees to it)
    if (world.fenceMove) return null;
    return `room asked for: ${r.width}x${r.length} for ${r.why}`;
  },
  run: async ctx => {
    const r = ctx.world.yardGrow;
    if (!r) return 'nothing asked';
    const yard = await yardOf(ctx);
    const res = await growStep(ctx, yard, { width: r.width, length: r.length }, r.why);
    r.note = res.text;
    if (res.status === 'blocked') throw new Error(res.text);
    if (/^grew the yard/.test(res.text)) delete ctx.world.yardGrow;
    return res.text;
  }
};

export function yardGrowStatus(world: WorldMemory | undefined): string[] {
  const r = world?.yardGrow;
  return r ? [`Yard growth asked for: ${r.width}x${r.length} for ${r.why}${r.note ? ` (${r.note})` : ''}.`] : [];
}
