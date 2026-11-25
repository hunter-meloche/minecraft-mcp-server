import { fromGate, no, onHomeLevel, outsideBy, type Decline, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { Ground } from './boatroute.js';
import { billLeft, type Side } from './blueprints.js';
import { inWood, type BuildPlan } from './milestones.js';
import { prepareBill } from './project.js';
import { allItems, mostWood } from './progress.js';
import { out } from './pockets.js';
import { CLEAR, gateRead, shutGate, strictSet } from './yardgates.js';
import { GAME_DAY, dropEntry, fetchOf, heldByFetch, inHallOrLock, journal, peekFetch, settle, wardOut, type Change, type FetchMemory } from './fetch.js';
import {
  footprintFree, inLock, lockFaults, lockOf, lockPlan, lockPlanOf, ringPlan, ringPlanOf, ringReady, spanOf,
  type Blocks, type Body, type Free, type Lock, type LockFault, type LockFaultKind, type LockPlan, type Placed, type RingPlan
} from './villagerwalk.js';

/**
 * The home side of the villager fetch, built (idle-plan V, sections 4.7 and 4.8; S0): the lock in front of the villager
 * hall's gate, then the fence round the yard's Nether portal, each from its blueprint (blueprints.ts hallLock and
 * portalRing; where each goes and whether it stands ready is villagerwalk.ts's to say). Why both: on Nov 24 the second
 * villager led home left by the hall's gate, which stood open with it awake, crossed the yard and was lost in the open
 * portal. With the lock the hall's gate and the lock's are never open together, so nothing in the hall reaches the
 * yard whatever walk passes; with the ring no villager and no animal of the bot's walks into the portal, and what
 * comes out of it stays by it (a zombified piglin walked from it into the hall).
 *
 * The lock goes up in front of a hall with somebody in it, by Baritone's builder, which opens whatever gate is in its
 * way and lifts the no-break rule on every kind it replaces (on Nov 14 it left five holes by the portal's plinth): so
 * the hall's doorway is plugged first, two dirt in the cell outside its gate (each in the journal before it is put
 * down: fetch.ts), and the plug comes up only once the lock stands whole and its own gate is read shut. The ground is
 * kept before anything is built (the zones `lock` and `ring`: footprints, which the site search keeps off). The
 * landmark zones are what "the lock stands" means to the hall chores and to the care goal (villagerwalk.ts lockOf),
 * and are written only when the build says every block is in place: a footprint alone switches nobody over to a lock
 * that is not there. Whether a shell is done is asked of the world as read (lockReady, ringReady), never of a flag:
 * the last read is in `fetch.shells`, and a shell found with blocks of it gone is built again, the same way.
 *
 * It obeys no switch (the lock and the ring protect whoever lives in the hall, a trip planned or not), and wants
 * nothing where no hall stands.
 */

const MINUTE = 60_000;
/** A build that does not finish: this long after the plug went in it is taken up again, and the chores go in the old way. */
export const PLUG_MAX = 2 * GAME_DAY;
/** A build given up, or one that found no free ground, is not begun again before this (the ground is read again then). */
export const NOT_AGAIN = 6 * GAME_DAY;
/** With both standing they are read over this often, and what is gone of them built again. */
export const LOOK_EVERY = 3 * GAME_DAY;
/** Daylight a build is begun with (game ticks), and the free slots its makings want (the lock's five kinds). */
const DAY_LEFT = 2400;
const SLOTS = 5;
const BUILD_MS = 8 * MINUTE;
/** The cap on the critical section round the plug's way out (real ms: one left set by a run that died ends by itself). */
const PLUG_OUT_MS = 3 * MINUTE;
/** The cap on the one round the mend of a lock that stands: the plug's walk in, the builder's minutes, the sill (the plug's way out has its own). */
const MEND_MS = BUILD_MS + PLUG_OUT_MS;
/** How often a running build looks at the gate watch's last read (ms; tests shorten it). */
export const SHELL_WAITS = { watchMs: 1000 };
/** `world.lastDone`: the last look over both, and when each build was last found impossible or given up. */
const LOOKED = 'shells', NO_LOCK = 'shells: no lock', NO_RING = 'shells: no ring';

type Cover = Extract<Change, { k: 'cover' }>;
type Shells = NonNullable<FetchMemory['shells']>;
type Box = ReturnType<typeof spanOf>;
type Reads = Pick<GoalContext, 'call' | 'world' | 's'>;

const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const same = (a: Pos | undefined, b: Pos | undefined) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
const idOf = (state: string | null | undefined) => (state ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
const list = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${v} ${k}`).join(', ');
const first = (text: string) => text.split('\n')[0].replace(/\s+/g, ' ').slice(0, 160);
const SIDES: readonly Side[] = ['south', 'east', 'west', 'north'];
const STEP: Record<Side, { x: number; z: number }> = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 } };
/** When each run began (real ms), for clock() below (as hallchores.ts keeps it: ctx.s.now is the run's start). */
const began = new WeakMap<object, number>();
const clock = (ctx: Pick<GoalContext, 's'>) => ctx.s.now + Math.max(0, Date.now() - (began.get(ctx) ?? Date.now()));
const covers = (world: WorldMemory): Cover[] => fetchOf(world).journal.filter((e): e is Cover => e.k === 'cover' && e.what === 'hall door');
/** `fetch.shells`, there to be written (made by a read; before the first one nothing is known of either shell). */
const shellsOf = (ctx: Pick<GoalContext, 'world' | 's'>): Shells =>
  (fetchOf(ctx.world).shells ??= { at: clock(ctx), lock: ['not read yet'], ring: ['not read yet'] });

// ------------------------------------------------------------------------------------------------ the strict gates

/**
 * The strict set sent to the bridge again, whole (yardgates.ts strictSet: from the zones; the call replaces the
 * bridge's set each time): the brain sends it at every start, and a build when a gate of its own is new: the lock's,
 * with its pair and its guard, and the ring's.
 */
const sendStrict = (ctx: Pick<GoalContext, 'call' | 'world'>) => ctx.call('gates.strict', strictSet(ctx.world) as unknown as Record<string, unknown>);

/**
 * Before a build: the strict set live in the bridge with the hall's gate in it (sent once where it is not: a client
 * relaunched since the brain's own send). A jar that keeps no strict gates builds nothing: for the minutes of a build
 * the gate the builder's walk opens must be one the closer never forgets and the watch reports.
 */
async function strictLive(ctx: GoalContext): Promise<void> {
  const h = ctx.world.zones?.['hall:gate']?.[0];
  const has = async () => !!(await ctx.call<{ strict?: Pos[] }>('gates.status').catch(() => undefined))?.strict?.some(g => same(g, h));
  if (await has()) return;
  await sendStrict(ctx).catch(() => undefined);
  if (ctx.signal.aborted) throw new Error('aborted');
  if (!(await has())) throw new Error('the bridge keeps no strict gates (an older jar, or its client not up yet): nothing built');
}

// ------------------------------------------------------------------------------------------------ as read

const NOTHING: Blocks = { state: () => undefined };
const union = (bs: Box[]): Box => ({
  x1: Math.min(...bs.map(b => b.x1)), y1: Math.min(...bs.map(b => b.y1)), z1: Math.min(...bs.map(b => b.z1)),
  x2: Math.max(...bs.map(b => b.x2)), y2: Math.max(...bs.map(b => b.y2)), z2: Math.max(...bs.map(b => b.z2))
});
const walk = async (ctx: Pick<GoalContext, 'call'>, to: Pos, range: number): Promise<boolean> =>
  (await ctx.call<{ arrived?: boolean }>('goto', { x: to.x, y: to.y, z: to.z, range, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => ({ arrived: false })))?.arrived !== false;

/** Whether every column of the boxes was read (none came back unloaded). */
const wholeOf = (g: Ground, boxes: Box[]): boolean => {
  const b = union(boxes);
  for (let z = b.z1; z <= b.z2; z++) for (let x = b.x1; x <= b.x2; x++) if (!g.has(x, z)) return false;
  return true;
};

/** The blocks of the boxes read; with `by`, from nearer (a careful walk to within 8 of it) where a column came back unread. */
async function readBoxes(ctx: Pick<GoalContext, 'call'>, boxes: Box[], by?: Pos): Promise<Ground> {
  const b = union(boxes), g = new Ground(b.y1, b.y2 - b.y1 + 1);
  await g.read(ctx, b.x1, b.z1, b.x2, b.z2);
  if (by && !wholeOf(g, boxes)) { await walk(ctx, by, 8); await g.read(ctx, b.x1, b.z1, b.x2, b.z2); }
  return g;
}

/** Who is about, as a look gives them; undefined when the look failed (nothing is then known of who is in the lock). */
const lookAbout = async (ctx: Pick<GoalContext, 'call'>): Promise<Body[] | undefined> => {
  const r = await ctx.call<{ entities?: Body[] }>('world.entities', { maxDistance: 128 }).catch(() => undefined);
  return Array.isArray(r?.entities) ? r.entities : undefined;
};
/** Whom a gate is never opened onto (what the bridge's guard counts: a villager, a wandering trader). */
const VILLAGER = /^(villager|wandering_trader)$/;

/** A layout or a gate side tried for a shell that does not stand, and whether its ground is free. */
export interface Tried<P> { plan: P; name: string; free: Free }
/** The lock and the ring as read now (readShells). */
export interface ShellsRead {
  at: number;
  /** every cell asked of was read, and the look into a standing lock answered: only such a read is written to `fetch.shells` */
  whole: boolean;
  /** who was about; undefined: the look failed, or no lock stands to look into */
  seen?: Body[];
  /** `plan`: the lock that stands (its zones); `faults` by kind (villagerwalk.ts lockFaults); `ground`: with none standing and none being built, the plain layout, then the mirrored */
  lock: { plan?: LockPlan; faults: LockFault[]; ground?: Tried<LockPlan>[]; blocks?: Ground };
  /** the same of the ring; `ground`: with none standing, its gate on each side, the side toward home first */
  ring: { plan?: RingPlan; faults: string[]; ground?: Tried<RingPlan>[]; blocks?: Ground };
}

const taken = (g: Tried<Placed>[]) => g.map(x => `${x.name}: ${x.free.ok ? 'free' : `${x.free.why} at ${fmt(x.free.at)}`}`).join('; ');

/**
 * The lock and the ring read (the blocks of each, and who stands about), and written to `fetch.shells` as words: the
 * faults, none when ready. Read from where the bot stands; `near`: a column not read is read again from by the shell
 * (the goal's own reads: a tool's walk nowhere). For a shell that does not stand, where it would go and whether that
 * ground is free, asked of every layout; not of the lock while it is being built (the plug in its cell reads as a
 * cell taken, both ways round). A read that is not whole (asked from afar, from another dimension, in the blind
 * seconds after a rejoin) is given back as it is and written nowhere: what was last read whole stands.
 */
export async function readShells(ctx: Reads, near = false): Promise<ShellsRead> {
  const world = ctx.world, building = peekFetch(world).shells?.building;
  const read: ShellsRead = { at: clock(ctx), whole: true, lock: { faults: [] }, ring: { faults: [] } };
  const stands = lockPlanOf(world);
  const plans = stands ? [stands] : [false, true].map(m => lockPlan(world, m)).filter((p): p is LockPlan => !!p);
  let g: Ground | undefined;
  if (plans.length) {
    g = read.lock.blocks = await readBoxes(ctx, plans.map(spanOf), near ? plugOf(plans[0]).beyond : undefined);
    if (stands) read.seen = await lookAbout(ctx);
    read.whole = wholeOf(g, plans.map(spanOf)) && (!stands || !!read.seen);
    if (!stands && building !== 'lock') read.lock.ground = plans.map(plan => ({ plan, name: plan.mirror ? 'the other way round' : 'the plain layout', free: footprintFree(g!, plan) }));
  }
  read.lock.plan = stands;
  read.lock.faults = lockFaults(world, g ?? NOTHING, read.seen ?? []);
  if (stands && !read.seen) read.lock.faults.push({ kind: 'unread', text: 'nobody looked into the lock (the look failed)' });
  const ring = ringPlanOf(world), home = ctx.s.home ?? world.landmarks?.bed;
  // (the gate where the bot's walk to the portal crosses the line: the side toward home first)
  const toward = (r: RingPlan) => (home ? STEP[r.side].x * (home.x - r.gate.x) + STEP[r.side].z * (home.z - r.gate.z) : 0);
  const sides = ring ? [ring] : SIDES.map(s => ringPlan(world, s)).filter((r): r is RingPlan => !!r).sort((a, b) => toward(b) - toward(a));
  let g2: Ground | undefined;
  if (sides.length) {
    g2 = read.ring.blocks = await readBoxes(ctx, sides.map(spanOf), near ? sides[0].outside : undefined);
    read.whole &&= wholeOf(g2, sides.map(spanOf));
    // (asked while it is being built too: what stands of a ring reads free for its own gate's side, and for no other)
    if (!ring) read.ring.ground = sides.map(plan => ({ plan, name: `its gate ${plan.side}`, free: footprintFree(g2!, plan) }));
  }
  read.ring.plan = ring;
  read.ring.faults = ringReady(world, g2 ?? NOTHING);
  const none = (g1?: Tried<Placed>[]) => (g1?.length && !g1.some(x => x.free.ok) ? `: no free ground for it (${taken(g1)})` : '');
  // (a read that is not whole writes nothing, not even an empty record: the read-only villager-plan makes none)
  if (!read.whole) return read;
  const sh = shellsOf(ctx);
  sh.at = read.at;
  sh.lock = read.lock.faults.map((f, i) => f.text + (i ? '' : none(read.lock.ground)));
  sh.ring = read.ring.faults.map((f, i) => f + (i ? '' : none(read.ring.ground)));
  return read;
}

/**
 * The shells in words, for the plan tool (villager-plan): the lock and the ring, where each stands or would go with
 * what its ground says, then every fault. A look only (it reads and writes `fetch.shells`; nothing is walked to).
 */
export async function shellsText(ctx: Reads): Promise<string> {
  const r = await readShells(ctx), building = peekFetch(ctx.world).shells?.building;
  const faults = (fs: string[]) => (fs.length ? [`${fs.length} fault(s)`, ...fs.map(f => `  - ${f}`)] : ['ready']);
  const lines: string[] = [];
  const l = r.lock.plan;
  if (l) {
    const [head, ...rest] = faults(r.lock.faults.map(f => f.text));
    lines.push(`The lock stands at the hall's ${l.side} gate${l.mirror ? ', the other way round' : ''}: P ${fmt(l.p)}, H ${fmt(l.h)}, socket ${fmt(l.socket)}, sill ${fmt(l.sill)}, post ${fmt(l.post)}, S_out ${fmt(l.sOut)}: ${head}`, ...rest);
  } else if (building === 'lock') lines.push('The lock is being built (the hall\'s doorway is plugged meanwhile).');
  else if (r.lock.ground) lines.push(`No lock stands. Its ground: ${taken(r.lock.ground)}.`);
  else lines.push('No lock: no villager hall stands.');
  const g = r.ring.plan;
  if (g) {
    const [head, ...rest] = faults(r.ring.faults);
    lines.push(`The portal's ring stands, its gate ${g.side} at ${fmt(g.gate)}: ${head}`, ...rest);
  } else if (building === 'ring') lines.push('The portal\'s ring is being built.');
  else if (r.ring.ground) lines.push(`No ring round the portal. Its ground: ${taken(r.ring.ground)}.`);
  else lines.push('No ring: the yard has no portal.');
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------ gates and the plug

const stateAt = async (ctx: Pick<GoalContext, 'call'>, p: Pos): Promise<string | undefined> =>
  (await ctx.call<{ blocks?: (string | null)[] }>('world.region', { x: p.x, y: p.y, z: p.z, width: 1, height: 1, length: 1 }).catch(() => undefined))?.blocks?.[0] ?? undefined;

/**
 * The plug's two cells (the cell outside the hall's gate, which is the lock's inside cell before it, and the one over
 * it), the cell the bot works them from (the next one out, before the lock's gate), and the cell 2 beyond that gate.
 */
function plugOf(lock: Pick<Lock, 'h' | 'p' | 'inside'>): { cells: [Pos, Pos]; stand: Pos; beyond: Pos } {
  const h = lock.h, low = lock.inside.find(c => Math.abs(c.x - h.x) + Math.abs(c.z - h.z) === 1)!;
  const d = { x: low.x - h.x, z: low.z - h.z };
  return {
    cells: [low, { ...low, y: low.y + 1 }], stand: { x: low.x + d.x, y: low.y, z: low.z + d.z },
    beyond: { x: lock.p.x + 2 * d.x, y: lock.p.y, z: lock.p.z + 2 * d.z }
  };
}

/**
 * The plug in: two dirt in the hall's doorway from outside it, behind its gate read shut, the lower first (the upper
 * stands on it), each in the journal before it is put down. For the minutes of the build nobody leaves by the hall's
 * gate whatever opens it. Gone on with after a kill: an entry there already is not written twice, and a cell that
 * holds its dirt is not put again.
 */
async function plugIn(ctx: GoalContext, plan: LockPlan): Promise<void> {
  const { cells, stand } = plugOf(plan);
  await walk(ctx, stand, 0);
  if (!(await shutGate(ctx, plan.h))) throw new Error(`the hall's gate at ${fmt(plan.h)} does not read shut: the plug waits`);
  for (const at of cells) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const entry = covers(ctx.world).find(e => same(e.at, at)) ?? journal(ctx, { k: 'cover', trip: 0, at, item: 'dirt', what: 'hall door', st: 'planned', t: clock(ctx) });
    if (idOf(await stateAt(ctx, at)) !== 'dirt') {
      const r = await ctx.own!.put(at, 'dirt');
      if (!r.ok) throw new Error(`the plug did not go into the hall's doorway at ${fmt(at)}: ${r.reason ?? `${r.block ?? 'nothing'} there`}`);
    }
    settle(entry, 'down');
    ctx.save?.();
  }
}

/**
 * Why the plug stays in for now: a villager in the hall's gateway (the dirt is not taken from before its feet), or,
 * `inside`, in the lock (its gate is not opened onto one); or no look to say so.
 */
async function someoneIn(ctx: GoalContext, lock: Lock, inside: boolean): Promise<string | undefined> {
  const seen = await lookAbout(ctx);
  if (!seen) return 'no look into the lock';
  const cell = (p: Pos) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
  const who = seen.find(e => VILLAGER.test(e.name) && !!e.position && ((inside && inLock(lock, e.position)) || same(cell(e.position), lock.h)));
  return who && `a ${who.name} stands in the lock or in the hall's gateway`;
}

/** A critical section of the hall's kind round `run` (pockets.ts: only flight cuts it; its cap ends one a dead run left). */
async function critical<T>(ctx: GoalContext, run: () => Promise<T>, capMs = PLUG_OUT_MS): Promise<T> {
  out.critical = { by: ctx.signal, until: clock(ctx) + capMs, why: 'hall' };
  try {
    return await run();
  } finally {
    if (out.critical?.by === ctx.signal) delete out.critical;
  }
}

/**
 * The plug out, which is the build's last step (and the end of a build given up; the care goal's too, for a plug
 * found left with the lock ready): with the lock standing, no villager in it or in the hall's gateway (its gate is
 * never opened onto one, and the dirt is not taken from before its feet; an animal that walked in before the walls
 * closed finds its way out by the gate the bot opens); in by the lock's gate to the cell before the plug; that gate
 * and the hall's read shut, and only then both dirt taken up from where the bot stands, the upper first; out by the
 * lock's gate, and it read shut behind. The hall's gate never opens. A critical section: with the landmark zones
 * written the bot in there is "in the lock", and the goal that takes a bot found in the hall or the lock out again
 * must leave this be. How many came up; with no plug in the journal nothing is walked to.
 */
export async function plugOut(ctx: GoalContext, plan: Lock): Promise<number> {
  const world = ctx.world;
  if (!covers(world).length) return 0;
  const { cells, stand, beyond } = plugOf(plan);
  // (a build given up stands as no lock: what is in its cells came from the yard, and goes back to it)
  const why = await someoneIn(ctx, plan, !!lockOf(world));
  if (why) throw new Error(`${why}: the plug stays in`);
  return critical(ctx, async () => {
    if (!(await walk(ctx, stand, 0))) throw new Error(`no way on foot into the lock to ${fmt(stand)}: the plug stays in`);
    for (const [name, gate] of [['the lock\'s', plan.p], ['the hall\'s', plan.h]] as const) {
      if (!(await shutGate(ctx, gate))) throw new Error(`${name} gate at ${fmt(gate)} does not read shut: the plug stays in`);
    }
    let up = 0;
    for (const at of [cells[1], cells[0]]) {
      const entry = covers(world).find(e => same(e.at, at));
      if (!entry) continue;
      if (ctx.signal.aborted) throw new Error('aborted');
      const r = await ctx.own!.take(at, 'dirt', { adopt: true, stay: true });
      if (r.dug) up++;
      // (another block in its place is someone's now: never dug, the entry dropped, and said)
      if (!r.ok && r.block && r.block !== 'dirt') ctx.progress(`shells: ${r.block} stands in the plug's cell at ${fmt(at)}, not the bot's dirt: left`);
      else if (!r.ok) throw new Error(`the plug did not come up at ${fmt(at)}: ${r.reason ?? 'not dug'}`);
      dropEntry(ctx, entry);
    }
    if (!(await walk(ctx, beyond, 0))) throw new Error(`no way on foot out of the lock to ${fmt(beyond)}`);
    if (!(await shutGate(ctx, plan.p))) throw new Error(`the lock's gate at ${fmt(plan.p)} does not read shut behind the bot`);
    return up;
  });
}

// ------------------------------------------------------------------------------------------------ the builds

/** A placed blueprint's box as world.region gives one (x fastest, then z, then y), from the blocks read: what billLeft takes. */
function boxOf(g: Blocks, pl: Placed): (string | null)[] {
  const { origin: o, bp } = pl, cells: (string | null)[] = [];
  for (let y = 0; y < bp.size.height; y++) for (let z = 0; z < bp.size.length; z++) for (let x = 0; x < bp.size.width; x++) cells.push(g.state(o.x + x, o.y + y, o.z + z) ?? null);
  return cells;
}

const WOODEN = /^(oak|birch|spruce|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_(planks|fence_gate|fence)$/;

/**
 * The blueprint in the wood the shell is to be of: the wood of what stands of it (a build cut short goes on in its
 * wood, and a block gone from a birch lock is put back in birch), else the wood the bot has most of, as every build's.
 */
function inItsWood(ctx: Pick<GoalContext, 's' | 'world'>, g: Blocks, pl: Placed): BuildPlan {
  const there = boxOf(g, pl), { width, length } = pl.bp.size;
  let wood: string | undefined;
  pl.bp.spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => {
    const m = ch === ' ' || ch === '.' ? null : WOODEN.exec(idOf(there[x + z * width + y * width * length]));
    if (m) wood ??= m[1];
  })));
  return inWood(pl.bp, wood ?? mostWood(allItems(ctx.s, ctx.world)));
}

/** A build begins on a box read whole: a cell not read would be billed, plugged and built as if nothing stood there. */
function readWhole(g: Blocks, pl: Placed, what: string): void {
  if (boxOf(g, pl).some(s => s === null)) throw new Error(`${what} is not read (its chunks are not loaded yet)`);
}

/** A cell of the spec that holds neither its block nor air or a plant: the builder would break what stands there. */
function inTheWay(g: Blocks, pl: Placed, bp: BuildPlan): string | undefined {
  const there = boxOf(g, pl), { width, length } = bp.size;
  let found: string | undefined;
  bp.spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => {
    const s = there[x + z * width + y * width * length];
    if (found || ch === ' ' || (s && (CLEAR.test(s) || (ch !== '.' && idOf(s) === idOf(bp.spec.palette[ch]))))) return;
    found = `${s ? idOf(s) : 'a cell not read'} at ${fmt({ x: pl.origin.x + x, y: pl.origin.y + y, z: pl.origin.z + z })}`;
  })));
  return found;
}

/**
 * The builder run over a shell (build-structure, as the hall's beds call it: it places only what is not in place), and
 * stopped on the tick the gate watch shows the hall's gate open (`fetch.gates`, a read made since the build began):
 * Baritone's walk opened it, and with somebody in the hall the build does not go on beside an open gate. It returns
 * with every block in place, and throws with what the builder said otherwise.
 */
async function build(ctx: GoalContext, pl: Placed, bp: BuildPlan, what: string): Promise<void> {
  const h = ctx.world.zones?.['hall:gate']?.[0], from = clock(ctx);
  let opened = false;
  const watch = setInterval(() => {
    const seen = peekFetch(ctx.world).gates;
    if (opened || !h || !seen || seen.at < from || !seen.open.some(g => same(g, h))) return;
    opened = true;
    try { void ctx.call('cancel').catch(() => undefined); } catch { /* the run is over */ }
  }, SHELL_WAITS.watchMs);
  let r: { ok: boolean; text: string };
  try {
    r = await ctx.act('build-structure', { ...pl.origin, spec: bp.spec, name: bp.name, timeoutMs: BUILD_MS });
  } finally {
    clearInterval(watch);
  }
  if (opened) {
    if (h) await shutGate(ctx, h);
    throw new Error(`${what}'s build was stopped: the hall's gate stood open`);
  }
  if (/all \d+ blocks in place/.test(r.text)) return;
  // the whole story in the log (what could not be placed and why), a line in the error
  ctx.progress(r.text.replace(/\s+/g, ' ').slice(0, 600));
  throw new Error(`${what} is not whole yet: ${first(r.text)}`);
}

const setBuilding = (ctx: GoalContext, what: 'lock' | 'ring' | undefined) => {
  const sh = shellsOf(ctx);
  if (what) sh.building = what; else delete sh.building;
  ctx.save?.();
};

/**
 * The lock built, or gone on with, or mended, at `plan` (blocks as just read): the makings first (short of them
 * nothing is plugged and the chores go on); then, with anything of it still to place, `building` set (the hall chores
 * keep out while it is), the plug in, and the builder; all blocks in place (and no villager standing in it): the sill
 * laid, the landmark zones written, the strict set sent again with the lock's gate, its pair and its guard; and last
 * the plug out. What does not finish throws and leaves the plug in: the next run goes on from what stands and what
 * the journal holds. A lock that stands (its landmark zones written) is mended from inside it: the plug goes in from
 * the lock's inside cell before it, and the builder leaves the bot in there. So it is gone into only as a passage goes
 * (nobody in it or in the hall's gateway, both its gates read shut: the read that let the mend begin is from before
 * the makings), and the whole mend, to the plug's way out, is one critical section: the bot in there is "in the
 * lock", and `out of the hall` would else take it out at the next tick, the build cut and `building` left set.
 */
async function buildLock(ctx: GoalContext, plan: LockPlan, g: Blocks): Promise<string> {
  const world = ctx.world;
  readWhole(g, plan, 'the lock');
  const bp = inItsWood(ctx, g, plan);
  const left = billLeft(bp.spec, boxOf(g, plan), bp.size), todo = Object.keys(left).length > 0;
  const plug = todo ? plugOf(plan).cells.filter(c => idOf(g.state(c.x, c.y, c.z)) !== 'dirt').length : 0;
  const sill = /(^|_)rail$/.test(idOf(g.state(plan.sill.x, plan.sill.y, plan.sill.z)));
  const bill = { ...left, ...(sill ? {} : { rail: 1 }), ...(plug ? { dirt: plug } : {}) };
  if (Object.keys(bill).length) {
    const short = await prepareBill(ctx, bill, { record: false });
    if (ctx.signal.aborted) throw new Error('aborted');
    if (Object.keys(short).length) throw new Error(`the lock: short of ${list(short)}${covers(world).length ? ' (the plug stays in)' : ' (nothing plugged yet)'}`);
  }
  const stands = same(lockOf(world)?.post, plan.post);
  if (!stands || !todo) return raiseLock(ctx, plan, bp, left, sill, stands);
  const busy = await someoneIn(ctx, plan, true) ?? await notShut(ctx, plan);
  if (busy) throw new Error(`${busy}: the lock is not mended now`);
  return critical(ctx, () => raiseLock(ctx, plan, bp, left, sill, stands), MEND_MS);
}

/** Why the lock is not to be gone into now: a gate of it not read shut (undefined: both read shut). */
async function notShut(ctx: GoalContext, plan: LockPlan): Promise<string | undefined> {
  for (const [name, gate] of [['the lock\'s', plan.p], ['the hall\'s', plan.h]] as const) {
    if (await gateRead(ctx, gate) !== false) return `${name} gate at ${fmt(gate)} does not read shut`;
  }
  return undefined;
}

/** buildLock's part from the plug on (`left`: what is to place; `sill`: the sill read down; `stands`: the lock's landmark zones written). */
async function raiseLock(ctx: GoalContext, plan: LockPlan, bp: BuildPlan, left: Record<string, number>, sill: boolean, stands: boolean): Promise<string> {
  const world = ctx.world, todo = Object.keys(left).length > 0;
  if (todo) {
    setBuilding(ctx, 'lock');
    await plugIn(ctx, plan);
    await build(ctx, plan, bp, 'the lock');
  }
  // it stands only with no villager in it: from the landmark zones on the bridge's guard shuts the lock's gate on a
  // villager inside, whoever opens it, and the bot the builder left in there with one would be shut in with it
  const why = stands ? undefined : await someoneIn(ctx, plan, true);
  if (why) throw new Error(`${why}: the lock does not stand until it is out (the plug stays in)`);
  if (!/(^|_)rail$/.test(idOf(await stateAt(ctx, plan.sill)))) {
    // from where the bot stands (a place asks no sight, and every cell inside the lock is in its reach: the bot the
    // builder left in there opens no gate for it), else from the post, the cell beside it; never by a walk "into
    // reach", which finds the lock's inside, through its gate, as near as the yard
    let r = await ctx.own!.put(plan.sill, 'rail', { stay: true });
    if (!r.placed && !/^(occupied|no )/.test(r.reason ?? '')) { await walk(ctx, plan.post, 0); r = await ctx.own!.put(plan.sill, 'rail', { stay: true }); }
    if (!r.ok) throw new Error(`the lock's sill did not go down at ${fmt(plan.sill)}: ${r.reason ?? `${r.block ?? 'nothing'} there`}`);
  }
  // (from the landmark zones on, the cell the builder left the bot in may be "in the lock": one section to the plug's end)
  const up = await critical(ctx, async () => {
    if (!stands) {
      const z = (world.zones ??= {});
      const one = (p: Pos) => [{ x: p.x, y: p.y, z: p.z }];
      Object.assign(z, { 'lock:gate': one(plan.p), 'lock:socket': one(plan.socket), 'lock:sill': one(plan.sill), 'lock:post': one(plan.post), 'lock:sout': one(plan.sOut), 'lock:inside': plan.inside.flatMap(one) });
      ctx.save?.();
    }
    await sendStrict(ctx);
    return plugOut(ctx, plan);
  });
  // (a run cut short on its way out left the lock's gate to the closer: it is read shut before the build is called done)
  if (!(await shutGate(ctx, plan.p))) throw new Error(`the lock's gate at ${fmt(plan.p)} does not read shut`);
  setBuilding(ctx, undefined);
  const r = await readShells(ctx);
  ctx.save?.();
  const how = todo ? `built the lock in front of the hall's gate (${list(left)})` : sill ? 'the lock stands whole' : 'laid the lock\'s sill';
  return `${how}${up ? `; took the plug up (${up} dirt)` : ''}; ${r.lock.faults.length ? `not ready yet: ${r.lock.faults[0].text}` : 'the lock is ready'}`;
}

/**
 * The portal's ring built, gone on with or mended at `plan` (the gate's side chosen by who calls), the same way with
 * no plug: the makings, `building`, the builder; all in place, the zone `ring:gate` and the strict set sent again
 * with its gate, and the gate read shut.
 */
async function buildRing(ctx: GoalContext, plan: RingPlan, g: Blocks): Promise<string> {
  const world = ctx.world;
  readWhole(g, plan, 'the portal\'s ring');
  const bp = inItsWood(ctx, g, plan);
  const left = billLeft(bp.spec, boxOf(g, plan), bp.size);
  if (Object.keys(left).length) {
    const short = await prepareBill(ctx, left, { record: false });
    if (ctx.signal.aborted) throw new Error('aborted');
    if (Object.keys(short).length) throw new Error(`the portal's ring: short of ${list(short)}`);
    setBuilding(ctx, 'ring');
    await build(ctx, plan, bp, 'the portal\'s ring');
  }
  if (!same(world.zones?.['ring:gate']?.at(-1), plan.gate)) {
    (world.zones ??= {})['ring:gate'] = [{ ...plan.gate }];
    ctx.save?.();
  }
  await sendStrict(ctx);
  await shutGate(ctx, plan.gate);
  setBuilding(ctx, undefined);
  const r = await readShells(ctx);
  ctx.save?.();
  return `fenced the Nether portal, its gate ${plan.side} at ${fmt(plan.gate)}${Object.keys(left).length ? ` (${list(left)})` : ''}; ${r.ring.faults.length ? `not ready yet: ${r.ring.faults[0]}` : 'the ring is ready'}`;
}

/** A build found impossible or given up: when, so the gate does not begin it again at once. */
const mark = (ctx: GoalContext, key: string) => { (ctx.world.lastDone ??= {})[key] = clock(ctx); };

/** The ground for a shell that does not stand: the first free of what was tried; none: said (it is in `fetch.shells`), marked, nothing built. */
function freeOf<P extends Placed>(ctx: GoalContext, ground: Tried<P>[] | undefined, what: string, key: string): P | string {
  if (!ground?.length) return `no ground for ${what}`;
  if (ground.some(x => !x.free.ok && x.free.why === 'not read')) throw new Error(`the ground for ${what} is not read (its chunks are not loaded)`);
  const free = ground.find(x => x.free.ok);
  if (free) return free.plan;
  mark(ctx, key);
  ctx.save?.();
  return `nothing built: no free ground for ${what} (${taken(ground)})`;
}

/** The faults a build may be begun under: what stands wrong of the shell itself. Not a gate open, somebody in it, the socket in use. */
const QUIET: readonly LockFaultKind[] = ['structure', 'reach', 'post', 'sight'];

/**
 * Both looked over (the read is `fetch.shells`), and what is gone of a shell that stands built again: only while no
 * villager is out or in the lock, nothing of the fetch's is in the socket, and nothing stands in a cell of the shell
 * that the builder would have to break (a stray in a doorway is the tidy round's; anything else is said and left).
 */
async function lookOver(ctx: GoalContext): Promise<string> {
  const world = ctx.world, r = await readShells(ctx, true);
  if (!r.whole) throw new Error('the lock and the portal\'s ring are not read (their chunks are not loaded, or the look failed)');
  mark(ctx, LOOKED);
  const said: string[] = [];
  const calm = !wardOut(world, clock(ctx)) && !!ctx.own;
  const l = r.lock.plan, lg = r.lock.blocks;
  if (l && lg && calm && r.lock.faults.every(f => QUIET.includes(f.kind)) && !heldByFetch(world, l.socket)) {
    const bp = inItsWood(ctx, lg, l);
    const gone = Object.keys(billLeft(bp.spec, boxOf(lg, l), bp.size)).length > 0 || !/(^|_)rail$/.test(idOf(lg.state(l.sill.x, l.sill.y, l.sill.z)));
    if (gone && !inTheWay(lg, l, bp)) { await strictLive(ctx); said.push(await buildLock(ctx, l, lg)); }
  }
  const g = r.ring.plan, gg = r.ring.blocks;
  if (g && gg && calm) {
    const bp = inItsWood(ctx, gg, g);
    if (Object.keys(billLeft(bp.spec, boxOf(gg, g), bp.size)).length > 0 && !inTheWay(gg, g, bp)) { await strictLive(ctx); said.push(await buildRing(ctx, g, gg)); }
  }
  if (said.length) return said.join('; ');
  const sh = shellsOf(ctx);
  const of = (name: string, stands: boolean, faults: string[]) => (!stands ? `no ${name}` : faults.length ? `the ${name}: ${faults[0]}${faults.length > 1 ? ` (and ${faults.length - 1} more)` : ''}` : `the ${name} ready`);
  return `looked over: ${of('lock', !!l, sh.lock)}; ${ringPlan(world, 'south') ? of('ring', !!g, sh.ring) : 'no portal in the yard'}`;
}

// ------------------------------------------------------------------------------------------------ the goal

type Owed = { kind: 'unplug' | 'lock' | 'ring' | 'look'; want: string } | { none: Decline };

/**
 * What the shells owe now, by the memory alone (pure: the gate's and the run's one answer). A build under way goes on
 * (its plug taken up instead once it is 2 game days old); a plug left with nothing building comes up; with no lock
 * standing it is built, then the ring; with both standing (or tried and not to be tried again yet) they are looked
 * over now and then.
 */
export function shellsOwed(world: WorldMemory, now: number): Owed {
  if (!lockPlan(world)) return { none: { cause: 'unneeded', text: 'no villager hall yet' } };
  const f = peekFetch(world), sh = f.shells;
  const plugs = f.journal.filter(e => e.k === 'cover' && e.what === 'hall door');
  if (sh?.building === 'lock') {
    return plugs.length && now - Math.min(...plugs.map(e => e.t)) >= PLUG_MAX
      ? { kind: 'unplug', want: 'the lock\'s build did not finish in 2 game days: the plug out of the hall\'s doorway' }
      : { kind: 'lock', want: 'the lock\'s build goes on' };
  }
  if (plugs.length) return { kind: 'unplug', want: 'a plug left in the hall\'s doorway' };
  if (sh?.building === 'ring') return { kind: 'ring', want: 'the portal ring\'s build goes on' };
  const wait = (key: string) => (world.lastDone?.[key] ?? -Infinity) + NOT_AGAIN - now;
  const noLock = !lockPlanOf(world), noRing = !!ringPlan(world, 'south') && !ringPlanOf(world);
  if (noLock && wait(NO_LOCK) <= 0) return { kind: 'lock', want: 'a lock in front of the villager hall\'s gate' };
  if (noRing && wait(NO_RING) <= 0) return { kind: 'ring', want: 'a fence round the Nether portal' };
  const looked = world.lastDone?.[LOOKED] ?? -Infinity;
  if (!sh || now - looked >= LOOK_EVERY) return { kind: 'look', want: 'the lock and the portal\'s ring looked over' };
  const min = (ms: number) => Math.max(1, Math.ceil(ms / MINUTE));
  const not = [noLock ? `no lock (its build is tried again in ${min(wait(NO_LOCK))} min)` : '', noRing ? `no ring round the portal (tried again in ${min(wait(NO_RING))} min)` : ''].filter(Boolean);
  return { none: { cause: 'unneeded', text: not.length ? not.join('; ') : `the lock and the portal's ring were looked over ${Math.floor((now - looked) / MINUTE)} min ago`, until: looked + LOOK_EVERY } };
}

const inYard = (s: Snapshot, world: WorldMemory) =>
  !!world.yard && !!s.home && s.dimension === 'overworld' && outsideBy(world.yard, s.position) === 0 && onHomeLevel(s.position, s.home);

/** The goal's one answer (pure): what is owed, from the yard and not from inside the hall, by day, with room for the makings. */
const gate = (s: Snapshot, world: WorldMemory): Gate => {
  const o = shellsOwed(world, s.now);
  if ('none' in o) return o.none;
  if (!inYard(s, world)) {
    return { cause: 'away', text: !s.home ? 'no home set' : s.dimension !== 'overworld' ? `in ${s.dimension}` : `${Math.round(s.distHome)} blocks from home, not in the yard on home's level (the lock and the ring are built from the yard)` };
  }
  // (a bot found in there is taken out through the lock by its own goal; a walk of this one's would go by the hall's gate)
  if (inHallOrLock(world, s.position)) return { cause: 'hold', text: 'the bot stands in the villager hall or its lock' };
  const builds = o.kind === 'lock' || o.kind === 'ring';
  if (builds && 36 - s.slotsUsed < SLOTS) return no.pockets(s, 'a shell\'s build', 36 - SLOTS + 1);
  return no.late(s, 'a shell\'s build', builds ? DAY_LEFT : 0) ?? { want: o.want };
};

/**
 * The shells: the lock, then the ring, built by day from the yard; a build cut short gone on with; both looked over
 * now and then and mended. It never stops what runs (a chore at home that can wait), and only flight cuts its last
 * step short (pockets.ts `critical`). A failure is tried again in a few minutes and never left for the morning: a plug
 * in the hall's doorway is owed its end.
 */
export const shellsGoal: Goal = {
  name: 'hall shells',
  priority: 31,
  timeoutMs: 15 * MINUTE,
  retryMs: 3 * MINUTE,
  failHoldMs: 10 * MINUTE,
  gate,
  ...fromGate(gate),
  cuts: () => false,
  run: async ctx => {
    began.set(ctx, Date.now());
    const world = ctx.world, o = shellsOwed(world, ctx.s.now);
    if ('none' in o) return o.none.text;
    if (o.kind === 'look') return lookOver(ctx);
    if (!ctx.own) throw new Error('this runtime puts down no blocks of its own (own.put, own.take): nothing built');
    const sh = peekFetch(world).shells;
    if (o.kind === 'unplug') {
      const plan = lockPlanOf(world) ?? lockPlan(world, !!sh?.mirror)!;
      const up = await plugOut(ctx, plan);
      const given = sh?.building === 'lock' && !lockPlanOf(world);
      setBuilding(ctx, undefined);
      if (given) mark(ctx, NO_LOCK);
      await readShells(ctx);
      ctx.save?.();
      return given ? `the lock's build did not finish in 2 game days: took the plug up (${up} dirt), and the chores go in the old way` : `took up the plug left in the hall's doorway (${up} dirt)`;
    }
    await strictLive(ctx);
    if (o.kind === 'lock') {
      // (a build under way keeps its layout: asked again, the plug in its cell reads as a cell taken, both ways round)
      if (sh?.building === 'lock') {
        const plan = lockPlan(world, !!sh.mirror)!;
        return buildLock(ctx, plan, await readBoxes(ctx, [spanOf(plan)], plugOf(plan).beyond));
      }
      const r = await readShells(ctx, true);
      const plan = freeOf(ctx, r.lock.ground, 'the lock', NO_LOCK);
      if (typeof plan === 'string') return plan;
      (world.zones ??= {}).lock = [{ ...plan.zone }];
      const mine = shellsOf(ctx);
      if (plan.mirror) mine.mirror = true; else delete mine.mirror;
      ctx.save?.();
      return buildLock(ctx, plan, r.lock.blocks!);
    }
    const r = await readShells(ctx, true);
    const plan = r.ring.plan ?? freeOf(ctx, r.ring.ground, 'the portal\'s ring', NO_RING);
    if (typeof plan === 'string') return plan;
    (world.zones ??= {}).ring = [{ ...plan.zone }];
    ctx.save?.();
    return buildRing(ctx, plan, r.ring.blocks!);
  }
};
