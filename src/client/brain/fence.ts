import { canPlaceAgainst, isReplaceable } from '../../build-protection.js';
import type { ClientRuntime } from '../tools.js';
import { key } from './chests.js';
import { outsideBy, type GoalContext } from './goals.js';
import type { BuiltBlock, IntegrityPlan, Restore } from './integrity.js';
import type { Pos, WorldMemory } from './memory.js';
import { readBox } from './milestones.js';

/**
 * The yard's fence, for the daily repair round. The round looked 24 round home, and the fence runs 64 north of home
 * and 32 south of it: live on Nov 13 eight posts of the east fence were gone 42 from home ((-533, 63, 2144..2151)),
 * and the ground under five of them, a crater (a creeper's, most likely) open down to y 58 beside them and on into
 * the cave under the yard, the way the cow search got under the yard five times that day. Every post was in the bot's
 * own record, with its state; the round said "put back 0/4" about other things nearer home, day after day. Here: the
 * ring as the perimeter milestone built it, the ground a missing post wants filled first, and the walk along the
 * fence that puts both back (careful walks only, inside the yard).
 */

/** The ring round the yard (zones.fence): its edge, the posts and gates one over `y` (the yard's ground), torches two over. */
export interface FenceRing { x1: number; z1: number; x2: number; z2: number; y: number }

/** Blocks of fill a run, at most: what is left waits for the next round, and is said. */
export const FILL_MAX = 40;
/**
 * What the ground is filled with, in this order (as the shafts under the yard are, underyard.ts): live the chests held
 * no dirt and hundreds of both stones, and with dirt alone the posts went back over the open ground when it ran short.
 */
export const FILL_KINDS = ['dirt', 'cobblestone', 'cobbled_deepslate'] as const;
/** How deep a column under or beside a post is filled, at most. */
export const FILL_DEPTH = 4;
/** How far across the fence line, either side, the open ground beside a missing post is filled (the crater's lip). */
export const FILL_ACROSS = 2;
/** Fill never goes further outside the yard than this (the bridge's margin round the home zone). */
export const YARD_MARGIN = 6;
/** The bot's reach, as the bridge measures it: from the eye to the point on the face it clicks. */
const REACH = 4.5;
/** Eye over feet, standing. */
const EYE = 1.62;
/**
 * Near enough for restoreBlock to place without walking: its own walk on "too far" (and on "the bot is standing
 * there") lets Baritone break and place, so it is never left to make one here. The face clicked is within 0.56 of
 * the cell's middle, so from 3.9 to the middle every face is within the bridge's 4.5.
 */
const NO_WALK = 3.9;

/** The yard's fence as the perimeter milestone built it: none while it is being moved out (its old side comes down). */
export function yardRing(world: WorldMemory): FenceRing | undefined {
  if (world.fenceMove) return undefined;
  const z = world.zones?.fence?.at(-1);
  if (!z || !z.width || !z.length || z.width < 2 || z.length < 2) return undefined;
  return { x1: z.x, z1: z.z, x2: z.x + z.width - 1, z2: z.z + z.length - 1, y: z.y };
}

/** On the ring's line, at any height. */
export const onEdge = (r: FenceRing, p: { x: number; z: number }) =>
  ((p.z === r.z1 || p.z === r.z2) && p.x >= r.x1 && p.x <= r.x2) || ((p.x === r.x1 || p.x === r.x2) && p.z >= r.z1 && p.z <= r.z2);

/** On the ring: its posts and gates (one over the ground) and what stands on them (the torches, two over). */
export function onRing(r: FenceRing, p: Pos): boolean {
  return (p.y === r.y + 1 || p.y === r.y + 2) && onEdge(r, p);
}

/** The bot's own blocks on the yard's ring within the leash of home (a look only: the round's gate asks it too). */
export function fenceBuilt(rt: Pick<ClientRuntime, 'builtNear'>, world: WorldMemory, home: Pos): BuiltBlock[] {
  const r = yardRing(world);
  if (!r) return [];
  const centre = { x: (r.x1 + r.x2) / 2, y: r.y + 1, z: (r.z1 + r.z2) / 2 };
  return rt.builtNear(centre, Math.hypot((r.x2 - r.x1) / 2, (r.z2 - r.z1) / 2) + 1)
    .filter(b => onRing(r, b.at) && Math.hypot(b.at.x - home.x, b.at.z - home.z) <= world.leash);
}

/** The ways out of the yard from a cell on its edge: one on a side, two at a corner. */
function outward(r: FenceRing, p: { x: number; z: number }): [number, number][] {
  const out: [number, number][] = [];
  if (p.x === r.x1) out.push([-1, 0]);
  if (p.x === r.x2) out.push([1, 0]);
  if (p.z === r.z1) out.push([0, -1]);
  if (p.z === r.z2) out.push([0, 1]);
  return out;
}

const idOf = (b: string) => b.replace(/^minecraft:/, '').replace(/\[.*$/, '');
const propsOf = (b: string): Record<string, string> =>
  Object.fromEntries((/\[(.*)\]$/.exec(b)?.[1] ?? '').split(',').filter(Boolean).map(kv => kv.split('=') as [string, string]));
/** Water and lava, and what stands in water: nothing is put there. */
const wet = (b: string) => /^(water|lava|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/.test(idOf(b)) || propsOf(b).waterlogged === 'true';
/** Open: air, or what grows on the ground (grass, one layer of snow): a block goes in it. Never water, lava or fire. */
const open = (b: string | null | undefined): boolean =>
  !!b && !wet(b) && !/^(fire|soul_fire)$/.test(idOf(b)) && isReplaceable({ name: idOf(b), getProperties: () => propsOf(b) });
/**
 * The world's own ground (or the bot's fill): what a filled column may rest on, and what the bot stands on to work.
 * Anything else under a hole (a chest, a rail, a torch, someone's floor) is left uncovered.
 */
const GROUND = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|dirt_path|farmland|mud|clay|moss_block|sand|red_sand|gravel|stone|cobblestone|mossy_cobblestone|cobbled_deepslate|deepslate|tuff|andesite|diorite|granite|calcite|dripstone_block|sandstone|red_sandstone|(\w+_)?terracotta|snow_block|packed_ice|ice|netherrack|bedrock|obsidian|smooth_basalt|\w+_ore)$/;

/** A block as world.region gives it ("name[props]"; null where unloaded, undefined outside what was read). */
export type CellAt = (x: number, y: number, z: number) => string | null | undefined;

/**
 * A column of fill: where, its cells bottom up, and how far across the fence line from the post it stands (0: under
 * it). `hangs`: the hole goes on under its deepest cell (closed at the top, hollow under it).
 */
export interface FillColumn { x: number; z: number; across: number; cells: Pos[]; hangs: boolean }

/**
 * The ground a missing post wants put back first: under it and the open ground within FILL_ACROSS either side across
 * the fence line (at a corner, across both of its lines), each column from the yard's ground level down to what
 * stands below, FILL_DEPTH at most (a deeper hole is closed at the top and left hollow under it). A column is left as
 * it is when its top holds something (the ground is there, or water: water is never filled), when it is not loaded,
 * when it is more than YARD_MARGIN outside the yard, and when it rests on something that is not ground (a chest, a
 * rail, a torch: nothing is buried; counted in `left`).
 */
export function groundUnder(r: FenceRing, post: { x: number; z: number }, cell: CellAt, yard: { x1: number; z1: number; x2: number; z2: number }): { columns: FillColumn[]; left: number } {
  const spots = [{ x: post.x, z: post.z, across: 0 }];
  for (const [dx, dz] of outward(r, post)) {
    for (let k = 1; k <= FILL_ACROSS; k++) for (const s of [k, -k]) spots.push({ x: post.x + s * dx, z: post.z + s * dz, across: k });
  }
  const columns: FillColumn[] = [];
  let left = 0;
  const seen = new Set<string>();
  for (const { x, z, across } of spots) {
    if (seen.has(`${x},${z}`)) continue;
    seen.add(`${x},${z}`);
    if (outsideBy(yard, { x, z }) > YARD_MARGIN) continue;
    const cells: Pos[] = [];
    let floor: string | null | undefined;
    let hangs = false;
    // down from the ground's level: the open run, and what it stands on (looked at one under the deepest it fills)
    for (let d = 0; d <= FILL_DEPTH; d++) {
      const b = cell(x, r.y - d, z);
      if (!open(b)) { floor = b; break; }
      if (d < FILL_DEPTH) cells.push({ x, y: r.y - d, z }); else hangs = true;
    }
    if (!cells.length || floor === null || (floor === undefined && cells.length < FILL_DEPTH)) continue;
    // on what isn't ground, nothing goes (water under it is fine: the fill goes on top, never in it)
    if (floor !== undefined && !wet(floor) && !GROUND.test(idOf(floor))) { left++; continue; }
    columns.push({ x, z, across, cells: cells.reverse(), hangs });
  }
  return { columns, left };
}

/**
 * Not to stand on: farmland (it would be trampled), and what is lower than a full block (a dirt path, mud): the bot's
 * feet sink under the cell over it, and a walk to the cell itself "did not arrive" (outByGate found it on the path).
 */
const NO_STAND = /^(farmland|dirt_path|mud)$/;

/**
 * Where to stand to work at a post: on ground strictly inside the fence (never on the line itself, nor out past it)
 * within 2 of the post, feet and head clear, not on farmland or a path (NO_STAND); the nearest first.
 */
export function standsFor(r: FenceRing, post: { x: number; z: number }, cell: CellAt): Pos[] {
  const out: { p: Pos; d: number }[] = [];
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const x = post.x + dx, z = post.z + dz, d = Math.hypot(dx, dz);
    if (d > 2 || x <= r.x1 || x >= r.x2 || z <= r.z1 || z >= r.z2) continue;
    const floor = cell(x, r.y, z);
    if (!floor || !GROUND.test(idOf(floor)) || NO_STAND.test(idOf(floor)) || !open(cell(x, r.y + 1, z)) || !open(cell(x, r.y + 2, z))) continue;
    out.push({ p: { x, y: r.y + 1, z }, d });
  }
  return out.sort((a, b) => a.d - b.d).map(o => o.p);
}

/** Whether any face the bridge may click to place at `c` is within its reach of the eye (if none is, it says "too far"). */
function mayReach(eye: { x: number; y: number; z: number }, c: Pos): boolean {
  const faces = [[0.5, 0, 0.5], [0.5, 1, 0.5], [0, 0.25, 0.5], [1, 0.25, 0.5], [0.5, 0.25, 0], [0.5, 0.25, 1]];
  return faces.some(([fx, fy, fz]) => Math.hypot(c.x + fx - eye.x, c.y + fy - eye.y, c.z + fz - eye.z) <= REACH);
}

/** The faces the bridge places against, in its own order, each with the step to the block it clicks. */
const FACES: [string, number, number, number][] = [['down', 0, -1, 0], ['north', 0, 0, -1], ['south', 0, 0, 1], ['east', 1, 0, 0], ['west', -1, 0, 0], ['up', 0, 1, 0]];

/**
 * The face to place `c` against: of the solid blocks beside it, the one whose face is nearest the eye, if that is in
 * reach. The bridge takes the first solid one in its own order, and says "too far" when that one is: from the lawn
 * the block below a cell two out across the line was, with the block on the yard's side in reach. `none`: nothing
 * solid beside it at all (yet).
 */
function faceFor(eye: { x: number; y: number; z: number }, c: Pos, solid: (p: Pos) => boolean): { face?: string; none: boolean } {
  let best: { face: string; d: number } | undefined;
  let any = false;
  for (const [face, dx, dy, dz] of FACES) {
    if (!solid({ x: c.x + dx, y: c.y + dy, z: c.z + dz })) continue;
    any = true;
    // the middle of the face between them, a side face low (as the bridge clicks it)
    const d = Math.hypot(c.x + 0.5 + dx / 2 - eye.x, c.y + 0.5 + dy / 2 - (dy ? 0 : 0.25) - eye.y, c.z + 0.5 + dz / 2 - eye.z);
    if (d <= REACH && (!best || d < best.d)) best = { face, d };
  }
  return { face: best?.face, none: !any };
}

/** The blocks round `ps` (one further each way), read as they are now; nothing at all when the read fails. */
async function readAround(ctx: Pick<GoalContext, 'call'>, ps: Pos[]): Promise<CellAt> {
  const lo = (k: keyof Pos) => Math.min(...ps.map(p => p[k])) - 1, hi = (k: keyof Pos) => Math.max(...ps.map(p => p[k])) + 1;
  const box = { x: lo('x'), y: lo('y'), z: lo('z'), width: hi('x') - lo('x') + 1, height: hi('y') - lo('y') + 1, length: hi('z') - lo('z') + 1 };
  const blocks = await readBox(ctx, box).catch(() => undefined);
  return (x, y, z) => {
    const dx = x - box.x, dy = y - box.y, dz = z - box.z;
    if (!blocks || dx < 0 || dy < 0 || dz < 0 || dx >= box.width || dy >= box.height || dz >= box.length) return undefined;
    return blocks[dx + dz * box.width + dy * box.width * box.length];
  };
}

/** The ground round the missing posts, read once: the fill each post wants, and where to stand for it. */
export interface FenceGround {
  cell: CellAt;
  /** the fill per post ("x,z"), with what is someone's left out */
  fill: Map<string, FillColumn[]>;
  /** columns left open: on something that is not ground, or in someone else's build */
  left: number;
  /** cells of fill planned in all (what the fill is fetched for) */
  cells: number;
}

const colKey = (p: { x: number; z: number }) => `${p.x},${p.z}`;

/**
 * Read the ground round what is to go back on the ring (the line and FILL_ACROSS either side of it, where the bot
 * stands too, from FILL_DEPTH under the yard's ground to a head over it) and plan the fill under the posts and
 * gates. Fill outside the fence never goes in a build the mod knows for someone else's (and not at all when it cannot
 * say); the line and the yard inside it are the bot's own, whatever it says (a zone wrongly over the homestead once
 * took its bed and chests away).
 */
export async function fenceGround(ctx: Pick<GoalContext, 'call' | 'world'>, r: FenceRing, restore: Restore[]): Promise<FenceGround> {
  const all = restore.map(b => b.at);
  const posts = all.filter(p => p.y === r.y + 1);
  const box = {
    x: Math.min(...all.map(p => p.x)) - FILL_ACROSS, z: Math.min(...all.map(p => p.z)) - FILL_ACROSS, y: r.y - FILL_DEPTH,
    width: 0, length: 0, height: FILL_DEPTH + 3
  };
  box.width = Math.max(...all.map(p => p.x)) + FILL_ACROSS - box.x + 1;
  box.length = Math.max(...all.map(p => p.z)) + FILL_ACROSS - box.z + 1;
  const blocks = await readBox(ctx, box);
  const cell: CellAt = (x, y, z) => {
    const dx = x - box.x, dy = y - box.y, dz = z - box.z;
    if (dx < 0 || dy < 0 || dz < 0 || dx >= box.width || dy >= box.height || dz >= box.length) return undefined;
    return blocks[dx + dz * box.width + dy * box.width * box.length];
  };
  const yard = ctx.world.yard ?? r;
  const fill = new Map<string, FillColumn[]>();
  let left = 0;
  const claimed = new Set<string>();
  for (const p of posts) {
    const g = groundUnder(r, p, cell, yard);
    left += g.left;
    // a column two posts share (by a corner) is filled once, by the first
    const mine = g.columns.filter(c => !claimed.has(colKey(c)));
    for (const c of mine) claimed.add(colKey(c));
    fill.set(colKey(p), mine);
  }
  const inside = (c: { x: number; z: number }) => c.x >= r.x1 && c.x <= r.x2 && c.z >= r.z1 && c.z <= r.z2;
  const out = [...fill.values()].flat().filter(c => !inside(c));
  if (out.length) {
    const cells = out.flatMap(c => c.cells);
    const said = await ctx.call<{ inside?: boolean[] }>('foreign.at', { positions: cells.map(p => [p.x, p.y, p.z]) }).catch(() => undefined);
    const theirs = new Set<string>();
    cells.forEach((p, i) => { if (!Array.isArray(said?.inside) || said.inside[i]) theirs.add(colKey(p)); });
    for (const [k, cols] of fill) {
      const kept = cols.filter(c => !theirs.has(colKey(c)));
      left += cols.length - kept.length;
      fill.set(k, kept);
    }
  }
  return { cell, fill, left, cells: [...fill.values()].flat().reduce((a, c) => a + c.cells.length, 0) };
}

/** Where some posts are, in a few words: "(-533, 63, 2144..2151)" for a run along one line. */
export function spanOf(ps: Pos[]): string {
  if (!ps.length) return '';
  const xs = [...new Set(ps.map(p => p.x))], ys = [...new Set(ps.map(p => p.y))], zs = [...new Set(ps.map(p => p.z))];
  const range = (vs: number[]) => (vs.length === 1 ? `${vs[0]}` : `${Math.min(...vs)}..${Math.max(...vs)}`);
  if (ys.length === 1 && (xs.length === 1 || zs.length === 1)) return `(${range(xs)}, ${ys[0]}, ${range(zs)})`;
  return ps.slice(0, 4).map(p => `(${p.x}, ${p.y}, ${p.z})`).join(', ') + (ps.length > 4 ? ` and ${ps.length - 4} more` : '');
}

type Entity = { name?: string; position?: { x: number; y: number; z: number } };

/**
 * How far under a hanging column (its hole deeper than the fill) what stands in the hole is looked for: filled over,
 * it would be roofed in (a cow at the bottom of a pit under a post was, closed in by the fill four over it).
 */
const UNDER_LOOK = 8;
/** How far past a post the look for what stands there reaches: its lip across the line, and down its hole and under it. */
const LOOK_PAST = Math.ceil(Math.hypot(FILL_ACROSS, FILL_DEPTH + UNDER_LOOK)) + 1;

/**
 * Put back what is missing from the yard's ring (`plan`, from missingBuilt over the ring's recorded blocks), post by
 * post, the nearest next: a careful walk (walk only: Baritone's own walk climbs the fence and leaves its scaffold) to
 * ground inside the fence by it, the ground under it filled first (FILL_MAX a run: a post whose fill does not fit,
 * or for which there is not fill enough, waits for the next round, which finds its ground open again: with the post
 * back over it, none would), then the post or gate with its recorded state, then what stood on it. Items come from
 * `have` (what the round got ready: carried, from the chests or crafted); a cell put back in vain twice is left alone,
 * as the round leaves its other blocks. Ends with a careful walk home. Says what it did, starting "fence: ".
 */
export async function mendFence(ctx: GoalContext, rt: Pick<ClientRuntime, 'restoreBlock' | 'protectBuilt'>, r: FenceRing, plan: IntegrityPlan,
  ground: FenceGround | undefined, have: Map<string, number>): Promise<string> {
  const tries = (ctx.world.repairFails ??= {});
  const units = new Map<string, { at: { x: number; z: number }; post?: Restore; top?: Restore }>();
  for (const b of plan.restore) {
    const u = units.get(colKey(b.at)) ?? { at: { x: b.at.x, z: b.at.z } };
    if (b.at.y === r.y + 1) u.post = b; else u.top = b;
    units.set(colKey(b.at), u);
  }
  const given = (b?: Restore) => !!b && (tries[key(b.at)] ?? 0) >= 2;
  const fill = () => FILL_KINDS.reduce((a, k) => a + (have.get(k) ?? 0), 0);
  const put: Restore[] = [];
  const failed: string[] = [];
  const noItem = new Map<string, number>();
  let filled = 0, short = 0, far = 0, waiting = 0, inHole = 0, inGap = 0, walked = false;
  const fail = (b: Restore, why: string) => {
    tries[key(b.at)] = (tries[key(b.at)] ?? 0) + 1;
    failed.push(`${b.item} at ${key(b.at)}: ${why}`);
    ctx.progress(`fence: couldn't place ${failed.at(-1)!}`);
  };
  const here = async (): Promise<Pos> => (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
  let me = await here();
  // what stands round a post (an animal, a dropped item, a boat), as far out as from the bot to under the post's lip
  let seen: Entity[] = [];
  const look = async (p: { x: number; z: number }) => {
    const d = Math.hypot(p.x + 0.5 - me.x, r.y + 1 - me.y, p.z + 0.5 - me.z);
    seen = (await ctx.call<{ entities?: Entity[] }>('world.entities', { maxDistance: Math.ceil(d) + LOOK_PAST }).catch(() => undefined))?.entities ?? [];
  };
  const inCell = (c: { x: number; z: number }, y1: number, y2: number) => seen.some(e => !!e.position && Math.floor(e.position.x) === c.x &&
    Math.floor(e.position.z) === c.z && Math.floor(e.position.y) >= y1 && Math.floor(e.position.y) <= y2);
  // a column's hole, and under a hanging one the open run below it too
  const inHoleOf = (c: FillColumn) => inCell(c, c.cells[0].y - (c.hangs ? UNDER_LOOK : 0), r.y + 1);
  // the post's gap (and what stood on it), and the hole under the post: nothing goes in either while something is there
  const held = (bs: (Restore | undefined)[], own?: FillColumn) =>
    bs.some(b => !!b && inCell(b.at, b.at.y - 1, b.at.y)) || (!!own && inHoleOf(own));
  // (what stood on a post given up on waits with it: no walk out to it)
  const todo = ground ? [...units.values()].filter(u => (u.post ? !given(u.post) : !!u.top && !given(u.top))) : [];
  const givenUp = plan.restore.filter(b => given(b)).length;
  while (todo.length && !ctx.signal.aborted) {
    // the nearest next, from where the bot is: along the line, not to and fro across the yard
    todo.sort((a, b) => Math.hypot(a.at.x + 0.5 - me.x, a.at.z + 0.5 - me.z) - Math.hypot(b.at.x + 0.5 - me.x, b.at.z + 0.5 - me.z));
    const u = todo.shift()!;
    const post = u.post && !given(u.post) ? u.post : undefined;
    const top = u.top && !given(u.top) ? u.top : undefined;
    let columns = post ? ground!.fill.get(colKey(u.at)) ?? [] : [];
    const own = columns.find(c => c.across === 0);
    // nothing to put back and no ground to fill: no walk out there (every round, to stand by the gap)
    const missing = (b?: Restore) => !!b && (have.get(b.item) ?? 0) <= 0;
    if ((post ? missing(post) : missing(top)) && !(columns.length && fill() > 0)) {
      const b = (post ?? top)!;
      noItem.set(b.item, (noItem.get(b.item) ?? 0) + 1);
      continue;
    }
    // the ground under it first: with this run's fill used up, or none to fill with, the post waits for the next round
    if (columns.length && filled >= FILL_MAX) { waiting++; continue; }
    if (columns.length && !fill()) { short++; continue; }
    // to the ground beside it, inside the fence, on foot only
    const stands = standsFor(r, u.at, ground!.cell);
    const at = (s: Pos) => Math.floor(me.x) === s.x && Math.floor(me.y) === s.y && Math.floor(me.z) === s.z;
    let there = stands.some(at);
    // something in the gap or in the hole under the post: seen from here, not walked out to every round (a boat that
    // stayed in a gap took a walk out and back each round)
    if (!there && stands.length) {
      await look(u.at);
      if (held([post, top], own)) { inGap++; continue; }
    }
    for (const s of stands.slice(0, 2)) {
      if (there || ctx.signal.aborted) break;
      ctx.progress(`fence: to (${s.x}, ${s.y}, ${s.z}), by the ${post ? post.item : 'post'} at (${u.at.x}, ${r.y + 1}, ${u.at.z})`);
      walked = true;
      const g = await ctx.call<{ arrived?: boolean }>('goto', { ...s, range: 0, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
      there = g?.arrived !== false;
    }
    if (ctx.signal.aborted) break;
    me = await here();
    if (!there) {
      for (const b of [post, top]) if (b) fail(b, stands.length ? 'no way to it on foot inside the fence' : 'no ground inside the fence by it to stand on');
      continue;
    }
    const eye = { x: me.x, y: me.y + EYE, z: me.z };
    // as it is here and now: the post waits for what is in its gap or the hole under it (never a try counted against it)
    await look(u.at);
    if (held([post, top], own)) { inGap++; continue; }
    // an animal or a dropped item in a hole by it is not buried, and nothing is put where one stands
    const clear = columns.filter(c => !inHoleOf(c));
    inHole += columns.length - clear.length;
    columns = clear;
    // what no face of is in reach from here is left (the deep end of a crater, seen from the lawn)
    const cells = columns.flatMap(c => c.cells.map(p => ({ p, across: c.across })));
    const reachable = cells.filter(c => mayReach(eye, c.p));
    if (filled + reachable.length > FILL_MAX) { waiting++; continue; }
    if (fill() < reachable.length) { short++; continue; }
    far += cells.length - reachable.length;
    // bottom up, and in each layer the post's own column first, then its lip, the nearer side first
    reachable.sort((a, b) => a.p.y - b.p.y || a.across - b.across);
    let now: CellAt = () => undefined;
    const laid = new Set<string>();
    if (reachable.length) {
      ctx.progress(`fence: filling ${reachable.length} under the post at (${u.at.x}, ${r.y + 1}, ${u.at.z})`);
      // as it is now, minutes after the round's look: a cell water ran into since is not filled (nor one filled since)
      now = await readAround(ctx, reachable.map(c => c.p));
      const solid = (p: Pos) => {
        const b = now(p.x, p.y, p.z);
        return laid.has(key(p)) || (!!b && canPlaceAgainst({ name: idOf(b), getProperties: () => propsOf(b) }));
      };
      let list = reachable.map(c => c.p).filter(p => open(now(p.x, p.y, p.z)));
      // once more for what had nothing beside it to go against: the cells round it may hold it by then
      for (let pass = 0; pass < 2 && list.length && !ctx.signal.aborted; pass++) {
        const again: Pos[] = [];
        for (const p of list) {
          // dirt first, then the stones (counted before the first: enough for every cell here)
          const kind = FILL_KINDS.find(k => (have.get(k) ?? 0) > 0);
          if (ctx.signal.aborted || !kind) break;
          const aim = faceFor(eye, p, solid);
          if (!aim.face) { if (aim.none && pass === 0) again.push(p); else far++; continue; }
          // the item named in the call: what the bridge cannot select is not placed (never the fence post in hand)
          const res = await ctx.call<{ placed: boolean; block?: string; reason?: string }>('place', { ...p, face: aim.face, item: kind })
            .catch((e: Error) => ({ placed: false, reason: e.message, block: undefined }));
          if (res.placed) {
            filled++;
            laid.add(key(p));
            have.set(kind, (have.get(kind) ?? 0) - 1);
            // the bot's own from now on: Baritone's walks leave it be, and the round puts it back if it goes
            rt.protectBuilt([{ at: p, state: res.block ?? kind }]);
            ctx.gain(1);
          } else if (pass === 0 && /nothing solid/.test(res.reason ?? '')) again.push(p);
          else far++;
        }
        list = again;
      }
    }
    if (ctx.signal.aborted) break;
    // the post goes on ground: with the ground straight under it not in (the look again failed, the place was
    // refused), it is tried again next round, which finds the hole again (with the post back over it, none would)
    const base = own?.cells.at(-1);
    const under = base && now(base.x, base.y, base.z);
    if (post && base && !laid.has(key(base)) && !(under && !open(under))) { fail(post, 'the ground under it did not go in'); continue; }

    // the post (or gate), then what stood on it: from here, never with restoreBlock's own walk
    me = await here();
    const feet = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
    const fromHere = async (b: Restore): Promise<boolean> => {
      if ((have.get(b.item) ?? 0) <= 0) { noItem.set(b.item, (noItem.get(b.item) ?? 0) + 1); return false; }
      const mid = Math.hypot(b.at.x + 0.5 - me.x, b.at.y + 0.5 - (me.y + EYE), b.at.z + 0.5 - me.z);
      const inIt = feet.x === b.at.x && feet.z === b.at.z && (feet.y === b.at.y || feet.y === b.at.y - 1);
      if (mid > NO_WALK || inIt) { fail(b, `out of reach from (${feet.x}, ${feet.y}, ${feet.z})`); return false; }
      const why = await rt.restoreBlock(b.at, b.item, b.facing);
      if (why) { fail(b, why); return false; }
      delete tries[key(b.at)];
      have.set(b.item, (have.get(b.item) ?? 0) - 1);
      put.push(b);
      ctx.gain(1);
      ctx.progress(`fence: put back ${b.item} at ${key(b.at)}`);
      return true;
    };
    // what stood on a post waits for the post (one given up on, or not put back, leaves it waiting too)
    const stands2 = post ? await fromHere(post) : !u.post;
    if (top && stands2 && !ctx.signal.aborted) await fromHere(top);
  }
  if (walked && !ctx.signal.aborted && ctx.s.home) {
    const p = await here();
    if (Math.hypot(p.x - ctx.s.home.x, p.z - ctx.s.home.z) > 3) {
      await ctx.call('goto', { x: ctx.s.home.x, y: ctx.s.home.y, z: ctx.s.home.z, range: 3, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => undefined);
    }
  }

  const posts = put.filter(b => b.at.y === r.y + 1);
  const gates = posts.filter(b => /_gate$/.test(b.item)).length;
  const tops = put.filter(b => b.at.y !== r.y + 1);
  const onTop = tops.length ? `${tops.length} ${tops.every(b => /torch$/.test(b.item)) ? 'torch(es)' : 'block(s)'}` : '';
  const what = [...(posts.length > gates ? [`${posts.length - gates} post(s)`] : []), ...(gates ? [`${gates} gate(s)`] : [])].join(' and ');
  const parts: string[] = [];
  if (posts.length) parts.push(`put back ${what} at ${spanOf(posts.map(b => b.at))}${onTop ? `, ${onTop} on them` : ''}`);
  else if (tops.length) parts.push(`put back ${onTop} on the posts at ${spanOf(tops.map(b => b.at))}`);
  else if (plan.restore.length > givenUp) parts.push(`${plan.restore.length - givenUp} missing, none put back`);
  if (givenUp) parts.push(`${givenUp} left alone (put back in vain twice)`);
  if (filled) parts.push(`filled ${filled} under them`);
  if (waiting) parts.push(`${waiting} post(s) wait for their ground (${FILL_MAX} filled a run): the next round`);
  if (short) parts.push(`${short} post(s) wait for their ground (no dirt or cobblestone to fill it with): the next round`);
  if (far) parts.push(`${far} cell(s) under them out of reach from the yard`);
  if (ground?.left) parts.push(`${ground.left} hole(s) by them left open (no ground under it, or someone's build)`);
  if (inHole) parts.push(`${inHole} hole(s) left open with an animal or an item in it`);
  if (inGap) parts.push(`${inGap} post(s) wait for an animal to leave the gap (or the hole under it)`);
  if (noItem.size) parts.push(`no ${[...noItem].map(([n, c]) => `${n} (x${c})`).join(', ')} to put back`);
  if (failed.length) parts.push(`couldn't place ${failed.slice(0, 5).join('; ')}`);
  if (plan.lost.length) parts.push(`not put back: ${plan.lost.slice(0, 5).map(l => `${l.state.replace(/\[.*$/, '')} at ${key(l.at)} (${l.why})`).join(', ')}`);
  if (plan.occupied) parts.push(`${plan.occupied} cell(s) hold another block now (left alone)`);
  return `fence: ${parts.join('; ')}`;
}
