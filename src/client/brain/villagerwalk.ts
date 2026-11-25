import type { Pos, WorldMemory } from './memory.js';
import { hallLock, portalRing, type Blueprint, type Side } from './blueprints.js';
import { cellOf, type Ground } from './boatroute.js';
import { CLEAR } from './yardgates.js';

/**
 * Acquiring villagers: the home side on paper (S0). A villager is brought in through a lock in front of the hall's
 * gate (blueprints.ts hallLock: a roofed plank cell 3 x 2 with its own gate P, a lure in a wall socket, worked by the
 * bot from one post outside), and the yard's Nether portal is fenced (portalRing): the second villager led home was
 * lost in the open portal, and the hall's gate let villagers out each time it stood open with one awake. Here: where
 * the two shells go and where they stand (the blueprint's landmarks, and the zones their build writes from them: one
 * source, never a second copy of the geometry), whether their ground is free, whether they are ready as read, and
 * what the bot reaches and sees from the post.
 *
 * Pure: nothing here reads the world or writes memory. The blocks come in as read (`Blocks`: boatroute.ts Ground is
 * one), the entities as a look gave them.
 */

/** Eye over feet, standing (the bridge's getEyePosition). */
export const EYE = 1.62;
/** How far dig.here and the gate closer reach from the eye: blockInteractionRange() - 0.1 (Interact.java, Gates.java). */
export const REACH = 4.4;

/** The blocks as read: a state by cell ("oak_fence_gate[facing=south,open=false]"), null or undefined where not read. */
export type Blocks = Pick<Ground, 'state'>;

/** A blueprint put down in the world: `origin` is its minimum corner (y: the ground's level plus its groundOffset). */
export interface Placed { bp: Blueprint; origin: Pos }

/** A footprint as a zone holds it (y: the ground's level). */
export interface Footprint { x: number; y: number; z: number; width: number; length: number }

/** The lock's cells in the world (the design's vocabulary: P the lock's gate, H the hall's, S_out the last lure spot). */
export interface Lock {
  p: Pos;
  h: Pos;
  /** the lower block of the wall the lock's lure takes the place of */
  socket: Pos;
  /** the rail outside the socket: no villager stands there to work the lure from the yard */
  sill: Pos;
  /** the bot's standing cell (feet) */
  post: Pos;
  sOut: Pos;
  /** the six cells inside, feet level */
  inside: Pos[];
  /** the inside as a box, 2 high: where "in the lock" is asked, and what the bridge's guard takes */
  box: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number };
}

/** A lock with the blueprint it is: which side of the hall, which way round, and the ground kept for it. */
export interface LockPlan extends Lock, Placed {
  side: Side;
  mirror: boolean;
  /** the footprint grown by 1, as the zone `lock` holds it (written before the build: the ground is reserved at once) */
  zone: Footprint;
}

/** The portal's ring as its blueprint puts it: the gate, the cell outside it, and the zone `ring`. */
export interface RingPlan extends Placed {
  side: Side;
  gate: Pos;
  outside: Pos;
  zone: Footprint;
}

/** What a look (world.entities) says of one entity, as far as the lock asks. */
export interface Body { name: string; position?: Pos; health?: number }

const SIDES: readonly Side[] = ['south', 'west', 'north', 'east'];
const STEP: Record<Side, { x: number; z: number }> = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 } };

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPos = (p: unknown): p is Pos => !!p && typeof p === 'object' && fin((p as Pos).x) && fin((p as Pos).y) && fin((p as Pos).z);
const cell = (p: Pos): Pos => ({ x: p.x, y: p.y, z: p.z });
const add = (a: Pos, b: Pos): Pos => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const same = (a: Pos | undefined, b: Pos | undefined) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
const key = (p: Pos) => `${p.x},${p.y},${p.z}`;
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const idOf = (state: string) => state.replace(/^minecraft:/, '').replace(/\[.*$/, '');
const propsOf = (state: string): Record<string, string> =>
  Object.fromEntries((/\[(.*)\]$/.exec(state)?.[1] ?? '').split(',').filter(Boolean).map(kv => kv.split('=') as [string, string]));
const stateAt = (g: Blocks, p: Pos) => g.state(p.x, p.y, p.z);

// ------------------------------------------------------------------------------------------------ where the shells go

/** A blueprint's landmarks of one kind, in the world. */
const marks = (pl: Placed, kind: string): Pos[] => pl.bp.landmarks.filter(l => l.kind === kind).map(l => add(pl.origin, l.at));

/** A blueprint put down so that its landmark `kind` (where it goes: not built) lies on `at`. */
function anchored(bp: Blueprint, kind: string, at: Pos): Placed {
  const a = bp.landmarks.find(l => l.kind === kind)!.at;
  return { bp, origin: { x: at.x - a.x, y: at.y - a.y, z: at.z - a.z } };
}

/** The cells a spec builds ('.': cleared, no state) in the world; ' ' cells are left as they are and not listed. */
function specCells(pl: Placed): { at: Pos; state?: string }[] {
  const out: { at: Pos; state?: string }[] = [];
  pl.bp.spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => {
    if (ch !== ' ') out.push({ at: add(pl.origin, { x, y, z }), ...(ch === '.' ? {} : { state: pl.bp.spec.palette[ch] }) });
  })));
  return out;
}

/**
 * The box of blocks the questions here read of a shell (footprintFree, lockReady, ringReady), for whoever reads the
 * world for them: everything the spec builds and every landmark, one more cell round them (what stands beside a wall
 * or a fence, and round S_out), from the ground's level to the shell's top layer.
 */
export function spanOf(pl: Placed): { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number } {
  const { bp, origin } = pl;
  const xs = [origin.x, origin.x + bp.size.width - 1, ...bp.landmarks.map(l => origin.x + l.at.x)];
  const zs = [origin.z, origin.z + bp.size.length - 1, ...bp.landmarks.map(l => origin.z + l.at.z)];
  return {
    x1: Math.min(...xs) - 1, y1: origin.y - bp.groundOffset, z1: Math.min(...zs) - 1,
    x2: Math.max(...xs) + 1, y2: origin.y + bp.size.height - 1, z2: Math.max(...zs) + 1
  };
}

/**
 * The lock as its blueprint puts it at a hall gate `h` on `side` of the hall, the plain way round or mirrored: every
 * cell from the blueprint's landmarks. Nothing is asked of the world: this is where it would stand.
 */
export function lockAt(h: Pos, side: Side, mirror = false): LockPlan {
  const pl = anchored(hallLock(mirror, side), 'hall', h);
  const one = (kind: string) => marks(pl, kind)[0];
  const inside = marks(pl, 'inside');
  const xs = inside.map(c => c.x), zs = inside.map(c => c.z), y = inside[0].y;
  const { bp, origin } = pl;
  return {
    bp, origin, side, mirror,
    p: one('gate'), h: cell(h), socket: one('socket'), sill: one('sill'), post: one('post'), sOut: one('sout'), inside,
    box: { x1: Math.min(...xs), y1: y, z1: Math.min(...zs), x2: Math.max(...xs), y2: y + 1, z2: Math.max(...zs) },
    zone: { x: origin.x - 1, y: origin.y - bp.groundOffset, z: origin.z - 1, width: bp.size.width + 2, length: bp.size.length + 2 }
  };
}

/** The hall's gate and the side of the hall it is on, from the hall's own zones (`hall`, `hall:gate`). */
function hallGate(world: WorldMemory): { h: Pos; side: Side } | undefined {
  const g = (world.zones?.['hall:gate'] ?? []).find(isPos);
  const b = world.zones?.hall?.[0];
  if (!g || !b || !fin(b.x) || !fin(b.z) || !fin(b.width) || !fin(b.length)) return undefined;
  const side: Side | undefined = g.z === b.z + b.length - 1 ? 'south' : g.z === b.z ? 'north' : g.x === b.x ? 'west' : g.x === b.x + b.width - 1 ? 'east' : undefined;
  return side && { h: cell(g), side };
}

/** Where the lock goes at this world's hall, plain or mirrored (undefined with no hall). */
export function lockPlan(world: WorldMemory, mirror = false): LockPlan | undefined {
  const g = hallGate(world);
  return g && lockAt(g.h, g.side, mirror);
}

/**
 * The lock that stands, with its blueprint: read from the zones its build wrote (`lock:gate`, `lock:socket`,
 * `lock:sill`, `lock:post`, `lock:sout`, `lock:inside` x6: written only once every block is in place) and the hall's
 * own `hall:gate`. The zones are held to the blueprint: they are one of its eight layouts at that hall gate, or no
 * lock stands (zones half written, or a hall moved from under them).
 */
export function lockPlanOf(world: WorldMemory): LockPlan | undefined {
  const z = world.zones ?? {};
  const last = (k: string) => (z[k] ?? []).filter(isPos).at(-1);
  const h = (z['hall:gate'] ?? []).find(isPos);
  const p = last('lock:gate'), socket = last('lock:socket'), sill = last('lock:sill'), post = last('lock:post'), sOut = last('lock:sout');
  const inside = new Set((z['lock:inside'] ?? []).filter(isPos).slice(-6).map(key));
  if (!h || !p || !socket || !sill || !post || !sOut || inside.size !== 6) return undefined;
  for (const side of SIDES) for (const mirror of [false, true]) {
    const plan = lockAt(h, side, mirror);
    if (same(plan.p, p) && same(plan.socket, socket) && same(plan.sill, sill) && same(plan.post, post) && same(plan.sOut, sOut)
      && plan.inside.every(c => inside.has(key(c)))) return plan;
  }
  return undefined;
}

/** The lock that stands, as its zones say (see lockPlanOf); undefined while none does. It only reads. */
export function lockOf(world: WorldMemory): Lock | undefined {
  const l = lockPlanOf(world);
  return l && { p: l.p, h: l.h, socket: l.socket, sill: l.sill, post: l.post, sOut: l.sOut, inside: l.inside, box: l.box };
}

/** Whether a place (a villager's feet, the bot's) is inside the lock: in one of its six cells, at their level. */
export function inLock(lock: Pick<Lock, 'box'>, p: Pos): boolean {
  const b = lock.box, x = Math.floor(p.x), z = Math.floor(p.z);
  return x >= b.x1 && x <= b.x2 && z >= b.z1 && z <= b.z2 && p.y >= b.y1 - 0.5 && p.y < b.y2 + 1;
}

/**
 * The portal's ring as its blueprint puts it round a portal site (the zone `portal`: its footprint, y the ground's
 * level), the gate on `gateSide`: on the cells just outside the ground the frame's build keeps (portal.ts ringOf).
 */
export function ringAt(portal: Footprint, gateSide: Side): RingPlan {
  const axis = portal.width >= portal.length ? 'x' : 'z';
  const pl = anchored(portalRing(axis, gateSide), 'portal', { x: portal.x, y: portal.y, z: portal.z });
  const gate = marks(pl, 'gate')[0];
  return {
    ...pl, side: gateSide, gate, outside: { x: gate.x + STEP[gateSide].x, y: gate.y, z: gate.z + STEP[gateSide].z },
    zone: { x: pl.origin.x, y: portal.y, z: pl.origin.z, width: pl.bp.size.width, length: pl.bp.size.length }
  };
}

/** The yard's portal site, from its zone (portal.ts: the frame's build wrote it). */
function portalOf(world: WorldMemory): Footprint | undefined {
  const s = world.zones?.portal?.[0];
  return s && isPos(s) && fin(s.width) && fin(s.length) ? { x: s.x, y: s.y, z: s.z, width: s.width, length: s.length } : undefined;
}

/** Where the ring goes round this world's portal with its gate on `gateSide` (undefined with no portal at home). */
export function ringPlan(world: WorldMemory, gateSide: Side): RingPlan | undefined {
  const s = portalOf(world);
  return s && ringAt(s, gateSide);
}

/**
 * The ring that stands, with its blueprint: read from its zones (`ring`, the footprint, written before the build;
 * `ring:gate`, written once every block is in place) and held to the blueprint round the portal's own zone.
 */
export function ringPlanOf(world: WorldMemory): RingPlan | undefined {
  const s = portalOf(world);
  const zone = world.zones?.ring?.at(-1);
  const gate = (world.zones?.['ring:gate'] ?? []).filter(isPos).at(-1);
  if (!s || !zone || !gate) return undefined;
  return SIDES.map(side => ringAt(s, side)).find(r => same(r.gate, gate)
    && r.zone.x === zone.x && r.zone.z === zone.z && r.zone.width === zone.width && r.zone.length === zone.length);
}

// ------------------------------------------------------------------------------------------------ reach and sight

/** The eye of a bot standing in a cell (feet): the cell's middle, 1.62 up. */
export const eyeOf = (c: Pos): Pos => ({ x: c.x + 0.5, y: c.y + EYE, z: c.z + 0.5 });

/** From the eye of a bot standing in `eyeCell` to a block's middle: what the gate closer measures (within REACH). */
export function reach(eyeCell: Pos, block: Pos): number {
  const e = eyeOf(eyeCell);
  return Math.hypot(block.x + 0.5 - e.x, block.y + 0.5 - e.y, block.z + 0.5 - e.z);
}

/** A box inside a block's cell: x1, y1, z1, x2, y2, z2, each 0..1. */
type Box = readonly [number, number, number, number, number, number];
const CUBE: Box = [0, 0, 0, 1, 1, 1];
const px = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): Box => [x1 / 16, y1 / 16, z1 / 16, x2 / 16, y2 / 16, z2 / 16];

/** Nothing a ray is stopped by: the air, and fluids (the bridge's clip asks for none). */
const NO_OUTLINE = /^(air|cave_air|void_air|water|lava|bubble_column)$/;
const TORCH = /^(soul_|redstone_|copper_)?torch$/;
const RAIL = /^(\w+_)?rail$/;
const WALL_TORCH: Record<string, Box> = {
  north: px(5.5, 3, 11, 10.5, 13, 16), south: px(5.5, 3, 0, 10.5, 13, 5), west: px(11, 3, 5.5, 16, 13, 10.5), east: px(0, 3, 5.5, 5, 13, 10.5)
};
/**
 * Small plants, none over 13 sixteenths: the game shifts each a little by its position, so their outline is taken as
 * the cell's whole width. Only those whose shape is known for sure: any other plant is its whole cell.
 */
const SHORT_PLANT = new RegExp('^(short_grass|fern|dead_bush|dandelion|poppy|\\w+_tulip|cornflower|oxeye_daisy|azure_bluet|allium|blue_orchid'
  + '|lily_of_the_valley|torchflower|red_mushroom|brown_mushroom|open_eyeblossom|closed_eyeblossom)$');
const FLAT = /^(leaf_litter|pink_petals|wildflowers|\w+_carpet|\w+_pressure_plate|redstone_wire)$/;
const FENCE_ARM: Record<string, Box> = { north: px(6, 0, 0, 10, 16, 6), south: px(6, 0, 10, 10, 16, 16), west: px(0, 0, 6, 6, 16, 10), east: px(10, 0, 6, 16, 16, 10) };

/**
 * A block's outline as a ray meets it (the game's OUTLINE shape, not its collision: a ray stops on a torch, a rail or
 * a tuft of grass, and passes over a closed gate's top half-block of collision). Never smaller than the game's: the
 * thin blocks a yard has are given their own boxes, anything else that is not air its whole cell, and so is a cell not
 * read. What sees through this sees in the game.
 */
function outlineOf(state: string | null | undefined): readonly Box[] {
  if (state === null || state === undefined) return [CUBE];
  const id = idOf(state);
  if (NO_OUTLINE.test(id)) return [];
  const p = propsOf(state);
  if (/_fence_gate$/.test(id)) {
    const top = p.in_wall === 'true' ? 13 : 16;
    const z = px(0, 0, 6, 16, top, 10), x = px(6, 0, 0, 10, top, 16);
    return p.facing === 'north' || p.facing === 'south' ? [z] : p.facing === 'east' || p.facing === 'west' ? [x] : [z, x];
  }
  if (/_fence$/.test(id)) {
    // (a plain "oak_fence", its arms not said: all four)
    const arms = Object.keys(FENCE_ARM).filter(s => (p[s] ?? 'true') === 'true');
    return [px(6, 0, 6, 10, 16, 10), ...arms.map(s => FENCE_ARM[s])];
  }
  if (TORCH.test(id)) return [px(6, 0, 6, 10, 10, 10)];
  if (/wall_torch$/.test(id)) return [WALL_TORCH[p.facing] ?? CUBE];
  if (RAIL.test(id)) return [px(0, 0, 0, 16, /^ascending/.test(p.shape ?? '') ? 8 : 2, 16)];
  if (/_slab$/.test(id)) return [p.type === 'bottom' ? px(0, 0, 0, 16, 8, 16) : p.type === 'top' ? px(0, 8, 0, 16, 16, 16) : CUBE];
  if (id === 'snow') return [px(0, 0, 0, 16, 2 * Number(p.layers ?? 1), 16)];
  if (SHORT_PLANT.test(id)) return [px(0, 0, 0, 16, 13, 16)];
  if (FLAT.test(id)) return [px(0, 0, 0, 16, 3, 16)];
  if (id === 'dirt_path' || id === 'farmland') return [px(0, 0, 0, 16, 15, 16)];
  return [CUBE];
}

/** Where along a-b (0..1) the segment first meets a box, or undefined when it passes it by (begun inside it: 0). */
function enters(a: Pos, b: Pos, lo: Pos, hi: Pos): number | undefined {
  let t0 = 0, t1 = 1;
  for (const k of ['x', 'y', 'z'] as const) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-12) {
      if (a[k] < lo[k] || a[k] > hi[k]) return undefined;
      continue;
    }
    const n = (lo[k] - a[k]) / d, f = (hi[k] - a[k]) / d;
    t0 = Math.max(t0, Math.min(n, f));
    t1 = Math.min(t1, Math.max(n, f));
    if (t0 > t1) return undefined;
  }
  return t0;
}

/**
 * The game's clip from `a` to `b` against the blocks' outlines, asked of one block: whether the ray meets `target`
 * before anything else, and what it meets first when not. A tie (the ray along an edge two blocks share) is the other
 * block's.
 */
function clipTo(g: Blocks, a: Pos, b: Pos, target: Pos): { hit: boolean; by?: Pos } {
  let tTarget: number | undefined, tOther: number | undefined, other: Pos | undefined;
  const lo = (k: 'x' | 'y' | 'z') => Math.floor(Math.min(a[k], b[k])), hi = (k: 'x' | 'y' | 'z') => Math.floor(Math.max(a[k], b[k]));
  for (let y = lo('y'); y <= hi('y'); y++) for (let z = lo('z'); z <= hi('z'); z++) for (let x = lo('x'); x <= hi('x'); x++) {
    const mine = x === target.x && y === target.y && z === target.z;
    for (const box of outlineOf(g.state(x, y, z))) {
      const t = enters(a, b, { x: x + box[0], y: y + box[1], z: z + box[2] }, { x: x + box[3], y: y + box[4], z: z + box[5] });
      if (t === undefined) continue;
      if (mine) tTarget = Math.min(tTarget ?? t, t);
      else if (tOther === undefined || t < tOther) { tOther = t; other = { x, y, z }; }
    }
  }
  if (tTarget !== undefined && (tOther === undefined || tTarget < tOther - 1e-9)) return { hit: true };
  return { hit: false, ...(other && tOther !== undefined && (tTarget === undefined || tOther <= tTarget + 1e-9) ? { by: other } : {}) };
}

/** A full collision cube (the bridge's isCollisionShapeFullBlock), as far as a state string says; a cell not read counts as one. */
function fullCube(state: string | null | undefined): boolean {
  if (state === null || state === undefined) return true;
  const c = cellOf(state);
  return idOf(state) === 'magma_block' || (c.kind === 'solid' && c.bottom === 0 && c.top === 1);
}

/** The six faces in the bridge's order (Direction.values()): of two faces as near, the first is the one clicked. */
const FACES = [['down', 0, -1, 0], ['up', 0, 1, 0], ['north', 0, 0, -1], ['south', 0, 0, 1], ['west', -1, 0, 0], ['east', 1, 0, 0]] as const;
export type Face = typeof FACES[number][0];

/** What dig.here would find of a block from a standing cell: the face it would work, or why none (`by`: what is in the way). */
export type Sight = { seen: true; face: Face; dist: number } | { seen: false; why: 'covered' | 'far' | 'blocked'; by?: Pos };

/**
 * The port of dig.here's own choice of a face (Interact.java, as the villager jar leaves it: B6), for a bot standing in
 * `eyeCell`: the eye is the cell's middle 1.62 up; of the block's six faces, those whose neighbour is no full collision
 * cube (a rail, a torch or a flower before a face does not cover it: the socket's one open face has the sill's rail
 * before it); the aim is the face's middle drawn 0.01 into the block (0.49 from its centre); it must lie within 4.4 of
 * the eye, and the game's clip from the eye to it, against the blocks' outlines, must meet this block before any
 * other; the nearest such face is the one. What the bridge does after these lines for a small block (a torch, a
 * flower: it aims at the middle of the outline) is not ported: what the bot takes this way are full blocks (a lure, a
 * wall block, a plug), and a block that is no full cube is answered for as its outlineOf, on the side of "not seen".
 */
export function sight(g: Blocks, eyeCell: Pos, block: Pos): Sight {
  const eye = eyeOf(eyeCell);
  let best: { face: Face; dist: number } | undefined;
  // (of the faces a ray did not reach, the nearest names what is in the way: the face that would have been worked)
  let far = false, blocked: { dist: number; by?: Pos } | undefined;
  for (const [face, dx, dy, dz] of FACES) {
    if (fullCube(g.state(block.x + dx, block.y + dy, block.z + dz))) continue; // covered: not seen
    const fc = { x: block.x + 0.5 + dx * 0.49, y: block.y + 0.5 + dy * 0.49, z: block.z + 0.5 + dz * 0.49 };
    const dist = Math.hypot(fc.x - eye.x, fc.y - eye.y, fc.z - eye.z);
    if (dist > REACH) { far = true; continue; }
    const c = clipTo(g, eye, fc, block);
    if (!c.hit) { if (!blocked || dist < blocked.dist) blocked = { dist, ...(c.by ? { by: c.by } : {}) }; continue; }
    if (!best || dist < best.dist) best = { face, dist };
  }
  if (best) return { seen: true, ...best };
  return blocked ? { seen: false, why: 'blocked', ...(blocked.by ? { by: blocked.by } : {}) } : { seen: false, why: far ? 'far' : 'covered' };
}

/** Whether dig.here, from a bot standing in `eyeCell`, would see a face of `block` and work it (see `sight`). */
export function seesFace(g: Blocks, eyeCell: Pos, block: Pos): boolean {
  return sight(g, eyeCell, block).seen;
}

/** The blocks as read with one more standing at `at`: what the bot would see of a block once it is put there. */
export function withBlock(g: Blocks, at: Pos, state: string): Blocks {
  return { state: (x, y, z) => (x === at.x && y === at.y && z === at.z ? state : g.state(x, y, z)) };
}

// ------------------------------------------------------------------------------------------------ free ground

/** A block and a block of the same make in another wood (a build is in whichever wood the bot has most of). */
const makeOf = (state: string) => {
  const id = idOf(state);
  return /_fence_gate$/.test(id) ? 'a gate' : /_fence$/.test(id) ? 'a fence' : /_planks$/.test(id) ? 'planks' : id;
};
/** What stands as tall as a fence and joins one: beside a fence it is no step over it. */
const FENCE_LIKE = /_(fence|fence_gate|wall)$/;
const fullFloor = (state: string) => { const c = cellOf(state); return c.kind === 'solid' && c.bottom === 0 && c.top === 1; };
const said = (bp: Blueprint) => bp.name.replace(/-/g, ' ');

export type Free = { ok: true } | { ok: false; why: string; at: Pos };

/** What the cells a shell is worked by are called, by their landmark. */
const GROUND_CELLS: Record<string, string> = { inside: 'a cell inside', sill: 'the sill', post: 'the post', sout: 'S_out' };

/**
 * Whether the ground a shell goes on is free, on the blocks as read (asked before anything is reserved or built: for
 * the lock the plain layout, then the mirrored; for the ring one gate side after another). Three things:
 *   - every cell the spec builds or clears is air or a plant (yardgates.ts CLEAR), or holds its block already (a
 *     build cut short is gone on with, and a shell that stands is free ground for itself: the sill's rail too);
 *   - the cells the shell is worked by stand free over a full floor: the six inside, the sill, the post and S_out, each
 *     gate and the cell outside it;
 *   - over the ground, within 1 of every column the spec builds in (for the lock its footprint grown by 1, for the ring
 *     a band along the fence), nothing but plants and torches: a block beside a fence is a way over it, and a lamp post
 *     by the lock's wall is a step to its roof. A fence beside a fence the spec builds joins it and stays (the yard's
 *     west fence runs beside the portal ring's; the lock builds no fence, so a lamp post by it is in the way). The row
 *     the lock leans on, the hall's own wall, is not asked. The ground's own level is not read but under the cells
 *     above: the bot's cobblestone walk runs under the lock's floor.
 * The first fault found is the answer, with its cell; a cell not read is one.
 */
export function footprintFree(read: Blocks, pl: Placed): Free {
  const { bp, origin } = pl;
  const what = said(bp);
  const cells = specCells(pl);
  const built = new Map(cells.map(c => [key(c.at), c]));
  for (const c of cells) {
    const s = stateAt(read, c.at);
    if (s === null || s === undefined) return { ok: false, why: 'not read', at: c.at };
    if (CLEAR.test(s) || (c.state && makeOf(c.state) === makeOf(s))) continue;
    return { ok: false, why: `${idOf(s)} stands where the ${what}'s ${c.state ? idOf(c.state) : 'doorway'} goes`, at: c.at };
  }
  // the sill once it is down: the one block of the shell no spec cell holds (an act step lays it after the build)
  const sills = new Set(marks(pl, 'sill').map(key));
  const free = (at: Pos, s: string) => CLEAR.test(s) || (sills.has(key(at)) && RAIL.test(idOf(s)));
  const ground: { at: Pos; name: string }[] = [
    ...Object.entries(GROUND_CELLS).flatMap(([kind, name]) => marks(pl, kind).map(at => ({ at, name }))),
    ...bp.entrances.flatMap(e => {
      const gate = add(origin, e);
      return [{ at: gate, name: 'the gate' }, { at: { x: gate.x + STEP[e.facing].x, y: gate.y, z: gate.z + STEP[e.facing].z }, name: 'the cell outside the gate' }];
    })
  ];
  for (const c of ground) {
    const s = stateAt(read, c.at), under = { ...c.at, y: c.at.y - 1 }, floor = stateAt(read, under);
    if (s === null || s === undefined) return { ok: false, why: 'not read', at: c.at };
    if (floor === null || floor === undefined) return { ok: false, why: 'not read', at: under };
    // (a gate's own cell was asked above, as a cell the spec builds)
    if (!built.has(key(c.at)) && !free(c.at, s)) return { ok: false, why: `${idOf(s)} stands in ${c.name} of the ${what}`, at: c.at };
    if (!fullFloor(floor)) return { ok: false, why: `no full floor under ${c.name} of the ${what} (${idOf(floor)})`, at: under };
  }
  // the hall's wall: the row through the hall's gate, across the way out
  const hall = marks(pl, 'hall')[0], out = bp.entrances[0] ? STEP[bp.entrances[0].facing] : undefined;
  const leansOn = (x: number, z: number) => !!hall && !!out && (x - hall.x) * out.x + (z - hall.z) * out.z === 0;
  // (the spec's fences, not its gates: nothing joins a gate but the posts of its own line)
  const fences = cells.filter(c => c.state && /_(fence|wall)$/.test(idOf(c.state))).map(c => c.at);
  const y1 = origin.y + 1 - bp.groundOffset, y2 = origin.y + bp.size.height - 1;
  const asked = new Set<string>();
  for (const col of new Set(cells.map(c => `${c.at.x},${c.at.z}`))) {
    const [cx, cz] = col.split(',').map(Number);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, z = cz + dz;
      if (asked.has(`${x},${z}`) || leansOn(x, z)) continue;
      asked.add(`${x},${z}`);
      for (let y = y1; y <= y2; y++) {
        const at = { x, y, z };
        if (built.has(key(at))) continue;
        const s = stateAt(read, at);
        if (s === null || s === undefined) return { ok: false, why: 'not read', at };
        if (free(at, s)) continue;
        if (FENCE_LIKE.test(idOf(s)) && fences.some(f => f.y === y && Math.max(Math.abs(f.x - x), Math.abs(f.z - z)) <= 1)) continue;
        return { ok: false, why: `${idOf(s)} stands within 1 of the ${what}`, at };
      }
    }
  }
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------ ready, as read

const isOpen = (state: string) => /[[,]open=true/.test(state);

/**
 * Whether a villager could stand in a cell, by the game's own rules at their widest (S0 asks it of the cells by the
 * socket only; the walk model of S1 has the full rule): the head free of collision, no rail at its feet (it never
 * paths onto one from off the rails), and something to stand on, in the cell (a carpet, a slab, a bed) or under it.
 * Undefined where a block of it is not read.
 */
function standable(g: Blocks, at: Pos): boolean | undefined {
  const feet = stateAt(g, at), head = stateAt(g, { ...at, y: at.y + 1 }), under = stateAt(g, { ...at, y: at.y - 1 });
  if (feet === null || feet === undefined || head === null || head === undefined || under === null || under === undefined) return undefined;
  if (RAIL.test(idOf(feet))) return false;
  const f = cellOf(feet), h = cellOf(head), u = cellOf(under);
  const through = (c: typeof f) => c.kind === 'open' || c.kind === 'water';
  if (!through(h)) return false;
  if (f.kind === 'solid' && f.top < 1) return true;
  return through(f) && !through(u);
}

/**
 * What a fault of the lock is a fault OF, so that who asks need not read its words: the chores ask whether the lock
 * STANDS (no 'zones', no 'structure'), a trip and care whether it is READY (none at all), and what is merely in use
 * or in the way just now is neither broken nor theirs to build again.
 *   - 'zones': no lock stands, or its zones are not its blueprint's;
 *   - 'unread': cells of it were not read (one fault for all of them: nothing is known of those);
 *   - 'structure': the shell is not as built: a wall or roof block gone, a gate gone, the sill gone, a block where it
 *     has none (a doorway one high, something in a cell inside);
 *   - 'socket': the socket's cell holds no wall block: the lure of a trip under way (in use), or air (the wall block
 *     is owed: care puts it back first). The one cell of the wall that changes by design;
 *   - 'gate-open': P or the hall's gate H read open;
 *   - 'occupied': somebody in the lock, or S_out taken (a trip's lure stands there);
 *   - 'reach': a cell outside the lock from which a villager could work a lure in the socket;
 *   - 'post': the ground the lock is worked from: the post no cell to stand in, no full floor under S_out;
 *   - 'sight': from the post dig.here does not see the socket, or a lure at S_out (a tuft of grass in the ray).
 */
export type LockFaultKind = 'zones' | 'unread' | 'structure' | 'socket' | 'gate-open' | 'occupied' | 'reach' | 'post' | 'sight';
export interface LockFault { kind: LockFaultKind; text: string }

/**
 * The lock as it must stand before a trip, during the chores and whenever care looks, on the blocks as read and the
 * entities as a look gave them: the faults, each with its kind, none when it is ready. Asked:
 *   - the lock's zones are written and are the blueprint's (lockPlanOf);
 *   - every wall and roof block in place (planks of any wood), the socket a wall block among them;
 *   - P and the hall's gate H there and read shut, both doorways 2 high (a stray over H shut every chore out on Nov 24);
 *   - the sill down;
 *   - the six inside cells clear, 2 high, and no villager and no animal in them;
 *   - no cell outside the lock from which a villager could work a lure in the socket (a cell sharing a face with it at
 *     its level, or its top): with the sill gone the lure is taken from the yard;
 *   - the post a cell to stand in, S_out free over a full floor, and from the post dig.here sees the socket and a lure
 *     at S_out (`sight`): a tuft of grass in the ray is a fault, named.
 * The light inside is not asked (a torch gone leaves the lock a lock). A cell not read is one fault for all of them,
 * and comes first.
 */
export function lockFaults(world: WorldMemory, read: Blocks, seen: readonly Body[] = []): LockFault[] {
  const lock = lockPlanOf(world);
  if (!lock) {
    const some = Object.keys(world.zones ?? {}).some(k => /^lock:/.test(k) && world.zones![k].length);
    return [{ kind: 'zones', text: some ? 'the lock\'s zones are not its blueprint\'s' : 'no lock stands' }];
  }
  const faults: LockFault[] = [];
  const fault = (kind: LockFaultKind, text: string) => { faults.push({ kind, text }); };
  const unread: Pos[] = [];
  const look = (p: Pos): string | undefined => {
    const s = stateAt(read, p);
    if (s === null || s === undefined) { unread.push(p); return undefined; }
    return s;
  };
  const roof = lock.origin.y + lock.bp.size.height - 1;
  const over = (p: Pos) => ({ ...p, y: p.y + 1 });
  for (const c of specCells(lock)) {
    if (!c.state || !/_planks$/.test(idOf(c.state))) continue;
    const s = look(c.at);
    if (s === undefined || /_planks$/.test(idOf(s))) continue;
    if (same(c.at, lock.socket)) fault('socket', `the socket is no wall block: ${idOf(s)} at ${fmt(c.at)}`);
    else fault('structure', `a ${c.at.y === roof ? 'roof' : 'wall'} block gone at ${fmt(c.at)} (${idOf(s)})`);
  }
  for (const [name, gate] of [['the lock\'s', lock.p], ['the hall\'s', lock.h]] as const) {
    const s = look(gate), top = look(over(gate));
    if (s !== undefined && !/_fence_gate$/.test(idOf(s))) fault('structure', `${name} gate is gone at ${fmt(gate)} (${idOf(s)})`);
    else if (s !== undefined && isOpen(s)) fault('gate-open', `${name} gate is open at ${fmt(gate)}`);
    if (top !== undefined && !CLEAR.test(top)) fault('structure', `${name} doorway is one high: ${idOf(top)} at ${fmt(over(gate))}`);
  }
  const sill = look(lock.sill);
  if (sill !== undefined && !RAIL.test(idOf(sill))) fault('structure', `the sill is gone at ${fmt(lock.sill)} (${idOf(sill)})`);
  for (const c of lock.inside) for (const p of [c, over(c)]) {
    const s = look(p);
    if (s !== undefined && !CLEAR.test(s)) fault('structure', `${idOf(s)} in the lock at ${fmt(p)}`);
  }
  for (const e of seen) {
    const p = e?.position;
    // (anything alive that is no player: the bridge gives every living entity its health)
    if (!p || !isPos(p) || e.name === 'player' || (e.name !== 'villager' && e.health === undefined) || !inLock(lock, p)) continue;
    fault('occupied', `a ${e.name} in the lock at (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`);
  }
  const inside = new Set(lock.inside.map(key));
  const by = [...SIDES.map(s => ({ x: lock.socket.x + STEP[s].x, y: lock.socket.y, z: lock.socket.z + STEP[s].z })), over(lock.socket)];
  for (const c of by) {
    if (inside.has(key(c))) continue;
    const st = standable(read, c);
    if (st === undefined) unread.push(c);
    else if (st) fault('reach', `a cell outside the lock reaches the socket: ${fmt(c)}`);
  }
  const feet = look(lock.post), head = look(over(lock.post)), floor = look({ ...lock.post, y: lock.post.y - 1 });
  if (feet !== undefined && head !== undefined && floor !== undefined && !(CLEAR.test(feet) && CLEAR.test(head) && cellOf(floor).kind === 'solid')) {
    const [s, p] = !CLEAR.test(feet) ? [feet, lock.post] : !CLEAR.test(head) ? [head, over(lock.post)] : [floor, { ...lock.post, y: lock.post.y - 1 }];
    fault('post', `the post is no cell to stand in: ${idOf(s)} at ${fmt(p)}`);
  }
  const spot = look(lock.sOut), under = look({ ...lock.sOut, y: lock.sOut.y - 1 });
  if (spot !== undefined && !CLEAR.test(spot)) fault('occupied', `S_out is taken: ${idOf(spot)} at ${fmt(lock.sOut)}`);
  else if (under !== undefined && !fullFloor(under)) fault('post', `no full floor under S_out at ${fmt(lock.sOut)} (${idOf(under)})`);
  const blind = (name: string, s: Sight & { seen: false }) => {
    const b0 = s.by && stateAt(read, s.by);
    return `the post does not see ${name}: ${s.why === 'far' ? 'out of reach' : s.why === 'covered' ? 'every face of it is covered'
      : s.by ? `${b0 === null || b0 === undefined ? 'a block not read' : idOf(b0)} at ${fmt(s.by)} is in the way` : 'out of sight'}`;
  };
  // (each asked with its block standing there: an open socket, or the lure in it, is its own fault above)
  const socket = sight(withBlock(read, lock.socket, 'oak_planks'), lock.post, lock.socket);
  if (!socket.seen) fault('sight', blind(`the socket at ${fmt(lock.socket)}`, socket));
  const lure = sight(withBlock(read, lock.sOut, 'fletching_table'), lock.post, lock.sOut);
  if (!lure.seen) fault('sight', blind(`a lure at S_out ${fmt(lock.sOut)}`, lure));
  if (unread.length) faults.unshift({ kind: 'unread', text: `the lock is not read: ${new Set(unread.map(key)).size} cell(s), the first at ${fmt(unread[0])}` });
  return faults;
}

/**
 * The same as words alone, none when the lock is ready: what goes to `fetch.shells.lock` and is said. "The lock is
 * ready" is lockOf and this empty; whether it STANDS is asked of lockFaults' kinds, never of these words.
 */
export function lockReady(world: WorldMemory, read: Blocks, seen: readonly Body[] = []): string[] {
  return lockFaults(world, read, seen).map(f => f.text);
}

/**
 * The portal's ring as it must stand, on the blocks as read: the faults, none when it is ready (they go to
 * `fetch.shells.ring`); ready too where the yard has no portal. Asked:
 *   - the ring's zones are written and are the blueprint's round the portal (ringPlanOf);
 *   - every ring cell a fence, or the gate; the gate read shut;
 *   - no block beside the ring, inside it or outside, at the fence's level or one above (the ground apart, which lies
 *     under both): a block beside a fence is a way over it, and Baritone builds over a fence when the gate is the
 *     longer way. Plants and torches are no step, and a fence, wall or gate beside the ring at its own level joins it
 *     (the yard's west fence runs beside the ring's west side).
 */
export function ringReady(world: WorldMemory, read: Blocks): string[] {
  if (!portalOf(world)) return [];
  const ring = ringPlanOf(world);
  if (!ring) {
    return [!world.zones?.ring?.length ? 'the portal has no ring' : !world.zones?.['ring:gate']?.length ? 'the portal\'s ring is not built'
      : 'the ring\'s zones are not its blueprint\'s'];
  }
  const faults: string[] = [];
  const unread: Pos[] = [];
  const look = (p: Pos): string | undefined => {
    const s = stateAt(read, p);
    if (s === null || s === undefined) { unread.push(p); return undefined; }
    return s;
  };
  const cells = specCells(ring).filter(c => c.state);
  const on = new Set(cells.map(c => `${c.at.x},${c.at.z}`));
  for (const c of cells) {
    const s = look(c.at);
    if (s === undefined) continue;
    const gate = same(c.at, ring.gate);
    if (!(gate ? /_fence_gate$/ : /_fence$/).test(idOf(s))) faults.push(`${gate ? 'the ring\'s gate is' : 'a fence of the ring is'} gone at ${fmt(c.at)} (${idOf(s)})`);
    else if (gate && isOpen(s)) faults.push(`the ring's gate is open at ${fmt(c.at)}`);
  }
  const asked = new Set<string>();
  for (const c of cells) for (const side of SIDES) {
    const x = c.at.x + STEP[side].x, z = c.at.z + STEP[side].z;
    if (on.has(`${x},${z}`) || asked.has(`${x},${z}`)) continue;
    asked.add(`${x},${z}`);
    for (const dy of [0, 1]) {
      const p = { x, y: c.at.y + dy, z };
      const s = look(p);
      if (s === undefined || CLEAR.test(s) || (dy === 0 && FENCE_LIKE.test(idOf(s)))) continue;
      faults.push(`${idOf(s)} beside the ring at ${fmt(p)}: a way over it`);
    }
  }
  if (unread.length) faults.unshift(`the ring is not read: ${new Set(unread.map(key)).size} cell(s), the first at ${fmt(unread[0])}`);
  return faults;
}
