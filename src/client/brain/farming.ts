import { fromGate, no, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { WorldMemory } from './memory.js';
import type { Milestone, MilestoneState, Step, StepResult } from './progress.js';
import { progressOf } from './progress.js';
import { prepareBill } from './project.js';
import { addZone, readBox, siteStep } from './milestones.js';
import { takeFromChests } from './chests.js';
import { digByHand } from '../structures/job.js';

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
      // (short of materials: with `need` the project waits longer each time, until all of it is there)
      if (Object.keys(short).length) return { ...blocked(`gathering for a bucket: short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')}`, 3 * MINUTE), need: short };
    }
    // the nearest still water open to the sky (the lake: the yard's pond is filled in)
    const found = await ctx.call<{ positions: Site[] }>('world.findBlocks', { block: 'water', maxDistance: 64, count: 256, openAbove: true });
    // real open water: not in the yard, and sky above it (a pocket under the storage house had air right above it)
    const yard = ctx.world.yard;
    const outside = found.positions.filter(w => !yard || w.x < yard.x1 - 2 || w.x > yard.x2 + 2 || w.z < yard.z1 - 2 || w.z > yard.z2 + 2);
    let tried = 0;
    for (const w of outside) {
      if (tried >= 6) break;
      if (!/^water(\[level=0\])?$/.test(await block(ctx, w))) continue;
      const { blocks: col } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { x: w.x, y: w.y + 1, z: w.z, width: 1, height: 16, length: 1 });
      if (col.some(b => b && !/^(minecraft:)?(air|cave_air|void_air)$/.test(b))) continue;
      tried++;
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
      // by id: the region gives states ("grass_block[snowy=false]"), and matched whole it tilled nothing
      const b = (blocks[i] ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
      if (!/^(grass_block|dirt|coarse_dirt|rooted_dirt|dirt_path)$/.test(b)) continue;
      const at = { x: site.x + i % SIZE, y: site.y, z: site.z + Math.floor(i / SIZE) };
      const r = await ctx.act('use-item-on-block', { ...at, item: hoe, face: 'up' });
      if (/farmland/.test(r.text)) tilled++; else left++;
    }
    if (ctx.signal.aborted) return going(`tilled ${tilled}`);
    const after = (await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...site, width: SIZE, height: 1, length: SIZE })).blocks;
    const farmland = after.filter(b => /farmland/.test(b ?? '')).length;
    if (farmland >= SIZE * SIZE - 1 - 4) return ok(`${farmland} farmland`);
    // most of it at least, or it isn't a plot yet (it once called 0 farmland done)
    if (farmland >= (SIZE * SIZE) / 2 && !left) return ok(`${farmland} farmland (the rest is not dirt)`);
    return going(`tilled ${tilled}, ${left} would not till (${farmland} farmland)`);
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
    // from just outside the plot's north edge: Baritone won't walk onto farmland (it would trample it), so a spot in
    // the plot was "no path found" 2 blocks away; the farm reaches the far corner from there with range 11
    await ctx.act('move-to-position', { x: c.x, y: c.y + 1, z: site.z - 1, range: 1, timeoutMs: 90_000 }).catch(() => undefined);
    const r = await ctx.act('farm', { range: 11, timeoutMs: 180_000 });
    addZone(ctx.world, 'plot', { x: site.x, y: site.y, z: site.z, width: SIZE, length: SIZE });
    ctx.world.landmarks.foundAt = 0; // pick up the new farmland
    progressOf(ctx.world).carry = progressOf(ctx.world).carryCap = undefined;
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
 * Run now? The "no" is said in this order: no round to do (no tree farm, or the round is not due); then what keeps a
 * round that is due from going (not in the yard, no room for the logs); the hour last.
 */
const treeGate = (s: Snapshot, world: WorldMemory): Gate => {
  if (!world.zones?.['trees:sapling']?.length) return { cause: 'unneeded', text: 'no tree farm' };
  const last = world.lastDone?.trees ?? 0;
  if (!(s.now - last > 20 * MINUTE)) return no.notDue('trees', s.now, last, 20 * MINUTE);
  if (s.distHome > 24) return no.away(s, 'trees', 24);
  if (s.slotsUsed >= 33) return no.pockets(s, 'trees', 33);
  return no.late(s, 'trees') ?? { want: 'daily round: the tree farm' };
};

/**
 * Once a day: fell the grown trees of the tree farm and plant saplings where the trunks stood (the leaves drop more
 * as they decay; a bare cell is planted next round).
 *
 * Every log in the plot goes, at any height (branches, and trunks a stopped round left floating: the old round cut
 * each trunk from the bottom with Baritone's dig and, stopped midway, never looked at a tree again once its bottom
 * log was gone). Logs are cut by hand from the ground where they're in reach (no Baritone: its dig pillared up on
 * cobblestone for the high ones and left the pillars), and only what's out of reach is left to Baritone. Then the
 * plot is cleared of scaffold: nothing but trees belongs in it, so every throwaway block above the ground goes.
 */
export const treeFarm: Goal = {
  name: 'trees',
  priority: 30,
  timeoutMs: 10 * MINUTE,
  retryMs: 30 * MINUTE,
  gate: treeGate,
  ...fromGate(treeGate),
  // logs cut and saplings planted: a round over a plot where nothing has grown (or that only clears scaffold) brought none
  gains: true,
  run: async ctx => {
    (ctx.world.lastDone ??= {}).trees = ctx.s.now;
    const cells = ctx.world.zones!['trees:sapling'];
    const box = treePlot(ctx.world, cells);
    const here = { at: ctx.s.position };
    let blocks = await readBox(ctx, box);
    const logs = plotLogs(blocks, box);
    let cut = 0, byBaritone = 0;
    const gone = new Set<string>();
    const high: Site[] = [];
    if (logs.length) ctx.progress(`felling ${logs.length} log(s) in the tree farm`);
    for (const p of logs) {
      if (ctx.signal.aborted) break;
      const why = await digByHand(ctx, blocks, box, p, here, gone);
      if (!why) { cut++; ctx.gain(1); gone.add(`${p.x},${p.y},${p.z}`); } else high.push(p);
    }
    // out of reach from the ground (the top of a tall one): Baritone, and its pillar comes down below
    for (const p of high) {
      if (ctx.signal.aborted) break;
      const r = await ctx.act('dig-block', { ...p });
      if (/^Dug/.test(r.text)) { byBaritone++; ctx.gain(1); }
    }
    if (cut + byBaritone) await ctx.act('collect-items', { x: box.x + Math.floor(box.width / 2), y: box.y + 1, z: box.z + Math.floor(box.length / 2), radius: 10, timeoutMs: 40_000 }).catch(() => undefined);
    // the scaffold: anything thrown down in the plot above the ground
    // by hand first; what's out of reach (an old pillar's top, left hanging once its foot was dug) goes to Baritone's
    // dig, and the pillar Baritone stands on for that is taken down by hand in the next pass
    let cleared = 0;
    let left: string[] = [];
    for (let pass = 0; pass < 3 && !ctx.signal.aborted; pass++) {
      blocks = await readBox(ctx, box);
      const scaffold = plotScaffold(blocks, box, cells[0].y);
      if (!scaffold.length) { left = []; break; }
      const high: Site[] = [];
      left = [];
      for (const p of scaffold) {
        if (ctx.signal.aborted) break;
        const why = await digByHand(ctx, blocks, box, p, here, new Set());
        if (!why) cleared++; else { high.push(p); left.push(`${p.x},${p.y},${p.z}: ${why}`); }
      }
      if (!high.length || pass === 2) break;
      for (const p of high) {
        if (ctx.signal.aborted) break;
        const r = await ctx.act('dig-block', { ...p });
        if (/^Dug/.test(r.text)) cleared++;
      }
    }
    if (left.length) ctx.progress(`scaffold left in the tree farm: ${left.slice(0, 5).join('; ')}`);
    const p = await plantSaplings(ctx, cells);
    ctx.gain(p.planted);
    return `cut ${cut + byBaritone} log(s)${byBaritone ? ` (${byBaritone} out of reach, by Baritone)` : ''}${high.length - byBaritone > 0 ? `, ${high.length - byBaritone} left` : ''}; ` +
      `cleared ${cleared} scaffold block(s)${left.length ? `, ${left.length} left` : ''}; planted ${p.planted} sapling(s)${p.bare ? `, ${p.bare} cell(s) bare` : ''}`;
  }
};

/** The tree farm's plot: its zone (or the saplings' box, a tree's crown round it), from the ground up past the tallest tree. */
export function treePlot(world: { zones?: Record<string, { x: number; y: number; z: number; width?: number; length?: number }[]> }, cells: Site[]): Site & { width: number; height: number; length: number } {
  const z = world.zones?.trees?.[0];
  const ground = cells[0].y - 1;
  if (z?.width && z.length) return { x: z.x, y: ground, z: z.z, width: z.width, height: 14, length: z.length };
  const x1 = Math.min(...cells.map(c => c.x)) - 2, x2 = Math.max(...cells.map(c => c.x)) + 2;
  const z1 = Math.min(...cells.map(c => c.z)) - 2, z2 = Math.max(...cells.map(c => c.z)) + 2;
  return { x: x1, y: ground, z: z1, width: x2 - x1 + 1, height: 14, length: z2 - z1 + 1 };
}

type Box3 = Site & { width: number; height: number; length: number };
const at = (box: Box3, i: number): Site => ({ x: box.x + i % box.width, y: box.y + Math.floor(i / (box.width * box.length)), z: box.z + Math.floor(i / box.width) % box.length });
const bare = (b: string | null) => (b ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');

/** Every log in the plot, top down (the top of each trunk first, so nothing is left hanging if a round stops). */
export function plotLogs(blocks: (string | null)[], box: Box3): Site[] {
  const out: Site[] = [];
  blocks.forEach((b, i) => { if (LOG.test(bare(b))) out.push(at(box, i)); });
  return out.sort((a, b) => b.y - a.y || a.x - b.x || a.z - b.z);
}

/** Scaffold in the plot: throwaway blocks and dirt above the ground (the saplings stand on the ground itself), top down. */
export const SCAFFOLD = /^(cobblestone|cobbled_deepslate|netherrack|andesite|diorite|granite|tuff|dirt|stone)$/;
export function plotScaffold(blocks: (string | null)[], box: Box3, saplingY: number): Site[] {
  const out: Site[] = [];
  blocks.forEach((b, i) => { const p = at(box, i); if (p.y >= saplingY && SCAFFOLD.test(bare(b))) out.push(p); });
  return out.sort((a, b) => b.y - a.y || a.x - b.x || a.z - b.z);
}
