import { brainRun } from '../tools.js';
import { fromGate, nearHome, no, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { Milestone, MilestoneState } from './progress.js';
import { buildStep, siteStep } from './milestones.js';
import { pen, type Side } from './blueprints.js';
import { inPen, nextAnimalAction, PEN_FOOD, penState, type Animal, type Pen, type PenKind } from './animals.js';
import { prepareBill } from './project.js';
import { takeFromChests } from './chests.js';
import { someones, type Creature } from './courtesy.js';
import { makeRoom, noRoom, out as afield, room } from './pockets.js';
import { addSite, alongSide, byYard, CLEAR, dropSite, gatesBetween, inFence, notePen, outByGate, sitesOf, type Bound, type HomeSide, type WorkResult } from './work.js';

/**
 * Animal pens: a 7 x 7 fenced pen per kind (cows, then sheep) with a gate toward home, and a chore that keeps each
 * stocked: strays walked in on a lead (food in hand when no lead can be had; walking, not sprinting: an animal can't
 * keep up with a sprinting player), the herd bred past its 6 adults, the surplus culled for food and leather, the
 * sheep sheared. Further out than the chore looks, the work queue's `cows` rung fetches them (fetchForPens), out
 * past the leash.
 */

const MINUTE = 60_000;
const SIZE = 7;
/** The adults a pen keeps to breed from: those above it are culled (never below the pair, never a calf). */
const MAX_ADULTS = 6;
/**
 * The most a pen holds, calves counted, while it breeds: room for four calves above the 6 adults, the surplus the
 * cull takes once grown. With the calves counted against the 6, as before, the herd stopped breeding at 6 and never
 * had one to cull: no leather from it, ever. The pen is 5 x 5 inside: ten cows leave the bot room to walk in it.
 */
const MAX_HERD = 10;
/**
 * How far from home, across the ground, a cow may be fetched from: past the leash, which everything else keeps (the
 * user, Nov 13: "allowed to wander further to find its cows"). Live every side came back with none within the leash,
 * its mark doubled four times and more, and the one cow seen that day stood 147 out. A constant, not a world setting:
 * nothing sets it but this, and with a longer leash set the leash is the range (cowRange).
 */
export const COW_RANGE = 256;
/**
 * The farthest the cows' range goes, however long the leash: the run's 10 minutes (work.ts timeoutOf) must hold the
 * whole fetch on the lead (needMs: d + 60 s) after up to 30 s of making room, with the walk home from out there (d / 3
 * s) and the 30 s margin on top: d + 60 <= 600 - 30 - 30 - d / 3 holds up to 360. With a leash of 400 every run said
 * "not setting out" and wrote no mark, so the rung was chosen again at once and never ran (the goal's timeout is fixed
 * when the goal is made, before any world is known).
 */
const COW_RANGE_MAX = 360;
/** The cows' range for a world: COW_RANGE, or the leash where that is longer, no further than COW_RANGE_MAX. */
export const cowRange = (world: WorldMemory): number => Math.min(Math.max(COW_RANGE, world.leash), COW_RANGE_MAX);
/** How far a fetch of this kind goes: the cows to their range, the rest (the sheep) to the leash. */
export function fetchBound(world: WorldMemory, kind: PenKind): Bound {
  return kind === 'cow' ? { blocks: cowRange(world), name: 'the cow range' } : { blocks: world.leash, name: 'the leash' };
}
/** An animal fed to breed can't breed again for 5 minutes (the client can't see that), by entity id. */
const fedAt = new Map<number, number>();

function gateToward(st: MilestoneState, home: { x: number; z: number }): Side {
  const site = st.data.site as { x: number; z: number };
  const cx = site.x + SIZE / 2, cz = site.z + SIZE / 2;
  return Math.abs(home.x - cx) > Math.abs(home.z - cz) ? (home.x < cx ? 'west' : 'east') : (home.z < cz ? 'north' : 'south');
}

export function penMilestone(kind: PenKind, prereqs: string[]): Milestone {
  const zone = `pen:${kind}`;
  const build = buildStep(zone, st => pen(SIZE, st.data.gate as Side), `${kind} pen`);
  return {
    id: `pen-${kind}`,
    title: `a ${kind} pen`,
    prereqs,
    done: v => !!v.world.zones?.[zone]?.length,
    steps: [
      siteStep(`${kind} pen`, SIZE, SIZE),
      { ...build, run: async (ctx, st) => { st.data.gate ??= gateToward(st, ctx.s.home!); return build.run(ctx, st); } }
    ]
  };
}

// ------------------------------------------------------------------------------------------------ the chore

type Ent = Animal & Creature & { category: string; position: Pos };
// someone's animals (named, tamed, on a lead, in their pen or by their builds) are never led, bred or culled
const entities = async (ctx: GoalContext, maxDistance = 48) =>
  (await ctx.call<{ entities: Ent[] }>('world.entities', { maxDistance })).entities.filter(e => e.category === 'creature' && !someones(e, ctx.world.yard));
const find = async (ctx: GoalContext, id: number, maxDistance = 48) => (await entities(ctx, maxDistance)).find(e => e.id === id);
/**
 * The bot's own led animal, whosever the list makes it: an animal on a lead is someone's to `entities` (the client
 * says on a lead, not whose), and the one on the bot's lead is the one it put it on, by id.
 */
const own = async (ctx: GoalContext, id: number) =>
  (await ctx.call<{ entities: Ent[] }>('world.entities', { maxDistance: 48 })).entities.find(e => e.id === id && e.category === 'creature');
/** The same for several, by one look: each as seen, or undefined. */
const ownAll = async (ctx: GoalContext, ids: number[]): Promise<(Ent | undefined)[]> => {
  const seen = (await ctx.call<{ entities: Ent[] }>('world.entities', { maxDistance: 48 })).entities;
  return ids.map(id => seen.find(e => e.id === id && e.category === 'creature'));
};
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const OUT: Record<Side, { x: number; z: number }> = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 }, east: { x: 1, z: 0 } };
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
/** a block cell's middle, for how far the bot (whose position is fractional) is from it */
const mid = (c: { x: number; z: number }) => ({ x: c.x + 0.5, z: c.z + 0.5 });
const cell = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const at = (p: Pos) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;

/**
 * The pen's inside cell nearest a point (the point's own when it is inside): the only cells a walk in the pen goes to.
 * Pressed against the fence from inside, the bot's middle lies in the fence's own cell (its box is 0.6 wide, the
 * post 0.25), and a bot whose block is a fence is wedged: every walk Baritone plans from there goes into the post.
 */
const innerCell = (p: Pen, q: { x: number; z: number }, y: number): Pos => ({
  x: Math.min(Math.max(Math.floor(q.x), p.x1 + 1), p.x2 - 1), y, z: Math.min(Math.max(Math.floor(q.z), p.z1 + 1), p.z2 - 1)
});

/**
 * Where to stand in the pen by an animal at `q`: of the inside cells round its own (innerCell), the nearest the bot,
 * not the one it stands in. Never a cell of the fence ring: a walk to within 2 of the animal could end in the gateway.
 */
function standIn(p: Pen, y: number, me: { x: number; z: number }, q: { x: number; z: number }): Pos {
  const c = innerCell(p, q, y);
  let best = c, d = Infinity;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const x = c.x + dx, z = c.z + dz;
    if ((!dx && !dz) || x <= p.x1 || x >= p.x2 || z <= p.z1 || z >= p.z2) continue;
    const e = horiz(mid({ x, z }), me);
    if (e < d) { d = e; best = { x, y, z }; }
  }
  return best;
}

/** In the pen with the gate shut behind (penVisit): the pen, and the height of its inside cells (the gate's). */
interface Inside { p: Pen; y: number }

/**
 * Walk up to an animal and use `item` on it; true when the client says it was used. `inside`: the bot is in the pen
 * with it (penVisit), and walks carefully to an inside cell by it (standIn); else Baritone's own way, as before (a
 * pen with no gate known).
 */
async function useOn(ctx: GoalContext, id: number, item: string, inside?: Inside): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const e = await find(ctx, id);
    if (!e) return false;
    if (e.distance > 3.5) {
      if (inside) await ctx.call('goto', { ...standIn(inside.p, inside.y, await here(ctx), e.position), range: 0, careful: true, timeoutMs: 15_000 }, 25_000).catch(() => undefined);
      else await ctx.act('move-to-position', { ...e.position, range: 2, timeoutMs: 45_000 });
    }
    try { await ctx.call('entity.use', { id, item }); return true; } catch { /* it moved: again */ }
  }
  return false;
}

/**
 * How far past the pen's inside cells (onto the fence's) a drop is still picked up from the inside cell by it: the
 * game picks up what is within a block of the bot's box and the item's, 1.425 of its middle across the ground (0.3 +
 * 1 + 0.125). A drop 0.75 into the fence's cell (the far edge of one on a post's top) is 1.25 off the inside cell's
 * middle, and the step there ends within DROP_STEER of it: 1.35 at most.
 */
const DROP_REACH = 0.75;
/** How near the inside cell's middle the step for a drop on the fence's cells ends (sneaking: it stops, not overshoots). */
const DROP_STEER = 0.1;

type Drop = { id: number; position: Pos };

/** The items lying round the pen, within 2 of its fence across the ground and 3 of its inside cells' height. */
async function dropsBy(ctx: GoalContext, { p, y }: Inside): Promise<Drop[]> {
  const near = (d: Drop) => d.position.x >= p.x1 - 2 && d.position.x < p.x2 + 3 && d.position.z >= p.z1 - 2 && d.position.z < p.z2 + 3 && Math.abs(d.position.y - y) <= 3;
  return (await ctx.call<{ entities: Drop[] }>('world.entities', { maxDistance: 16, type: 'item' })
    .catch(() => ({ entities: [] as Drop[] }))).entities.filter(near);
}

/**
 * The drops round the pen picked up from its inside cells only: a careful walk (range 0) to the inside cell nearest
 * each, and for one on the fence's cells a straight step to that cell's middle, within it. What lies further out (past
 * the fence, or on top of the far side of it) is left. The cull's drops were picked up the way attack-entity does it,
 * Baritone's own walk to the drop's cell and, with no way there, a straight walk at it: on Nov 13 one by the cow pen's
 * corner post took the bot into the corner, its middle into the post's cell, and the brain's wedge watch then stopped
 * every job for 1 h 45 min. `left`: this cull's drops still lying round the pen; `before`, the ids of what lay there
 * before the fight, is not counted (an earlier cull's leather past the fence lies there 5 minutes, and a round culls
 * several in a visit: each line would say it again).
 */
async function dropsIn(ctx: GoalContext, inside: Inside, before: Set<number>): Promise<{ left: number }> {
  const { p, y } = inside;
  const reachable = (q: Pos) => q.x >= p.x1 + 1 - DROP_REACH && q.x < p.x2 + DROP_REACH && q.z >= p.z1 + 1 - DROP_REACH && q.z < p.z2 + DROP_REACH &&
    q.y >= y - 1 && q.y < y + 2;
  const look = () => dropsBy(ctx, inside);
  let lying = await look();
  const tried = new Set<number>();
  for (let i = 0; i < 6 && !ctx.signal.aborted; i++) {
    const me = await here(ctx);
    const next = lying.filter(d => reachable(d.position) && !tried.has(d.id)).sort((a, b) => horiz(a.position, me) - horiz(b.position, me))[0];
    if (!next) break;
    tried.add(next.id);
    const to = innerCell(p, next.position, y);
    await ctx.call('goto', { ...to, range: 0, careful: true, timeoutMs: 15_000 }, 25_000).catch(() => undefined);
    // (a walk ends anywhere in the cell: from its middle the fence's cell by it is in reach)
    if (!within(p, next.position)) await ctx.call('steer', { ...mid(to), y, within: DROP_STEER, sneak: true, timeoutMs: 1500 }, 5000).catch(() => undefined);
    lying = await look();
  }
  return { left: lying.filter(d => !before.has(d.id)).length };
}

/**
 * A cull from inside the pen: a careful walk to an inside cell by the animal first (standIn), so the fight starts
 * within reach and its own chase (Baritone's walk to within 2) has little or nothing to do; then the fight, its drops
 * left to dropsIn, not picked up the fight's way. The fight's text, and how many drops were left by the fence.
 */
async function cullIn(ctx: GoalContext, inside: Inside, id: number): Promise<{ ok: boolean; text: string; left: number }> {
  const e = await find(ctx, id);
  if (e && e.distance > 2.5) {
    await ctx.call('goto', { ...standIn(inside.p, inside.y, await here(ctx), e.position), range: 0, careful: true, timeoutMs: 15_000 }, 25_000).catch(() => undefined);
  }
  const before = new Set((await dropsBy(ctx, inside)).map(d => d.id));
  const r = await ctx.act('attack-entity', { target: `#${id}`, maxDistance: 24, timeoutMs: 30_000, collect: false });
  const { left } = await dropsIn(ctx, inside, before);
  return { ...r, left };
}

/** The pen's gate, the cells just outside it and two in, and the last row in before the far fence (`deep`). */
export function gateOf(gate: { x: number; y: number; z: number } | undefined, p: Pen) {
  if (!gate) return undefined;
  const side: Side = gate.z === p.z1 ? 'north' : gate.z === p.z2 ? 'south' : gate.x === p.x1 ? 'west' : 'east';
  const o = OUT[side];
  const depth = (side === 'north' || side === 'south' ? p.z2 - p.z1 : p.x2 - p.x1) - 1;
  return {
    gate, side, outside: { x: gate.x + o.x, y: gate.y, z: gate.z + o.z }, inside: { x: gate.x - 2 * o.x, y: gate.y, z: gate.z - 2 * o.z },
    deep: { x: gate.x - depth * o.x, y: gate.y, z: gate.z - depth * o.z }
  };
}
type Way = NonNullable<ReturnType<typeof gateOf>>;

/** A pen of the bot's as world memory has it, and its gate when it has one. */
function penOf(world: WorldMemory, kind: PenKind): { p: Pen; way?: Way } | undefined {
  const z = world.zones?.[`pen:${kind}`]?.[0];
  if (!z?.width || !z.length) return undefined;
  const p: Pen = { x1: z.x, z1: z.z, x2: z.x + z.width - 1, z2: z.z + z.length - 1, kind };
  return { p, way: gateOf(world.zones?.[`pen:${kind}:gate`]?.[0], p) };
}

/** A pen of the bot's with a gate to bring an animal in by (pure: the cows rung's gate asks it too). */
export function penAt(world: WorldMemory, kind: PenKind): { p: Pen; way: Way } | undefined {
  const o = penOf(world, kind);
  return o?.way ? { p: o.p, way: o.way } : undefined;
}

/** Inside the fence, not on it (a block column x covers [x, x + 1)): the fence ring and the gateway are not in. */
const within = (p: Pen, e: { x: number; z: number }) => e.x >= p.x1 + 1 && e.x < p.x2 && e.z >= p.z1 + 1 && e.z < p.z2;
/** How far in from the gate (the gate block's middle is 0). */
const depthIn = (way: Way, e: { x: number; z: number }) => -((e.x - (way.gate.x + 0.5)) * OUT[way.side].x + (e.z - (way.gate.z + 0.5)) * OUT[way.side].z);
/** In, and clear of the gateway: the bot can walk out past it and shut the gate behind with it inside. */
const wellIn = (p: Pen, way: Way, e: { x: number; z: number }) => within(p, e) && depthIn(way, e) >= 1.5;

async function gateOpen(ctx: GoalContext, g: { x: number; y: number; z: number }): Promise<boolean> {
  const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...g, width: 1, height: 1, length: 1 });
  return /open=true/.test(blocks[0] ?? '');
}
const toggle = (ctx: GoalContext, g: Pos) => ctx.act('use-item-on-block', { ...g, face: 'up', toggle: true });

const carried = async (ctx: GoalContext, name: string) =>
  (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items.filter(i => i.slot < 36 && i.name === name).reduce((n, i) => n + i.count, 0);
const here = async (ctx: GoalContext): Promise<Pos> => (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;

/**
 * Calls that put the client back as the walk found it (sprint, the gates, a lead let go), made for a run the brain
 * has given up as well: from then on that run's own calls fail at once, and an aborted lure left the gates for good
 * open behind the bot (gates.auto off) and its sprint off.
 */
const tidyUp = (fn: () => Promise<unknown>) => brainRun.exit(() => fn()).catch(() => undefined);

// ---- what the animal is walked home by

/**
 * Blocks a leg on the lead. The game pulls a led animal toward the bot from 6 blocks off and the lead breaks past 12
 * (26.3: Leashable LEASH_ELASTIC_DIST, LEASH_TOO_FAR_DIST): short legs, and a wait after each, keep it within 6.
 */
const LEAD_LEG = 4;
/** Within this of the bot the led animal is with it: the next leg goes. */
const HEEL = 4;
/** Blocks a leg of the walk home with an animal on the food. */
const LEG = 3;
/** Leads the fetch keeps on hand: two wild ones grazing together come in on one walk, the pair the pen breeds from. */
const LEADS = 2;
/** A second wild one this near the first (blocks) is led in with it. */
const MATE_NEAR = 8;

type Hold = { lead: true } | { food: string };

/**
 * Leads to walk the animal home by: two kept on hand, carried, else from the chests, else made from 5 string (two
 * leads, at the home table: the recipe is 3x3), the way the kit and the shears are made (project.ts prepareBill); one
 * carried will do when no second is to be had. With none, its food in hand, as before: `why` says so. Neither: no
 * hold, and why.
 */
async function holdFor(ctx: GoalContext, kind: PenKind): Promise<{ hold?: Hold; why: string }> {
  if ((await carried(ctx, 'lead')) >= LEADS) return { hold: { lead: true }, why: '' };
  const short = await prepareBill(ctx, { lead: LEADS }, { record: false }).catch(() => ({ lead: LEADS }));
  if ((await carried(ctx, 'lead')) > 0) return { hold: { lead: true }, why: '' };
  const words = Object.entries(short).filter(([k]) => k !== 'lead').map(([k, v]) => `${v} ${k}`).join(', ');
  const why = `no lead to be had (${words ? `short of ${words} for one` : 'none carried or stored, and none would craft'})`;
  for (const f of PEN_FOOD[kind]) if ((await carried(ctx, f)) >= 2) return { hold: { food: f }, why };
  for (const f of PEN_FOOD[kind]) if (await takeFromChests(ctx, f, 16)) return { hold: { food: f }, why };
  return { why: `${why}, and no ${PEN_FOOD[kind][0]} to lure one with` };
}

/**
 * The walk to an animal, careful in and by the yard (the bot's own builds), Baritone's own way out in the wild. From
 * inside the fence to one outside it, out by a gate first (work.ts outByGate); with no gate that lets it out, the
 * careful walk straight there as before (to the animal's own block: no cave under the yard ends that walk).
 */
async function walkTo(ctx: GoalContext, p: Pos, range: number): Promise<void> {
  const yard = ctx.world.yard;
  let me = await here(ctx);
  const homely = !!yard && [me, p].some(q => q.x >= yard.x1 - 8 && q.x < yard.x2 + 9 && q.z >= yard.z1 - 8 && q.z < yard.z2 + 9);
  if (homely) me = (await outByGate(ctx, p)).at ?? me;
  // a walk that ends a few blocks short throws ("no path found ... 3.61 blocks away", the cow on a ledge): that
  // failed the whole fetch, though the lead or the wheat reaches it from there: the close-in judges that
  if (homely) await ctx.call('goto', { ...cell(p), range, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => undefined);
  else await ctx.act('move-to-position', { ...cell(p), range, timeoutMs: 120_000 }).catch(() => undefined);
}

/** said of an animal that has grazed on past the fetch's bound (the leash, the cow range): it is not followed there */
const past = (bound: Bound) => `it wandered past ${bound.name}`;

/**
 * Up to the animal: where it stood when seen (77 blocks off, once) is not where it grazes by the time the bot gets
 * there ("it stopped following" at the first leg), so close in on where it is now, three times at most, and never
 * past the bound (a cow seen 95 out grazed on past the leash). The animal as last seen within 3, or why not.
 */
async function reach(ctx: GoalContext, id: number, home: Pos, bound: Bound, food?: string): Promise<{ e?: Ent; why?: string }> {
  let e = await find(ctx, id, 96);
  if (!e) return { why: 'it wandered off before the bot got to it' };
  if (horiz(e.position, home) > bound.blocks) return { why: past(bound) };
  if (food) await ctx.call('item.select', { name: food });
  if (e.distance > 3) await walkTo(ctx, e.position, 3);
  for (let i = 0; i < 3; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    e = await find(ctx, id);
    if (!e) return { why: 'it wandered off before the bot got to it' };
    if (horiz(e.position, home) > bound.blocks) return { why: past(bound) };
    if (e.distance <= 3) return { e };
    if (food) await ctx.call('item.select', { name: food });
    await walkTo(ctx, e.position, 2);
  }
  e = await find(ctx, id);
  return e && e.distance <= 4 ? { e } : { why: e ? `the bot could get no nearer than ${Math.round(e.distance)} blocks` : 'it wandered off before the bot got to it' };
}

/**
 * A lead on it: the client's use key with the lead in hand, within 4.5 blocks. Only a wild one: `find` leaves out a
 * named, tamed or led animal and one in someone's pen or by their builds, as the pens round does (the game would take
 * an animal off a fence post's knot onto the bot's lead). On once the client shows it led. `used` is called as the
 * lead is used on it: the game may take it, shown or not (a slow client may show it later, and a run given up just
 * then is refused its next look and throws here), and the run takes it off again at its end. Past the leash the land
 * is new to the bot: the mod looks for builds only 48 round it, every 5 s, and a cow by someone's farm out there may
 * not show it yet when the bot comes up to it. There the mod looks again from beside it (foreign.zones looks afresh)
 * and the cow is judged by that look before the lead goes on.
 */
async function leashOn(ctx: GoalContext, id: number, home: Pos, bound: Bound, used: () => void = () => undefined): Promise<{ ok: boolean; why: string }> {
  let why = 'it stayed out of reach';
  const theirs = 'it is gone from sight, or is someone\'s';
  for (let i = 0; i < 2; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const e = await find(ctx, id);
    if (!e) return { ok: false, why: theirs };
    if (horiz(e.position, home) > bound.blocks) return { ok: false, why: past(bound) };
    if (e.distance > 3.5) await walkTo(ctx, e.position, 2);
    if (horiz(e.position, home) > ctx.world.leash) {
      await ctx.call('foreign.zones').catch(() => undefined);
      if (!(await find(ctx, id))) return { ok: false, why: theirs };
    }
    let r: { success?: boolean; result?: string };
    used();
    try {
      r = await ctx.call<{ success?: boolean; result?: string }>('entity.use', { id, item: 'lead' });
    } catch (err) {
      why = (err as Error).message.split('\n')[0].slice(0, 80);
      continue;
    }
    if (r.success === false) { why = `the game said ${r.result ?? 'no'}`; continue; }
    for (let w = 0; w < 5; w++) {
      if ((await own(ctx, id))?.leashed) return { ok: true, why: '' };
      await pause(400);
    }
    // (not tried again: on the bot's lead after all, a second use would take it off)
    return { ok: false, why: 'the client used the lead on it, but it did not show on a lead' };
  }
  return { ok: false, why };
}

/** A dropped lead picked up: walked onto, round `near` (a lead that comes off a mob falls where the mob stands). */
async function pickUpLead(ctx: GoalContext, near: Pos): Promise<boolean> {
  const before = await carried(ctx, 'lead');
  for (let i = 0; i < 3; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const lying = (await ctx.call<{ entities: { id: number; item?: string; position: Pos }[] }>('world.entities', { maxDistance: 32, type: 'item' })).entities
      .filter(e => e.item === 'lead' && horiz(e.position, near) <= 8).sort((a, b) => horiz(a.position, near) - horiz(b.position, near))[0];
    if (!lying) { await pause(500); continue; }
    await ctx.call('goto', { ...cell(lying.position), range: 0, careful: true, timeoutMs: 15_000 }, 25_000).catch(() => undefined);
    if ((await carried(ctx, 'lead')) > before) return true;
  }
  return (await carried(ctx, 'lead')) > before;
}

/**
 * Take the bot's lead off the animal: the use key on it again. The game asks whose lead it is before what is in hand
 * (Entity.interact: a mob led by this player comes off with anything in hand but shears or a name tag; Mob.interact
 * asks that before feeding), so a sword in hand, as the lure puts its food away. The lead falls where the animal
 * stands and is picked up. No knot on the fence: nothing here uses a fence.
 */
async function letGo(ctx: GoalContext, id: number): Promise<{ off: boolean; picked: boolean }> {
  let e = await own(ctx, id);
  let off = !e?.leashed;
  if (e?.leashed) {
    if (e.distance > 3.5) { await walkTo(ctx, e.position, 2); e = (await own(ctx, id)) ?? e; }
    const weapon = ctx.s.items.find(i => /_sword$/.test(i.name))?.name;
    if (weapon) await ctx.call('item.select', { name: weapon }).catch(() => undefined);
    await ctx.call('entity.use', { id }).catch(() => undefined);
    for (let w = 0; w < 4 && !off; w++) {
      const o = await own(ctx, id);
      if (!o?.leashed) { e = o ?? e; off = true; break; }
      await pause(400);
    }
  }
  return { off, picked: e ? await pickUpLead(ctx, e.position) : false };
}

/**
 * Off the bot's leads where a run that was given up left them, walking nowhere: the bot stands, and a led animal
 * closes in to 2 within a second or two (a 4-block leg leaves it up to 6 behind, past the 4.5 the use key reaches; one
 * use at once left the cow on the lead, dragged after whatever the bot did next). Up to 4 looks half a second apart,
 * about 2.5 s, both of two seen to at each: the brain waits 5 s for a run it stopped before survival goes on. Each
 * lead falls by its animal. None shown on a lead at the first look, a second half a second on: a lead put on just as
 * the run was given up shows only once the server's word of it reaches the client.
 */
async function offLead(ctx: GoalContext, ids: number[]): Promise<void> {
  const look = async () => (await ownAll(ctx, ids)).filter((o): o is Ent => !!o?.leashed);
  let on = await look();
  if (!on.length) { await pause(500); on = await look(); }
  if (!on.length) return;
  const weapon = ctx.s.items.find(i => /_sword$/.test(i.name))?.name;
  if (weapon) await ctx.call('item.select', { name: weapon }).catch(() => undefined);
  for (let i = 0; i < 4 && on.length; i++) {
    for (const o of on) if (o.distance <= 4) await ctx.call('entity.use', { id: o.id }).catch(() => undefined);
    await pause(500);
    on = await look();
  }
}

// ---- where a lead walk stands, and the way round the pen to its gate

type Cell = { x: number; z: number };
/** The gates and doors world memory knows: the yard's, the pens', the buildings'. */
const doorways = (world: WorldMemory) => Object.entries(world.zones ?? {}).filter(([k]) => /:(gate|door)$/.test(k)).flatMap(([, zs]) => zs);

/**
 * Where a walk with an animal may stop and wait for it: 2 cells clear of every gate and door, not on a fence line,
 * and not inside what world memory knows is built or fenced (a pen, the storage house, the plot, the tree farm; the
 * yard's own fence box aside). Live on Nov 13 two walks home on the lead stopped in the yard's north gate for the
 * waits for the cow, and the brain's wedge watch stopped both there: "wedged in the oak_fence_gate at -549,63,2119",
 * the cow let go outside the fence.
 */
export function standsClear(world: WorldMemory): (c: Cell) => boolean {
  const ways = doorways(world);
  const fence = fencesOf(world);
  const built = builtAt(world);
  return c => ways.every(g => Math.max(Math.abs(c.x - g.x), Math.abs(c.z - g.z)) >= 2) && !fence(c.x, c.z) && !built(c.x, c.z);
}

/** In a box world memory knows is built or fenced (every zone with a size but the yard's fence), or within `by` of one. */
function builtAt(world: WorldMemory, by = 0): (x: number, z: number) => boolean {
  const built = Object.entries(world.zones ?? {}).filter(([k]) => k !== 'fence').flatMap(([, zs]) => zs).filter(b => b.width && b.length);
  return (x, z) => built.some(b => x >= b.x - by && x < b.x + b.width! + by && z >= b.z - by && z < b.z + b.length! + by);
}

/** The fence lines world memory knows, cell by cell: the yard's and the pens', their gates as shut but those in `open`. */
function fencesOf(world: WorldMemory, open: Pos[] = []): (x: number, z: number) => boolean {
  const rings = [
    ...(world.yard ? [world.yard] : []),
    ...Object.entries(world.zones ?? {}).filter(([k]) => /^pen:[a-z]+$/.test(k)).flatMap(([, zs]) => zs).filter(b => b.width && b.length)
      .map(b => ({ x1: b.x, z1: b.z, x2: b.x + b.width! - 1, z2: b.z + b.length! - 1 }))
  ];
  return (x, z) => !open.some(g => g.x === x && g.z === z)
    && rings.some(r => ((x === r.x1 || x === r.x2) && z >= r.z1 && z <= r.z2) || ((z === r.z1 || z === r.z2) && x >= r.x1 && x <= r.x2));
}

/**
 * No fence cell on the straight line from a to b, the line a lead pulls an animal along: every cell it passes through,
 * one it only clips the corner of too (a cow is 0.9 wide, a gateway 1).
 */
function lineClear(a: Cell, b: Cell, fence: (x: number, z: number) => boolean): boolean {
  let x = Math.floor(a.x), z = Math.floor(a.z);
  const dx = b.x - a.x, dz = b.z - a.z;
  const sx = Math.sign(dx), sz = Math.sign(dz);
  // (how far along the line, 0 to 1, the next cell edge across x and across z is, and the step between edges)
  const next = (p: number, d: number, s: number) => (s === 0 ? Infinity : (s > 0 ? Math.floor(p) + 1 - p : p - Math.floor(p)) / Math.abs(d));
  let tx = next(a.x, dx, sx), tz = next(a.z, dz, sz);
  const stepX = sx ? 1 / Math.abs(dx) : Infinity, stepZ = sz ? 1 / Math.abs(dz) : Infinity;
  for (let i = 0; i < 4096; i++) {
    if (tx > 1 && tz > 1) return true;
    if (tx < tz) { x += sx; tx += stepX; } else if (tz < tx) { z += sz; tz += stepZ; } else {
      // through a corner exactly: both cells beside it are in its way
      if (fence(x + sx, z) || fence(x, z + sz)) return false;
      x += sx; z += sz; tx += stepX; tz += stepZ;
    }
    if (fence(x, z)) return false;
  }
  return true;
}

/** The cell `n` out from the pen's gate, on its line. */
const outOf = (way: Way, n: number): Pos => ({ x: way.gate.x + n * OUT[way.side].x, y: way.gate.y, z: way.gate.z + n * OUT[way.side].z });

/**
 * The berths round a pen tried in turn, the first that keeps inside the yard and off what is built: blocks out from
 * the fence on its three shut sides, and on its gate's side. 3 keeps a led animal pulled round a corner clear of the
 * corner post, and of the cow barn's posts 1 out from the live pen's corners (at 2 the straight pull of one 2 behind
 * the bot would cut across them); the gate's side further out, so the last stretch runs straight in along the gate's
 * line with the animal behind the bot.
 */
const BERTHS: [number, number][] = [[3, 6], [3, 5], [3, 4], [3, 3], [2, 4], [2, 3], [2, 2]];

/**
 * The way round the pen to its gate from `from` (in the yard): onto a ring round the pen at a berth (BERTHS), round it
 * the shorter way, past its corners, to the gate's line, and in along it to the cell 2 outside the gate. A lead pulls
 * an animal in a straight line toward the bot, and a fence stops it: live on Nov 13 the walk from the north gate
 * straight at the pen's south gate went round the pen close by, the cow drawn after it against the pen's north fence,
 * and it stood there, 2 off the bot inside, across the fence ("at the gate it would not come in"). No ring fits: that
 * cell straight, as before. Cells at the gate's height. `open`: what a look round the pen found a body can walk
 * through (openRound): a ring, or the gate's line in from it, through a build world memory does not know is not
 * tried (live, the sheep pen's every ring went through the cottage, 2 from its gate).
 */
export function penWay(world: WorldMemory, p: Pen, way: Way, from: Cell, open: (c: Cell) => boolean = () => true): Pos[] {
  const y = way.gate.y;
  const two = outOf(way, 2);
  const ok = standsClear(world);
  for (const [s, g] of BERTHS) {
    const X0 = p.x1 - (way.side === 'west' ? g : s), X1 = p.x2 + (way.side === 'east' ? g : s);
    const Z0 = p.z1 - (way.side === 'north' ? g : s), Z1 = p.z2 + (way.side === 'south' ? g : s);
    const ring: Cell[] = [];
    for (let x = X0; x <= X1; x++) ring.push({ x, z: Z0 }, { x, z: Z1 });
    for (let z = Z0 + 1; z < Z1; z++) ring.push({ x: X0, z }, { x: X1, z });
    if (!ring.every(c => ok(c) && (!world.yard || inFence(world, c)) && open(c))) continue;
    if (!Array.from({ length: g - 1 }, (_, i) => outOf(way, i + 2)).every(open)) continue;
    // where along the ring a cell of it is, clockwise from its north-west corner
    const W = X1 - X0, H = Z1 - Z0, P = 2 * (W + H);
    const along = (c: Cell) => (c.z === Z0 ? c.x - X0 : c.x === X1 ? W + c.z - Z0 : c.z === Z1 ? W + H + X1 - c.x : 2 * W + H + Z1 - c.z);
    const corners: Cell[] = [{ x: X0, z: Z0 }, { x: X1, z: Z0 }, { x: X1, z: Z1 }, { x: X0, z: Z1 }];
    // onto it: the nearest cell of it (from inside it, toward the nearest side)
    const b = { x: Math.floor(from.x), z: Math.floor(from.z) };
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    let onto: Cell = { x: clamp(b.x, X0, X1), z: clamp(b.z, Z0, Z1) };
    if (b.x > X0 && b.x < X1 && b.z > Z0 && b.z < Z1) {
      const d = [b.z - Z0, X1 - b.x, Z1 - b.z, b.x - X0];
      onto = [{ x: b.x, z: Z0 }, { x: X1, z: b.z }, { x: b.x, z: Z1 }, { x: X0, z: b.z }][d.indexOf(Math.min(...d))];
    }
    // (that one, or the nearest a straight walk to keeps a block clear of the builds world memory knows; with the bot
    // standing by one, the nearest it keeps out of them: from the yard's south gate the nearest, the corner behind the
    // storage house, lay through the house, its door and all, the cow on the lead)
    for (const near of [builtAt(world, 1), builtAt(world)]) {
      const to = lineClear(from, mid(onto), near) ? onto : ring.filter(c => lineClear(from, mid(c), near)).sort((c, d) => horiz(from, mid(c)) - horiz(from, mid(d)))[0];
      if (to) { onto = to; break; }
    }
    const line = outOf(way, g);
    const cw = (((along(line) - along(onto)) % P) + P) % P;
    const back = (P - cw) % P;
    const off = (c: Cell) => (cw <= back ? (((along(c) - along(onto)) % P) + P) % P : (((along(onto) - along(c)) % P) + P) % P);
    const past = corners.filter(c => off(c) > 0 && off(c) < Math.min(cw, back)).sort((c, d) => off(c) - off(d));
    const pts = [onto, ...past, line, two].filter((c, i, all) => i === 0 || c.x !== all[i - 1].x || c.z !== all[i - 1].z);
    return pts.map(c => ({ x: c.x, y, z: c.z }));
  }
  return [two];
}

/** Plants a body walks through that CLEAR (work.ts) leaves out: a ring over a patch of pink petals goes through no build. */
const PLANTS = /^(minecraft:)?(pink_petals|wildflowers|firefly_bush|short_dry_grass|tall_dry_grass|sunflower|lilac|rose_bush|peony|red_mushroom|brown_mushroom)(\[|$)/;

/**
 * What a body can walk through round a pen, by one look (world.region) at its gate's height, feet and head, out as far
 * as the berths and the gate's line go (BERTHS): world memory knows the pens, the storage house and the plot, not
 * every build. Live, the cottage's south wall stands 2 out from the sheep pen's gate (its cell 2 out), and every ring
 * round that pen went through the cottage. A cell the look did not cover, or did not see (not loaded: a fetch from
 * far out), or a look that failed: as world memory has it.
 */
async function openRound(ctx: GoalContext, p: Pen, y: number): Promise<(c: Cell) => boolean> {
  const R = 6;
  const box = { x: p.x1 - R, y, z: p.z1 - R, width: p.x2 - p.x1 + 1 + 2 * R, height: 2, length: p.z2 - p.z1 + 1 + 2 * R };
  const blocks = (await ctx.call<{ blocks?: (string | null)[] }>('world.region', box).catch(() => undefined))?.blocks;
  if (!blocks || blocks.length < box.width * box.height * box.length) return () => true;
  // (x fastest, then z, then y)
  const block = (c: Cell, dy: number) => blocks[dy * box.width * box.length + (c.z - box.z) * box.width + (c.x - box.x)];
  return c => c.x < box.x || c.x >= box.x + box.width || c.z < box.z || c.z >= box.z + box.length
    || [0, 1].every(dy => { const b = block(c, dy); return b === null || b === undefined || CLEAR.test(b) || PLANTS.test(b); });
}

/**
 * The way round to the gate's side and in along its line (penWay, roundToGate) is open: nothing world memory does not
 * know stands in the cell 2 out or the one by the gate (the cottage's wall 2 out from the sheep pen's gate). Not so: the
 * walk to the cell outside the gate, and in, as before (from the row between the wall and the fence no led one ever
 * stood on the gate's line, and every lure there ended "it would not come round to the gate").
 */
const roundable = (way: Way, open: (c: Cell) => boolean) => open(outOf(way, 2)) && open(way.outside);

/** A stop on the way in: `pass`, one walk through the yard's gate from 2 before it to 2 beyond; `xz`, at any height; `exact`, to the cell itself. */
interface Stop { at: Pos; pass?: true; xz?: true; exact?: true }

/**
 * The way to the pen's gate from out there: through the yard's gate that makes the shortest way round (its cell 2
 * outside, then 2 inside in one walk: work.ts gatesBetween, which the walks out of the yard go by too), then round the
 * pen to its gate (penWay) with an animal on a lead, or to the cell 2 outside the gate with one after food (a tempted
 * animal walks the way round itself). On a lead, up to the yard's gate along its line from 6 out first (unless
 * already on that line by the gate), and on in along it after the pass: the lead pulls in a straight line, and an
 * animal brought in at the gate from the side, or turned there, is drawn across the post beside it. No way through a
 * build the look round the pen saw (openRound). A leg aimed at the pen through the fence had Baritone walk the fence
 * round to a gate in one go, out of the animal's reach. From inside the yard, or with no gate known, from where the
 * bot stands.
 */
function routeFor(world: WorldMemory, me: Pos, from: Pos, p: Pen, way: Way, lead: boolean, open: (c: Cell) => boolean): { points: Stop[]; gate?: Pos } {
  const two = outOf(way, 2);
  // (onto the gate's line, and to the cell outside the gate, to the cells themselves: a walk to within 1 of one
  // ends beside it, and the animal comes in at the gate from the side)
  const pen = (start: Cell): Stop[] => {
    // (no walking through the cell 2 out or the one by the gate: a build stands there that world memory does not
    // know, the cottage's wall by the sheep pen's gate. To within 1 of the cell outside the gate, as before)
    if (!roundable(way, open)) return [{ at: way.outside }];
    const pts = lead ? penWay(world, p, way, start, open) : [two];
    return pts.map((at, i) => ({ at, ...(i >= pts.length - (lead ? 2 : 1) ? { exact: true as const } : {}) }));
  };
  if (!world.yard || inFence(world, from) || !inFence(world, way.outside)) return { points: pen(me) };
  const best = gatesBetween(world, mid(way.outside), from)[0];
  if (!best) return { points: pen(me) };
  const far = { x: best.gate.x + 3 * (best.outer.x - best.gate.x), y: best.gate.y, z: best.gate.z + 3 * (best.outer.z - best.gate.z) };
  // (already on the gate's line outside it, and no further out than that stop: none. By the gate but to its side, a
  // cow led in was caught on the post beside it. To the cell itself: a walk that ended within 1.5 of it, as other
  // stops do, stood a block off the line, and the cow 2 behind was brought in from the side all the same)
  const ux = (best.outer.x - best.gate.x) / 2, uz = (best.outer.z - best.gate.z) / 2;
  const rx = me.x - mid(best.gate).x, rz = me.z - mid(best.gate).z;
  const outward = rx * ux + rz * uz, aside = Math.abs(rx * uz - rz * ux);
  const lineUp: Stop[] = lead && !(aside < 0.75 && outward >= 1.5 && outward <= 6.5) ? [{ at: far, xz: true, exact: true }] : [];
  // on a lead, on in along the gate's line past the cell 2 in, up to 6 in where the yard and the builds allow: there
  // the animal, 2 behind, stands in the gateway, and the next leg's turn pulled it onto the post beside it (the west
  // gate, on the way to the pen's west side)
  const ok = standsClear(world);
  const inward = (n: number): Pos => ({ x: best.gate.x + n * (best.inner.x - best.gate.x) / 2, y: best.gate.y, z: best.gate.z + n * (best.inner.z - best.gate.z) / 2 });
  const deep = lead ? [6, 5, 4, 3].find(m => ok(inward(m)) && inFence(world, inward(m)) && Array.from({ length: m - 2 }, (_, i) => inward(i + 3)).every(open)) : undefined;
  // (by 4 in first, where that is further: there the animal 2 behind is in the fence, clear of the gateway, and the
  // gate is shut from there, in reach. From 6 in the bot walked back toward it past the animal, and a run given up
  // in that walk left the gate open till dusk: the click of a run given up walks nowhere, and reaches 4.5)
  const deeper: Stop[] = deep === undefined ? [] : [...(deep > 4 && ok(inward(4)) ? [inward(4)] : []), inward(deep)].map(at => ({ at, exact: true as const }));
  return { points: [...lineUp, { at: best.outer }, { at: best.inner, pass: true }, ...deeper, ...pen(mid(deeper.at(-1)?.at ?? best.inner))], gate: best.gate };
}

/**
 * The cell a walk from `me` toward `to` gets to `s` blocks on: its floor at that point of the line.
 */
const onLine = (me: Cell, to: Cell, s: number): Cell => {
  const d = horiz(me, to);
  return { x: Math.floor(me.x + (to.x - me.x) * s / d), z: Math.floor(me.z + (to.z - me.z) * s / d) };
};

/**
 * One leg toward `w`: `leg` blocks at most, careful (walk only: Baritone's tool pick took the wheat out of hand
 * mid-leg); the last one to the cell itself (to within 1 of it, or `exact`). With `ok`, where the bot may stop and wait
 * for its animal (standsClear): a leg that would end in a gateway, or by it, or in a building, ends at the last cell
 * short of it that will do, or failing that goes on past it in one walk, as far as another leg (a gate: from 2
 * before it to 2 beyond).
 */
async function stepToward(ctx: GoalContext, me: Pos, w: Pos, leg: number, o: { ok?: (c: Cell) => boolean; xz?: boolean; exact?: boolean } = {}): Promise<void> {
  const d = horiz(me, mid(w));
  let s = Math.min(leg, d);
  if (o.ok && d > leg) {
    const mine = cell(me);
    const stand = (t: number) => { const c = onLine(me, mid(w), t); return (c.x !== mine.x || c.z !== mine.z) && o.ok!(c); };
    const short = Array.from({ length: leg }, (_, i) => leg - i).find(stand);
    const beyond = Array.from({ length: leg }, (_, i) => leg + 1 + i).find(t => t < d && stand(t));
    s = short ?? beyond ?? (d <= 2 * leg ? d : leg);
  }
  const to = s >= d ? { x: w.x, y: w.y, z: w.z, ...(o.xz ? { xz: true } : {}), range: o.exact ? 0 : 1 }
    // (any height: the ground between here and there is not known)
    : { ...onLine(me, mid(w), s), y: w.y, xz: true, range: 1 };
  await ctx.call('goto', { ...to, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
}

/**
 * After a leg on the lead: the animal close again (within 4, up to 6 s), and when it lags, a step back toward it to
 * give it slack, twice at most: halfway back, or with `ok` the cell nearest halfway on the way back where the bot may
 * stand (never back into a gateway: the step back from 2 inside the yard's gate toward a cow 4 outside it went to the
 * gate itself), none at all when there is none. Off the lead (`broke`), gone from sight, or as last seen. `rounds`:
 * of looks (up to 6 s each), the steps back between them.
 */
async function heelLead(ctx: GoalContext, id: number, ok?: (c: Cell) => boolean, rounds = 3): Promise<{ e?: Ent; broke?: true }> {
  let e: Ent | undefined;
  for (let tries = 0; tries < rounds; tries++) {
    for (let w = 0; w < 8; w++) {
      e = await own(ctx, id);
      if (!e) return {};
      if (!e.leashed) return { e, broke: true };
      if (e.distance <= HEEL) return { e };
      await pause(750);
    }
    if (tries === rounds - 1) return { e };
    const me = await here(ctx);
    const half = { x: (me.x + e!.position.x) / 2, z: (me.z + e!.position.z) / 2 };
    const mine = cell(me);
    const steps = Math.floor(horiz(me, half) * 2);
    const to = !ok ? { x: Math.floor(half.x), z: Math.floor(half.z) }
      : Array.from({ length: steps }, (_, i) => onLine(me, half, (steps - i) / 2)).find(c => (c.x !== mine.x || c.z !== mine.z) && ok(c));
    if (!to) continue;
    await ctx.call('goto', { ...to, y: Math.floor(e!.position.y), xz: true, range: 1, careful: true, timeoutMs: 15_000 }, 25_000)
      .catch(() => undefined);
  }
  return { e };
}

/**
 * Wait for a lured animal to close in (food in hand, up to 8 s), and when it lags (5 to 10 off) step back toward it
 * to tempt it again, twice at most. The animal as last seen, or undefined when it's gone.
 */
async function keepClose(ctx: GoalContext, id: number, food: string): Promise<Ent | undefined> {
  let e: Ent | undefined;
  for (let tries = 0; tries < 3; tries++) {
    for (let w = 0; w < 8; w++) {
      await ctx.call('item.select', { name: food }).catch(() => undefined);
      e = await find(ctx, id);
      if (!e || e.distance < 5) return e;
      await pause(1000);
    }
    if (!e || e.distance > 10 || tries === 2) return e;
    // lagging: halfway back toward it, food out
    const me = await here(ctx);
    await ctx.call('goto', { x: Math.floor((me.x + e.position.x) / 2), y: Math.floor(e.position.y), z: Math.floor((me.z + e.position.z) / 2), range: 1, careful: true, timeoutMs: 15_000 }, 25_000)
      .catch(() => undefined);
  }
  return e;
}

/** How a walk-in ended: how many came into the pen, in words, and where one not brought in was last seen. */
interface Brought { penned: number; text: string; last?: Pos }

/** An animal on the walk home: its id, as last seen, its lead's breaks, `nth` (`first `, `second `: two on leads). */
interface Led { id: number; last: Ent; broke: number; nth: string }

/**
 * The second of two on leads: up to it with the first on its lead, in legs of LEAD_LEG at most, the first heeled after
 * each (one walk of 8 would leave the first past what its lead holds), and the other lead on it. The second as seen,
 * or why not (the first off its lead on the way is said, and the walk home deals with it as with any break).
 */
async function toSecond(ctx: GoalContext, id: number, first: Led, home: Pos, bound: Bound, used: () => void): Promise<{ e?: Ent; why: string }> {
  for (let i = 0; i < 4; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const e = await find(ctx, id);
    if (!e) return { why: 'it wandered off before the bot got to it' };
    if (horiz(e.position, home) > bound.blocks) return { why: past(bound) };
    if (e.distance <= 3) {
      const on = await leashOn(ctx, id, home, bound, used);
      return on.ok ? { e, why: '' } : { why: `it would not take the lead (${on.why})` };
    }
    const ok = standsClear(ctx.world);
    await stepToward(ctx, await here(ctx), cell(e.position), LEAD_LEG, { ok });
    const h = await heelLead(ctx, first.id, ok);
    if (!h.e || h.broke) return { why: 'the first came off its lead on the way to it' };
    first.last = h.e;
  }
  return { why: 'the bot could get no nearer to it' };
}

/**
 * Walk animals into their pen: up to the first, a lead on it (or its food in hand), and with `pair` (a second lead
 * carried) and another wild one within 8 of it, as a look from beside it shows, up to that one and the other lead on
 * it (two at once: the pair the pen breeds from in one walk; a look from 48 off, where the first was seen, misses one
 * grazing behind it). Home in short legs through the yard's gate (shut behind them once they are through), on a lead
 * round the pen to its gate's side (routeFor, penWay) and there till each led one has come round behind the bot
 * (roundToGate), in at the pen's gate, and right across the pen: a tempted animal stops 2.5 blocks from the bot
 * (TemptGoal) and a led one 2 (PathfinderMob), and with the bot only 2 in, both stopped in the gateway. Off the lead
 * there (picked up), or the food put away, out, the gate shut. Every wait for the animals is 2 clear of the gates and
 * doors (standsClear), and a gate is passed in one walk. One of two lost or broken free on the way is let be, and the
 * other walked on. The words say where each broke off and how far: what a maintenance run reads.
 */
async function bringIn(ctx: GoalContext, kind: PenKind, p: Pen, way: Way, first: Ent, hold: Hold, o: { home: Pos; enough: () => boolean; pair?: boolean }): Promise<Brought> {
  const lead = 'lead' in hold;
  const food = lead ? undefined : hold.food;
  const bound = fetchBound(ctx.world, kind);
  /** the animals a lead went on (shown by the client or not): however the run ends, each is seen off it */
  const used = new Set<number>();
  /** the client's closer was turned off (put back on however the walk ends), and is off now */
  let gatesOff = false;
  let closerOff = false;
  /** the yard's gate the way in goes through, once the closer is off for it; and whether the pen's was opened */
  let yardGate: Pos | undefined;
  let penOpened = false;
  const gatesAuto = async (on: boolean) => {
    if (closerOff === !on) return;
    closerOff = !on;
    if (!on) gatesOff = true;
    await ctx.call('gates.auto', { enabled: on }).catch(() => undefined);
  };
  /**
   * Shut a gate the walk opened: a careful walk up to it first when it is out of reach (use-item-on-block's own walk
   * there is a plain one, which may place and break blocks by the fence, with the animal on the lead), to 2 from it
   * on the bot's own side (a walk to the gate itself goes through it, and the next leg opens it again), then a click.
   */
  const shut = async (g: Pos) => {
    if (!(await gateOpen(ctx, g).catch(() => false))) return;
    const me = await here(ctx);
    const c = mid(g), d = horiz(me, c);
    // (out of the click's reach, eye to the gate's top face, with a margin: from 4 in on its line the bot clicks)
    if (Math.hypot(d, me.y + 1.62 - (g.y + 1)) > 4.4) {
      const near = { x: Math.floor(c.x + (me.x - c.x) * 2 / d), y: g.y, z: Math.floor(c.z + (me.z - c.z) * 2 / d) };
      await ctx.call('goto', { ...near, range: 1, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
    }
    await toggle(ctx, g).catch(() => undefined);
  };
  await ctx.call('sprint.set', { allowed: false }).catch(() => undefined);
  try {
    const r = await reach(ctx, first.id, o.home, bound, food);
    if (!r.e) return { penned: 0, text: r.why!, last: first.position };
    const out = Math.round(horiz(r.e.position, o.home));
    if (lead) {
      const on = await leashOn(ctx, first.id, o.home, bound, () => { used.add(first.id); });
      if (!on.ok) return { penned: 0, text: `would not take the lead (${on.why})`, last: r.e.position };
    }
    // from here the animal walks with the bot, and only survival may stop the run (the brain reads this): the way
    // from the yard's gate to the pen passes within 10 of home, inside the reach of the home rounds, and a round that
    // cut in there (smelt 66, the kit 70, the stash 60) left the cow loose in the yard and the lead lying by it
    afield.ledBy = ctx.signal;
    const led: Led[] = [{ id: first.id, last: r.e, broke: 0, nth: '' }];
    let second = '';
    // (the first on the bot's lead is someone's to `entities`: not among them)
    const mate = lead && o.pair ? wildAmong(ctx.world, kind, p, o.home, await entities(ctx)).find(e => horiz(e.position, r.e!.position) <= MATE_NEAR) : undefined;
    if (mate) {
      ctx.progress(`a second ${kind} by it, ${Math.round(mate.distance)} off: on the other lead`);
      const m = await toSecond(ctx, mate.id, led[0], o.home, bound, () => { used.add(mate.id); });
      if (m.e) { led[0].nth = 'first '; led.push({ id: mate.id, last: m.e, broke: 0, nth: 'second ' }); }
      else second = `; no second ${kind} on a lead (${m.why})`;
    }
    const said = [`${!lead ? `on the ${food}` : led.length > 1 ? 'on two leads' : 'on the lead'} from ${out} out${second}`];
    const name = (l: Led) => `the ${l.nth}${kind}`;
    const fromGate = async () => Math.round(horiz(await here(ctx), mid(way.outside)));
    const open = await openRound(ctx, p, way.gate.y);
    const route = routeFor(ctx.world, await here(ctx), r.e.position, p, way, lead, open);
    let yardShut = !route.gate;
    /** where one not brought in was last seen (the first such): where to look next time */
    let lostAt: Pos | undefined;
    const drop = (l: Led, at: Pos) => { lostAt ??= at; led.splice(led.indexOf(l), 1); };
    /** let go of them where they are (out of time, stuck): the leads off and picked up */
    const leave = async (why: string): Promise<Brought> => {
      const last = lostAt ?? led[0].last.position;
      if (!lead) return { penned: 0, text: `${said.join('; ')}; ${why}`, last };
      let picked = true;
      for (const l of led) if (!(await letGo(ctx, l.id)).picked) picked = false;
      const them = led.length > 1 ? 'them' : 'it';
      return { penned: 0, text: `${said.join('; ')}; ${why}: let go of ${them} there${picked ? `, the lead${led.length > 1 ? 's' : ''} picked up` : '; the lead not found where it fell'}`, last };
    };
    const ok = standsClear(ctx.world);
    /** on a lead, round to the gate's side and lined up on its line before it opens (penWay, roundToGate) */
    const round = lead && roundable(way, open);
    /**
     * After a walk with them on their leads: each close again (heelLead), one lost or broken free said where (and put
     * on again once, when there is time). `again`: one was put on again, so the next walk goes from where it stands
     * (the yard's gate waits); `none`: none is left on a lead.
     */
    const heelAll = async (): Promise<'on' | 'again' | 'none'> => {
      let again = false;
      for (const l of [...led]) {
        const h = await heelLead(ctx, l.id, ok);
        if (!h.e) {
          const g = await pickUpLead(ctx, l.last.position);
          said.push(`${l.nth ? `${name(l)} ` : ''}lost on the way (last seen ${Math.round(l.last.distance)} off at ${at(l.last.position)})${g ? '; the lead picked up' : ''}`);
          drop(l, l.last.position);
          continue;
        }
        l.last = h.e;
        if (!h.broke) continue;
        l.broke++;
        const where = `the lead broke ${await fromGate()} from the gate (${name(l)} ${Math.round(h.e.distance)} off)`;
        const picked = await pickUpLead(ctx, h.e.position);
        // once more from where it stands, when there is time: a lead caught on a tree breaks once
        if (picked && l.broke === 1 && !o.enough()) {
          const back = await reach(ctx, l.id, o.home, bound);
          if (back.e && (await leashOn(ctx, l.id, o.home, bound)).ok) { l.last = back.e; said.push(`${where}, put on again`); again = true; continue; }
        }
        said.push(`${where}${picked ? '; the lead picked up' : '; the lead not found where it fell'}`);
        drop(l, h.e.position);
      }
      return !led.length ? 'none' : again ? 'again' : 'on';
    };
    /** the fences a led one's pull is stopped by: the yard's gate the walk came through stands open till it is shut */
    const fences = () => fencesOf(ctx.world, route.gate && !yardShut ? [route.gate] : []);
    /**
     * At the cell 2 outside the pen's gate, before it opens: each one still on its lead on the gate's side, within 3
     * of that cell, and no fence on the line from it to there nor on the line from it to the cell 2 in, through the
     * gateway: the line the lead pulls it along when the bot walks in (one to the side of the gate is drawn across the
     * post beside it). Waited for up to 6 s while it still moves; not so, out along the gate's line to 6 out (or as far
     * as the yard and the builds allow) and in again, which brings it round behind the bot, twice at most. Then in with
     * those that came round, the others let go where they stand; none did: why, or `none` when none is left on a lead.
     * `again`: after a let-go that took the bot off the cell 2 out (up to the one let go, onto its lead), back to it,
     * and the rest waited for once more: walked in from where the let-go left it, the one lined up was drawn in at
     * the gate from the side, onto the post.
     */
    const roundToGate = async (again = true): Promise<string | undefined> => {
      const two = mid(outOf(way, 2));
      const through = fencesOf(ctx.world, [way.gate]);
      const ready = (e: Ent) => horiz(e.position, two) <= 3 && depthIn(way, e.position) < -0.5
        && lineClear(e.position, two, fences()) && lineClear(e.position, mid(way.inside), through);
      // (and the gate's line in from there to the cell 2 out clear of builds the look saw: none at all with that cell
      // in a wall, as by the sheep pen's gate, where the cell 6 out is in the cottage)
      const out6 = [6, 5, 4, 3].filter(n => Array.from({ length: n - 1 }, (_, i) => outOf(way, i + 2)).every(open)).map(n => outOf(way, n))
        .find(c => ok(c) && (!ctx.world.yard || inFence(ctx.world, c)));
      let seen: (Ent | undefined)[] = [];
      for (let round = 0; round < 3; round++) {
        for (let w = 0; w < 8; w++) {
          if (ctx.signal.aborted) throw new Error('aborted');
          const before = seen;
          seen = (await ownAll(ctx, led.map(l => l.id))).filter(e => e?.leashed);
          if (seen.every(e => ready(e!))) return undefined;
          // (standing where it stands: no more waiting brings it round)
          if (w > 0 && seen.every(e => { const b = before.find(o => o?.id === e!.id); return !!b && horiz(b.position, e!.position) < 0.2; })) break;
          await pause(750);
        }
        if (round === 2 || !out6) break;
        for (const c of [out6, outOf(way, 2)]) {
          await stepToward(ctx, await here(ctx), c, LEAD_LEG, { ok, exact: true });
          if ((await heelAll()) === 'none') return 'none';
        }
      }
      if (seen.some(e => ready(e!))) {
        // (in with those that came round only: one still out of line is let go where it stands, not pulled across the
        // post beside the gate, nor walked out to through the open gate with the other loose in the pen)
        for (const e of seen.filter(e => !ready(e!))) {
          const l = led.find(x => x.id === e!.id)!;
          const g = await letGo(ctx, l.id);
          said.push(`${name(l)} would not come round to the gate (it stood ${Math.round(horiz(e!.position, two))} off at ${at(e!.position)}): let go of it there${g.picked ? '' : '; the lead not found where it fell'}`);
          drop(l, e!.position);
        }
        if (again && horiz(await here(ctx), two) >= 0.75) {
          await stepToward(ctx, await here(ctx), outOf(way, 2), LEAD_LEG, { ok, exact: true });
          if ((await heelAll()) === 'none') return 'none';
          return roundToGate(false);
        }
        return undefined;
      }
      const off = seen[0];
      return `${led.length > 1 ? 'they' : 'it'} would not come round to the gate${off ? ` (it stood ${Math.round(horiz(off.position, two))} off at ${at(off.position)})` : ''}`;
    };
    const start = await here(ctx);
    const passAt = route.points.findIndex(s => s.pass);
    /** from a stray in the yard to a pen in it: no yard's gate on the way */
    const yardOnly = !route.gate && inFence(ctx.world, r.e.position) && inFence(ctx.world, way.outside);
    for (const [i, w] of route.points.entries()) {
      // from the yard's gate on (the way in through it, or straight to the pen's from out there), nothing shuts a gate
      // behind the bot: the client's closer shuts one as soon as the bot is 2 past it, on the animal's nose. The bot
      // shuts them itself once the animal is through, and the yard's however the walk ends (the closer, off while it
      // opened, never takes it as the bot's afterwards). Once the yard's is shut behind them, and on a walk all in the
      // yard, the closer is on again till the pen's gate: it shuts a door the walk passes, of a build world memory does
      // not know (the cottage's, the windmill's: with the closer off one stood open through the night, out of the dusk
      // sweep's reach, the bed behind it)
      if (!yardOnly && (passAt < 0 || i >= passAt) && !gatesOff) { await gatesAuto(false); yardGate = route.gate; }
      /** the stop before this one: where a led one caught behind a fence corner is stepped back toward */
      const prev = i > 0 ? route.points[i - 1].at : cell(start);
      let snags = 0;
      let held = 0;
      let passes = 0;
      // (the stop out on the yard's gate's line is a help, not the way: one in water or up a bank is not tried for long)
      const legs = Math.ceil(horiz(await here(ctx), mid(w.at)) / (lead ? LEAD_LEG : LEG)) + (w.xz ? 2 : 10);
      for (let leg = 0; leg < legs; leg++) {
        if (ctx.signal.aborted) throw new Error('aborted');
        const me = await here(ctx);
        if (horiz(me, mid(w.at)) < (w.exact || w.pass ? 0.75 : 1.5)) break;
        if (o.enough()) return leave(`the run's time ran out ${await fromGate()} from the gate`);
        if (food) await ctx.call('item.select', { name: food }).catch(() => undefined);
        if (w.pass) {
          // through the yard's gate in one walk, from 2 outside it to 2 in (Baritone opens it): no wait in the
          // gateway, where the wedge watch stops a run, and none by it
          await ctx.call('goto', { ...w.at, range: 0, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
          const now = await here(ctx);
          if (!inFence(ctx.world, now) || !ok(cell(now))) {
            if (++passes >= 2) return leave(`could not get through the yard's gate at ${at(route.gate!)}`);
            continue;
          }
        } else await stepToward(ctx, me, w.at, lead ? LEAD_LEG : LEG, { ok, ...(w.xz ? { xz: true } : {}), ...(w.exact ? { exact: true } : {}) });
        if (lead) {
          // (how far from the stop the leg got the bot, before the waits for them)
          const went = horiz(await here(ctx), mid(w.at));
          const h = await heelAll();
          if (h === 'none') return { penned: 0, text: said.join('; '), last: lostAt };
          if (h === 'again') continue;
          // a lead pulls in a straight line, and a fence stops it: one caught behind a fence corner (the pen's) is
          // stepped back toward, the way the bot came, until it is round; twice a stop at most, and still caught
          // then, let go there: more legs to the stop never brought it round, each with its wait for it, and a lure
          // with no time limit of its own ran on into the pens round's 8 minutes. Not back out through the yard's
          // gate (from in the yard a walk out goes by its gate's cells: outByGate)
          const now = await here(ctx);
          // (on the way round to the gate's side only: on the walk straight to the cell outside the gate, as before, the
          // game's own close-in brings one round a corner; there the rule let go of every sheep led round the sheep
          // pen's corner)
          const caught = round && inFence(ctx.world, prev) === inFence(ctx.world, now) ? led.find(l => !lineClear(l.last.position, now, fences())) : undefined;
          if (caught && snags >= 2) return leave(`${name(caught)} was caught on the fence at ${at(caught.last.position)}`);
          if (caught) {
            snags++;
            await stepToward(ctx, now, prev, LEAD_LEG, { ok });
            const back = await heelAll();
            if (back === 'none') return { penned: 0, text: said.join('; '), last: lostAt };
            continue;
          }
          // held by what no fence world memory knows holds it by (a build, a post, a bank): the leg got the bot on,
          // and the waits for it took the bot back (heelLead's steps back toward it). Three such legs at a stop: let go
          // there. Each stop had its legs (ceil(d / 4) + 10), each with up to 18 s of waits: 100 led walks and 5
          // minutes for one fetch, and a lure's three tries ran past the pens round's 8 minutes. (A leg that got the
          // bot nowhere is the stop's own doing, a cell in water: its legs run out, as before)
          const was = horiz(me, mid(w.at));
          if (went < was - 1 && horiz(now, mid(w.at)) > was - 1 && ++held >= 3) {
            const l = [...led].sort((a, b) => b.last.distance - a.last.distance)[0];
            return leave(`${name(l)} would not follow (it stood ${Math.round(l.last.distance)} off at ${at(l.last.position)})`);
          }
        } else {
          const e = await keepClose(ctx, led[0].id, food!);
          if (!e || e.distance > 10) {
            return { penned: 0, text: `${said.join('; ')}; it stopped following ${await fromGate()} from the gate${e ? ` (the ${kind} ${Math.round(e.distance)} off)` : ''}`, last: (e ?? led[0].last).position };
          }
          led[0].last = e;
        }
        // through the yard's gate, and the animals too: shut it behind them
        if (!yardShut && route.gate && inFence(ctx.world, await here(ctx)) && led.every(l => inFence(ctx.world, l.last.position))) {
          yardShut = true;
          await shut(route.gate);
          await gatesAuto(true);
        }
      }
    }
    // (legs that got nowhere: walking on into the pen in one go would leave it behind)
    const short = await fromGate();
    if (short > 3) return leave(`got no nearer than ${short} to the gate`);
    if (round) {
      const come = await roundToGate();
      if (come === 'none') return { penned: 0, text: said.join('; '), last: lostAt };
      if (come) return leave(come);
    }
    await gatesAuto(false);
    // in at the gate and across the pen, the animals after the bot
    penOpened = true;
    if (!(await gateOpen(ctx, way.gate))) await toggle(ctx, way.gate);
    if (food) await ctx.call('item.select', { name: food });
    for (const c of [way.inside, way.deep]) {
      await ctx.call('goto', { ...c, range: 0, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
      // on a lead, each let come through the gateway behind the bot from the cell 2 in before it walks on: from the
      // far row the lead pulled one that lagged across the gate's post. One round of looks: in the pen there is no
      // cell to step back to, and the gate stands open behind the bot with the herd inside
      if (lead && c === way.inside) for (const l of led) await heelLead(ctx, l.id, ok, 1);
    }
    const ids = led.map(l => l.id);
    let seen: (Ent | undefined)[] = [];
    for (let w = 0; w < 10; w++) {
      seen = lead ? await ownAll(ctx, ids) : [await find(ctx, ids[0])];
      if (seen.every(e => !e || wellIn(p, way, e.position))) break;
      await pause(750);
    }
    let tail = '';
    if (lead) {
      for (const id of ids) if (!(await letGo(ctx, id)).picked) tail = '; the lead not found where it fell';
    } else {
      // food away (a sword in hand), or it follows the bot straight back out
      const weapon = ctx.s.items.find(i => /_sword$/.test(i.name))?.name;
      if (weapon) await ctx.call('item.select', { name: weapon });
      await pause(1500);
    }
    await ctx.call('goto', { ...way.outside, range: 0, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
    if (await gateOpen(ctx, way.gate)) await toggle(ctx, way.gate);
    const all = await entities(ctx);
    const ends = ids.map(id => all.find(e => e.id === id));
    const isIn = (k: number) => !!ends[k] && within(p, ends[k]!.position);
    const fate = (k: number) => {
      if (isIn(k)) return 'led in';
      const e = seen[k];
      if (e && wellIn(p, way, e.position)) return 'in the pen, but out again as the bot left';
      return `at the gate it would not come in${e ? ` (it stood ${Math.round(e.distance)} off at ${at(e.position)})` : ''}`;
    };
    const penned = ids.filter((_, k) => isIn(k)).length;
    said.push(led.length === 1 ? fate(0) : penned === led.length ? 'both led in' : led.map((l, k) => `${name(l)}: ${fate(k)}`).join('; '));
    const out1 = ids.findIndex((_, k) => !isIn(k));
    const last = lostAt ?? (out1 < 0 ? undefined : (ends[out1] ?? seen[out1] ?? led[out1].last).position);
    return { penned, text: `${said.join('; ')}${tail}`, ...(last ? { last } : {}) };
  } finally {
    // still on a lead (cut short by survival, the LLM or the timeout; or a lead the client was slow to show): off it
    // comes, or the bot drags it into whatever it does next. A run given up walks nowhere (offLead); one still going
    // walks up to each and picks the lead up, and only survival cuts it till then
    if (used.size) {
      if (ctx.signal.aborted) await tidyUp(() => offLead(ctx, [...used]));
      else for (const id of used) if ((await own(ctx, id).catch(() => undefined))?.leashed) await letGo(ctx, id).catch(() => undefined);
    }
    // the gates the walk opened and left open (it ended short of the pen, or was cut short): the client's closer was
    // off while they opened and never takes them as the bot's afterwards, so they stood open until the shelter's dusk
    // sweep. A run given up only clicks one within reach (the bridge's own click: it walks nowhere)
    for (const g of [yardGate, penOpened ? way.gate : undefined]) {
      if (!g) continue;
      if (ctx.signal.aborted) await tidyUp(async () => { if (await gateOpen(ctx, g)) await ctx.call('useOn', { ...g, face: 'up', toggle: true }); });
      else await shut(g);
    }
    await tidyUp(() => ctx.call('sprint.set', { allowed: true }));
    if (gatesOff) await tidyUp(() => ctx.call('gates.auto', { enabled: true }));
    // only now may a chore cut the run again: the walk back to shut a gate is the walk's too (with it cleared first, a
    // round that cut in there left the yard's gate open until the dusk sweep)
    if (afield.ledBy === ctx.signal) afield.ledBy = undefined;
  }
}

/**
 * Wild adults of a pen's kind among `look` (not someone's), outside its pen and within the fetch's bound of home (the
 * leash, the cows' range): the nearest first.
 */
const wildAmong = (world: WorldMemory, kind: PenKind, p: Pen, home: Pos, look: Ent[]): Ent[] =>
  look.filter(e => e.name.replace(/^minecraft:/, '') === kind && !e.baby && !inPen(p, e.position) && horiz(e.position, home) <= fetchBound(world, kind).blocks)
    .sort((a, b) => a.distance - b.distance);

/** The same, of what is in sight now. */
async function wildOnes(ctx: GoalContext, kind: PenKind, p: Pen, home: Pos, range = 48): Promise<Ent[]> {
  return wildAmong(ctx.world, kind, p, home, await entities(ctx, range));
}

/** The wild ones a look saw, written down where they stood (the nearest kept first, four a kind): the cows rung's `in sight`. */
function sighted(world: WorldMemory, kind: PenKind, seen: Ent[]): void {
  for (const e of seen.slice(0, 4).reverse()) addSite(world, kind, cell(e.position));
}

/**
 * In the pen to feed, cull or shear, and out again, the gate shut behind the bot both ways: a careful walk to the cell
 * outside the gate, a sword in hand (the herd follows wheat out of an open gate), the gate opened, in to 2 inside, the
 * gate shut; out the same way, the wheat put away first. The client's closer is off meanwhile: the bot opens and
 * shuts the gate itself, as the walk in with a stray does. Before, each feed and each cull went in on Baritone's own
 * way (a plain walk in the yard, which may place and break blocks by the fence, through the gate it opened and left
 * to the closer), and the bot left with the wheat in hand. `enter` says whether the bot got in: a walk to the gate
 * that ended out of reach of it goes no further (the click would walk there on Baritone's own way).
 */
function penVisit(ctx: GoalContext, p: Pen, way: Way) {
  let inside = false;
  let gatesOff = false;
  const sword = async () => {
    const weapon = ctx.s.items.find(i => /_sword$/.test(i.name))?.name;
    if (weapon) await ctx.call('item.select', { name: weapon }).catch(() => undefined);
  };
  const shutGate = async () => { if (await gateOpen(ctx, way.gate).catch(() => false)) await toggle(ctx, way.gate).catch(() => undefined); };
  return {
    enter: async (): Promise<boolean> => {
      if (inside) return true;
      await ctx.call('goto', { ...way.outside, range: 1, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);
      if (horiz(await here(ctx), mid(way.gate)) > 4) return false;
      await sword();
      gatesOff = true;
      await ctx.call('gates.auto', { enabled: false }).catch(() => undefined);
      if (!(await gateOpen(ctx, way.gate))) await toggle(ctx, way.gate);
      await ctx.call('goto', { ...way.inside, range: 0, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
      inside = within(p, await here(ctx));
      await shutGate();
      return inside;
    },
    /**
     * Out, the gate shut behind: back to the cell inside the gate first (a cull or a feed in the far corner leaves the
     * gate out of the click's reach, and the click would walk there on Baritone's own way). A round given up walks
     * nowhere. However it ends (given up on the way out, a call that failed), the gate is clicked shut from where the
     * bot stands, the wheat put away, and the client's closer is on again: the closer never takes a gate that opened
     * while it was off, and with it left off every gate and door Baritone opened after stood open until the next round.
     */
    leave: async (): Promise<void> => {
      try {
        if (inside && !ctx.signal.aborted) {
          await sword();
          await ctx.call('goto', { ...way.inside, range: 0, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
          if (!(await gateOpen(ctx, way.gate).catch(() => true))) await toggle(ctx, way.gate).catch(() => undefined);
          await ctx.call('goto', { ...way.outside, range: 0, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
          await shutGate();
        }
      } finally {
        inside = false;
        if (gatesOff) {
          await tidyUp(async () => {
            await sword();
            if (await gateOpen(ctx, way.gate)) await ctx.call('useOn', { ...way.gate, face: 'up', toggle: true });
          });
          gatesOff = false;
          await tidyUp(() => ctx.call('gates.auto', { enabled: true }));
        }
      }
    }
  };
}

/**
 * Run now? The "no" is said in this order: no pen to see to (none built, or the round is not due); then what keeps a
 * round that is due from going (not in the yard, no room for what the animals drop); the hour last.
 */
const gate = (s: Snapshot, world: WorldMemory): Gate => {
  if (!Object.keys(world.zones ?? {}).some(k => /^pen:[a-z]+$/.test(k))) return { cause: 'unneeded', text: 'no pen' };
  const last = world.lastDone?.pens ?? 0;
  if (!(s.now - last > 6 * MINUTE)) return no.notDue('pens', s.now, last, 6 * MINUTE);
  if (!nearHome(s, 24)) return no.away(s, 'pens', 24);
  // two slots free for what the animals drop, or the stash able to make them (the round does that first)
  if (room('yard', s, world) === 'no') return noRoom('yard', 'pens', s, world);
  return no.late(s, 'pens') ?? { want: 'the pens: lure, breed, cull, shear' };
};

/**
 * Every few minutes by day: up to three things at each pen (lead in, cull, shear, breed). Each look writes down what
 * the pen holds and the wild ones round it within the fetch's bound (work.pen, work.sites): the cows rung goes by
 * them. The herd is bred to MAX_HERD, calves counted, and the adults above MAX_ADULTS culled: from the bot's own
 * pen only (the count is of the adults inside its fence), never a calf, never someone's (named, tamed or on a lead,
 * or by their builds outside the yard), never below the pair. Feeding, culling and shearing are done from inside the
 * pen, the gate shut behind the bot (penVisit), every walk in there to the pen's inside cells (standIn); the cull's
 * drops are picked up from those cells (dropsIn), and what fell past the fence is left.
 */
export const pens: Goal = {
  name: 'pens',
  priority: 46,
  timeoutMs: 8 * MINUTE,
  retryMs: 10 * MINUTE,
  gate,
  ...fromGate(gate),
  // a round that only looks (nothing to lure, breed or cull) is busy time to no gain
  gains: true,
  run: async run => {
    // room for what the animals drop first (home to the chests where the pockets are too full), before the round is
    // written down. The round then counts from the pockets as they are after that: the stash may just have put the
    // wheat away, and with the old count the pen's food would not be taken out again
    const ctx: GoalContext = { ...run, s: await makeRoom(run, 'yard') };
    (ctx.world.lastDone ??= {}).pens = ctx.s.now;
    const home = ctx.s.home ?? ctx.s.position;
    const out: string[] = [];
    for (const key of Object.keys(ctx.world.zones ?? {})) {
      const m = /^pen:([a-z]+)$/.exec(key);
      if (!m) continue;
      const kind = m[1] as PenKind;
      const where = penOf(ctx.world, kind);
      if (!where) continue;
      const { p, way } = where;
      // food for it from the chests (wheat from the farm), and shears for the sheep
      const food = PEN_FOOD[kind];
      if (!food.some(f => (ctx.s.counts.get(f) ?? 0) >= 2)) for (const f of food) if (await takeFromChests(ctx, f, 16)) break;
      if (kind === 'sheep' && !ctx.s.counts.get('shears')) await prepareBill(ctx, { shears: 1 }).catch(() => undefined);
      const visit = way ? penVisit(ctx, p, way) : undefined;
      // (every walk in the pen goes to its inside cells, at the gate's height)
      const inside: Inside | undefined = way ? { p, y: way.gate.y } : undefined;
      try {
        for (let i = 0; i < 3 && !ctx.signal.aborted; i++) {
          const inv = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
          const counts = new Map<string, number>();
          for (const it of inv.items) if (it.slot < 36) counts.set(it.name, (counts.get(it.name) ?? 0) + it.count);
          const look = await entities(ctx);
          const st = penState(p, look);
          notePen(ctx.world, kind, { adults: st.inside.adults, babies: st.inside.babies, at: ctx.s.now });
          sighted(ctx.world, kind, wildAmong(ctx.world, kind, p, home, look));
          const a = nextAnimalAction(p, look, counts, {
            minAdults: 2, maxAdults: MAX_ADULTS, maxHerd: MAX_HERD, breedCooldownOk: id => Date.now() - (fedAt.get(id) ?? 0) > 5.5 * MINUTE
          });
          if (a.kind === 'wait') { out.push(`${kind}: ${a.why}`); break; }
          if (a.kind === 'lure') {
            // (out of the pen first: the walk in with it goes by the gate itself)
            await visit?.leave();
            const target = look.find(e => e.id === a.target)!;
            // (on a lead first, as the fetch does; the wheat when no lead can be had)
            const h: { hold?: Hold; why: string } = way ? await holdFor(ctx, kind) : { why: 'no gate on the pen' };
            const r = way && h.hold ? await bringIn(ctx, kind, p, way, target, h.hold, { home, enough: () => false }) : { penned: 0, text: h.why };
            out.push(`${kind}: ${h.hold && 'food' in h.hold ? `${h.why}: ` : ''}${r.text}`);
            if (r.penned) ctx.gain(r.penned);
          } else if (visit && !(await visit.enter())) {
            out.push(`${kind}: could not get into the pen by its gate (${way!.gate.x}, ${way!.gate.y}, ${way!.gate.z})`);
            break;
          } else if (a.kind === 'breed') {
            let fed = 0;
            for (const id of a.ids) if (await useOn(ctx, id, a.food, inside)) { fed++; fedAt.set(id, Date.now()); ctx.gain(1); }
            out.push(`${kind}: fed ${fed} to breed`);
          } else if (a.kind === 'cull') {
            const r = inside ? await cullIn(ctx, inside, a.id)
              : { ...await ctx.act('attack-entity', { target: `#${a.id}`, maxDistance: 24, timeoutMs: 30_000 }), left: 0 };
            if (r.ok) ctx.gain(1);
            out.push(`${kind}: culled one (${r.text.split('\n')[0].slice(0, 60)})${r.left ? `, ${r.left} drop(s) left by the fence` : ''}`);
          } else {
            out.push(`${kind}: ${(await useOn(ctx, a.id, 'shears', inside)) ? 'sheared one' : 'could not shear'}`);
          }
          ctx.progress(out.at(-1)!);
        }
      } finally {
        // (out of the pen with the gate shut behind, however the round ended)
        await visit?.leave();
      }
    }
    // empty pens and no animal near to lure: nothing changes in six minutes, and each look stopped whatever ran
    // (a wood trip for the homestead, twice): look again in half an hour
    if (out.length && out.every(o => /: 0 \w+ in the pen and none within \d+ to lure/.test(o))) ctx.world.lastDone.pens = ctx.s.now + 24 * MINUTE;
    return out.join('; ') || 'nothing to do at the pens';
  }
};

// ------------------------------------------------------------------------------------------------ the fetch

/** The variant of the cows rung that goes where a wild one was last seen. */
export const IN_SIGHT = 'in sight';
/** A pen with this many adults breeds the rest itself. */
const PAIR = 2;
/** Within this of the pen's middle the bot sees the whole pen (its look is 48 round it). */
const PEN_SIGHT = 40;
/** A walk to where one was seen that ended within this of it looked there (the look is 48 round the bot). */
const SITE_NEAR = 16;

/**
 * What a fetch came to: an animal penned is its gain; `untried`: it never got to look (no pen to bring one to);
 * `mark`: what it learnt of the place it looked, for the wrapper's dry mark (work.ts WorkResult).
 */
export interface Fetched { gain: number; text: string; untried?: true; mark?: WorkResult['mark'] }

/**
 * Where a wild one was seen (work.sites, the pens round's looks and the fetches'): one in sight from here first, then
 * the nearest place it was seen and the next (within the fetch's bound), walked to and looked round. A place with
 * none any more is forgotten; one the walk ended well short of is kept, and said (a cow seen 250 out across rough
 * ground was out of the look's 48 from where a 90 s walk stopped, and forgotten as gone). `short`: the run's time ran
 * out before a place was looked at; `untried`: no gate let it out of the yard to one.
 */
async function toSighting(ctx: GoalContext, kind: PenKind, p: Pen, home: Pos, enough: () => boolean): Promise<{ found?: Ent; text: string; short?: true; untried?: true }> {
  const bound = fetchBound(ctx.world, kind);
  const first = (await wildOnes(ctx, kind, p, home))[0];
  if (first) return { found: first, text: '' };
  const seen = sitesOf(ctx.world, kind).filter(q => horiz(q, home) <= bound.blocks).sort((a, b) => horiz(a, home) - horiz(b, home)).slice(0, 2);
  const gone: string[] = [];
  const unreached: string[] = [];
  for (const q of seen) {
    if (ctx.signal.aborted) throw new Error('aborted');
    if (enough()) {
      if (!gone.length && !unreached.length) return { text: `the run's time ran out before the bot got to where a ${kind} was seen`, short: true };
      break;
    }
    ctx.progress(`to where a ${kind} was seen, (${q.x}, ${q.y}, ${q.z}), ${Math.round(horiz(q, home))} blocks from home`);
    // out of the yard by a gate to one seen outside it, the gate that makes the shortest way. On from it, and in and
    // by the yard, to the place at its own height, as walkTo goes to an animal: from another side's gate a walk to
    // "any height at its x and z" goes round the fence or back across the yard, where a cave under it answers too
    const gate = await outByGate(ctx, q);
    if (gate.shut) return { text: `no wild ${kind} looked for where one was seen: ${gate.shut}`, untried: true };
    const inside = inFence(ctx.world, q);
    // (careful in and by the yard, as every walk of the fetch: a cow loose in the yard is the bot's, and seen there)
    const from = gate.at ?? await here(ctx);
    const careful = byYard(ctx.world, from, q);
    // (the time the walk's length needs, at 2 a second: a place 250 out, or the next one from the first, is past 90 s)
    const ms = Math.max(90_000, Math.round(horiz(from, q) / 2 * 1000));
    await ctx.call('goto', { x: q.x, y: q.y, z: q.z, ...(inside || careful ? {} : { xz: true }), range: 8, ...(careful ? { careful: true } : {}), timeoutMs: ms }, ms + 15_000).catch(() => undefined);
    if (ctx.signal.aborted) throw new Error('aborted');
    const ones = await wildOnes(ctx, kind, p, home);
    sighted(ctx.world, kind, ones);
    if (ones[0]) return { found: ones[0], text: '' };
    const off = Math.round(horiz(await here(ctx), q));
    if (off > SITE_NEAR) { unreached.push(`got no nearer than ${off} to where a ${kind} was seen at (${q.x}, ${q.y}, ${q.z})`); continue; }
    dropSite(ctx.world, kind, q);
    gone.push(`(${q.x}, ${q.y}, ${q.z})`);
  }
  const said = [...(gone.length ? [`no wild ${kind} where one was seen at ${gone.join(', ')}: forgotten`] : []), ...unreached];
  return { text: said.length ? said.join('; ') : `no wild ${kind} seen within ${bound.name} any more` };
}

/**
 * The work queue's cows rung (worktasks.ts): wild animals fetched for a pen short of a pair, from where one was last
 * seen (`in sight`) or one side of home a run (north, east, south, west), out to the fetch's bound and no further
 * (the cows' range, 256: past the leash, the user's word; the sheep the leash), and walked in on a lead (bringIn).
 * With two leads carried and a second wild one within 8 of the first, both come in on the one walk: the pair the pen
 * breeds from. The cow pen on the friend's server never held a cow: every fetch on the wheat "did not come in" (10 of
 * 12), and on the lead every side came back with none within the leash. Gain: the animals penned. What the pen holds
 * is written down as it is seen (work.pen), and where a wild one stood (work.sites).
 */
export async function fetchForPens(ctx: GoalContext, from: string, opts: { kind?: PenKind; enough?: () => boolean; now?: () => number } = {}): Promise<Fetched> {
  const kind = opts.kind ?? 'cow';
  const enough = opts.enough ?? (() => false);
  const now = opts.now ?? (() => ctx.s.now);
  const where = penAt(ctx.world, kind);
  if (!where) return { gain: 0, text: `no ${kind} pen with a gate`, untried: true };
  const { p, way } = where;
  const home = ctx.s.home ?? ctx.s.position;
  const centre = { x: (p.x1 + p.x2 + 1) / 2, z: (p.z1 + p.z2 + 1) / 2 };
  const lookAtPen = async (): Promise<number | undefined> => {
    if (horiz(await here(ctx), centre) > PEN_SIGHT) return undefined;
    const st = penState(p, await entities(ctx));
    notePen(ctx.world, kind, { adults: st.inside.adults, babies: st.inside.babies, at: now() });
    return st.inside.adults;
  };
  // the pen as it stands, from the yard the run sets out from (the count it went by may be half an hour old)
  // (nothing learnt of the side then: its count stays)
  const adults = await lookAtPen();
  if (adults !== undefined && adults >= PAIR) return { gain: 0, text: `the ${kind} pen has ${adults} already: none fetched`, mark: 'same' };
  const h = await holdFor(ctx, kind);
  if (!h.hold) return { gain: 0, text: `${kind}: ${h.why}` };
  const bound = fetchBound(ctx.world, kind);
  const found: { found?: Ent; text: string; short?: true; untried?: true } = from === IN_SIGHT ? await toSighting(ctx, kind, p, home, enough)
    : await alongSide(ctx, from as HomeSide, `wild ${kind}s`, async () => {
      const ones = await wildOnes(ctx, kind, p, home);
      sighted(ctx.world, kind, ones);
      return ones[0];
    }, enough, bound);
  if (!found.found) return { gain: 0, text: found.text, ...(found.short ? { mark: 'same' as const } : {}), ...(found.untried ? { untried: true as const } : {}) };
  const target = found.found;
  // two leads carried: a second grazing by it comes in on the same walk
  const pair = 'lead' in h.hold && (await carried(ctx, 'lead')) >= LEADS;
  const seenAt = cell(target.position);
  addSite(ctx.world, kind, seenAt);
  ctx.progress(`fetching a ${kind} for the pen: ${Math.round(target.distance)} blocks off, ${Math.round(horiz(target.position, home))} from home`);
  const r = await bringIn(ctx, kind, p, way, target, h.hold, { home, enough, pair });
  // in: it was seen there no longer. Not in: where it was last seen is where to look next time
  dropSite(ctx.world, kind, seenAt);
  if (r.last && horiz(r.last, home) <= bound.blocks && !inPen(p, r.last)) addSite(ctx.world, kind, cell(r.last));
  await lookAtPen();
  // one found and not brought in: there are cows that way, and the side (or `in sight`) is tried again after a first
  // mark's wait, not an ever longer one (four lost on the lead would have kept the side where they graze for days)
  return { gain: r.penned, text: `${kind}: ${'food' in h.hold ? `${h.why}: ` : ''}${r.text}`, ...(r.penned ? {} : { mark: 'first' as const }) };
}
