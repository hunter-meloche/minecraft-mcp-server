import type { GoalContext } from './goals.js';

/**
 * Filling a bucket at a lava or water source without going near danger. The first lava run walked the bot to lava 40
 * blocks under the yard (findBlocks' openAbove is no sky check), and use-item-on-block's "walk closer when too far"
 * handed the approach to Baritone, which took it into the cave beside the lava: it burned to death and lost its
 * diamond tools. So everything is decided beforehand from the blocks round the source, and anything off is refused:
 * - lava only from a pool open to the sky (every block above it to the top of the scan is air) near ground level;
 * - a stand spot on solid ground, room for feet and head, at least 2 from the source (water: 1), no lava in any cell
 *   round the feet or the floor, in reach (4.3 from the eye), with a clear line of sight from the eye to the source;
 * - the walk there careful (no digging, no placing), the arrival checked, the cells round the feet read again;
 * - the bucket used from there through the mod's useOn directly, never "walk closer": if it doesn't work from
 *   there, another spot or another source, never nearer.
 */

export type P = { x: number; y: number; z: number };
export type Box = P & { width: number; height: number; length: number };

/** How far round a source the stand spots are looked for. */
export const AROUND = 4;
/** How much sky above a lava source must be air. */
export const SKY = 24;
const REACH = 4.3;

const id = (b: string | null | undefined) => (b ?? '').replace(/^minecraft:/, '');
const isLava = (b: string | null | undefined) => /^(lava|fire|magma_block|soul_fire)(\[|$)/.test(id(b));
const isFluid = (b: string | null | undefined) => /^(lava|water|bubble_column)(\[|$)/.test(id(b));
/** What a player walks through (feet and head room). */
const PASSABLE = /^(air|cave_air|short_grass|tall_grass|fern|large_fern|dead_bush|dandelion|poppy|leaf_litter|wildflowers|pink_petals|snow)(\[|$)/;
/** A floor to stand on: solid, not a fluid, not hot, not something that isn't a full floor. */
const NOT_FLOOR = /^(air|cave_air|void_air|water|lava|fire|soul_fire|magma_block|powder_snow|.*_fence|.*_wall|.*_gate|.*_door|.*_trapdoor|.*torch|.*_sign|.*_carpet|.*_pressure_plate|.*_button|ladder|vine|short_grass|tall_grass|fern|.*_leaves|scaffolding|cobweb|sweet_berry_bush|cactus|campfire|.*_campfire)(\[|$)/;

/** The region of blocks round a source a stand spot is chosen from (feet levels from one under it to two over). */
export const aroundBox = (t: P): Box => ({ x: t.x - AROUND, y: t.y - 1, z: t.z - AROUND, width: 2 * AROUND + 1, height: 5, length: 2 * AROUND + 1 });

/** Every block above a source, up to SKY, is air: a pool under the open sky, not a cave. */
export function openToSky(column: (string | null)[]): boolean {
  return column.length >= SKY && column.every(b => b !== null && /^(air|void_air)$/.test(id(b)));
}

/**
 * Safe spots to stand at to bucket the source `t`: feet cells, nearest the bot first. `blocks` is a readBox of
 * aroundBox(t). `keep` is how far from the source the spot must be (2 for lava, 1 for water).
 */
export function standSpots(blocks: (string | null)[], box: Box, t: P, from: P, keep: number): P[] {
  const at = (x: number, y: number, z: number): string | null | undefined => {
    const ix = x - box.x, iy = y - box.y, iz = z - box.z;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= box.width || iy >= box.height || iz >= box.length) return undefined;
    return blocks[ix + iz * box.width + iy * box.width * box.length];
  };
  const out: { p: P; d: number; plants: number }[] = [];
  for (const fy of [t.y, t.y + 1]) {
    for (let dz = -AROUND + 1; dz <= AROUND - 1; dz++) for (let dx = -AROUND + 1; dx <= AROUND - 1; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) < keep) continue;
      const f = { x: t.x + dx, y: fy, z: t.z + dz };
      const floor = at(f.x, f.y - 1, f.z), feet = at(f.x, f.y, f.z), head = at(f.x, f.y + 1, f.z);
      if (floor == null || feet == null || head == null) continue; // unknown is no
      if (NOT_FLOOR.test(id(floor)) || !PASSABLE.test(id(feet)) || !PASSABLE.test(id(head))) continue;
      // no lava (or fire) anywhere round the feet, the floor or the head: one step from danger is too close
      let hot = false;
      for (let y = f.y - 1; y <= f.y + 1 && !hot; y++) for (let z = f.z - 1; z <= f.z + 1 && !hot; z++) for (let x = f.x - 1; x <= f.x + 1 && !hot; x++) {
        const b = at(x, y, z);
        if (b === undefined || isLava(b)) hot = true;
      }
      if (hot) continue;
      // in reach, and nothing on the line from the eye to the source's top but air, fluid, or plants it can clear
      const line = sightLine(at, f, t);
      if (!line) continue;
      out.push({ p: f, d: Math.hypot(f.x - from.x, f.y - from.y, f.z - from.z), plants: line.length });
    }
  }
  // a clear line first (breaking the tall grass on the line didn't always clear the aim; the clear spot filled at once)
  return out.sort((a, b) => a.plants - b.plants || a.d - b.d).map(o => o.p);
}

/**
 * The line from the eye at feet `f` to the top of source `t`: undefined when it's out of reach or a solid block is in
 * the way; else the plant cells on it (a bucket's aim stops at anything with a hitbox: tall grass between the shore
 * spot and the lake made every fill "use: Fail"), which the bot breaks by hand before using the bucket.
 */
export function sightLine(at: (x: number, y: number, z: number) => string | null | undefined, f: P, t: P): P[] | undefined {
  const eye = { x: f.x + 0.5, y: f.y + 1.62, z: f.z + 0.5 };
  const aim = { x: t.x + 0.5, y: t.y + 0.9, z: t.z + 0.5 };
  const len = Math.hypot(aim.x - eye.x, aim.y - eye.y, aim.z - eye.z);
  if (len > REACH) return undefined;
  const plants = new Map<string, P>();
  for (let s = 0.2; s < len - 0.2; s += 0.1) {
    const q = { x: eye.x + (aim.x - eye.x) * s / len, y: eye.y + (aim.y - eye.y) * s / len, z: eye.z + (aim.z - eye.z) * s / len };
    const c = { x: Math.floor(q.x), y: Math.floor(q.y), z: Math.floor(q.z) };
    if (c.x === t.x && c.y === t.y && c.z === t.z) break;
    const b = at(c.x, c.y, c.z);
    if (b === undefined) return undefined;
    if (/^(air|cave_air|void_air)$/.test(id(b)) || isFluid(b)) continue;
    if (PASSABLE.test(id(b))) { plants.set(`${c.x},${c.y},${c.z}`, c); continue; }
    return undefined; // solid in the way
  }
  return [...plants.values()];
}

/** Why a source is no good to bucket, or '' with its stand spots. */
export interface SourceVerdict { at: P; why: string; spots: P[] }

const region = async (ctx: Pick<GoalContext, 'call'>, b: Box) =>
  (await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...b }, 30_000)).blocks;

/**
 * Look a source over: a still source, open to the sky (lava), near the ground (lava: within 4 of `groundY`), and
 * at least one safe stand spot. Read-only.
 */
export async function judgeSource(ctx: Pick<GoalContext, 'call'>, t: P, fluid: 'lava' | 'water', groundY: number | undefined, from: P): Promise<SourceVerdict> {
  const here = (await region(ctx, { ...t, width: 1, height: 1, length: 1 }))[0];
  if (!new RegExp(`^${fluid}(\\[level=0\\])?$`).test(id(here))) return { at: t, why: `not a still ${fluid} source (${id(here) || 'unknown'})`, spots: [] };
  if (fluid === 'lava' && groundY !== undefined && Math.abs(t.y - groundY) > 4) return { at: t, why: `${t.y - groundY} from the ground level (under ground, or up a mountain)`, spots: [] };
  // water too: a cave pond is a walk into a cave
  if (!openToSky(await region(ctx, { x: t.x, y: t.y + 1, z: t.z, width: 1, height: SKY, length: 1 }))) return { at: t, why: 'not open to the sky (a cave)', spots: [] };
  const box = aroundBox(t);
  const spots = standSpots(await region(ctx, box), box, t, from, fluid === 'lava' ? 2 : 1);
  return { at: t, why: spots.length ? '' : 'no safe spot to stand at in reach of it', spots };
}

/**
 * Fill one empty bucket at a source from a safe spot: walk there carefully, check the arrival and the cells round
 * the feet again, use the bucket through useOn (never walking closer). True when the inventory gained the filled bucket.
 */
export async function fillAt(ctx: GoalContext, v: SourceVerdict, fluid: 'lava' | 'water'): Promise<{ ok: boolean; text: string }> {
  const filled = `${fluid}_bucket`;
  const count = async (n: string) => (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items
    .filter(i => i.slot < 36 && i.name === n).reduce((a, i) => a + i.count, 0);
  const before = await count(filled);
  if (!(await count('bucket'))) return { ok: false, text: 'no empty bucket' };
  const whys: string[] = [];
  for (const s of v.spots.slice(0, 3)) {
    if (ctx.signal.aborted) break;
    const g = await ctx.call<{ arrived: boolean; at?: P }>('goto', { ...s, range: 0, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false, at: undefined }));
    const st = await ctx.call<{ position?: P }>('status').catch(() => ({}) as { position?: P });
    const feet = st.position ? { x: Math.floor(st.position.x), y: Math.floor(st.position.y), z: Math.floor(st.position.z) } : undefined;
    if (!g.arrived || !feet || feet.x !== s.x || feet.y !== s.y || feet.z !== s.z) { whys.push(`couldn't get to (${s.x}, ${s.y}, ${s.z})`); continue; }
    // the cells round the feet once more, as they are now (lava flows)
    const box = aroundBox(v.at);
    const again = standSpots(await region(ctx, box), box, v.at, feet, fluid === 'lava' ? 2 : 1);
    if (!again.some(q => q.x === s.x && q.y === s.y && q.z === s.z)) { whys.push(`(${s.x}, ${s.y}, ${s.z}) isn't safe any more`); continue; }
    // the plants on the line from the eye to the source, broken by hand from here (they'd catch the bucket's aim)
    const blocks = await region(ctx, box);
    const look = (x: number, y: number, z: number) => {
      const ix = x - box.x, iy = y - box.y, iz = z - box.z;
      return ix < 0 || iy < 0 || iz < 0 || ix >= box.width || iy >= box.height || iz >= box.length ? undefined : blocks[ix + iz * box.width + iy * box.width * box.length];
    };
    for (const pl of sightLine(look, s, v.at) ?? []) await ctx.call('dig.here', { ...pl, timeoutMs: 5_000 }, 10_000).catch(() => undefined);
    await ctx.call('item.select', { name: 'bucket' });
    const r = await ctx.call<{ used: boolean; reason?: string }>('useOn', { ...v.at, face: 'up' }, 15_000).catch(e => ({ used: false, reason: (e as Error).message }));
    if ((await count(filled)) > before) return { ok: true, text: `filled a ${filled} at (${v.at.x}, ${v.at.y}, ${v.at.z}) from (${s.x}, ${s.y}, ${s.z})` };
    whys.push(`from (${s.x}, ${s.y}, ${s.z}): ${r.used ? 'nothing filled' : r.reason}`);
  }
  return { ok: false, text: whys.join('; ') || 'no spot to stand at' };
}

/** Sources of a fluid in sight, judged, nearest first (read-only). */
export async function sourcesInSight(ctx: Pick<GoalContext, 'call' | 's'>, fluid: 'lava' | 'water', groundY: number | undefined, most = 12): Promise<SourceVerdict[]> {
  const found = await ctx.call<{ positions: P[] }>('world.findBlocks', { block: fluid, maxDistance: 96, count: 256 }).catch(() => ({ positions: [] as P[] }));
  const here = (await ctx.call<{ position?: P }>('status').catch(() => ({}) as { position?: P })).position ?? ctx.s.position;
  const from = { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) };
  // lava near the ground level only, before any is judged: an underground lake's hundreds of sources were all nearer
  // than any surface pool, and the 60 judged were all of them (none safe, every time)
  const band = (p: P) => fluid !== 'lava' || groundY === undefined || Math.abs(p.y - groundY) <= 4;
  const near = found.positions.filter(band).sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y, a.z - from.z) - Math.hypot(b.x - from.x, b.y - from.y, b.z - from.z));
  // judged until `most` good ones (the nearest dozen were all cave water under the yard, the lake past them), at
  // most 60 looked at; the refused ones come along too (lava-sources shows why), good ones first
  const good: SourceVerdict[] = [], bad: SourceVerdict[] = [];
  for (const t of near.slice(0, 60)) {
    if (good.length >= most) break;
    const v = await judgeSource(ctx, t, fluid, groundY, from);
    (v.why ? bad : good).push(v);
  }
  return [...good, ...bad];
}
