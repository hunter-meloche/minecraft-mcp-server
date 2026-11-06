import type { ClientRuntime } from '../tools.js';
import { survey, type Cluster } from '../survey.js';
import type { Goal } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { readBox, yardOf } from './milestones.js';

/**
 * Once a day: take away the stray blocks left standing on the lawn: an emergency wall-in, Baritone's scaffold, a
 * pillar it climbed. Only what survey-area calls placed-looking, only above the yard's ground (a filled hole is meant
 * to stay), only the scaffold kinds (dirt and cobblestone: never planks or anything else someone may have built
 * with), never next to a built block, and only small clusters.
 */

const MINUTE = 60_000;
const STRAY = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|netherrack)$/;
const MAX_CLUSTER = 16;

const since = (world: WorldMemory, chore: string, now: number) => now - (world.lastDone?.[chore] ?? 0);
const done = (world: WorldMemory, chore: string, now: number) => { world.lastDone ??= {}; world.lastDone[chore] = now; };

/** The cells of the clusters to clear: small, scaffold kinds only, above `groundY`, and clear of built blocks. */
export function strayCells(clusters: Cluster[], groundY: number, built: Set<string>): Pos[] {
  const near = (p: Pos) => {
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (built.has(`${p.x + dx},${p.y + dy},${p.z + dz}`)) return true;
    }
    return false;
  };
  const out: Pos[] = [];
  for (const c of clusters) {
    if (c.blocks > MAX_CLUSTER || !c.cells.every(b => STRAY.test(b.block))) continue;
    const cells = c.cells.filter(b => b.y > groundY);
    if (!cells.length || cells.some(near)) continue;
    // top down, so nothing is left hanging and the bot never digs the block it stands on first
    out.push(...cells.sort((a, b) => b.y - a.y).map(({ x, y, z }) => ({ x, y, z })));
  }
  return out;
}

export function tidyGoal(rt: ClientRuntime): Goal {
  return {
    name: 'tidy',
    priority: 34,
    timeoutMs: 6 * MINUTE,
    retryMs: 30 * MINUTE,
    wants: (s, world) => {
      if (s.activity !== 'work' || s.sleeping || !s.home || s.distHome > 12 || s.dimension !== 'overworld') return null;
      return since(world, 'tidy', s.now) > 20 * MINUTE ? 'daily round: stray blocks on the lawn' : null;
    },
    run: async ctx => {
      done(ctx.world, 'tidy', ctx.s.now);
      const yard = await yardOf(ctx);
      const box = { x: yard.x1 - 2, y: yard.y - 3, z: yard.z1 - 2, width: yard.x2 - yard.x1 + 5, height: 14, length: yard.z2 - yard.z1 + 5 };
      const blocks = await readBox(ctx, box);
      const builtList = rt.builtNear({ x: (yard.x1 + yard.x2) / 2, y: yard.y, z: (yard.z1 + yard.z2) / 2 }, 64);
      const built = new Set(builtList.map(b => `${b.at.x},${b.at.y},${b.at.z}`));
      const r = survey(box, blocks, p => built.has(`${p.x},${p.y},${p.z}`));
      const cells = strayCells(r.placed, yard.y, built).slice(0, 40);
      if (!cells.length) return 'the lawn is clear';
      let dug = 0;
      for (const c of cells) {
        if (ctx.signal.aborted) break;
        const d = await ctx.act('dig-block', { ...c });
        if (d.ok && /^Dug/.test(d.text)) dug++;
      }
      return `cleared ${dug} of ${cells.length} stray block(s)`;
    }
  };
}
