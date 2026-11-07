/**
 * Terraslicer's world model: the blocks round a structure as a voxel grid, what each block is to the bot (room to stand
 * in, a floor to stand on, something to place against, something to see through) and where it can walk. Pure: the
 * slicer builds the structure in a copy of this, block by block, so every step of the plan sees exactly what stands at
 * that point.
 */

export type P = { x: number; y: number; z: number };
export interface Box { x: number; y: number; z: number; width: number; height: number; length: number }

export const key = (p: P) => `${p.x},${p.y},${p.z}`;
export const same = (a: P, b: P) => a.x === b.x && a.y === b.y && a.z === b.z;

// what a block state is to the bot, as bits
export const AIR = 1;
/** a placed block simply goes into it (vanilla's canBeReplaced, near enough) */
export const REPLACEABLE = 2;
/** feet and head can be in it (and Baritone walks through it: doors and gates it opens) */
export const PASSABLE = 4;
/** solid enough to stand on */
export const FLOOR = 8;
/** solid, and clicking it places against it (blocks that open or toggle when clicked don't) */
export const SUPPORT = 16;
export const LIQUID = 32;
/** not loaded, or outside the box: nothing is known, so nothing is assumed */
export const UNKNOWN = 64;
/** a ray from the eye goes through it (the mod's line-of-sight test: outlines stop it, fluids don't) */
export const CLEAR = 128;

const AIR_RE = /^(air|cave_air|void_air)$/;
const REPLACEABLE_RE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|bush|vine|glow_lichen|snow|water|lava|seagrass|tall_seagrass|fire|soul_fire|structure_void|leaf_litter|light)$/;
const PASSABLE_RE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|bush|firefly_bush|leaf_litter|vine|glow_lichen|snow|structure_void|light|fire|soul_fire|dandelion|poppy|blue_orchid|allium|azure_bluet|[a-z_]*tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|wither_rose|wildflowers|pink_petals|[a-z_]*sapling|wheat|carrots|potatoes|beetroots|sugar_cane|[a-z_]*torch|[a-z_]*sign|[a-z_]*banner|[a-z_]*button|lever|[a-z_]*pressure_plate|[a-z_]*carpet|rail|powered_rail|detector_rail|activator_rail|redstone_wire|tripwire|tripwire_hook|ladder|flower_pot|potted_[a-z_]+|[a-z_]*candle)$/;
/** Baritone walks through wooden doors and gates (it opens them), never iron ones */
const OPENS_RE = /^(?!iron_)[a-z_]*_(door|fence_gate)$/;
/** solid, but not a floor: too tall (fences, walls, gates), not a full top, or it hurts */
const NO_FLOOR_RE = /(water|lava|fence|_wall$|_gate$|_door$|pane$|_bars$|chain$|lantern$|end_rod|lightning_rod|campfire|cactus|magma_block|sweet_berry_bush|cobweb|pointed_dripstone|_bed$|scaffolding|powder_snow|_trapdoor$)/;
/** the mod's place never clicks these: they open or toggle instead (Interact.java ACTIVATABLE) */
const ACTIVATABLE_RE = /^(crafting_table|crafter|(blast_)?furnace|smoker|(trapped_)?chest|ender_chest|barrel|.*shulker_box|hopper|dispenser|dropper|brewing_stand|enchanting_table|(chipped_|damaged_)?anvil|grindstone|stonecutter|loom|cartography_table|smithing_table|fletching_table|lectern|beacon|bell|note_block|jukebox|lever|respawn_anchor|.*_(door|trapdoor|fence_gate|bed|button|sign|hanging_sign))$/;
const LIQUID_RE = /^(water|lava|bubble_column)$/;
const CLEAR_RE = /^(air|cave_air|void_air|water|lava|light|structure_void)$/;

export const idOf = (state: string | null | undefined) => (state ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');

/** Scaffold in the slicer's copy of the world: the block, marked (the marker never reaches the game). */
export const scaffoldState = (item: string) => `${item}[scaffold=true]`;
export const isScaffold = (state: string | null | undefined) => !!state && state.includes('scaffold=true');

export function classOf(state: string | null | undefined): number {
  if (state === null || state === undefined || state === 'unknown') return UNKNOWN;
  const id = idOf(state);
  let c = 0;
  if (AIR_RE.test(id)) c |= AIR;
  if (REPLACEABLE_RE.test(id)) c |= REPLACEABLE;
  if (PASSABLE_RE.test(id) || OPENS_RE.test(id)) c |= PASSABLE;
  if (LIQUID_RE.test(id)) c |= LIQUID;
  if (CLEAR_RE.test(id)) c |= CLEAR;
  const solid = !(c & (PASSABLE | REPLACEABLE | LIQUID));
  if (solid && !NO_FLOOR_RE.test(id)) c |= FLOOR;
  if (solid && !ACTIVATABLE_RE.test(id)) c |= SUPPORT;
  return c;
}

interface Table { states: string[]; index: Map<string, number>; cls: number[] }

/**
 * The blocks of a box (readBox order: x fastest, then z, then y), interned: copies are cheap (one typed array), so the
 * slicer can try a station's work in a copy and keep it or throw it away.
 */
export class Voxels {
  readonly box: Box;
  ids: Uint16Array;
  private readonly t: Table;

  constructor(box: Box, blocks: (string | null)[], table?: Table, ids?: Uint16Array) {
    this.box = box;
    this.t = table ?? { states: [], index: new Map(), cls: [] };
    if (ids) { this.ids = ids; return; }
    this.ids = new Uint16Array(box.width * box.height * box.length);
    const unknown = this.intern('unknown');
    for (let i = 0; i < this.ids.length; i++) this.ids[i] = blocks[i] === null || blocks[i] === undefined ? unknown : this.intern(blocks[i]!);
  }

  private intern(state: string): number {
    const s = state.replace(/^minecraft:/, '');
    let id = this.t.index.get(s);
    if (id === undefined) {
      id = this.t.states.length;
      this.t.states.push(s);
      this.t.index.set(s, id);
      this.t.cls.push(classOf(s));
    }
    return id;
  }

  clone(): Voxels { return new Voxels(this.box, [], this.t, this.ids.slice()); }

  get size() { return this.ids.length; }
  inside(p: P): boolean {
    const b = this.box;
    return p.x >= b.x && p.y >= b.y && p.z >= b.z && p.x < b.x + b.width && p.y < b.y + b.height && p.z < b.z + b.length;
  }
  index(p: P): number {
    if (!this.inside(p)) return -1;
    const b = this.box;
    return (p.x - b.x) + (p.z - b.z) * b.width + (p.y - b.y) * b.width * b.length;
  }
  at(i: number): P {
    const b = this.box, wl = b.width * b.length;
    return { x: b.x + i % b.width, y: b.y + Math.floor(i / wl), z: b.z + Math.floor((i % wl) / b.width) };
  }
  /** the state there ('unknown' where nothing is known), undefined outside the box */
  get(p: P): string | undefined {
    const i = this.index(p);
    return i < 0 ? undefined : this.t.states[this.ids[i]];
  }
  stateAt(i: number): string { return this.t.states[this.ids[i]]; }
  set(p: P, state: string): void {
    const i = this.index(p);
    if (i >= 0) this.ids[i] = this.intern(state);
  }
  /** the class bits there (UNKNOWN outside the box) */
  cls(p: P): number {
    const i = this.index(p);
    return i < 0 ? UNKNOWN : this.t.cls[this.ids[i]];
  }
  clsAt(i: number): number { return this.t.cls[this.ids[i]]; }
  is(p: P, bit: number): boolean { return (this.cls(p) & bit) !== 0; }
  /** the bot can stand with its feet here: room for feet and head, a floor under them */
  standable(p: P): boolean {
    return this.is(p, PASSABLE) && this.is({ x: p.x, y: p.y + 1, z: p.z }, PASSABLE) && this.is({ x: p.x, y: p.y - 1, z: p.z }, FLOOR);
  }
  /**
   * A spot to work from: standable, and not in a doorway (walking through is fine, but with its head in a door's top
   * half the mod's line of sight hits the door: a scaffold block inside a tower was "out of sight" from there, again
   * and again)
   */
  workable(p: P): boolean {
    return this.standable(p) && !this.inDoorway(p);
  }
  /** feet or head in a door or a gate */
  inDoorway(p: P): boolean {
    return OPENS_RE.test(idOf(this.get(p))) || OPENS_RE.test(idOf(this.get({ x: p.x, y: p.y + 1, z: p.z })));
  }
  /** the cells whose state differs from another copy of the same box */
  diff(o: Voxels): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.ids.length; i++) if (this.ids[i] !== o.ids[i] && this.stateAt(i) !== o.stateAt(i)) out.push(i);
    return out;
  }
}

// ------------------------------------------------------------------------------------------------ walking

/** Seconds: a block walked, a diagonal, a jump up, a drop (per block). Walking is 4.3 blocks a second. */
export const WALK = 0.23, DIAGONAL = 0.33, JUMP = 0.25, DROP = 0.1;
/** Highest drop it walks off (no fall damage below 4). */
export const MAX_DROP = 3;

const ORTHO: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Seconds a step onto a spot by a long drop costs on top (the deeper, the more): walls and roofs aren't paths. */
export const EDGE = 1.0, EDGE_PER_BLOCK = 0.3;

/**
 * How far the bot could fall off the spot (feet at `p`): the deepest drop beside it (the air under an open side, down
 * to the first floor, up to 8). A wall top seven blocks up is a 7; the ground, 0.
 */
export function drop(v: Voxels, p: P): number {
  let most = 0;
  for (const [dx, dz] of ORTHO) {
    const x = p.x + dx, z = p.z + dz;
    if (!v.is({ x, y: p.y, z }, PASSABLE) || !v.is({ x, y: p.y + 1, z }, PASSABLE)) continue;
    let k = 0;
    while (k < 8 && v.is({ x, y: p.y - 1 - k, z }, PASSABLE)) k++;
    if (k > most) most = k;
  }
  return most;
}

/** The extra a step onto `p` costs for the fall it risks (nothing for drops it walks off anyway). */
export const edgeCost = (v: Voxels, p: P) => { const d = drop(v, p); return d > MAX_DROP ? EDGE + EDGE_PER_BLOCK * (d - MAX_DROP) : 0; };

/**
 * The feet cells the bot can walk to in one step from `f` (which must be standable), with the time each takes; a spot
 * beside a fall it couldn't take costs extra (edgeCost), so the slicer keeps it off wall tops unless that pays.
 */
export function steps(v: Voxels, f: P, out: (p: P, cost: number) => void): void {
  const pass = (x: number, y: number, z: number) => v.is({ x, y, z }, PASSABLE);
  const stand = (x: number, y: number, z: number) => v.standable({ x, y, z });
  const go = (p: P, cost: number) => out(p, cost + edgeCost(v, p));
  for (const [dx, dz] of ORTHO) {
    const x = f.x + dx, z = f.z + dz;
    if (stand(x, f.y, z)) { go({ x, y: f.y, z }, WALK); continue; }
    // up a block: head room over where it stands now for the jump
    if (stand(x, f.y + 1, z) && pass(f.x, f.y + 2, f.z)) { go({ x, y: f.y + 1, z }, WALK + JUMP); continue; }
    // off an edge: room to walk out, then down to the first floor (no deeper than MAX_DROP)
    if (!pass(x, f.y, z) || !pass(x, f.y + 1, z)) continue;
    for (let k = 1; k <= MAX_DROP; k++) {
      if (!pass(x, f.y - k, z)) break;
      if (stand(x, f.y - k, z)) { go({ x, y: f.y - k, z }, WALK + DROP * k); break; }
    }
  }
  for (const [dx, dz] of DIAG) {
    const x = f.x + dx, z = f.z + dz;
    // no cutting corners: both sides open at feet and head
    if (!pass(f.x + dx, f.y, f.z) || !pass(f.x + dx, f.y + 1, f.z) || !pass(f.x, f.y, f.z + dz) || !pass(f.x, f.y + 1, f.z + dz)) continue;
    if (stand(x, f.y, z)) go({ x, y: f.y, z }, DIAGONAL);
  }
}

/** A binary heap of cell indices by cost. */
class Heap {
  private i: number[] = [];
  private c: number[] = [];
  get size() { return this.i.length; }
  push(index: number, cost: number) {
    const i = this.i, c = this.c;
    i.push(index); c.push(cost);
    let n = i.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (c[p] <= c[n]) break;
      [i[p], i[n]] = [i[n], i[p]]; [c[p], c[n]] = [c[n], c[p]];
      n = p;
    }
  }
  pop(): [number, number] {
    const i = this.i, c = this.c;
    const top: [number, number] = [i[0], c[0]];
    const li = i.pop()!, lc = c.pop()!;
    if (i.length) {
      i[0] = li; c[0] = lc;
      let n = 0;
      for (;;) {
        const l = 2 * n + 1, r = l + 1;
        let m = n;
        if (l < i.length && c[l] < c[m]) m = l;
        if (r < i.length && c[r] < c[m]) m = r;
        if (m === n) break;
        [i[m], i[n]] = [i[n], i[m]]; [c[m], c[n]] = [c[n], c[m]];
        n = m;
      }
    }
    return top;
  }
}

/** Walking times from a spot (or several) to every spot it can walk to in the box: Infinity where it can't. */
export interface Walk { cost: Float64Array; from: Int32Array }

export function walkFrom(v: Voxels, start: P | P[], maxCost = Infinity): Walk {
  const cost = new Float64Array(v.size).fill(Infinity);
  const from = new Int32Array(v.size).fill(-1);
  const heap = new Heap();
  for (const s of Array.isArray(start) ? start : [start]) {
    const i = v.index(s);
    if (i < 0 || !v.standable(s)) continue;
    cost[i] = 0;
    heap.push(i, 0);
  }
  while (heap.size) {
    const [i, c] = heap.pop();
    if (c > cost[i]) continue;
    steps(v, v.at(i), (p, d) => {
      const j = v.index(p);
      const nc = c + d;
      if (j < 0 || nc >= cost[j] || nc > maxCost) return;
      cost[j] = nc;
      from[j] = i;
      heap.push(j, nc);
    });
  }
  return { cost, from };
}

/** The spots walked through to `to` (start first), or [] when it can't get there. */
export function pathTo(v: Voxels, w: Walk, to: P): P[] {
  let i = v.index(to);
  if (i < 0 || !Number.isFinite(w.cost[i])) return [];
  const out: P[] = [];
  while (i >= 0) { out.push(v.at(i)); i = w.from[i]; }
  return out.reverse();
}

/**
 * Standing on a column of its own scaffold, where the bot ends up digging its way down it (the block under the feet,
 * one at a time), or undefined when it isn't on scaffold or the column doesn't end on a floor.
 */
export function descent(v: Voxels, feet: P): { count: number; to: P } | undefined {
  let k = 0;
  while (isScaffold(v.get({ x: feet.x, y: feet.y - 1 - k, z: feet.z }))) k++;
  if (!k) return undefined;
  const to = { x: feet.x, y: feet.y - k, z: feet.z };
  return v.is({ x: to.x, y: to.y - 1, z: to.z }, FLOOR) ? { count: k, to } : undefined;
}

/**
 * Whether the bot standing at `from` can still get out of `area` (to a spot outside its x/z footprint): walking, and
 * with `descend`, digging its way down a scaffold column it stands on (always open to it).
 */
export function canLeave(v: Voxels, from: P, area: Box, descend = false): boolean {
  const outside = (p: P) => p.x < area.x || p.z < area.z || p.x >= area.x + area.width || p.z >= area.z + area.length;
  if (!v.standable(from)) return false;
  if (outside(from)) return true;
  const seen = new Uint8Array(v.size);
  const queue = [v.index(from)];
  seen[queue[0]] = 1;
  for (let q = 0; q < queue.length; q++) {
    let found = false;
    const here = v.at(queue[q]);
    const visit = (p: P) => {
      if (found) return;
      const j = v.index(p);
      if (j < 0 || seen[j]) return;
      if (outside(p)) { found = true; return; }
      seen[j] = 1;
      queue.push(j);
    };
    steps(v, here, visit);
    if (descend && !found) { const d = descent(v, here); if (d) visit(d.to); }
    if (found) return true;
  }
  return false;
}

/**
 * Where the bot comes into the box from `p` outside it (home, far off): the standable spot on the box's sides nearest
 * it, at ground level (no fall beside it). The tour starts there, so its first station is one it can walk or climb to
 * from the ground (started from nowhere, the first station was a "hop" to a tower's lookout, ten blocks up).
 */
export function entryPoint(v: Voxels, p: P): P | undefined {
  const b = v.box;
  let best: P | undefined, bd = Infinity;
  for (let y = b.y; y < b.y + b.height; y++) for (let z = b.z; z < b.z + b.length; z++) for (let x = b.x; x < b.x + b.width; x++) {
    if (x !== b.x && x !== b.x + b.width - 1 && z !== b.z && z !== b.z + b.length - 1) continue;
    const q = { x, y, z };
    if (!v.standable(q) || drop(v, q) > MAX_DROP) continue;
    const d = Math.hypot(x - p.x, z - p.z) + 2 * Math.abs(y - p.y);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

/** The standable spots on the box's sides with no fall beside them: where one comes into the box on foot. */
export function edgeSpots(v: Voxels): P[] {
  const b = v.box;
  const out: P[] = [];
  for (let y = b.y; y < b.y + b.height; y++) for (let z = b.z; z < b.z + b.length; z++) for (let x = b.x; x < b.x + b.width; x++) {
    if (x !== b.x && x !== b.x + b.width - 1 && z !== b.z && z !== b.z + b.length - 1) continue;
    const q = { x, y, z };
    if (v.standable(q) && drop(v, q) <= MAX_DROP) out.push(q);
  }
  return out;
}

/** The standable spot nearest `p` (itself if it is one), searching a few blocks round it; undefined if none. */
export function nearestStandable(v: Voxels, p: P, radius = 6): P | undefined {
  let best: P | undefined, bd = Infinity;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
    const d = dx * dx + dz * dz + 2 * dy * dy;
    if (d < bd && v.standable(q)) { bd = d; best = q; }
  }
  return best;
}
