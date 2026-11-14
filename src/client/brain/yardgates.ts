/**
 * The yard's fence as the walks cross it: by its gates, both ways. A walk that leaves the yard from inside the fence
 * goes out by a gate first (outByGate, leaveYard), and a walk home from outside it comes in by one (inByGate), each
 * through the gate's two cells, 2 inside it and 2 outside, on their own floors. Inside the yard, and out in the wild,
 * the walks are as they were.
 *
 * Why: Baritone does whatever is cheapest, and over the fence on a block or two of cobblestone is cheaper than the
 * walk round to a gate. Live on Nov 13 it had left a cobblestone stair over the north gate, scaffold along the east
 * fence up to y 67 (on the posts, on a torch) and stray blocks inside the yard; the user: "we need to work on making
 * sure the bot never uses scaffolding to get over the homestead fences". The client mod now refuses Baritone's
 * throwaway blocks within 2 of the fence (FenceScaffoldMixin), so with no gate on its way a walk finds a gate itself
 * or no way at all; this keeps the walks on the gates' cells in the first place, and off "any height at this x and
 * z" by the yard, which the caves under it answer too.
 *
 * The pens' fences the same way (outOfPen): a walk that sets out from inside a pen leaves by the pen's gate first.
 *
 * (Here, not in work.ts: homeward.ts's walk home comes in by a gate, and work.ts imports homeward.ts. Nothing from
 * goals.ts is used at this module's top level: goals.ts imports homeward.ts, which imports this. Nor is pens.ts
 * imported: it imports this, through work.ts, and builds its goal at its top level.)
 */
import { brainRun } from '../tools.js';
import { BELOW_HOME, outsideBy, YARD_EDGE, type GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';

/** A side of home, and its step on the map. */
export type HomeSide = 'north' | 'east' | 'south' | 'west';
export const SIDE_STEP: Record<HomeSide, [number, number]> = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };

/**
 * What the walks through a gate use of a goal's context (a trip's helpers are handed no more than this): `act` for
 * the click on a pen's gate (outOfPen).
 */
export type WalkContext = Pick<GoalContext, 's' | 'world' | 'signal' | 'call' | 'status' | 'progress' | 'act'>;

const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;

/**
 * Strictly inside the yard's fence (the fence line itself is not inside: the gates stand on it). The walks into the
 * yard (a fetch with its animal, pens.ts) and out of it (the side walks, the fetch's walk to an animal) go by this.
 */
export function inFence(world: WorldMemory, q: { x: number; z: number }): boolean {
  const y = world.yard;
  return !!y && Math.floor(q.x) > y.x1 && Math.floor(q.x) < y.x2 && Math.floor(q.z) > y.z1 && Math.floor(q.z) < y.z2;
}

/** A gate in the yard's fence as a walk through it goes: the side it is on, and the cells 2 inside and 2 outside it. */
export interface YardGate { gate: Pos; side: HomeSide; inner: Pos; outer: Pos }

const mid = (c: { x: number; z: number }) => ({ x: c.x + 0.5, z: c.z + 0.5 });

/** The yard's gates (world memory's `fence:gate`, those on its fence line), in the order memory keeps them. */
export function yardGates(world: WorldMemory): YardGate[] {
  const yard = world.yard;
  if (!yard) return [];
  const gates: YardGate[] = [];
  for (const g of world.zones?.['fence:gate'] ?? []) {
    const side: HomeSide | undefined = g.z === yard.z1 ? 'north' : g.z === yard.z2 ? 'south' : g.x === yard.x1 ? 'west' : g.x === yard.x2 ? 'east' : undefined;
    if (!side) continue;
    const [dx, dz] = SIDE_STEP[side];
    gates.push({ gate: { x: g.x, y: g.y, z: g.z }, side, inner: { x: g.x - 2 * dx, y: g.y, z: g.z - 2 * dz }, outer: { x: g.x + 2 * dx, y: g.y, z: g.z + 2 * dz } });
  }
  return gates;
}

/**
 * The yard's gates by the way each makes between a place inside the fence and one outside it, the shortest first: to
 * its cell on the near side, through it, and on from its cell on the far side (the same either way round: a fetch
 * walks in by it, a side walk out, and the walk home in).
 */
export function gatesBetween(world: WorldMemory, inside: { x: number; z: number }, outside: { x: number; z: number }): YardGate[] {
  return yardGates(world).map(g => ({ len: horiz(outside, mid(g.outer)) + 4 + horiz(mid(g.inner), inside), g }))
    .sort((a, b) => a.len - b.len).map(w => w.g);
}

/** A place far out on that side of `from`: what a walk along the side (explore) leaves the yard toward. */
const beyond = (from: { x: number; z: number }, side: HomeSide): { x: number; z: number } =>
  ({ x: from.x + SIDE_STEP[side][0] * 1000, z: from.z + SIDE_STEP[side][1] * 1000 });

/** What a body stands in and walks through: the air, and what grows on the ground or hangs on a wall. */
export const CLEAR = /^(minecraft:)?(air|cave_air|short_grass|tall_grass|fern|large_fern|dead_bush|bush|leaf_litter|dandelion|poppy|\w+_tulip|cornflower|oxeye_daisy|azure_bluet|allium|blue_orchid|lily_of_the_valley|snow|torch|wall_torch)(\[|$)/;
const WET = /^(minecraft:)?(flowing_)?(water|lava)(\[|$)/;

/**
 * Where to stand at a cell by a gate: on its own floor within 3 of the gate's level, the nearest to that level first
 * (the ground outside a gate is not always the yard's: outside the live yard's west gate it is 3 higher, outside its
 * north gate a hill); the gate's level where the look fails or finds none.
 */
async function floorAt(ctx: WalkContext, cell: Pos): Promise<Pos> {
  const box = { x: cell.x, y: cell.y - 4, z: cell.z, width: 1, height: 9, length: 1 };
  const col = (await ctx.call<{ blocks?: (string | null)[] }>('world.region', box).catch(() => undefined))?.blocks;
  if (!col || col.length < box.height) return cell;
  const clear = (b: string | null | undefined) => !!b && CLEAR.test(b);
  const floor = (b: string | null | undefined) => !!b && !CLEAR.test(b) && !WET.test(b);
  for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
    const i = 4 + dy;
    if (floor(col[i - 1]) && clear(col[i]) && clear(col[i + 1])) return { ...cell, y: cell.y + dy };
  }
  return cell;
}

/**
 * Out of the yard by one of its gates, from strictly inside the fence toward `to` outside it: a careful walk (walk
 * only) to the cell 2 inside the gate that makes the shortest way, then through it to the cell 2 outside, each on
 * its own floor. Never "any height at this x and z" from in here: a cave under the yard answers that as
 * well as the gate does. Live on Nov 13 the cows' walk from 32 out north (inside the yard) to 64 out (the north gate
 * itself) went down three times in 20 min, 30 to 41 under the lawn: in front of the gate the way on foot was shut
 * (cells Baritone keeps out of), and the gate's column was there to be had in the cave 30 under it, by the pit at the
 * gap in the east fence. Out from under dug it out each time. `toward` a side: a walk along it (explore), as to a place
 * far out that way; undefined: a walk whose end is not known when it sets out (the miner's), by the gate nearest the
 * bot. `sides`: only the gates on these sides of the fence
 * (a side walk's own: from another side's gate its walk on to "any height" at the stop goes round the fence, or back
 * across the yard, by the same caves). Each walk is to within 1 of its cell: still a block on the ground, which no
 * cave far below answers, and one a bot on a dirt path (its block is the path's own, under the cell) or in a plant
 * floorAt took for a floor (pink petals, a sapling, a carpet) gets to; to the block itself it "did not arrive".
 * From inside one of the bot's pens it goes out by the pen's gate first, the gate shut behind (outOfPen), whatever
 * comes after. `{}`: nothing to do (the bot not inside the fence, `to` not outside it, or no gate known); `shut`: no
 * gate let it out (one gone or blocked: the next is tried), or none on those sides; `gate` and `at` once out.
 */
export async function outByGate(ctx: WalkContext, toward: { x: number; z: number } | HomeSide | undefined, sides?: HomeSide[]): Promise<{ gate?: Pos; at?: Pos; shut?: string }> {
  // out of a pen by its gate first, where a round given up left the bot (outOfPen): the yard's gate is then the one
  // that makes the shortest way from the pen's gate
  await outOfPen(ctx);
  // (no yard or no gate known: nothing to do, and no look needed to say so)
  if (!yardGates(ctx.world).length) return {};
  const me = (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
  const to = typeof toward === 'string' ? beyond(me, toward) : toward;
  if (!inFence(ctx.world, me) || (to && inFence(ctx.world, to))) return {};
  const all = to ? gatesBetween(ctx.world, me, to) : yardGates(ctx.world).sort((a, b) => horiz(mid(a.inner), me) - horiz(mid(b.inner), me));
  if (!all.length) return {};
  const gates = sides ? all.filter(g => sides.includes(g.side)) : all;
  if (!gates.length) return { shut: `no gate in the yard's ${sides!.join(' or ')} fence` };
  const tried: string[] = [];
  for (const g of gates) {
    if (ctx.signal.aborted) throw new Error('aborted');
    ctx.progress(`out of the yard by its ${g.side} gate (${g.gate.x}, ${g.gate.y}, ${g.gate.z})`);
    let arrived = true;
    for (const c of [g.inner, g.outer]) {
      const at = await floorAt(ctx, c);
      const r = await ctx.call<{ arrived?: boolean }>('goto', { ...at, range: 1, careful: true, timeoutMs: 90_000 }, 105_000).catch(() => ({ arrived: false }));
      if (ctx.signal.aborted) throw new Error('aborted');
      if (r?.arrived === false) { arrived = false; break; }
    }
    const now = (await ctx.status().catch(() => undefined))?.position;
    // out: within the walk's 1 of the cell outside, or at it or past it however the walk ended; never in the gateway
    // itself (the fence line is not inside, but a walk to "any height" from there is the one this way keeps from)
    const [dx, dz] = SIDE_STEP[g.side];
    const past = (p: { x: number; z: number }) => (Math.floor(p.x) - g.gate.x) * dx + (Math.floor(p.z) - g.gate.z) * dz;
    if (now ? past(now) >= (arrived ? 1 : 2) : arrived) return { gate: g.gate, at: now ?? g.outer };
    tried.push(`the ${g.side} gate (${g.gate.x}, ${g.gate.y}, ${g.gate.z})`);
  }
  return { shut: `no way out of the yard by ${tried.join(' or ')}` };
}

/**
 * Out of the yard by a gate before a walk that leaves it (outByGate): `toward` a place, by the gate (any of them) that
 * makes the shortest way there; a side (a walk along it, explore), by that side's own gate only, as alongSide goes:
 * out by another side's gate, the walk's first stop along the side is back across the yard, or round the fence, at
 * any height (from the west gate a walk east stops at (-535, 2183), inside the live yard), which the caves under it
 * answer too; for a walk whose end is not known when it sets out (Baritone's miner goes to the nearest ore it knows
 * of, outside the home area), by the gate nearest the bot. The walk then sets out from outside the fence. With no
 * gate that lets it out it goes on as it would have, from where the bot stands (the run's progress says so):
 * Baritone may place nothing by the fence now, so its own way out is a gate it opens itself, or none.
 */
export async function leaveYard(ctx: WalkContext, toward?: { x: number; z: number } | HomeSide): Promise<{ gate?: Pos; at?: Pos; shut?: string }> {
  const r = await outByGate(ctx, toward, typeof toward === 'string' ? [toward] : undefined);
  if (r.shut) ctx.progress(`${r.shut}: on by Baritone's own way`);
  return r;
}

/** explore's shortest walk (its least maxDistance). */
export const EXPLORE_MIN = 16;

/**
 * How far an explore along a side may go from where it sets out and still end within `reach` of home (across the
 * ground): explore measures its maxDistance from where the bot stands, and after leaveYard that is a gate's outer
 * cell, 18 to 66 from home on the live yard. The whole reach from there went up to 66 past the leash (162 out north),
 * and nothing goes past it (the cows' own range aside). `out` is leaveYard's answer: where it got out, else where
 * the bot stands now. Under EXPLORE_MIN there is no explore to be had from there.
 */
export async function exploreReach(ctx: WalkContext, out: { at?: Pos }, reach: number): Promise<number> {
  // (no home known, or a helper's context with no snapshot: the whole reach, as before)
  const home = ctx.s?.home;
  if (!home) return reach;
  // (leaveYard's own `at` first: the run's snapshot is from its start, and a failed look would read home as 0 off)
  const from = out.at ?? (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
  return Math.floor(reach - horiz(from, home));
}

/** From further than this off a gate's outer cell, the walk in gets near it in legs first, as go-home's own legs go. */
const GATE_NEAR = 48;
/** Those legs are walks to "any height at this x and z", so the last ends this far out from the cell: well clear of the caves under the yard and its margin. */
const LEG_END = 32;
/** A leg is this long at most: Baritone plans over the chunks the client has loaded (go-home's legs are as long). */
const LEG = 200;
/** No walk to a gate is set out on with less time than this left: go-home has the rest. */
const GATE_MIN_MS = 30_000;
/** The gate on the way home, and the next: past those, go-home as it went (a walk round the whole yard at dusk would cost the shelter its evening). */
const GATE_TRIES = 2;

/** Whether the straight way across the ground from `a` to `b` keeps further than YARD_EDGE from the yard all along (a step at a time). */
function clearOfYard(yard: NonNullable<WorldMemory['yard']>, a: { x: number; z: number }, b: { x: number; z: number }): boolean {
  const n = Math.ceil(horiz(a, b));
  for (let i = 0; i <= n; i++) {
    const t = n ? i / n : 0;
    if (outsideBy(yard, { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }) <= YARD_EDGE) return false;
  }
  return true;
}

/**
 * Into the yard by one of its gates, from outside the fence on the way home (home inside it): to the cell 2 outside
 * the gate that makes the shortest way home (gatesBetween, as a fetch brings its animal in), then through it,
 * carefully, to the cell 2 inside, each on its own floor; go-home walks on from there, inside the yard, as it always
 * did. From further than GATE_NEAR off that cell it first walks toward it in legs at any height (as go-home's own),
 * the last ending LEG_END out, and only while the straight way keeps clear of the yard and its edge: a leg's "any
 * height" across the yard is the one the caves under it answer too. The walk to the outer cell is careful (walk
 * only) from within YARD_EDGE of the yard, as every walk round the homestead; from further out it is Baritone's own
 * (it may dig or place out there; the client mod refuses its blocks within 2 of the fence, and the zone any dig by
 * the yard). A gate it does not get in by (shut, blocked, a hill outside it), and the next is tried, GATE_TRIES in
 * all, while `budgetMs` lasts. Not from deep down (more than BELOW_HOME under home's level): the walk to a gate would
 * be a climb to the surface, and walkHome climbs out first where it may, and leaves it to go-home's own walk where it
 * may not (at night, in water, under lava or someone's build). `{}`: nothing to do (no yard or gate known, home not
 * inside the fence, the bot inside it already, deep down or in another dimension); `shut`: no gate let it in; `gate`
 * and `at` once in.
 */
export async function inByGate(ctx: WalkContext, budgetMs: number): Promise<{ gate?: Pos; at?: Pos; shut?: string }> {
  const { world } = ctx;
  // (no gate known: nothing to do, and nothing looked at)
  if (!yardGates(world).length) return {};
  const home = ctx.s.home;
  const yard = world.yard!;
  if (!home || !inFence(world, home)) return {};
  const began = Date.now();
  const left = () => budgetMs - (Date.now() - began);
  const stopped = () => { if (ctx.signal.aborted) throw new Error('aborted'); };
  const look = async () => { const st = await ctx.status().catch(() => undefined); stopped(); return st; };
  const st = await look();
  const from = st?.position ?? ctx.s.position;
  if ((st?.dimension ?? ctx.s.dimension) !== home.dimension || inFence(world, from) || from.y < home.y - BELOW_HOME) return {};
  const walk = async (to: Record<string, unknown>, ms: number) => {
    const r = await ctx.call<{ arrived?: boolean }>('goto', { ...to, timeoutMs: ms }, ms + 15_000).catch(() => ({ arrived: false }));
    stopped();
    return r?.arrived !== false;
  };
  const tried: string[] = [];
  for (const g of gatesBetween(world, home, from).slice(0, GATE_TRIES)) {
    if (left() < GATE_MIN_MS) break;
    ctx.progress(`into the yard by its ${g.side} gate ${fmt(g.gate)}`);
    tried.push(`the ${g.side} gate ${fmt(g.gate)}`);
    let me: { x: number; z: number } = (await look())?.position ?? from;
    // (block by block: the bot's block and the cell's)
    const o = g.outer;
    const off = () => horiz({ x: Math.floor(me.x), z: Math.floor(me.z) }, o);
    for (let leg = 0; leg < 10 && off() > GATE_NEAR && left() > GATE_MIN_MS; leg++) {
      const d = off();
      const k = Math.max(LEG_END, d - LEG) / d;
      const stop = { x: Math.round(o.x + (Math.floor(me.x) - o.x) * k), y: o.y, z: Math.round(o.z + (Math.floor(me.z) - o.z) * k) };
      if (!clearOfYard(yard, me, stop)) break;
      await walk({ ...stop, xz: true, range: 8 }, Math.min(240_000, left()));
      const now = (await look())?.position;
      if (!now) break;
      me = now;
      // (no headway on this leg: water, a cliff; the walk to the cell itself is tried from here)
      if (off() >= d - 4) break;
    }
    // (in the gateway already, or just outside it: straight through)
    if (horiz(me, mid(g.gate)) > 1.5) {
      const careful = outsideBy(yard, me) <= YARD_EDGE;
      if (!await walk({ ...await floorAt(ctx, g.outer), range: 1, ...(careful ? { careful: true } : {}) }, Math.min(careful ? 90_000 : 120_000, Math.max(left(), 10_000)))) continue;
    }
    const through = await walk({ ...await floorAt(ctx, g.inner), range: 1, careful: true }, Math.min(90_000, Math.max(left(), 10_000)));
    const now = (await look())?.position;
    if (now ? inFence(world, now) : through) return { gate: g.gate, at: now ?? g.inner };
  }
  return tried.length ? { shut: `no way into the yard by ${tried.join(' or ')}` } : {};
}

// ------------------------------------------------------------------------------------------------ the pens' fences

/**
 * A pen's gate as the walks through it go: the side of the pen it is on, the cell just outside it, the cell two in,
 * and the last row in before the far fence (`deep`).
 */
export interface PenWay { gate: Pos; side: HomeSide; outside: Pos; inside: Pos; deep: Pos }

/** The way through a pen's gate (`gate`, on the pen's fence ring x1..x2, z1..z2), or undefined with no gate. */
export function penGateWay(gate: { x: number; y: number; z: number } | undefined, p: { x1: number; z1: number; x2: number; z2: number }): PenWay | undefined {
  if (!gate) return undefined;
  const side: HomeSide = gate.z === p.z1 ? 'north' : gate.z === p.z2 ? 'south' : gate.x === p.x1 ? 'west' : 'east';
  const [ox, oz] = SIDE_STEP[side];
  const depth = (side === 'north' || side === 'south' ? p.z2 - p.z1 : p.x2 - p.x1) - 1;
  return {
    gate, side, outside: { x: gate.x + ox, y: gate.y, z: gate.z + oz }, inside: { x: gate.x - 2 * ox, y: gate.y, z: gate.z - 2 * oz },
    deep: { x: gate.x - depth * ox, y: gate.y, z: gate.z - depth * oz }
  };
}

/** A pen of the bot's (world memory's `pen:<kind>`): its fence ring, and the way through its gate when one is known. */
export interface PenFence { kind: string; x1: number; z1: number; x2: number; z2: number; way?: PenWay }

/** The bot's pens, in the order memory keeps them. */
export function penFences(world: WorldMemory): PenFence[] {
  return Object.entries(world.zones ?? {}).flatMap(([key, zs]) => {
    const m = /^pen:([a-z]+)$/.exec(key);
    const z = zs?.[0];
    if (!m || !z?.width || !z.length) return [];
    const ring = { x1: z.x, z1: z.z, x2: z.x + z.width - 1, z2: z.z + z.length - 1 };
    const way = penGateWay(world.zones?.[`pen:${m[1]}:gate`]?.[0], ring);
    return [{ kind: m[1], ...ring, ...(way ? { way } : {}) }];
  });
}

/**
 * Inside a pen's fence: between the middles of its posts, at its gate's level (a block either way). Pressed against
 * the fence from inside, the bot's middle lies in the post's own cell (wedge.ts), and it is inside all the same; one
 * pressed against it from outside is not. In the gateway, on the pen's side of the gate's middle, it is in.
 */
export function inPenFence(f: PenFence & { way: PenWay }, q: Pos): boolean {
  return q.x > f.x1 + 0.5 && q.x < f.x2 + 0.5 && q.z > f.z1 + 0.5 && q.z < f.z2 + 0.5 && Math.abs(Math.floor(q.y) - f.way.gate.y) <= 1;
}

const gateIsOpen = async (ctx: WalkContext, g: Pos): Promise<boolean> =>
  /open=true/.test((await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...g, width: 1, height: 1, length: 1 })).blocks[0] ?? '');
const clickGate = (ctx: WalkContext, g: Pos) => ctx.act('use-item-on-block', { ...g, face: 'up', toggle: true });

/**
 * Out of a pen through its gate, the gate shut behind: pens.ts penVisit's way out, and every walk's that sets out
 * from inside a pen (outOfPen). A sword in hand first (the wheat put away: the herd stays in, and does not follow the
 * bot out); a careful walk (walk only) to the cell two in from the gate, the gate opened if it is shut, a careful
 * walk to the cell just outside it, and the gate clicked shut. A step that fails (a walk that ends short, a look at
 * the gate that does not answer) is let go and the next tried: the click shut comes from wherever the bot stands.
 */
export async function throughPenGate(ctx: WalkContext, way: PenWay): Promise<void> {
  const weapon = ctx.s.items.find(i => /_sword$/.test(i.name))?.name;
  if (weapon) await ctx.call('item.select', { name: weapon }).catch(() => undefined);
  await ctx.call('goto', { ...way.inside, range: 0, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
  if (!(await gateIsOpen(ctx, way.gate).catch(() => true))) await clickGate(ctx, way.gate).catch(() => undefined);
  await ctx.call('goto', { ...way.outside, range: 0, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
  if (await gateIsOpen(ctx, way.gate).catch(() => false)) await clickGate(ctx, way.gate).catch(() => undefined);
}

/**
 * Out of the pen the bot stands in by its gate, the gate shut behind (throughPenGate), before a walk that sets out
 * from there: the walk home (homeward.ts goHome), and out of the yard (outByGate, leaveYard). A pens round given up
 * mid-visit (the shelter at dusk, survival) leaves the bot in the pen by design, and the next goal's walk set out
 * from there. Baritone's own way out of a pen was over its fence: live on Nov 13 the shelter's walk home from
 * (-557, 63, 2170) in the cow pen pressed the bot into the pen's west fence five times in four minutes, each a wedge
 * stop, while the gate stood two blocks off. One try: a gate it does not get out by (a cow in the gateway) is shut
 * from where the bot stands, said, and the walk goes on from there as it would have (Baritone may place nothing by a
 * pen's fence either: Protection.java). A run given up on the way clicks the gate shut from where the bot stands
 * (outside the run: its own calls fail from then on), and throws. `{}`: not in a pen with a gate (or no look at where
 * it stands: a stale snapshot must never walk it into a pen; another dimension); `pen` and `out` once it tried.
 */
export async function outOfPen(ctx: WalkContext): Promise<{ pen?: string; out?: boolean }> {
  // (no pen with a gate known: nothing to do, and no look needed to say so)
  const pens = penFences(ctx.world).filter((f): f is PenFence & { way: PenWay } => !!f.way);
  if (!pens.length) return {};
  const st = await ctx.status().catch(() => undefined);
  if (ctx.signal.aborted) throw new Error('aborted');
  const me = st?.position;
  // (the pens stand in home's dimension)
  const there = !st?.dimension || !ctx.s.home || st.dimension === ctx.s.home.dimension;
  const f = me && there ? pens.find(q => inPenFence(q, me)) : undefined;
  if (!f) return {};
  const { way } = f;
  ctx.progress(`out of the ${f.kind} pen by its gate ${fmt(way.gate)}`);
  try {
    await throughPenGate(ctx, way);
  } finally {
    // (the bridge's own click, within reach or not at all: it walks nowhere)
    if (ctx.signal.aborted) {
      await brainRun.exit(async () => { if (await gateIsOpen(ctx, way.gate)) await ctx.call('useOn', { ...way.gate, face: 'up', toggle: true }); }).catch(() => undefined);
    }
  }
  if (ctx.signal.aborted) throw new Error('aborted');
  const now = (await ctx.status().catch(() => undefined))?.position;
  const out = !now || !inPenFence(f, now);
  if (!out) ctx.progress(`no way out of the ${f.kind} pen by its gate ${fmt(way.gate)}, shut behind: on by Baritone's own way`);
  return { pen: f.kind, out };
}
