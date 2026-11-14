import type { ClientRuntime } from '../tools.js';
import { survey, type Cluster } from '../survey.js';
import { nearHome, type Goal, type GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { readBox, yardOf } from './milestones.js';
import { digByHand } from '../structures/job.js';
import { HANGS, SIDE_ATTACHED, regionOf } from '../structures/tidy.js';
import { onEdge, onRing, yardRing, type FenceRing } from './fence.js';
import { roundDue, roundFrom, toRound } from './work.js';
import { reservedSites } from './progress.js';
import { takeFromChests } from './chests.js';

/**
 * Once a day: take away the stray blocks left standing on the lawn: an emergency wall-in, Baritone's scaffold, a
 * pillar it climbed. Only what survey-area calls placed-looking, only above the yard's ground (a filled hole is meant
 * to stay), only the scaffold kinds (dirt and cobblestone: never planks or anything else someone may have built
 * with), never next to a built block, and only small clusters. Scaffold against the yard fence is the one exception
 * to the last two (strayCells). Dug by hand, from a spot it walks to without breaking or placing anything: Baritone's
 * own dig lifts the protection on everything but furniture while it walks into reach, and reaching a stray up by the
 * watchtower it cut logs and cobblestone out of the tower, every day. A stray it can't get at twice is left be.
 *
 * Before the blocks, stray fluid (strayFluids): a water or lava source on the lawn that nothing of the bot's keeps, a
 * pour that went astray. A block is placed into it (a placement is a click on a face, which the server takes where the
 * bridge says, unlike a bucket's use along the look) and dug out again, which dries its flow.
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

// ------------------------------------------------------------------------------------------------ stray fluid

/** A water or lava source the sweep plugs: where, which, and the block under it (farmland under a plug turns to dirt). */
export interface StrayFluid extends Pos { fluid: 'water' | 'lava'; under: string }

/** How long the flow of a plugged source takes to dry before the bot walks or tills by it (ms; tests set 0). */
export const FLUID_TIMING = { dry: 2500 };
/** Stray sources plugged in one round, at most. */
const FLUID_BATCH = 4;
/** Three or more sources together are a pond (a well, the lake's arm): never a stray pour, which is one source. */
const POND = 3;
/** The plug's cell centre from the eye, at most: every face the bridge may click against is then within its 4.5. */
const PLUG_REACH = 3.9;
/** How far out from a source the flow is looked along for dry ground to wade in from (water runs 7 on the flat). */
const WADE_LOOK = 10;

const name = (b: string | null | undefined) => (b ?? '').replace(/^minecraft:/, '');
const SOURCE = /^(water|lava)(\[level=0\])?$/;
/** Its flow (or a fall), never a source: the bot may wade through it. */
const FLOWING_WATER = /^water\[level=([1-9]|1[0-5])\]$/;
/**
 * Feet and head room on dry ground: air, what a player walks through, and a wooden door's cell (Baritone opens it;
 * no water runs into it). Live the storage house's spill stood 3 in front of its door, its flow over every cell
 * outside, and the doorway was the one dry cell in reach of it.
 */
const ROOM_FOR = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|bush|dandelion|poppy|.*_tulip|oxeye_daisy|cornflower|azure_bluet|allium|leaf_litter|wildflowers|pink_petals|snow|wheat|carrots|potatoes|beetroots|(?!iron_)[a-z_]+_door)(\[|$)/;
/** Nothing to stand on. */
const NO_FLOOR = /^(|air|cave_air|void_air|water|lava|bubble_column|fire|soul_fire|magma_block|powder_snow|.*_fence|.*_wall|.*_fence_gate|.*_door|.*_trapdoor|.*torch|.*_sign|.*_carpet|.*_pressure_plate|.*_button|ladder|vine|short_grass|tall_grass|fern|large_fern|.*_leaves|scaffolding|cobweb|sweet_berry_bush|cactus|.*campfire|wheat|carrots|potatoes|beetroots|.*_sapling|sugar_cane|dandelion|poppy|leaf_litter|snow)(\[|$)/;
/** Baritone does not walk onto farmland (it would trample it): no walk of its ends there. */
const FARMLAND = /^farmland(\[|$)/;
const HOT = /^(|lava|fire|soul_fire|magma_block)(\[|$)/;
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;

/**
 * Who keeps the water or lava at a cell, or undefined: the zones' landmark cells of water or lava (`<build>:water`:
 * the workshop's floor cell), each crop plot's middle, the cast pit (its lava and the water over it), the water beside
 * the ground a cane stands on, and anything in a site the project keeps (a plot's water is poured before its zone is
 * put down, the workshop's step plugs its own stray pour).
 */
export function fluidOwner(world: WorldMemory): (p: Pos) => string | undefined {
  const cells = new Map<string, string>();
  for (const [kind, zs] of Object.entries(world.zones ?? {})) {
    const m = /^(.+):(water|lava)$/.exec(kind);
    if (m) for (const z of zs) cells.set(key(z), `the ${m[1]}'s ${m[2]}`);
  }
  for (const z of world.zones?.plot ?? []) cells.set(key({ x: z.x + Math.floor((z.width ?? 9) / 2), y: z.y, z: z.z + Math.floor((z.length ?? 9) / 2) }), "the crop plot's water");
  for (const c of world.zones?.['obsidian:cast'] ?? []) for (const y of [c.y, c.y - 1]) cells.set(key({ ...c, y }), 'the cast pit');
  for (const c of world.zones?.cane ?? []) for (const [dx, dz] of SIDES) cells.set(key({ x: c.x + dx, y: c.y - 1, z: c.z + dz }), "the cane's water");
  const sites = reservedSites(world.progress).filter(b => b.width && b.length);
  return p => cells.get(key(p)) ??
    (sites.some(b => p.x >= b.x && p.x < b.x + b.width! && p.z >= b.z && p.z < b.z + b.length!) ? "the project's site" : undefined);
}

/**
 * The stray water and lava sources in the yard, and the ones kept (with who keeps them). Looked for strictly inside the
 * fence (never on it or past it), on the lawn (the yard's ground y + 1) and in a hole in it (its ground y). Kept: a
 * cell of the bot's builds (`built`), what `owner` names, and a pond (POND sources together, of the same fluid). The
 * live spills (Nov 14): water at (-542, 63, 2161) on the crop plot, 3 in front of the workshop's door, and at
 * (-547, 63, 2189), 3 in front of the storage house's; their flow walled both doors off for Baritone.
 */
export function strayFluids(at: (p: Pos) => string, yard: { x1: number; z1: number; x2: number; z2: number; y: number },
  owner: (p: Pos) => string | undefined, built: Set<string>): { stray: StrayFluid[]; kept: { at: Pos; why: string }[] } {
  const stray: StrayFluid[] = [], kept: { at: Pos; why: string }[] = [];
  const fluidAt = (p: Pos) => SOURCE.exec(name(at(p)))?.[1] as 'water' | 'lava' | undefined;
  // sources of the same fluid joined to p, counted up to POND
  const together = (p: Pos, fluid: string) => {
    const seen = new Set([key(p)]), todo = [p];
    while (todo.length && seen.size < POND) {
      const q = todo.pop()!;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const n = { x: q.x + dx, y: q.y + dy, z: q.z + dz };
        if (seen.has(key(n)) || fluidAt(n) !== fluid) continue;
        seen.add(key(n)); todo.push(n);
      }
    }
    return seen.size;
  };
  for (const y of [yard.y + 1, yard.y]) for (let z = yard.z1 + 1; z < yard.z2; z++) for (let x = yard.x1 + 1; x < yard.x2; x++) {
    const p = { x, y, z };
    const fluid = fluidAt(p);
    if (!fluid) continue;
    const why = built.has(key(p)) ? "a cell of the bot's builds" : owner(p) ?? (together(p, fluid) >= POND ? 'a pond' : undefined);
    if (why) kept.push({ at: p, why });
    else stray.push({ ...p, fluid, under: name(at({ ...p, y: y - 1 })) });
  }
  return { stray, kept };
}

/** A spot to plug a source from: walked to carefully, or (`shore`) walked to the dry ground there, then waded in. */
export interface PlugSpot { at: Pos; shore?: Pos }

/**
 * Where to stand to plug the source `t`: feet one or two over its floor, a floor to stand on, the plug's cell in reach
 * (PLUG_REACH from the eye). Dry spots first (feet and head clear, not on farmland: Baritone's walk won't end there),
 * nearest `from`. Then, for water only, a spot in its own flow: water on the flat runs 7 blocks, so every dry spot is
 * out of reach of a source poured on the open lawn. Those lie on the four lines out from the source, the one nearest
 * the dry ground on each, with the dry ground (the shore) the wade starts from and only flow, room and floor between
 * (no hole, no wall); shortest wade first. Lava: dry spots only, 2 or more from it, nothing hot round the feet.
 */
export function plugSpots(at: (p: Pos) => string, t: Pos, from: Pos, fluid: 'water' | 'lava'): PlugSpot[] {
  const b = (p: Pos) => name(at(p));
  const reach = (f: Pos) => Math.hypot(f.x - t.x, f.y + 1.12 - t.y, f.z - t.z) <= PLUG_REACH;
  const floored = (f: Pos) => !NO_FLOOR.test(b({ ...f, y: f.y - 1 }));
  const dry = (f: Pos) => floored(f) && ROOM_FOR.test(b(f)) && ROOM_FOR.test(b({ ...f, y: f.y + 1 }));
  const wet = (f: Pos) => floored(f) && FLOWING_WATER.test(b(f)) && (ROOM_FOR.test(b({ ...f, y: f.y + 1 })) || FLOWING_WATER.test(b({ ...f, y: f.y + 1 })));
  const hot = (f: Pos) => {
    for (let y = f.y - 1; y <= f.y + 1; y++) for (let z = f.z - 1; z <= f.z + 1; z++) for (let x = f.x - 1; x <= f.x + 1; x++) if (HOT.test(b({ x, y, z }))) return true;
    return false;
  };
  const dryOut: { at: Pos; d: number }[] = [];
  for (const fy of [t.y, t.y + 1]) for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
    const f = { x: t.x + dx, y: fy, z: t.z + dz };
    if ((!dx && !dz) || !reach(f) || !dry(f) || FARMLAND.test(b({ ...f, y: fy - 1 }))) continue;
    if (fluid === 'lava' && (Math.max(Math.abs(dx), Math.abs(dz)) < 2 || hot(f))) continue;
    dryOut.push({ at: f, d: Math.hypot(f.x - from.x, f.y - from.y, f.z - from.z) });
  }
  const out: PlugSpot[] = dryOut.sort((a, c) => a.d - c.d).map(o => ({ at: o.at }));
  if (fluid !== 'water') return out;
  const wades: { at: Pos; shore: Pos; n: number }[] = [];
  for (const fy of [t.y, t.y + 1]) for (const [dx, dz] of SIDES) {
    let spot: { at: Pos; m: number } | undefined;
    for (let m = 1; m <= WADE_LOOK; m++) {
      const f = { x: t.x + dx * m, y: fy, z: t.z + dz * m };
      if (wet(f)) { if (reach(f)) spot = { at: f, m }; continue; }
      // the first dry cell out along the line is the shore, if a walk may end there; anything else ends the line
      if (spot && dry(f) && !FARMLAND.test(b({ ...f, y: fy - 1 }))) wades.push({ at: spot.at, shore: f, n: m - spot.m });
      break;
    }
  }
  return [...out, ...wades.sort((a, c) => a.n - c.n).map(w => ({ at: w.at, shore: w.shore }))];
}

/** What plugs a source: on the lawn a block dug out again (cobblestone first); in a hole, dirt first (it stays: the hole filled). */
const PLUGS = { lawn: ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff'], hole: ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff'] };

type InvItems = { items: { name: string; count: number; slot: number }[] };
const carriedOf = async (ctx: GoalContext) => (await ctx.call<InvItems>('inventory').catch((): InvItems => ({ items: [] }))).items.filter(i => i.slot < 36);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Plug one stray source and, on the lawn, dig the plug out again (in a hole it stays: the hole filled); farmland under
 * it comes back as dirt and is tilled back with a carried hoe. Returns the log's words, `ok` when it was plugged.
 */
async function plugFluid(ctx: GoalContext, f: StrayFluid, groundY: number, here: { at: Pos }): Promise<{ ok: boolean; text: string }> {
  const what = `a stray ${f.fluid} source at ${fmt(f)}`;
  // round it as it is now, not as the round's first look had it: a plug before this one dried a flow, a lava flow spreads
  const near = { x: f.x - WADE_LOOK, y: f.y - 2, z: f.z - WADE_LOOK, width: 2 * WADE_LOOK + 1, height: 5, length: 2 * WADE_LOOK + 1 };
  const look = regionOf(await readBox(ctx, near), near);
  const at = (p: Pos) => look.at(p) ?? '';
  if (!SOURCE.test(name(at(f)))) return { ok: true, text: `${what}: gone before it was plugged (${name(at(f)) || 'unknown'})` };
  const hole = f.y <= groundY;
  const kinds = hole ? PLUGS.hole : PLUGS.lawn;
  let items = await carriedOf(ctx);
  if (!kinds.some(k => items.some(i => i.name === k))) {
    await takeFromChests(ctx, 'cobblestone', 4);
    items = await carriedOf(ctx);
  }
  const plug = kinds.find(k => items.some(i => i.name === k));
  if (!plug) return { ok: false, text: `${what} not plugged: no block carried or stored to plug it with` };
  const feet = () => ({ x: Math.floor(here.at.x), y: Math.floor(here.at.y), z: Math.floor(here.at.z) });
  const same = (a: Pos, c: Pos) => a.x === c.x && a.y === c.y && a.z === c.z;
  const spots = plugSpots(at, f, feet(), f.fluid);
  if (!spots.length) return { ok: false, text: `${what} not plugged: no ${f.fluid === 'lava' ? 'safe ' : ''}spot in reach of it to stand at` };
  type Placed = { placed: boolean; reason?: string };
  type Walk = { arrived: boolean; at?: Pos };
  const whys: string[] = [];
  // back out of the flow to the shore it waded in from, with the current (at the floor's height, as in): Baritone
  // plans no walk from inside a flow (it never paths through flowing water), and the current alone takes about 10 s to
  // carry the bot out, so the next spot's walk failed at once and used up the source's try
  const ashore = async ({ shore }: PlugSpot) => {
    if (!shore) return;
    await ctx.call('steer', { x: shore.x + 0.5, y: shore.y - 1, z: shore.z + 0.5, within: 0.5, timeoutMs: 6_000 }, 10_000).catch(() => undefined);
    const st = await ctx.call<{ position?: Pos }>('status').catch(() => ({}) as { position?: Pos });
    if (st.position) here.at = st.position;
  };
  let placed = false;
  for (const s of spots.slice(0, 3)) {
    if (ctx.signal.aborted) return { ok: false, text: `${what}: stopped` };
    if (!same(feet(), s.at)) {
      // on foot only (A11): Baritone breaks and places nothing on the way, and it never walks in flowing water
      const g = await ctx.call<Walk>('goto', { ...(s.shore ?? s.at), range: 0, careful: true, timeoutMs: 30_000 }, 45_000).catch((): Walk => ({ arrived: false }));
      if (g.at) here.at = g.at;
      if (!g.arrived) { whys.push(`no way on foot to ${fmt(s.shore ?? s.at)}`); continue; }
      if (s.shore) {
        // in through its flow, straight: the floor's height (it never hops in the shallow water: a jump onto
        // farmland tramples it)
        await ctx.call('steer', { x: s.at.x + 0.5, y: s.at.y - 1, z: s.at.z + 0.5, within: 0.35, timeoutMs: 10_000 }, 15_000).catch(() => undefined);
        const st = await ctx.call<{ position?: Pos }>('status').catch(() => ({}) as { position?: Pos });
        if (st.position) here.at = st.position;
        if (!same(feet(), s.at)) { whys.push(`could not wade to ${fmt(s.at)}`); await ashore(s); continue; }
      }
    }
    await ctx.call('item.select', { name: plug }).catch(() => undefined);
    const r = await ctx.call<Placed>('place', { x: f.x, y: f.y, z: f.z, face: 'down' }).catch((e: unknown): Placed => ({ placed: false, reason: e instanceof Error ? e.message : String(e) }));
    if (r.placed) { placed = true; break; }
    whys.push(`from ${fmt(s.at)}: ${r.reason ?? 'not placed'}`);
    await ashore(s);
  }
  if (!placed) return { ok: false, text: `${what} not plugged: ${whys.join('; ')}` };
  if (hole) return { ok: true, text: `${what} plugged (the hole filled with ${plug})` };
  // dug out from where it stands: the flow is gone with its source
  const d = await ctx.call<{ dug: boolean; reason?: string }>('dig.here', { x: f.x, y: f.y, z: f.z, timeoutMs: 15_000 }, 25_000)
    .catch((e: unknown) => ({ dug: false, reason: e instanceof Error ? e.message : String(e) }));
  await sleep(FLUID_TIMING.dry);
  // (left standing it is a stray block on the lawn: the next round's to dig)
  const cleared = d.dug || d.reason === 'air' ? 'plugged and cleared' : `plugged; the ${plug} not dug out (${d.reason ?? 'not dug'})`;
  if (!FARMLAND.test(f.under)) return { ok: true, text: `${what} ${cleared}` };
  // a block on farmland turns it to dirt: tilled back from where it stands (the farm round only harvests and sows)
  const hoe = (await carriedOf(ctx)).find(i => /_hoe$/.test(i.name))?.name;
  if (!hoe) return { ok: true, text: `${what} ${cleared}; the farmland under it is dirt now (no hoe carried to till it back)` };
  const till = await ctx.act('use-item-on-block', { x: f.x, y: f.y - 1, z: f.z, item: hoe, face: 'up' }).catch((e: unknown) => ({ ok: false, text: e instanceof Error ? e.message : String(e) }));
  return { ok: true, text: `${what} ${cleared}; ${/farmland/.test(till.text) ? 'the farmland under it tilled back' : `the farmland under it is dirt now (${till.text.slice(0, 80)})`}` };
}

/**
 * The stray fluid of the yard plugged, nearest first; its words for the round's reply, whether a block changed, and
 * whether any stays. What stays is named by where it is: lava out on the lawn is never walked up to, so it is a hand's
 * to clear, and the round's "the lawn is clear" with no place named read as nothing wrong.
 */
async function sweepFluids(ctx: GoalContext, at: (p: Pos) => string, yard: { x1: number; z1: number; x2: number; z2: number; y: number },
  built: Set<string>, here: { at: Pos }): Promise<{ text: string; changed: boolean; stays: boolean }> {
  const { stray } = strayFluids(at, yard, fluidOwner(ctx.world), built);
  const tk = (p: Pos) => `fluid:${key(p)}`;
  // forget the ones gone (plugged, or dried up some other way)
  for (const k of Object.keys(ctx.world.tidyTries ?? {})) if (k.startsWith('fluid:') && !stray.some(f => tk(f) === k)) delete ctx.world.tidyTries![k];
  if (!stray.length) return { text: '', changed: false, stays: false };
  const tries = (ctx.world.tidyTries ??= {});
  const d = (p: Pos) => Math.hypot(p.x - here.at.x, p.y - here.at.y, p.z - here.at.z);
  const todo = stray.filter(f => (tries[tk(f)] ?? 0) < TRIES).sort((a, b) => d(a) - d(b)).slice(0, FLUID_BATCH);
  const gone = new Set<string>();
  for (const f of todo) {
    if (ctx.signal.aborted) break;
    const r = await plugFluid(ctx, f, yard.y, here);
    // a round cut short is no try at it
    if (ctx.signal.aborted && !r.ok) break;
    ctx.progress(r.text);
    if (r.ok) { gone.add(tk(f)); delete tries[tk(f)]; } else tries[tk(f)] = (tries[tk(f)] ?? 0) + 1;
  }
  const kinds = [...new Set(stray.map(f => f.fluid))].join(' and ');
  const named = (fs: StrayFluid[]) => fs.slice(0, 3).map(f => `${f.fluid} at ${fmt(f)}`).join(', ') + (fs.length > 3 ? ` and ${fs.length - 3} more` : '');
  // what stays: tried this round and not plugged; left be (tried twice already: a hand's to clear); for the next round
  const failed = todo.filter(f => !gone.has(tk(f)));
  const leftBe = stray.filter(f => !todo.includes(f) && (tries[tk(f)] ?? 0) >= TRIES);
  const later = stray.length - todo.length - leftBe.length;
  return {
    text: `plugged ${gone.size} of ${todo.length} stray ${kinds} source(s)` + (failed.length ? `; not plugged: ${named(failed)}` : '') +
      (leftBe.length ? `; left be after two tries, for a hand to clear: ${named(leftBe)}` : '') + (later ? `; ${later} more for the next round` : ''),
    changed: gone.size > 0,
    stays: failed.length + leftBe.length + later > 0
  };
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
      let blocks = await readBox(ctx, box);
      const builtList = rt.builtNear({ x: (yard.x1 + yard.x2) / 2, y: yard.y, z: (yard.z1 + yard.z2) / 2 }, 64);
      const built = new Set(builtList.map(b => key(b.at)));
      const here = { at: ctx.s.position };
      // stray fluid first: its flow walls doors off for Baritone, and the walks to the stray blocks with them
      const first = regionOf(blocks, box);
      const fluids = await sweepFluids(ctx, p => first.at(p) ?? '', yard, built, here);
      if (fluids.changed && !ctx.signal.aborted) blocks = await readBox(ctx, box);
      const said = (text: string) => (fluids.text ? `${fluids.text}; ${text}` : text);
      const r = survey(box, blocks, p => built.has(key(p)));
      // the fence as it stands (none while it is being moved out: its old side is coming down)
      const ring = yardRing(ctx.world);
      const region = regionOf(blocks, box);
      const at = (p: Pos) => region.at(p) ?? '';
      const fence = ring && { ring, fence: yardFence(builtList.map(b => b.at), at, ring), at };
      const cells = strayCells(r.placed, yard.y, built, fence).slice(0, 40);
      // (with stray fluid still on it the lawn is not clear: its blocks are)
      if (!cells.length) return said(fluids.stays ? 'no stray blocks' : 'the lawn is clear');
      const tries = (ctx.world.tidyTries ??= {});
      const todo = cells.filter(c => (tries[key(c)] ?? 0) < TRIES);
      if (!todo.length) return said(`${cells.length} stray block(s) out of reach on foot: left be`);
      const gone = new Set<string>();
      let dug = 0, byFence = 0;
      for (const c of todo) {
        if (ctx.signal.aborted) break;
        const k = key(c);
        // only the cell's place: digByHand hands what it is given on to the bridge
        const why = await digByHand(ctx, blocks, box, { x: c.x, y: c.y, z: c.z }, here, gone);
        if (!why) { dug++; if (c.fence) byFence++; gone.add(k); delete tries[k]; } else tries[k] = (tries[k] ?? 0) + 1;
      }
      // forget strays that are gone (dug, or taken down by someone else); the fluid's are the sweep's own
      for (const k of Object.keys(tries)) if (!k.startsWith('fluid:') && !cells.some(c => key(c) === k)) delete tries[k];
      return said(`cleared ${dug} of ${todo.length} stray block(s)${byFence ? ` (${byFence} against the yard fence)` : ''}${todo.length < cells.length ? ` (${cells.length - todo.length} out of reach, left be)` : ''}`);
    }
  };
}
