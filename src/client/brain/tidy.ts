import type { ClientRuntime } from '../tools.js';
import { survey, type Cluster } from '../survey.js';
import { nearHome, type Goal, type GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { readBox, yardOf } from './milestones.js';
import { digByHand } from '../structures/job.js';
import { HANGS, SIDE_ATTACHED, regionOf } from '../structures/tidy.js';
import { onEdge, onRing, yardRing, type FenceRing } from './fence.js';
import { roundDue, roundFrom, toRound } from './work.js';

/**
 * Once a day: take away the stray blocks left standing on the lawn: an emergency wall-in, Baritone's scaffold, a
 * pillar it climbed. Only what survey-area calls placed-looking, only above the yard's ground (a filled hole is meant
 * to stay), only the scaffold kinds (dirt and cobblestone: never planks or anything else someone may have built
 * with), never next to a built block, and only small clusters. Scaffold against the yard fence is the one exception
 * to the last two (strayCells). Dug by hand, from a spot it walks to without breaking or placing anything: Baritone's
 * own dig lifts the protection on everything but furniture while it walks into reach, and reaching a stray up by the
 * watchtower it cut logs and cobblestone out of the tower, every day. A stray it can't get at twice is left be.
 */

const MINUTE = 60_000;
/** Near enough home to start the round where it is; from further out in the yard it walks home first (work.ts roundFrom). */
const REACH = 12;
const STRAY = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|netherrack)$/;
const MAX_CLUSTER = 16;
/** A cluster against the yard fence is a way over it, and is cleared up to this size (live, the north gate's was over 20). */
const FENCE_CLUSTER = 32;
/** How far outside the ring a cluster against the fence may reach: the step against it from outside, no further. */
const FENCE_OUTSIDE = 1;
/** Tries at a stray before it's left be (out of reach on foot: high on a wall, over water). */
const TRIES = 2;

const idOf = (b: string | null | undefined) => (b ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
const FENCE = /_fence(_gate)?$/;
const TORCH = /^(soul_|copper_)?torch$/;
const GONE = /^(air|cave_air|void_air)$/;
/** What stands on a block and comes off with it when the block is dug. */
const ON_TOP = /(torch|lantern|sign|banner|carpet|rail|pressure_plate|button|lever|candle|flower_pot|potted_|redstone|repeater|comparator|_door|_bed$|sapling|bell)/;
const key = (p: Pos) => `${p.x},${p.y},${p.z}`;

const done = (world: WorldMemory, chore: string, now: number) => { world.lastDone ??= {}; world.lastDone[chore] = now; };

/** The yard fence as the round sees it: what strayCells needs to let scaffold against it go. */
export interface YardFence {
  /** the yard's ring (zones.fence) */
  ring: FenceRing;
  /** its posts, gates and the torches on them, of the bot's own record, as they stand (yardFence) */
  fence: Set<string>;
  /** the block standing at a cell, as the round read it ('' where it read none) */
  at: (p: Pos) => string;
}

/**
 * The yard fence's own cells: the bot's built cells on the ring that hold a fence post or a gate now, and the torches
 * standing on those. The block read decides, not the record: a post gone, or with another block in its place, is no
 * post, and a fence that is not on the ring (a pen's, inside the yard) is none of it.
 */
export function yardFence(built: Pos[], at: (p: Pos) => string, ring: FenceRing): Set<string> {
  const mine = built.filter(p => onRing(ring, p));
  const fence = new Set(mine.filter(p => FENCE.test(idOf(at(p)))).map(key));
  for (const p of mine) if (TORCH.test(idOf(at(p))) && fence.has(key({ ...p, y: p.y - 1 }))) fence.add(key(p));
  return fence;
}

/**
 * The cells of the clusters to clear: small, scaffold kinds only, above `groundY`, and clear of built blocks.
 *
 * Against the yard fence (`yard`: a cell within one of its posts, gates or their torches, and none further than one
 * outside the ring) a cluster is a way over the fence, for a mob and for the bot's own walks, and the fence itself
 * shelters none of it. Live on Nov 13 a cobblestone stair stood over the north gate (one block each side, one on the
 * gate itself): the gateway was a block high, every cow walk north came back "no way out of the yard by the north
 * gate" (five in 7 hours, the enchanting room waiting on 38 leather), and a mob could walk up it into the yard. The
 * round left it be every day: it touched the gate and a torch on a post, and with the cobblestone along the fence east
 * of the gate (on posts, on that torch, pillars inside, up to y 67) it was over 20 blocks, more than a stray cluster
 * may be, and it touched a lawn torch at (-547, 63, 2123) that was gone. So, against the fence: up to FENCE_CLUSTER;
 * the fence's own cells, the bot's blocks gone to air and its blocks in or under the ground (the fill the repair
 * round puts back under its posts) shelter none; any other built block still keeps the cluster, and so does a cell
 * something stands on, hangs from or is hung on (a torch, a lantern, a sign: someone's lamp post, not scaffold). A
 * cell in the fence's own line at post height or below is never dug: it stands where a post is missing, and digging
 * it would open the fence (the post is the repair round's to put back).
 */
export function strayCells(clusters: Cluster[], groundY: number, built: Set<string>, yard?: YardFence): (Pos & { fence?: true })[] {
  const by = (p: Pos, hit: (q: Pos) => boolean) => {
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (hit({ x: p.x + dx, y: p.y + dy, z: p.z + dz })) return true;
    }
    return false;
  };
  const out: (Pos & { fence?: true })[] = [];
  for (const c of clusters) {
    if (!c.cells.every(b => STRAY.test(b.block))) continue;
    const cells = c.cells.filter(b => b.y > groundY);
    if (!cells.length) continue;
    let dig: Pos[];
    const fence = yard && againstFence(cells, yard, by) ? yard : undefined;
    if (fence) {
      const mine = new Set(c.cells.map(key));
      const shelters = (q: Pos) => built.has(key(q)) && !fence.fence.has(key(q)) && q.y > groundY && !GONE.test(idOf(fence.at(q)));
      if (c.blocks > FENCE_CLUSTER || cells.some(p => by(p, shelters) || holds(p, fence.at, mine))) continue;
      const r = fence.ring;
      dig = cells.filter(p => !(onEdge(r, p) && p.y <= r.y + 1));
    } else {
      if (c.blocks > MAX_CLUSTER || cells.some(p => by(p, q => built.has(key(q))))) continue;
      dig = cells;
    }
    // top down, so nothing is left hanging and the bot never digs the block it stands on first
    out.push(...dig.sort((a, b) => b.y - a.y).map(({ x, y, z }) => ({ x, y, z, ...(fence ? { fence: true as const } : {}) })));
  }
  return out;
}

/** Against the yard fence: a cell of the cluster by a post, a gate or their torch, and all within FENCE_OUTSIDE of the ring. */
function againstFence(cells: Pos[], yard: YardFence, by: (p: Pos, hit: (q: Pos) => boolean) => boolean): boolean {
  const r = yard.ring, o = FENCE_OUTSIDE;
  if (!cells.every(p => p.x >= r.x1 - o && p.x <= r.x2 + o && p.z >= r.z1 - o && p.z <= r.z2 + o)) return false;
  return cells.some(p => by(p, q => yard.fence.has(key(q))));
}

/** Something stands on the block, hangs from it or is hung on its side (cells of its own cluster go first). */
function holds(p: Pos, at: (p: Pos) => string, mine: Set<string>): boolean {
  const up = { ...p, y: p.y + 1 }, down = { ...p, y: p.y - 1 };
  if (!mine.has(key(up)) && ON_TOP.test(idOf(at(up)))) return true;
  if (!mine.has(key(down)) && HANGS.test(idOf(at(down)))) return true;
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => SIDE_ATTACHED.test(idOf(at({ x: p.x + dx, y: p.y, z: p.z + dz }))));
}

export function tidyGoal(rt: ClientRuntime): Goal {
  return {
    name: 'tidy',
    priority: 34,
    timeoutMs: 6 * MINUTE,
    retryMs: 30 * MINUTE,
    wants: (s, world) => {
      if (s.activity !== 'work' || s.sleeping || !s.home || !roundFrom(s, world, REACH) || s.dimension !== 'overworld') return null;
      // after 20 min, and then in the evening, or when no trip could go instead (or it has waited 40): the morning is the trips'
      return roundDue(s, world, 'tidy', 20 * MINUTE) ? 'daily round: stray blocks on the lawn' : null;
    },
    // within its reach it cuts in as ever; from out in the yard it waits for what runs to end
    cuts: s => nearHome(s, REACH),
    run: async run => {
      // from out in the yard, home first (on foot): its digs go from where the bot then stands, as they always did
      const ctx: GoalContext = { ...run, s: await toRound(run, REACH) };
      done(ctx.world, 'tidy', ctx.s.now);
      const yard = await yardOf(ctx);
      const box = { x: yard.x1 - 2, y: yard.y - 3, z: yard.z1 - 2, width: yard.x2 - yard.x1 + 5, height: 14, length: yard.z2 - yard.z1 + 5 };
      const blocks = await readBox(ctx, box);
      const builtList = rt.builtNear({ x: (yard.x1 + yard.x2) / 2, y: yard.y, z: (yard.z1 + yard.z2) / 2 }, 64);
      const built = new Set(builtList.map(b => key(b.at)));
      const r = survey(box, blocks, p => built.has(key(p)));
      // the fence as it stands (none while it is being moved out: its old side is coming down)
      const ring = yardRing(ctx.world);
      const region = regionOf(blocks, box);
      const at = (p: Pos) => region.at(p) ?? '';
      const fence = ring && { ring, fence: yardFence(builtList.map(b => b.at), at, ring), at };
      const cells = strayCells(r.placed, yard.y, built, fence).slice(0, 40);
      if (!cells.length) return 'the lawn is clear';
      const tries = (ctx.world.tidyTries ??= {});
      const todo = cells.filter(c => (tries[key(c)] ?? 0) < TRIES);
      if (!todo.length) return `${cells.length} stray block(s) out of reach on foot: left be`;
      const here = { at: ctx.s.position };
      const gone = new Set<string>();
      let dug = 0, byFence = 0;
      for (const c of todo) {
        if (ctx.signal.aborted) break;
        const k = key(c);
        // only the cell's place: digByHand hands what it is given on to the bridge
        const why = await digByHand(ctx, blocks, box, { x: c.x, y: c.y, z: c.z }, here, gone);
        if (!why) { dug++; if (c.fence) byFence++; gone.add(k); delete tries[k]; } else tries[k] = (tries[k] ?? 0) + 1;
      }
      // forget strays that are gone (dug, or taken down by someone else)
      for (const k of Object.keys(tries)) if (!cells.some(c => key(c) === k)) delete tries[k];
      return `cleared ${dug} of ${todo.length} stray block(s)${byFence ? ` (${byFence} against the yard fence)` : ''}${todo.length < cells.length ? ` (${cells.length - todo.length} out of reach, left be)` : ''}`;
    }
  };
}
