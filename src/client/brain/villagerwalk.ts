import type { Pos, WorldMemory } from './memory.js';
import { hallLock, portalRing, type Blueprint, type Side } from './blueprints.js';
import { cellOf, FROM_ZONES, type Ground } from './boatroute.js';
import { zoneDistance, type Zone } from './courtesy.js';
import { CLEAR, SIDE_STEP, type HomeSide, type YardGate } from './yardgates.js';

/**
 * Acquiring villagers: the home side on paper (S0). A villager is brought in through a lock in front of the hall's
 * gate (blueprints.ts hallLock: a roofed plank cell 3 x 2 with its own gate P, a lure in a wall socket, worked by the
 * bot from one post outside), and the yard's Nether portal is fenced (portalRing): the second villager led home was
 * lost in the open portal, and the hall's gate let villagers out each time it stood open with one awake. Here: where
 * the two shells go and where they stand (the blueprint's landmarks, and the zones their build writes from them: one
 * source, never a second copy of the geometry), whether their ground is free, whether they are ready as read, and
 * what the bot reaches and sees from the post.
 *
 * And the villager's ground (S1, the second half of this file): where a villager led by a lure walks, by two rule
 * sets over one search, and where each hop's lure, the villager and the bot go.
 *
 * Pure: nothing here reads the world or writes memory. The blocks come in as read (`Blocks`: boatroute.ts Ground is
 * one), the entities as a look gave them.
 */

/** Eye over feet, standing (the bridge's getEyePosition). */
export const EYE = 1.62;
/** How far dig.here and the gate closer reach from the eye: blockInteractionRange() - 0.1 (Interact.java, Gates.java). */
export const REACH = 4.4;

/**
 * The blocks as read: a state by cell ("oak_fence_gate[facing=south,open=false]"), null or undefined where not read;
 * with the band of heights read (`y0`, `height`) where it is known, as a Ground knows it.
 */
export type Blocks = Pick<Ground, 'state'> & Partial<Pick<Ground, 'y0' | 'height'>>;

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
  const band = g.y0 !== undefined && g.height !== undefined ? { y0: g.y0, height: g.height } : {};
  return { ...band, state: (x, y, z) => (x === at.x && y === at.y && z === at.z ? state : g.state(x, y, z)) };
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

// ================================================================================================ the villager's ground (S1)
//
// A villager without a job walks by itself to the nearest free job-site block it can reach within 48 and takes the
// job; break the block and it is jobless again at once. The bot leapfrogs one such block home (the lure): down about
// 22 on, the villager comes, broken, carried on. About 60 hops were driven by hand on Nov 23-24 and every one with a
// walkable way and no nearer free job site arrived in 4-18 s (E-results E8). What went wrong was round the hop: the
// bot's own smithing table nearer than the lure, a bench by a fence that wedged the villager, a sinkhole it could fall
// into and not climb out of, a 3-block drop at the west gate. So every hop is planned here on the ground as read, by
// two rule sets over one search. `lead`: what the bot may COUNT on the villager doing (a rise of a block, a drop of 2,
// a full floor, no water, a ring round what hurts). `game`: what the game's pathfinder lets it do (rises to 1.125 by
// collision tops, drops of 3, any top, a slab, a stair, a bed, a fence's top from a block beside it, water). Each errs
// to its own side: lead never more than the villager can do, game never less. A hop is taken only where the two agree
// near the way (sameWay): the villager takes the game's way, not the planner's.

/** The game's own search for a job site [B: AcquirePoi, WalkNodeEvaluator]: a path of 48 at most, 768 nodes looked at. */
export const GAME_PATH = 48;
export const GAME_NODES = 768;
/** A hop's lure goes about this far on (live: hops of 22-25 arrived in 4-18 s), this far at most, and this far at least toward where it goes. */
export const HOP_LEN = 22;
export const HOP_MAX = 24;
export const HOP_MIN = 8;
/** What the lead rules let a hop's way be: well inside the game's 48 and 768, whose miss the bot cannot see. */
export const HOP_PATH = 36;
export const HOP_NODES = 600;
/** No free job site within this of any cell of a way (the game's 48 and 8 more): between a break and a place no lure stands. */
export const RIVAL_R = 56;
/** No cell the game reaches within this of a spot and cannot leave again (an employed villager strolls ~9 from its block [B]). */
export const TRAP_R = 10;
/** The first lure within this many lead path cells of a candidate. */
export const FIRST_PATH = 24;
/** A lure never goes down again in a cell it stood in this recently: the game's retry backoff grows 2-20 s a miss [B]. */
export const REUSE_MS = 20_000;
/** The bot's careful walk to where it stands by a lure, at most, by the lead rules (a safe subset of what a careful walk does). */
export const BOT_WALK = 40;
/** From where it stands the bot puts the lure on its floor: Interact.java aimPlace clicks the floor's top first, 4.5 from the eye at most. */
const PLACE_REACH = 4.5;
/** A villager's height (EntityType.VILLAGER is 0.6 x 1.95): the air a body stands in, from its feet's height up. */
const BODY = 1.95;
const EPS = 1e-6;
/** Heights are collision tops (a path block's 15/16, a fence's 1.5), not cells: from floor top to floor top. */
const LEAD_RISE = 1 + 1 / 16; // a path block up onto a full block
const GAME_RISE = 1.125; // WalkNodeEvaluator's jump [B]
/**
 * The deepest drop the ward climbs back up by the lead rules (a full block down onto a path block is 1 1/16): a way
 * with none deeper is one it can walk back (`retrace`); a hop whose `drop` is deeper commits the trip ('drop').
 */
export const RETRACE_DROP = LEAD_RISE;
const LEAD_DROP = 2;
const GAME_DROP = 3; // a mob's fall distance when it chases nothing [B]
/** Water to the game: a way, at a cost (PathType.WATER's malus). */
const WATER_COST = 8;
/** What hurts is a wall to the lead rules with a ring this wide round it; a portal with every cell within 5; a hop's spot keeps 4 off what hurts. */
const NEAR_HURT = 1;
const NEAR_PORTAL = 5;
const SPOT_HURT = 4;

/** The two rule sets: `lead`, what the bot may count on; `game`, what the game's pathfinder lets the villager do. */
export type RuleSet = 'lead' | 'game';

/** A box on the ground, both ends in it. */
export interface Area { x1: number; z1: number; x2: number; z2: number }

/** The yard as the walk sees it: its fence's box and ground's level (the block, as world.yard keeps it), the bot's own blocks in it (rt.builtNear). */
export interface YardGround extends Area { y: number; built?: readonly Pos[] }

export interface WalkOpts {
  /** the gates held open for this way: the lead rules pass no other gate (the closer may shut one any time); the game these and any read open */
  open?: readonly Pos[];
  /** the trip is not committed (lead): no drop deeper than the villager climbs back up. What it walked out it can walk back */
  retrace?: boolean;
  /**
   * The yard: to the lead rules an unrecorded scaffold-kind block above the yard's ground is a wall, not a floor (the
   * staircase the bot's walks left by the west gate was how villager 2 left the yard on Nov 25)
   */
  yard?: YardGround;
}

/** Where a body stands: its feet's cell, and its feet's height `f` (the floor's collision top: 70.9375 on a path block at y 70). */
export interface Stand { x: number; y: number; z: number; f: number }

/** Why a step, a stand or a way is refused. `floor`: something stands there but nothing the lead rules count on as a floor (a slab, a stair, leaves, the bot's scaffold). */
export type Why = 'rise' | 'drop' | 'fence' | 'floor' | 'water' | 'hazard' | 'unread' | 'zone' | 'rival' | 'far';
/** A refusal and where: `size` the rise, the drop or the water's width; `by` the job site or build kept off; `what` what is there. */
export interface NoWay { why: Why; at: Pos; size?: number; what?: string; by?: Pos }

export const isStand = (s: Stand | NoWay): s is Stand => 'f' in s;
const posOf = (s: Stand): Pos => ({ x: s.x, y: s.y, z: s.z });
/** The cell the feet are in at a height: a floor within a sixteenth of a block's top is that block's top (a path block's 15/16 is the cell over it). */
const cellY = (f: number) => (Math.abs(f - Math.round(f)) <= 1 / 16 + EPS ? Math.round(f) : Math.floor(f));
const hdist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
/** A cell's middle across the ground (an entity's position, a waypoint's cell). */
const midOf = (p: { x: number; z: number }) => ({ x: Math.floor(p.x) + 0.5, z: Math.floor(p.z) + 0.5 });
const inArea = (a: Area, p: { x: number; z: number }) => p.x >= a.x1 && p.x <= a.x2 && p.z >= a.z1 && p.z <= a.z2;
const DIRS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// ------------------------------------------------------------------------------------------------ the cells

/** What stands on a block's top as a villager meets it: `full` the lead rules count on; `thin` and `post` only the game's; `none` nobody's. */
type Floor = 'full' | 'thin' | 'post' | 'leaves' | 'none';
interface Box1 { bottom: number; top: number; floor: Floor }
/** A cell as a walking villager meets it. */
type VCell =
  | { k: 'unread' }
  | { k: 'air' }
  | { k: 'rail' }
  | { k: 'water' }
  | { k: 'hazard'; what: string; portal?: true }
  | { k: 'gate'; open: boolean }
  | { k: 'door'; wooden: boolean; open: boolean }
  | ({ k: 'solid'; id: string } & Box1);

const UNREAD: VCell = { k: 'unread' };
const AIR: VCell = { k: 'air' };
const RAIL_CELL: VCell = { k: 'rail' };
const WATER: VCell = { k: 'water' };
/** A gate nobody walks through is a bar 1.5 high, the game's floor on top; a door nobody walks through is a wall. */
const GATE_BOX: Box1 = { bottom: 0, top: 1.5, floor: 'post' };
const DOOR_BOX: Box1 = { bottom: 0, top: 1, floor: 'none' };

/** What a portal takes away: a wall, with every cell within 5 of it, to the lead rules (villager 2 walked into the yard's on Nov 25). */
const PORTALS = /^(nether_portal|end_portal|end_gateway)$/;
/** What hurts, holds or slows: a wall to both sets, with its ring to the lead rules. */
const HURTS: Record<string, string> = {
  lava: 'lava', fire: 'fire', soul_fire: 'fire', magma_block: 'a magma block', campfire: 'a campfire', soul_campfire: 'a campfire',
  cactus: 'a cactus', sweet_berry_bush: 'a berry bush', powder_snow: 'powder snow', wither_rose: 'a wither rose', cobweb: 'a cobweb',
  pointed_dripstone: 'dripstone'
};
const WATERY = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass|lily_pad)$/;
/**
 * Blocks the game stands on or beside and the lead rules count on as no floor (a block with collision whose top is not
 * a full block's, or is only a narrow part of the cell). boatroute.ts cellOf takes every one of them for a whole cube;
 * anything else it takes so is a full block here too.
 */
const THIN = new RegExp('(_stairs|_trapdoor|_bed|^chest|^trapped_chest|^ender_chest|lantern|^chain|_chain|flower_pot|^potted_\\w+|cake|candle'
  + '|_head|_skull|end_rod|lightning_rod|anvil|enchanting_table|brewing_stand|^bell|grindstone|stonecutter|lectern|hopper|daylight_detector'
  + '|conduit|bamboo|scaffolding|ladder|cocoa|sea_pickle|turtle_egg|amethyst_bud|amethyst_cluster|big_dripleaf|heavy_core|decorated_pot'
  + '|sniffer_egg|composter|cauldron|_carpet|^snow|honey_block|soul_sand|^mud|azalea|_shelf|dried_ghast|chorus_\\w+|piston_head)$');
/** The tidy round's stray kinds (tidy.ts STRAY): what the bot's own walks pillar and bridge with. */
const STRAY = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|netherrack)$/;

/** A cell's kind, from its state alone (the same for every state string: kept once each). */
const KINDS = new Map<string, VCell>();
function classify(state: string | null | undefined): VCell {
  if (state === null || state === undefined) return UNREAD;
  let c = KINDS.get(state);
  if (c) return c;
  c = kindOf(state);
  if (KINDS.size > 20_000) KINDS.clear();
  KINDS.set(state, c);
  return c;
}
function kindOf(state: string): VCell {
  const id = idOf(state);
  if (PORTALS.test(id)) return { k: 'hazard', what: 'a portal', portal: true };
  if (HURTS[id]) return { k: 'hazard', what: HURTS[id] };
  if (WATERY.test(id)) return WATER;
  if (RAIL.test(id)) return RAIL_CELL;
  if (/_fence_gate$/.test(id)) return { k: 'gate', open: isOpen(state) };
  if (/_door$/.test(id)) return { k: 'door', wooden: id !== 'iron_door', open: isOpen(state) };
  if (/_(fence|wall)$/.test(id)) return { k: 'solid', id, bottom: 0, top: 1.5, floor: 'post' };
  if (/(^|_)(glass_pane|pane|bars)$/.test(id)) return { k: 'solid', id, bottom: 0, top: 1, floor: 'post' };
  const c = cellOf(state);
  if (c.kind === 'open') return AIR;
  if (c.kind === 'water') return WATER;
  if (c.kind === 'unknown') return UNREAD;
  // (the boat's other hazards are no harm to a villager: flowing water is water, a big dripleaf tips under a boat)
  if (c.kind === 'hazard') return /water/.test(c.what) ? WATER : { k: 'solid', id, bottom: 0, top: 15 / 16, floor: 'thin' };
  const full = c.top >= 15 / 16 - EPS && c.top <= 1 + EPS && (c.bottom < EPS || /_slab$/.test(id));
  const floor: Floor = /_leaves$/.test(id) ? 'leaves' : full && !THIN.test(id) ? 'full' : 'thin';
  return { k: 'solid', id, bottom: c.bottom, top: c.top, floor };
}

const nameOf = (c: VCell): string => (c.k === 'solid' ? c.id : c.k === 'gate' ? 'a gate' : c.k === 'door' ? 'a door' : c.k === 'hazard' ? c.what
  : c.k === 'rail' ? 'a rail' : c.k === 'water' ? 'water' : c.k === 'unread' ? 'a block not read' : 'air');
/** Whether a block is a thin one (fence, wall, pane, bars, gate, stairs, trapdoor, a slab not on top, bed, chest...): what the game stands on or beside that the lead rules do not. */
const thinCell = (c: VCell) => c.k === 'gate' || (c.k === 'solid' && (c.floor === 'thin' || c.floor === 'post'));

/** What hurts in a column (its heights and what it is) and where its portal blocks are. */
interface Column { hurts: { y: number; what: string }[]; portals: number[] }

/**
 * The ground as one search reads it: each cell's kind looked up once, and per column what hurts and what is a portal
 * (asked of every lead stand within 1 and 5). `with` gives the same ground with one block more (the lure where it would
 * go): the rest is as read and already looked at.
 */
class View {
  private readonly memo = new Map<string, VCell>();
  private readonly cols = new Map<string, Column>();
  private constructor(readonly g: Blocks, private readonly lo: number, private readonly hi: number,
    private readonly base?: View, private readonly patch?: { at: Pos; cell: VCell; state: string }) {}
  /** The ground `g` over its band of heights (a Ground's own; else 24 round the heights the question names). */
  static of(g: Blocks, ...ys: number[]): View {
    if (g instanceof View) return g;
    if (g.y0 !== undefined && g.height !== undefined) return new View(g, g.y0, g.y0 + g.height - 1);
    const fy = ys.filter(Number.isFinite), lo = fy.length ? Math.min(...fy) : 64, hi = fy.length ? Math.max(...fy) : 64;
    return new View(g, Math.floor(lo) - 24, Math.ceil(hi) + 24);
  }
  /** The same ground with `state` standing at `at` (never what hurts: the lists of a column are the ground's own). */
  with(at: Pos, state: string): View {
    return new View(this.g, this.lo, this.hi, this.base ?? this, { at, cell: classify(state), state });
  }
  /** The state as read, with the block `with` stood there (a View is Blocks: `sight` asks it). */
  state(x: number, y: number, z: number): string | null | undefined {
    const p = this.patch;
    return p && p.at.x === x && p.at.y === y && p.at.z === z ? p.state : this.g.state(x, y, z);
  }
  /** The band's top: the highest height read. */
  top(): number { return this.base ? this.base.top() : this.hi; }
  cls(x: number, y: number, z: number): VCell {
    const p = this.patch;
    if (p && p.at.x === x && p.at.y === y && p.at.z === z) return p.cell;
    if (this.base) return this.base.cls(x, y, z);
    const k = `${x},${y},${z}`;
    let c = this.memo.get(k);
    if (!c) { c = classify(this.g.state(x, y, z)); this.memo.set(k, c); }
    return c;
  }
  private col(x: number, z: number): Column {
    if (this.base) return this.base.col(x, z);
    const k = `${x},${z}`;
    let c = this.cols.get(k);
    if (!c) {
      c = { hurts: [], portals: [] };
      for (let y = this.lo; y <= this.hi; y++) {
        const v = this.cls(x, y, z);
        if (v.k !== 'hazard') continue;
        if (v.portal) c.portals.push(y);
        else c.hurts.push({ y, what: v.what });
      }
      this.cols.set(k, c);
    }
    return c;
  }
  /** What hurts within `r` (Chebyshev, across the ground) of a column, between two heights; undefined when nothing. */
  hurts(x: number, z: number, r: number, y1: number, y2: number): { at: Pos; what: string } | undefined {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const h = this.col(x + dx, z + dz).hurts.find(e => e.y >= y1 && e.y <= y2);
      if (h) return { at: { x: x + dx, y: h.y, z: z + dz }, what: h.what };
    }
    return undefined;
  }
  /** A portal block within `r` of a column, between two heights. */
  portal(x: number, z: number, r: number, y1: number, y2: number): Pos | undefined {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const y = this.col(x + dx, z + dz).portals.find(e => e >= y1 && e <= y2);
      if (y !== undefined) return { x: x + dx, y, z: z + dz };
    }
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------------ the two rule sets

/**
 * One rule set over one ground: where a body stands (`stand`) and where one step takes it (`step`), each answered once.
 * A step goes the way the game's own walk does: whatever stands in the body's way at its height it steps up onto if it
 * is no higher than the set climbs (and the body stands on it), else it is refused; with nothing in the way the body
 * comes down on the first floor under it, no further down than the set drops. Then the set's own rules for where it
 * came to: the floor (the lead rules count on full tops only), the air over it, and to the lead rules what hurts within
 * 1 and a portal within 5.
 */
class Walker {
  readonly game: boolean;
  private readonly rise: number;
  private readonly drop: number;
  private readonly open: Set<string>;
  private readonly built: Set<string>;
  private readonly stands = new Map<string, Stand | NoWay>();
  private readonly steps = new Map<string, Stand | NoWay>();
  constructor(readonly v: View, readonly set: RuleSet, readonly o: WalkOpts = {}) {
    this.game = set === 'game';
    this.rise = this.game ? GAME_RISE : LEAD_RISE;
    // (retracing, a drop no deeper than the lead rules climb back up: a full block down onto a path block is 1 1/16)
    this.drop = this.game ? GAME_DROP : o.retrace ? RETRACE_DROP : LEAD_DROP;
    this.open = new Set((o.open ?? []).map(key));
    this.built = new Set((o.yard?.built ?? []).map(key));
  }

  /** Whether a body walks through what is in a cell: air and plants, a wooden door; a gate held open; to the game a gate or door read open, and water. */
  private through(c: VCell, at: Pos): boolean {
    switch (c.k) {
      case 'air': return true;
      case 'door': return c.wooden || (this.game && c.open);
      case 'gate': return this.open.has(key(at)) || (this.game && c.open);
      case 'water': return this.game;
      default: return false;
    }
  }

  /** The collision box of what a body does not walk through, where it is one (a gate is a bar 1.5 high, a door a wall). */
  private boxOf(c: VCell): Box1 | undefined {
    return c.k === 'solid' ? c : c.k === 'gate' ? GATE_BOX : c.k === 'door' ? DOOR_BOX : undefined;
  }

  private no(c: VCell, at: Pos): NoWay {
    switch (c.k) {
      case 'unread': return { why: 'unread', at };
      case 'hazard': return { why: 'hazard', at, what: c.what };
      case 'water': return { why: 'water', at, what: 'water' };
      case 'rail': return { why: 'fence', at, what: 'a rail' };
      case 'gate': case 'door': return { why: 'fence', at, what: nameOf(c) };
      default: return { why: 'rise', at, what: nameOf(c) };
    }
  }

  /** An unrecorded scaffold-kind block above the yard's ground, inside its fence's box: the bot's walks left it, and the game climbs it. */
  private scaffold(c: VCell, at: Pos): boolean {
    const y = this.o.yard;
    return !!y && c.k === 'solid' && inArea(y, at) && at.y > y.y && STRAY.test(c.id) && !this.built.has(key(at));
  }

  private floorWhy(c: VCell, at: Pos): NoWay | undefined {
    const b = this.boxOf(c);
    if (!b || b.floor === 'none') return { why: 'floor', at, what: nameOf(c) };
    if (this.game) return undefined;
    if (b.floor === 'post') return { why: 'fence', at, what: nameOf(c) };
    if (b.floor !== 'full') return { why: 'floor', at, what: nameOf(c) };
    if (this.scaffold(c, at)) return { why: 'floor', at, what: `${nameOf(c)} of the bot's scaffold` };
    return undefined;
  }

  /**
   * What stands in a column between two heights: undefined for nothing, else the highest collision top in the way
   * (with its cell), or why the column is no way at all (not read, what hurts, a rail, water to the lead rules). The cell
   * under `lo`'s is asked too: a fence's 1.5 reaches into the cell over it.
   */
  private inWay(x: number, z: number, lo: number, hi: number): { top: number; at: Pos; c: VCell } | NoWay | undefined {
    let best: { top: number; at: Pos; c: VCell } | undefined;
    const y0 = Math.floor(lo + EPS);
    for (let y = y0 - 1; y <= Math.floor(hi - EPS); y++) {
      const c = this.v.cls(x, y, z), at = { x, y, z };
      if (this.through(c, at)) continue;
      const b = this.boxOf(c);
      if (!b) {
        if (y < y0) continue;
        return this.no(c, at);
      }
      if (y + b.top <= lo + EPS || y + b.bottom >= hi - EPS) continue;
      if (!best || y + b.top > best.top) best = { top: y + b.top, at, c };
    }
    return best;
  }

  /** Whether (and at what height) a body stands with its feet in a cell, by this set's rules. */
  stand(x: number, y: number, z: number): Stand | NoWay {
    const k = `${x},${y},${z}`;
    let s = this.stands.get(k);
    if (!s) { s = this.standing(x, y, z); this.stands.set(k, s); }
    return s;
  }

  private standing(x: number, y: number, z: number): Stand | NoWay {
    const at = { x, y, z }, here = this.v.cls(x, y, z);
    let f: number;
    if (here.k === 'water' && this.game) f = y;
    else if (!this.through(here, at)) {
      // (a block lower than its cell in the feet's own cell: a slab, a carpet, a bed, snow; its top is the floor)
      const b = this.boxOf(here);
      if (!b) return this.no(here, at);
      if (b.bottom > EPS || b.top >= 15 / 16 - EPS) return { why: b.floor === 'post' || b.floor === 'none' ? 'fence' : 'rise', at, what: nameOf(here) };
      const why = this.floorWhy(here, at);
      if (why) return why;
      f = y + b.top;
    } else {
      const under = { x, y: y - 1, z }, u = this.v.cls(x, y - 1, z), b = this.boxOf(u);
      if (!b || y - 1 + b.top < y - 1 / 16 - EPS) {
        if (u.k === 'unread' || u.k === 'hazard' || (u.k === 'water' && !this.game)) return this.no(u, under);
        return { why: 'drop', at, what: 'nothing under it' };
      }
      const why = this.floorWhy(u, under);
      if (why) return why;
      f = y - 1 + b.top;
    }
    const way = this.inWay(x, z, f, f + BODY);
    if (way) return 'why' in way ? way : { why: 'rise', at: way.at, what: `${nameOf(way.c)} where the body stands` };
    if (!this.game) {
      const h = this.v.hurts(x, z, NEAR_HURT, Math.floor(f - EPS), Math.floor(f + BODY - EPS));
      if (h) return { why: 'hazard', at: h.at, what: h.what };
      const p = this.v.portal(x, z, NEAR_PORTAL, y - NEAR_PORTAL, y + NEAR_PORTAL);
      if (p) return { why: 'hazard', at: p, what: 'a portal' };
    }
    return { x, y, z, f };
  }

  /** One step from a stand, to a neighbour across the ground (a diagonal only on the level, both cells beside it standable at that level). */
  step(n: Stand, dx: number, dz: number): Stand | NoWay {
    const k = `${n.x},${n.y},${n.z},${n.f},${dx},${dz}`;
    let s = this.steps.get(k);
    if (!s) { s = this.stepping(n, dx, dz); this.steps.set(k, s); }
    return s;
  }

  private stepping(n: Stand, dx: number, dz: number): Stand | NoWay {
    if (dx && dz) {
      const level = (s: Stand | NoWay): NoWay | undefined => !isStand(s) ? s
        : Math.abs(s.f - n.f) > EPS ? { why: s.f > n.f ? 'rise' : 'drop', at: posOf(s), size: Math.abs(s.f - n.f), what: 'a corner off the level' } : undefined;
      const side = level(this.step(n, dx, 0)) ?? level(this.step(n, 0, dz));
      if (side) return side;
      const t = this.straight(n, n.x + dx, n.z + dz);
      return level(t) ?? t;
    }
    return this.straight(n, n.x + dx, n.z + dz);
  }

  private straight(n: Stand, x: number, z: number): Stand | NoWay {
    const f = n.f;
    const way = this.inWay(x, z, f, f + BODY);
    if (way && 'why' in way) return way;
    if (way) {
      if (way.top - f > this.rise + EPS) {
        if (way.c.k === 'gate' || way.c.k === 'door' || (way.c.k === 'solid' && way.c.floor === 'post')) return { why: 'fence', at: way.at, what: nameOf(way.c) };
        return { why: 'rise', at: way.at, size: this.climb(x, z, f), what: nameOf(way.c) };
      }
      const up = way.top;
      const head = this.inWay(x, z, up, up + BODY);
      if (head) return 'why' in head ? head : { why: 'rise', at: head.at, size: this.climb(x, z, f), what: `${nameOf(head.c)} over the step` };
      if (!this.game) {
        // (the lead rules: the air to rise in, over the cell it rises from)
        const room = this.inWay(n.x, n.z, f, up + BODY);
        if (room) return { why: 'rise', at: room.at, what: 'no room over it to step up' };
      }
      return this.landing(x, z, up);
    }
    // nothing in the way at its height: down onto the first floor under it
    for (let y = Math.floor(f + EPS); y >= Math.floor(f - this.drop - EPS) - 1; y--) {
      const c = this.v.cls(x, y, z), at = { x, y, z };
      if (c.k === 'water' && this.game) {
        if (f - y > this.drop + EPS) return { why: 'drop', at, size: f - y, what: 'water' };
        return this.landing(x, z, y);
      }
      if (this.through(c, at) || c.k === 'rail') continue;
      const b = this.boxOf(c);
      if (!b) return this.no(c, at);
      const top = y + b.top;
      if (f - top > this.drop + EPS) return { why: 'drop', at: { x, y: y + 1, z }, size: f - top };
      return this.landing(x, z, top);
    }
    return { why: 'drop', at: { x, y: Math.floor(f + EPS), z }, size: this.depth(x, z, f) };
  }

  /** Where a step that comes to height `f` in a column stands, by this set's rules. */
  private landing(x: number, z: number, f: number): Stand | NoWay {
    const y = cellY(f), s = this.stand(x, y, z);
    return isStand(s) && Math.abs(s.f - f) > EPS ? { why: 'floor', at: { x, y, z }, what: 'no floor at the height it comes to' } : s;
  }

  /** How high the first place a body stands in a column is over `f` (the rise a refused step would have needed: "a rise of 4"). */
  private climb(x: number, z: number, f: number): number {
    for (let y = Math.floor(f + EPS) + 1; y <= Math.floor(f) + 16; y++) {
      const s = this.stand(x, y, z);
      if (isStand(s)) return s.f - f;
    }
    return 16;
  }

  /** How deep the first floor (or water) under `f` is in a column, to 24. */
  private depth(x: number, z: number, f: number): number {
    for (let y = Math.floor(f - EPS); y >= Math.floor(f) - 24; y--) {
      const c = this.v.cls(x, y, z), b = this.boxOf(c);
      if (c.k === 'water' || c.k === 'unread' || c.k === 'hazard') return f - y - (c.k === 'water' ? 0 : 1);
      if (b) return f - (y + b.top);
    }
    return 24;
  }
}

/** A rule set's walker over a view (`Blocks` made one). */
const walkerOf = (g: Blocks | View, set: RuleSet, o: WalkOpts, ...ys: number[]) => new Walker(g instanceof View ? g : View.of(g, ...ys), set, o);

/**
 * Where a body is (an entity's position, or a cell) as a stand of these rules: its cell, or one a block up or down
 * (an entity's height is its feet's, a cell's its own). `lenient`: where these rules have it nowhere, the game's
 * (the villager IS there, on a slab or a stair: the way from it is the lead rules' all the same).
 */
function resolve(w: Walker, p: Pos, lenient?: Walker): Stand | NoWay {
  const x = Math.floor(p.x), z = Math.floor(p.z), y0 = Math.floor(p.y + 0.25);
  let first: NoWay | undefined;
  for (const dy of [0, 1, -1, 2, -2]) {
    const s = w.stand(x, y0 + dy, z);
    if (isStand(s)) return s;
    first ??= s;
  }
  if (lenient) for (const dy of [0, 1, -1]) {
    const s = lenient.stand(x, y0 + dy, z);
    if (isStand(s)) return s;
  }
  return first!;
}

/**
 * Whether a villager stands with its feet in a cell by a rule set (section 4.2's table): its feet's height on the floor
 * when it does, why not when not.
 */
export function stand(g: Blocks, x: number, y: number, z: number, rules: RuleSet, o: WalkOpts = {}): Stand | NoWay {
  return walkerOf(g, rules, o, y).stand(x, y, z);
}

/** Where one step from `from` (a stand, or a cell resolved to one) toward (dx, dz) takes a villager by a rule set, or why it does not. */
export function step(g: Blocks, from: Stand | Pos, dx: number, dz: number, rules: RuleSet, o: WalkOpts = {}): Stand | NoWay {
  const w = walkerOf(g, rules, o, from.y);
  const n = 'f' in from ? from : resolve(w, from);
  return isStand(n) ? w.step(n, dx, dz) : n;
}

// ------------------------------------------------------------------------------------------------ ways

/** A circle across the ground kept out of (trip.avoid: someone's free job site, another village). */
export interface Circle { at: { x: number; z: number }; r: number; why?: string }
/** A free job-site block as sitesNear found it. */
export interface JobSite { at: Pos; name?: string }

/**
 * The free job sites a way keeps RIVAL_R off, and those it does not: the origin village's own inside its area (`home`:
 * it walks its daily ways there, and "home, with a job" is no loss), those lifted for the trip (4.5), those inside the
 * hall's box while its gate H reads shut, and a lure of this trip.
 */
export interface RivalOpts {
  sites?: readonly JobSite[];
  home?: Area;
  lifted?: readonly Pos[];
  hall?: { box: Area; shut: boolean };
  lures?: readonly Pos[];
}

export interface PathOpts extends WalkOpts {
  /** others' builds (foreign.zones; the origin village's own left out by the caller): every cell FROM_ZONES 16 or more off */
  zones?: readonly Zone[];
  /** circles every cell keeps out of */
  avoid?: readonly Circle[];
  /** boxes every cell keeps `d` off across the ground (the portal's ring: 5) */
  keep?: readonly (Area & { d: number; why: string })[];
  /** the search's bounds: path cells and nodes looked at (lead 36 / 600, game 48 / 768; false: none, a corridor) */
  limits?: { path: number; nodes: number } | false;
}

/** A way found: its cells (feet) from the first to the last, its length in steps, and the largest drop on it. */
export interface Path { ok: true; cells: Pos[]; len: number; drop: number }
export type NoPath = { ok: false } & NoWay;

/** The rival sites of RivalOpts as circles, the exempt ones left out. */
function rivalCircles(o: RivalOpts): Circle[] {
  const lifted = new Set((o.lifted ?? []).map(key)), lures = new Set((o.lures ?? []).map(key));
  return (o.sites ?? []).filter(s => !(o.home && inArea(o.home, s.at)) && !lifted.has(key(s.at)) && !lures.has(key(s.at))
    && !(o.hall?.shut && inArea(o.hall.box, s.at)))
    .map(s => ({ at: s.at, r: RIVAL_R, why: `a free ${s.name ?? 'job site'}` }));
}

/** The keep-offs of a way as one question of each stand: undefined where it may go. */
function keeperOf(o: PathOpts & RivalOpts): (s: Stand) => NoWay | undefined {
  const zones = o.zones ?? [], keep = o.keep ?? [];
  const circles = [...(o.avoid ?? []), ...rivalCircles(o)];
  if (!zones.length && !keep.length && !circles.length) return () => undefined;
  return s => {
    const p = { x: s.x + 0.5, y: s.f, z: s.z + 0.5 };
    for (const zn of zones) {
      if (zoneDistance(p, zn) < FROM_ZONES) return { why: 'zone', at: posOf(s), by: { x: zn.x1, y: zn.y1, z: zn.z1 }, what: `someone's build at x ${zn.x1}..${zn.x2}, z ${zn.z1}..${zn.z2}` };
    }
    for (const c of circles) {
      if (hdist(p, { x: Math.floor(c.at.x) + 0.5, z: Math.floor(c.at.z) + 0.5 }) < c.r) {
        return { why: 'rival', at: posOf(s), by: { x: c.at.x, y: (c.at as Pos).y ?? s.y, z: c.at.z }, what: c.why ?? 'a job site of someone\'s' };
      }
    }
    for (const b of keep) {
      if (Math.hypot(Math.max(0, b.x1 - p.x, p.x - b.x2 - 1), Math.max(0, b.z1 - p.z, p.z - b.z2 - 1)) < b.d) return { why: 'zone', at: posOf(s), what: b.why };
    }
    return undefined;
  };
}

/** A binary heap of node indices by their f. */
class Heap {
  private readonly a: { f: number; i: number }[] = [];
  get size() { return this.a.length; }
  push(f: number, i: number): void {
    const a = this.a;
    a.push({ f, i });
    for (let j = a.length - 1; j > 0;) {
      const p = (j - 1) >> 1;
      if (a[p].f <= a[j].f) break;
      [a[p], a[j]] = [a[j], a[p]];
      j = p;
    }
  }
  pop(): number {
    const a = this.a, top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let j = 0; ;) {
        const l = 2 * j + 1, r = l + 1;
        let m = j;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === j) break;
        [a[m], a[j]] = [a[j], a[m]];
        j = m;
      }
    }
    return top.i;
  }
}

/** What a search goes to: `done` for a stand; `h` a lower bound of the steps left from a column (0 for a test). */
interface Goal { done: (s: Stand) => boolean; h: (x: number, z: number) => number }

/** The steps across the ground between two columns at least (a diagonal step is one of 1.41). */
const octile = (dx: number, dz: number) => { const a = Math.abs(dx), b = Math.abs(dz); return Math.max(a, b) + (Math.SQRT2 - 1) * Math.min(a, b); };

/** The way's stands from the start, by the parents. */
function trace<T extends { s: Stand; parent: number }>(nodes: T[], i: number): Stand[] {
  const out: Stand[] = [];
  for (let j = i; j >= 0; j = nodes[j].parent) out.push(nodes[j].s);
  return out.reverse();
}

const pathOf = (stands: Stand[]): Path => {
  let drop = 0;
  for (let i = 1; i < stands.length; i++) drop = Math.max(drop, stands[i - 1].f - stands[i].f);
  return { ok: true, cells: stands.map(posOf), len: stands.length - 1, drop: Math.round(drop * 1e6) / 1e6 };
};

/**
 * A* over a walker's steps from `start` to `goal`, every stand kept off as `keep` says, within the limits. Not found:
 * why, read where the search came nearest: the refused step from there that would have gone furthest toward the goal
 * (a river's bank: water, and how wide; a cliff's foot: the rise; the edge of a rival's circle: the site), else 'far'.
 */
function aStar(w: Walker, start: Stand, goal: Goal, keep: (s: Stand) => NoWay | undefined, lim: { path: number; nodes: number } | false): Path | NoPath {
  const nodes: { s: Stand; g: number; steps: number; parent: number; closed: boolean }[] = [];
  const index = new Map<string, number>();
  const heap = new Heap();
  const kOf = (s: Stand) => `${s.x},${s.y},${s.z}`;
  nodes.push({ s: start, g: 0, steps: 0, parent: -1, closed: false });
  index.set(kOf(start), 0);
  heap.push(goal.h(start.x, start.z), 0);
  let best = 0, bestH = goal.h(start.x, start.z), looked = 0, cut = false;
  while (heap.size) {
    const i = heap.pop(), n = nodes[i];
    if (n.closed) continue;
    n.closed = true;
    if (goal.done(n.s)) return pathOf(trace(nodes, i));
    if (lim && ++looked > lim.nodes) { cut = true; break; }
    const h0 = goal.h(n.s.x, n.s.z);
    if (h0 < bestH - EPS) { best = i; bestH = h0; }
    if (lim && n.steps >= lim.path) { cut = true; continue; }
    for (const [dx, dz] of DIRS) {
      const t = w.step(n.s, dx, dz);
      if (!isStand(t) || keep(t)) continue;
      const k = kOf(t), g = n.g + (dx && dz ? Math.SQRT2 : 1) + (w.game && w.v.cls(t.x, t.y, t.z).k === 'water' ? WATER_COST : 0);
      const j = index.get(k);
      if (j !== undefined && (nodes[j].closed || nodes[j].g <= g + EPS)) continue;
      if (j === undefined) { index.set(k, nodes.length); nodes.push({ s: t, g, steps: n.steps + 1, parent: i, closed: false }); heap.push(g + goal.h(t.x, t.z), nodes.length - 1); }
      else { Object.assign(nodes[j], { s: t, g, steps: n.steps + 1, parent: i }); heap.push(g + goal.h(t.x, t.z), j); }
    }
  }
  // (why not: from where it came nearest, the refused step that went furthest toward the goal)
  const b = nodes[best].s;
  let why: NoWay | undefined, whyH = Infinity;
  for (const [dx, dz] of DIRS) {
    const t = w.step(b, dx, dz), no = isStand(t) ? keep(t) : t;
    if (!no) continue;
    const h = goal.h(b.x + dx, b.z + dz);
    if (h < whyH - EPS) { why = no; whyH = h; }
  }
  if (why && whyH < bestH - EPS) {
    if (why.why === 'water') why = { ...why, size: wide(w, b, why.at) };
    return { ok: false, ...why };
  }
  return { ok: false, why: 'far', at: posOf(b), what: cut && lim ? `no way within ${lim.path} cells and ${lim.nodes} nodes` : 'no way' };
}

/** How many columns of water lie on from a bank, the way from `b` to the first of them (to 64). */
function wide(w: Walker, b: Stand, at: Pos): number {
  const dx = Math.sign(at.x - b.x), dz = Math.sign(at.z - b.z);
  let n = 0;
  for (let i = 1; i <= 64; i++) {
    const x = b.x + dx * i, z = b.z + dz * i;
    let wet = false;
    for (let y = b.y; y >= b.y - 3; y--) {
      const c = w.v.cls(x, y, z);
      if (c.k === 'water') { wet = true; break; }
      if (c.k !== 'air') break;
    }
    if (!wet) break;
    n++;
  }
  return Math.max(1, n);
}

/**
 * Every stand a walker reaches from the starts in `max` steps or fewer (a step is a step, a diagonal too), kept off as
 * `keep` says and inside `within`: each with its steps and the stand it came from, the starts first.
 */
function flood(w: Walker, starts: readonly Stand[], max: number, keep: (s: Stand) => NoWay | undefined = () => undefined,
  within: (s: Stand) => boolean = () => true, cap = 30_000): { nodes: { s: Stand; d: number; parent: number }[]; index: Map<string, number> } {
  const nodes: { s: Stand; d: number; parent: number }[] = [];
  const index = new Map<string, number>();
  for (const s of starts) {
    const k = `${s.x},${s.y},${s.z}`;
    if (index.has(k)) continue;
    index.set(k, nodes.length);
    nodes.push({ s, d: 0, parent: -1 });
  }
  for (let i = 0; i < nodes.length && nodes.length < cap; i++) {
    const n = nodes[i];
    if (n.d >= max) continue;
    for (const [dx, dz] of DIRS) {
      const t = w.step(n.s, dx, dz);
      if (!isStand(t)) continue;
      const k = `${t.x},${t.y},${t.z}`;
      if (index.has(k) || keep(t) || !within(t)) continue;
      index.set(k, nodes.length);
      nodes.push({ s: t, d: n.d + 1, parent: i });
    }
  }
  return { nodes, index };
}

const DEFAULT_LIMITS: Record<RuleSet, { path: number; nodes: number }> = { lead: { path: HOP_PATH, nodes: HOP_NODES }, game: { path: GAME_PATH, nodes: GAME_NODES } };

/** A goal of cells (each resolved to the stand in its column nearest its height), or of a test. */
function goalOf(w: Walker, to: Pos | readonly Pos[] | ((c: Pos) => boolean), lenient?: Walker): Goal {
  if (typeof to === 'function') return { done: s => to(posOf(s)), h: () => 0 };
  const cells = (Array.isArray(to) ? to : [to as Pos]).map(p => {
    const s = resolve(w, p, lenient);
    return isStand(s) ? { x: s.x, y: s.y, z: s.z, tol: 0 } : { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), tol: 2 };
  });
  return {
    done: s => cells.some(c => c.x === s.x && c.z === s.z && Math.abs(c.y - s.y) <= c.tol),
    h: (x, z) => Math.min(...cells.map(c => octile(c.x - x, c.z - z)))
  };
}

/**
 * The villager's way from `from` (where it stands: a stand of the game's where the lead rules have none, a slab, a
 * stair) to `to` (a cell, any of some cells, or a test of a cell) by a rule set (4.2): every cell kept off others' builds
 * (`zones`, FROM_ZONES), out of the `avoid` circles and `keep` boxes, within the limits (the lead rules' by default 36
 * cells and 600 nodes, well inside the game's 48 and 768; `limits: false` for a corridor). Found: its cells and the
 * largest drop on it; else why not and where (the place nearest the goal it could not pass).
 */
export function pathFor(g: Blocks, from: Pos, to: Pos | readonly Pos[] | ((c: Pos) => boolean), rules: RuleSet, o: PathOpts & RivalOpts = {}): Path | NoPath {
  const ys = [from.y, ...(typeof to === 'function' ? [] : Array.isArray(to) ? to.map(p => p.y) : [(to as Pos).y])];
  const v = View.of(g, ...ys), w = new Walker(v, rules, o), game = rules === 'game' ? w : new Walker(v, 'game', { open: o.open });
  return pathIn(w, game, from, to, o);
}

function pathIn(w: Walker, game: Walker, from: Pos, to: Pos | readonly Pos[] | ((c: Pos) => boolean), o: PathOpts & RivalOpts): Path | NoPath {
  const start = resolve(w, from, game);
  if (!isStand(start)) return { ok: false, ...start };
  const limits = o.limits === undefined ? DEFAULT_LIMITS[w.set] : o.limits;
  return aStar(w, start, goalOf(w, to, game), keeperOf(o), limits);
}

/** A way's refusal in words, for the log and `site.fetch.why`: "a rise of 4 at (x, y, z)", "water 9 wide at ...". */
export function wayText(n: NoWay): string {
  const at = fmt(n.at), size = n.size !== undefined ? Math.round(n.size * 10) / 10 : undefined;
  switch (n.why) {
    case 'rise': return size !== undefined ? `a rise of ${size} at ${at}` : `${n.what ?? 'a block'} in the way at ${at}`;
    case 'drop': return `a drop of ${size ?? 'more than 3'} at ${at}`;
    case 'water': return `water ${size ?? 1} wide at ${at}`;
    case 'fence': return `${n.what ?? 'a fence'} at ${at}`;
    case 'floor': return `no floor a villager is counted on to walk (${n.what ?? 'not a full block'}) at ${at}`;
    case 'hazard': return `${n.what ?? 'what hurts'} by the way at ${at}`;
    case 'unread': return `ground not read at ${at}`;
    case 'zone': return n.by ? `${n.what ?? 'someone\'s build'} within ${FROM_ZONES} of every way, at ${at}` : `${n.what ?? 'kept off'} at ${at}`;
    case 'rival': return `${n.what ?? 'a job site of someone\'s'} at ${n.by ? fmt(n.by) : at} within ${RIVAL_R} of every way`;
    case 'far': return `${n.what ?? 'no way'} from ${at}`;
  }
}

// ------------------------------------------------------------------------------------------------ the game's way beside the lead's

/** Whether the game's moves by a way are the lead's own; else the first that is not: the stand it came from, where it went, what it is. */
export type Same = { ok: true } | { ok: false; at: Pos; from: Pos; what: string };

/**
 * sameWay (4.2): every cell the game's rules reach within 2 steps of the lead's way (a flood of 2 from each of its
 * cells) is a cell the lead rules stand in, reached by the lead rules' own step. Deterministic, with no path of the
 * game's in it: it refuses the bench by the pavilion's fence (a stair's top is the game's floor, not the lead's: the
 * villager wedged there on Nov 24) and passes a plain lamp post (no game step onto a post's top without a block beside
 * it). `skip`: cells of the way not asked (a gate's own lane, the cells before the lock).
 */
export function sameWay(g: Blocks, path: readonly Pos[], o: WalkOpts & { skip?: (c: Pos) => boolean } = {}): Same {
  const v = View.of(g, ...path.map(p => p.y));
  return sameIn(new Walker(v, 'lead', { open: o.open, yard: o.yard }), new Walker(v, 'game', { open: o.open }), path, o.skip);
}

function sameIn(lead: Walker, game: Walker, path: readonly Pos[], skip?: (c: Pos) => boolean): Same {
  const depth = new Map<string, number>();
  const queue: { s: Stand; d: number }[] = [];
  for (const p of path) {
    if (skip?.(p)) continue;
    const s = resolve(lead, p, game);
    if (!isStand(s)) continue;
    const k = `${s.x},${s.y},${s.z}`;
    if ((depth.get(k) ?? 9) <= 0) continue;
    depth.set(k, 0);
    queue.push({ s, d: 0 });
  }
  for (let i = 0; i < queue.length; i++) {
    const { s, d } = queue[i];
    for (const [dx, dz] of DIRS) {
      const t = game.step(s, dx, dz);
      if (!isStand(t)) continue;
      const l = lead.step(s, dx, dz);
      if (!isStand(l) || l.x !== t.x || l.y !== t.y || l.z !== t.z || Math.abs(l.f - t.f) > EPS) {
        const what = !isStand(l) ? `the game goes where the lead rules do not: ${wayText(l)}` : `the game comes down at ${t.y}, the lead rules at ${l.y}`;
        return { ok: false, at: posOf(t), from: posOf(s), what };
      }
      if (d + 1 >= 2) continue;
      const k = `${t.x},${t.y},${t.z}`;
      if ((depth.get(k) ?? 9) <= d + 1) continue;
      depth.set(k, d + 1);
      queue.push({ s: t, d: d + 1 });
    }
  }
  return { ok: true };
}

/**
 * trapNear (4.2): a cell the game's rules reach within `r` of a lure at `at`, from the cells it is worked from, that
 * they find no way back from: a pit, a hollow behind a 2-3 high lip (villager 2 spent nine days at the bottom of a
 * sinkhole with two cows and a sheep, Nov 24), a 1 x 1 hole 2 deep. An employed villager strolls about 9 from its
 * block. Undefined: none. The way back may run 6 further out than `r`.
 */
export function trapNear(g: Blocks, at: Pos, r = TRAP_R, o: WalkOpts = {}): Pos | undefined {
  return trapIn(new Walker(View.of(g, at.y), 'game', { open: o.open }), at, r);
}

function trapIn(game: Walker, at: Pos, r: number): Pos | undefined {
  const mid = { x: at.x + 0.5, z: at.z + 0.5 };
  const starts = reachIn(game, at);
  if (!starts.length) return undefined;
  const out = r + 6;
  const near = (s: Stand) => hdist({ x: s.x + 0.5, z: s.z + 0.5 }, mid) <= out;
  const { nodes, index } = flood(game, starts, 4 * out, undefined, near, 12_000);
  // (the way back: which of them reach a start, over the steps the flood found, turned round)
  const back: number[][] = nodes.map(() => []);
  nodes.forEach((n, i) => {
    for (const [dx, dz] of DIRS) {
      const t = game.step(n.s, dx, dz);
      if (!isStand(t)) continue;
      const j = index.get(`${t.x},${t.y},${t.z}`);
      if (j !== undefined) back[j].push(i);
    }
  });
  const home = new Array<boolean>(nodes.length).fill(false);
  const queue: number[] = [];
  nodes.forEach((n, i) => { if (n.d === 0) { home[i] = true; queue.push(i); } });
  for (let q = 0; q < queue.length; q++) for (const i of back[queue[q]]) if (!home[i]) { home[i] = true; queue.push(i); }
  let trap: { at: Pos; d: number } | undefined;
  nodes.forEach((n, i) => {
    if (home[i]) return;
    const d = hdist({ x: n.s.x + 0.5, z: n.s.z + 0.5 }, mid);
    if (d <= r && (!trap || d < trap.d)) trap = { at: posOf(n.s), d };
  });
  return trap?.at;
}

/**
 * reachCells (4.2): where a villager works a job-site block from (the game's reach is Manhattan 1 [B]): the cells
 * sharing a face with it at its own level, and its top, each a stand of the rules. Ask it of the ground with the block
 * standing there (withBlock).
 */
export function reachCells(g: Blocks, block: Pos, rules: RuleSet = 'lead', o: WalkOpts = {}): Pos[] {
  return reachIn(new Walker(View.of(g, block.y), rules, o), block).map(posOf);
}

function reachIn(w: Walker, b: Pos): Stand[] {
  return [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].map(([dx, dy, dz]) => w.stand(b.x + dx, b.y + dy, b.z + dz)).filter(isStand);
}

/** Whether a thin block (fence, gate, stairs, a slab not on top, bed, chest...) shares a face with a cell. */
function thinBeside(v: View, c: Pos): boolean {
  return [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]].some(([dx, dy, dz]) => thinCell(v.cls(c.x + dx, c.y + dy, c.z + dz)));
}

/** What hurts within SPOT_HURT of a spot, any way. */
const hurtNear = (v: View, s: Pos, r = SPOT_HURT) => v.hurts(s.x, s.z, r, s.y - r, s.y + r);

/**
 * botStand (4.2): where the bot stands to put a lure down at `at` and take it up again: a cell the lead rules stand in,
 * 2 or 3 from it (Chebyshev, across the ground), beyond it from where the ward comes (`path`'s first cell), not where
 * it works the lure from and not on its way, from which dig.here sees a face of the lure (`seesFace`, the bridge's own
 * sight) and the place's first click (the floor's top) is within 4.5 of the eye, and a lead way of BOT_WALK or fewer
 * from `from` (where the bot is now) reaches. Ask it of the ground with the lure standing there; the bot's walk is
 * asked of it as it is before the lure goes down (the bot walks there first). None: the spot is refused (a careful
 * walk that does not arrive is a miss, never a plain walk).
 */
export function botStand(g: Blocks, at: Pos, path: readonly Pos[], from: Pos, o: WalkOpts = {}): Pos | undefined {
  const v = View.of(g, at.y, from.y), before = v.with(at, 'air');
  const lead = new Walker(before, 'lead', { open: o.open, yard: o.yard });
  return botIn(lead, v, at, path, botWalk(lead, from));
}

/** The bot's own walk from where it is, as far as BOT_WALK: the stands it reaches, by the lead rules (nothing kept off: it is the bot). */
function botWalk(lead: Walker, from: Pos): Set<string> {
  const s = resolve(lead, from, new Walker(lead.v, 'game', lead.o));
  if (!isStand(s)) return new Set();
  return new Set(flood(lead, [s], BOT_WALK).nodes.map(n => `${n.s.x},${n.s.y},${n.s.z}`));
}

function botIn(lead: Walker, lure: View, at: Pos, path: readonly Pos[], walk: Set<string>): Pos | undefined {
  const ward = path[0] ?? at;
  const dir = { x: at.x - ward.x, z: at.z - ward.z };
  const onPath = new Set(path.map(key));
  const reach = new Set([[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].map(([dx, dy, dz]) => key({ x: at.x + dx, y: at.y + dy, z: at.z + dz })));
  const floor = { x: at.x + 0.5, y: at.y, z: at.z + 0.5 };
  const cells: { s: Stand; ring: number; ahead: number }[] = [];
  for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
    const ring = Math.max(Math.abs(dx), Math.abs(dz));
    if (ring < 2) continue;
    const ahead = dx * dir.x + dz * dir.z;
    if (ahead <= 0 && (dir.x || dir.z)) continue;
    for (let dy = -2; dy <= 2; dy++) {
      const s = lead.stand(at.x + dx, at.y + dy, at.z + dz);
      if (isStand(s)) cells.push({ s, ring, ahead });
    }
  }
  cells.sort((a, b) => a.ring - b.ring || b.ahead - a.ahead || Math.abs(a.s.y - at.y) - Math.abs(b.s.y - at.y));
  for (const { s } of cells) {
    const c = posOf(s), k = key(c);
    if (onPath.has(k) || reach.has(k) || !walk.has(k)) continue;
    if (Math.hypot(floor.x - (c.x + 0.5), floor.y - (s.f + EYE), floor.z - (c.z + 0.5)) > PLACE_REACH) continue;
    if (!seesFace(lure, c, at)) continue;
    return c;
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------ hop spots

/** What a lure is put into (Interact.java replaceable: air, or the game's canBeReplaced; a flower or a torch is not). */
const REPLACEABLE = /^(air|cave_air|void_air|light|short_grass|fern|dead_bush|bush|short_dry_grass|tall_dry_grass|tall_grass|large_fern|vine|glow_lichen)$/;
const isReplaceable = (state: string | null | undefined) =>
  !!state && (REPLACEABLE.test(idOf(state)) || (idOf(state) === 'snow' && Number(propsOf(state).layers ?? 1) <= 1));
/** The yard's own floors a lure goes on: its lawn at the ground's level (or the bot's walk there, recorded or a stray kind). */
const LAWN = /^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|mycelium|moss_block|gravel|sand|red_sand)$/;
const LURE = 'fletching_table';

export interface HopOpts extends PathOpts, RivalOpts {
  /** where the bot stands now: it walks to its standing cell by the lead rules, BOT_WALK at most */
  bot: Pos;
  /** cells a lure of this trip stood in, and when (ms, with `now`): none goes down again within REUSE_MS */
  used?: readonly { at: Pos; t: number }[];
  now?: number;
  /** the hop's aim: HOP_LEN (the short hop after none: 11; a yard hop 16); a spot is 2 further at most */
  len?: number;
}

/** A hop's lure and everything about it: where it goes, where the ward takes it from and its way there, where the bot stands. */
export interface HopSpot {
  block: Pos;
  reach: Pos;
  botStand: Pos;
  /** the ward's way to `reach`, its cells by the lead rules */
  path: Pos[];
  /** the largest drop on that way: over 1 the trip is committed ('drop'): it cannot walk back up */
  drop: number;
}

/** The questions of a spot that need no way (the first lure asks two more): undefined where they all pass, else why not. */
function spotWhy(v: View, s: Stand, o: HopOpts, first?: { marks: readonly Pos[]; clear: number }): string | undefined {
  const at = posOf(s), state = v.state(at.x, at.y, at.z), under = { ...at, y: at.y - 1 }, fl = v.cls(under.x, under.y, under.z);
  if (!isReplaceable(state)) return `${state ? idOf(state) : 'a cell not read'} is no cell a block goes into`;
  if (fl.k !== 'solid' || fl.floor !== 'full' || fl.bottom > EPS || Math.abs(s.f - at.y) > EPS) return `no full block under it (${nameOf(fl)})`;
  if (o.yard && inArea(o.yard, at) && !(under.y === o.yard.y && (LAWN.test(fl.id) || STRAY.test(fl.id) || (o.yard.built ?? []).some(b => same(b, under))))) {
    return `in the yard off its lawn and walks (${fl.id} at ${under.y})`;
  }
  if ((o.used ?? []).some(u => same(u.at, at) && (o.now === undefined || o.now - u.t < REUSE_MS))) return 'a lure stood there in the last 20 s';
  const h = hurtNear(v, at);
  if (h) return `${h.what} within ${SPOT_HURT} at ${fmt(h.at)}`;
  if (first) {
    const m = first.marks.find(p => Math.max(Math.abs(p.x - at.x), Math.abs(p.y - at.y), Math.abs(p.z - at.z)) <= first.clear);
    if (m) return `a village's mark within ${first.clear} at ${fmt(m)}`;
    for (let y = at.y + 1; y <= v.top(); y++) {
      const c = v.cls(at.x, y, at.z);
      if (c.k !== 'air' && c.k !== 'unread') return `${nameOf(c)} over it at ${y}`;
    }
  }
  return undefined;
}

/** The rest of a spot's questions, with the lure standing there: a reach cell, the ward's way to it, sameWay, no trap, the bot's cell. */
function spotWith(base: View, wl: { lead: Walker; plain: Walker; game: Walker }, s: Stand, from: Stand, o: HopOpts, walk: Set<string>,
  lim: { path: number; nodes: number }, keep: (s: Stand) => NoWay | undefined): HopSpot | string {
  const at = posOf(s), lure = base.with(at, LURE);
  const lead = new Walker(lure, 'lead', wl.lead.o);
  const reach = reachIn(lead, at).filter(r => !keep(r) && !thinBeside(lure, posOf(r)));
  if (!reach.length) return 'no cell to take it from with no thin block beside it';
  const way = aStar(lead, from, { done: t => reach.some(r => r.x === t.x && r.y === t.y && r.z === t.z), h: (x, z) => Math.min(...reach.map(r => octile(r.x - x, r.z - z))) }, keep, lim);
  if (!way.ok) return `no way to it within ${lim.path} cells and ${lim.nodes} nodes: ${wayText(way)}`;
  const inHome = !!o.home && [at, ...way.cells].every(c => inArea(o.home!, c));
  if (!inHome) {
    const same = sameIn(wl.plain, wl.game, way.cells);
    if (!same.ok) return `the game's way leaves the lead's by ${fmt(same.from)}: ${same.what}`;
  }
  const trap = trapIn(wl.game, at, TRAP_R);
  if (trap) return `a trap within ${TRAP_R} at ${fmt(trap)}`;
  const bot = botIn(wl.plain, lure, at, way.cells, walk);
  if (!bot) return 'no cell for the bot to stand in, see it from and walk to';
  return { block: at, reach: way.cells[way.cells.length - 1], botStand: bot, path: way.cells, drop: way.drop };
}

/** How many spots are asked the questions with a way in them, at most (each a search, a flood or two). */
const SPOTS_TRIED = 40;

/**
 * hopSpot (4.2): the next lure, from where the ward STANDS toward `toward` (the corridor's next waypoint): the cell
 * farthest along the ward's lead way (36 cells, 600 nodes at most) within HOP_MAX straight (aim HOP_LEN, `len`) and
 * HOP_MIN or more nearer `toward`, such that the lure goes into it on a full block (not a path block or farmland: a
 * block set on them turns them to dirt; in the yard on its lawn or walk), with a cell the ward takes it from with no
 * thin block beside it, the bot's cell (botStand), sameWay (from the first hop whose way leaves the origin village's
 * area, `home`), no trap within TRAP_R, nothing that hurts within 4, the spot and every cell of the way FROM_ZONES off
 * others' builds, out of the `avoid` circles, and RIVAL_R off every free job site but the exempt ones (RivalOpts), and
 * not a cell a lure stood in within 20 s. `retrace` (the trip not committed): a way with no drop the ward cannot climb
 * back first; only when there is none, any: a `drop` deeper than RETRACE_DROP then says the trip is committed.
 */
export function hopSpot(g: Blocks, ward: Pos, toward: { x: number; z: number }, o: HopOpts): HopSpot | { why: string } {
  const base = View.of(g, ward.y, o.bot.y);
  const plain = new Walker(base, 'lead', { open: o.open, yard: o.yard }), game = new Walker(base, 'game', { open: o.open });
  const walk = botWalk(plain, o.bot);
  const passes = o.retrace ? [true, false] : [false];
  let why = '';
  for (const retrace of passes) {
    const lead = retrace ? new Walker(base, 'lead', { open: o.open, yard: o.yard, retrace: true }) : plain;
    const r = hopIn(base, { lead, plain, game }, ward, toward, o, walk);
    if (!('why' in r)) return r;
    why = r.why;
  }
  return { why };
}

function hopIn(base: View, wl: { lead: Walker; plain: Walker; game: Walker }, ward: Pos, toward: { x: number; z: number }, o: HopOpts, walk: Set<string>): HopSpot | { why: string } {
  const from = resolve(wl.lead, ward, wl.game);
  if (!isStand(from)) return { why: `the ward stands nowhere a way starts: ${wayText(from)}` };
  const keep = keeperOf(o);
  const no = keep(from);
  if (no) return { why: `where the ward stands: ${wayText(no)}` };
  const aim = o.len ?? HOP_LEN, max = aim + HOP_MAX - HOP_LEN;
  const goal = midOf(toward), w0 = { x: from.x + 0.5, y: from.f, z: from.z + 0.5 }, t0 = hdist(w0, goal);
  const { nodes } = flood(wl.lead, [from], HOP_PATH, keep);
  // (progress to the hundredth: two cells as far on are one, and the shorter way to it goes first)
  const spots = nodes.filter(n => n.d > 0).map(n => {
    const c = { x: n.s.x + 0.5, y: n.s.f, z: n.s.z + 0.5 };
    return { n, progress: t0 - hdist(c, goal), straight: Math.hypot(c.x - w0.x, c.y - w0.y, c.z - w0.z) };
  }).filter(c => c.straight <= max + EPS && c.progress >= HOP_MIN - EPS)
    .sort((a, b) => Math.round(100 * Math.min(b.progress, aim)) - Math.round(100 * Math.min(a.progress, aim)) || a.n.d - b.n.d);
  if (!spots.length) return { why: `no cell ${HOP_MIN} nearer (${Math.round(toward.x)}, ${Math.round(toward.z)}) within ${max} of ${fmt(posOf(from))} on the ward's way` };
  let tried = 0, first = '';
  for (const c of spots) {
    const local = spotWhy(base, c.n.s, o);
    if (local) { first ||= `${fmt(posOf(c.n.s))}: ${local}`; continue; }
    if (++tried > SPOTS_TRIED) break;
    const r = spotWith(base, wl, c.n.s, from, o, walk, { path: HOP_PATH, nodes: HOP_NODES }, keep);
    if (typeof r !== 'string') return r;
    first ||= `${fmt(posOf(c.n.s))}: ${r}`;
  }
  return { why: `no hop spot toward (${Math.round(toward.x)}, ${Math.round(toward.z)}): ${spots.length} cell(s) looked at, the best ${first}` };
}

/**
 * The first lure, L0 (4.1): the hop spot nearest the corridor's start (`start`) within FIRST_PATH lead path cells of a
 * candidate (any of them: whoever flips is the ward), with no mark of a village's (foreign.marks, any kind) within 3 of
 * it, or within 1 where no cell has 3 (a dense village centre), and nothing over it to the band's top. Where no
 * candidate has a way by the model (indoors, upstairs: it knows no house), an open spot 12-32 straight from the
 * candidate nearest `start`, on `start`'s side of it, with the same questions but the way (`open`): the game is the
 * judge (live, a villager 23 off and 6 up, indoors, set off within 1 s, Nov 24). `from`: the candidate whose way it is.
 */
export function firstSpot(g: Blocks, candidates: readonly Pos[], start: { x: number; z: number }, o: HopOpts & { marks?: readonly Pos[]; path?: number; level?: boolean }):
  (HopSpot & { from?: Pos; open?: true }) | { why: string } {
  // (`path`: the flood's reach from the candidates, FIRST_PATH unless the first lure asks nearer; `level`: on the
  // candidate's own level only, 4.1's spot nearer the nearest after nobody came)
  const reach = o.path ?? FIRST_PATH;
  const base = View.of(g, o.bot.y, ...candidates.map(c => c.y));
  const plain = new Walker(base, 'lead', { open: o.open, yard: o.yard }), game = new Walker(base, 'game', { open: o.open });
  const walk = botWalk(plain, o.bot);
  const keep = keeperOf(o), marks = o.marks ?? [];
  let why = '';
  for (const retrace of o.retrace ? [true, false] : [false]) {
    const lead = retrace ? new Walker(base, 'lead', { open: o.open, yard: o.yard, retrace: true }) : plain;
    const wl = { lead, plain, game };
    const froms = candidates.map(c => resolve(lead, c, game)).filter(isStand).filter(s => !keep(s));
    if (!froms.length) { why = 'no candidate stands where a way starts'; continue; }
    const { nodes } = flood(lead, froms, reach, keep);
    const home = midOf(start), mid = (s: Stand) => ({ x: s.x + 0.5, z: s.z + 0.5 });
    const spots = nodes.filter(n => n.d > 0).sort((a, b) => hdist(mid(a.s), home) - hdist(mid(b.s), home) || a.d - b.d);
    for (const clear of [3, 1]) {
      let tried = 0;
      for (const n of spots) {
        let root = n;
        while (root.parent >= 0) root = nodes[root.parent];
        if (o.level && n.s.y !== root.s.y) continue;
        const local = spotWhy(base, n.s, o, { marks, clear });
        if (local) { why ||= `${fmt(posOf(n.s))}: ${local}`; continue; }
        if (++tried > SPOTS_TRIED) break;
        const r = spotWith(base, wl, n.s, root.s, o, walk, { path: reach, nodes: HOP_NODES }, keep);
        if (typeof r !== 'string') return { ...r, from: posOf(root.s) };
        why ||= `${fmt(posOf(n.s))}: ${r}`;
      }
    }
  }
  // no way from any candidate by the model: an open spot near the nearest, on the home side
  const nearest = [...candidates].sort((a, b) => hdist(a, start) - hdist(b, start))[0];
  if (!nearest) return { why: 'no candidate' };
  const near = midOf(nearest), home = midOf(start), mid = (s: Stand) => ({ x: s.x + 0.5, z: s.z + 0.5 });
  const { nodes } = flood(plain, [resolve(plain, o.bot, game)].filter(isStand), 64, keep);
  const open = nodes.map(n => n.s).filter(s => {
    const d = hdist(mid(s), near);
    return d >= 12 - EPS && d <= 32 + EPS && hdist(mid(s), home) < hdist(near, home);
  }).sort((a, b) => hdist(mid(a), near) - hdist(mid(b), near));
  for (const clear of [3, 1]) {
    for (const s of open) {
      if (spotWhy(base, s, o, { marks, clear })) continue;
      const at = posOf(s), lure = base.with(at, LURE);
      const reach = reachIn(new Walker(lure, 'lead', plain.o), at).filter(r => !thinBeside(lure, posOf(r))).sort((a, b) => hdist(mid(a), near) - hdist(mid(b), near));
      if (!reach.length || trapIn(game, at, TRAP_R)) continue;
      const bot = botIn(plain, lure, at, [{ x: Math.floor(nearest.x), y: Math.floor(nearest.y), z: Math.floor(nearest.z) }], walk);
      if (bot) return { block: at, reach: posOf(reach[0]), botStand: bot, path: [], drop: 0, open: true };
    }
  }
  return { why: `no first lure: ${why || 'no cell within reach of a candidate'}; no open spot 12-32 from ${fmt({ x: Math.floor(nearest.x), y: Math.floor(nearest.y), z: Math.floor(nearest.z) })} either` };
}

// ------------------------------------------------------------------------------------------------ the corridor and the yard's way

/** The way home planned whole: its waypoints (every HOP_LEN cells, the last the gate's outer cell), its length and cells. */
export interface Corridor { ok: true; waypoints: Pos[]; len: number; cells: Pos[]; drop: number }

/**
 * corridor (4.2): the lead rules' way from the candidates' side of the village (`from`) to the yard gate's outer cell,
 * over the band read on the way out, with no limits, kept off as a hop is (zones, the avoid circles, the rival sites);
 * sampled every HOP_LEN cells for the hops' waypoints. None: the first place no way exists, in words ("a rise of 4 at
 * ...", "water 9 wide at ...", "a free cauldron at ... within 56 of every way"): on water, a rise or a drop SURVEY
 * reads one more band to each side of it and asks once more (the bot swims and climbs where a villager needs the
 * ford 30 aside).
 */
export function corridor(g: Blocks, from: Pos, gate: Pos, o: PathOpts & RivalOpts = {}): Corridor | (NoPath & { text: string }) {
  const r = pathFor(g, from, gate, 'lead', { ...o, limits: false });
  if (!r.ok) return { ...r, text: wayText(r) };
  // (a sample fewer than HOP_MIN short of the end is no hop of its own)
  const end = r.cells.length - 1;
  const waypoints = r.cells.filter((_, i) => i > 0 && (i === end || (i % HOP_LEN === 0 && end - i >= HOP_MIN)));
  return { ok: true, waypoints, len: r.len, cells: r.cells, drop: r.drop };
}

/**
 * gateLane (4.2): a yard gate's lane, the feet and head cells from 3 outside to 6 inside, outside first: what PREP
 * reads 2 high (the south gate's had the bot's cobblestone at head height one out and a pile two out, Nov 24) and what
 * the yard's way does not ask sameWay of (the gate's own posts, the bank outside).
 */
export function gateLane(gate: Pos, side: HomeSide): Pos[] {
  const [dx, dz] = SIDE_STEP[side];
  const out: Pos[] = [];
  for (let n = 3; n >= -6; n--) for (const dy of [0, 1]) out.push({ x: gate.x + n * dx, y: gate.y + dy, z: gate.z + n * dz });
  return out;
}

export interface YardWayOpts extends WalkOpts {
  /** the portal's ring (its zone's box): the way keeps 5 off its fence */
  ring?: Area;
}
export type YardWay = { ok: true; cells: Pos[]; len: number; drop: number; reach: Pos } | { ok: false; at: Pos; text: string; why?: Why };

/** How far the yard's way keeps from the portal's ring. */
const RING_OFF = 5;

/**
 * yardWay (4.2): the ward's way across the yard from a gate's inner cell to where it takes the lure at S_out, the gate
 * held open, the lock's and the hall's gates shut, 5 off the portal's ring, with sameWay over it but for the gate's lane
 * and the three cells before S_out (the gate's own posts, the lock's gate and sill). Inside the yard's box the bot's
 * unrecorded scaffold is no floor (`yard`). PREP asks it of each gate: the shortest is the trip's.
 */
export function yardWay(g: Blocks, gate: Pick<YardGate, 'gate' | 'side' | 'inner'>, sOut: Pos, o: YardWayOpts = {}): YardWay {
  const open = [gate.gate, ...(o.open ?? [])];
  const base = View.of(g, gate.gate.y, sOut.y), lure = base.with(sOut, LURE);
  const lead = new Walker(lure, 'lead', { open, yard: o.yard }), game = new Walker(lure, 'game', { open });
  const reach = reachIn(lead, sOut).filter(r => r.y === sOut.y);
  if (!reach.length) return { ok: false, at: sOut, text: `no cell to take a lure at S_out ${fmt(sOut)} from` };
  const keep = o.ring ? [{ ...o.ring, d: RING_OFF, why: `${RING_OFF} off the portal's ring` }] : [];
  const r = pathIn(lead, game, gate.inner, reach.map(posOf), { open, yard: o.yard, keep, limits: false });
  if (!r.ok) return { ok: false, at: r.at, why: r.why, text: wayText(r) };
  const lane = new Set(gateLane(gate.gate, gate.side).filter(c => c.y === gate.gate.y).map(c => `${c.x},${c.z}`));
  const last = new Set(r.cells.slice(-3).map(key));
  const same = sameIn(new Walker(base, 'lead', { open, yard: o.yard }), new Walker(base, 'game', { open }), r.cells,
    c => lane.has(`${c.x},${c.z}`) || last.has(key(c)));
  if (!same.ok) return { ok: false, at: same.at, text: `the game's way leaves the lead's by ${fmt(same.from)}: ${same.what}` };
  return { ok: true, cells: r.cells, len: r.len, drop: r.drop, reach: r.cells[r.cells.length - 1] };
}
