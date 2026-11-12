import type { ClientRuntime } from '../tools.js';
import type { Goal, GoalContext } from './goals.js';
import { key } from './chests.js';
import { prepare } from './project.js';
import { missingBuilt, type BuiltBlock } from './integrity.js';
import type { Pos, WorldMemory } from './memory.js';
import { roundDue } from './work.js';

/**
 * Once a day: look over everything the bot built around home and put back what went missing (a creeper's crater in
 * the cabin wall, a torch an enderman took, the block Baritone broke walking past). Built blocks are the protected
 * positions with the state each had when built; see integrity.ts for what counts as missing.
 */

const MINUTE = 60_000;
/** Near enough home to start the round. */
const NEAR_HOME = 10;
/** How far around home built blocks are checked. */
export const REPAIR_RADIUS = 24;
/** world.region's limit (cells per call). */
const REGION_MAX = 65_536;

// the same daily bookkeeping as chores.ts
const done = (world: WorldMemory, chore: string, now: number) => { world.lastDone ??= {}; world.lastDone[chore] = now; };

/** The blocks at `positions` (as world.region gives them: null where unloaded), read over their bounding box in slabs. */
export async function readCells(ctx: Pick<GoalContext, 'call'>, positions: Pos[]): Promise<(string | null)[]> {
  if (!positions.length) return [];
  const min = (k: keyof Pos) => Math.min(...positions.map(p => p[k]));
  const max = (k: keyof Pos) => Math.max(...positions.map(p => p[k]));
  const box = { x: min('x'), y: min('y'), z: min('z'), width: max('x') - min('x') + 1, height: max('y') - min('y') + 1, length: max('z') - min('z') + 1 };
  const per = Math.max(1, Math.floor(REGION_MAX / (box.width * box.length)));
  const blocks: (string | null)[] = [];
  for (let y = 0; y < box.height; y += per) {
    const part = await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...box, y: box.y + y, height: Math.min(per, box.height - y) }, 60_000);
    blocks.push(...part.blocks);
  }
  return positions.map(p => blocks[(p.x - box.x) + (p.z - box.z) * box.width + (p.y - box.y) * box.width * box.length] ?? null);
}

/** The daily home-integrity round (register it with the brain's goals). */
export function repairGoal(rt: ClientRuntime): Goal {
  const builtAround = (home: Pos): BuiltBlock[] => rt.builtNear(home, REPAIR_RADIUS).filter(b => b.state);
  return {
    name: 'repair',
    priority: 38,
    timeoutMs: 10 * MINUTE,
    retryMs: 15 * MINUTE,
    // blocks put back: a round that finds nothing missing (or can put none of it back) brought nothing
    gains: true,
    wants: (s, world) => {
      if (s.activity !== 'work' || s.sleeping || s.dimension !== 'overworld' || !s.home || s.distHome > NEAR_HOME) return null;
      // after 20 min, and then in the evening, or when no trip could go instead (or it has waited 40): the morning is the trips'
      if (!roundDue(s, world, 'repair', 20 * MINUTE)) return null;
      return rt.builtNear(s.home, REPAIR_RADIUS).length ? 'daily round: anything missing from what the bot built' : null;
    },
    run: async ctx => {
      // blocks built before states were kept: take what stands there now as how they should be (once)
      const unknown = rt.builtNear(ctx.s.home!, REPAIR_RADIUS).filter(b => !b.state);
      if (unknown.length) {
        const now = await readCells(ctx, unknown.map(b => b.at));
        const adopt = unknown.map((b, i) => ({ at: b.at, state: now[i] ?? '' }))
          .filter(b => b.state && !/^(minecraft:)?(air|cave_air|void_air)$/.test(b.state));
        rt.adoptStates(adopt);
        if (adopt.length) ctx.progress(`took the current state of ${adopt.length} older built block(s) as their baseline`);
      }
      const built = builtAround(ctx.s.home!);
      if (!built.length) { done(ctx.world, 'repair', ctx.s.now); return 'nothing built near home to check'; }
      const plan = missingBuilt(built, await readCells(ctx, built.map(b => b.at)));
      done(ctx.world, 'repair', ctx.s.now);
      const taken = plan.occupied ? `; ${plan.occupied} cell(s) hold another block now (left alone)` : '';
      const lost = plan.lost.length
        ? `; not put back: ${plan.lost.slice(0, 5).map(l => `${l.state.replace(/\[.*$/, '')} at ${key(l.at)} (${l.why})`).join(', ')}` : '';
      if (!plan.restore.length) return `${plan.lost.length ? 'missing blocks' : `all ${built.length} built blocks checked, none missing`}${lost}${taken}`;
      ctx.progress(`${plan.restore.length} block(s) to put back`);

      // what's needed, carried or fetched from the home chests
      const inv = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
      const have = new Map<string, number>();
      for (const i of inv.items) have.set(i.name, (have.get(i.name) ?? 0) + i.count);
      const need = new Map<string, number>();
      for (const r of plan.restore) need.set(r.item, (need.get(r.item) ?? 0) + 1);
      for (const [item, n] of need) {
        if (n - (have.get(item) ?? 0) <= 0) continue;
        // from the chests, else crafted (planks and stairs from the logs in the chests: a creeper took cabin planks
        // and the round put back only what it found as it was)
        const short = await prepare(ctx, item, n).catch(() => ({ [item]: n }));
        if (!Object.keys(short).length) { have.set(item, n); ctx.progress(`got ${n} ${item} ready`); continue; }
        const now = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
        have.set(item, now.items.filter(i => i.name === item).reduce((a, i) => a + i.count, 0));
      }

      let restored = 0;
      const noItem = new Map<string, number>();
      const failed: string[] = [];
      // a cell put back in vain two days running (buried fill out of reach, say) is left alone from then on
      const tries = (ctx.world.repairFails ??= {});
      for (const r of plan.restore) {
        if ((tries[key(r.at)] ?? 0) >= 2) continue;
        if ((have.get(r.item) ?? 0) <= 0) { noItem.set(r.item, (noItem.get(r.item) ?? 0) + 1); continue; }
        const why = await rt.restoreBlock(r.at, r.item, r.facing);
        if (why) {
          tries[key(r.at)] = (tries[key(r.at)] ?? 0) + 1;
          failed.push(`${r.item} at ${key(r.at)}: ${why}`); ctx.progress(failed.at(-1)!); continue;
        }
        delete tries[key(r.at)];
        restored++;
        ctx.gain(1);
        have.set(r.item, have.get(r.item)! - 1);
        ctx.progress(`put back ${r.item} at ${key(r.at)}`);
      }
      const missing = noItem.size ? `; no ${[...noItem].map(([n, c]) => `${n} (x${c})`).join(', ')} to put back` : '';
      const couldnt = failed.length ? `; couldn't place ${failed.slice(0, 5).join('; ')}` : '';
      return `put back ${restored}/${plan.restore.length} missing block(s)${missing}${couldnt}${lost}${taken}`;
    }
  };
}
