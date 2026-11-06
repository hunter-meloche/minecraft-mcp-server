import type { GoalContext } from './goals.js';
import type { Milestone, MilestoneState, Step, StepResult } from './progress.js';
import { progressOf } from './progress.js';
import { prepareBill } from './project.js';
import { addZone, siteStep } from './milestones.js';
import { takeFromChests } from './chests.js';

/**
 * Farm v2: a 9 x 9 crop plot with a water source in the middle (one source keeps 4 blocks each way wet), tilled and
 * sown. The bucket comes from iron (the stock trips mine it when short) and is filled at the lake.
 */

const MINUTE = 60_000;
const SIZE = 9;
const ok = (text: string): StepResult => ({ status: 'done', text });
const going = (text: string): StepResult => ({ status: 'progress', text });
const blocked = (text: string, retryMs = 5 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });

type Site = { x: number; y: number; z: number };
const siteOf = (st: MilestoneState) => st.data.site as Site;
const centreOf = (site: Site) => ({ x: site.x + (SIZE - 1) / 2, y: site.y, z: site.z + (SIZE - 1) / 2 });
const block = async (ctx: GoalContext, p: Site) =>
  ((await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...p, width: 1, height: 1, length: 1 })).blocks[0] ?? '').replace(/^minecraft:/, '');
const carried = (ctx: GoalContext, re: RegExp) => ctx.s.items.filter(i => i.slot < 36 && re.test(i.name));
async function inv(ctx: GoalContext): Promise<Map<string, number>> {
  const r = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
  const m = new Map<string, number>();
  for (const i of r.items) if (i.slot < 36) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
  return m;
}

/** A water bucket in hand: crafted from 3 iron (from the chests, or what the stock trips bring), filled at still water. */
export const waterBucketStep: Step = {
  name: 'get a water bucket',
  run: async ctx => {
    let have = await inv(ctx);
    if (have.get('water_bucket')) return ok('a water bucket in hand');
    if (!have.get('bucket')) await takeFromChests(ctx, 'water_bucket', 1);
    have = await inv(ctx);
    if (have.get('water_bucket')) return ok('a water bucket from the chest');
    if (!have.get('bucket')) {
      const short = await prepareBill(ctx, { bucket: 1 });
      if (Object.keys(short).length) return blocked(`gathering for a bucket: short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')}`, 3 * MINUTE);
    }
    // the nearest still water open to the sky (the lake: the yard's pond is filled in)
    const found = await ctx.call<{ positions: Site[] }>('world.findBlocks', { block: 'water', maxDistance: 64, count: 64, openAbove: true });
    for (const w of found.positions.slice(0, 8)) {
      if (!/^water(\[level=0\])?$/.test(await block(ctx, w))) continue;
      const r = await ctx.act('use-item-on-block', { ...w, item: 'bucket', face: 'up' });
      if ((await inv(ctx)).get('water_bucket')) return ok(`filled a bucket at (${w.x}, ${w.y}, ${w.z})`);
      ctx.progress(`bucket at (${w.x}, ${w.y}, ${w.z}): ${r.text.slice(0, 80)}`);
    }
    return blocked('no still water to fill the bucket at within 64 blocks', 20 * MINUTE);
  }
};

/** Level the plot, dig out the middle and pour the water in. */
export const waterStep: Step = {
  name: 'level the plot and pour the water',
  run: async (ctx, st) => {
    const site = siteOf(st);
    const c = centreOf(site);
    if (/^water/.test(await block(ctx, c))) return ok('the water is in');
    if (!(await inv(ctx)).get('water_bucket')) { st.step--; return going('the water bucket is gone: getting another'); }
    if (!st.data.levelled) {
      const r = await ctx.act('level-area', { x1: site.x, z1: site.z, x2: site.x + SIZE - 1, z2: site.z + SIZE - 1, level: site.y, timeoutMs: 6 * MINUTE });
      if (!/Now level|Already level/.test(r.text)) return going(`leveling the plot: ${r.text.split('\n').pop()?.slice(0, 100)}`);
      st.data.levelled = true;
    }
    if (!/^air$/.test(await block(ctx, c))) await ctx.act('dig-block', { ...c, collect: true });
    const r = await ctx.act('use-item-on-block', { ...c, y: c.y - 1, item: 'water_bucket', face: 'up' });
    if (/^water/.test(await block(ctx, c))) return ok(`water at (${c.x}, ${c.y}, ${c.z})`);
    return going(`pouring the water: ${r.text.slice(0, 100)}`);
  }
};

/** Till every ground cell of the plot but the water. */
export const tillStep: Step = {
  name: 'till the plot',
  run: async (ctx, st) => {
    const site = siteOf(st);
    let hoe: string | undefined = carried(ctx, /_hoe$/)[0]?.name;
    if (!hoe) {
      await prepareBill(ctx, { stone_hoe: 1 });
      const found = [...(await inv(ctx)).keys()].find(n => /_hoe$/.test(n));
      if (!found) return blocked('no hoe (the kit makes one)', 3 * MINUTE);
      hoe = found;
    }
    const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...site, width: SIZE, height: 1, length: SIZE });
    let tilled = 0, left = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (ctx.signal.aborted) break;
      const b = (blocks[i] ?? '').replace(/^minecraft:/, '');
      if (!/^(grass_block|dirt|coarse_dirt|rooted_dirt|dirt_path)$/.test(b)) continue;
      const at = { x: site.x + i % SIZE, y: site.y, z: site.z + Math.floor(i / SIZE) };
      const r = await ctx.act('use-item-on-block', { ...at, item: hoe, face: 'up' });
      if (/farmland/.test(r.text)) tilled++; else left++;
    }
    if (ctx.signal.aborted) return going(`tilled ${tilled}`);
    const after = (await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...site, width: SIZE, height: 1, length: SIZE })).blocks;
    const farmland = after.filter(b => /farmland/.test(b ?? '')).length;
    if (farmland >= SIZE * SIZE - 1 - 4) return ok(`${farmland} farmland`);
    return left ? going(`tilled ${tilled}, ${left} would not till (${farmland} farmland)`) : ok(`${farmland} farmland (the rest is not dirt)`);
  }
};

/** Sow the plot (the farm tool plants on bare farmland), then remember it: the farm round and the food goal see it. */
export const sowStep: Step = {
  name: 'sow the plot',
  run: async (ctx, st) => {
    const site = siteOf(st);
    const c = centreOf(site);
    const have = await inv(ctx);
    const seeds = ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds'].reduce((a, n) => a + (have.get(n) ?? 0), 0);
    if (seeds < 20) for (const n of ['wheat_seeds', 'carrot', 'potato']) await takeFromChests(ctx, n, 40);
    await ctx.act('move-to-position', { x: c.x, y: c.y + 1, z: c.z + 1, range: 2, timeoutMs: 90_000 });
    const r = await ctx.act('farm', { range: 6, timeoutMs: 120_000 });
    addZone(ctx.world, 'plot', { x: site.x, y: site.y, z: site.z, width: SIZE, length: SIZE });
    ctx.world.landmarks.foundAt = 0; // pick up the new farmland
    progressOf(ctx.world).carry = undefined;
    return ok(r.text.slice(0, 120));
  }
};

/** One crop plot (id `plot` + n, so a second can follow the first). */
export function cropPlotMilestone(n: number, prereqs: string[]): Milestone {
  return {
    id: `plot${n}`,
    title: n === 1 ? 'a watered crop plot' : `crop plot ${n}`,
    prereqs,
    done: v => (v.world.zones?.plot?.length ?? 0) >= n,
    steps: [siteStep('plot', SIZE, SIZE), waterBucketStep, waterStep, tillStep, sowStep]
  };
}

// ------------------------------------------------------------------------------------------------ tree farm

const TREE_COLS = 4, TREE_ROWS = 3, TREE_PITCH = 4;
const SAPLING = /_sapling$/;
const LOG = /^(?!stripped_)[a-z_]+_log$/;

/** The sapling cells of a tree farm on `site` (ground y): where the trunks stand, a block above the ground. */
export function treeCells(site: Site): Site[] {
  const out: Site[] = [];
  for (let j = 0; j < TREE_ROWS; j++) for (let i = 0; i < TREE_COLS; i++) out.push({ x: site.x + i * TREE_PITCH, y: site.y + 1, z: site.z + j * TREE_PITCH });
  return out;
}

/** Plant a sapling on each bare cell (whatever saplings it carries or has in the chests). */
async function plantSaplings(ctx: GoalContext, cells: Site[]): Promise<{ planted: number; bare: number }> {
  let planted = 0, bare = 0;
  for (const c of cells) {
    if (ctx.signal.aborted) break;
    const here = await block(ctx, c);
    if (here !== 'air' && !/^(short_grass|tall_grass|fern|leaf_litter|dandelion|poppy)$/.test(here.replace(/\[.*$/, ''))) continue;
    let sapling = [...(await inv(ctx))].find(([n]) => SAPLING.test(n))?.[0];
    if (!sapling) {
      const stored = Object.entries(ctx.world.chestItems ?? {}).flatMap(([, items]) => Object.keys(items)).find(n => SAPLING.test(n));
      if (stored) await takeFromChests(ctx, stored, 12);
      sapling = [...(await inv(ctx))].find(([n]) => SAPLING.test(n))?.[0];
    }
    if (!sapling) { bare++; continue; }
    if (here !== 'air') await ctx.act('dig-block', { ...c, collect: false });
    const r = await ctx.act('place-block', { ...c, faceDirection: 'down', item: sapling });
    if (/^Placed/.test(r.text)) planted++; else bare++;
  }
  return { planted, bare };
}

/** A grid of 12 saplings with 3 blocks between them, once the plot is in: logs (and charcoal) from home. */
export function treeFarmMilestone(prereqs: string[]): Milestone {
  return {
    id: 'trees',
    title: 'a tree farm',
    prereqs,
    done: v => !!v.world.zones?.trees?.length,
    steps: [
      siteStep('trees', (TREE_COLS - 1) * TREE_PITCH + 1 + 2, (TREE_ROWS - 1) * TREE_PITCH + 1 + 2),
      {
        name: 'plant the saplings',
        run: async (ctx, st) => {
          // the site has a block of room on each side: the grid starts one in
          const s0 = siteOf(st);
          const site = { x: s0.x + 1, y: s0.y, z: s0.z + 1 };
          const cells = treeCells(site);
          const r = await plantSaplings(ctx, cells);
          if (r.bare === cells.length) return blocked('no saplings to plant', 30 * MINUTE);
          addZone(ctx.world, 'trees', { x: s0.x, y: s0.y, z: s0.z, width: (TREE_COLS - 1) * TREE_PITCH + 3, length: (TREE_ROWS - 1) * TREE_PITCH + 3 });
          for (const c of cells) addZone(ctx.world, 'trees:sapling', c);
          return ok(`planted ${r.planted} sapling(s)${r.bare ? `, ${r.bare} cell(s) bare for now` : ''}`);
        }
      }
    ]
  };
}

/**
 * Once a day: fell the grown trees of the tree farm (each trunk dug from the bottom up: Baritone climbs for the top)
 * and plant saplings where the trunks stood (the leaves drop more as they decay; a bare cell is planted next round).
 */
export const treeFarm: import('./goals.js').Goal = {
  name: 'trees',
  priority: 28,
  timeoutMs: 10 * MINUTE,
  retryMs: 30 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || s.sleeping || !world.zones?.['trees:sapling']?.length || s.distHome > 24 || s.slotsUsed >= 33) return null;
    return s.now - (world.lastDone?.trees ?? 0) > 20 * MINUTE ? 'daily round: the tree farm' : null;
  },
  run: async ctx => {
    (ctx.world.lastDone ??= {}).trees = ctx.s.now;
    const cells = ctx.world.zones!['trees:sapling'];
    let felled = 0, logs = 0;
    for (const c of cells) {
      if (ctx.signal.aborted) break;
      const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...c, width: 1, height: 10, length: 1 });
      const trunk = blocks.map((b, i) => ({ b: (b ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, ''), y: c.y + i })).filter(t => LOG.test(t.b));
      if (!trunk.length || trunk[0].y !== c.y) continue; // a sapling still, or nothing
      ctx.progress(`felling the tree at (${c.x}, ${c.z}): ${trunk.length} log(s)`);
      for (const t of trunk) {
        if (ctx.signal.aborted) break;
        const r = await ctx.act('dig-block', { x: c.x, y: t.y, z: c.z });
        if (/^Dug/.test(r.text)) logs++;
      }
      felled++;
    }
    const p = await plantSaplings(ctx, cells);
    return `felled ${felled} tree(s) (${logs} log(s)); planted ${p.planted} sapling(s)${p.bare ? `, ${p.bare} cell(s) bare` : ''}`;
  }
};
