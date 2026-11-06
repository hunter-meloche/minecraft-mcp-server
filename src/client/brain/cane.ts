import type { Goal, GoalContext } from './goals.js';
import type { Milestone, StepResult } from './progress.js';
import type { Pos } from './memory.js';
import { addZone } from './milestones.js';
import { takeFromChests } from './chests.js';

/**
 * Sugar cane on the lake shore (paper for books, books for the enchanting table and its shelves): a few stalks from
 * the wild, planted on the land cells right beside the water, and a daily round that cuts the top two blocks and
 * leaves the base to grow again.
 */

const MINUTE = 60_000;
const CANE_ON = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|sand|red_sand|mud|moss_block)$/;
const AIRY = /^(air|short_grass|tall_grass|fern|leaf_litter|dandelion|poppy|bush)$/;
const name = (b: string | null | undefined) => (b ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
const ok = (text: string): StepResult => ({ status: 'done', text });
const blocked = (text: string, retryMs = 30 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });

/**
 * Shore cells for cane in a region read 3 high from the water's level (layer 0: the ground the cane stands on and the
 * water beside it; layers 1 and 2: open air for the cane): ground cane grows on, with water right next to it on some
 * side and air above. Returns the cells the cane goes in (a block above the ground), every other one along the shore.
 */
export function shoreCells(box: { x: number; y: number; z: number; width: number; height: number; length: number },
  blocks: (string | null)[], max: number): Pos[] {
  const { width: w, length: l } = box;
  const at = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= w || z >= l || y < 0 || y >= box.height ? '' : name(blocks[x + z * w + y * w * l]));
  const out: Pos[] = [];
  const taken = new Set<string>();
  for (let z = 0; z < l && out.length < max; z++) for (let x = 0; x < w && out.length < max; x++) {
    if (!CANE_ON.test(at(x, 0, z)) || !AIRY.test(at(x, 1, z)) || !AIRY.test(at(x, 2, z))) continue;
    if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => at(x + dx, 0, z + dz) === 'water')) continue;
    // a gap between plants, so each can be cut without stepping on the next
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => taken.has(`${x + dx},${z + dz}`))) continue;
    taken.add(`${x},${z}`);
    out.push({ x: box.x + x, y: box.y + 1, z: box.z + z });
  }
  return out;
}

const caneCount = async (ctx: GoalContext) =>
  (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items
    .filter(i => i.slot < 36 && i.name === 'sugar_cane').reduce((a, i) => a + i.count, 0);

export function caneMilestone(prereqs: string[]): Milestone {
  return {
    id: 'cane',
    title: 'sugar cane by the lake',
    prereqs,
    done: v => !!v.world.zones?.cane?.length,
    steps: [
      {
        name: 'find sugar cane',
        run: async ctx => {
          if ((await caneCount(ctx)) < 3) await takeFromChests(ctx, 'sugar_cane', 12);
          if ((await caneCount(ctx)) >= 3) return ok('cane in hand');
          const r = await ctx.act('mine-blocks', { block: 'sugar_cane', count: 6, timeoutMs: 4 * MINUTE });
          await ctx.act('go-home', { name: 'home', timeoutMs: 180_000 }).catch(() => undefined);
          if ((await caneCount(ctx)) >= 1) return ok(r.text.split('\n')[0].slice(0, 100));
          return blocked(`no sugar cane found: ${r.text.split('\n')[0].slice(0, 100)}`, 60 * MINUTE);
        }
      },
      {
        name: 'plant cane on the lake shore',
        run: async ctx => {
          const water = (await ctx.call<{ positions: Pos[] }>('world.findBlocks', { block: 'water', maxDistance: 64, count: 64, openAbove: true })).positions;
          const lake = water[0];
          if (!lake) return blocked('no open water within 64 blocks', 60 * MINUTE);
          const box = { x: lake.x - 12, y: lake.y, z: lake.z - 12, width: 25, height: 3, length: 25 };
          const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', box);
          const cells = shoreCells(box, blocks, Math.min(12, await caneCount(ctx)));
          if (!cells.length) return blocked(`no shore to plant on round (${lake.x}, ${lake.z})`, 60 * MINUTE);
          let planted = 0;
          for (const c of cells) {
            if (ctx.signal.aborted) break;
            const r = await ctx.act('place-block', { ...c, faceDirection: 'down', item: 'sugar_cane' });
            if (/^Placed/.test(r.text)) { planted++; addZone(ctx.world, 'cane', c); }
          }
          return planted ? ok(`planted ${planted} cane on the shore by (${lake.x}, ${lake.z})`) : blocked('the cane would not go in', 20 * MINUTE);
        }
      }
    ]
  };
}

/** Once a day: cut the cane down to its base (the stalk above the bottom block), and replant a missing base. */
export const caneRound: Goal = {
  name: 'cane',
  priority: 29,
  timeoutMs: 6 * MINUTE,
  retryMs: 30 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || s.sleeping || !world.zones?.cane?.length || s.distHome > 24 || s.slotsUsed >= 34) return null;
    return s.now - (world.lastDone?.cane ?? 0) > 20 * MINUTE ? 'daily round: the sugar cane' : null;
  },
  run: async ctx => {
    (ctx.world.lastDone ??= {}).cane = ctx.s.now;
    let cut = 0, replanted = 0;
    const before = await caneCount(ctx);
    for (const c of ctx.world.zones!.cane) {
      if (ctx.signal.aborted) break;
      const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...c, width: 1, height: 3, length: 1 });
      const [base, mid] = blocks.map(name);
      if (base === 'sugar_cane' && mid === 'sugar_cane') {
        // cutting the second block brings the rest down with it
        const r = await ctx.act('dig-block', { x: c.x, y: c.y + 1, z: c.z, collect: true });
        if (/^Dug/.test(r.text)) cut++;
      } else if (AIRY.test(base) && (await caneCount(ctx)) > 0) {
        const r = await ctx.act('place-block', { ...c, faceDirection: 'down', item: 'sugar_cane' });
        if (/^Placed/.test(r.text)) replanted++;
      }
    }
    const got = (await caneCount(ctx)) - before + replanted;
    return `cut ${cut} stalk(s) (${Math.max(0, got)} cane)${replanted ? `, replanted ${replanted}` : ''}`;
  }
};
