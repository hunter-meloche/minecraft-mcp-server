import type { ClientRuntime } from '../tools.js';
import type { Pos, WorldMemory } from './memory.js';
import { onEdge, yardRing, type FenceRing } from './fence.js';
import { missingBuilt, type BuiltBlock } from './integrity.js';

/**
 * Out of a fence the bot is wedged in. Pressed against a fence from either side, the bot's middle comes to lie 0.075
 * inside the fence's own cell (its box is 0.6 wide, the post 0.25), so its block position is the fence's and
 * Baritone plans every walk from inside the post, into it, for ever. The brain's wedge watch (brain.ts) stops the
 * run and steps the bot out by hand, to the open cell on the side it really stands on; and when that fails twice, a
 * fence of its own is dug out, stepped out of and put back.
 */

/** Blocks the bot can stand partly inside of (thin ones): a fence, wall, pane, bars, a shut gate. */
const THIN = /(fence|_wall(\[|$)|pane|iron_bars|chain(\[|$))/;
/** What the bot can step into: air and the small plants and lights that don't block a walk. */
const OPEN = /^(minecraft:)?(air|cave_air|short_grass|tall_grass|fern|large_fern|dandelion|poppy|\w+_tulip|cornflower|oxeye_daisy|azure_bluet|allium|blue_orchid|lily_of_the_valley|torch|wall_torch|snow\[layers=1\])(\[|$)/;
/**
 * This far off its cell's middle on an axis (of a block), the bot is past the thin block's middle on that side:
 * pressed into a fence's corner from inside a pen it stands 0.425 off it on both.
 */
const PAST = 0.25;
const SIDES: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const idOf = (b: string) => b.replace(/^minecraft:/, '').replace(/\[.*$/, '');
/** `blocks` is the 3x2x3 region from (x-1, y, z-1) round the floored position, x fastest, then z, then y. */
const cellIn = (blocks: (string | null)[]) => (dx: number, dy: number, dz: number) =>
  (blocks[(dx + 1) + (dz + 1) * 3 + dy * 9] ?? '').replace(/^minecraft:/, '');

/**
 * Where to step to out of the thin block the bot stands in, best first: the middles of the open cells (feet and head)
 * on the side of it the bot is on, then the other open side cells, the nearest first. The side it is on comes first
 * because a straight walk anywhere else goes into the post: on Nov 13 the bot stood 1 h 45 min pressed into the
 * inside corner of its cow pen's corner post (-558, 63, 2171), and the step-out went to the nearest open side cells,
 * west and south of the post, outside the pen, through it, 142 times. In a corner from inside the cell it is on is
 * the one inside the corner, across it: past the post on both axes, the cell on the diagonal comes first.
 */
export function stepsOut(pos: Pos, blocks: (string | null)[]): Pos[] {
  const at = cellIn(blocks);
  const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
  const ox = pos.x - fx - 0.5, oz = pos.z - fz - 0.5;
  const side = (o: number) => (o >= PAST ? 1 : o <= -PAST ? -1 : 0);
  const sx = side(ox), sz = side(oz);
  const open = ([dx, dz]: [number, number]) => OPEN.test(at(dx, 0, dz)) && OPEN.test(at(dx, 1, dz));
  // the bot's own side: the corner cell when it is past the middle both ways, then the side it is further past
  const sides: [number, number][] = Math.abs(ox) >= Math.abs(oz) ? [[sx, 0], [0, sz]] : [[0, sz], [sx, 0]];
  const mine = ([...(sx && sz ? [[sx, sz] as [number, number]] : []), ...sides] as [number, number][])
    .filter(([dx, dz]) => (dx || dz) && open([dx, dz]));
  const mid = ([dx, dz]: [number, number]): Pos => ({ x: fx + dx + 0.5, y: fy, z: fz + dz + 0.5 });
  const rest = SIDES.filter(d => open(d) && !mine.some(m => m[0] === d[0] && m[1] === d[1])).map(mid)
    .sort((a, b) => Math.hypot(a.x - pos.x, a.z - pos.z) - Math.hypot(b.x - pos.x, b.z - pos.z));
  return [...mine.map(mid), ...rest];
}

/**
 * Wedged: the bot's feet cell (floored) holds a thin block it stands against, so Baritone plans from inside the
 * fence and walks into it for ever. Three times one night at the south fence (-547, 63, 2199), right after hunts
 * outside it: food, shelter and every retry "looks stuck" for half an hour, hungry, out of bed. `blocks` is the
 * 3x2x3 region from (x-1, y, z-1) round the floored position, x fastest, then z, then y. Returns the thin block and
 * the middle of the cell to step to (stepsOut's first), or undefined when it isn't wedged (or can't step out).
 */
export function wedgedOut(pos: Pos, blocks: (string | null)[]): { block: string; to: Pos } | undefined {
  const feet = cellIn(blocks)(0, 0, 0);
  if (!THIN.test(feet) || /open=true/.test(feet)) return undefined;
  const to = stepsOut(pos, blocks)[0];
  return to ? { block: idOf(feet), to } : undefined;
}

/** The rings of the bot's pens (zones `pen:<kind>`), as the yard's: posts one over the zone's ground, torches two over. */
function penRings(world: WorldMemory): FenceRing[] {
  return Object.entries(world.zones ?? {}).filter(([k]) => /^pen:[a-z]+$/.test(k)).map(([, zs]) => zs[0])
    .filter(z => !!z?.width && !!z.length).map(z => ({ x1: z.x, z1: z.z, x2: z.x + z.width! - 1, z2: z.z + z.length! - 1, y: z.y }));
}

const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;

/**
 * The bot's own to dig out and put back: in its record of what it built (placed-blocks.json, `built`), or a fence, a
 * gate or a wall on the yard's ring or a pen's (what the perimeter and pen milestones built there). Nothing else: a
 * thin block of someone else's is never dug (and the client refuses one in a build it knows for someone's).
 */
export function ownThin(world: WorldMemory | undefined, built: BuiltBlock[], at: Pos, state: string): boolean {
  if (built.some(b => same(b.at, at))) return true;
  if (!world || !/(_fence|_fence_gate|_wall)$/.test(idOf(state))) return false;
  const rings = [yardRing(world), ...penRings(world)].filter((r): r is FenceRing => !!r);
  return rings.some(r => at.y === r.y + 1 && onEdge(r, at));
}

/** What stands on a post and comes down with it when it is dug: a torch or a lantern set on top (not one on a wall, nor one that hangs). */
const onTop = (b: string) => /^(\w+_)?(torch|lantern)$/.test(idOf(b)) && !/wall_torch$/.test(idOf(b)) && !/hanging=true/.test(b);

/**
 * What a dig gives back to put back: a fence, a gate, a wall. A pane breaks to nothing without silk touch (the bot's
 * windows are its own in the record), so one dug out would leave a hole for good.
 */
const DIGS_BACK = /(_fence|_fence_gate|_wall)$/;

/** The bridge's steer reply: within reach of the point, and the block the bot ended in. */
interface Steered { reached?: boolean; at?: Pos }
/** Near enough to put a block back without walking: restoreBlock's own walk lets Baritone break and place (fence.ts NO_WALK). */
const NO_WALK = 3.9;
/** Eye over feet, standing. */
const EYE = 1.62;
/** The drops' pick-up delay is half a second: the post and its torch must be in the pockets before they go back. */
const PICK_UP_MS = 700;
/**
 * A put-back refused is tried once more after this: the pick-up came late (a slow server: "no oak_fence in the
 * inventory"), or a cow stepped into the gap (the game places no block where one stands).
 */
const AGAIN_MS = 1500;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

/** What the wedge watch needs of the client. */
export type WedgeRuntime = Pick<ClientRuntime, 'call' | 'status' | 'builtNear' | 'restoreBlock' | 'protectBuilt'>;

/**
 * Out of the thin block the bot stands in (the brain has stopped the run): a short straight walk to the middle of the
 * open cell on its side of it (stepsOut), then once more (to the next way out, when there is one: a cow may stand in
 * the first). Both failed, a fence, gate or wall of the bot's own (ownThin, DIGS_BACK) is dug out from where it stands
 * (dig.here: no walk, no Baritone; the client refuses one in someone's build), the bot steps out of the open cell, and
 * once it is clear of it and within reach, the block goes back with its recorded state, then what stood on it (the
 * dig drops both; a put-back refused is tried once more, AGAIN_MS on). Every
 * walk here is a steer: Baritone, which plans from inside the post, has no part in it. `go`: whether the autopilot
 * still has the bot (the brain's run is stopped by now, so neither the LLM taking over nor autonomy off reaches this):
 * asked before the dig, the steps after it and each put-back, which hold the keys and dig while someone else's tool
 * runs. `out`: the bot is out of the cell; `line`, for the log, when it was not a plain step out.
 */
export async function getOut(rt: WedgeRuntime, world: WorldMemory | undefined, pos: Pos, blocks: (string | null)[], go: () => boolean = () => true): Promise<{ out: boolean; line?: string }> {
  const at = cellIn(blocks);
  const state = at(0, 0, 0);
  const steps = stepsOut(pos, blocks);
  if (!THIN.test(state) || !steps.length) return { out: false };
  const feet = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
  const where = `the ${idOf(state)} at (${feet.x}, ${feet.y}, ${feet.z})`;
  const outOf = (r?: Steered) => !!r && (r.reached === true || (!!r.at && (Math.floor(r.at.x) !== feet.x || Math.floor(r.at.z) !== feet.z)));
  const steer = (to: Pos) => rt.call<Steered>('steer', { ...to, within: 0.25, timeoutMs: 2000 }, 5000).catch(() => undefined);
  for (const to of [steps[0], steps[1] ?? steps[0]]) if (outOf(await steer(to))) return { out: true };

  const built = rt.builtNear(feet, 1);
  if (!ownThin(world, built, feet, state)) return { out: false, line: `wedged in ${where}: could not step out, and it is not the bot's own to dig out` };
  if (!DIGS_BACK.test(idOf(state))) return { out: false, line: `wedged in ${where}: could not step out, and a ${idOf(state)} dug out would not come back (not dug)` };
  if (!go()) return { out: false, line: `wedged in ${where}: could not step out; left to the one who took over` };
  const dug = await rt.call<{ dug?: boolean; reason?: string }>('dig.here', { ...feet, timeoutMs: 10_000 }, 20_000)
    .catch((e: Error) => ({ dug: false, reason: e.message }));
  if (!dug.dug) return { out: false, line: `wedged in ${where}: could not step out or dig it out (${(dug.reason ?? 'no reason given').replace(/ \(force.*\)$/, '')})` };

  // the post with the state it was built with (as it stood, where none is recorded), then what stood on it
  const up = { ...feet, y: feet.y + 1 };
  const recorded = (p: Pos) => built.find(b => same(b.at, p))?.state;
  const top = at(0, 1, 0);
  const wanted: BuiltBlock[] = [{ at: feet, state: recorded(feet) ?? state }, ...(onTop(top) ? [{ at: up, state: recorded(up) ?? top }] : [])];
  // one the bot's own by the ring rule alone goes in the record as it stood, now it is surely dug (the client may
  // refuse someone's): the repair round puts back only what the record holds, and a put-back that fails is its job
  try {
    if (!recorded(feet)) rt.protectBuilt([{ at: feet, state }, ...(onTop(top) && !recorded(up) ? [{ at: up, state: top }] : [])]);
  } catch { /* (the record helps the repair round; the step out and the put-back come first) */ }
  if (!go()) return { out: false, line: `wedged in ${where}: dug it out; left for the repair round to put back (the autopilot was stopped)` };
  let out = false;
  for (const to of steps.slice(0, 3)) if ((out = outOf(await steer(to)))) break;
  if (!out) return { out: false, line: `wedged in ${where}: dug it out, but could not step out (left for the repair round to put back)` };

  const plan = missingBuilt(wanted, wanted.map(() => 'air')).restore;
  await pause(PICK_UP_MS);
  const me = (await rt.status().catch(() => undefined))?.position;
  let put = 0;
  let why: string | undefined;
  const restore = (b: (typeof plan)[number]) => rt.restoreBlock(b.at, b.item, b.facing).catch((e: Error) => e.message);
  for (const b of plan) {
    // (in the column, the client would say "the bot is standing there" and walk it out Baritone's way)
    const reach = me ? Math.hypot(b.at.x + 0.5 - me.x, b.at.y + 0.5 - (me.y + EYE), b.at.z + 0.5 - me.z) : Infinity;
    const inIt = !!me && Math.floor(me.x) === b.at.x && Math.floor(me.z) === b.at.z;
    if (inIt || reach > NO_WALK) { why = 'not clear of it, or out of reach, where it stepped out'; break; }
    if (!go()) { why = 'the autopilot was stopped'; break; }
    why = await restore(b);
    if (why) {
      await pause(AGAIN_MS);
      if (!go()) { why = 'the autopilot was stopped'; break; }
      why = await restore(b);
    }
    if (why) break;
    put++;
  }
  const back = !why ? 'put it back'
    : put ? `put it back, but not the ${plan[put].item} on it (${why})`
      : `could not put it back (${why}): left for the repair round`;
  return { out: true, line: `wedged in ${where}: dug it out, stepped out, ${back}` };
}
