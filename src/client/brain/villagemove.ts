import type { Decline, Goal, GoalContext, Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { Zone } from './courtesy.js';
import { brainRun, type Status } from '../tools.js';
import { alongSide, byYard, inFence, outByGate, roundFrom, type HomeSide, type WorkResult, type WorkTask } from './work.js';
import { prepare } from './project.js';
import { CHEST_SPARE, FOOD_TARGET, readyFoodPoints } from './food.js';
import { Ground, MAX_DROP, checkLeg, entryOf, footprint, planRoute, readBand, type BoatAt, type Entry } from './boatroute.js';
import { planRails, railsLine, type RailPlan } from './railroute.js';
import { chestTotals } from './chests.js';
import {
  HALL_FRESH, HALL_WANTS, JOB_SITE, MARKERS_NEAR, VILLAGE_MARK, VILLAGE_RANGE, byJobSite, judgeVillage, knownVillage, movesOn, noteSeen, noteVillage,
  peekVillages, pennedIn, siteOf, siteOpen, variantOf, villageArea, villagesOf, type Seen, type Verdict, type VillageLook, type VillageSite
} from './village.js';

/**
 * The villager move (P5c of the progression plan), run supervised behind the villager-moves switch: the `villagers` rung
 * of the work queue brings one unemployed adult villager a run from a village judged free (village.ts) to the bot's
 * own hall (villagers.ts), by boat. Villagers cannot be leashed (26.3: AbstractVillager.canBeLeashed is false) and follow
 * no one, emeralds or not; a boat put down against one takes it into its back seat on the next tick, the bot gets in
 * front and steers (the bridge's vehicle.* calls, Vehicle.java). The way: the boat's route home judged on the ground
 * before the villager is taken (boatroute.ts: flat, downhill or water, 2 wide, 16 off every build of others), read as
 * the bot walks out to the village; at the yard, the fence's posts straight out from the hall's panel and the panel
 * itself (3 wide: the boat is 1.375 across) dug from the boat, driven through, the villager let out in the room, the
 * boat broken back into its item, the panel and the fence put back as they were. A move that runs past its budget, or
 * finds the way blocked, gives up: home without the villager, the boat taken back up, everything it opened put back;
 * one cut short (survival, its timeout, the LLM) gets out of the boat and breaks it all the same, outside the run, and
 * leaves what it opened in `villages.open` for the `close up` goal (and the brain gets a bot seated in a boat with no run
 * to steer it out first, a restart's among them: brain.ts outOfVehicle). Every step is said
 * (`villagers: ...`). With the switch off nothing of it runs: the rung offers nothing, the sightings are only remembered.
 * When no boat way home is found, the rails fallback (the user's) is planned on the same ground and said, a dry run:
 * nothing of it is laid, switch on or off (railroute.ts; the lead builds the laying if the boat move fails live).
 */

const MINUTE = 60_000;
/** The boat's pace on land, blocks a second (0.1 a tick; on water 8): how long the way home with a villager takes. */
export const BOAT_PACE = 2;
/**
 * A move's budget: the walk out to a village at the range's end (384 at 3 a second, 128 s), the look round it (a minute
 * or two), the boat home on land (192 s) and the yard's openings: 10 min. The run's timeout is 4 min more (work.ts
 * timeoutOf), which holds the walk home from out there after a give-up.
 */
export const MOVE_BUDGET = 10 * MINUTE;
/** The stops of the walk out, blocks apart: the ground round each is read for the boat's way back. */
const SURVEY_LEG = 48;
/** The band either side of the line from the yard to the village that is read for the way home. */
const BAND = 16;
/** Read round the bot no further than this (the client has the chunks within about 96 loaded). */
const READ_NEAR = 80;
/** The look round a village: how far round its middle the bells, beds and villagers are looked for. */
const LOOK = 96;
/** The most extra places walked to for the scans to see all of a village. */
const VIEWPOINTS = 4;
/**
 * The ground read on the walk out reaches this far under and over the yard's and the village's levels, for the rails'
 * plan (a hill the boat cannot cross is what they are for): one world.region a tile still (64 high at most).
 */
const RAILS_BELOW = 8;
const RAILS_ABOVE = 20;
/** Tries at putting the boat down against the villager (it wanders). */
const PLACE_TRIES = 3;
/** The yard's part of a move: the fence and the panel dug from the boat, the two short drives, out, the boat up, all put back. */
const YARD_MS = 60_000;
/** The boat's item: five oak planks at a table (26.3's oak_boat.json; progress.ts RECIPES). */
export const BOAT_ITEM = 'oak_boat';
const SIDES: HomeSide[] = ['north', 'east', 'south', 'west'];
const isSide = (v: string): v is HomeSide => (SIDES as string[]).includes(v);

const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const fmt = (p: { x: number; y?: number; z: number }) => `(${Math.floor(p.x)}, ${p.y === undefined ? '' : `${Math.floor(p.y)}, `}${Math.floor(p.z)})`;
const idOf = (state: string) => state.replace(/^minecraft:/, '').replace(/\[.*$/, '');
const pause = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
/** A turn for everything else waiting (the brain's ticks, the bridge's replies) between searches of whole seconds. */
const yieldNow = () => new Promise<void>(res => setImmediate(res));

/**
 * How long the boat takes home from `from` along `legs` (pure): at the boat's pace on land, a third more for its turns
 * and stops, and the yard's part after. Judged before a villager is taken: a drive timed out halfway home lets it out
 * in the wild, between its village and the hall.
 */
export function homeMs(from: { x: number; z: number }, legs: readonly { x: number; z: number }[]): number {
  let d = 0, at = from;
  for (const q of legs) { d += horiz(at, q); at = q; }
  return Math.round(d / BOAT_PACE * 1000 * 1.3) + YARD_MS;
}

// ------------------------------------------------------------------------------------------------ the rung's gates

/**
 * Why the rung has nothing to do (pure): the switch off; no hall; the hall with its villagers as last counted (under
 * half an hour ago: older, the run looks again first).
 */
function hallWhy(s: Snapshot, world: WorldMemory): Decline | null {
  if (!movesOn(world)) return { cause: 'unneeded', text: 'villager moves are off' };
  if (!world.zones?.hall?.length) return { cause: 'unneeded', text: 'no villager hall yet' };
  const h = peekVillages(world).hall;
  if (h && s.now - h.at < HALL_FRESH && h.count >= HALL_WANTS) return { cause: 'stocked', text: `the hall has ${h.count} villagers (${HALL_WANTS} wanted)` };
  return null;
}

/**
 * The `villagers` rung (worktasks.ts LADDER, rank 4.4: above the Nether and the deep trips, whose mornings it would
 * otherwise never get; it is a few moves in all). Its variants: each village known and open to it (within the range,
 * not someone's, its boat way not failed today: `first`, tried ahead of the turn), then the four sides of home, searched
 * out to VILLAGE_RANGE as the cows' are (`alongSide`). Never in the rain (the plan's word), never at night (the shared
 * gates), never with a move's openings not put back. The way home with a villager is at the boat's pace on land
 * (`backPace`), so a move that sets out has the day to come home in.
 */
export const villagersTask: WorkTask = {
  name: 'villagers',
  rank: 4.4,
  reach: 'far',
  room: 'trip',
  budgetMs: MOVE_BUDGET,
  terrain: true,
  range: () => VILLAGE_RANGE,
  backPace: BOAT_PACE,
  variants: (s, world) => {
    if (hallWhy(s, world)) return [];
    const home = s.home ?? s.position;
    const sites = peekVillages(world).sites.filter(q => siteOpen(q, home, s.now)).sort((a, b) => horiz(a, home) - horiz(b, home));
    return [...sites.map(q => ({ id: variantOf(q), dist: Math.round(horiz(q, home)), first: true as const })), ...SIDES.map(id => ({ id, dist: VILLAGE_RANGE }))];
  },
  none: (s, world) => hallWhy(s, world) ?? { cause: 'unneeded', text: 'villagers: nothing to do' },
  ready: (s, world) => {
    if (s.raining || s.thundering) return { cause: 'late', text: 'raining: no villager is moved in the rain' };
    const open = peekVillages(world).open?.length;
    if (open) return { cause: 'unneeded', text: `${open} block(s) of the hall or the fence left open by a move: close up first` };
    return null;
  },
  run: async (ctx, variant, budgetMs, now) => {
    const began = now();
    const enough = () => now() - began > budgetMs;
    // the hall counted first, whichever way the run goes: a count over half an hour old lets the gates through, and a
    // full hall sent no one on a move but did send the side search out to 384
    const counted = await countHall(ctx, now());
    if (counted !== undefined && counted >= HALL_WANTS) return { gain: 0, text: `the hall has ${counted} villagers already: none moved`, mark: 'same' };
    if (isSide(variant)) return searchSide(ctx, variant, enough, now);
    const site = siteOf(ctx.world, variant);
    if (!site) return { gain: 0, text: `no ${variant} known any more`, mark: 'forget' };
    return moveFrom(ctx, site, { now, began, budgetMs, enough });
  }
};

// ------------------------------------------------------------------------------------------------ looks

const here = async (ctx: GoalContext): Promise<Pos> => (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
const say = (ctx: GoalContext, text: string) => ctx.progress(`villagers: ${text}`);

/** The villagers inside the hall's box (world.entities from home or the hall), noted with the time; undefined when not seen. */
async function countHall(ctx: GoalContext, now: number): Promise<number | undefined> {
  const hall = ctx.world.zones?.hall?.[0];
  if (!hall?.width || !hall.length) return undefined;
  const { x, y, z, width, length } = { ...hall, width: hall.width, length: hall.length };
  const r = await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 128, type: 'villager' }).catch(() => undefined);
  if (!Array.isArray(r?.entities)) return undefined;
  const inside = r.entities.filter(e => e.position && e.position.x >= x && e.position.x < x + width
    && e.position.z >= z && e.position.z < z + length && Math.abs(e.position.y - (y + 1)) <= 3);
  villagesOf(ctx.world).hall = { count: inside.length, at: now };
  return inside.length;
}

/**
 * A village in sight from where the bot stands: a bell within 96 (world.findBlocks: the chunks loaded round it), else
 * three villagers out in the world near each other. Not one already judged (someone's, waiting, free) or found with no
 * boat way home: the side walks on past it (live in a probe, the north side walked back into a village it had judged
 * someone's every 20 minutes, and never searched beyond it). The villagers and players seen are remembered either way.
 */
async function villageInSight(ctx: GoalContext, now: number): Promise<Pos | undefined> {
  const home = ctx.s.home ?? ctx.s.position;
  const seen = await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: LOOK }).catch(() => undefined);
  if (Array.isArray(seen?.entities)) noteSeen(ctx.world, seen.entities, now, ctx.s.dimension);
  const bells = await ctx.call<{ positions?: Pos[] }>('world.findBlocks', { block: 'bell', maxDistance: LOOK, count: 4 }).catch(() => undefined);
  const bell = (bells?.positions ?? []).find(b => horiz(b, home) > 64 && !knownVillage(ctx.world, b));
  if (bell) return bell;
  const vs = (seen?.entities ?? []).filter(e => e.name === 'villager' && e.position && horiz(e.position, home) > 64 && !knownVillage(ctx.world, e.position));
  const group = vs.find(v => vs.filter(o => horiz(o.position!, v.position!) <= 32).length >= 3);
  return group ? { x: Math.floor(group.position!.x), y: Math.floor(group.position!.y), z: Math.floor(group.position!.z) } : undefined;
}

/**
 * The look round a village for the judge: its bells, beds and job sites as the scans saw them (foreign.marks), the
 * creatures round it (each villager's own few cells read for a pen), the markers in its area and 16 round it, how much
 * of that the scans have seen (walking to up to VIEWPOINTS more places when not all), the builds of others, the players
 * remembered, the world spawn. `middle`: where the village is thought to be.
 */
async function lookVillage(ctx: GoalContext, middle: Pos, now: number, enough: () => boolean): Promise<VillageLook> {
  const seen = new Map<number, Seen>();
  const visited: { x: number; z: number }[] = [await here(ctx)];
  let marks: { at: { x: number; y: number; z: number; name: string }[] } = { at: [] };
  let kinds: Record<string, number> = {};
  let looked = { chunks: 0, of: 1 };
  const area = () => villageArea({ ...split(marks.at), seen: [...seen.values()] });
  for (let round = 0; round <= VIEWPOINTS; round++) {
    const r = await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: LOOK }).catch(() => undefined);
    for (const e of r?.entities ?? []) seen.set(e.id, e);
    noteSeen(ctx.world, r?.entities ?? [], now, ctx.s.dimension);
    marks = await ctx.call<{ at?: { x: number; y: number; z: number; name: string }[] }>('foreign.marks', {
      x1: middle.x - LOOK, z1: middle.z - LOOK, x2: middle.x + LOOK, z2: middle.z + LOOK, match: VILLAGE_MARK.source, max: 256
    }).then(m => ({ at: m.at ?? [] })).catch(() => ({ at: [] }));
    const a = area();
    if (!a) break;
    const k = await ctx.call<{ kinds?: Record<string, number>; chunks?: number; of?: number }>('foreign.marks', {
      x1: a.x1 - MARKERS_NEAR, z1: a.z1 - MARKERS_NEAR, x2: a.x2 + MARKERS_NEAR, z2: a.z2 + MARKERS_NEAR, y1: a.y1 - MARKERS_NEAR, y2: a.y2 + MARKERS_NEAR
    }).catch(() => undefined);
    kinds = k?.kinds ?? {};
    looked = { chunks: k?.chunks ?? 0, of: k?.of ?? 1 };
    if (looked.chunks >= looked.of || round === VIEWPOINTS || enough()) break;
    // the scans see 48 round the bot: on to the corner of the box farthest from where it has looked
    const box = { x1: a.x1 - MARKERS_NEAR, z1: a.z1 - MARKERS_NEAR, x2: a.x2 + MARKERS_NEAR, z2: a.z2 + MARKERS_NEAR };
    const pull = (lo: number, hi: number, v: number) => (v === lo ? Math.min(hi, lo + 40) : Math.max(lo, hi - 40));
    const corners = [[box.x1, box.z1], [box.x2, box.z1], [box.x1, box.z2], [box.x2, box.z2]].map(([x, z]) => ({ x: pull(box.x1, box.x2, x), z: pull(box.z1, box.z2, z) }));
    const next = corners.map(c => ({ c, d: Math.min(...visited.map(v => horiz(v, c))) })).sort((p, q) => q.d - p.d)[0];
    if (!next || next.d < 40) break;
    say(ctx, `looking round the village from (${next.c.x}, ${next.c.z}): ${looked.chunks} of ${looked.of} chunks seen`);
    await ctx.call('goto', { x: next.c.x, y: middle.y, z: next.c.z, xz: true, range: 8, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => undefined);
    visited.push(await here(ctx));
  }
  const parts = split(marks.at);
  // each villager's few cells round it, read for a pen (a trading hall's cell, a cage)
  const penned = new Set<number>();
  for (const e of [...seen.values()].filter(v => v.name === 'villager' && v.position)) {
    const f = { x: Math.floor(e.position!.x), y: Math.floor(e.position!.y), z: Math.floor(e.position!.z) };
    const box = { x: f.x - 6, y: f.y - 2, z: f.z - 6, width: 13, height: 6, length: 13 };
    const r = await ctx.call<{ blocks?: (string | null)[] }>('world.region', box).catch(() => undefined);
    if (!r?.blocks) continue;
    const block = (x: number, y: number, z: number) => {
      const i = (x - box.x) + (z - box.z) * box.width + (y - box.y) * box.width * box.length;
      return x < box.x || x >= box.x + box.width || z < box.z || z >= box.z + box.length || y < box.y || y >= box.y + box.height ? null : r.blocks![i];
    };
    if (pennedIn(block, f)) penned.add(e.id);
  }
  // (a call that did not answer is no answer: "no builds round it" and "no spawn known" would pass the judge's rules)
  const unread: string[] = [];
  const zones = await ctx.call<{ zones?: Zone[] }>('foreign.zones', {}).then(z => {
    if (!Array.isArray(z?.zones)) throw new Error('no zones in the reply');
    return z.zones;
  }).catch(() => { unread.push('the builds of others round it'); return [] as Zone[]; });
  const st: Partial<Status> = await ctx.status().catch(() => ({}));
  if (!st.spawn) unread.push('the world spawn');
  return {
    ...parts, seen: [...seen.values()], penned, kinds, looked, zones, players: peekVillages(ctx.world).players, ...(st.spawn ? { spawn: st.spawn } : {}),
    ...(unread.length ? { unread } : {})
  };
}

function split(at: { x: number; y: number; z: number; name: string }[]): Pick<VillageLook, 'bells' | 'beds' | 'jobs'> {
  const p = (m: { x: number; y: number; z: number }) => ({ x: m.x, y: m.y, z: m.z });
  return {
    bells: at.filter(m => m.name === 'bell').map(p),
    beds: at.filter(m => /_bed$/.test(m.name)).map(p),
    jobs: at.filter(m => JOB_SITE.test(m.name)).map(m => ({ name: m.name, at: p(m) }))
  };
}

/**
 * The judge's word written on the site (a free one is judged again on every move: a fresh look is what counts), the
 * site moved to its bell; returns the site kept (none: no village there, forgotten).
 */
function noteVerdict(world: WorldMemory, site: VillageSite, look: VillageLook, v: Verdict, now: number): VillageSite | undefined {
  const counts = { bells: look.bells.length, beds: look.beds.length, jobs: look.jobs.length, villagers: look.seen.filter(e => e.name === 'villager').length };
  const w = villagesOf(world);
  // (the site as it was, moved to its bell: not another one made beside it)
  const kept = w.sites.find(q => q.x === site.x && q.z === site.z) ?? noteVillage(world, look.bells[0] ?? site, counts, now);
  if (v.kind === 'none') {
    w.sites = w.sites.filter(q => q !== kept);
    return undefined;
  }
  const bell = look.bells[0];
  if (bell) { kept.x = bell.x; kept.y = bell.y; kept.z = bell.z; }
  Object.assign(kept, counts, { seenAt: now, judged: { at: now, kind: v.kind, why: v.why.slice(0, 160) } });
  return kept;
}

// ------------------------------------------------------------------------------------------------ the search

/**
 * Along one side of home for a village, out to the range (the cows' way: stops 32 apart, by the side's own gate):
 * found, the bot walks to its middle and looks it over, and the judge's word is kept. The move is the next run's (from
 * the known site, `first`), which reads the boat's way home on its walk out.
 */
async function searchSide(ctx: GoalContext, side: HomeSide, enough: () => boolean, now: () => number): Promise<WorkResult> {
  say(ctx, `looking ${side} for a village, out to ${VILLAGE_RANGE}`);
  const found = await alongSide(ctx, side, 'village', () => villageInSight(ctx, now()), enough, { blocks: VILLAGE_RANGE, name: 'the village range' });
  if (!found.found) return { gain: 0, text: found.text, ...(found.short ? { mark: 'same' as const } : {}) };
  const at = found.found;
  say(ctx, `a village in sight at ${fmt(at)}, ${Math.round(horiz(at, ctx.s.home ?? ctx.s.position))} from home: walking over to look at it`);
  // (careful: walk only, nothing broken or put down in a village not judged yet; one not got to is looked at from where
  // the walk ended, and waits when the scans did not see it all)
  await ctx.call('goto', { x: at.x, y: at.y, z: at.z, xz: true, range: 8, careful: true, timeoutMs: 90_000 }, 105_000).catch(() => undefined);
  if (ctx.signal.aborted) throw new Error('aborted');
  const site = noteVillage(ctx.world, at, {}, now());
  const look = await lookVillage(ctx, at, now(), enough);
  const v = judgeVillage(look);
  noteVerdict(ctx.world, site, look, v, now());
  const text = `found a village at ${fmt(at)}: ${v.kind === 'free' ? `free (${v.why}): the move next run` : v.kind === 'theirs' ? `someone's, left alone: ${v.why}` : v.why}`;
  say(ctx, text);
  return { gain: 0, text, mark: 'first' };
}

// ------------------------------------------------------------------------------------------------ the move

interface Clock { now: () => number; began: number; budgetMs: number; enough: () => boolean }

/** The bot's own boat (vehicle.place's): its id now and the uuid that names it after a restart. */
interface Boat { id: number; uuid: string }
/** What the vehicle calls answer: ok, or why not. */
type Reply = { ok: boolean; reason?: string };
type Placed = Reply & { id?: number; uuid?: string; position?: Pos; tookIt?: boolean };

/** What the bot rides (status.riding), or undefined on foot. */
const ridingOf = async (ctx: GoalContext): Promise<Status['riding']> => (await ctx.status().catch(() => undefined))?.riding ?? undefined;

/** The block under a creature's feet (a boat put down on its top face comes down where the creature stands). */
const under = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y - 0.01), z: Math.floor(p.z) });

/** One block a move dug: what it was, so it goes back as it was. */
type Opened = { at: Pos; block: string };

/**
 * Dig a block from where the bot sits or stands (dig.here: no walking, no Baritone), written into `villages.open`
 * first, so a run cut short leaves it for `close up`. Air: nothing to do. Returns why not, or undefined.
 */
async function digOut(ctx: GoalContext, at: Pos, block: string | null | undefined): Promise<string | undefined> {
  if (ctx.signal.aborted) throw new Error('aborted');
  if (!block || /^(minecraft:)?(air|cave_air)(\[|$)/.test(block)) return undefined;
  const v = villagesOf(ctx.world);
  (v.open ??= []).push({ at: { ...at }, block });
  const r = await ctx.call<{ dug?: boolean; reason?: string }>('dig.here', { ...at, timeoutMs: 15_000 }, 25_000).catch(e => ({ dug: false, reason: (e as Error).message }));
  // (gone already: what stood on a dug block falls with it, and goes back all the same)
  if (r.dug || r.reason === 'air') return undefined;
  // (not dug: nothing to put back there)
  v.open = v.open.filter(o => !(o.at.x === at.x && o.at.y === at.y && o.at.z === at.z));
  if (!v.open.length) delete v.open;
  return `${idOf(block)} at ${fmt(at)}: ${r.reason ?? 'not dug'}`;
}

const OPPOSITE: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east' };

/**
 * Put one dug block back as it was (place-block: the bot's own again, protected), from where the bot stands: a
 * standing block on the block below it, a wall torch on the block it hung on. A creature in the cell (a villager by the
 * panel) is waited out for a few seconds; the bot standing in it steps aside. Taken off `villages.open` once in place.
 */
async function putBack(ctx: GoalContext, o: Opened): Promise<string | undefined> {
  const id = idOf(o.block);
  const item = /wall_torch$/.test(id) ? id.replace('wall_torch', 'torch') : id;
  const facing = /facing=(north|south|east|west)/.exec(o.block)?.[1];
  const face = /wall_torch$/.test(id) && facing ? OPPOSITE[facing] : 'down';
  let said = '';
  for (let i = 0; i < 4; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const r = await ctx.act('place-block', { ...o.at, item, faceDirection: face }).catch(e => ({ ok: false, text: (e as Error).message }));
    said = r.text;
    const there = /already a block \(([a-z_:]+)/.exec(r.text)?.[1]?.replace(/^minecraft:/, '');
    if (/^Placed/.test(r.text) || there === id) {
      const v = villagesOf(ctx.world);
      v.open = (v.open ?? []).filter(x => !(x.at.x === o.at.x && x.at.y === o.at.y && x.at.z === o.at.z));
      if (!v.open.length) delete v.open;
      return undefined;
    }
    if (/No .* in inventory/.test(r.text)) break;
    if (/where you're standing/.test(r.text)) await ctx.call('goto', { ...o.at, away: 2, careful: true, timeoutMs: 10_000 }, 20_000).catch(() => undefined);
    else await pause(1000);
  }
  return `${item} at ${fmt(o.at)}: ${said.slice(0, 80)}`;
}

/** Put back everything a move left open (or those of `which`), the lowest first, walking carefully into reach of each. */
async function closeUp(ctx: GoalContext, which?: (o: Opened) => boolean): Promise<{ put: number; left: string[] }> {
  const todo = [...(villagesOf(ctx.world).open ?? [])].filter(o => !which || which(o)).sort((a, b) => a.at.y - b.at.y);
  let put = 0;
  const left: string[] = [];
  for (const o of todo) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const me = await here(ctx);
    if (Math.hypot(me.x - o.at.x - 0.5, me.y + 1.6 - o.at.y - 0.5, me.z - o.at.z - 0.5) > 4) {
      await ctx.call('goto', { ...o.at, range: 2, careful: true, timeoutMs: 45_000 }, 60_000).catch(() => undefined);
    }
    const why = await putBack(ctx, o);
    if (why) left.push(why); else put++;
  }
  return { put, left };
}

/**
 * The move from a village known (a run of the rung): the hall counted, the way into it read and judged, the boat and
 * the blocks to put back carried, the walk out reading the boat's way home, the village looked over and judged, a
 * villager whose way home is found taken into the boat, the drive home, the yard's openings, the villager let out in
 * the hall, everything put back. Any step that fails, or the budget run out, gives up (giveUp).
 */
async function moveFrom(ctx: GoalContext, site: VillageSite, clk: Clock): Promise<WorkResult> {
  const { now, enough } = clk;
  const world = ctx.world;
  const entry = entryOf(world);
  if ('why' in entry) return { gain: 0, text: `no way into the hall: ${entry.why}`, untried: true };
  // the ground: from under the yard's floor (the boat's lowest) to over the village's, with room for the rails' climbs
  // and dips (their dry run plans on the same reads when the boat finds no way)
  const y0 = Math.min(entry.level - MAX_DROP - 3, Math.min(site.y, entry.level) - RAILS_BELOW);
  const top = Math.max(site.y + 12, entry.level + 8, Math.max(site.y, entry.level) + RAILS_ABOVE);
  const ground = new Ground(y0, Math.min(64, top - y0 + 1));
  // the yard's part, read from here: the fence's posts and what stands on them, the hall's wall
  const yardBox = boxOf([entry.out, entry.front, entry.inside, ...entry.fence, ...entry.wall], 4);
  await ground.read(ctx, yardBox.x1, yardBox.z1, yardBox.x2, yardBox.z2);
  // (what stands on a post first: a torch on it pops off as its post goes, and would never be put back)
  const fence: Opened[] = [];
  for (const p of entry.fence) {
    const over = { x: p.x, y: p.y + 1, z: p.z };
    const top = ground.state(over.x, over.y, over.z);
    if (top && !/^(minecraft:)?(air|cave_air)(\[|$)/.test(top)) fence.push({ at: over, block: top });
    fence.push({ at: p, block: ground.state(p.x, p.y, p.z) ?? '' });
  }
  const wall: Opened[] = entry.wall.map(p => ({ at: p, block: ground.state(p.x, p.y, p.z) ?? '' }));
  const unread = [...fence, ...wall].find(o => !o.block);
  if (unread) return { gain: 0, text: `the way into the hall not read at ${fmt(unread.at)}`, untried: true };
  // what the yard's way will be once they are out: judged so (the posts and the wall as air)
  for (const o of [...fence, ...wall]) ground.set(o.at.x, o.at.y, o.at.z, 'air');
  // (from the ground the boat stands on outside the fence: the band there, cleared to the yard's level or not)
  const outside = footprint(ground, entry.out.x, entry.out.z, entry.level + MAX_DROP, false);
  const into = outside.ok ? checkLeg(ground, { ...entry.out, level: outside.level }, entry.front) : outside;
  const inside = into.ok ? checkLeg(ground, { ...entry.front, level: into.level }, entry.inside) : into;
  if (!inside.ok) {
    for (const o of [...fence, ...wall]) ground.set(o.at.x, o.at.y, o.at.z, o.block);
    return { gain: 0, text: `the boat's way into the hall is blocked: ${inside.why} at ${fmt(inside.at)}`, untried: true };
  }
  // carried: the boat, and what goes back into the fence and the wall (the dug blocks drop, but may not all be picked up)
  const need = new Map<string, number>([[BOAT_ITEM, 1]]);
  for (const o of [...fence, ...wall]) {
    const id = idOf(o.block);
    const item = /wall_torch$/.test(id) ? id.replace('wall_torch', 'torch') : id;
    need.set(item, (need.get(item) ?? 0) + 1);
  }
  const short: string[] = [];
  for (const [item, n] of need) {
    const left = await prepare(ctx, item, n);
    if (Object.keys(left).length) short.push(`${item} (${Object.entries(left).map(([k, v]) => `${v} ${k}`).join(', ')})`);
  }
  if (short.length) return { gain: 0, text: `not setting out: short of ${short.join(', ')}`, untried: true };
  // fed for the ride home: the Guardian eats as the bar empties, and under FOOD_TARGET of ready food carried the food
  // goal (survival, which cuts any run) would stop the move out there and let the villager out in the wild. Live on
  // Nov 15 it cut the deep trips five times in a day ("carrying 15 food points"). From the chests' bread
  const ride = FOOD_TARGET + CHEST_SPARE;
  let fed = readyFoodPoints(await countsNow(ctx));
  if (fed < ride) {
    const each = readyFoodPoints(new Map([['bread', 1]])) || 5;
    await prepare(ctx, 'bread', ((await countsNow(ctx)).get('bread') ?? 0) + Math.ceil((ride - fed) / each));
    fed = readyFoodPoints(await countsNow(ctx));
  }
  if (fed < ride) return { gain: 0, text: `not setting out: short of food (${fed} food points of ready food carried, ${ride} wanted for the ride home)`, untried: true };
  if (ctx.signal.aborted) throw new Error('aborted');

  // out to the village, reading the band the way home will go
  const target = { x: site.x + 0.5, z: site.z + 0.5 };
  await readBand(ctx, ground, entry.out, target, BAND, await here(ctx), READ_NEAR);
  say(ctx, `to the village at ${fmt(site)}, ${Math.round(horiz(site, ctx.s.home ?? ctx.s.position))} from home, reading the boat's way back as it goes`);
  const gate = await outByGate(ctx, site);
  if (gate.shut) return { gain: 0, text: `no villager fetched: ${gate.shut}`, untried: true };
  const d = horiz(entry.out, target);
  const legs = Math.max(1, Math.ceil(d / SURVEY_LEG));
  for (let i = 1; i <= legs; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    if (enough()) return { gain: 0, text: `the run's time ran out on the way out to the village at ${fmt(site)}`, mark: 'same' };
    const p = { x: Math.round(entry.out.x + (target.x - entry.out.x) * i / legs), z: Math.round(entry.out.z + (target.z - entry.out.z) * i / legs) };
    // (the line starts outside the panel's fence: to a village on the far side, its first stops lie in the yard, which
    // the walk out has just left by the gate that way; the band there was read from home before it set out)
    if (inFence(world, p)) continue;
    // careful by the yard (walk only: nothing broken or put down there), and as it comes up to the village, which is not
    // judged yet: a walk not got to its stop reads from where it ended
    const careful = byYard(world, await here(ctx), p) || horiz(p, target) <= LOOK;
    await ctx.call('goto', { x: p.x, y: site.y, z: p.z, xz: true, range: 8, ...(careful ? { careful: true } : {}), timeoutMs: 90_000 }, 105_000).catch(() => undefined);
    await readBand(ctx, ground, entry.out, target, BAND, await here(ctx), READ_NEAR);
  }
  if (ctx.signal.aborted) throw new Error('aborted');

  // the village looked over and judged
  const look = await lookVillage(ctx, { x: site.x, y: site.y, z: site.z }, now(), enough);
  const v = judgeVillage(look);
  const kept = noteVerdict(world, site, look, v, now());
  if (v.kind === 'none' || !kept) return { gain: 0, text: `no village at ${fmt(site)} any more: forgotten`, mark: 'forget' };
  if (v.kind === 'theirs') {
    say(ctx, `the village at ${fmt(site)} is someone's, left alone: ${v.why}`);
    return { gain: 0, text: `left the village at ${fmt(site)} alone: ${v.why}`, mark: 'forget' };
  }
  if (v.kind === 'wait') return { gain: 0, text: `the village at ${fmt(site)}: ${v.why}` };
  say(ctx, `the village at ${fmt(site)} is free to take from: ${v.why}`);
  if (!v.candidates.length) return { gain: 0, text: `no villager to take at ${fmt(site)}: ${v.why}` };
  // its ground, for the boat's first legs out of it; the way home keeps off every build but its own
  await ground.read(ctx, Math.max(v.area.x1, Math.floor(target.x) - READ_NEAR), Math.max(v.area.z1, Math.floor(target.z) - READ_NEAR),
    Math.min(v.area.x2, Math.floor(target.x) + READ_NEAR), Math.min(v.area.z2, Math.floor(target.z) + READ_NEAR));
  const zones = look.zones.filter(z => !v.own.includes(z));
  const bounds = boxOf([entry.out, target, { x: v.area.x1, z: v.area.z1 }, { x: v.area.x2, z: v.area.z2 }], BAND);
  const me = await here(ctx);
  const plan = (from: BoatAt) => planRoute(ground, from, entry.out, { zones, bounds, within: 1.5 });
  let chosen: { e: Seen; legs: { x: number; z: number }[] } | undefined;
  let why = '';
  let routed = 0, passed = 0;
  // those on whole blocks first, the nearest first: one standing on a path or farmland (15/16 high) has the grass beside
  // it a step up under the boat's footprint at once. The boat goes down beside the villager anyway, and the way is
  // judged again from where it comes down; a villager no boat way can even start from is passed over, not counted
  // against the village (else a village whose nearest four stood on its paths was given up for a day)
  const order = [...v.candidates].sort((a, b) => Number(!Number.isInteger(a.position!.y)) - Number(!Number.isInteger(b.position!.y)) || horiz(a.position!, me) - horiz(b.position!, me));
  for (const e of order) {
    // (a search is up to seconds of work with nothing else running: the brain's ticks, the bridge's replies and the
    // harness get their turn between)
    await yieldNow();
    if (ctx.signal.aborted) throw new Error('aborted');
    const from = { x: e.position!.x, z: e.position!.z, level: e.position!.y };
    if (!footprint(ground, from.x, from.z, from.level, false).ok) { passed++; continue; }
    const r = plan(from);
    if (r.ok) { chosen = { e, legs: r.legs }; break; }
    routed++;
    why ||= r.why;
    say(ctx, `no boat way home from by the villager (${e.id}) at ${fmt(e.position!)}: ${r.why}`);
    // (stopped by the way itself, away from where it started: a ridge, the band's edge, ground not read. The same stops
    // every other villager's search, each seconds long)
    if (r.unread || !r.at || horiz(r.at, e.position!) > 4) break;
  }
  if (!chosen && !routed) {
    const text = `no villager to take at ${fmt(site)} stands where a boat way could start (${passed} on a path, farmland or the like): looked at again when they have wandered`;
    say(ctx, text);
    return { gain: 0, text, mark: 'same' };
  }
  if (!chosen) {
    kept.noBoat = { at: now(), why: why.slice(0, 160) };
    say(ctx, `no boat way home from the village at ${fmt(site)}: ${why}`);
    await yieldNow();
    const rails = railsDryRun(ctx, { site: kept, ground, entry, fence, zones, bounds, candidates: v.candidates, me, at: now() });
    return { gain: 0, text: `no boat way home from the village at ${fmt(site)}: ${why}; ${rails}` };
  }
  // the way home must fit in what is left of the run before the villager is taken (the walk out and the look may have
  // used most of it, and an afternoon's budget is the daylight left): a leg timed out halfway lets it out in the wild
  const homeTakes = homeMs(chosen.e.position!, chosen.legs);
  const spare = clk.began + clk.budgetMs - now();
  if (spare < homeTakes) {
    const text = `not enough of the run left to bring a villager home from ${fmt(site)} (need ${Math.round(homeTakes / 1000)} s, ${Math.max(0, Math.round(spare / 1000))} s left)`;
    say(ctx, text);
    return { gain: 0, text, mark: 'same' };
  }
  return boatHome(ctx, { site: kept, entry, ground, zones, fence, wall, plan, villager: chosen.e, jobs: look.jobs, clk });
}

/** What the bot carries, kind by kind. */
async function countsNow(ctx: GoalContext): Promise<Map<string, number>> {
  const inv = await ctx.call<{ items?: { name: string; count: number }[] }>('inventory').catch(() => undefined);
  const m = new Map<string, number>();
  for (const it of inv?.items ?? ctx.s.items) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
  return m;
}

/** The last rails dry run's plan in full, by world: this session's only (hundreds of rails are no matter for brain.json). */
const railPlans = new WeakMap<WorldMemory, RailPlan>();
/** The last rails dry run's plan this session (the villager-moves tool shows it), or undefined. */
export const lastRailPlan = (world: WorldMemory): RailPlan | undefined => railPlans.get(world);

/**
 * The rails fallback when the boat finds no way home, as P5c has it: planned on the ground the walk out read and said,
 * NEVER laid (whatever the switch: the laying is not built; the lead builds it and turns it on if the boat move fails
 * live). From by the villagers the judge allows (the nearest to the bot first) to the yard's fence straight out from
 * the hall's panel, 16 off every build but the village's own: the route, the bill against the stores (the chests as last
 * seen and the pockets), every block it would put down and take back up (kept for the villager-moves tool), what it would
 * open. Its line is kept on the site. Returns what the run's result says of it.
 */
function railsDryRun(ctx: GoalContext, t: {
  site: VillageSite; ground: Ground; entry: Entry; fence: Opened[]; zones: Zone[]; bounds: { x1: number; z1: number; x2: number; z2: number };
  candidates: Seen[]; me: Pos; at: number;
}): string {
  const panel = (ctx.world.zones?.['hall:panel'] ?? []).filter(p => p && typeof p.y === 'number').sort((a, b) => a.y - b.y)[0];
  const yard = ctx.world.yard;
  if (!panel || !yard) return 'no rails planned (no panel or yard known)';
  const stores: Record<string, number> = { ...chestTotals(ctx.world) };
  for (const [item, n] of ctx.s.counts) stores[item] = (stores[item] ?? 0) + n;
  const candidates = [...t.candidates].filter(e => e.position).sort((a, b) => horiz(a.position!, t.me) - horiz(b.position!, t.me));
  const r = planRails(t.ground, { candidates, entry: t.entry, panel, yard, zones: t.zones, bounds: t.bounds, stores, fence: t.fence });
  if (!r.ok) {
    t.site.rails = { at: t.at, ok: false, text: r.why.slice(0, 200) };
    say(ctx, `no rails way home either (a dry run): ${r.why}`);
    return `no rails way home either: ${r.why}`;
  }
  railPlans.set(ctx.world, r);
  t.site.rails = { at: t.at, ok: true, text: `${r.length} rails (up ${r.climb}, down ${r.drop}), ${r.bill.iron_ingot} iron, ${r.bill.gold_ingot} gold, about ${Math.round(r.seconds.total / 60)} min` };
  say(ctx, `rails home planned (a dry run, nothing laid): ${railsLine(r)}`);
  say(ctx, `rails: the route ${r.route}; it would open the fence at ${r.opens.map(o => `${idOf(o.block)} ${fmt(o.at)}`).join(', ')} and take every rail, torch${r.stop.placed ? ' and the stop' : ''} back up after`);
  return `rails home planned (a dry run, nothing laid): ${r.length} rails, ${r.bill.iron_ingot} iron, ${r.bill.gold_ingot} gold, about ${Math.round(r.seconds.total / 60)} min`;
}

/** A box round some points (x1..z2), grown by `by`. */
function boxOf(ps: { x: number; z: number }[], by: number) {
  return {
    x1: Math.floor(Math.min(...ps.map(p => p.x))) - by, z1: Math.floor(Math.min(...ps.map(p => p.z))) - by,
    x2: Math.floor(Math.max(...ps.map(p => p.x))) + by, z2: Math.floor(Math.max(...ps.map(p => p.z))) + by
  };
}

interface Trip {
  site: VillageSite; entry: Entry; ground: Ground; zones: Zone[]; fence: Opened[]; wall: Opened[];
  plan: (from: BoatAt) => ReturnType<typeof planRoute>;
  villager: Seen; jobs: readonly { at: Pos }[]; clk: Clock;
}

/** Why a villager the judge allowed is no longer one to take, looked at again just before the boat goes down; '' if it still is. */
function notFree(e: Seen, jobs: readonly { at: Pos }[]): string {
  if (e.profession !== 'none') return `has a job now (${e.profession ?? 'none said'})`;
  if (e.baby) return 'is a baby';
  if (e.named) return 'is named';
  if (e.vehicle) return `rides a ${e.vehicle}`;
  if (e.leashed) return 'is on a lead';
  if (byJobSite(e, jobs)) return 'stands by a job site';
  return '';
}

const secs = (ms: number) => Math.max(0, Math.round(ms / 1000));

/**
 * The boat put down against the villager (it is in the back seat at once), the bot in front, the drive home leg by leg
 * (each judged again from where the boat is before it goes, and the rest planned again when it no longer holds), the
 * fence and the hall's wall dug from the boat, the villager let out in the room, the boat broken back into its item,
 * the wall put back from inside, out by the hall's gate, the fence back. Stopped from outside with the boat out (the
 * finally), the bot gets out and breaks the boat all the same, outside the run.
 */
async function boatHome(ctx: GoalContext, t: Trip): Promise<WorkResult> {
  const { site, entry, ground, zones, clk } = t;
  const { now, enough } = clk;
  const world = ctx.world;
  let boat: Boat | undefined;
  /** the drive home has begun: given up from here on, the villager is let out away from its village */
  let drove = false;
  const left = (): number => clk.began + clk.budgetMs - now();
  const giveUp = async (why: string): Promise<WorkResult> => {
    // (stopped from outside, every call of the run is refused now: the let-go is the finally's, outside the run)
    if (ctx.signal.aborted) throw new Error('aborted');
    say(ctx, `giving up: ${why}`);
    const out = await letGo(ctx, boat);
    if (out.taken) boat = undefined;
    const closed = await closeUp(ctx);
    // under way home, the villager is out of its village now; a cause that fails the same way every time (a step the
    // ground's model misses, the server refusing the boat on land) would leave one more out there each try, over a
    // spike the lead cannot watch all day: the moves wait for the lead (the plan's precedent, three Nether deaths)
    if (drove && movesOn(world)) {
      world.villagerMoves = false;
      say(ctx, `villager moves off (by the move: ${why})`);
    }
    const text = `gave up: ${why}${out.text}${closed.put ? `; put back ${closed.put} block(s)` : ''}${closed.left.length ? `; could not put back ${closed.left.join(', ')}` : ''}`;
    villagesOf(world).last = { at: now(), text: text.slice(0, 160), moved: false };
    return { gain: 0, text };
  };

  try {
    // the boat against the villager: it is in the back seat on the next tick (beside where it stands: the bridge picks
    // the spot on the tick of the use. It wanders, so it is looked at again just before, and a boat that missed it is
    // taken back up and put down again)
    let e = t.villager;
    let route: { x: number; z: number }[] | undefined;
    let pos: Pos | undefined;
    for (let i = 0; i < PLACE_TRIES && !boat; i++) {
      if (ctx.signal.aborted) throw new Error('aborted');
      if (enough()) return await giveUp('the run\'s time ran out before the villager was in the boat');
      // (never in the rain, the plan's word: the gate saw a dry sky when the run set out, minutes ago)
      const sky = await ctx.status().catch(() => undefined);
      if (sky?.raining || sky?.thundering) return await giveUp('it began to rain: no villager is taken in the rain');
      await ctx.call('goto', { ...under(e.position!), y: Math.floor(e.position!.y), range: 2, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);
      // looked at again just before: where the villager is now, and whether a player has come by since the judge's look
      // (a village a player is seen within 64 of is someone's: left alone, and for good)
      const round = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 64 }).catch(() => undefined))?.entities ?? [];
      noteSeen(world, round, now(), ctx.s.dimension);
      const player = round.find(x => x.name === 'player' && x.position);
      if (player) {
        site.judged = { at: now(), kind: 'theirs', why: `a player came by at ${fmt(player.position!)} as the bot was about to take a villager` };
        return await giveUp(`a player came by at ${fmt(player.position!)}: the village is someone's, left alone`);
      }
      const fresh = round.find(x => x.id === e.id && x.name === 'villager');
      if (!fresh?.position) return await giveUp(`the villager (${e.id}) went out of sight`);
      e = fresh;
      // and what it is, as the judge read it a minute or more ago (the way home searched, the walk over): an unemployed
      // villager takes a job site in that time as readily as any, and only unemployed adults are taken
      const changed = notFree(e, t.jobs);
      if (changed) return await giveUp(`the villager (${e.id}) ${changed}: no longer one to take`);
      say(ctx, `the boat down against an unemployed villager (${e.id}) at ${fmt(e.position!)}`);
      // (beside it, not on it: the game's boat item refuses a boat whose box meets a mob's, so the bridge puts its box
      // just clear of the villager's, within the 0.2 a boat takes a mob from, on the tick of the use)
      const r = await ctx.call<Placed>('vehicle.place', { item: BOAT_ITEM, for: e.id, inVillage: true }, 20_000)
        .catch((x): Placed => ({ ok: false, reason: (x as Error).message }));
      if (!r.ok || r.id === undefined || !r.uuid) { say(ctx, `the boat did not go down: ${r.reason ?? 'no reply'}`); continue; }
      const placed: Boat = { id: r.id, uuid: r.uuid };
      const at = r.position ?? { ...e.position! };
      villagesOf(world).boat = { uuid: r.uuid, at: under(at), since: now() };
      if (!r.tookIt) {
        say(ctx, 'the villager was not taken in: the boat back up, again');
        const why = await takeBoat(ctx, placed);
        if (why) { boat = placed; return await giveUp(`the boat missed the villager and did not come back up: ${why}`); }
        continue;
      }
      boat = placed;
      // the way home from where the boat came down
      const plan = t.plan({ x: at.x, z: at.z, level: at.y });
      if (!plan.ok) return await giveUp(`no boat way home from where the boat came down at ${fmt(at)}: ${plan.why}`);
      route = plan.legs;
      pos = at;
    }
    if (!boat || !route || !pos) return await giveUp('the boat could not be put down against the villager');
    if (ctx.signal.aborted) throw new Error('aborted');
    // the time home judged again from where the boat is, the villager in it: too little, it is let out here, in its own village
    const needHome = homeMs(pos, route);
    if (left() < needHome) return await giveUp(`not enough of the run left to bring the villager home (need ${secs(needHome)} s, ${secs(left())} s left)`);
    const m = await ctx.call<Reply & { controlling?: boolean }>('vehicle.mount', { id: boat.id, uuid: boat.uuid }, 15_000).catch((x): Reply & { controlling?: boolean } => ({ ok: false, reason: (x as Error).message }));
    if (!m.ok) return await giveUp(`could not get into the boat: ${m.reason ?? 'no reply'}`);
    if (!m.controlling) return await giveUp('in the boat, but not in the front seat (not steering)');
    say(ctx, `in the boat with the villager (${e.id}): home in ${route.length} leg(s)`);

    // the drive home, leg by leg, to the stop outside the fence
    const drive = async (to: { x: number; z: number }, within: number, what: string): Promise<string | undefined> => {
      if (ctx.signal.aborted) throw new Error('aborted');
      const at = await ridingOf(ctx);
      const p = at?.position;
      const dist = p ? horiz(p, to) : 0;
      const ms = Math.max(20_000, Math.min(15 * MINUTE, Math.round(dist / BOAT_PACE * 1500) + 10_000, Math.max(20_000, left())));
      drove = true;
      const r = await ctx.call<{ ok: boolean; reason?: string; at?: Pos; seconds?: number }>('vehicle.drive', { to, within, timeoutMs: ms, maxDrop: MAX_DROP, maxOff: 3 }, ms + 15_000)
        .catch(x => ({ ok: false, reason: (x as Error).message, at: undefined, seconds: undefined }));
      // (where the boat is now: a move stopped from outside says where it left it)
      const kept = villagesOf(world).boat;
      if (kept && r.at && Number.isFinite(r.at.x) && Number.isFinite(r.at.y) && Number.isFinite(r.at.z)) kept.at = under(r.at);
      if (ctx.signal.aborted) throw new Error('aborted');
      if (r.ok) { say(ctx, `${what}: there in ${Math.round(r.seconds ?? 0)} s`); return undefined; }
      return `the drive ${what} stopped: ${r.reason ?? 'no reply'}${r.at ? ` at ${fmt(r.at)}` : ''}`;
    };
    let n = 0, replans = 0;
    while (route.length) {
      if (ctx.signal.aborted) throw new Error('aborted');
      if (enough()) return await giveUp('the run\'s time ran out on the way home');
      const at = await ridingOf(ctx);
      if (!at?.position) return await giveUp('no longer in the boat');
      const from: BoatAt = { x: at.position.x, z: at.position.z, level: at.position.y };
      const leg = route[0];
      // judged again from where the boat is (it stops within a block or so of a turn, not on it)
      if (!checkLeg(ground, from, leg, zones).ok) {
        if (++replans > 5) return await giveUp(`the way home kept failing from ${fmt(at.position)}`);
        await yieldNow();
        const again = t.plan(from);
        if (!again.ok) return await giveUp(`no boat way home from ${fmt(at.position)}: ${again.why}`);
        route = again.legs;
        continue;
      }
      const last = route.length === 1;
      const stopped = await drive(leg, last ? 0.5 : 1.2, last ? `to the yard's fence at ${fmt(leg)}` : `leg ${++n} to ${fmt(leg)}`);
      if (stopped) return await giveUp(stopped);
      route = route.slice(1);
    }

    // the yard: the fence's posts dug from the boat, through, the hall's wall dug, into the room. Each opening's leg
    // judged again from where the boat stopped (within half a block of its stop: off the opening's middle, it would catch
    // a post of the 3-wide gap), before anything is dug
    const throughFrom = async (to: { x: number; z: number }, what: string): Promise<string | undefined> => {
      const at = (await ridingOf(ctx))?.position;
      if (!at) return 'no longer in the boat';
      const leg = checkLeg(ground, { x: at.x, z: at.z, level: at.y }, to);
      return leg.ok ? undefined : `the boat stopped where its way ${what} does not hold, at ${fmt(at)}: ${leg.why} at ${fmt(leg.at)}`;
    };
    const offFence = await throughFrom(entry.front, 'through the fence');
    if (offFence) return await giveUp(offFence);
    for (const o of t.fence) {
      const why = await digOut(ctx, o.at, o.block);
      if (why) return await giveUp(`the fence did not come out: ${why}`);
    }
    say(ctx, `the fence open at ${t.fence.filter(o => o.at.y === entry.level).map(o => fmt(o.at)).join(', ')}`);
    const through = await drive(entry.front, 0.5, `through the fence to the hall at ${fmt(entry.front)}`);
    if (through) return await giveUp(through);
    const offWall = await throughFrom(entry.inside, 'into the hall');
    if (offWall) return await giveUp(offWall);
    for (const o of t.wall) {
      const why = await digOut(ctx, o.at, o.block);
      if (why) return await giveUp(`the hall's wall did not come out: ${why}`);
    }
    say(ctx, `the hall's panel open at ${fmt(t.wall[0].at)} (${t.wall.length} blocks)`);
    const into = await drive(entry.inside, 0.8, 'into the hall');
    if (into) return await giveUp(into);
    // out, the boat broken (the villager stands where it was), the wall put back from inside before it can wander out
    const deeper = { x: entry.inside.x - entry.dir[0] * 4, z: entry.inside.z - entry.dir[1] * 4 };
    if (ctx.signal.aborted) throw new Error('aborted');
    const off = await ctx.call<{ ok: boolean; reason?: string }>('vehicle.dismount', { toward: deeper }, 15_000).catch(x => ({ ok: false, reason: (x as Error).message }));
    if (!off.ok) return await giveUp(`could not get out in the hall: ${off.reason ?? 'no reply'}`);
    await pause(500);
    const took = await takeBoat(ctx, boat);
    if (took) say(ctx, `the boat not taken up: ${took}`);
    else boat = undefined;
    say(ctx, `the villager (${e.id}) let out in the hall; the panel back`);
    // (two in from the panel's middle column: every cell of the opening within reach)
    const c = t.wall[Math.floor(t.wall.length / 4)].at;
    const stand = { x: c.x - entry.dir[0] * 2, y: c.y, z: c.z - entry.dir[1] * 2 };
    await ctx.call('goto', { ...stand, range: 1, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
    const inWall = (o: Opened) => t.wall.some(w => w.at.x === o.at.x && w.at.y === o.at.y && w.at.z === o.at.z);
    const wallBack = await closeUp(ctx, inWall);
    // out by the hall's gate (villagers open no gate), then the fence back
    if (entry.gate) {
      const g = entry.gate;
      const gside = g.z === entry.hall.z ? [0, -1] : g.z === entry.hall.z + entry.hall.length - 1 ? [0, 1] : g.x === entry.hall.x ? [-1, 0] : [1, 0];
      await ctx.call('goto', { x: g.x + gside[0] * 2, y: g.y, z: g.z + gside[1] * 2, range: 1, careful: true, timeoutMs: 45_000 }, 60_000).catch(() => undefined);
    }
    const fenceBack = await closeUp(ctx);
    const count = await countHall(ctx, now());
    site.moved = (site.moved ?? 0) + 1;
    const notBack = [...wallBack.left, ...fenceBack.left];
    const text = `moved an unemployed villager from the village at ${fmt(site)} to the hall${count !== undefined ? ` (${count} in it now)` : ''}` +
      `${took ? `; the boat left in the hall (${took})` : ''}${notBack.length ? `; could not put back ${notBack.join(', ')}` : ''}`;
    villagesOf(world).last = { at: now(), text: text.slice(0, 160), moved: true };
    say(ctx, text);
    return { gain: 1, text };
  } finally {
    // stopped from outside with the boat out (a survival goal, the run's timeout, the LLM, autonomy off): out of it and
    // the boat broken back into its item all the same, outside the run, whose own calls are all refused now (else the
    // bot sat on in the boat, the next goal's walk steering it with Baritone's keys, and the villager sat on in it for
    // good). What the move opened stays in villages.open: close up puts it back once the bot is in the yard
    if (ctx.signal.aborted && boat) {
      const b = boat;
      await brainRun.exit(async () => {
        const out = await letGo(ctx, b);
        ctx.progress(`villagers: stopped with the boat out${out.text}`);
      }).catch(() => undefined);
    }
  }
}

/** Break the bot's own boat back into its item (vehicle.take: an axe, never a sword); why not, or undefined. */
async function takeBoat(ctx: GoalContext, boat: Boat): Promise<string | undefined> {
  const r = await ctx.call<{ ok: boolean; reason?: string }>('vehicle.take', { id: boat.id, uuid: boat.uuid }, 30_000).catch(x => ({ ok: false, reason: (x as Error).message }));
  if (r.ok) { delete villagesOf(ctx.world).boat; return undefined; }
  return r.reason ?? 'no reply';
}

/**
 * Giving up with the boat out: out of it if the bot sits in it (onto land, the way home if it can), the boat broken
 * back into its item (the villager steps out where it was: left there, unharmed). Says what it left behind, and
 * whether the boat is its item again.
 */
async function letGo(ctx: GoalContext, boat: Boat | undefined): Promise<{ text: string; taken: boolean }> {
  let said = '';
  const seat = await ridingOf(ctx);
  // (where the boat is: the villager steps out there)
  const out = boat ? seat?.position ?? villagesOf(ctx.world).boat?.at : undefined;
  if (seat) {
    const home = ctx.s.home ?? ctx.s.position;
    let r = await ctx.call<{ ok: boolean; reason?: string }>('vehicle.dismount', { toward: { x: home.x, z: home.z } }, 15_000).catch(x => ({ ok: false, reason: (x as Error).message }));
    if (!r.ok) r = await ctx.call<{ ok: boolean; reason?: string }>('vehicle.dismount', { force: true }, 15_000).catch(x => ({ ok: false, reason: (x as Error).message }));
    if (!r.ok) said += `; still in the boat (${r.reason ?? 'no reply'})`;
    await pause(500);
  }
  if (!boat) return { text: said, taken: true };
  const where = out && seat ? out : out ? { ...out, y: out.y + 1 } : await here(ctx);
  const why = await takeBoat(ctx, boat);
  said += why ? `; the boat left at ${fmt(where)} (${why})` : `; the villager let out at ${fmt(where)}, the boat taken back up`;
  return { text: said, taken: !why };
}

// ------------------------------------------------------------------------------------------------ close up

/**
 * What a move dug and a run cut short did not put back (`villages.open`: the hall's wall, the yard's fence, what stood on
 * its posts): put back as soon as the bot is in the yard, whatever the hour and whatever the switch, before anything
 * else of the yard's (just over the stash). Each block from where the bot stands within reach of it, walked to
 * carefully. A block that will not go back stays on the list and is said.
 */
export const closeUpGoal: Goal = {
  name: 'close up',
  priority: 61,
  timeoutMs: 5 * MINUTE,
  retryMs: 5 * MINUTE,
  failHoldMs: 30 * MINUTE,
  // (never worth stopping a run for: the move's own run puts back what it opened as it goes)
  cuts: () => false,
  wants: (s, world) => {
    const open = peekVillages(world).open?.length;
    if (!open || s.sleeping || s.dimension !== 'overworld' || !roundFrom(s, world, 24)) return null;
    return `${open} block(s) of the hall or the fence left open by a villager move`;
  },
  run: async ctx => {
    const r = await closeUp(ctx);
    if (r.left.length && !r.put) throw new Error(`could not put back ${r.left.join(', ')}`);
    return `put back ${r.put} block(s) a villager move left open${r.left.length ? `; not ${r.left.join(', ')}` : ''}`;
  }
};
