/**
 * Structures the brain builds, as pure spec generators for build-structure (see schematic.ts for the spec format: layers
 * bottom up, rows along +z, characters along +x; '.' = air, cleared; ' ' = leave the cell as it is).
 *
 * Coordinates are relative to the structure's origin, its minimum corner; north is -z, east +x. Where the origin goes
 * in y is each blueprint's `groundOffset`: origin.y = ground level + groundOffset, where ground level is the y of the
 * top ground block (the block you stand on).
 *   - groundOffset 1 (most of them): layer 0 is the first layer ABOVE the ground; the ground itself is left alone.
 *   - groundOffset 0 (cropPlot): layer 0 IS the top ground layer.
 *
 * Only blocks the player places from an item of the same name go in a spec, in states build-structure can verify
 * (checkBuild/missingCells compare only the properties a spec names, so a state names just what placing decides
 * reliably):
 *   - doors name facing and half only (hinge and open depend on the click and on whoever used the door last); both
 *     halves are in the spec so the check sees the top too, while placing and the bill count the lower half only;
 *   - fences are plain `oak_fence` (their north/east/south/west connections follow the neighbours), fence gates name
 *     only facing (open/in_wall/powered change by themselves);
 *   - torches are floor torches (`torch`): build-structure takes a block's id as the item to place and to look for in
 *     the inventory, and `wall_torch` is not an item, so a spec wall torch could never be placed;
 *   - chests name facing and type (left/right), so the two halves of a double chest are checked as a pair.
 * Things that are not placed from an item (farmland is tilled, water poured from a bucket, saplings and sugar cane
 * planted) are landmarks for later act steps, not spec blocks.
 */

import { layoutSpec, secondHalf, type StructureSpec } from '../schematic.js';
import type { Pos } from '../survey.js';

export type Side = 'north' | 'south' | 'east' | 'west';

export interface Landmark { kind: string; at: Pos }
/** A way in: the cell of the door or gate (its lower half), and the side it opens to (the cell outside is one step that way). */
export interface Entrance extends Pos { facing: Side }

export interface Blueprint {
  name: string;
  spec: StructureSpec;
  size: { width: number; height: number; length: number };
  /** items it takes, by item name (wall torch -> torch, a door's two halves -> one door), including act-step items */
  bill: Record<string, number>;
  entrances: Entrance[];
  landmarks: Landmark[];
  /** origin.y = ground level + groundOffset (1: layer 0 stands on the ground; 0: layer 0 replaces the top ground layer) */
  groundOffset: 0 | 1;
}

export interface MinePlan {
  /** cells to dig, step by step from the top (each column top to bottom), then the landing */
  dig: Pos[];
  /** cells to put a floor torch in (standing on the block below) */
  torches: Pos[];
  /** the centre of the landing's floor (the cell the bot stands in) */
  landing: Pos;
  steps: number;
}

// ---- directions and rotation ----

const CW: Record<Side, Side> = { north: 'east', east: 'south', south: 'west', west: 'north' };
const CCW: Record<Side, Side> = { north: 'west', west: 'south', south: 'east', east: 'north' };
const STEP: Record<Side, { x: number; z: number }> = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 } };
const SIDES = new Set<string>(['north', 'south', 'east', 'west']);

const norm = (turns: number) => ((Math.round(turns) % 4) + 4) % 4;

/** A side turned clockwise (seen from above) `turns` quarter turns. */
export function turn(side: Side, turns: number): Side {
  let s = side;
  for (let i = 0; i < norm(turns); i++) s = CW[s];
  return s;
}

/** The other half of a double chest: left halves join the chest clockwise of their facing, right halves counter-clockwise. */
export function chestPartner(at: Pos, facing: Side, type: 'left' | 'right'): Pos {
  const d = STEP[type === 'left' ? CW[facing] : CCW[facing]];
  return { x: at.x + d.x, y: at.y, z: at.z + d.z };
}

/** A block state turned clockwise `turns` quarter turns: facing, horizontal axis and per-side properties (fences, walls). */
export function rotateState(state: string, turns: number): string {
  const t = norm(turns);
  const m = /^([^[]+)\[(.*)\]$/.exec(state);
  if (!t || !m) return state;
  const props = m[2].split(',').filter(Boolean).map(kv => {
    const [k, v = ''] = kv.split('=').map(s => s.trim());
    if (k === 'facing' && SIDES.has(v)) return `${k}=${turn(v as Side, t)}`;
    if (k === 'axis' && t % 2 && (v === 'x' || v === 'z')) return `${k}=${v === 'x' ? 'z' : 'x'}`;
    if (SIDES.has(k)) return `${turn(k as Side, t)}=${v}`;
    return `${k}=${v}`;
  });
  return `${m[1]}[${props.join(',')}]`;
}

/** A position in a width x length box after turning the box clockwise `turns` times (it stays at the minimum corner). */
export function rotatePos<P extends Pos>(p: P, size: { width: number; length: number }, turns: number): P {
  let q: P = { ...p };
  let { width, length } = size;
  for (let i = 0; i < norm(turns); i++) {
    q = { ...q, x: length - 1 - q.z, z: q.x };
    [width, length] = [length, width];
  }
  return q;
}

/** A spec turned clockwise (seen from above) `turns` quarter turns; short rows are padded with air first, as layoutSpec does. */
export function rotateSpec(spec: StructureSpec, turns: number): StructureSpec {
  const t = norm(turns);
  if (!t) return spec;
  const { width, length } = layoutSpec(spec);
  const palette = Object.fromEntries(Object.entries(spec.palette).map(([ch, s]) => [ch, rotateState(s, t)]));
  const layers = spec.layers.map(layer => {
    let w = width, l = length;
    let grid = Array.from({ length: l }, (_, z) => Array.from({ length: w }, (_, x) => layer[z]?.[x] ?? '.'));
    for (let i = 0; i < t; i++) {
      const old = grid, ow = w, ol = l;
      [w, l] = [ol, ow];
      // new (x', z') holds old (x = z', z = ol - 1 - x')
      grid = Array.from({ length: l }, (_, z) => Array.from({ length: w }, (_, x) => old[ol - 1 - x][z]));
    }
    return grid.map(r => r.join(''));
  });
  return { palette, layers };
}

/** A whole blueprint turned clockwise `turns` quarter turns: spec, size, entrances and landmarks. */
export function rotate(bp: Blueprint, turns: number): Blueprint {
  const t = norm(turns);
  if (!t) return bp;
  const box = { width: bp.size.width, length: bp.size.length };
  const spec = rotateSpec(bp.spec, t);
  const size = t % 2 ? { width: bp.size.length, height: bp.size.height, length: bp.size.width } : { ...bp.size };
  return {
    ...bp, spec, size,
    entrances: bp.entrances.map(e => ({ ...rotatePos(e, box, t), facing: turn(e.facing, t) })),
    landmarks: bp.landmarks.map(l => ({ ...l, at: rotatePos(l.at, box, t) }))
  };
}

// ---- bill of materials ----

/** Blocks that come from another item. */
const ITEM_FOR: Record<string, string> = {
  wall_torch: 'torch', soul_wall_torch: 'soul_torch', redstone_wall_torch: 'redstone_torch', copper_wall_torch: 'copper_torch',
  redstone_wire: 'redstone', tripwire: 'string', water: 'water_bucket', lava: 'lava_bucket', powder_snow: 'powder_snow_bucket'
};

/** The item that places a block state ("minecraft:oak_wall_sign[facing=north]" -> "oak_sign"). */
export function itemOf(state: string): string {
  const id = state.replace(/^minecraft:/, '').replace(/\[.*$/, '');
  return ITEM_FOR[id] ?? id.replace(/_wall_hanging_sign$/, '_hanging_sign').replace(/_wall_(sign|banner|head|skull|fan)$/, '_$1');
}

/** Items a spec takes to build: every block cell, with a door's top and a bed's head free, and a double slab two slabs. */
export function billOf(spec: StructureSpec): Record<string, number> {
  layoutSpec(spec); // throws on characters not in the palette
  const bill: Record<string, number> = {};
  for (const layer of spec.layers) for (const row of layer) for (const ch of row) {
    if (ch === '.' || ch === ' ') continue;
    const state = spec.palette[ch];
    if (secondHalf(state)) continue;
    const item = itemOf(state);
    bill[item] = (bill[item] ?? 0) + (/_slab\[.*type=double/.test(state) ? 2 : 1);
  }
  return bill;
}

/**
 * What's left to place of a spec, given the blocks there now (a region read at the build's origin over its size, x
 * fastest, then z, then y): a cell already holding its block (by id, whatever its state) costs nothing. A fence ring
 * moved out wanted all 148 pieces again with 100 of them still standing.
 */
export function billLeft(spec: StructureSpec, blocks: (string | null)[], size: { width: number; length: number }): Record<string, number> {
  const bill: Record<string, number> = {};
  const id = (b: string | null | undefined) => (b ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
  spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => {
    if (ch === '.' || ch === ' ') return;
    const state = spec.palette[ch];
    if (secondHalf(state)) return;
    if (id(blocks[x + z * size.width + y * size.width * size.length]) === id(state)) return;
    const item = itemOf(state);
    bill[item] = (bill[item] ?? 0) + (/_slab\[.*type=double/.test(state) ? 2 : 1);
  })));
  return bill;
}

const addBill = (a: Record<string, number>, b: Record<string, number>) => {
  const out = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
};

// ---- building helpers ----

/** A mutable box of spec characters, [y][z][x]. */
class Grid {
  private readonly cells: string[][][];
  constructor(readonly width: number, readonly height: number, readonly length: number, fill = ' ') {
    this.cells = Array.from({ length: height }, () => Array.from({ length }, () => new Array<string>(width).fill(fill)));
  }
  set(x: number, y: number, z: number, ch: string): void {
    if (x < 0 || y < 0 || z < 0 || x >= this.width || y >= this.height || z >= this.length) {
      throw new RangeError(`cell ${x},${y},${z} is outside the ${this.width}x${this.height}x${this.length} box`);
    }
    this.cells[y][z][x] = ch;
  }
  get(x: number, y: number, z: number): string { return this.cells[y][z][x]; }
  layers(): string[][] { return this.cells.map(l => l.map(r => r.join(''))); }
}

function blueprint(name: string, spec: StructureSpec, extra: { entrances?: Entrance[]; landmarks?: Landmark[];
  bill?: Record<string, number>; groundOffset?: 0 | 1 } = {}): Blueprint {
  const { width, height, length } = layoutSpec(spec);
  return {
    name, spec, size: { width, height, length },
    bill: addBill(billOf(spec), extra.bill ?? {}),
    entrances: extra.entrances ?? [], landmarks: extra.landmarks ?? [], groundOffset: extra.groundOffset ?? 1
  };
}

/** Clockwise quarter turns that bring a structure drawn with its door on the south side round to `side`. */
const TURNS_FROM_SOUTH: Record<Side, number> = { south: 0, west: 1, north: 2, east: 3 };

function checkSide(side: string): asserts side is Side {
  if (!SIDES.has(side)) throw new Error(`side must be north, south, east or west, not "${side}"`);
}

const ROOM_PALETTE = {
  L: 'oak_log[axis=y]', P: 'oak_planks', T: 'torch',
  D: 'oak_door[facing=south,half=lower]', U: 'oak_door[facing=south,half=upper]'
};

/**
 * A W x L oak room drawn with its door on the south wall: log corner posts and plank walls `walls` high on the ground,
 * a flat plank roof on top, the inside cleared, and an oak door in the middle of the south wall.
 */
function room(width: number, length: number, walls: number): { g: Grid; door: Pos } {
  const g = new Grid(width, walls + 1, length, '.');
  for (let y = 0; y < walls; y++) for (let z = 0; z < length; z++) for (let x = 0; x < width; x++) {
    const edgeX = x === 0 || x === width - 1, edgeZ = z === 0 || z === length - 1;
    if (edgeX && edgeZ) g.set(x, y, z, 'L');
    else if (edgeX || edgeZ) g.set(x, y, z, 'P');
  }
  for (let z = 0; z < length; z++) for (let x = 0; x < width; x++) g.set(x, walls, z, 'P');
  const door = { x: Math.floor(width / 2), y: 0, z: length - 1 };
  g.set(door.x, 0, door.z, 'D');
  g.set(door.x, 1, door.z, 'U');
  return { g, door };
}

// ---- the blueprints ----

/** Most double chests a storage house holds: three along each long wall. */
export const STORAGE_HOUSE_MAX_CHESTS = 6;

/**
 * A 7 x 9 storage house (9 x 7 with the door east or west: the whole house turns): log corners, oak plank walls 4 high
 * and a flat plank roof (5 layers), an oak door in the middle of `doorSide`, double chests along the two long walls
 * from the back, facing the 3-wide aisle, and two floor torches in the aisle. Layer 0 stands on the ground (no floor:
 * the ground is the floor). Landmarks: every chest cell ('chest'), the door ('door') and the torches ('torch').
 */
export function storageHouse(opts: { chests?: number; doorSide?: Side } = {}): Blueprint {
  const chests = opts.chests ?? 4;
  const doorSide = opts.doorSide ?? 'south';
  checkSide(doorSide);
  if (!Number.isInteger(chests) || chests < 0 || chests > STORAGE_HOUSE_MAX_CHESTS) {
    throw new RangeError(`a storage house holds 0 to ${STORAGE_HOUSE_MAX_CHESTS} double chests, not ${chests}`);
  }
  const W = 7, L = 9;
  const { g, door } = room(W, L, 4);
  const landmarks: Landmark[] = [];
  // west row (x 1) faces east, east row (x 5) faces west; a left half's partner is clockwise of its facing:
  // facing east that is south (+z), facing west north (-z)
  const rows = [
    { x: 1, facing: 'east' as Side, n: Math.ceil(chests / 2), first: 'a', second: 'b' },
    { x: W - 2, facing: 'west' as Side, n: Math.floor(chests / 2), first: 'd', second: 'c' }
  ];
  for (const r of rows) {
    for (let i = 0; i < r.n; i++) {
      const z = 1 + 2 * i;
      g.set(r.x, 0, z, r.first);
      g.set(r.x, 0, z + 1, r.second);
      landmarks.push({ kind: 'chest', at: { x: r.x, y: 0, z } }, { kind: 'chest', at: { x: r.x, y: 0, z: z + 1 } });
    }
  }
  const torches = [{ x: 3, y: 0, z: 2 }, { x: 3, y: 0, z: 6 }];
  for (const t of torches) { g.set(t.x, t.y, t.z, 'T'); landmarks.push({ kind: 'torch', at: t }); }
  landmarks.push({ kind: 'door', at: door });
  const spec: StructureSpec = {
    palette: {
      ...ROOM_PALETTE,
      a: 'chest[facing=east,type=left]', b: 'chest[facing=east,type=right]',
      c: 'chest[facing=west,type=left]', d: 'chest[facing=west,type=right]'
    },
    layers: g.layers()
  };
  const bp = blueprint('storage-house', spec, { entrances: [{ ...door, facing: 'south' }], landmarks });
  return rotate(bp, TURNS_FROM_SOUTH[doorSide]);
}

/** The 16 dye colours, for wool and beds. */
export const COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple',
  'blue', 'brown', 'green', 'red', 'black'] as const;

/**
 * The first home: a 5 x 7 oak cabin drawn with its door on the south wall (log corners, plank walls 3 high, a flat
 * plank roof), a bed in the back corner with its head to the back wall, a crafting table and a furnace along the
 * other side, and a floor torch inside: the first nights' bed and workbench under a roof. Without `bed` the two bed
 * cells are left as they are (the bed comes later, by hand). Landmarks: 'bed' (its head), 'bed-foot', 'table',
 * 'furnace', 'torch', 'door'.
 */
export function cabin(opts: { bed?: string; doorSide?: Side } = {}): Blueprint {
  const doorSide = opts.doorSide ?? 'south';
  checkSide(doorSide);
  if (opts.bed && !/^[a-z_]+_bed$/.test(opts.bed)) throw new Error(`a bed is a "<colour>_bed", not "${opts.bed}"`);
  const { g, door } = room(5, 7, 3);
  const head = { x: 1, y: 0, z: 1 }, foot = { x: 1, y: 0, z: 2 };
  const table = { x: 3, y: 0, z: 1 }, furnace = { x: 3, y: 0, z: 2 }, torch = { x: 3, y: 0, z: 4 };
  g.set(head.x, 0, head.z, opts.bed ? 'H' : ' ');
  g.set(foot.x, 0, foot.z, opts.bed ? 'F' : ' ');
  g.set(table.x, 0, table.z, 'C');
  g.set(furnace.x, 0, furnace.z, 'K');
  g.set(torch.x, 0, torch.z, 'T');
  const palette: Record<string, string> = { ...ROOM_PALETTE, C: 'crafting_table', K: 'furnace[facing=west]' };
  if (opts.bed) {
    palette.H = `${opts.bed}[facing=north,part=head]`;
    palette.F = `${opts.bed}[facing=north,part=foot]`;
  }
  const landmarks: Landmark[] = [
    { kind: 'bed', at: head }, { kind: 'bed-foot', at: foot }, { kind: 'table', at: table }, { kind: 'furnace', at: furnace },
    { kind: 'torch', at: torch }, { kind: 'door', at: door }
  ];
  const bp = blueprint('cabin', { palette, layers: g.layers() }, { entrances: [{ ...door, facing: 'south' }], landmarks });
  return rotate(bp, TURNS_FROM_SOUTH[doorSide]);
}

/**
 * A 7 x 7 enchanting room: walls 4 high and a roof like the storage house, the enchanting table in the middle, and 15
 * bookshelves on the ground around it at distance 2 (the vanilla layout: an air ring between table and shelves, which
 * must stay empty, so no torches there); the 16th shelf cell, in front of the door, is left open as the way in. Floor
 * torches stand on the four corner shelves. Landmarks: 'table', 'bookshelf' x15, 'door', 'torch' x4.
 */
export function enchantRoom(opts: { doorSide?: Side } = {}): Blueprint {
  const doorSide = opts.doorSide ?? 'south';
  checkSide(doorSide);
  const N = 7, c = 3;
  const { g, door } = room(N, N, 4);
  const landmarks: Landmark[] = [{ kind: 'table', at: { x: c, y: 0, z: c } }];
  g.set(c, 0, c, 'E');
  for (let z = 1; z < N - 1; z++) for (let x = 1; x < N - 1; x++) {
    if (Math.max(Math.abs(x - c), Math.abs(z - c)) !== 2) continue;
    if (x === door.x && z === door.z - 1) continue; // the way in
    g.set(x, 0, z, 'B');
    landmarks.push({ kind: 'bookshelf', at: { x, y: 0, z } });
  }
  for (const [x, z] of [[1, 1], [N - 2, 1], [1, N - 2], [N - 2, N - 2]]) {
    g.set(x, 1, z, 'T');
    landmarks.push({ kind: 'torch', at: { x, y: 1, z } });
  }
  landmarks.push({ kind: 'door', at: door });
  const spec: StructureSpec = { palette: { ...ROOM_PALETTE, E: 'enchanting_table', B: 'bookshelf' }, layers: g.layers() };
  return rotate(blueprint('enchanting-room', spec, { entrances: [{ ...door, facing: 'south' }], landmarks }), TURNS_FROM_SOUTH[doorSide]);
}

export interface Gate { side: Side; offset: number }

/** The perimeter of a width x length box, clockwise from the north-west corner, with which cells are corners. */
function perimeter(width: number, length: number): { x: number; z: number; corner: boolean }[] {
  const out: { x: number; z: number; corner: boolean }[] = [];
  const corner = (x: number, z: number) => (x === 0 || x === width - 1) && (z === 0 || z === length - 1);
  for (let x = 0; x < width; x++) out.push({ x, z: 0, corner: corner(x, 0) });
  for (let z = 1; z < length; z++) out.push({ x: width - 1, z, corner: corner(width - 1, z) });
  for (let x = width - 2; x >= 0; x--) out.push({ x, z: length - 1, corner: corner(x, length - 1) });
  for (let z = length - 2; z >= 1; z--) out.push({ x: 0, z, corner: corner(0, z) });
  return out;
}

function gateCell(box: { width: number; length: number }, g: Gate): { x: number; z: number } {
  checkSide(g.side);
  const along = g.side === 'north' || g.side === 'south' ? box.width : box.length;
  if (!Number.isInteger(g.offset) || g.offset < 1 || g.offset > along - 2) {
    throw new RangeError(`a ${g.side} gate's offset must be 1 to ${along - 2} (not a corner), not ${g.offset}`);
  }
  switch (g.side) {
    case 'north': return { x: g.offset, z: 0 };
    case 'south': return { x: g.offset, z: box.length - 1 };
    case 'west': return { x: 0, z: g.offset };
    default: return { x: box.width - 1, z: g.offset };
  }
}

const GATE_CHAR: Record<Side, string> = { north: 'n', south: 's', east: 'e', west: 'w' };

function ring(name: string, box: { width: number; length: number }, gates: Gate[],
  torchAt: (index: number, corner: boolean) => boolean): Blueprint {
  const { width, length } = box;
  if (!Number.isInteger(width) || !Number.isInteger(length) || width < 2 || length < 2) {
    throw new RangeError(`a fence ring needs whole sides of at least 2, not ${width} x ${length}`);
  }
  const g = new Grid(width, 2, length, ' ');
  const gateAt = new Map<string, Gate>();
  for (const gate of gates) {
    const c = gateCell(box, gate);
    const k = `${c.x},${c.z}`;
    if (gateAt.has(k)) throw new Error(`two gates at ${k}`);
    gateAt.set(k, gate);
  }
  const landmarks: Landmark[] = [];
  const entrances: Entrance[] = [];
  perimeter(width, length).forEach(({ x, z, corner }, i) => {
    const gate = gateAt.get(`${x},${z}`);
    if (gate) {
      g.set(x, 0, z, GATE_CHAR[gate.side]);
      entrances.push({ x, y: 0, z, facing: gate.side });
      landmarks.push({ kind: 'gate', at: { x, y: 0, z } });
      return;
    }
    g.set(x, 0, z, 'F');
    if (torchAt(i, corner)) {
      g.set(x, 1, z, 'T');
      landmarks.push({ kind: 'torch', at: { x, y: 1, z } });
    }
  });
  const spec: StructureSpec = {
    palette: {
      F: 'oak_fence', T: 'torch',
      ...Object.fromEntries(Object.entries(GATE_CHAR).map(([side, ch]) => [ch, `oak_fence_gate[facing=${side}]`]))
    },
    layers: g.layers()
  };
  return blueprint(name, spec, { entrances, landmarks });
}

/**
 * A 1-high oak fence ring on the perimeter of width x length (layer 0, on the ground), an oak fence gate at each gate
 * (`offset` counts from the side's west or north end; corners can't be gates), and a floor torch on top of every
 * `torchEvery`-th post counted clockwise from the north-west corner, plus every corner (layer 1). Everything else,
 * inside and above, is left as it is. A gate faces its side (it is placed looking out).
 */
export function fenceRing(box: { width: number; length: number }, gates: Gate[], torchEvery = 6): Blueprint {
  return ring('fence-ring', box, gates, (i, corner) => corner || (torchEvery > 0 && i % torchEvery === 0));
}

/** A size x size animal pen: a fence ring with one gate in the middle of `gateSide` and torches on the corner posts. */
export function pen(size = 7, gateSide: Side = 'south'): Blueprint {
  if (!Number.isInteger(size) || size < 3) throw new RangeError(`a pen needs a size of at least 3, not ${size}`);
  return ring('pen', { width: size, length: size }, [{ side: gateSide, offset: Math.floor(size / 2) }], (_, corner) => corner);
}

/**
 * A size x size crop plot. groundOffset 0: layer 0 is the ground layer itself. Nothing in it is placeable (farmland is
 * tilled, water poured), so the spec only prepares the ground: it digs out the centre ground block for the water (layer
 * 0, '.') and clears what grows over the plot (layer 1, '.'); the rest of the ground is left as it is (' ').
 * Landmarks for the act steps: 'water' (the hole, fill it with a water bucket) and 'till' (every other ground cell,
 * at y 0). A 9 x 9 plot is the most one water source keeps wet (4 blocks each way). Planting is a separate step.
 * Pass `watered: true` once the water is in: the centre is then left as it is (a '.' there would have build-structure
 * try to clear the water) and layer 1 too (so the crops stay).
 */
export function cropPlot(size = 9, opts: { watered?: boolean } = {}): Blueprint {
  if (!Number.isInteger(size) || size < 3 || size % 2 === 0) throw new RangeError(`a crop plot needs an odd size of at least 3, not ${size}`);
  const c = (size - 1) / 2;
  const g = new Grid(size, 2, size, opts.watered ? ' ' : '.');
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) if (x !== c || z !== c) g.set(x, 0, z, ' ');
  const landmarks: Landmark[] = [{ kind: 'water', at: { x: c, y: 0, z: c } }];
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    if (x !== c || z !== c) landmarks.push({ kind: 'till', at: { x, y: 0, z } });
  }
  return blueprint('crop-plot', { palette: {}, layers: g.layers() },
    { landmarks, bill: opts.watered ? {} : { water_bucket: 1 }, groundOffset: 0 });
}

/**
 * A grid of saplings, cols along x and rows along z, `gap` empty cells between them. Saplings are planted by an act
 * step, so the spec places nothing (one layer, all ' ': a '.' would clear the trunks of grown trees). Landmarks
 * 'sapling' are the saplings' own cells (y 0, standing on the ground block below); bill: the saplings.
 */
export function treeGrid(cols: number, rows: number, gap = 3, sapling = 'oak_sapling'): Blueprint {
  for (const [k, v] of [['cols', cols], ['rows', rows]] as const) {
    if (!Number.isInteger(v) || v < 1) throw new RangeError(`${k} must be a whole number of at least 1, not ${v}`);
  }
  if (!Number.isInteger(gap) || gap < 0) throw new RangeError(`gap must be a whole number of at least 0, not ${gap}`);
  const pitch = gap + 1;
  const width = (cols - 1) * pitch + 1, length = (rows - 1) * pitch + 1;
  const landmarks: Landmark[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) landmarks.push({ kind: 'sapling', at: { x: i * pitch, y: 0, z: j * pitch } });
  const spec = { palette: {}, layers: new Grid(width, 1, length, ' ').layers() };
  return blueprint('tree-grid', spec, { landmarks, bill: { [sapling]: cols * rows } });
}

/**
 * A strip of sugar cane along +x: cane cells at z 0 (y 0, standing on the ground block below), each next to water at
 * z 1 in the ground layer (y -1), which must already be there (a shoreline: cane needs water beside the block it stands
 * on). The spec places nothing (planting is an act step); it spans both rows. Landmarks 'cane' and 'water'.
 */
export function caneStrip(length: number): Blueprint {
  if (!Number.isInteger(length) || length < 1) throw new RangeError(`length must be a whole number of at least 1, not ${length}`);
  const landmarks: Landmark[] = [];
  for (let x = 0; x < length; x++) landmarks.push({ kind: 'cane', at: { x, y: 0, z: 0 } });
  for (let x = 0; x < length; x++) landmarks.push({ kind: 'water', at: { x, y: -1, z: 1 } });
  const spec = { palette: {}, layers: new Grid(length, 1, 2, ' ').layers() };
  return blueprint('cane-strip', spec, { landmarks, bill: { sugar_cane: length } });
}

/** Steps between torches on a mine staircase. */
export const STAIR_TORCH_EVERY = 8;

/**
 * A staircase down: not a build but the cells to dig. Relative to the top of the stairs: (0, 0, 0) is the cell the bot
 * stands in (feet) before the first step. Step i (1..depth) is i cells along `dir` and i down; it is 2 wide (the
 * second lane to the right of `dir`, clockwise) and 3 high (y -i to -i + 2). At the bottom a 5 x 5 x 3 landing: the 5
 * cells along `dir` after the last step, lanes -2..2 (centred on the left lane), floor at -depth. Torches: one on the
 * floor of the right lane every 8th step, and one against the landing's far wall. dig.length = depth * 6 + 75.
 */
export function mineStairs(depth: number, dir: Side): MinePlan {
  checkSide(dir);
  if (!Number.isInteger(depth) || depth < 1) throw new RangeError(`depth must be a whole number of at least 1, not ${depth}`);
  const d = STEP[dir], s = STEP[CW[dir]];
  const at = (along: number, side: number, y: number): Pos => ({ x: d.x * along + s.x * side + 0, y, z: d.z * along + s.z * side + 0 });
  const dig: Pos[] = [];
  const torches: Pos[] = [];
  for (let i = 1; i <= depth; i++) {
    for (const side of [0, 1]) for (let y = -i + 2; y >= -i; y--) dig.push(at(i, side, y));
    if (i % STAIR_TORCH_EVERY === 0) torches.push(at(i, 1, -i));
  }
  for (let along = depth + 1; along <= depth + 5; along++) {
    for (let side = -2; side <= 2; side++) for (let y = -depth + 2; y >= -depth; y--) dig.push(at(along, side, y));
  }
  torches.push(at(depth + 5, 0, -depth));
  return { dig, torches, landing: at(depth + 3, 0, -depth), steps: depth };
}
