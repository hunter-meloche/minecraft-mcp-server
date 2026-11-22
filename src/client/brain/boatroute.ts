import type { GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { zoneDistance, type Zone } from './courtesy.js';

/**
 * The boat's way home for the villager move (P5c of the progression plan), judged on the ground the bot has read before
 * a villager is taken: a villager in a boat stuck halfway home is a villager taken from its village for nothing. What
 * a boat crosses, as the bridge checked against the 26.3 jar (Vehicle.java): it climbs nothing (its step height is 0:
 * not a slab, not a carpet, not the 1/16 from a path block up onto grass, not out of water onto a bank at the water's
 * own level), it falls down a step and its passengers take the fall but into water (drops kept to 2), it is 1.375
 * across (2 blocks wide all the way, with the drive's few tenths off its line on either side) and its passengers' eyes
 * stand up to 1.81 over its bottom (2 blocks of air over the floor). Lava, fire and what hurts are refused; so is a lily
 * pad (a boat touching one breaks it); and the way keeps 16 from every build of others but the village's own.
 *
 * Pure but for Ground.read, which reads the world (world.region) where the chunks are loaded.
 */

/** Half the boat's width (1.375 across: AbstractBoat's entity type). */
export const BOAT_HALF = 0.6875;
/**
 * How far off its line the drive may take the boat, on land and on water (the bridge's run against the real boat
 * physics: at most 0.43 on grass, 1.44 on water): the way is judged that much wider either side.
 */
export const LAND_SLACK = 0.5;
export const WATER_SLACK = 1.5;
/** Air over the boat's bottom: the villager's eye stands 1.81 over it (an eye inside a block suffocates). */
export const HEAD = 1.9;
/** The deepest step down: a fall of more than 3 hurts the passengers (the bridge's drive stops before a drop of more than 2). */
export const MAX_DROP = 2;
/** The way keeps this far from every build of others (the village's own aside): the plan's word. */
export const FROM_ZONES = 16;
const EPS = 1e-6;
/** The way is looked at every half block along a leg. */
const STEP = 0.5;
/** world.region's limit (cells a call). */
const REGION_MAX = 65_536;

/** A block as a boat meets it: nothing there, a floor or a wall (its bottom and top within the block), water, a hazard. */
export type Cell =
  | { kind: 'open' }
  | { kind: 'solid'; bottom: number; top: number }
  | { kind: 'water'; surface: number }
  | { kind: 'hazard'; what: string }
  | { kind: 'unknown' };

const OPEN: Cell = { kind: 'open' };
const UNKNOWN: Cell = { kind: 'unknown' };
const FULL: Cell = { kind: 'solid', bottom: 0, top: 1 };

/** No collision box: plants, torches, rails, signs, buttons, crops... (the boat goes over or through them). */
const NO_COLLISION = new RegExp('^(air|cave_air|void_air|light|structure_void|short_grass|tall_grass|fern|large_fern|dead_bush|bush|firefly_bush'
  + '|short_dry_grass|tall_dry_grass|leaf_litter|pink_petals|wildflowers|dandelion|poppy|\\w+_tulip|cornflower|oxeye_daisy|azure_bluet|allium'
  + '|blue_orchid|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony|pitcher_plant|open_eyeblossom|closed_eyeblossom|\\w+_sapling'
  + '|red_mushroom|brown_mushroom|sugar_cane|vine|glow_lichen|hanging_roots|spore_blossom|cave_vines|cave_vines_plant|\\w*torch|\\w*wall_torch'
  + '|redstone_wire|rail|powered_rail|detector_rail|activator_rail|\\w+_button|lever|tripwire|tripwire_hook|\\w+_pressure_plate|\\w+_sign'
  + '|\\w+_banner|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_melon_stem|attached_pumpkin_stem|nether_wart|frogspawn)$');
/** What hurts, holds or breaks: never crossed (a lily pad breaks under a boat; a portal would take it elsewhere). */
const HAZARD: Record<string, string> = {
  lava: 'lava', fire: 'fire', soul_fire: 'fire', magma_block: 'a magma block', campfire: 'a campfire', soul_campfire: 'a campfire',
  cactus: 'a cactus', sweet_berry_bush: 'a berry bush', wither_rose: 'a wither rose', powder_snow: 'powder snow', cobweb: 'a cobweb',
  lily_pad: 'a lily pad (a boat breaks it)', bubble_column: 'a bubble column', pointed_dripstone: 'dripstone', nether_portal: 'a portal',
  end_portal: 'a portal', big_dripleaf: 'a big dripleaf (it tips)'
};

const idOf = (state: string) => state.replace(/^minecraft:/, '').replace(/\[.*$/, '');
function propsOf(state: string): Record<string, string> {
  const m = /\[(.*)\]$/.exec(state);
  if (!m) return {};
  return Object.fromEntries(m[1].split(',').map(kv => kv.split('=') as [string, string]));
}

/** A block state as world.region gives it ("oak_slab[type=bottom,waterlogged=false]"), as a boat meets it. Pure. */
export function cellOf(state: string | null | undefined): Cell {
  if (state === null || state === undefined) return UNKNOWN;
  const id = idOf(state);
  if (HAZARD[id]) return { kind: 'hazard', what: HAZARD[id] };
  const p = propsOf(state);
  if (id === 'water' || id === 'kelp' || id === 'kelp_plant' || id === 'seagrass' || id === 'tall_seagrass') {
    const level = Number(p.level ?? 0);
    // (a falling column, and a flow, move a boat on their own: still water only)
    if (level >= 8) return { kind: 'hazard', what: 'falling water' };
    if (level > 0) return { kind: 'hazard', what: 'flowing water' };
    return { kind: 'water', surface: 8 / 9 };
  }
  if (id === 'snow') {
    const layers = Number(p.layers ?? 1);
    return layers <= 1 ? OPEN : { kind: 'solid', bottom: 0, top: (layers - 1) / 8 };
  }
  if (/_fence_gate$/.test(id)) return p.open === 'true' ? OPEN : { kind: 'solid', bottom: 0, top: 1.5 };
  if (NO_COLLISION.test(id)) return OPEN;
  if (/_slab$/.test(id)) return p.type === 'bottom' ? { kind: 'solid', bottom: 0, top: 0.5 } : p.type === 'top' ? { kind: 'solid', bottom: 0.5, top: 1 } : FULL;
  if (/_carpet$/.test(id)) return { kind: 'solid', bottom: 0, top: 1 / 16 };
  if (id === 'dirt_path' || id === 'farmland' || id === 'honey_block') return { kind: 'solid', bottom: 0, top: 15 / 16 };
  if (id === 'soul_sand' || id === 'mud') return { kind: 'solid', bottom: 0, top: 14 / 16 };
  if (/_bed$/.test(id)) return { kind: 'solid', bottom: 0, top: 9 / 16 };
  if (id === 'chest' || id === 'trapped_chest' || id === 'ender_chest') return { kind: 'solid', bottom: 0, top: 14 / 16 };
  if (/_trapdoor$/.test(id) && p.open !== 'true') return p.half === 'top' ? { kind: 'solid', bottom: 13 / 16, top: 1 } : { kind: 'solid', bottom: 0, top: 3 / 16 };
  if (/_fence$|_wall$/.test(id)) return { kind: 'solid', bottom: 0, top: 1.5 };
  return FULL;
}

/** Where a boat comes to rest in a column, or why it cannot go there (`y`: the block that says so), or the block not read. */
export type Settle = { level: number; water: boolean } | { blocked: string; y: number } | { unknown: number };

/**
 * A boat whose bottom is at `level` (absolute y) moving into a column (`cell(y)`): where it comes to rest. First what
 * stands in the way between its bottom and its passengers' heads, the lowest of it naming it: a block whose top is above
 * the boat's bottom (a step up: it climbs nothing; a wall), or one hanging lower than their heads. Then the floor: the
 * first below, no more than `maxDrop` under it; water anywhere on the way down is where it floats (a boat rises on
 * water, and a fall into water hurts no one), but not water deeper over it than a block. Lava, fire and the rest of
 * HAZARD stop it, in the way or under it. Pure.
 */
export function settle(cell: (y: number) => Cell, level: number, maxDrop = MAX_DROP): Settle {
  const top = Math.floor(level + HEAD - EPS);
  const bottom = Math.floor(level) - maxDrop - 1;
  for (let y = Math.floor(level); y <= top; y++) {
    const c = cell(y);
    if (c.kind === 'unknown') return { unknown: y };
    if (c.kind === 'hazard') return { blocked: c.what, y };
    if (c.kind !== 'solid') continue;
    const t = y + c.top, b = y + c.bottom;
    // (its floor, or over their heads: no matter)
    if (t <= level + EPS || b >= level + HEAD - EPS) continue;
    return { blocked: b > level + EPS ? 'a block too low over the boat' : t - level <= 0.6 + EPS ? 'a step up (a boat climbs nothing)' : 'a wall', y };
  }
  for (let y = top; y >= bottom; y--) {
    const c = cell(y);
    if (c.kind === 'unknown') return { unknown: y };
    if (c.kind === 'open') continue;
    if (c.kind === 'hazard') return { blocked: c.what, y };
    if (c.kind === 'water') {
      const s = y + c.surface;
      if (s > level + 1 + EPS) return { blocked: 'water deeper than the boat can rise to', y };
      return { level: s, water: true };
    }
    const t = y + c.top;
    // (over their heads, looked at above)
    if (t > level + EPS) continue;
    if (level - t > maxDrop + EPS) return { blocked: `a drop of more than ${maxDrop}`, y };
    return { level: t, water: false };
  }
  return { blocked: `a drop of more than ${maxDrop}`, y: bottom };
}

/** The ground as read: block states by column, over one band of heights. */
export class Ground {
  private cols = new Map<string, (string | null)[]>();
  constructor(readonly y0: number, readonly height: number) {}
  private key(x: number, z: number) { return `${x},${z}`; }
  /** The block at (x, y, z) as a boat meets it (unknown where not read, or outside the band of heights). */
  cell(x: number, y: number, z: number): Cell {
    const col = this.cols.get(this.key(x, z));
    if (!col || y < this.y0 || y >= this.y0 + this.height) return UNKNOWN;
    return cellOf(col[y - this.y0]);
  }
  /** The raw state, for the put-back and the tests (undefined where not read). */
  state(x: number, y: number, z: number): string | null | undefined {
    const col = this.cols.get(this.key(x, z));
    return col && y >= this.y0 && y < this.y0 + this.height ? col[y - this.y0] : undefined;
  }
  /** Every column read, for a debug record (railshome.ts: a failed extension's ground, replayed offline by fromDump). */
  dump(): { y0: number; height: number; cols: Record<string, (string | null)[]> } {
    return { y0: this.y0, height: this.height, cols: Object.fromEntries(this.cols) };
  }
  /** The ground of a debug record (dump). */
  static fromDump(d: { y0: number; height: number; cols: Record<string, (string | null)[]> }): Ground {
    const g = new Ground(d.y0, d.height);
    for (const [k, col] of Object.entries(d.cols)) g.cols.set(k, col);
    return g;
  }
  /** A column read whole (no unloaded block in it). */
  has(x: number, z: number): boolean {
    const col = this.cols.get(this.key(x, z));
    return !!col && col.every(b => b !== null && b !== undefined);
  }
  /** Columns from a box as world.region gives it (x fastest, then z, then y), from `y0` up `height`. A column read whole stays. */
  put(box: { x: number; z: number; width: number; length: number }, blocks: (string | null)[]): void {
    for (let z = 0; z < box.length; z++) for (let x = 0; x < box.width; x++) {
      const k = this.key(box.x + x, box.z + z);
      if (this.has(box.x + x, box.z + z)) continue;
      const col: (string | null)[] = [];
      for (let y = 0; y < this.height; y++) col.push(blocks[x + z * box.width + y * box.width * box.length] ?? null);
      this.cols.set(k, col);
    }
  }
  /** Set one block (a test's world, or a cell the move digs out: what the way will be once it is). */
  set(x: number, y: number, z: number, state: string): void {
    const k = this.key(x, z);
    let col = this.cols.get(k);
    if (!col) { col = new Array<string | null>(this.height).fill(null); this.cols.set(k, col); }
    if (y >= this.y0 && y < this.y0 + this.height) col[y - this.y0] = state;
  }
  /**
   * Read the columns of a box that are not yet read whole, in tiles world.region takes (the chunks round the bot are
   * loaded: what lies further out comes back unread, and is read again on a later call).
   */
  async read(ctx: Pick<GoalContext, 'call'>, x1: number, z1: number, x2: number, z2: number): Promise<void> {
    const tile = this.height <= 64 ? 32 : 16;
    for (let tz = Math.min(z1, z2); tz <= Math.max(z1, z2); tz += tile) {
      for (let tx = Math.min(x1, x2); tx <= Math.max(x1, x2); tx += tile) {
        const box = { x: tx, z: tz, width: Math.min(tile, Math.max(x1, x2) - tx + 1), length: Math.min(tile, Math.max(z1, z2) - tz + 1) };
        let whole = true;
        for (let z = 0; z < box.length && whole; z++) for (let x = 0; x < box.width && whole; x++) if (!this.has(box.x + x, box.z + z)) whole = false;
        if (whole) continue;
        const per = Math.max(1, Math.floor(REGION_MAX / (box.width * box.length)));
        const blocks: (string | null)[] = [];
        for (let y = 0; y < this.height; y += per) {
          const part = await ctx.call<{ blocks: (string | null)[] }>('world.region', { x: box.x, y: this.y0 + y, z: box.z, width: box.width, height: Math.min(per, this.height - y), length: box.length }, 60_000)
            .catch(() => ({ blocks: [] as (string | null)[] }));
          // (a box that could not be read reads as unloaded)
          const n = box.width * box.length * Math.min(per, this.height - y);
          for (let i = 0; i < n; i++) blocks.push(part.blocks?.[i] ?? null);
        }
        this.put(box, blocks);
      }
    }
  }
}

/** How far a point is from the segment a-b, across the ground. Pure. */
export function offSegment(a: { x: number; z: number }, b: { x: number; z: number }, p: { x: number; z: number }): number {
  const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
}

/**
 * Read the band `half` blocks either side of the line from `a` to `b`, the tiles of it within `near` of `me` (the
 * chunks loaded round the bot): the boat's way home, read as the bot walks out along it. A tile read whole before is
 * not read again; one with chunks not loaded yet is, at the next stop.
 */
export async function readBand(ctx: Pick<GoalContext, 'call'>, g: Ground, a: { x: number; z: number }, b: { x: number; z: number }, half: number,
  me: { x: number; z: number }, near: number): Promise<void> {
  const tile = g.height <= 64 ? 32 : 16;
  const x1 = Math.floor(Math.min(a.x, b.x) - half), x2 = Math.floor(Math.max(a.x, b.x) + half);
  const z1 = Math.floor(Math.min(a.z, b.z) - half), z2 = Math.floor(Math.max(a.z, b.z) + half);
  const reach = tile * 0.71;
  for (let tz = Math.floor(z1 / tile) * tile; tz <= z2; tz += tile) {
    for (let tx = Math.floor(x1 / tile) * tile; tx <= x2; tx += tile) {
      const c = { x: tx + tile / 2, z: tz + tile / 2 };
      if (offSegment(a, b, c) > half + reach || Math.hypot(c.x - me.x, c.z - me.z) > near + reach) continue;
      await g.read(ctx, tx, tz, tx + tile - 1, tz + tile - 1);
    }
  }
}

/** Where the boat is: its middle and its bottom's height, on water or not. */
export interface BoatAt { x: number; z: number; level: number; water?: boolean }

/** A leg judged: where the boat comes to on it, or why not and where. */
export type Leg = { ok: true; level: number; water: boolean } | { ok: false; why: string; at: Pos; unread?: true };

const slackOf = (water: boolean) => BOAT_HALF + (water ? WATER_SLACK : LAND_SLACK);

/**
 * The boat on the columns under it at (px, pz) coming from `level`: the columns its box covers, the drive's slack
 * either side, each as `settle` says; it rests on the highest of them (any one stopping it stops it). Pure.
 */
export function footprint(g: Pick<Ground, 'cell'>, px: number, pz: number, level: number, water: boolean, maxDrop = MAX_DROP): Leg {
  const hw = slackOf(water);
  let best: { level: number; water: boolean } | undefined;
  for (let x = Math.floor(px - hw); x <= Math.floor(px + hw - EPS); x++) {
    for (let z = Math.floor(pz - hw); z <= Math.floor(pz + hw - EPS); z++) {
      const r = settle(y => g.cell(x, y, z), level, maxDrop);
      if ('unknown' in r) return { ok: false, why: 'not read', at: { x, y: r.unknown, z }, unread: true };
      if ('blocked' in r) return { ok: false, why: r.blocked, at: { x, y: r.y, z } };
      if (!best || r.level > best.level + EPS) best = r;
    }
  }
  return best ? { ok: true, ...best } : { ok: false, why: 'not read', at: { x: Math.floor(px), y: Math.floor(level), z: Math.floor(pz) }, unread: true };
}

/** Off a zone by less than FROM_ZONES at this point (3D box distance), or undefined. Pure. */
export function zoneNear(zones: readonly Zone[], p: { x: number; y: number; z: number }, from = FROM_ZONES): Zone | undefined {
  return zones.find(z => zoneDistance(p, z) < from);
}

/**
 * One straight leg of the boat's way, from where it is to `to`: every half block along the line, its box and the slack
 * on the ground there (footprint), and FROM_ZONES off every zone in `zones` (the caller leaves the village's own out).
 * Pure.
 */
export function checkLeg(g: Pick<Ground, 'cell'>, from: BoatAt, to: { x: number; z: number }, zones: readonly Zone[] = [], maxDrop = MAX_DROP): Leg {
  const d = Math.hypot(to.x - from.x, to.z - from.z);
  const n = Math.max(1, Math.ceil(d / STEP));
  let level = from.level, water = !!from.water;
  for (let i = 1; i <= n; i++) {
    const px = from.x + (to.x - from.x) * i / n, pz = from.z + (to.z - from.z) * i / n;
    const r = footprint(g, px, pz, level, water, maxDrop);
    if (!r.ok) return r;
    level = r.level;
    water = r.water;
    const near = zoneNear(zones, { x: px, y: level, z: pz });
    if (near) return { ok: false, why: `within ${FROM_ZONES} of someone's build (x ${near.x1}..${near.x2}, z ${near.z1}..${near.z2})`, at: { x: Math.floor(px), y: Math.floor(level), z: Math.floor(pz) } };
  }
  return { ok: true, level, water };
}

/** A route found: its turning points, each leg straight, the last the target itself; or why none, and how near it got. */
export type Route = { ok: true; legs: { x: number; z: number }[]; level: number } | { ok: false; why: string; at?: Pos; unread?: true; nearest?: number };

const SQRT2 = Math.SQRT2;
const NEIGHBOURS: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]];

/**
 * A way for the boat from `from` to `to` over the ground read, in straight legs: a search over the columns (each step
 * the boat's footprint at the column's middle, as checkLeg judges it, and FROM_ZONES off `zones`), within `bounds`,
 * then pulled straight: from each turning point the farthest point of the search's way that one straight leg reaches,
 * as checkLeg judges it. `within`: the search ends this near the target. At most `maxNodes` columns looked at.
 * `corners: false`: no diagonal step past a corner, its two straight steps beside it judged too (the footprints
 * checkLeg judges along a diagonal step cover them: a step round the corner of a build kept off was found by the
 * search, then refused straightened, "on the way the search found"); the way across the yard's, among its builds. Pure.
 */
export function planRoute(g: Pick<Ground, 'cell'>, from: BoatAt, to: { x: number; z: number }, opts: {
  zones?: readonly Zone[]; bounds?: { x1: number; z1: number; x2: number; z2: number }; maxNodes?: number; within?: number; maxDrop?: number; corners?: false;
} = {}): Route {
  const zones = opts.zones ?? [];
  const maxDrop = opts.maxDrop ?? MAX_DROP;
  const direct = checkLeg(g, from, to, zones, maxDrop);
  if (direct.ok) return { ok: true, legs: [{ x: to.x, z: to.z }], level: direct.level };
  const b = opts.bounds;
  const within = opts.within ?? 2;
  const maxNodes = opts.maxNodes ?? 80_000;
  type Node = { x: number; z: number; level: number; water: boolean; g: number; prev?: Node };
  const key = (x: number, z: number) => `${x},${z}`;
  const h = (x: number, z: number) => Math.hypot(x + 0.5 - to.x, z + 0.5 - to.z);
  const start: Node = { x: Math.floor(from.x), z: Math.floor(from.z), level: from.level, water: !!from.water, g: 0 };
  const best = new Map<string, Node>([[key(start.x, start.z), start]]);
  // a binary heap on f = g + h
  const heap: { f: number; n: Node }[] = [];
  const push = (n: Node) => {
    heap.push({ f: n.g + h(n.x, n.z), n });
    for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p].f <= heap[i].f) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = (): Node | undefined => {
    if (!heap.length) return undefined;
    const top = heap[0].n;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  push(start);
  let looked = 0, end: Node | undefined, nearest = start;
  const closed = new Set<string>();
  while (looked < maxNodes) {
    const n = pop();
    if (!n) break;
    const k = key(n.x, n.z);
    if (closed.has(k)) continue;
    closed.add(k);
    looked++;
    if (h(n.x, n.z) < h(nearest.x, nearest.z)) nearest = n;
    if (h(n.x, n.z) <= within) { end = n; break; }
    for (const [dx, dz, cost] of NEIGHBOURS) {
      const x = n.x + dx, z = n.z + dz;
      if (b && (x < b.x1 || x > b.x2 || z < b.z1 || z > b.z2)) continue;
      const nk = key(x, z);
      if (closed.has(nk)) continue;
      const r = footprint(g, x + 0.5, z + 0.5, n.level, n.water, maxDrop);
      if (!r.ok) continue;
      if (zoneNear(zones, { x: x + 0.5, y: r.level, z: z + 0.5 })) continue;
      if (opts.corners === false && dx && dz && (!footprint(g, n.x + dx + 0.5, n.z + 0.5, n.level, n.water, maxDrop).ok || !footprint(g, n.x + 0.5, n.z + dz + 0.5, n.level, n.water, maxDrop).ok)) continue;
      const gn = n.g + cost;
      const was = best.get(nk);
      if (was && was.g <= gn) continue;
      const m: Node = { x, z, level: r.level, water: r.water, g: gn, prev: n };
      best.set(nk, m);
      push(m);
    }
  }
  if (!end) {
    const off = Math.round(h(nearest.x, nearest.z));
    const why = direct.unread ? `the way not all read (as far as (${direct.at.x}, ${direct.at.z}))` : `${direct.why} at (${direct.at.x}, ${direct.at.y}, ${direct.at.z})`;
    return { ok: false, why: `no way round: straight on, ${why}; it got no nearer than ${off}`, at: { x: nearest.x, y: Math.floor(nearest.level), z: nearest.z }, nearest: off, ...(direct.unread ? { unread: true as const } : {}) };
  }
  const path: { x: number; z: number }[] = [];
  for (let n: Node | undefined = end; n; n = n.prev) path.unshift({ x: n.x + 0.5, z: n.z + 0.5 });
  path[0] = { x: from.x, z: from.z };
  path.push({ x: to.x, z: to.z });
  // pulled straight: from each turning point, the farthest point of the way a leg reaches (a binary search on it,
  // then the leg judged again: a leg the search's steps allow can still be judged out as one straight line)
  const legs: { x: number; z: number }[] = [];
  let at: BoatAt = { ...from };
  let i = 0;
  while (i < path.length - 1) {
    let lo = i + 1, hi = path.length - 1, got = -1;
    let gotLeg: Leg | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = checkLeg(g, at, path[mid], zones, maxDrop);
      if (r.ok) { got = mid; gotLeg = r; lo = mid + 1; } else hi = mid - 1;
    }
    if (got < 0) {
      // (the next step itself out as a straight line from where the leg ended between two columns: try the column after)
      const r = checkLeg(g, at, path[i + 1], zones, maxDrop);
      if (!r.ok) return { ok: false, why: `${r.why} at (${r.at.x}, ${r.at.y}, ${r.at.z}) on the way the search found`, at: r.at, ...(r.unread ? { unread: true as const } : {}) };
      got = i + 1;
      gotLeg = r;
    }
    legs.push(path[got]);
    at = { x: path[got].x, z: path[got].z, level: (gotLeg as { level: number }).level, water: (gotLeg as { water: boolean }).water };
    i = got;
  }
  return { ok: true, legs, level: at.level };
}

// ------------------------------------------------------------------------------------------------ the way into the hall

export type WallSide = 'north' | 'south' | 'west' | 'east';

/**
 * The way the boat comes into the hall, from the hall's and the yard's zones (pure): the hall's `panel` (the 1 x 2 of
 * its wall that P5b built to be taken out) and a column either side of it in the same wall (3 wide: the boat is 1.375
 * across and the drive a few tenths off its line; 2 where a corner or the gate stands beside it); the yard's fence
 * straight out from it, the same columns of it (its posts and what stands on them); and the boat's stops: `out` 2.5 out
 * from the fence, `front` 2 out from the hall's wall (both dug from there, from the boat), `inside` the middle of the
 * room. The boat drives out -> front -> inside along the opening's middle line. `level`: the yard's floor (its ground's
 * top). Undefined, with why, when the hall or its panel is not known, or the fence does not face the panel; `fence`
 * when only the fence straight out will not do (a gate or a corner in it). There, or where the ground outside the
 * fence there lets no boat by, the way in is across the yard instead (yardEntry: `yard`).
 */
export interface Entry {
  side: WallSide;
  /** the hall's box (its site) */
  hall: { x: number; y: number; z: number; width: number; length: number };
  /** the wall's cells to take out, bottom row first */
  wall: Pos[];
  /** the fence's posts to take out (what stands on each is read when it is dug) */
  fence: Pos[];
  out: { x: number; z: number };
  front: { x: number; z: number };
  inside: { x: number; z: number };
  /** the hall's gate (the bot leaves the room by it, the panel put back from inside) */
  gate?: Pos;
  level: number;
  /** the fence's line (z for north/south, x for west/east), and which way is out of the hall */
  dir: [number, number];
  /** in by a panel of the fence elsewhere and across the yard (yardEntry), not straight out from the hall's wall */
  yard?: YardWay;
}

/**
 * A way in across the yard: the side of the yard's fence the boat comes in by and which way is out of the yard there,
 * the stop 2.5 inside the fence (`through`: out -> through along the opening's middle line), the legs across the yard
 * from it to the hall's `front` (the last is `front` itself), and the opening's middle post (the rails' dry run comes in
 * by its column).
 */
export interface YardWay { side: WallSide; dir: [number, number]; through: { x: number; z: number }; legs: { x: number; z: number }[]; post: Pos }

const isPos = (p: unknown): p is Pos => !!p && typeof (p as Pos).x === 'number' && typeof (p as Pos).y === 'number' && typeof (p as Pos).z === 'number';
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const at3 = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;

/** Along a wall or a fence on that side, and which way is out (the game's north being -z, east +x). */
const ALONG = (side: WallSide): [number, number] => (side === 'north' || side === 'south' ? [1, 0] : [0, 1]);
const OUTWARD: Record<WallSide, [number, number]> = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
/** The point `by` out from a line across the way out (z for north/south, x for west/east), on the middle line `mid`; in for `by` under 0. */
function outFrom(side: WallSide, line: number, mid: number, by: number): { x: number; z: number } {
  const v = line + (side === 'north' || side === 'west' ? -by : by);
  return side === 'north' || side === 'south' ? { x: mid, z: v } : { x: v, z: mid };
}

type HallBox = Entry['hall'];

/**
 * The hall's side of a way in (pure): the panel's column `p` and one either side of it in the side's wall (but a
 * corner or the gate), two rows from `p.y`; the opening's middle line, the stop 2 out from the wall and the room's
 * middle on it.
 */
function hallWay(box: HallBox, side: WallSide, p: Pos, gate: Pos | undefined): Pick<Entry, 'side' | 'wall' | 'front' | 'inside' | 'dir'> & { cols: { x: number; z: number }[]; mid: number } | { why: string } {
  const along = ALONG(side);
  // the columns: the panel's, and one either side in the same wall, but a corner or the gate
  const corner = (x: number, z: number) => (x === box.x || x === box.x + box.width - 1) && (z === box.z || z === box.z + box.length - 1);
  const cols = [-1, 0, 1].map(k => ({ x: p.x + along[0] * k, z: p.z + along[1] * k }))
    .filter(c => !corner(c.x, c.z) && !(gate && gate.x === c.x && gate.z === c.z));
  if (cols.length < 2) return { why: 'no room beside the panel for a boat (a corner or the gate either side)' };
  const wall = [p.y, p.y + 1].flatMap(y => cols.map(c => ({ x: c.x, y, z: c.z })));
  // the opening's middle line, across: the columns' outer edges' middle
  const lo = Math.min(...cols.map(c => c.x * along[0] + c.z * along[1]));
  const hi = Math.max(...cols.map(c => c.x * along[0] + c.z * along[1]));
  const mid = (lo + hi + 1) / 2;
  // the wall's outer face (along dir), and the room's middle row
  const wallLine = side === 'north' ? box.z : side === 'south' ? box.z + box.length : side === 'west' ? box.x : box.x + box.width;
  const insideLine = side === 'north' || side === 'south' ? box.z + box.length / 2 : box.x + box.width / 2;
  const inside = side === 'north' || side === 'south' ? { x: mid, z: insideLine } : { x: insideLine, z: mid };
  return { side, wall, cols, mid, front: outFrom(side, wallLine, mid, 2), inside, dir: OUTWARD[side] };
}

export function entryOf(world: WorldMemory): Entry | { why: string; fence?: true } {
  const hall = world.zones?.hall?.[0];
  const panel = (world.zones?.['hall:panel'] ?? []).filter(isPos).sort((a, b) => a.y - b.y);
  const yard = world.yard;
  if (!hall || !hall.width || !hall.length) return { why: 'no villager hall built' };
  if (panel.length < 2) return { why: 'the hall\'s panel is not known' };
  if (!yard) return { why: 'no yard' };
  const box = { x: hall.x, y: hall.y, z: hall.z, width: hall.width, length: hall.length };
  const p = panel[0];
  const side: WallSide | undefined = p.z === box.z ? 'north' : p.z === box.z + box.length - 1 ? 'south' : p.x === box.x ? 'west' : p.x === box.x + box.width - 1 ? 'east' : undefined;
  if (!side) return { why: `the panel at (${p.x}, ${p.y}, ${p.z}) is in no wall of the hall` };
  const gate = (world.zones?.['hall:gate'] ?? []).find(isPos);
  const way = hallWay(box, side, p, gate);
  if ('why' in way) return way;
  // the fence straight out from the wall: the yard's edge on that side
  const fenceAt = side === 'north' ? yard.z1 : side === 'south' ? yard.z2 : side === 'west' ? yard.x1 : yard.x2;
  const fence = way.cols.map(c => (side === 'north' || side === 'south' ? { x: c.x, y: yard.y + 1, z: fenceAt } : { x: fenceAt, y: yard.y + 1, z: c.z }));
  const corners = (q: Pos) => (q.x === yard.x1 || q.x === yard.x2) && (q.z === yard.z1 || q.z === yard.z2);
  const gates = (world.zones?.['fence:gate'] ?? []).filter(isPos);
  // (`fence`: the hall and its panel will do, only not straight out: the way in across the yard may, yardEntry)
  if (fence.some(q => corners(q) || gates.some(gt => gt.x === q.x && gt.z === q.z))) return { why: 'the fence straight out from the panel holds a corner or a gate', fence: true };
  // the fence's outer face (along dir)
  const fenceLine = side === 'north' ? fenceAt : side === 'south' ? fenceAt + 1 : side === 'west' ? fenceAt : fenceAt + 1;
  const out = outFrom(side, fenceLine, way.mid, 2.5);
  return { side, hall: box, wall: way.wall, fence, out, front: way.front, inside: way.inside, ...(gate ? { gate } : {}), level: yard.y + 1, dir: way.dir };
}

// ------------------------------------------------------------------------------------------------ the way in across the yard

/** The yard's inside, the fence's line left out: the box a way across it keeps within. */
export const yardInside = (yard: NonNullable<WorldMemory['yard']>) => ({ x1: yard.x1 + 1, z1: yard.z1 + 1, x2: yard.x2 - 1, z2: yard.z2 - 1 });

/** Of the zones round the yard, those this far out of it are kept off too (the cane patch reaches out past the south fence). */
const KEEP_OFF_NEAR = 8;

/**
 * The ground as a boat's way in across the yard meets it (pure): every cell of the bot's own builds and the like, the
 * zones (the pens, the portal, the workshop, the storage house, the enchanting room, the tree farm, the plot, the hall,
 * the cane patch's cells, a cast's spot...), a wall in every column of it: the boat keeps off them by its footprint and
 * the drive's slack, as off a wall (the plot's farmland and the cane by water have no wall a boat would stop at). Not
 * the fence's own (its ring, gates and torches: its posts are walls as read, and the panel the boat comes in by is dug).
 * Zones only: an improvement run's build keeps no zone (its box is no help: the lamp walk's runs the width of the
 * yard's south half), and its blocks are in the ground as read. And in the yard a floor under a block high (a dirt
 * path, farmland: 15/16) where the boat's own box (1.375 across: two columns each way) could sit wholly on such floors:
 * it sinks the 1/16 and climbs nothing back out (26.3: a boat's maxUpStep is 0), so those are walls too. The footprint
 * rests the boat on the highest column under its box and the drive's slack, which would carry it across a path two
 * wide on the grass beside it; a path one wide it does cross, on the grass either side.
 */
export function keepOff(g: Pick<Ground, 'cell'>, world: WorldMemory): Pick<Ground, 'cell'> {
  const yard = world.yard;
  const inside = yard ? yardInside(yard) : undefined;
  const low = new Map<string, boolean>();
  const lowAt = (x: number, z: number): boolean => {
    const k = `${x},${z}`;
    let v = low.get(k);
    if (v === undefined) {
      const c = yard ? g.cell(x, yard.y, z) : UNKNOWN;
      v = c.kind === 'solid' && c.bottom < EPS && c.top > EPS && c.top < 1 - EPS && g.cell(x, yard!.y + 1, z).kind === 'open';
      low.set(k, v);
    }
    return v;
  };
  const sunk = (x: number, z: number) => !!inside && x >= inside.x1 && x <= inside.x2 && z >= inside.z1 && z <= inside.z2 && lowAt(x, z)
    && [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([ox, oz]) => lowAt(x + ox, z + oz) && lowAt(x + ox + 1, z + oz) && lowAt(x + ox, z + oz + 1) && lowAt(x + ox + 1, z + oz + 1));
  const cols = new Map<string, string>();
  for (const [kind, boxes] of Object.entries(world.zones ?? {})) {
    if (kind === 'fence' || kind.startsWith('fence:') || !Array.isArray(boxes)) continue;
    for (const b of boxes) {
      if (!b || !fin(b.x) || !fin(b.z)) continue;
      const w = fin(b.width) && b.width > 0 ? b.width : 1, l = fin(b.length) && b.length > 0 ? b.length : 1;
      for (let x = b.x; x < b.x + w; x++) for (let z = b.z; z < b.z + l; z++) {
        if (yard && (x < yard.x1 - KEEP_OFF_NEAR || x > yard.x2 + KEEP_OFF_NEAR || z < yard.z1 - KEEP_OFF_NEAR || z > yard.z2 + KEEP_OFF_NEAR)) continue;
        if (!cols.has(`${x},${z}`)) cols.set(`${x},${z}`, kind);
      }
    }
  }
  return {
    cell: (x, y, z) => {
      const kind = cols.get(`${x},${z}`);
      if (kind) return { kind: 'hazard', what: `the bot's own ${kind}` };
      if (sunk(x, z)) return { kind: 'hazard', what: 'a floor under a block high, two wide or more (a path, farmland: the boat would sink onto it and climb nothing back out)' };
      return g.cell(x, y, z);
    }
  };
}

/** The ground with these cells open (what a move digs out: the way as it will be once they are). Pure. */
function opened(g: Pick<Ground, 'cell'>, cells: readonly Pos[]): Pick<Ground, 'cell'> {
  const open = new Set(cells.map(c => `${c.x},${c.y},${c.z}`));
  return { cell: (x, y, z) => (open.has(`${x},${y},${z}`) ? OPEN : g.cell(x, y, z)) };
}

/**
 * The hall's panel for a way in across the yard (pure): in the wall that faces the yard's middle (the axis it is
 * further off along, scaled to the hall's sizes, as villagers.ts sideToward has it), the panel P5b built where it is in
 * that wall; else that wall's middle column, or the column two along from the gate, toward the yard's middle, where the
 * gate stands within one of it (the blueprint's own place for a panel in the gate's wall). A panel, not the gate: the
 * gate is one block wide and the boat 1.375 across (the planks either side of it would come out as well), and an open
 * gate the bot is 2.2 from is shut by the bridge (Gates.java) as the boat goes through with the villager in its back
 * seat. Beside it, the gate stays shut and untouched throughout, and the bot leaves the room by it as from the built
 * panel. (26.3: an open gate has no collision, FenceGateBlock.getCollisionShape; a villager opens only doors,
 * InteractWithDoor's #mob_interactable_doors, and paths round a shut gate, WalkNodeEvaluator's FENCE.)
 */
export function yardPanel(world: WorldMemory): { side: WallSide; at: Pos } | { why: string } {
  const hall = world.zones?.hall?.[0];
  const yard = world.yard;
  if (!hall || !hall.width || !hall.length) return { why: 'no villager hall built' };
  if (!yard) return { why: 'no yard' };
  const box = { x: hall.x, y: hall.y, z: hall.z, width: hall.width, length: hall.length };
  const m = { x: (yard.x1 + yard.x2 + 1) / 2, z: (yard.z1 + yard.z2 + 1) / 2 };
  const dx = (m.x - (box.x + box.width / 2)) / box.width, dz = (m.z - (box.z + box.length / 2)) / box.length;
  const side: WallSide = Math.abs(dx) > Math.abs(dz) ? (dx < 0 ? 'west' : 'east') : (dz < 0 ? 'north' : 'south');
  const ns = side === 'north' || side === 'south';
  const line = side === 'north' ? box.z : side === 'south' ? box.z + box.length - 1 : side === 'west' ? box.x : box.x + box.width - 1;
  const inWall = (q: Pos) => (ns ? q.z === line && q.x > box.x && q.x < box.x + box.width - 1 : q.x === line && q.z > box.z && q.z < box.z + box.length - 1);
  const built = (world.zones?.['hall:panel'] ?? []).filter(isPos).sort((a, b) => a.y - b.y)[0];
  if (built && inWall(built)) return { side, at: { ...built } };
  const gate = (world.zones?.['hall:gate'] ?? []).find(isPos);
  let c = ns ? box.x + Math.floor((box.width - 1) / 2) : box.z + Math.floor((box.length - 1) / 2);
  if (gate && inWall(gate)) {
    const g = ns ? gate.x : gate.z;
    if (Math.abs(g - c) <= 1) c = g + 2 * ((ns ? m.x : m.z) >= g + 0.5 ? 1 : -1);
  }
  return { side, at: ns ? { x: c, y: box.y + 1, z: line } : { x: line, y: box.y + 1, z: c } };
}

/** Ways across the yard searched at most (the cheapest panels of the fence the boat can come in by, one search over the yard each). */
export const YARD_TRIES = 6;

/**
 * The way in across the yard (pure; the ground read round the whole yard), where straight out from the hall's panel
 * the ground outside the fence lets no boat by: live on Nov 15 the hall stood in the yard's north-west corner, cut into
 * a hillside on the north and the west, and its panel faced the hill ("a wall at (-557, 65, 2115)"). In through a
 * panel of the yard's own fence (3 plain posts in a row: no corner, no gate; what stands on them goes back too) where
 * the ground outside lets the boat stand 2.5 out (`out`, its stop at the end of the way home) and on through the
 * opening to 2.5 inside (`through`), then across the yard to the hall's yard-facing panel (yardPanel) on a way planned
 * as the way home is (planRoute, checkLeg), its own builds kept off (keepOff), nothing in the yard dug but the one
 * panel of its fence. The fence's panels tried the cheapest first: from `toward` (the village) to `out`, then from
 * `through` to the hall's `front`, straight (the side toward the village, and the shortest way), at most YARD_TRIES of
 * them searched across. A boat steps up nothing (26.3: AbstractBoat keeps Entity.maxUpStep's 0, and Entity.collide
 * steps up only over 0): not the 1/16 from a dirt path onto the grass beside it (settle), so a way all on a path
 * (15/16 high) for the boat's whole footprint has no way off it, and the search goes round.
 */
export function yardEntry(g: Pick<Ground, 'cell' | 'state'>, world: WorldMemory, toward: { x: number; z: number }, tries = YARD_TRIES): Entry | { why: string } {
  const hall = world.zones?.hall?.[0];
  const yard = world.yard;
  if (!hall || !hall.width || !hall.length) return { why: 'no villager hall built' };
  if (!yard) return { why: 'no yard' };
  const box = { x: hall.x, y: hall.y, z: hall.z, width: hall.width, length: hall.length };
  const level = yard.y + 1;
  const panel = yardPanel(world);
  if ('why' in panel) return panel;
  const gate = (world.zones?.['hall:gate'] ?? []).find(isPos);
  const way = hallWay(box, panel.side, panel.at, gate);
  if ('why' in way) return way;
  // into the room by it, the panel as air (judged on the ground as it is: the hall is not the yard's way)
  const room = checkLeg(opened(g, way.wall), { ...way.front, level }, way.inside);
  if (!room.ok) return { why: `into the hall by a panel in its ${way.side} wall: ${room.why} at ${at3(room.at)}` };
  const gates = (world.zones?.['fence:gate'] ?? []).filter(isPos);
  type Panel = { side: WallSide; posts: Pos[]; out: { x: number; z: number }; through: { x: number; z: number } };
  const panels: { p: Panel; cost: number }[] = [];
  for (const side of ['north', 'south', 'west', 'east'] as WallSide[]) {
    const ns = side === 'north' || side === 'south';
    const line = side === 'north' ? yard.z1 : side === 'south' ? yard.z2 : side === 'west' ? yard.x1 : yard.x2;
    // the fence block's outer and inner faces
    const outer = side === 'south' || side === 'east' ? line + 1 : line;
    const inner = side === 'south' || side === 'east' ? line : line + 1;
    const [a1, a2] = ns ? [yard.x1, yard.x2] : [yard.z1, yard.z2];
    for (let c = a1 + 2; c <= a2 - 2; c++) {
      const posts = [c - 1, c, c + 1].map(v => (ns ? { x: v, y: level, z: line } : { x: line, y: level, z: v }));
      if (posts.some(q => gates.some(gt => gt.x === q.x && gt.z === q.z))) continue;
      const p: Panel = { side, posts, out: outFrom(side, outer, c + 0.5, 2.5), through: outFrom(side, inner, c + 0.5, -2.5) };
      panels.push({ p, cost: Math.hypot(toward.x - p.out.x, toward.z - p.out.z) + Math.hypot(p.through.x - way.front.x, p.through.z - way.front.z) });
    }
  }
  panels.sort((a, b) => a.cost - b.cost);
  const own = keepOff(g, world);
  const bounds = yardInside(yard);
  const fenceId = /^(minecraft:)?[a-z_]+_fence(\[|$)/;
  let searched = 0, why = '';
  for (const { p } of panels) {
    // its posts plain fence, read, and what stands on them read (it goes back after)
    if (p.posts.some(q => !fenceId.test(g.state(q.x, q.y, q.z) ?? '') || !g.state(q.x, q.y + 1, q.z))) continue;
    const view = keepOff(opened(g, p.posts.flatMap(q => [q, { x: q.x, y: q.y + 1, z: q.z }])), world);
    // the boat outside it, from the ground there (at most MAX_DROP over the yard's floor), through the opening
    const stand = footprint(view, p.out.x, p.out.z, level + MAX_DROP, false);
    if (!stand.ok) continue;
    const into = checkLeg(view, { ...p.out, level: stand.level }, p.through);
    if (!into.ok || !footprint(own, p.through.x, p.through.z, into.level, false).ok) continue;
    if (searched++ >= tries) break;
    const r = planRoute(own, { ...p.through, level: into.level }, way.front, { bounds, within: 1, corners: false });
    if (r.ok) {
      return {
        side: way.side, hall: box, wall: way.wall, fence: p.posts, out: p.out, front: way.front, inside: way.inside, ...(gate ? { gate } : {}), level, dir: way.dir,
        yard: { side: p.side, dir: OUTWARD[p.side], through: p.through, legs: r.legs, post: { ...p.posts[1] } }
      };
    }
    why ||= `from the ${p.side} fence at ${at3(p.posts[1])}: ${r.why}`;
  }
  return { why: why ? `no way across the yard (${why})` : 'no panel of the yard\'s fence with ground outside it the boat can come in from' };
}
