import { rotatePos, rotateState, turn, type Side } from '../brain/blueprints.js';
import { secondHalf } from '../schematic.js';

/**
 * Declarative structures: a design is the shape of a build (no coordinates), a structure is a design placed in a world
 * (anchor, rotation, options). Compiling a structure gives the cells it manages, each with the block it should hold
 * ("air" for cells kept clear); cells no part touches are not managed (left as they are). The world is the state:
 * progress, repair and drift are all "what differs from this" (diff.ts).
 *
 * A design, made to be written by an LLM:
 *   { version: 1, name: "hut",
 *     palette: { P: "oak_planks", L: "oak_log[axis=y]", D: "oak_door[facing=south,half=lower]" },
 *     parts: [
 *       { fill:  { from: [0,0,0], to: [4,0,4], block: "P" } },             // solid box
 *       { walls: { from: [0,1,0], to: [4,3,4], block: "P", corners: "L" } },// hollow sides (corner posts optional)
 *       { box:   { from: [0,0,0], to: [4,4,4], block: "P" } },             // hollow box with floor and roof
 *       { clear: { from: [1,1,1], to: [3,3,3] } },                         // must be air
 *       { layers: { at: [0,4,0], rows: [["PPPPP", "P...P"]] } },           // bottom-up layers of rows along +z,
 *                                                                          // characters along +x; '.' air, ' ' unmanaged
 *       { set:   { at: [2,1,0], block: "D" } } ],                         // one cell
 *     signs: [ { at: [2,2,1], facing: "south", lines: ["food1"] } ] }     // a wall sign there, text facing `facing`
 * Parts apply in order, later ones overwriting earlier ones. A block is a palette key or a block state written out
 * ("stone_bricks"). Coordinates are local: x east, y up, z south, from the design's minimum corner.
 */

export type Vec3 = [number, number, number];
export interface Pos { x: number; y: number; z: number }
export type Rotation = 0 | 90 | 180 | 270;

export type Part =
  | { fill: { from: Vec3; to: Vec3; block: string } }
  | { walls: { from: Vec3; to: Vec3; block: string; corners?: string } }
  | { box: { from: Vec3; to: Vec3; block: string; corners?: string } }
  | { clear: { from: Vec3; to: Vec3 } }
  | { layers: { at?: Vec3; rows: string[][] } }
  | { set: { at: Vec3; block: string } };

/** A sign: a wall sign whose text faces `facing`, or any sign block given as `block` (a standing one with its rotation). */
export interface SignSpec { at: Vec3; facing?: Side; lines: string[]; wood?: string; block?: string }

export interface Design {
  version: 1;
  name: string;
  description?: string;
  palette?: Record<string, string>;
  parts: Part[];
  signs?: SignSpec[];
}

export interface Structure {
  version: 1;
  name: string;
  /** a saved design by name, or the design itself */
  design: string | Design;
  /** where the design's minimum corner goes (after rotation) */
  anchor: Pos;
  rotation?: Rotation;
  /** the autopilot puts it back to this file when it drifts (default: only reported) */
  autoRepair?: boolean;
  /** before building: level the footprint and fill under the floor down to the ground */
  prepare?: { level?: boolean; foundation?: boolean };
  /** its chests are the home's storage (the whole homestead): the stash, the kit and the food goal use them */
  homeStorage?: boolean;
  notes?: string;
}

/** A managed cell: the block it should hold, in world coordinates. */
export interface Cell {
  at: Pos;
  /** block state without the namespace ("oak_door[facing=south,half=lower]"), or "air" */
  want: string;
  /** a sign's lines */
  sign?: string[];
  /** comes by itself with another cell (a door's top, a bed's head): checked, never placed on its own */
  second?: boolean;
}

export interface Compiled {
  cells: Cell[];
  /** the world box the structure spans */
  box: { x: number; y: number; z: number; width: number; height: number; length: number };
  /** blocks it places, by state id (without second halves or air) */
  counts: Record<string, number>;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
const ID = /^[a-z0-9_]+(\[[a-z0-9_]+=[a-z0-9_]+(,[a-z0-9_]+=[a-z0-9_]+)*\])?$/;
const SIDES: Side[] = ['north', 'south', 'east', 'west'];
const bare = (s: string) => s.replace(/^minecraft:/, '').trim();
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** Problems with a design, as sentences (empty when it's fine). */
export function validateDesign(d: Design): string[] {
  const out: string[] = [];
  if (!d || typeof d !== 'object') return ['a design is an object with name, palette and parts'];
  if (d.version !== 1) out.push('version must be 1');
  if (!NAME.test(d.name ?? '')) out.push(`name "${d.name}" must be letters, digits, - and _ (up to 48)`);
  for (const [k, v] of Object.entries(d.palette ?? {})) {
    if (k.length !== 1 || k === '.' || k === ' ') out.push(`palette key "${k}" must be one character other than '.' and space`);
    if (!ID.test(bare(v))) out.push(`palette ${k}: "${v}" is not a block state like "oak_planks" or "oak_stairs[facing=east]"`);
  }
  if (!Array.isArray(d.parts) || !d.parts.length) out.push('parts must list at least one part');
  const block = (b: string, where: string) => {
    if (typeof b !== 'string' || !b) { out.push(`${where}: block is missing`); return; }
    if (b.length === 1 && !d.palette?.[b]) out.push(`${where}: "${b}" is not in the palette`);
    else if (b.length > 1 && !ID.test(bare(b))) out.push(`${where}: "${b}" is not a block state`);
  };
  const vec = (v: unknown, where: string) => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(n => Number.isInteger(n))) out.push(`${where} must be [x, y, z] whole numbers`);
  };
  (d.parts ?? []).forEach((p, i) => {
    const where = `part ${i + 1}`;
    const kinds = Object.keys(p);
    if (kinds.length !== 1) { out.push(`${where}: one of fill, walls, box, clear, layers, set`); return; }
    const k = kinds[0];
    const v = (p as Record<string, Record<string, unknown>>)[k];
    if (k === 'fill' || k === 'walls' || k === 'box' || k === 'clear') {
      vec(v.from, `${where} (${k}) from`); vec(v.to, `${where} (${k}) to`);
      if (k !== 'clear') block(v.block as string, `${where} (${k})`);
      if (v.corners) block(v.corners as string, `${where} (${k}) corners`);
    } else if (k === 'set') {
      vec(v.at, `${where} (set) at`); block(v.block as string, `${where} (set)`);
    } else if (k === 'layers') {
      if (v.at) vec(v.at, `${where} (layers) at`);
      const rows = v.rows as string[][];
      if (!Array.isArray(rows) || !rows.every(l => Array.isArray(l) && l.every(r => typeof r === 'string'))) out.push(`${where} (layers): rows is a list of layers, each a list of strings`);
      else for (const ch of new Set(rows.flat().join(''))) if (ch !== '.' && ch !== ' ' && !d.palette?.[ch]) out.push(`${where} (layers): "${ch}" is not in the palette`);
    } else out.push(`${where}: unknown part "${k}"`);
  });
  (d.signs ?? []).forEach((s, i) => {
    vec(s.at, `sign ${i + 1} at`);
    if (s.block ? !/_sign(\[|$)/.test(bare(s.block)) : !SIDES.includes(s.facing!)) out.push(`sign ${i + 1}: facing must be north, south, east or west (or give block, a sign block state)`);
    if (!Array.isArray(s.lines) || s.lines.length > 4 || s.lines.some(l => typeof l !== 'string' || l.length > 15)) out.push(`sign ${i + 1}: lines are up to 4 strings of up to 15 characters`);
  });
  return out;
}

/** The design's cells in local coordinates (before rotation): "x,y,z" -> state or "air". */
function localCells(d: Design): { cells: Map<string, string>; signs: Map<string, string[]> } {
  const cells = new Map<string, string>();
  const state = (b: string) => bare(b.length === 1 ? d.palette![b] : b);
  const span = (a: Vec3, b: Vec3) => {
    const lo = a.map((v, i) => Math.min(v, b[i])), hi = a.map((v, i) => Math.max(v, b[i]));
    return { lo, hi };
  };
  for (const p of d.parts) {
    if ('fill' in p || 'walls' in p || 'box' in p || 'clear' in p) {
      const v = 'fill' in p ? p.fill : 'walls' in p ? p.walls : 'box' in p ? p.box : p.clear;
      const { lo, hi } = span(v.from, v.to);
      for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) for (let x = lo[0]; x <= hi[0]; x++) {
        const edgeX = x === lo[0] || x === hi[0], edgeZ = z === lo[2] || z === hi[2], edgeY = y === lo[1] || y === hi[1];
        if ('clear' in p) { cells.set(key(x, y, z), 'air'); continue; }
        if ('walls' in p && !(edgeX || edgeZ)) continue;
        if ('box' in p && !(edgeX || edgeZ || edgeY)) continue;
        const corners = 'walls' in p ? p.walls.corners : 'box' in p ? p.box.corners : undefined;
        const block = corners && edgeX && edgeZ ? corners : ('fill' in p ? p.fill.block : 'walls' in p ? p.walls.block : (p as { box: { block: string } }).box.block);
        cells.set(key(x, y, z), state(block));
      }
    } else if ('set' in p) {
      cells.set(key(...p.set.at), state(p.set.block));
    } else if ('layers' in p) {
      const [ax, ay, az] = p.layers.at ?? [0, 0, 0];
      p.layers.rows.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => {
        if (ch === ' ') return;
        cells.set(key(ax + x, ay + y, az + z), ch === '.' ? 'air' : state(ch));
      })));
    }
  }
  const signs = new Map<string, string[]>();
  for (const s of d.signs ?? []) {
    cells.set(key(...s.at), s.block ? bare(s.block) : `${s.wood ?? 'oak'}_wall_sign[facing=${s.facing}]`);
    signs.set(key(...s.at), s.lines);
  }
  return { cells, signs };
}

/** The other half of a two-block block, if `state` is the half that's placed (door bottom, bed foot). */
function otherHalf(state: string, at: Vec3): { at: Vec3; state: string } | undefined {
  if (/_door\[/.test(state) && /half=lower/.test(state)) return { at: [at[0], at[1] + 1, at[2]], state: state.replace('half=lower', 'half=upper') };
  if (/_bed\[/.test(state) && /part=foot/.test(state)) {
    const f = /facing=(north|south|east|west)/.exec(state)?.[1] as Side | undefined;
    if (!f) return undefined;
    const d = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[f];
    return { at: [at[0] + d[0], at[1], at[2] + d[1]], state: state.replace('part=foot', 'part=head') };
  }
  return undefined;
}

/**
 * The cells a design manages once placed: rotated clockwise (seen from above) by `rotation`, its minimum corner at
 * `anchor`. A door's top and a bed's head are added as second halves.
 */
export function compile(d: Design, anchor: Pos, rotation: Rotation = 0): Compiled {
  const problems = validateDesign(d);
  if (problems.length) throw new Error(`the design has problems: ${problems.join('; ')}`);
  const { cells, signs } = localCells(d);
  // second halves: a door's top and a bed's head take their cell whatever the design put there (a wall over a door)
  for (const [k, state] of [...cells]) {
    const at = k.split(',').map(Number) as Vec3;
    const o = otherHalf(state, at);
    if (o) cells.set(key(...o.at), o.state);
  }
  const all = [...cells.keys()].map(k => k.split(',').map(Number));
  const min = [0, 1, 2].map(i => Math.min(...all.map(c => c[i])));
  const max = [0, 1, 2].map(i => Math.max(...all.map(c => c[i])));
  const size = { width: max[0] - min[0] + 1, height: max[1] - min[1] + 1, length: max[2] - min[2] + 1 };
  const turns = ((rotation ?? 0) / 90) % 4;
  const out: Cell[] = [];
  const counts: Record<string, number> = {};
  for (const [k, state] of cells) {
    const [x, y, z] = k.split(',').map(Number);
    const p = rotatePos({ x: x - min[0], y: y - min[1], z: z - min[2] }, { width: size.width, length: size.length }, turns);
    const want = state === 'air' ? 'air' : rotateState(state, turns);
    const cell: Cell = { at: { x: anchor.x + p.x, y: anchor.y + p.y, z: anchor.z + p.z }, want };
    if (signs.has(k)) cell.sign = signs.get(k);
    if (want !== 'air' && secondHalf(want)) cell.second = true;
    else if (want !== 'air') counts[want] = (counts[want] ?? 0) + 1;
    out.push(cell);
  }
  const turned = turns % 2 ? { width: size.length, length: size.width } : { width: size.width, length: size.length };
  out.sort((a, b) => a.at.y - b.at.y || a.at.z - b.at.z || a.at.x - b.at.x);
  return { cells: out, box: { ...anchor, width: turned.width, height: size.height, length: turned.length }, counts };
}

/** A sign's facing after the structure's rotation. */
export const turnSide = (s: Side, rotation: Rotation = 0) => turn(s, ((rotation ?? 0) / 90) % 4);
