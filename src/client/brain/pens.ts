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
import { addSite, alongSide, byYard, dropSite, gatesBetween, inFence, notePen, outByGate, sitesOf, type HomeSide, type WorkResult } from './work.js';

/**
 * Animal pens: a 7 x 7 fenced pen per kind (cows, then sheep) with a gate toward home, and a chore that keeps each
 * stocked: strays walked in on a lead (food in hand when no lead can be had; walking, not sprinting: an animal can't
 * keep up with a sprinting player), the herd bred up to 6, the surplus culled for food and leather, the sheep sheared.
 * Further out than the chore looks, the work queue's `cows` rung fetches one (fetchForPens).
 */

const MINUTE = 60_000;
const SIZE = 7;
const MAX_ADULTS = 6;
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
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const OUT: Record<Side, { x: number; z: number }> = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 }, east: { x: 1, z: 0 } };
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
/** a block cell's middle, for how far the bot (whose position is fractional) is from it */
const mid = (c: { x: number; z: number }) => ({ x: c.x + 0.5, z: c.z + 0.5 });
const cell = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const at = (p: Pos) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;

/** Walk up to an animal and use `item` on it; true when the client says it was used. */
async function useOn(ctx: GoalContext, id: number, item: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const e = await find(ctx, id);
    if (!e) return false;
    if (e.distance > 3.5) await ctx.act('move-to-position', { ...e.position, range: 2, timeoutMs: 45_000 });
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

type Hold = { lead: true } | { food: string };

/**
 * A lead to walk the animal home by: carried, else from the chests, else made from 4 string and a slime ball (two
 * leads), the way the kit and the shears are made (project.ts prepareBill). With none to be had, its food in hand,
 * as before: `why` says so. Neither: no hold, and why.
 */
async function holdFor(ctx: GoalContext, kind: PenKind): Promise<{ hold?: Hold; why: string }> {
  if ((await carried(ctx, 'lead')) > 0) return { hold: { lead: true }, why: '' };
  const short = await prepareBill(ctx, { lead: 1 }, { record: false }).catch(() => ({ lead: 1 }));
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

/** said of an animal that has grazed on past the leash: the bot does not follow it there */
const PAST_LEASH = 'it wandered past the leash';

/**
 * Up to the animal: where it stood when seen (77 blocks off, once) is not where it grazes by the time the bot gets
 * there ("it stopped following" at the first leg), so close in on where it is now, three times at most, and never
 * past the leash (a cow seen 95 out grazes on). The animal as last seen within 3, or why not.
 */
async function reach(ctx: GoalContext, id: number, home: Pos, food?: string): Promise<{ e?: Ent; why?: string }> {
  let e = await find(ctx, id, 96);
  if (!e) return { why: 'it wandered off before the bot got to it' };
  if (horiz(e.position, home) > ctx.world.leash) return { why: PAST_LEASH };
  if (food) await ctx.call('item.select', { name: food });
  if (e.distance > 3) await walkTo(ctx, e.position, 3);
  for (let i = 0; i < 3; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    e = await find(ctx, id);
    if (!e) return { why: 'it wandered off before the bot got to it' };
    if (horiz(e.position, home) > ctx.world.leash) return { why: PAST_LEASH };
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
 * then is refused its next look and throws here), and the run takes it off again at its end.
 */
async function leashOn(ctx: GoalContext, id: number, home: Pos, used: () => void = () => undefined): Promise<{ ok: boolean; why: string }> {
  let why = 'it stayed out of reach';
  for (let i = 0; i < 2; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const e = await find(ctx, id);
    if (!e) return { ok: false, why: 'it is gone from sight, or is someone\'s' };
    if (horiz(e.position, home) > ctx.world.leash) return { ok: false, why: PAST_LEASH };
    if (e.distance > 3.5) await walkTo(ctx, e.position, 2);
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
 * Off the bot's lead where a run that was given up left it, walking nowhere: the bot stands, and a led animal closes
 * in to 2 within a second or two (a 4-block leg leaves it up to 6 behind, past the 4.5 the use key reaches; one use
 * at once left the cow on the lead, dragged after whatever the bot did next). Up to 4 looks half a second apart,
 * about 2.5 s: the brain waits 5 s for a run it stopped before survival goes on. The lead falls by it. Not shown
 * on a lead at the first look, a second half a second on: a lead put on just as the run was given up shows only once
 * the server's word of it reaches the client.
 */
async function offLead(ctx: GoalContext, id: number): Promise<void> {
  let o = await own(ctx, id);
  if (!o?.leashed) { await pause(500); o = await own(ctx, id); }
  if (!o?.leashed) return;
  const weapon = ctx.s.items.find(i => /_sword$/.test(i.name))?.name;
  if (weapon) await ctx.call('item.select', { name: weapon }).catch(() => undefined);
  for (let i = 0; i < 4 && o?.leashed; i++) {
    if (o.distance <= 4) await ctx.call('entity.use', { id }).catch(() => undefined);
    await pause(500);
    o = await own(ctx, id);
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

/** How a walk-in ended: in the pen or not, in words, and where the animal was last seen when not. */
interface Brought { penned: boolean; text: string; last?: Pos }

/**
 * Walk an animal into its pen: up to it, a lead on it (or its food in hand), home in short legs through the yard's
 * gate (shut behind it once it is through), in at the pen's gate, and right across the pen: a tempted animal stops 2.5
 * blocks from the bot (TemptGoal) and a led one 2 (PathfinderMob), and with the bot only 2 in, both stopped in the
 * gateway. Off the lead there (picked up), or the food put away, out, the gate shut. The words say where it broke
 * off and how far: what a maintenance run reads.
 */
async function bringIn(ctx: GoalContext, kind: PenKind, p: Pen, way: Way, target: Ent, hold: Hold, o: { home: Pos; enough: () => boolean }): Promise<Brought> {
  const id = target.id;
  const lead = 'lead' in hold;
  const food = lead ? undefined : hold.food;
  /** a lead went on it (shown by the client or not): however the run ends, it is seen off it */
  let used = false;
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
    const r = await reach(ctx, id, o.home, food);
    if (!r.e) return { penned: false, text: r.why!, last: target.position };
    const out = Math.round(horiz(r.e.position, o.home));
    if (lead) {
      const on = await leashOn(ctx, id, o.home, () => { used = true; });
      if (!on.ok) return { penned: false, text: `would not take the lead (${on.why})`, last: r.e.position };
    }
    // from here the animal walks with the bot, and only survival may stop the run (the brain reads this): the way
    // from the yard's gate to the pen passes within 10 of home, inside the reach of the home rounds, and a round that
    // cut in there (smelt 66, the kit 70, the stash 60) left the cow loose in the yard and the lead lying by it
    afield.ledBy = ctx.signal;
    const said = [`${lead ? 'on the lead' : `on the ${food}`} from ${out} out`];
    const fromGate = async () => Math.round(horiz(await here(ctx), mid(way.outside)));
    const route = routeFor(ctx.world, r.e.position, way);
    let last: Ent = r.e;
    let broke = 0;
    let yardShut = !route.gate;
    /** let go of it where it is (out of time, stuck): the lead off and picked up */
    const leave = async (why: string): Promise<Brought> => {
      if (!lead) return { penned: false, text: `${said.join('; ')}; ${why}`, last: last.position };
      const g = await letGo(ctx, id);
      return { penned: false, text: `${said.join('; ')}; ${why}: let go of it there${g.picked ? ', the lead picked up' : '; the lead not found where it fell'}`, last: last.position };
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
          const h = await heelLead(ctx, id);
          if (!h.e) {
            const g = await pickUpLead(ctx, last.position);
            return { penned: false, text: `${said.join('; ')}; lost on the way (last seen ${Math.round(last.distance)} off at ${at(last.position)})${g ? '; the lead picked up' : ''}`, last: last.position };
          }
          last = h.e;
          if (h.broke) {
            broke++;
            const where = `the lead broke ${await fromGate()} from the gate (the ${kind} ${Math.round(h.e.distance)} off)`;
            const picked = await pickUpLead(ctx, h.e.position);
            // once more from where it stands, when there is time: a lead caught on a tree breaks once
            if (picked && broke === 1 && !o.enough()) {
              const again = await reach(ctx, id, o.home);
              if (again.e && (await leashOn(ctx, id, o.home)).ok) { last = again.e; said.push(`${where}, put on again`); continue; }
            }
            return { penned: false, text: `${said.join('; ')}; ${where}${picked ? '; the lead picked up' : '; the lead not found where it fell'}`, last: h.e.position };
          }
        } else {
          const e = await keepClose(ctx, id, food!);
          if (!e || e.distance > 10) {
            return { penned: false, text: `${said.join('; ')}; it stopped following ${await fromGate()} from the gate${e ? ` (the ${kind} ${Math.round(e.distance)} off)` : ''}`, last: (e ?? last).position };
          }
          last = e;
        }
        // through the yard's gate, and the animal too: shut it behind them
        if (!yardShut && route.gate && last && inFence(ctx.world, await here(ctx)) && inFence(ctx.world, last.position)) {
          yardShut = true;
          await shut(route.gate);
        }
      }
    }
    // (legs that got nowhere: walking on into the pen in one go would leave it behind)
    const short = await fromGate();
    if (short > 3) return leave(`got no nearer than ${short} to the gate`);
    if (!gatesOff) await gatesAuto(false);
    // in at the gate and across the pen, the animal after the bot
    penOpened = true;
    if (!(await gateOpen(ctx, way.gate))) await toggle(ctx, way.gate);
    if (food) await ctx.call('item.select', { name: food });
    for (const c of [way.inside, way.deep]) await ctx.call('goto', { ...c, range: 0, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
    let e: Ent | undefined;
    for (let w = 0; w < 10; w++) {
      e = lead ? await own(ctx, id) : await find(ctx, id);
      if (!e || wellIn(p, way, e.position)) break;
      await pause(750);
    }
    const came = !!e && wellIn(p, way, e.position);
    const stood = e ? ` (it stood ${Math.round(e.distance)} off at ${at(e.position)})` : '';
    let tail = '';
    if (lead) {
      const g = await letGo(ctx, id);
      if (!g.picked) tail = '; the lead not found where it fell';
    } else {
      // food away (a sword in hand), or it follows the bot straight back out
      const weapon = ctx.s.items.find(i => /_sword$/.test(i.name))?.name;
      if (weapon) await ctx.call('item.select', { name: weapon });
      await pause(1500);
    }
    await ctx.call('goto', { ...way.outside, range: 0, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
    if (await gateOpen(ctx, way.gate)) await toggle(ctx, way.gate);
    const end = await find(ctx, id);
    const penned = !!end && within(p, end.position);
    said.push(penned ? 'led in' : came ? 'in the pen, but out again as the bot left' : `at the gate it would not come in${stood}`);
    return { penned, text: `${said.join('; ')}${tail}`, ...(penned ? {} : { last: (end ?? e ?? last).position }) };
  } finally {
    // still on the lead (cut short by survival, the LLM or the timeout; or a lead the client was slow to show): off it
    // comes, or the bot drags it into whatever it does next. A run given up walks nowhere (offLead); one still going
    // walks up to it and picks the lead up, and only survival cuts it till then
    if (used) {
      if (ctx.signal.aborted) await tidyUp(() => offLead(ctx, id));
      else if ((await own(ctx, id).catch(() => undefined))?.leashed) await letGo(ctx, id).catch(() => undefined);
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

/** Wild adults of a pen's kind in sight (not someone's), outside its pen and within the leash of home: the nearest first. */
async function wildOnes(ctx: GoalContext, kind: PenKind, p: Pen, home: Pos, range = 48): Promise<Ent[]> {
  return (await entities(ctx, range)).filter(e => e.name.replace(/^minecraft:/, '') === kind && !e.baby && !inPen(p, e.position) && horiz(e.position, home) <= ctx.world.leash)
    .sort((a, b) => a.distance - b.distance);
}

/** The wild ones a look saw, written down where they stood (the nearest kept first, four a kind): the cows rung's `in sight`. */
function sighted(world: WorldMemory, kind: PenKind, seen: Ent[]): void {
  for (const e of seen.slice(0, 4).reverse()) addSite(world, kind, cell(e.position));
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
 * the pen holds and the wild ones round it within the leash (work.pen, work.sites): the cows rung goes by them.
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
      for (let i = 0; i < 3 && !ctx.signal.aborted; i++) {
        const inv = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
        const counts = new Map<string, number>();
        for (const it of inv.items) if (it.slot < 36) counts.set(it.name, (counts.get(it.name) ?? 0) + it.count);
        const look = await entities(ctx);
        const st = penState(p, look);
        notePen(ctx.world, kind, { adults: st.inside.adults, babies: st.inside.babies, at: ctx.s.now });
        sighted(ctx.world, kind, look.filter(e => e.name.replace(/^minecraft:/, '') === kind && !e.baby && !inPen(p, e.position) && horiz(e.position, home) <= ctx.world.leash)
          .sort((a, b) => a.distance - b.distance));
        const a = nextAnimalAction(p, look, counts, {
          minAdults: 2, maxAdults: MAX_ADULTS, breedCooldownOk: id => Date.now() - (fedAt.get(id) ?? 0) > 5.5 * MINUTE
        });
        if (a.kind === 'wait') { out.push(`${kind}: ${a.why}`); break; }
        if (a.kind === 'lure') {
          const target = look.find(e => e.id === a.target)!;
          // (on a lead first, as the fetch does; the wheat when no lead can be had)
          const h: { hold?: Hold; why: string } = way ? await holdFor(ctx, kind) : { why: 'no gate on the pen' };
          const r = way && h.hold ? await bringIn(ctx, kind, p, way, target, h.hold, { home, enough: () => false }) : { penned: false, text: h.why };
          out.push(`${kind}: ${h.hold && 'food' in h.hold ? `${h.why}: ` : ''}${r.text}`);
          if (r.penned) ctx.gain(1);
        } else if (a.kind === 'breed') {
          let fed = 0;
          for (const id of a.ids) if (await useOn(ctx, id, a.food)) { fed++; fedAt.set(id, Date.now()); ctx.gain(1); }
          out.push(`${kind}: fed ${fed} to breed`);
        } else if (a.kind === 'cull') {
          const r = await ctx.act('attack-entity', { target: `#${a.id}`, maxDistance: 24, timeoutMs: 30_000 });
          if (r.ok) ctx.gain(1);
          out.push(`${kind}: culled one (${r.text.split('\n')[0].slice(0, 60)})`);
        } else {
          out.push(`${kind}: ${(await useOn(ctx, a.id, 'shears')) ? 'sheared one' : 'could not shear'}`);
        }
        ctx.progress(out.at(-1)!);
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

/**
 * What a fetch came to: an animal penned is its gain; `untried`: it never got to look (no pen to bring one to);
 * `mark`: what it learnt of the place it looked, for the wrapper's dry mark (work.ts WorkResult).
 */
export interface Fetched { gain: number; text: string; untried?: true; mark?: WorkResult['mark'] }

/**
 * Where a wild one was seen (work.sites, the pens round's looks and the fetches'): one in sight from here first, then
 * the nearest place it was seen and the next, walked to and looked round. A place with none any more is forgotten.
 * `short`: the run's time ran out before a place was looked at; `untried`: no gate let it out of the yard to one.
 */
async function toSighting(ctx: GoalContext, kind: PenKind, p: Pen, home: Pos, enough: () => boolean): Promise<{ found?: Ent; text: string; short?: true; untried?: true }> {
  const first = (await wildOnes(ctx, kind, p, home))[0];
  if (first) return { found: first, text: '' };
  const seen = sitesOf(ctx.world, kind).filter(q => horiz(q, home) <= ctx.world.leash).sort((a, b) => horiz(a, home) - horiz(b, home)).slice(0, 2);
  const gone: string[] = [];
  for (const q of seen) {
    if (ctx.signal.aborted) throw new Error('aborted');
    if (enough()) {
      if (!gone.length) return { text: `the run's time ran out before the bot got to where a ${kind} was seen`, short: true };
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
    const careful = byYard(ctx.world, gate.at ?? await here(ctx), q);
    await ctx.call('goto', { x: q.x, y: q.y, z: q.z, ...(inside || careful ? {} : { xz: true }), range: 8, ...(careful ? { careful: true } : {}), timeoutMs: 90_000 }, 105_000).catch(() => undefined);
    if (ctx.signal.aborted) throw new Error('aborted');
    const ones = await wildOnes(ctx, kind, p, home);
    sighted(ctx.world, kind, ones);
    if (ones[0]) return { found: ones[0], text: '' };
    dropSite(ctx.world, kind, q);
    gone.push(`(${q.x}, ${q.y}, ${q.z})`);
  }
  return { text: gone.length ? `no wild ${kind} where one was seen at ${gone.join(', ')}: forgotten` : `no wild ${kind} seen within the leash any more` };
}

/**
 * The work queue's cows rung (worktasks.ts): one wild animal fetched for a pen short of a pair, from where one was
 * last seen (`in sight`) or one side of home a run (north, east, south, west), out to the leash and no further, and
 * walked in on a lead (bringIn). The cow pen on the friend's server never held a cow: every fetch on the wheat
 * "did not come in" (10 of 12), so the herd never bred and the enchanting room waited on its 38 leather. Gain: the
 * animal penned. What the pen holds is written down as it is seen (work.pen), and where a wild one stood (work.sites).
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
  const found: { found?: Ent; text: string; short?: true; untried?: true } = from === IN_SIGHT ? await toSighting(ctx, kind, p, home, enough)
    : await alongSide(ctx, from as HomeSide, `wild ${kind}s`, async () => {
      const ones = await wildOnes(ctx, kind, p, home);
      sighted(ctx.world, kind, ones);
      return ones[0];
    }, enough);
  if (!found.found) return { gain: 0, text: found.text, ...(found.short ? { mark: 'same' as const } : {}), ...(found.untried ? { untried: true as const } : {}) };
  const target = found.found;
  const seenAt = cell(target.position);
  addSite(ctx.world, kind, seenAt);
  ctx.progress(`fetching a ${kind} for the pen: ${Math.round(target.distance)} blocks off, ${Math.round(horiz(target.position, home))} from home`);
  const r = await bringIn(ctx, kind, p, way, target, h.hold, { home, enough });
  // in: it was seen there no longer. Not in: where it was last seen is where to look next time
  dropSite(ctx.world, kind, seenAt);
  if (!r.penned && r.last && horiz(r.last, home) <= ctx.world.leash && !inPen(p, r.last)) addSite(ctx.world, kind, cell(r.last));
  await lookAtPen();
  // one found and not brought in: there are cows that way, and the side (or `in sight`) is tried again after a first
  // mark's wait, not an ever longer one (four lost on the lead would have kept the side where they graze for days)
  return { gain: r.penned ? 1 : 0, text: `${kind}: ${'food' in h.hold ? `${h.why}: ` : ''}${r.text}`, ...(r.penned ? {} : { mark: 'first' as const }) };
}
