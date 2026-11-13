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
import { addSite, alongSide, byYard, dropSite, gatesBetween, inFence, notePen, outByGate, sitesOf, type Bound, type HomeSide, type WorkResult } from './work.js';

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
 * Walk up to an animal and use `item` on it; true when the client says it was used. `inside`: the bot is in the pen
 * with it, the gate shut behind (penVisit), and walks up carefully; else Baritone's own way, as before (a pen with no
 * gate known).
 */
async function useOn(ctx: GoalContext, id: number, item: string, inside = false): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const e = await find(ctx, id);
    if (!e) return false;
    if (e.distance > 3.5) {
      if (inside) await ctx.call('goto', { ...cell(e.position), range: 2, careful: true, timeoutMs: 15_000 }, 25_000).catch(() => undefined);
      else await ctx.act('move-to-position', { ...e.position, range: 2, timeoutMs: 45_000 });
    }
    try { await ctx.call('entity.use', { id, item }); return true; } catch { /* it moved: again */ }
  }
  return false;
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
 * Leads to walk the animal home by: two kept on hand, carried, else from the chests, else made from 4 string and a
 * slime ball (two leads), the way the kit and the shears are made (project.ts prepareBill); one carried will do when
 * no second is to be had. With none, its food in hand, as before: `why` says so. Neither: no hold, and why.
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

/**
 * The way to the pen's gate from out there: through the yard's gate that makes the shortest way round (its cell 2
 * outside, then 2 inside: work.ts gatesBetween, which the walks out of the yard go by too), then to the pen's. A leg
 * aimed at the pen through the fence had Baritone walk the fence round to a gate in one go, out of the animal's
 * reach. From inside the yard, or with no gate known, straight there.
 */
function routeFor(world: WorldMemory, from: Pos, way: Way): { points: Pos[]; gate?: Pos } {
  if (!world.yard || inFence(world, from) || !inFence(world, way.outside)) return { points: [way.outside] };
  const best = gatesBetween(world, mid(way.outside), from)[0];
  return best ? { points: [best.outer, best.inner, way.outside], gate: best.gate } : { points: [way.outside] };
}

/** One leg toward `w`: `leg` blocks at most, careful (walk only: Baritone's tool pick took the wheat out of hand mid-leg); the last one to the cell itself. */
async function stepToward(ctx: GoalContext, me: Pos, w: Pos, leg: number): Promise<void> {
  const d = horiz(me, mid(w));
  const t = Math.min(1, leg / d);
  const to = t >= 1 ? { x: w.x, y: w.y, z: w.z, range: 1 }
    // (any height: the ground between here and there is not known)
    : { x: Math.floor(me.x + (mid(w).x - me.x) * t), y: w.y, z: Math.floor(me.z + (mid(w).z - me.z) * t), xz: true, range: 1 };
  await ctx.call('goto', { ...to, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
}

/**
 * After a leg on the lead: the animal close again (within 4, up to 6 s), and when it lags, a step back toward it to
 * give it slack, twice at most. Off the lead (`broke`), gone from sight, or as last seen.
 */
async function heelLead(ctx: GoalContext, id: number): Promise<{ e?: Ent; broke?: true }> {
  let e: Ent | undefined;
  for (let tries = 0; tries < 3; tries++) {
    for (let w = 0; w < 8; w++) {
      e = await own(ctx, id);
      if (!e) return {};
      if (!e.leashed) return { e, broke: true };
      if (e.distance <= HEEL) return { e };
      await pause(750);
    }
    if (tries === 2) return { e };
    const me = await here(ctx);
    await ctx.call('goto', { x: Math.floor((me.x + e!.position.x) / 2), y: Math.floor(e!.position.y), z: Math.floor((me.z + e!.position.z) / 2), xz: true, range: 1, careful: true, timeoutMs: 15_000 }, 25_000)
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
    await stepToward(ctx, await here(ctx), cell(e.position), LEAD_LEG);
    const h = await heelLead(ctx, first.id);
    if (!h.e || h.broke) return { why: 'the first came off its lead on the way to it' };
    first.last = h.e;
  }
  return { why: 'the bot could get no nearer to it' };
}

/**
 * Walk animals into their pen: up to the first, a lead on it (or its food in hand), and with `pair` (a second lead
 * carried) and another wild one within 8 of it, as a look from beside it shows, up to that one and the other lead on
 * it (two at once: the pair the pen breeds from in one walk; a look from 48 off, where the first was seen, misses one
 * grazing behind it). Home in short legs through the yard's gate (shut behind them once they are through), in at the
 * pen's gate, and right across the pen: a tempted animal stops 2.5 blocks from the bot (TemptGoal) and a led one 2
 * (PathfinderMob), and with the bot only 2 in, both stopped in the gateway. Off the lead there (picked up), or the
 * food put away, out, the gate shut. One of two lost or broken free on the way is let be, and the other walked on.
 * The words say where each broke off and how far: what a maintenance run reads.
 */
async function bringIn(ctx: GoalContext, kind: PenKind, p: Pen, way: Way, first: Ent, hold: Hold, o: { home: Pos; enough: () => boolean; pair?: boolean }): Promise<Brought> {
  const lead = 'lead' in hold;
  const food = lead ? undefined : hold.food;
  const bound = fetchBound(ctx.world, kind);
  /** the animals a lead went on (shown by the client or not): however the run ends, each is seen off it */
  const used = new Set<number>();
  let gatesOff = false;
  /** the yard's gate the way in goes through, once the closer is off for it; and whether the pen's was opened */
  let yardGate: Pos | undefined;
  let penOpened = false;
  const gatesAuto = async (on: boolean) => { if (!on) gatesOff = true; await ctx.call('gates.auto', { enabled: on }).catch(() => undefined); };
  /**
   * Shut a gate the walk opened: a careful walk up to it first when it is out of reach (use-item-on-block's own walk
   * there is a plain one, which may place and break blocks by the fence, with the animal on the lead), to 2 from it
   * on the bot's own side (a walk to the gate itself goes through it, and the next leg opens it again), then a click.
   */
  const shut = async (g: Pos) => {
    if (!(await gateOpen(ctx, g).catch(() => false))) return;
    const me = await here(ctx);
    const c = mid(g), d = horiz(me, c);
    if (d > 4) {
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
    const route = routeFor(ctx.world, r.e.position, way);
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
    for (const [i, w] of route.points.entries()) {
      // from the yard's gate on (the way in through it, or straight to the pen's), nothing shuts a gate behind the
      // bot: the client's closer shuts one as soon as the bot is 2 past it, on the animal's nose. The bot shuts them
      // itself once the animal is through, and the yard's however the walk ends (the closer, off while it opened,
      // never takes it as the bot's afterwards)
      if ((i > 0 || route.points.length === 1) && !gatesOff) { await gatesAuto(false); yardGate = route.gate; }
      const legs = Math.ceil(horiz(await here(ctx), mid(w)) / (lead ? LEAD_LEG : LEG)) + 10;
      for (let leg = 0; leg < legs; leg++) {
        if (ctx.signal.aborted) throw new Error('aborted');
        const me = await here(ctx);
        if (horiz(me, mid(w)) < 1.5) break;
        if (o.enough()) return leave(`the run's time ran out ${await fromGate()} from the gate`);
        if (food) await ctx.call('item.select', { name: food }).catch(() => undefined);
        await stepToward(ctx, me, w, lead ? LEAD_LEG : LEG);
        if (lead) {
          /** one put on again this leg: on with the next leg first, as it stands (the yard's gate waits) */
          let again = false;
          for (const l of [...led]) {
            const h = await heelLead(ctx, l.id);
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
          if (!led.length) return { penned: 0, text: said.join('; '), last: lostAt };
          if (again) continue;
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
        }
      }
    }
    // (legs that got nowhere: walking on into the pen in one go would leave it behind)
    const short = await fromGate();
    if (short > 3) return leave(`got no nearer than ${short} to the gate`);
    if (!gatesOff) await gatesAuto(false);
    // in at the gate and across the pen, the animals after the bot
    penOpened = true;
    if (!(await gateOpen(ctx, way.gate))) await toggle(ctx, way.gate);
    if (food) await ctx.call('item.select', { name: food });
    for (const c of [way.inside, way.deep]) await ctx.call('goto', { ...c, range: 0, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
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
 * pen, the gate shut behind the bot (penVisit); the cull's drops are picked up there (attack-entity).
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
            for (const id of a.ids) if (await useOn(ctx, id, a.food, !!visit)) { fed++; fedAt.set(id, Date.now()); ctx.gain(1); }
            out.push(`${kind}: fed ${fed} to breed`);
          } else if (a.kind === 'cull') {
            const r = await ctx.act('attack-entity', { target: `#${a.id}`, maxDistance: 24, timeoutMs: 30_000 });
            if (r.ok) ctx.gain(1);
            out.push(`${kind}: culled one (${r.text.split('\n')[0].slice(0, 60)})`);
          } else {
            out.push(`${kind}: ${(await useOn(ctx, a.id, 'shears', !!visit)) ? 'sheared one' : 'could not shear'}`);
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
