import { parse } from '../diff.js';
import { itemOf } from '../../brain/blueprints.js';
import { placerFacing } from '../../schematic.js';
import { AIR, CLEAR, FLOOR, PASSABLE, REPLACEABLE, SUPPORT, idOf, isScaffold, type P, type Voxels } from './world.js';

/**
 * How the bot puts each kind of block in place, as the mod's calls do it: the sides of the target it may click against,
 * where on the face it clicks, which way it looks, the cells that must be free with it, and how far it reaches. The
 * slicer plans with these and the simulator checks plans with these, so a plan that passes matches what the mod does.
 */

export type Dir = 'down' | 'up' | 'north' | 'south' | 'east' | 'west';
export const STEP: Record<Dir, P> = {
  down: { x: 0, y: -1, z: 0 }, up: { x: 0, y: 1, z: 0 }, north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 }, east: { x: 1, y: 0, z: 0 }, west: { x: -1, y: 0, z: 0 }
};
export const OPP: Record<Dir, Dir> = { down: 'up', up: 'down', north: 'south', south: 'north', east: 'west', west: 'east' };
const SIDES: Dir[] = ['north', 'south', 'east', 'west'];
const ALL: Dir[] = ['down', 'north', 'south', 'east', 'west', 'up'];
export const toward = (p: P, d: Dir, n = 1): P => ({ x: p.x + STEP[d].x * n, y: p.y + STEP[d].y * n, z: p.z + STEP[d].z * n });

/** Planning reach: vanilla survival is 4.5 (the mod refuses beyond it), less a margin for where the bot really stops. */
export const REACH = 4.3;
export const EYE = 1.62;
export interface V3 { x: number; y: number; z: number }
export const eyeOf = (feet: P): V3 => ({ x: feet.x + 0.5, y: feet.y + EYE, z: feet.z + 0.5 });
export const dist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** The bot's own two cells (it can't place into them, and a block placed there would trap it). */
export const occupies = (feet: P, c: P) => c.x === feet.x && c.z === feet.z && (c.y === feet.y || c.y === feet.y + 1);

export interface PlaceRule {
  /** the item that places it */
  item: string;
  /** sides of the target it may be clicked against, best first (the block on that side is the reference) */
  refs: Dir[];
  /** click a side face high (upside-down stairs, top slabs and trapdoors); else low, as the mod does */
  top: boolean;
  /** the yaw to place with (stairs, doors, chests...: see placerFacing) */
  look?: string;
  /** a log, pillar or chain: only faces on this axis */
  axis?: 'x' | 'y' | 'z';
  /** cells that must be free too: a door's top, a bed's head */
  extra: P[];
  /** falls without a block under it (sand, gravel, concrete powder) */
  gravity: boolean;
  /** hangs on, or stands on, its support: placed after what it rests on */
  attached: boolean;
  /** why the bot can't place it at all (a double slab, a piston facing up...) */
  unsupported?: string;
}

const WALL_MOUNTED = /^(wall_torch|soul_wall_torch|redstone_wall_torch|copper_wall_torch|ladder|[a-z_]+_wall_banner|[a-z_]+_wall_sign|[a-z_]+_wall_hanging_sign|tripwire_hook|[a-z_]+_wall_head|[a-z_]+_wall_skull)$/;
const ON_FLOOR = /^(torch|soul_torch|redstone_torch|copper_torch|[a-z_]*_pressure_plate|[a-z_]+_sign|[a-z_]+_banner|[a-z_]*carpet|rail|powered_rail|detector_rail|activator_rail|flower_pot|potted_[a-z_]+|[a-z_]*candle|redstone_wire|repeater|comparator|[a-z_]+_bed|[a-z_]+_door|[a-z_]*sapling|dandelion|poppy|blue_orchid|allium|azure_bluet|[a-z_]*tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|snow|cake|[a-z_]+_head|[a-z_]+_skull)$/;
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|[a-z_]+_concrete_powder|anvil|chipped_anvil|damaged_anvil|dragon_egg|pointed_dripstone)$/;
const ATTACHED = /(^|_)(torch|wall_torch|lantern|sign|wall_sign|hanging_sign|door|bed|ladder|button|lever|carpet|rail|pressure_plate|banner|wall_banner|flower_pot|trapdoor|tripwire_hook|candle|chain|bell|item_frame|skull|head)$/;
/** facing up or down from where the player looks (the mod only turns the yaw): not placeable as asked yet */
const LOOKS_3D = /^(piston|sticky_piston|observer|dispenser|dropper|barrel|hopper|end_rod|lightning_rod|[a-z_]*amethyst_bud|amethyst_cluster)$/;
const NOT_PLACED = /^(water|lava|bubble_column|fire|soul_fire|vine|glow_lichen|cave_vines|cave_vines_plant|twisting_vines|weeping_vines|kelp|kelp_plant|seagrass|tall_seagrass|tall_grass|large_fern|scaffolding|bamboo|cactus|sugar_cane|nether_portal|end_portal|piston_head|moving_piston)$/;

export function placeRule(state: string): PlaceRule {
  const { id, props } = parse(state);
  const item = itemOf(state);
  const base: PlaceRule = { item, refs: ALL, top: false, extra: [], gravity: GRAVITY.test(id), attached: ATTACHED.test(id) };
  if (NOT_PLACED.test(id)) return { ...base, unsupported: `${id} isn't placed as a block` };
  if (/_slab$/.test(id) && props.type === 'double') return { ...base, unsupported: 'a double slab (two slabs in one cell)' };
  if (LOOKS_3D.test(id) && (props.facing === 'up' || props.facing === 'down' || /hopper/.test(id))) return { ...base, unsupported: `${id} facing ${props.facing ?? 'down'}` };
  const facing = props.facing as Dir | undefined;
  const look = facing && SIDES.includes(facing) ? placerFacing(id, facing) : undefined;
  const r: PlaceRule = { ...base, ...(look ? { look } : {}) };
  // the clicked face decides: wall things go on the block behind them, floor things on the block below
  if (WALL_MOUNTED.test(id) && facing && SIDES.includes(facing)) return { ...r, refs: [OPP[facing]] };
  if (props.face === 'floor') return { ...r, refs: ['down'] };
  if (props.face === 'ceiling') return { ...r, refs: ['up'] };
  if (props.face === 'wall' && facing && SIDES.includes(facing)) return { ...r, refs: [OPP[facing]] };
  if (/lantern$/.test(id)) return { ...r, refs: props.hanging === 'true' ? ['up'] : ['down'] };
  if (/_hanging_sign$/.test(id)) return { ...r, refs: ['up'] };
  if (/_door$/.test(id)) return { ...r, refs: ['down'], extra: [{ x: 0, y: 1, z: 0 }] };
  if (/_bed$/.test(id) && facing && SIDES.includes(facing)) return { ...r, refs: ['down'], extra: [STEP[facing]] };
  if (ON_FLOOR.test(id)) return { ...r, refs: ['down'] };
  if (props.axis === 'x' || props.axis === 'y' || props.axis === 'z') {
    const refs: Dir[] = props.axis === 'x' ? ['east', 'west'] : props.axis === 'z' ? ['north', 'south'] : ['down', 'up'];
    return { ...r, refs, axis: props.axis };
  }
  // stairs, slabs and trapdoors: the bottom face of the block above or a side clicked high makes the top half
  const topHalf = props.half === 'top' || props.type === 'top';
  if (/(_stairs|_slab|_trapdoor)$/.test(id)) {
    if (/_trapdoor$/.test(id) && facing && SIDES.includes(facing)) return { ...r, refs: [OPP[facing]], top: topHalf };
    return { ...r, refs: topHalf ? ['up', ...SIDES] : ['down', ...SIDES], top: topHalf };
  }
  if (r.gravity) return { ...r, refs: ['down'] };
  return r;
}

/**
 * The point the mod clicks to place at `target` against the block on its `d` side: the middle of that block's face
 * toward the target, a quarter lower on a side face (stairs and slabs come out as bottom halves) or a quarter higher
 * for a top half.
 */
export function placeHit(target: P, d: Dir, top = false): V3 {
  const s = STEP[d];
  const side = s.y === 0;
  return { x: target.x + 0.5 + 0.5 * s.x, y: target.y + 0.5 + 0.5 * s.y + (side ? (top ? 0.25 : -0.25) : 0), z: target.z + 0.5 + 0.5 * s.z };
}

/** The sign call clicks the support's face in the middle. */
export function signHit(target: P, d: Dir): V3 {
  const s = STEP[d];
  return { x: target.x + 0.5 + 0.5 * s.x, y: target.y + 0.5 + 0.5 * s.y, z: target.z + 0.5 + 0.5 * s.z };
}

/**
 * The reference sides a placement could use in the world as it is (the block there is something to click). Nothing
 * attached rests on scaffold: a torch on it would drop when it's taken down.
 */
export function supports(v: Voxels, at: P, rule: PlaceRule): Dir[] {
  return rule.refs.filter(d => { const r = toward(at, d); return v.is(r, SUPPORT) && !(rule.attached && isScaffold(v.get(r))); });
}

/** Whether `at` can take the block now, wherever the bot stands: the cell (and the extra cells) free, a support there. */
export function placeable(v: Voxels, at: P, rule: PlaceRule): boolean {
  if (rule.unsupported || !v.is(at, REPLACEABLE)) return false;
  for (const e of rule.extra) if (!v.is({ x: at.x + e.x, y: at.y + e.y, z: at.z + e.z }, REPLACEABLE)) return false;
  if (rule.gravity && !v.is(toward(at, 'down'), FLOOR)) return false;
  return supports(v, at, rule).length > 0;
}

/**
 * The side to click from `feet`, or undefined when no support is in reach and in sight from there. In sight as a
 * player's crosshair is: the ray from the eye to the point clicked gets to the reference block through the open cell
 * the block goes into (a vanilla server doesn't check, but a player can't place through a ceiling, and neither does
 * the bot: it planned torches on a lookout's fence posts from under the lookout's floor).
 */
export function placeFrom(v: Voxels, feet: P, at: P, rule: PlaceRule, reach = REACH, hit = placeHit): Dir | undefined {
  if (occupies(feet, at)) return undefined;
  for (const e of rule.extra) if (occupies(feet, { x: at.x + e.x, y: at.y + e.y, z: at.z + e.z })) return undefined;
  const eye = eyeOf(feet);
  for (const d of supports(v, at, rule)) {
    const h = hit(at, d, rule.top);
    if (dist(eye, h) > reach) continue;
    // the point a hair inside the reference block (on its face, the boundary)
    const s = STEP[d];
    if (sightTo(v, eye, { x: h.x + 0.01 * s.x, y: h.y + 0.01 * s.y, z: h.z + 0.01 * s.z }, toward(at, d), at)) return d;
  }
  return undefined;
}

/**
 * Whether a ray from `from` reaches the target cell without anything in between: the mod's dig.here aims at a face only
 * when the ray hits that block first (plants and torches have outlines that stop it; fluids don't).
 */
export function sightTo(v: Voxels, from: V3, to: V3, target: P, through?: P): boolean {
  let x = Math.floor(from.x), y = Math.floor(from.y), z = Math.floor(from.z);
  const tx = target.x, ty = target.y, tz = target.z;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const inv = (d: number) => (d === 0 ? Infinity : Math.abs(1 / d));
  const next = (p: number, d: number) => (d > 0 ? Math.floor(p) + 1 - p : p - Math.floor(p));
  let tMaxX = dx === 0 ? Infinity : next(from.x, dx) * inv(dx), tMaxY = dy === 0 ? Infinity : next(from.y, dy) * inv(dy), tMaxZ = dz === 0 ? Infinity : next(from.z, dz) * inv(dz);
  const tdx = inv(dx), tdy = inv(dy), tdz = inv(dz);
  for (let n = 0; n < 64; n++) {
    if (x === tx && y === ty && z === tz) return true;
    // the eye's own cell is the head: always open; `through` too (the cell a block goes into: grass in it is replaced)
    const open = n === 0 || (through && x === through.x && y === through.y && z === through.z) || v.is({ x, y, z }, CLEAR);
    if (!open) return false;
    if (tMaxX < tMaxY && tMaxX < tMaxZ) { if (tMaxX > 1) break; x += sx; tMaxX += tdx; }
    else if (tMaxY < tMaxZ) { if (tMaxY > 1) break; y += sy; tMaxY += tdy; }
    else { if (tMaxZ > 1) break; z += sz; tMaxZ += tdz; }
  }
  return x === tx && y === ty && z === tz;
}

/**
 * Whether the bot standing at `feet` can dig `at`: an open face (the mod's test: the block beside that face is
 * replaceable) whose middle is in reach and in sight. Never the floor it stands on.
 */
export function digFrom(v: Voxels, feet: P, at: P, reach = REACH): boolean {
  if (at.x === feet.x && at.z === feet.z && at.y === feet.y - 1) return false;
  if (v.is(at, AIR)) return false;
  const eye = eyeOf(feet);
  // a small block (torch, flower, grass): the mod aims at the middle of its outline
  if (v.is(at, PASSABLE)) {
    const mid = { x: at.x + 0.5, y: at.y + 0.4, z: at.z + 0.5 };
    return dist(eye, mid) <= reach && sightTo(v, eye, mid, at);
  }
  for (const d of ALL) {
    if (!v.is(toward(at, d), REPLACEABLE)) continue;
    const s = STEP[d];
    const fc = { x: at.x + 0.5 + 0.49 * s.x, y: at.y + 0.5 + 0.49 * s.y, z: at.z + 0.5 + 0.49 * s.z };
    if (dist(eye, fc) <= reach && sightTo(v, eye, fc, at)) return true;
  }
  return false;
}

/** Something to dig there: a block, with an open face. */
export function diggable(v: Voxels, at: P): boolean {
  if (v.is(at, AIR) || !v.inside(at)) return false;
  return ALL.some(d => v.is(toward(at, d), REPLACEABLE));
}

// ------------------------------------------------------------------------------------------------ tools on blocks

/** What a hoe or a shovel makes of a block (farmland, a path), and from what. */
export const WORKED: Record<string, { tool: 'hoe' | 'shovel'; from: RegExp }> = {
  farmland: { tool: 'hoe', from: /^(dirt|grass_block|dirt_path)$/ },
  dirt_path: { tool: 'shovel', from: /^(dirt|grass_block|coarse_dirt|podzol|mycelium|rooted_dirt)$/ }
};

/** Whether the block at `at` can be worked into `want` now (the right block, air over it: vanilla's rule). */
export function workable(v: Voxels, at: P, want: string): boolean {
  const w = WORKED[idOf(want)];
  return !!w && w.from.test(idOf(v.get(at))) && v.is(toward(at, 'up'), AIR);
}

/** The useOn call clicks the top face's middle. */
export function workFrom(feet: P, at: P, reach = REACH): boolean {
  return dist(eyeOf(feet), { x: at.x + 0.5, y: at.y + 1, z: at.z + 0.5 }) <= reach;
}
