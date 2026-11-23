import type { GoalContext, Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { Zone } from './courtesy.js';
import type { CartPlaced, CartState, CartStatus, CartWatched, RailLay, RailPlaced, RailTaken } from '../tools.js';
import { EARTH_MAX, FIRST_BOOST, HEAD, HOP, JOIN_TAIL, earthed, planExtension, railBase, railRoom, shapeOf, type EarthEdit, type RailCell, type RailExtension, type RailPlan, type RailShape, type RailTorch } from './railroute.js';
import { FROM_ZONES, Ground, MAX_DROP, cellOf, checkLeg, footprint, planRoute, zoneNear, type BoatAt, type Entry } from './boatroute.js';
import { HALL_FRESH, HALL_WANTS, JUDGE_V, joinAreas, judgeOnWhole, judgeVillage, movesOn, peekVillages, siteFor, villagesOf, type Seen, type Verdict, type VillageLook, type VillageSite } from './village.js';
import { prepare } from './project.js';
import { CHEST_SPARE, FOOD_TARGET, gatherFood, readyFoodPoints } from './food.js';
import { MIN_WORK, inFence, outByGate, type WorkResult, type WorkTask } from './work.js';
import { clock } from './idlelog.js';
import {
  BOAT_ITEM, BOAT_PACE, PLAYER_SIGHT, VIEWPOINTS, VIEWPOINT_MS, boatIntoHall, closeUp, countHall, digOut, hallWay, letGo, lookVillage, noteVerdict, notFree, playerNow, ridingOf, takeBoat, wayZones, wordOn, yieldNow,
  type Boat, type HallWay
} from './villagemove.js';

/**
 * The rails home (P5e of the progression plan, the user's fallback of Nov 13 when the boat finds no way home from a free
 * village): the line railroute.ts plans, laid over as many runs as the day's light needs, the villager brought home in a
 * minecart, and every block of it taken back up. Behind the `rails` switch (the villager-moves tool's), off as it ships;
 * nothing is laid with the villager moves off either. The bridge's calls are Rails.java's (rail.place, rail.torch,
 * cart.place, cart.status, cart.watch) through the runtime's rails tools (tools.ts lay-rail, take-up-rail,
 * place-minecart: a block laid is the bot's own, and only the bot's own is ever taken up).
 *
 * What the job rests on (the bridge's notes, read in the 26.3 jar):
 * - a rail takes its shape from the rails beside it, never from the hand: the line is laid in its order, each rail next
 *   to the last, and rail.place is told the rail laid before (with the shape it must end with) and the cell laid after,
 *   and refuses what would not come out as planned (or would turn a rail not the bot's own). The days lay it from the
 *   yard's fence outward to the village (the brief's order), so a curve's or a slope's first rail comes right only as
 *   the next one goes down: what each rail ends as with only the rails laid so far is shapeWith's;
 * - the yard's own stretch (from the fence's post in to the brake) is laid on the move's day only, the post opened then
 *   and put back the same run (the homestead's nightly cleanup takes up what stands in the yard that is not its own,
 *   and a gap in the fence is a way in for mobs at night). A move that does not go leaves it for `close up`;
 * - the server runs the old minecart rules (the minecart_improvements experiment is a world's at its creation): a
 *   moving empty cart takes the first mob it runs into at 0.1 a tick or more, none still. A player in a still cart barely
 *   moves it, so the launch's torch is the only start: the cart off the stop takes the villager standing on the pickup
 *   (brought to it by boat from wherever it stands in its village: the pickup is fixed where one stood at plan time, and
 *   villagers keep round their village's middle) and rolls home onto the brake;
 * - the bot goes home on foot along the line behind the cart (not in a second cart: one put on the lit launch leaves
 *   at once, too fast to board, and the bridge places nothing while riding, so the trigger could not be taken up and
 *   put back for it). Behind it the cart is always ahead, and past the server's simulation distance it waits for the bot
 *   to come near (cart.status says the distance), never behind a bot that took up its rails;
 * - at the brake the fence's post goes back first (the yard shut), then the cart is broken (the villager steps out where
 *   it sat) and the boat move's own last part takes it into the hall (villagemove.ts boatIntoHall: the yard way F7 built,
 *   the hall's panel opened from the boat and put back). A boat that cannot take it leaves the villager in the shut yard
 *   (said, moves off); one that took it but stops on the way leaves it seated in the boat, never loose.
 *
 * Every block put down is written into `world.rails.line.laid` before it goes down (as villages.open is before a dig),
 * so a run cut short, a restart, or a give-up always takes all of it back up: the take-up walks the record, not the plan.
 * An extension's earthworks (the user's of Nov 21: the ground levelled by the villager) are written into
 * `world.rails.line.earth` with it, each cut with the block it takes out, before any is made; the take-up takes the
 * fills up and puts the cut blocks back.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The job's whole budget: a line older than this (planned a real day ago, laid or not) is given up and taken up. */
export const MAX_AGE = 72 * HOUR;
/** Runs in a row stopped by something unexpected on the line (a cell not as read, a player near) before it is given up. */
export const STOPS = 2;
/** Tries at getting the villager into the cart (it wanders off the pickup, the cart misses it). */
export const MOVE_TRIES = 3;
/**
 * Move runs that found nothing wrong but no villager to take (none in the village, none a boat way reached the fixed
 * pickup from, the village not judged free that day): not stops, but the line is given up after this many all the same,
 * each of them having opened the fence and walked the line.
 */
export const MISSES = 4;
/**
 * A free word on the village seen whole this recently holds on a move day whose look saw only part of it (freshFree):
 * the move day's run has the time for one or two viewpoints at most once out along the line. A day (live, Nov 22: at 6 h
 * the look-only days and the move days took turns, a look seeing 114 of 121 chunks a wait, and the move slipped a
 * run each time; the user's of Nov 20, "the bot doesn't need to be this careful"); the partial look still stops the
 * move for a player by or a villager named. Three days since Nov 23 (MAX_AGE, the line's own life): past a day the
 * rung wanted a look-only day again, 9.3 min of the workday's 9.6, and no morning gave it that.
 */
export const FRESH_FREE = 72 * 60 * 60_000;
/** Runs a block of the line would not be reached for the take-up (not loaded, out of reach) before it is left, said. */
export const UP_TRIES = 3;

/** Cells read and looked at together as the bot goes along the line; a look round for players with each. */
const STRETCH = 12;
/** A player this near the bot stops the laying for the day (courtesy: nothing put down by anyone at work). */
export const PLAYER_NEAR = 32;
/** The walks along the line: a stop every this many rails. */
const WALK_EVERY = 24;
/** The longest walk leg out to the line's far end. */
const LEG = 48;
/** What the look round the village needs, and the pickup's hop and the cart's start. */
const LOOK_MS = 60_000;
// (90 s: live, Nov 22, a villager 42 off the pickup needed a 62 s hop, 58 s left; the move day's look is made in
// passing on the way out, so its LOOK_MS is not in the move's day need: the time is the hop's)
const PICKUP_MS = 90_000;
/** The yard's stretch laid and the fence's post opened, before the move's walk out. */
const YARD_OPEN_MS = 40_000;
/** Of the move's time at the village, what the cart's start is kept (the hop to the pickup may take the rest of the run). */
const CART_MS = 30_000;
/** The boat's part in the yard, and the yard's stretch laid and the post opened before the move goes out. */
const YARD_MS = 150_000;
/** How long a cart that took the villager is given to come to rest on the brake once the bot is at the fence. */
const BRAKE_WAIT = 30_000;
/** Kept in hand for the walk home from where the work stopped. */
const MARGIN = 15_000;

export type RailItem = 'rail' | 'powered_rail' | 'redstone_torch' | 'cobblestone';
/** The job's stages: the bill to make, the line being laid, the line whole (the move next), the move under way, taking it all up. */
export type RailStage = 'bill' | 'laying' | 'whole' | 'moving' | 'taking up';
const STAGES: readonly RailStage[] = ['bill', 'laying', 'whole', 'moving', 'taking up'];

/** One rails home job, as kept in brain.json (world.rails.line): the plan, what is down, where it stands. */
export interface RailLine {
  /** planned (real ms) */
  at: number;
  /** the village it serves (its site's place when planned), and its area as the judge saw it (its own builds meet it) */
  site: Pos;
  area?: { x1: number; z1: number; x2: number; z2: number };
  /** the villager it was planned from, where it stood, the pickup's rail */
  villager: number;
  from: Pos;
  pickup: Pos;
  /** the plan (railroute.ts): the launch's stop, the rails from the launch (0) to the brake, the torches, the yard's stretch */
  stop: { at: Pos; placed: boolean };
  cells: RailCell[];
  torches: RailTorch[];
  yard: number;
  /** the fence's post and what stood on it, opened on the move's day and put back */
  opens: { at: Pos; block: string }[];
  /** the boat's way into the hall the plan came in by (boatroute.ts entryOf or yardEntry) */
  entry: Entry;
  stage: RailStage;
  /**
   * every block the job put down and has not taken back up, written before it goes down; `unsure`: its lay had no answer
   * and the read after failed too (the client dropped), so it may be down: kept, and read again before it counts
   */
  laid: { at: Pos; item: RailItem; unsure?: true }[];
  /** the laying runs so far */
  runs: number;
  /** runs in a row stopped by something unexpected, and the last such */
  stops?: number;
  stopWhy?: string;
  /** move runs that found no villager to take (MISSES), and the last one's why */
  misses?: number;
  missWhy?: string;
  /** the take-up's runs that did not reach a block, by its place (UP_TRIES) */
  upTries?: Record<string, number>;
  /** the last run's span: a death in it gives the job up */
  run?: { at: number; end?: number };
  /** the last death seen against this line */
  deathSeen?: number;
  /** the yard's stretch laid and the post opened (the move's day) and not all taken back up yet */
  yardOpen?: boolean;
  /** the bot's own cart on the line (cart.place's uuid names it after a restart) */
  cart?: { uuid: string; id?: number };
  /**
   * a cart being put on the launch, written before cart.place is asked and cleared once its answer names it (`cart`):
   * a run cut short, a kill or a lost reply as it goes down leaves it found there by its place (findCartAt)
   */
  cartAt?: Pos;
  /** the villager taken out of its village in the cart (a give-up after it switches the moves off) */
  villagerOut?: number;
  /** the villager the cart is launched for, written before the trigger goes down (a move cut short names its rider by it) */
  aimed?: number;
  /** close up's last look at a cart out that was not at rest on the brake (the post left open for it): not again for a while */
  postLook?: number;
  /** given up (or done): why, while it is taken up */
  why?: string;
  /** the villager made it into the hall */
  moved?: true;
  /** blocks of it that would not come up (said; not the bot's own any more, someone's now): left */
  left?: string[];
  /**
   * the line extended into the village (the user's of Nov 21: its villagers uphill of a pickup no boat climbs to): the
   * last extension's join (the old launch's cell), its new pickup, its rails (the first `rails` of `cells`), and how many
   */
  extended?: { at: number; from: Pos; to: Pos; rails: number; powered: number; times: number };
  /**
   * the extensions' earthworks (railroute.ts earthFor: the head levelled by the villager, a step of the boat's hop, a
   * climb of more than a block a block): every cut with the block it took out, every fill (cobblestone) with what stood
   * there, written in with the extension before any of it is made; `done` once made. The take-up removes the fills and
   * puts the cut blocks back (bottom up, the same kind from the pockets or the chests: a grass block comes back as dirt),
   * walking the record as it does the rails'
   */
  earth?: (EarthEdit & { done?: true })[];
}

/** Kept per world (world.rails): the job under way, and the last one's end. */
export interface RailsMemory { line?: RailLine; last?: { at: number; text: string } }

/** The rails switch (the villager-moves tool's `rails`): a line is laid only while it is true, off as it ships. */
export const railsOn = (world: WorldMemory): boolean => world.railsHome === true;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPos = (p: unknown): p is Pos => isObj(p) && fin(p.x) && fin(p.y) && fin(p.z);

/** A line as brain.json may hold it, sound enough to be worked (a damaged one is no line: nothing in the gates may throw). */
function sound(l: unknown): l is RailLine {
  if (!isObj(l)) return false;
  const x = l as Partial<RailLine>;
  return fin(x.at) && Array.isArray(x.cells) && x.cells.length > 2 && x.cells.every(isPos) && Array.isArray(x.torches) && x.torches.every(t => isObj(t) && isPos(t.at) && isPos(t.lights))
    && Array.isArray(x.laid) && x.laid.every(b => isObj(b) && isPos(b.at)) && fin(x.yard) && x.yard >= 1 && x.yard < x.cells.length
    && typeof x.stage === 'string' && STAGES.includes(x.stage) && isObj(x.entry) && isObj(x.stop) && isPos(x.stop.at) && isPos(x.site) && isPos(x.pickup)
    && Array.isArray(x.opens) && fin(x.runs) && (x.earth === undefined || (Array.isArray(x.earth) && x.earth.every(w => isPos(w) && (w.op === 'cut' || w.op === 'fill') && typeof w.was === 'string')));
}

/** The line under way, read only (the gates): undefined for none, or one brain.json holds damaged. */
export function peekLine(world: WorldMemory): RailLine | undefined {
  const l = world.rails?.line;
  return sound(l) ? l : undefined;
}

const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
const same = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => a.x === b.x && a.y === b.y && a.z === b.z;
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const fmt = (p: { x: number; y?: number; z: number }) => `(${Math.floor(p.x)}, ${p.y === undefined ? '' : `${Math.floor(p.y)}, `}${Math.floor(p.z)})`;
const idOf = (state: string) => state.replace(/^minecraft:/, '').replace(/\[.*$/, '');
const pause = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
const say = (ctx: GoalContext, text: string) => ctx.progress(`rails: ${text}`);
const aborted = (ctx: GoalContext) => { if (ctx.signal.aborted) throw new Error('aborted'); };

/** The last rail outside the yard's fence (the cell the days lay first; the yard's stretch, from the post in, follows it). */
export const goalOf = (line: Pick<RailLine, 'cells' | 'yard'>): number => line.cells.length - line.yard - 1;
const itemOf = (c: RailCell): 'rail' | 'powered_rail' => (c.kind === 'rail' ? 'rail' : 'powered_rail');
const triggerOf = (line: RailLine): RailTorch | undefined => line.torches.find(t => t.trigger);
/** The rails of the line laid now, by index (the record: a block of the plan's item there; another is a stray). */
function laidCells(line: RailLine): Set<number> {
  const keys = new Set(line.laid.filter(b => planItemAt(line, b.at) === b.item).map(b => key(b.at)));
  const out = new Set<number>();
  line.cells.forEach((c, i) => { if (keys.has(key(c))) out.add(i); });
  return out;
}
/** What the plan puts at `p` (a rail of the line, a torch, the stop), or undefined: none of it. */
function planItemAt(line: RailLine, p: Pos): RailItem | undefined {
  const c = line.cells.find(q => same(q, p));
  if (c) return itemOf(c);
  if (line.torches.some(t => same(t.at, p))) return 'redstone_torch';
  if (line.stop.placed && same(line.stop.at, p)) return 'cobblestone';
  return undefined;
}
/**
 * Blocks of the record the plan no longer has there (an extension's: the old launch's powered rail where a plain rail
 * goes now, the old stop's cobblestone, the old trigger): taken up before the laying goes on, and by the take-up.
 */
export const straysOf = (line: RailLine): RailLine['laid'] => line.laid.filter(b => planItemAt(line, b.at) !== b.item);
/** The places of the record that stand as the plan has them (laid and counted). */
const fitKeys = (line: RailLine, sureOnly = false): Set<string> => new Set(line.laid.filter(b => (!sureOnly || !b.unsure) && planItemAt(line, b.at) === b.item).map(b => key(b.at)));
const isLaid = (line: RailLine, p: Pos) => line.laid.some(b => same(b.at, p));
const record = (line: RailLine, at: Pos, item: RailItem) => { if (!isLaid(line, at)) line.laid.push({ at: { x: at.x, y: at.y, z: at.z }, item }); };
const forget = (line: RailLine, at: Pos) => { line.laid = line.laid.filter(b => !same(b.at, at)); };
/** A block kept in the record whose lay had no answer and whose read after failed (it may be down or not). */
const unsureAt = (line: RailLine, at: Pos) => line.laid.some(b => same(b.at, at) && b.unsure);
/** One block of the line taken up by the rails tools, told what the record says the bot put there (nothing else is dug). */
const takeUp = (ctx: GoalContext, line: RailLine, at: Pos): Promise<RailTaken> => ctx.rails!.takeUp(at, line.laid.find(b => same(b.at, at))?.item)
  .catch((x: Error): RailTaken => ({ ok: false, dug: false, reason: x.message }));
/** The village's own ground (its area as judged, grown by the 16 the line keeps off others' builds): rails go down there as `inVillage`. */
const inVillage = (line: RailLine, p: { x: number; z: number }) => !!line.area
  && p.x >= line.area.x1 - FROM_ZONES && p.x <= line.area.x2 + FROM_ZONES && p.z >= line.area.z1 - FROM_ZONES && p.z <= line.area.z2 + FROM_ZONES;

/**
 * What the rail at `i` ends as with only the rails `has` (pure): the plan's shape with both its rails beside it, the
 * shape toward the one (up to it when it is higher, else straight on its way) with one, none to say with none. The game
 * turns a rail toward the rails beside it that are not already joined to two (RailState), and the plan never puts one
 * rail beside another but the next and the last (railroute.ts touching): so the rail laid first of a curve runs
 * straight toward the next until the one after it is down, and the brief's laying from the yard outward meets every
 * curve and slope from its far side.
 */
export function shapeWith(line: Pick<RailLine, 'cells'>, i: number, has: (j: number) => boolean): RailShape | undefined {
  const c = line.cells[i];
  const by = [i - 1, i + 1].filter(j => j >= 0 && j < line.cells.length && has(j)).map(j => line.cells[j]);
  if (by.length === 2) return c.shape;
  if (by.length === 1) return shapeOf(by[0], c);
  return undefined;
}

/**
 * The lay-rail call for the rail at `i` (pure): `laid` the rails down before it, `next` the cell laid right after it (the
 * plan's neighbour on the far side; none at the line's end). The rail before (`prev`) is the one of its neighbours
 * already down, with the shape it must end with once this one joins it; this one's `shape` is what it ends as once
 * `next` is down too. A gap mended between two rails already down names both.
 */
export function layArgs(line: RailLine, i: number, laid: ReadonlySet<number>, next?: number): RailLay {
  const c = line.cells[i];
  const after = new Set(laid);
  after.add(i);
  const prevAt = [i + 1, i - 1].find(j => laid.has(j) && j !== next);
  const nextAt = next ?? [i - 1, i + 1].find(j => laid.has(j) && j !== prevAt);
  const shape = shapeWith(line, i, j => after.has(j) || j === nextAt);
  const prevShape = prevAt === undefined ? undefined : shapeWith(line, prevAt, j => after.has(j));
  return {
    at: { x: c.x, y: c.y, z: c.z }, item: itemOf(c),
    ...(shape ? { shape } : {}),
    ...(prevAt !== undefined && prevShape ? { prev: { x: line.cells[prevAt].x, y: line.cells[prevAt].y, z: line.cells[prevAt].z, shape: prevShape } } : {}),
    ...(nextAt !== undefined ? { next: { x: line.cells[nextAt].x, y: line.cells[nextAt].y, z: line.cells[nextAt].z, item: itemOf(line.cells[nextAt]) } } : {}),
    ...(inVillage(line, c) ? { inVillage: true } : {})
  };
}

/** One thing a run puts down: a rail of the line, a torch beside one, the launch's stop; or a stray of the record it takes up. */
export type Step = { kind: 'cell'; i: number } | { kind: 'torch'; t: RailTorch } | { kind: 'stop' } | { kind: 'stray'; at: Pos; item: RailItem };
const torchesFor = (line: RailLine, i: number): RailTorch[] => line.torches.filter(t => !t.trigger && same(t.lights, line.cells[i]));
export const stepAt = (line: RailLine, s: Step): Pos => (s.kind === 'cell' ? line.cells[s.i] : s.kind === 'torch' ? s.t.at : s.kind === 'stray' ? s.at : line.stop.at);
const stepItem = (line: RailLine, s: Step): RailItem => (s.kind === 'cell' ? itemOf(line.cells[s.i]) : s.kind === 'torch' ? 'redstone_torch' : s.kind === 'stray' ? s.item : 'cobblestone');
const stepWord = (line: RailLine, s: Step): string => (s.kind === 'cell' ? `${stepItem(line, s)} ${fmt(line.cells[s.i])}` : s.kind === 'torch' ? `redstone torch ${fmt(s.t.at)}`
  : s.kind === 'stray' ? `the ${s.item} ${fmt(s.at)} (no longer the plan's)` : `the stop ${fmt(line.stop.at)}`);

/**
 * What the laying days put down, in their order (pure): from the last rail outside the fence out to the launch, each
 * torch as the rail it lights is down, the launch's stop last. Not the yard's stretch (the move's day), nor the trigger
 * (the move's start).
 */
export function outwardSteps(line: RailLine): Step[] {
  const out: Step[] = [];
  for (let i = goalOf(line); i >= 0; i--) {
    out.push({ kind: 'cell', i });
    for (const t of torchesFor(line, i)) out.push({ kind: 'torch', t });
    if (i === 0 && line.stop.placed) out.push({ kind: 'stop' });
  }
  return out;
}
/** The yard's stretch, the move's day: from the fence's post in to the brake's last rail (pure). */
export function yardSteps(line: RailLine): Step[] {
  const out: Step[] = [];
  for (let i = goalOf(line) + 1; i < line.cells.length; i++) {
    out.push({ kind: 'cell', i });
    for (const t of torchesFor(line, i)) out.push({ kind: 'torch', t });
  }
  return out;
}

/** The rails of the line down, of how many. */
export const laidOf = (line: RailLine): { rails: number; of: number } => ({ rails: laidCells(line).size, of: line.cells.length });

/** Where the next day's laying begins (the first step not down yet), or the launch when every one is. */
function frontier(line: RailLine): Pos {
  const keys = fitKeys(line, true);
  const s = outwardSteps(line).find(x => !keys.has(key(stepAt(line, x))));
  return s ? stepAt(line, s) : line.cells[0];
}
/** The farthest block of it down from home (the take-up walks out to it). */
function farthest(line: RailLine, home: { x: number; z: number }): number {
  return [...line.laid.map(b => b.at), ...(line.earth ?? [])].reduce((m, b) => Math.max(m, horiz(b, home)), 0);
}

/**
 * What the move needs of the day, ms (pure): out to the head along the line at a walk, the look round the village,
 * the hop and the cart's start, home along the line behind it, the yard (its stretch laid, the boat into the hall).
 */
export function railMoveNeedMs(line: RailLine, home: { x: number; z: number }): number {
  const out = Math.max(horiz(line.cells[0], home), (line.cells.length - line.yard) * 0.8);
  // (out at a walk, the look, then what the run itself asks to have left at the village, moveRest: live, Nov 22, a
  // 351-rail line set out on this estimate's old sum and turned back at the village, "too little of the run left")
  // (and the yard's stretch laid and the fence opened before the walk out: 33 s on Nov 23)
  return Math.round(out / 3 * 1000) + YARD_OPEN_MS + moveRest(line, home) + MARGIN;
}

/**
 * What a look-only day needs of the day, ms (pure): out to the head along the line and back at a walk, and the look
 * round the village at its fullest (LOOK_MS and VIEWPOINTS walks of VIEWPOINT_MS). The rung's day check (work.ts
 * lateFor) holds this against the daylight left, so such a day sets out early or waits for the next morning.
 */
export function railLookNeedMs(line: RailLine, home: { x: number; z: number }): number {
  const out = Math.max(horiz(line.cells[0], home), (line.cells.length - line.yard) * 0.8);
  return Math.round(2 * out / 3 * 1000) + LOOK_MS + VIEWPOINTS * VIEWPOINT_MS;
}

// ------------------------------------------------------------------------------------------------ the gates

/** The village the line serves, as remembered now (read only), or undefined. */
function siteNowOf(world: WorldMemory, line: RailLine): VillageSite | undefined {
  return siteFor(peekVillages(world).sites, line.site);
}

/**
 * Why the line is given up now and taken back up (pure), or undefined: given up already (or done), the rails switch
 * off, the job's budget spent (a day old), stopped by something unexpected run after run (a hold), the village gone
 * from memory or someone's now, the hall full (no move under way).
 */
export function giveUpWhy(s: Pick<Snapshot, 'now'>, world: WorldMemory, line: RailLine): string | undefined {
  if (line.stage === 'taking up') return line.why ?? 'given up';
  if (line.stage === 'moving') return undefined;
  if (!railsOn(world)) return 'the rails switch is off';
  if (s.now - line.at > MAX_AGE) return `the line is ${Math.round((s.now - line.at) / HOUR)} h old (${MAX_AGE / HOUR} h at the most)`;
  if ((line.stops ?? 0) >= STOPS) return `stopped ${line.stops} runs in a row: ${line.stopWhy ?? 'something unexpected'}`;
  if ((line.misses ?? 0) >= MISSES) return `the move not made on ${line.misses} runs: ${line.missWhy ?? 'no villager to take'}`;
  const site = siteNowOf(world, line);
  if (!site) return `the village at ${fmt(line.site)} is no longer known`;
  if (site.judged?.kind === 'theirs') return `the village at ${fmt(line.site)} is someone's now: ${site.judged.why}`;
  const h = peekVillages(world).hall;
  if (h && s.now - h.at < HALL_FRESH && h.count >= HALL_WANTS) return `the hall has ${h.count} villagers (${HALL_WANTS} wanted)`;
  return undefined;
}

/**
 * The `rails` rung (worktasks.ts LADDER, rank 4.3: a line on the ground comes before the villagers rung's searches).
 * One variant at a time, by the stage: `bill` (made at home), `lay` (a day's laying, out from the fence), `move` (the
 * line whole), `take up` (given up or done: whatever the switches, it never leaves a block out there). Nothing but the
 * take-up with the villager moves off; never in the rain for the move; the gates only read.
 */
export const railsTask: WorkTask = {
  name: 'rails',
  rank: 4.3,
  reach: 'far',
  room: 'trip',
  budgetMs: 12 * MINUTE,
  // (every run keeps its own way home in its clock, the move's home behind the cart (moveRest), the laying's keep(p):
  // the day's budget is not cut by a walk back besides. Live, Nov 22: the 351-rail move turned back at the village
  // twice, 72 s short, the walk home counted twice)
  backPace: 3,
  variants: (s, world) => {
    const line = peekLine(world);
    if (!line) return [];
    const home = s.home ?? s.position;
    if (giveUpWhy(s, world, line)) {
      const d = farthest(line, home);
      return [{ id: 'take up', dist: Math.round(d), needMs: Math.round(2 * d / 3 * 1000) + MIN_WORK.far }];
    }
    // (a move cut short goes on, or gives up, whatever the moves' switch: the cart may hold a villager)
    if (line.stage === 'moving') return [{ id: 'move', dist: Math.round(horiz(line.cells[0], home)), needMs: MIN_WORK.far }];
    if (!movesOn(world)) return [];
    if (line.stage === 'bill') return [{ id: 'bill', dist: 0, needMs: MIN_WORK.far }];
    if (line.stage === 'laying') {
      const d = horiz(frontier(line), home);
      return [{ id: 'lay', dist: Math.round(d), needMs: Math.round(2 * d / 3 * 1000) + MIN_WORK.far }];
    }
    // (no free word seen whole within FRESH_FREE: a look-only day first, early in the day: it needs the whole look round)
    if (!freeToMove(world, line, s.now)) return [{ id: 'look', dist: Math.round(horiz(line.cells[0], home)), needMs: railLookNeedMs(line, home) }];
    // (the move's yard part, at home inside the fence, may run into the evening: YARD_MS of it, up to night, work.ts
    // DUSK_MAX. Live, Nov 23: the 375-rail move needed 8.5 min of the workday's 9.6, and no morning gave it that)
    return [{ id: 'move', dist: Math.round(horiz(line.cells[0], home)), needMs: railMoveNeedMs(line, home), duskMs: YARD_MS }];
  },
  none: (s, world) => (!peekLine(world) ? { cause: 'unneeded', text: 'rails: no line to lay' }
    : { cause: 'unneeded', text: 'rails: villager moves are off: the line waits' }),
  ready: (s, world, variant) => {
    const line = peekLine(world);
    if (variant !== 'move' || !line || line.stage === 'moving') return null;
    if (s.raining || s.thundering) return { cause: 'late', text: 'raining: no villager is moved in the rain' };
    const open = (peekVillages(world).open ?? []).filter(o => !held(line, o.at)).length;
    if (open) return { cause: 'unneeded', text: `${open} block(s) of the hall or the fence left open by a move: close up first` };
    return null;
  },
  run: async (ctx, variant, budgetMs, now) => {
    const line = peekLine(ctx.world);
    if (!line) return { gain: 0, text: 'no rails line any more', mark: 'forget' };
    if (!ctx.rails) return { gain: 0, text: 'no rails tools in this runtime', untried: true };
    const began = now();
    const clk: Clk = { now, began, budgetMs, left: () => began + budgetMs - now() };
    line.run = { at: began };
    try {
      if (variant === 'take up') {
        const why = giveUpWhy({ now: began }, ctx.world, line);
        if (line.stage !== 'taking up') giveUp(ctx, line, why ?? 'given up');
        return await takeUpRun(ctx, line, clk);
      }
      if (variant === 'bill') return await billRun(ctx, line);
      if (variant === 'lay') return await layRun(ctx, line, clk);
      if (variant === 'move') return await moveRun(ctx, line, clk);
      if (variant === 'look') return line.stage === 'whole' ? await lookRun(ctx, line, clk) : { gain: 0, text: `no look-only day with the line ${line.stage}`, untried: true };
      return { gain: 0, text: `no such step: ${variant}`, untried: true };
    } finally {
      if (line.run) line.run.end = now();
    }
  }
};

interface Clk { now: () => number; began: number; budgetMs: number; left: () => number }

/** Given up: everything it put down is taken back up from here on (the take-up variant), and said. */
function giveUp(ctx: GoalContext, line: RailLine, why: string): void {
  line.stage = 'taking up';
  line.why = why.slice(0, 160);
  ctx.save?.();
  say(ctx, `giving up the line: ${why}; everything it put down taken back up from here on`);
}

/**
 * The work queue's housekeeping for the line, once a tick (work.ts workTick, so never in a gate): a death during a
 * rails run gives the job up (the brief's give-ups: the budget, a hold and the hall are the gates', the villager lost
 * the move's). Returns what happened, for the log.
 */
export function railsTick(world: WorldMemory, d: { time: number } | undefined): string[] {
  const line = peekLine(world);
  if (!line || !d || !fin(d.time) || line.stage === 'taking up' || d.time <= (line.deathSeen ?? line.at)) return [];
  line.deathSeen = d.time;
  const r = line.run;
  if (!r || d.time < r.at) return [];
  // (a run whose end was never written, a restart mid-run, ended by its timeout at the latest: a death hours later, on a
  // deep trip, is not the rails run's; the run is closed there)
  // (its budget and the goal's timeout margin: work.ts timeoutOf)
  const end = r.end ?? r.at + railsTask.budgetMs + 2 * MINUTE;
  if (d.time > end + 5_000) {
    if (r.end === undefined) r.end = end;
    return [];
  }
  line.stage = 'taking up';
  line.why = `a death on a rails run (${clock(d.time)})`;
  // (the cart launched for the villager and not accounted for counts as out: it may be rolling home with it)
  const out = line.villagerOut !== undefined || launched(line);
  if (out && movesOn(world)) world.villagerMoves = false;
  return [`rails: giving up the line: ${line.why}; everything it put down taken back up from here on${out ? '; villager moves off (the villager was, or may be, out of its village)' : ''}`];
}

/**
 * The line kept to be laid (villagemove.ts, the boat's way failed and the rails planned with the rails switch on and the
 * moves on): a write, from the move's run. Not when one is under way already (one job at a time).
 */
export function startLine(world: WorldMemory, plan: RailPlan, site: VillageSite, entry: Entry, now: number): RailLine | undefined {
  if (peekLine(world)) return undefined;
  const line: RailLine = {
    at: now, site: { x: site.x, y: site.y, z: site.z }, ...(site.area ? { area: { ...site.area } } : {}),
    villager: plan.villager, from: { ...plan.from }, pickup: { ...plan.pickup },
    stop: { at: { ...plan.stop.at }, placed: plan.stop.placed }, cells: plan.cells.map(c => ({ ...c })), torches: plan.torches.map(t => ({ ...t, at: { ...t.at }, lights: { ...t.lights } })),
    yard: plan.yard, opens: plan.opens.map(o => ({ at: { ...o.at }, block: o.block })), entry: JSON.parse(JSON.stringify(entry)) as Entry,
    stage: 'bill', laid: [], runs: 0
  };
  (world.rails ??= {}).line = line;
  return line;
}

/** The line's opening in the yard's fence, or what stood on it, while its post's rail is down: not close up's to put back (the take-up's). */
export function held(line: RailLine | undefined, at: Pos): boolean {
  if (!line) return false;
  const post = line.cells[goalOf(line) + 1];
  return !!post && line.opens.some(o => same(o.at, at)) && isLaid(line, post);
}
/** The same for close up, from the world (read only). */
export const heldByRails = (world: WorldMemory, at: Pos): boolean => held(peekLine(world), at);

/**
 * The yard's stretch left down with no cart out on the line: close up's to take back up, any hour (a move that did not
 * go, one cut short before its cart went down, a give-up), so the fence is never left open overnight for it. With a
 * cart out in a move cut short (shelter at dusk, the timeout, a restart), only the post's rail: close up takes it up
 * and shuts the fence once the cart rests on the brake (closeRailsYard reads it; one still rolling home is left its
 * way in), the brake and the cart with the villager left for the morning's resumeMove.
 */
/**
 * The cart out with the villager in it, not accounted for: a move under way, or one given up with its cart not found yet
 * (it may still roll home, frozen out on the line past the simulation distance till someone comes near). Its way in, the
 * brake and the post's rail, is left down until it rests on the brake (the post then shut behind it) or is found.
 */
const cartOut = (line: RailLine) => !!line.cart && (line.stage === 'moving' || line.villagerOut !== undefined || line.aimed !== undefined);
/**
 * The cart launched (its trigger tried, `aimed` written before it) and not taken back up: whatever the launch's answer,
 * it may hold the villager it went for (a lost reply, a death in the watch). The yard is held for it, a give-up turns
 * the moves off.
 */
const launched = (line: RailLine) => !!line.cart && line.aimed !== undefined;

/** How long close up leaves the rails' post alone after a look found the cart out not at rest on the brake. */
const POST_LOOK_MS = 10 * MINUTE;
/**
 * The post left open for a cart out (cartOut) that close up is not to look at now: the line given up (the take-up's to
 * shut once the cart is found or let go), or the last look, a while ago, found it not at rest on the brake.
 */
export function railsPostWaits(world: WorldMemory, now: number): boolean {
  const line = peekLine(world);
  if (!line || !cartOut(line)) return false;
  return line.stage === 'taking up' || (line.postLook !== undefined && now - line.postLook >= 0 && now - line.postLook < POST_LOOK_MS);
}

export function railsYardOpen(world: WorldMemory): boolean {
  const line = peekLine(world);
  if (!line || !line.yardOpen) return false;
  if (cartOut(line)) return isLaid(line, line.cells[goalOf(line) + 1]);
  const keys = new Set(line.laid.map(b => key(b.at)));
  const v = peekVillages(world);
  return yardSteps(line).some(st => keys.has(key(stepAt(line, st)))) || (v.open ?? []).some(o => line.opens.some(q => same(q.at, o.at)));
}

// ------------------------------------------------------------------------------------------------ the status

/**
 * brain-status, `Rails home:`: the switch; the line's state (planned, N of M laid, whole, the move, taking up) and the
 * last job's end.
 */
export function railsHomeLine(world: WorldMemory, now: number): string {
  const sw = `Rails home: ${railsOn(world) ? 'on' : 'off'}`;
  const line = peekLine(world);
  const last = world.rails?.last;
  const lastText = last && fin(last.at) && typeof last.text === 'string' ? `; last ${clock(last.at)}: ${last.text}` : '';
  if (!line) return `${sw}; no line${lastText}.`;
  const { rails, of } = laidOf(line);
  const age = Math.round((now - line.at) / MINUTE);
  // (given up by the gates, the take-up next: what the rung offers, not the stage it stopped at)
  const why = line.stage === 'taking up' || line.stage === 'moving' ? undefined : giveUpWhy({ now }, world, line);
  const state = why ? `to be taken up (${why}): ${line.laid.length} block(s) down`
    : line.stage === 'bill' ? `planned: ${of} rails, the bill to make`
    : line.stage === 'laying' ? `${rails} of ${of} laid (${line.runs} run(s))${line.stops ? `, stopped last run: ${line.stopWhy}` : ''}`
    : line.stage === 'whole' ? `whole (${of} rails): the move next${line.yardOpen ? ' (its yard stretch left down: close up takes it back)' : ''}${line.stops ? `; the last move stopped: ${line.stopWhy}` : ''}`
    : line.stage === 'moving' ? `the move under way${line.cart ? ` (the cart ${line.cart.uuid})` : ''}`
    : `taking up (${line.why ?? 'given up'}): ${line.laid.length} block(s) still down${line.left?.length ? `, ${line.left.length} that would not come up` : ''}`;
  const wait = !why && !movesOn(world) && line.stage !== 'taking up' ? ' (villager moves off: it waits)' : '';
  const ext = line.extended && line.stage !== 'taking up' ? `; extended into the village by ${line.extended.rails} rails to the pickup ${fmt(line.extended.to)}` : '';
  const dug = line.earth?.length ? `; ${line.earth.filter(w => w.op === 'cut').length} cut(s) and ${line.earth.filter(w => w.op === 'fill').length} fill(s) of ground in the record (${line.earth.filter(w => w.done).length} made)` : '';
  return `${sw}; the line to the village at ${fmt(line.site)}, planned ${age < 120 ? `${age} min` : `${Math.round(age / 60)} h`} ago: ${state}${wait}${ext}${dug}${lastText}.`;
}

// ------------------------------------------------------------------------------------------------ the bill

/** What is still to go down of the whole line, by item (the bill against what the job laid already). */
export function billLeft(line: RailLine): Record<string, number> {
  const keys = fitKeys(line);
  // (in one order whatever the line: the rails, the powered ones, the torches, the stop, the cart)
  const bill: Record<string, number> = { rail: 0, powered_rail: 0, redstone_torch: 0, cobblestone: 0, minecart: 0 };
  const add = (item: string, n = 1) => { bill[item] += n; };
  line.cells.forEach(c => { if (!keys.has(key(c))) add(itemOf(c)); });
  for (const t of line.torches) if (!keys.has(key(t.at))) add('redstone_torch');
  if (line.stop.placed && !keys.has(key(line.stop.at))) add('cobblestone');
  add('cobblestone', pendingFills(line));
  if (!line.cart) add('minecart');
  for (const item of Object.keys(bill)) if (!bill[item]) delete bill[item];
  return bill;
}

/** The pocket slots in use now (of 36). */
const slotsNow = async (ctx: GoalContext): Promise<number> => {
  const inv = await ctx.call<{ items?: { name: string; count: number; slot?: number }[] }>('inventory').catch(() => undefined);
  return (inv?.items ?? ctx.s.items).filter(it => (it.slot ?? 0) < 36).length;
};
/** The pocket slots the move day keeps free as it carries an extension's rails (the stash cuts any run short at 36). */
const EXT_FREE = 6;
const countsNow = async (ctx: GoalContext): Promise<Map<string, number>> => {
  const inv = await ctx.call<{ items?: { name: string; count: number; slot?: number }[] }>('inventory').catch(() => undefined);
  const m = new Map<string, number>();
  for (const it of inv?.items ?? ctx.s.items) if ((it.slot ?? 0) < 36) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
  return m;
};

/** Each of `need` carried (from the chests, or made: prepare); what is short, said, or undefined. */
async function carry(ctx: GoalContext, need: Record<string, number>): Promise<string | undefined> {
  const short: string[] = [];
  for (const [item, n] of Object.entries(need)) {
    if (n <= 0) continue;
    const left = await prepare(ctx, item, n);
    if (Object.keys(left).length) short.push(`${item} (${Object.entries(left).map(([k, v]) => `${v} ${k}`).join(', ')})`);
  }
  return short.length ? short.join(', ') : undefined;
}

/**
 * The bill made at home (the brief's part 1): every rail, powered rail and redstone torch still to go down, the stop's
 * cobblestone and the minecart, crafted from the chests' iron, gold, redstone and sticks (RECIPES, prepare: raw ore
 * smelted a batch at a time, so a big bill may take a few runs). Made whole, the laying is next; what the stash puts
 * away between runs the day's laying takes out again.
 */
async function billRun(ctx: GoalContext, line: RailLine): Promise<WorkResult> {
  const bill = billLeft(line);
  const before = await countsNow(ctx);
  const short = await carry(ctx, bill);
  const after = await countsNow(ctx);
  const made = Object.keys(bill).reduce((a, k) => a + Math.max(0, (after.get(k) ?? 0) - (before.get(k) ?? 0)), 0);
  const list = Object.entries(bill).map(([k, v]) => `${v} ${k}`).join(', ');
  if (short) {
    const text = `the bill (${list}): short of ${short}; the rest next run`;
    say(ctx, text);
    return { gain: made, text, ...(made ? {} : { mark: 'same' as const }) };
  }
  line.stage = 'laying';
  const text = `the bill made (${list}); the laying next, from the yard's fence out`;
  say(ctx, text);
  return { gain: Math.max(1, made), text };
}

// ------------------------------------------------------------------------------------------------ reading the line

/** The states round some cells (each, the one under and the two over), from world.region; undefined where not read. */
async function readAround(ctx: GoalContext, ps: readonly Pos[]): Promise<(x: number, y: number, z: number) => string | null | undefined> {
  if (!ps.length) return () => undefined;
  const x1 = Math.min(...ps.map(p => p.x)), x2 = Math.max(...ps.map(p => p.x));
  const z1 = Math.min(...ps.map(p => p.z)), z2 = Math.max(...ps.map(p => p.z));
  const y1 = Math.min(...ps.map(p => p.y)) - 1, y2 = Math.max(...ps.map(p => p.y)) + 2;
  const box = { x: x1, y: y1, z: z1, width: x2 - x1 + 1, height: y2 - y1 + 1, length: z2 - z1 + 1 };
  const r = await ctx.call<{ blocks?: (string | null)[] }>('world.region', box, 30_000).catch(() => undefined);
  const blocks = r?.blocks;
  return (x, y, z) => {
    if (!blocks || x < x1 || x > x2 || y < y1 || y > y2 || z < z1 || z > z2) return undefined;
    return blocks[(x - x1) + (z - z1) * box.width + (y - y1) * box.width * box.length];
  };
}

/** A rail's shape as world.region writes its state ("rail[shape=north_south,...]"). */
const shapeIn = (state: string) => /shape=([a-z_]+)/.exec(state)?.[1];
const airy = (state: string | null | undefined) => !!state && cellOf(state).kind === 'open';

/**
 * What stands over the line's rail at `i` where the villager's head passes in the cart (pure on what was read): one
 * block over a level rail, two over a slope (railroute.ts: its eye up to 2.64 over a slope rail's block). A block there
 * is in-wall damage at every pass. What, or undefined (nothing read is no answer).
 */
function overRail(line: RailLine, i: number, at: (x: number, y: number, z: number) => string | null | undefined): string | undefined {
  const c = line.cells[i];
  for (let dy = 1; dy <= (c.shape.startsWith('ascending_') ? 2 : 1); dy++) {
    const st = at(c.x, c.y + dy, c.z);
    if (st !== undefined && !airy(st)) return `${st ? idOf(st) : 'nothing read'} ${dy === 1 ? 'over' : 'two over'} it`;
  }
  return undefined;
}

/**
 * Whether a step not down yet can still go where the plan put it (pure on what was read): room for it, natural ground
 * under it (railroute.ts railBase), and the air over a rail. Why not, or undefined (`unread` where not read).
 */
function notAsRead(line: RailLine, s: Step, at: (x: number, y: number, z: number) => string | null | undefined): string | undefined {
  const p = stepAt(line, s);
  const here = at(p.x, p.y, p.z), below = at(p.x, p.y - 1, p.z);
  if (here === undefined || below === undefined || here === null || below === null) return 'unread';
  if (!railRoom(here)) return `${stepWord(line, s)}: ${idOf(here)} there now`;
  // (the bot's own fill under it, made for it: ground to the plan)
  if (!railBase(below) && !(idOf(below) === 'cobblestone' && isFill(line, { x: p.x, y: p.y - 1, z: p.z }))) return `${stepWord(line, s)}: ${idOf(below)} under it now`;
  const over = s.kind === 'cell' ? overRail(line, s.i, at) : undefined;
  if (over) return `${stepWord(line, s)}: ${over} now`;
  return undefined;
}

// ------------------------------------------------------------------------------------------------ the earthworks

type EarthRec = NonNullable<RailLine['earth']>[number];
/** The earthworks of a column (x, z). */
const earthIn = (line: RailLine, x: number, z: number): EarthRec[] => (line.earth ?? []).filter(w => w.x === x && w.z === z);
/** The cell is one of the record's fills (the bot's cobblestone, made for a rail over it). */
const isFill = (line: RailLine, p: Pos) => (line.earth ?? []).some(w => w.op === 'fill' && same(w, p));
/** The fills not made yet (their cobblestone to carry). */
const pendingFills = (line: RailLine) => (line.earth ?? []).filter(w => w.op === 'fill' && !w.done).length;
const pendingEarth = (line: RailLine) => (line.earth ?? []).some(w => !w.done);
const dropEarth = (line: RailLine, w: EarthRec) => { line.earth = (line.earth ?? []).filter(q => q !== w); if (!line.earth.length) delete line.earth; };

/**
 * What a cut cell is put back with (pure): the block it was where the pockets hold it (what a cut drops without silk
 * touch: a grass block's dirt, stone's cobblestone), else the nearest kind carried; dirt or cobblestone at the last.
 */
const REFILL: Record<string, string[]> = {
  grass_block: ['dirt'], dirt: ['dirt'], coarse_dirt: ['coarse_dirt', 'dirt'], stone: ['stone', 'cobblestone'], andesite: ['andesite', 'cobblestone'],
  diorite: ['diorite', 'cobblestone'], granite: ['granite', 'cobblestone'], gravel: ['gravel', 'sand', 'dirt'], sand: ['sand', 'gravel', 'dirt']
};
export function refillOf(was: string, have: (item: string) => number): string | undefined {
  const id = idOf(was);
  return [...(REFILL[id] ?? [id]), 'dirt', 'cobblestone'].find(i => have(i) > 0);
}

/** A villager (or any mob) standing in the column now (world.entities): no cut or fill under it. */
async function mobInColumn(ctx: GoalContext, x: number, z: number): Promise<Seen | undefined> {
  const round = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 16 }).catch(() => undefined))?.entities ?? [];
  return round.find(e => e.name !== 'player' && e.position && Math.abs(e.position.x - (x + 0.5)) < 0.9 && Math.abs(e.position.z - (z + 0.5)) < 0.9);
}

/**
 * The cuts and fills of a column made, before the block of the line over it goes down (each in the record since the
 * extension was written: applyExtension), in their order: the fills from the bottom up (cobblestone, through the rails
 * tools: the bot's own once down), the cuts from the top down (the rails tools' cut: only the block the record names,
 * never from over it). Read first: a cell no longer as planned stops it. `wait`: a mob stands in the column (the next
 * run goes on there). Why not, or undefined.
 */
async function earthDown(ctx: GoalContext, line: RailLine, x: number, z: number): Promise<{ why: string; wait?: true } | undefined> {
  const todo = earthIn(line, x, z).filter(w => !w.done)
    .sort((a, b) => (a.op === b.op ? (a.op === 'fill' ? a.y - b.y : b.y - a.y) : a.op === 'fill' ? -1 : 1));
  if (!todo.length) return undefined;
  if (!ctx.rails?.cut) return { why: 'no earthworks in this runtime' };
  await walkTo(ctx, { x, y: todo[0].y, z }, 2);
  for (let k = 0; ; k++) {
    const mob = await mobInColumn(ctx, x, z);
    if (!mob) break;
    if (k >= 2) return { why: `a ${mob.name ?? 'mob'} (${mob.id}) standing at ${fmt(mob.position!)}: nothing cut or filled under it`, wait: true };
    await pause(2000);
  }
  const at = await readAround(ctx, todo);
  for (const w of todo) {
    const st = at(w.x, w.y, w.z);
    if (st === undefined || st === null) return { why: `the ground at ${fmt(w)} not read` };
    if (w.op === 'cut' && idOf(st) !== idOf(w.was) && !railRoom(st)) return { why: `${idOf(st)} at ${fmt(w)} where the cut is of ${idOf(w.was)} (not as read when planned)` };
    if (w.op === 'fill' && !railRoom(st)) return { why: `${idOf(st)} at ${fmt(w)} where the fill goes (not as read when planned)` };
  }
  for (const w of todo) {
    aborted(ctx);
    const p = { x: w.x, y: w.y, z: w.z };
    const st = at(w.x, w.y, w.z)!;
    // (a cut already open, someone's or a run cut short's: made, the take-up puts it back)
    if (w.op === 'cut' && railRoom(st)) { w.done = true; ctx.save?.(); continue; }
    if (w.op === 'fill') {
      const r = await ctx.rails.lay({ at: p, item: 'cobblestone' }).catch((e: Error): RailPlaced => ({ ok: false, placed: false, reason: e.message }));
      aborted(ctx);
      if (!r.placed) return { why: `the fill at ${fmt(p)} not made: ${r.reason ?? 'no answer'}` };
    } else {
      const r = await ctx.rails.cut(p, w.was).catch((e: Error): RailTaken => ({ ok: false, dug: false, reason: e.message }));
      aborted(ctx);
      if (!r.ok) return { why: `the cut of the ${idOf(w.was)} at ${fmt(p)} not made: ${r.reason ?? 'no answer'}` };
    }
    w.done = true;
    ctx.save?.();
  }
  return undefined;
}

/**
 * The earthworks of a column undone once nothing of the line stands in it any more (the take-up's): the fills taken
 * up from the top down (only the bot's own cobblestone), then the cut cells filled back from the bottom up with the
 * block each was (refillOf: a grass block comes back as dirt, stone as stone if any is carried, else as cobblestone).
 * A cell found as it was is done; one with someone's block in it now is left as found, said. How many blocks it moved.
 */
async function earthUp(ctx: GoalContext, line: RailLine, x: number, z: number, said: string[]): Promise<number> {
  const ws = earthIn(line, x, z);
  if (!ws.length || line.laid.some(b => b.at.x === x && b.at.z === z) || !ctx.rails) return 0;
  await walkTo(ctx, { x, y: ws[0].y, z }, 2);
  let n = 0;
  for (const w of ws.filter(q => q.op === 'fill').sort((a, b) => b.y - a.y)) {
    aborted(ctx);
    const p = { x: w.x, y: w.y, z: w.z };
    const r = await ctx.rails.takeUp(p, 'cobblestone').catch((e: Error): RailTaken => ({ ok: false, dug: false, reason: e.message }));
    aborted(ctx);
    if (r.ok) { dropEarth(line, w); if (r.dug) n++; ctx.save?.(); continue; }
    if (notOurs(r.reason)) {
      (line.left ??= []).push(`the fill ${fmt(p)}: ${r.reason ?? 'no answer'}`.slice(0, 120));
      dropEarth(line, w);
      ctx.save?.();
      continue;
    }
    said.push(earthUnreached(line, w, r.reason ?? 'no answer'));
    return n;
  }
  const cuts = ws.filter(q => q.op === 'cut').sort((a, b) => a.y - b.y);
  if (!cuts.length) return n;
  if (!ctx.rails.restore) { said.push(`the cuts at ${fmt(cuts[0])}: no way to fill them back in this runtime`); return n; }
  const counts = await countsNow(ctx);
  const at = await readAround(ctx, cuts);
  for (const w of cuts) {
    aborted(ctx);
    const p = { x: w.x, y: w.y, z: w.z };
    const st = at(w.x, w.y, w.z);
    if (st === undefined || st === null) { said.push(earthUnreached(line, w, 'not read')); return n; }
    // (never cut, or put back already)
    if (idOf(st) === idOf(w.was)) { dropEarth(line, w); ctx.save?.(); continue; }
    if (!railRoom(st)) {
      (line.left ??= []).push(`the cut ${fmt(p)} of ${idOf(w.was)}: ${idOf(st)} there now (left as found)`.slice(0, 120));
      dropEarth(line, w);
      ctx.save?.();
      continue;
    }
    const item = refillOf(w.was, i => counts.get(i) ?? 0);
    if (!item) { said.push(earthUnreached(line, w, `nothing carried to fill it with (${REFILL[idOf(w.was)]?.[0] ?? idOf(w.was)})`)); return n; }
    const r = await ctx.rails.restore(p, item).catch((e: Error): RailPlaced => ({ ok: false, placed: false, reason: e.message }));
    aborted(ctx);
    if (!r.placed) { said.push(earthUnreached(line, w, r.reason ?? 'no answer')); return n; }
    counts.set(item, (counts.get(item) ?? 1) - 1);
    if (item !== idOf(w.was) && !(idOf(w.was) === 'grass_block' && item === 'dirt')) (line.left ??= []).push(`the cut ${fmt(p)} of ${idOf(w.was)} put back as ${item}`.slice(0, 120));
    dropEarth(line, w);
    n++;
    ctx.save?.();
  }
  return n;
}

/**
 * What the take-up puts back into the cuts, carried from the chests (prepare), as far as they give it: each cut's own
 * kind (a grass block's dirt), stone as stone only if the chests hold some (never smelted for it: cobblestone then).
 */
async function carryRefills(ctx: GoalContext, line: RailLine): Promise<void> {
  const stored = (item: string) => Object.values(ctx.world.chestItems ?? {}).reduce((a, c) => a + (c[item] ?? 0), 0);
  const need: Record<string, number> = {};
  for (const w of line.earth ?? []) {
    if (w.op !== 'cut') continue;
    let item = (REFILL[idOf(w.was)] ?? [idOf(w.was)])[0];
    if (item === 'stone' && !stored('stone')) item = 'cobblestone';
    need[item] = (need[item] ?? 0) + 1;
  }
  for (const [item, n] of Object.entries(need)) await prepare(ctx, item, n).catch(() => undefined);
}

/** An earthwork the take-up did not undo this run: counted, and left (said, off the record) after UP_TRIES runs. */
function earthUnreached(line: RailLine, w: EarthRec, reason: string): string {
  const tries = (line.upTries ??= {});
  const k = `earth:${key(w)}`;
  tries[k] = (tries[k] ?? 0) + 1;
  const what = `the ${w.op} ${fmt(w)}${w.op === 'cut' ? ` of ${idOf(w.was)}` : ''}`;
  if (tries[k] < UP_TRIES) return `${what} not undone: ${reason}; again next run`;
  delete tries[k];
  (line.left ??= []).push(`${what}: not undone on ${UP_TRIES} runs (${reason})`.slice(0, 120));
  dropEarth(line, w);
  return `${what} left: not undone on ${UP_TRIES} runs (${reason})`;
}

/** A player near the bot (world.entities): where, or undefined. */
async function playerNear(ctx: GoalContext, r = PLAYER_NEAR): Promise<Pos | undefined> {
  const seen = await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: r }).catch(() => undefined);
  return seen?.entities?.find(e => e.name === 'player' && e.position)?.position;
}

/** The builds of others read again (foreign.zones): one within the 16 the line keeps off, not the village's own; 'unread'. */
async function zonesOnLine(ctx: GoalContext, line: RailLine): Promise<string | undefined> {
  const r = await ctx.call<{ zones?: Zone[] }>('foreign.zones', {}).catch(() => undefined);
  if (!Array.isArray(r?.zones)) return 'unread';
  const a = line.area;
  // (the village's own: its houses meet the area its judge drew, as the judge's `own`)
  const own = (z: Zone) => !!a && z.x1 <= a.x2 && z.x2 >= a.x1 && z.z1 <= a.z2 && z.z2 >= a.z1;
  const zones = r.zones.filter(z => !own(z));
  for (const p of [...line.cells, ...line.torches.map(t => t.at), line.stop.at]) {
    if (inFence(ctx.world, p)) continue;
    const z = zoneNear(zones, { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, FROM_ZONES);
    if (z) return `a build of someone's within ${FROM_ZONES} of the line at ${fmt(p)} (x ${z.x1}..${z.x2}, z ${z.z1}..${z.z2}${z.sample ? `, ${z.sample}` : ''})`;
  }
  return undefined;
}

/**
 * Walk to `to` (within `range`), in legs, careful (walk only: Baritone breaks and places nothing) all the way: the brief's
 * "nothing dug but what the plan says". The line itself is ground a rail stands on with air over it, so a walk along
 * it needs nothing dug; one that cannot get there stops short, and the lay or take-up there says so.
 */
async function walkTo(ctx: GoalContext, to: Pos, range = 3): Promise<void> {
  for (let leg = 0; leg < 12; leg++) {
    aborted(ctx);
    const me = await here(ctx);
    const d = horiz(me, { x: to.x + 0.5, z: to.z + 0.5 });
    if (d <= range + 1) return;
    const f = Math.min(1, LEG / d);
    const p = d <= LEG ? to : { x: Math.round(me.x + (to.x + 0.5 - me.x) * f), y: to.y, z: Math.round(me.z + (to.z + 0.5 - me.z) * f) };
    await ctx.call('goto', { x: p.x, y: p.y, z: p.z, ...(d <= LEG ? {} : { xz: true }), range: d <= LEG ? range : 6, careful: true, timeoutMs: 90_000 }, 105_000).catch(() => undefined);
    const now = await here(ctx);
    // (no nearer: the walk is stuck; whoever asked sees the bot short of it)
    if (horiz(now, me) < 1) return;
  }
}

/** The rails switch or the villager moves switched off (the villager-moves tool pauses no run): nothing more is laid. */
const offNow = (ctx: GoalContext): boolean => !railsOn(ctx.world) || !movesOn(ctx.world);
const OFF_NOW = 'the rails switch (or the villager moves) went off: nothing more laid';

const here = async (ctx: GoalContext): Promise<Pos> => (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;

/**
 * Along the line's rails that are down, from the cell `from` toward `to` (indices, either way), a stop every
 * WALK_EVERY: each stretch read; a rail gone (air where the record has one) laid again between the two beside it (the
 * game turns no rail at a take-up, so the gap's neighbours still point at it), a torch gone put back; a rail with
 * another shape, or anything else where one of the line's should be, stops it (someone's work, or a mob's): why.
 * A player near stops it too.
 */
async function alongLine(ctx: GoalContext, line: RailLine, from: number, to: number, clk: Clk): Promise<{ stop?: string; late?: true; off?: true; mended: number }> {
  const step = from <= to ? 1 : -1;
  let mended = 0;
  const laid = laidCells(line);
  const idx: number[] = [];
  for (let i = from; step > 0 ? i <= to : i >= to; i += step) if (laid.has(i)) idx.push(i);
  for (let k = 0; k < idx.length; k += WALK_EVERY) {
    aborted(ctx);
    if (clk.left() < MARGIN) return { stop: 'the run\'s time ran out on the way along the line', late: true, mended };
    const part = idx.slice(k, k + WALK_EVERY);
    await walkTo(ctx, line.cells[part[Math.floor(part.length / 2)]], 4);
    const p = await playerNear(ctx);
    if (p) return { stop: `a player near at ${fmt(p)}`, mended };
    for (let j = 0; j < part.length; j += STRETCH) {
      const cells = part.slice(j, j + STRETCH);
      const torches = line.torches.filter(t => isLaid(line, t.at) && cells.some(i => same(line.cells[i], t.lights)));
      const at = await readAround(ctx, [...cells.map(i => line.cells[i]), ...torches.map(t => t.at)]);
      for (const i of cells) {
        const c = line.cells[i];
        const st = at(c.x, c.y, c.z);
        if (st === undefined || st === null) continue;
        const now = laidCells(line);
        // (a block put over the line since it was laid, an enderman's or a player's: the villager's head would pass in it)
        const over = overRail(line, i, at);
        if (over) return { stop: `${over} at ${fmt(c)}: over the line now`, mended };
        if (idOf(st) === itemOf(c)) {
          const want = shapeWith(line, i, x => now.has(x));
          if (want && shapeIn(st) && shapeIn(st) !== want) return { stop: `the ${itemOf(c)} at ${fmt(c)} is ${shapeIn(st)} now, not ${want}`, mended };
          continue;
        }
        if (!/^(air|cave_air)$/.test(idOf(st))) return { stop: `${idOf(st)} where the line's ${itemOf(c)} was, at ${fmt(c)}`, mended };
        // (switched off mid-run: nothing more laid, the next pick gives the line up)
        if (offNow(ctx)) return { stop: OFF_NOW, off: true, mended };
        // gone: laid again between the two beside it
        now.delete(i);
        const r = await lay(ctx, line, { kind: 'cell', i }, layArgs(line, i, now));
        if (!r.ok) return { stop: `the ${itemOf(c)} gone at ${fmt(c)} could not be laid again: ${r.reason ?? 'no answer'}`, mended };
        mended++;
      }
      for (const t of torches) {
        const st = at(t.at.x, t.at.y, t.at.z);
        if (st === undefined || st === null || idOf(st) === 'redstone_torch') continue;
        if (!/^(air|cave_air)$/.test(idOf(st))) return { stop: `${idOf(st)} where the line's redstone torch was, at ${fmt(t.at)}`, mended };
        if (offNow(ctx)) return { stop: OFF_NOW, off: true, mended };
        const r = await lay(ctx, line, { kind: 'torch', t }, { at: t.at, item: 'redstone_torch', lights: t.lights, ...(inVillage(line, t.at) ? { inVillage: true } : {}) });
        if (!r.ok) return { stop: `the redstone torch gone at ${fmt(t.at)} could not be put back: ${r.reason ?? 'no answer'}`, mended };
        mended++;
      }
    }
  }
  if (mended) say(ctx, `${mended} block(s) of the line found gone and put back`);
  return { mended };
}

/**
 * One block of the line put down (the runtime's rails tools: a careful walk into reach, the bot's own once down), written
 * into the record first, and brain.json with it (a restart mid-run must not forget a block out there: the take-up walks
 * the record), and taken off it again if it did not go down. A stop's cobblestone is walked to first (lay-rail places it
 * as place-block does, with no walk of its own).
 */
async function lay(ctx: GoalContext, line: RailLine, s: Step, args: RailLay): Promise<RailPlaced> {
  aborted(ctx);
  const at = stepAt(line, s);
  if (s.kind === 'stop') await walkTo(ctx, at, 2);
  record(line, at, stepItem(line, s));
  ctx.save?.();
  const r = await ctx.rails!.lay(args).catch((e: Error): RailPlaced => ({ ok: false, placed: false, reason: e.message }));
  aborted(ctx);
  if (!r.placed) {
    // (a block there that came out of it all the same, the bridge's answer lost: read, not guessed; the cell was read
    // as room just before, so what of the line's stands there now is the bot's)
    const down = await downAfterAll(ctx, line, s, r);
    // (not read either, the client dropped as it went down: it may stand there, the bot's; kept in the record, unsure,
    // for the take-up to find, and read again before the laying counts it)
    if (down === 'unread') {
      const b = line.laid.find(x => same(x.at, at));
      if (b) b.unsure = true;
      ctx.save?.();
      return { ...r, reason: `${r.reason ?? 'no answer'}; not read after (kept in the record)` };
    }
    if (down) { sure(line, at); return down; }
    forget(line, at);
    ctx.save?.();
    return r;
  }
  sure(line, at);
  return r;
}

/** A block of the record read down at last: no longer unsure (saved with the next write). */
const sure = (line: RailLine, at: Pos) => { const b = line.laid.find(x => same(x.at, at)); if (b?.unsure) delete b.unsure; };

/**
 * A step the answer says is not down, read: the block there after all (the reply lost, a timeout), kept in the record,
 * `ok` when it and the rails beside it stand as the plan has them with the rails down now (a torch: its rail lit).
 * Undefined when it is not there, `unread` when the read failed (it may be).
 */
async function downAfterAll(ctx: GoalContext, line: RailLine, s: Step, r: RailPlaced): Promise<RailPlaced | undefined | 'unread'> {
  const p = stepAt(line, s);
  const near = s.kind === 'cell' ? [s.i - 1, s.i, s.i + 1].filter(j => j >= 0 && j < line.cells.length).map(j => line.cells[j]) : s.kind === 'torch' ? [s.t.lights] : [];
  const at = await readAround(ctx, [p, ...near]);
  const st = at(p.x, p.y, p.z);
  if (st === undefined || st === null) return 'unread';
  if (idOf(st) !== stepItem(line, s)) return undefined;
  let ok = true;
  if (s.kind === 'cell') {
    const laid = laidCells(line);
    for (const j of [s.i - 1, s.i, s.i + 1]) {
      if (!laid.has(j)) continue;
      const want = shapeWith(line, j, x => laid.has(x));
      const got = at(line.cells[j].x, line.cells[j].y, line.cells[j].z);
      if (want && (!got || shapeIn(got) !== want)) ok = false;
    }
  } else if (s.kind === 'torch') ok = /powered=true/.test(at(s.t.lights.x, s.t.lights.y, s.t.lights.z) ?? '');
  return { ...r, ok, placed: true, block: stepItem(line, s), reason: `down after all (${r.reason ?? 'no answer'}), read after${ok ? '' : ': not as planned'}` };
}

// ------------------------------------------------------------------------------------------------ the laying

/**
 * A day's laying (the brief's part 2): what the day lays carried (the bill made it: from the chests), the builds round
 * the line read again (one of someone's within 16 gives the line up), out by the gate that way, along what is down
 * (read and mended), then each step in its order from the frontier out: the ground ahead read before it (a cell not as
 * planned, a player near: the day's laying stops there), the block written into the record, put down. It stops in time
 * for the walk home (the wrapper's), and the next morning goes on. Whole, the move is next.
 */
async function layRun(ctx: GoalContext, line: RailLine, clk: Clk): Promise<WorkResult> {
  const home = ctx.s.home ?? ctx.s.position;
  // (a block kept unsure, its lay unanswered and unread, is laid again: read first, it may stand there already)
  const keys = fitKeys(line, true);
  const todo = outwardSteps(line).filter(st => !keys.has(key(stepAt(line, st))));
  if (!todo.length && !straysOf(line).length && !pendingEarth(line)) { line.stage = 'whole'; return { gain: 0, text: 'the line is whole already: the move next', mark: 'forget' }; }
  const need: Record<string, number> = {};
  for (const st of todo) need[stepItem(line, st)] = (need[stepItem(line, st)] ?? 0) + 1;
  if (pendingFills(line)) need.cobblestone = (need.cobblestone ?? 0) + pendingFills(line);
  const short = await carry(ctx, need);
  if (short) return { gain: 0, text: `not setting out to lay: short of ${short}`, untried: true };
  const zone = await zonesOnLine(ctx, line);
  if (zone === 'unread') return { gain: 0, text: 'not setting out to lay: the builds round the line not read', untried: true };
  if (zone) { giveUp(ctx, line, zone); return { gain: 0, text: `the line given up: ${zone}`, mark: 'forget' }; }
  const ew0 = (line.earth ?? []).find(w => !w.done);
  const first = todo.length ? stepAt(line, todo[0]) : straysOf(line).length ? straysOf(line)[0].at : { x: ew0!.x, y: ew0!.y, z: ew0!.z };
  const { rails, of } = laidOf(line);
  say(ctx, `laying the line, day ${line.runs + 1}: ${rails} of ${of} rails down, on from ${fmt(first)}`);
  const gate = await outByGate(ctx, first);
  if (gate.shut) return { gain: 0, text: `not out of the yard to lay: ${gate.shut}`, untried: true };
  line.runs += 1;
  // along what is down to the frontier
  const firstCell = todo.find(st => st.kind === 'cell') as { kind: 'cell'; i: number } | undefined;
  const walked = await alongLine(ctx, line, goalOf(line), (firstCell?.i ?? 0) + 1, clk);
  if (walked.off) return { gain: 0, text: OFF_NOW };
  if (walked.late) { clean(line); return { gain: 0, text: `${walked.stop}: on the next run`, mark: 'same' }; }
  if (walked.stop) return stopped(ctx, line, walked.stop, 0);
  // (an extension's strays first: the old launch's powered rail where a plain rail goes now, the old stop, the old trigger)
  const stray = await upStrays(ctx, line);
  if (stray) return stopped(ctx, line, stray, 0);
  const ext = extendedDown(line);
  const r = await layOn(ctx, line, todo, clk, p => horiz(p, home) / 3 * 1000 + MARGIN);
  if (ext && r.kind !== 'end') sayExtension(ctx, line, r.put);
  if (r.kind === 'end') return r.result;
  const put = r.put;
  if (r.kind === 'late') {
    clean(line);
    const text = `laid ${put} today (${laidOf(line).rails} of ${of} rails down); the day's end: on from ${fmt(r.at)} next morning`;
    say(ctx, text);
    return { gain: put, text, ...(put ? {} : { mark: 'same' as const }) };
  }
  if (r.kind === 'off') { say(ctx, OFF_NOW); return { gain: put, text: `laid ${put} today; ${OFF_NOW}` }; }
  if (r.kind === 'short') { clean(line); return { gain: put, text: `laid ${put} today; out of ${r.item}: the rest next run`, ...(put ? {} : { mark: 'same' as const }) }; }
  clean(line);
  line.stage = 'whole';
  const text = `the line is whole: ${of} rails, ${line.torches.length} torches${line.stop.placed ? ', the stop' : ''} (laid ${put} today, in ${line.runs} run(s)); the move next`;
  say(ctx, text);
  return { gain: put, text };
}

/** How a stretch of laying ended: all of it down, the run's time (`at`: where it stopped), out of an item, switched off, or a WorkResult (a stop, a give-up). */
type LayEnd = { kind: 'done'; put: number } | { kind: 'late'; put: number; at: Pos } | { kind: 'short'; put: number; item: RailItem } | { kind: 'off'; put: number } | { kind: 'end'; put: number; result: WorkResult };

/**
 * The steps `todo` laid in their order (a laying day's, an extension's on the move day): the ground ahead read before
 * it (a cell not as planned, a player near: stopped there), each block written into the record before it goes down. It
 * stops while `keep(p)` (the ms the run must keep from `p` on: the walk home, or the move) still fits.
 */
async function layOn(ctx: GoalContext, line: RailLine, todo: readonly Step[], clk: Clk, keep: (p: Pos) => number): Promise<LayEnd> {
  let put = 0;
  let at: ((x: number, y: number, z: number) => string | null | undefined) | undefined;
  let readFrom = -1;
  for (let k = 0; k < todo.length; k++) {
    aborted(ctx);
    const st = todo[k];
    const p = stepAt(line, st);
    // in time for what the run keeps from here
    if (clk.left() < keep(p)) return { kind: 'late', put, at: p };
    // (switched off mid-run: the villager-moves tool pauses no run; not a stop, the next pick gives the line up)
    if (offNow(ctx)) return { kind: 'off', put };
    if (k - readFrom >= STRETCH || !at) {
      const ahead = todo.slice(k, k + STRETCH);
      // (into reach of the stretch first: the chunks round the bot are what the client holds)
      await walkTo(ctx, stepAt(line, ahead[Math.min(ahead.length - 1, 3)]), 4);
      const pl = await playerNear(ctx);
      if (pl) return { kind: 'end', put, result: stopped(ctx, line, `a player near at ${fmt(pl)}`, put) };
      at = await readAround(ctx, ahead.map(x => stepAt(line, x)));
      readFrom = k;
    }
    // (laid again on the way out since: the mending's)
    if (fitKeys(line).has(key(p)) && !unsureAt(line, p)) continue;
    // the column's cuts and fills first (an extension's earthworks), then the stretch read again as they left it
    if (earthIn(line, p.x, p.z).some(w => !w.done)) {
      if (offNow(ctx)) return { kind: 'off', put };
      const pl = await playerNear(ctx);
      if (pl) return { kind: 'end', put, result: stopped(ctx, line, `a player near at ${fmt(pl)}`, put) };
      const ew = await earthDown(ctx, line, p.x, p.z);
      if (ew?.wait) { say(ctx, `${ew.why}: on from there next run`); return { kind: 'late', put, at: p }; }
      if (ew) {
        if (/no cobblestone carried/.test(ew.why)) return { kind: 'short', put, item: 'cobblestone' };
        return { kind: 'end', put, result: stopped(ctx, line, ew.why, put) };
      }
      at = await readAround(ctx, todo.slice(k, k + STRETCH).map(x => stepAt(line, x)));
      readFrom = k;
    }
    let r: RailPlaced;
    const there = unsureAt(line, p) ? at(p.x, p.y, p.z) : undefined;
    if (there && idOf(there) === stepItem(line, st)) {
      // (kept unsure on a run before, and down there all the same: the bot's, read as the lay's own read-back does)
      const down = await downAfterAll(ctx, line, st, { ok: false, placed: false, reason: 'its lay unanswered on a run before' });
      if (!down || down === 'unread') return { kind: 'end', put, result: stopped(ctx, line, `${stepWord(line, st)}: not read again`, put) };
      sure(line, p);
      ctx.save?.();
      r = down;
    } else {
      const why = notAsRead(line, st, at);
      if (why === 'unread') return { kind: 'end', put, result: stopped(ctx, line, `${stepWord(line, st)}: the ground there not read`, put) };
      if (why) return { kind: 'end', put, result: stopped(ctx, line, `${why} (not as read when planned)`, put) };
      const laid = laidCells(line);
      const args: RailLay = st.kind === 'cell' ? layArgs(line, st.i, laid, st.i > 0 ? st.i - 1 : undefined)
        : st.kind === 'torch' ? { at: st.t.at, item: 'redstone_torch', lights: st.t.lights, ...(inVillage(line, st.t.at) ? { inVillage: true } : {}) }
        : { at: line.stop.at, item: 'cobblestone' };
      r = await lay(ctx, line, st, args);
    }
    if (r.newMovement) {
      giveUp(ctx, line, 'the server runs the minecart_improvements experiment: the line was planned on the old minecart rules');
      put += r.placed ? 1 : 0;
      return { kind: 'end', put, result: { gain: put, text: `the line given up: ${line.why}` } };
    }
    if (!r.placed) {
      if (/^no .* carried$/.test(r.reason ?? '')) return { kind: 'short', put, item: stepItem(line, st) };
      return { kind: 'end', put, result: stopped(ctx, line, `${stepWord(line, st)} not laid: ${r.reason ?? 'no answer'}`, put) };
    }
    put++;
    ctx.gain(1);
    // down, but not as planned (the port and the server disagree): the lead looks; nothing more is laid on it
    if (!r.ok) {
      giveUp(ctx, line, `${stepWord(line, st)} came out not as planned: ${r.reason ?? 'no answer'}`);
      return { kind: 'end', put, result: { gain: put, text: `the line given up: ${line.why}` } };
    }
  }
  // the earthworks left once every step is down: the trigger's column (its torch goes down on the move), the boat's
  // hop to the pickup
  for (const w of [...(line.earth ?? [])]) {
    if (w.done) continue;
    aborted(ctx);
    if (clk.left() < keep(w)) return { kind: 'late', put, at: { x: w.x, y: w.y, z: w.z } };
    if (offNow(ctx)) return { kind: 'off', put };
    const ew = await earthDown(ctx, line, w.x, w.z);
    if (ew?.wait) { say(ctx, `${ew.why}: on from there next run`); return { kind: 'late', put, at: { x: w.x, y: w.y, z: w.z } }; }
    if (ew) return { kind: 'end', put, result: stopped(ctx, line, ew.why, put) };
  }
  return { kind: 'done', put };
}

/**
 * The record's strays (straysOf: what an extension made no longer the plan's) taken up where they stand, each walked to;
 * one no longer the bot's left, said. Why one did not come up (the laying waits on it: a rail goes where it stands), or undefined.
 */
async function upStrays(ctx: GoalContext, line: RailLine): Promise<string | undefined> {
  for (const b of straysOf(line)) {
    aborted(ctx);
    await walkTo(ctx, b.at, 3);
    const r = await takeUp(ctx, line, b.at);
    aborted(ctx);
    if (r.ok) { forget(line, b.at); ctx.save?.(); continue; }
    const st: Step = { kind: 'stray', at: b.at, item: b.item };
    if (!notOurs(r.reason)) return `${stepWord(line, st)} not taken up: ${r.reason ?? 'no answer'}`;
    (line.left ??= []).push(`${stepWord(line, st)}: ${r.reason ?? 'no answer'}`.slice(0, 120));
    forget(line, b.at);
    ctx.save?.();
  }
  return undefined;
}

/** A run that ended with nothing unexpected (its day's end, out of an item, the line whole): the stops are no longer in a row. */
function clean(line: RailLine): void {
  line.stops = 0;
  delete line.stopWhy;
}

/** A run stopped by something unexpected on the line: said, counted toward the give-up (STOPS in a row), home. */
function stopped(ctx: GoalContext, line: RailLine, why: string, put: number): WorkResult {
  line.stops = (line.stops ?? 0) + 1;
  line.stopWhy = why.slice(0, 160);
  const text = `${put ? `laid ${put}, then ` : ''}stopped: ${why}${line.stops >= STOPS ? ' (the line is given up next)' : ''}`;
  say(ctx, text);
  return { gain: put, text, ...(put ? {} : { mark: 'same' as const }) };
}

// ------------------------------------------------------------------------------------------------ the move

/** The bot's cart as cart.status reads it now (by its uuid), or undefined (gone, or out of sight). */
async function cartNow(ctx: GoalContext, line: RailLine): Promise<{ cart?: CartState; simulation?: number; read?: boolean }> {
  if (!line.cart) return {};
  const r = await ctx.call<CartStatus>('cart.status', { uuid: line.cart.uuid, ...(line.cart.id !== undefined ? { id: line.cart.id } : {}) }).catch(() => undefined);
  const cart = r?.carts?.find(c => c.uuid === line.cart!.uuid) ?? r?.carts?.[0];
  if (cart?.id !== undefined) line.cart.id = cart.id;
  return { cart, simulation: r?.simulationDistance, read: !!r && Array.isArray(r.carts) };
}
/** The index of the rail a cart stands on (its rail, else its block), or -1. */
const cellIndexAt = (line: RailLine, c: CartState): number => {
  const p = c.rail ?? c.block ?? (c.position ? { x: Math.floor(c.position.x), y: Math.floor(c.position.y), z: Math.floor(c.position.z) } : undefined);
  return p ? line.cells.findIndex(q => q.x === p.x && q.z === p.z && Math.abs(q.y - p.y) <= 1) : -1;
};
const onBrake = (line: RailLine, i: number) => i >= line.cells.length - line.cells.filter(c => c.kind === 'brake').length - 2;

/** The move given up after the villager was taken out of its village: the moves wait for the lead (the boat move's rule). */
function lostOut(ctx: GoalContext, line: RailLine, why: string): WorkResult {
  giveUp(ctx, line, why);
  if (movesOn(ctx.world)) {
    ctx.world.villagerMoves = false;
    say(ctx, `villager moves off (by the rails move: ${why})`);
  }
  return { gain: 0, text: `the move given up: ${why}` };
}

/**
 * The move not made today, nothing lost: the line stays whole (its yard stretch for close up), counted as a stop unless
 * it was only the day's time, a player by, or a judge that waits on the village (`late`), or no villager to take from
 * a village seen whole (`miss`: counted toward MISSES, the dry mark's growing wait before the next try).
 */
function notToday(ctx: GoalContext, line: RailLine, why: string, late: boolean | 'miss' = false): WorkResult {
  line.stage = 'whole';
  if (late === 'miss') {
    line.misses = (line.misses ?? 0) + 1;
    line.missWhy = why.slice(0, 160);
    const text = `the move not made: ${why}${line.misses >= MISSES ? ` (${line.misses} such runs: the line is given up next)` : ''}`;
    say(ctx, text);
    return { gain: 0, text };
  }
  if (!late) return stopped(ctx, line, `the move not made: ${why}`, 0);
  say(ctx, `the move not made today: ${why}`);
  return { gain: 0, text: `the move not made today: ${why}`, mark: 'same' };
}

/**
 * The move, once the line is whole (the brief's part 3): by day and dry (the gates), the hall counted, what the move
 * takes carried; the yard's stretch laid from the fence's post in (the post opened, written into villages.open, held
 * for the take-up); out along the line to its head (read and mended); the village looked over and judged again; an
 * unemployed villager taken by boat onto the pickup and the boat taken up; the cart on the launch, the trigger torch:
 * the cart takes it in and rolls home. Missed (it wandered off the pickup), the cart is broken back and the trigger
 * taken up, and again, MOVE_TRIES times: then the villager is lost and the line given up. Home along the line behind the
 * cart; at the brake the post's rail up and the fence shut, the cart broken, the boat into the hall. Then the take-up,
 * as far as the day goes.
 */
async function moveRun(ctx: GoalContext, line: RailLine, clk: Clk): Promise<WorkResult> {
  const world = ctx.world;
  if (line.stage === 'moving') return resumeMove(ctx, line, clk);
  const counted = await countHall(ctx, clk.now());
  if (counted !== undefined && counted >= HALL_WANTS) { giveUp(ctx, line, `the hall has ${counted} villagers already`); return { gain: 0, text: `the line given up: ${line.why}`, mark: 'forget' }; }
  const need: Record<string, number> = { [BOAT_ITEM]: 1 };
  if (!line.cart) need.minecart = 1;
  const trig = triggerOf(line);
  if (trig && !isLaid(line, trig.at)) need.redstone_torch = 1;
  for (const st of yardSteps(line)) if (!isLaid(line, stepAt(line, st))) need[stepItem(line, st)] = (need[stepItem(line, st)] ?? 0) + 1;
  for (const o of line.opens) { const it = idOf(o.block).replace(/wall_torch$/, 'torch'); need[it] = (need[it] ?? 0) + 1; }
  const short = await carry(ctx, need);
  if (short) return { gain: 0, text: `not setting out on the move: short of ${short}`, untried: true };
  // (some cobblestone for an extension's fills, if one is left to make: as much as the chests give, never a reason to stay)
  if ((line.extended?.times ?? 0) < EXTENSIONS && ctx.rails?.cut) await prepare(ctx, 'cobblestone', EARTH_CARRY).catch(() => undefined);
  // (and an extension's rails, as far as the chests and the crafting give them, never a reason to stay: live, Nov 22,
  // the extension planned on the move day was laid on the next run, and by the move day after the villager it was laid
  // to had wandered off; carried, it is laid and the move made in the one run, the villager still where it stood)
  // (only while the pockets keep EXT_FREE slots free, the crafting's leftovers counted: live, Nov 22, the carry filled
  // all 36 and the stash cut the move short three times running, putting the rails away each time)
  if ((line.extended?.times ?? 0) < EXTENSIONS) {
    for (const [item, n] of Object.entries(EXT_CARRY)) {
      if (await slotsNow(ctx) > 36 - EXT_FREE) break;
      await prepare(ctx, item, n).catch(() => undefined);
    }
  }
  // fed for the day out (the food goal, survival, would cut the move with the villager in the cart)
  const ride = FOOD_TARGET + CHEST_SPARE;
  let fed = readyFoodPoints(await countsNow(ctx));
  if (fed < ride) {
    // any ready food the chests hold, as a trip's top-up (food.ts gatherFood): bread alone was asked for, and with
    // none stored (Nov 21: only carrots and the like) the move stayed home one food point short
    await gatherFood(ctx, ride, true, true).catch(() => undefined);
    fed = readyFoodPoints(await countsNow(ctx));
    if (fed < ride) {
      await prepare(ctx, 'bread', ((await countsNow(ctx)).get('bread') ?? 0) + Math.ceil((ride - fed) / 5));
      fed = readyFoodPoints(await countsNow(ctx));
    }
  }
  if (fed < ride) return { gain: 0, text: `not setting out on the move: short of food (${fed} food points carried, ${ride} wanted)`, untried: true };
  const zone = await zonesOnLine(ctx, line);
  if (zone === 'unread') return { gain: 0, text: 'not setting out on the move: the builds round the line not read', untried: true };
  if (zone) { giveUp(ctx, line, zone); return { gain: 0, text: `the line given up: ${zone}`, mark: 'forget' }; }

  // the yard's stretch, from the fence's post in: the post opened (and what stood on it)
  line.stage = 'moving';
  line.yardOpen = true;
  ctx.save?.();
  const yardWhy = await openYard(ctx, line);
  // (a rail of it that came out not as planned gives the line up: not a day's stop)
  if (yardWhy && (line.stage as RailStage) === 'taking up') return { gain: 0, text: `the line given up: ${line.why}` };
  if (yardWhy) return notToday(ctx, line, yardWhy);
  say(ctx, `the yard's stretch laid (${line.yard} rails, the fence open at ${fmt(line.cells[goalOf(line) + 1])}); out along the line to the village at ${fmt(line.site)}`);

  // out along the line to its head
  const g = goalOf(line);
  const gate = await outByGate(ctx, line.cells[g]);
  if (gate.shut) return notToday(ctx, line, `not out of the yard: ${gate.shut}`);
  const walked = await alongLine(ctx, line, g, 0, clk);
  if (walked.stop) return notToday(ctx, line, walked.stop, walked.late || walked.off);
  await walkTo(ctx, line.pickup, 3);
  // (a boat a hop cut short left at the pickup, the villager perhaps seated in it: broken back first)
  const boatLeft = await boatAtPickup(ctx, line);
  if (boatLeft) return notToday(ctx, line, boatLeft);

  // the village looked over and judged again (a fresh look is what counts)
  const vs = villagesOf(world);
  const site = siteFor(vs.sites, line.site);
  if (!site) { giveUp(ctx, line, `the village at ${fmt(line.site)} is no longer known`); return { gain: 0, text: `the line given up: ${line.why}` }; }
  const home = ctx.s.home ?? ctx.s.position;
  const enough = () => clk.left() < moveRest(line, home);
  // (the look round it as relook and the boat move have it: on to up to VIEWPOINTS places round the village, carefully,
  // nothing touched, while the walk there, back to the pickup and the move after still fit the run. Nov 21, set out near
  // dusk, the run had no time for a viewpoint: 45 of 132 chunks of the west village seen from the line's end, a miss)
  const lookBy = (to?: { x: number; z: number }) => enough() || (!!to && clk.left() < moveRest(line, home) + VIEWPOINT_MS + horiz(to, line.pickup) / 3 * 1000);
  // (the village's free word as it stood before this look: seen whole a few hours ago, it holds where today's look saw
  // only part of it)
  const before = freshFree(site, clk.now());
  const { look, today, kept } = await judgeAgain(ctx, site, clk, lookBy);
  const v = before && today.kind === 'wait' && today.unseen ? judgeOnWhole(look, before.area) : today;
  if (v !== today && kept?.judged?.kind === 'free') say(ctx, `the village as judged free at ${clock(before!.judged.at)}Z (seen whole); today's look saw ${look.looked.chunks} of ${look.looked.of} chunks`);
  const word = wordOn(v, kept);
  if (v.kind === 'theirs' || word.kind === 'theirs') { giveUp(ctx, line, `the village at ${fmt(line.site)} is someone's: ${word.why}`); return { gain: 0, text: `the line given up: ${line.why}` }; }
  // (not all of it seen, its bell not seen, too little of it, illagers by it, a read that did not answer: the judge
  // waits, and so does the move: not made today, neither a miss nor a stop. Only a village seen whole that gives no
  // villager to take is a miss)
  if (v.kind === 'wait') return notToday(ctx, line, `the village not judged free today: ${v.why}`, true);
  if (v.kind !== 'free') return notToday(ctx, line, `the village not judged free today: ${v.why}`, 'miss');
  if (enough()) return notToday(ctx, line, 'too little of the run left for the move after the look', true);
  // (back from the look's viewpoints to the pickup, if it went to any: the hop's look for villagers and the launch are
  // from there)
  await walkTo(ctx, line.pickup, 3);
  // out along the whole line with nothing unexpected: the stops before are no longer in a row
  clean(line);
  say(ctx, `the village at ${fmt(line.site)} is free to take from: ${v.why}`);
  // (the hop's ways keep off every build but the village's own, as the boat's way home does; the hop may take what of
  // the run is left once the cart's start, the way home and the yard are kept)
  const zones = wayZones(look, v);
  const hopRoom = () => clk.left() - (moveRest(line, home) - PICKUP_MS) - CART_MS;
  const hopFrom: HopFrom = { candidates: v.candidates, jobs: look.jobs, area: v.area, zones, room: hopRoom };
  // (no villager the judge allows that a boat way reaches the pickup from: the line extended into the village to one,
  // the user's of Nov 21, and laid as the run allows)
  const extended = await extendFor(ctx, line, hopFrom, look, v, clk, home);
  if (extended) return extended;

  // the villager onto the pickup, the cart, the trigger
  let took: Seen | undefined;
  let missed = '';
  let forced = false;
  const extLeft = () => (line.extended?.times ?? 0) < EXTENSIONS;
  for (let k = 0; k < MOVE_TRIES && !took; k++) {
    aborted(ctx);
    if (enough()) return notToday(ctx, line, `the run's time ran out at the pickup${missed ? ` (${missed})` : ''}`, true);
    const sky = await ctx.status().catch(() => undefined);
    if (sky?.raining || sky?.thundering) return notToday(ctx, line, 'it began to rain: no villager is moved in the rain', true);
    const pick = await toPickup(ctx, line, hopFrom, clk.now());
    if ('why' in pick) {
      if (pick.late) return notToday(ctx, line, pick.why, true);
      if (!missed) {
        // (the dry check found a way, the real hop did not bring the villager: the extension in this same run while
        // one is left and the run has the time, the boat back in the pockets; Nov 21, the day counted a miss instead)
        if (pick.hop && extLeft() && !forced && !enough() && (await countsNow(ctx)).get(BOAT_ITEM)) {
          forced = true;
          const ext = await extendFor(ctx, line, hopFrom, look, v, clk, home, pick.why);
          if (ext) return ext;
          k--;
          continue;
        }
        // (none in the village to bring to the pickup today: a miss, not a stop; one there that no hop brought is a miss
        // only once no extension is left to try)
        return notToday(ctx, line, pick.why, pick.hop && extLeft() ? true : 'miss');
      }
      break;
    }
    const go = await launch(ctx, line, pick.e);
    if ('took' in go) { took = pick.e; break; }
    if ('fail' in go) return go.out ? lostOut(ctx, line, go.fail) : lostIfOut(ctx, line, go.fail);
    // (the cart perhaps gone with the villager, not read: the move stays under way, the next run's resumeMove finds the
    // cart by the villager it went for)
    if ('unsure' in go) {
      ctx.save?.();
      const text = `the move left under way: ${go.unsure}; the next run looks for the cart`;
      say(ctx, text);
      return { gain: 0, text, mark: 'same' };
    }
    // (not the villager lost: the cart never went down for it; the dry mark's wait lets the mob wander off)
    if ('blocked' in go) return notToday(ctx, line, go.blocked, 'miss');
    missed = go.missed;
    say(ctx, `the cart missed the villager (${pick.e.id}): ${go.missed}; again`);
    const back = await recoverCart(ctx, line);
    if (back) return lostIfOut(ctx, line, `the cart that missed could not be taken back up: ${back}`);
  }
  if (!took) { giveUp(ctx, line, `the villager lost: the cart missed it ${MOVE_TRIES} times (${missed})`); return { gain: 0, text: `the line given up: ${line.why}` }; }
  line.villagerOut = took.id;
  ctx.save?.();
  say(ctx, `the villager (${took.id}) in the cart, rolling home; following along the line on foot`);

  // home on foot along the line behind the cart
  const follow = await followHome(ctx, line, took.id, clk);
  if (follow) return lostOut(ctx, line, follow);
  return intoHall(ctx, line, took.id, clk);
}

/**
 * The look round the village and today's judge, its word kept on the site (noteVerdict), but for a wait only for what the
 * look did not see (not all of it, its bell): that never overwrites a free word kept (fresh or not), which stays the
 * site's with the time it was given (and ages past FRESH_FREE as ever). Live, Nov 21: the move days before this rule
 * overwrote the west village's free word (seen whole at 04:28Z) with "not all of it seen yet (101 of 132 chunks)".
 */
async function judgeAgain(ctx: GoalContext, site: VillageSite, clk: Clk, lookBy: (to?: { x: number; z: number }) => boolean): Promise<{ look: VillageLook; today: Verdict; kept: VillageSite | undefined }> {
  const was = site.judged?.kind === 'free' ? { judged: { ...site.judged }, area: site.area ? { ...site.area } : undefined } : undefined;
  const look = await lookVillage(ctx, { x: site.x, y: site.y, z: site.z }, clk.now(), lookBy);
  const today = judgeVillage(look);
  const kept = noteVerdict(ctx.world, site, look, today, clk.now());
  if (was && today.kind === 'wait' && today.unseen && kept?.judged?.kind === 'wait') {
    kept.judged = was.judged;
    if (was.area) kept.area = joinAreas(kept.area, was.area);
  }
  return { look, today, kept };
}

/**
 * A look-only day (the `look` variant: the line whole, the village with no free word seen whole within FRESH_FREE): out
 * of the yard by its gate and along the line to the pickup (the yard's stretch not laid, the fence's post not opened:
 * nothing of the move), the look round the village with all the run's time but the walk home along the line, and its
 * word kept. Free: the next move day goes on it (fresh). Someone's: the line given up. Still not seen whole, or another
 * wait: not made today, neither a miss nor a stop. No villager to take in a village seen whole: a miss, as on a move day.
 */
async function lookRun(ctx: GoalContext, line: RailLine, clk: Clk): Promise<WorkResult> {
  const counted = await countHall(ctx, clk.now());
  if (counted !== undefined && counted >= HALL_WANTS) { giveUp(ctx, line, `the hall has ${counted} villagers already`); return { gain: 0, text: `the line given up: ${line.why}`, mark: 'forget' }; }
  const zone = await zonesOnLine(ctx, line);
  if (zone === 'unread') return { gain: 0, text: 'not setting out to look at the village: the builds round the line not read', untried: true };
  if (zone) { giveUp(ctx, line, zone); return { gain: 0, text: `the line given up: ${zone}`, mark: 'forget' }; }
  const g = goalOf(line);
  const gate = await outByGate(ctx, line.cells[g]);
  if (gate.shut) return notToday(ctx, line, `not out of the yard: ${gate.shut}`);
  const walked = await alongLine(ctx, line, g, 0, clk);
  if (walked.stop) return notToday(ctx, line, walked.stop, walked.late || walked.off);
  await walkTo(ctx, line.pickup, 3);
  const site = siteFor(villagesOf(ctx.world).sites, line.site);
  if (!site) { giveUp(ctx, line, `the village at ${fmt(line.site)} is no longer known`); return { gain: 0, text: `the line given up: ${line.why}` }; }
  const home = ctx.s.home ?? ctx.s.position;
  // (the run's whole time for the look, but the walk home along the line from where it ends)
  const back = (from: { x: number; z: number }) => (horiz(from, line.pickup) + Math.max(horiz(line.cells[0], home), line.cells.length - line.yard)) / 3 * 1000 + MARGIN;
  const lookBy = (to?: { x: number; z: number }) => clk.left() < back(line.pickup) || (!!to && clk.left() < back(to) + VIEWPOINT_MS);
  const { look, today: v, kept } = await judgeAgain(ctx, site, clk, lookBy);
  const word = wordOn(v, kept);
  const seen = `${look.looked.chunks} of ${look.looked.of} chunks seen`;
  say(ctx, `a look-only day at the village at ${fmt(line.site)} (${seen}): ${word.kind}: ${word.why}`);
  if (v.kind === 'theirs' || word.kind === 'theirs') { giveUp(ctx, line, `the village at ${fmt(line.site)} is someone's: ${word.why}`); return { gain: 0, text: `the line given up: ${line.why}` }; }
  if (v.kind === 'wait') return notToday(ctx, line, `the village not judged free today: ${v.why}`, true);
  if (v.kind !== 'free') return notToday(ctx, line, `the village not judged free today: ${v.why}`, 'miss');
  if (!v.candidates.length) return notToday(ctx, line, `the village judged free, but no unemployed villager in it to take: ${v.why}`, 'miss');
  clean(line);
  const text = `the village at ${fmt(line.site)} looked at whole and judged free (${seen}): ${v.why}; the move on the next move day`;
  return { gain: 0, text, mark: 'same' };
}

/** Whether the move day has a free word on the village to go on (pure, the gates' and the variants'): seen whole within FRESH_FREE. */
const freeToMove = (world: WorldMemory, line: RailLine, now: number): boolean => {
  const site = siteNowOf(world, line);
  return !!site && !!freshFree(site, now);
};

/**
 * The village's free word of today's judge (JUDGE_V), given on a look that saw it whole (the judge says free of no other)
 * less than FRESH_FREE ago, and the area it saw, or undefined. Live, Nov 21: the west village seen whole and judged free
 * at 04:28Z (relook) and on the move days at 06:15 and 06:47Z; the move day of 09:05Z had the time for one viewpoint (42
 * of 121 chunks seen), and waited on "not all of it seen yet (101 of 132 chunks)". A village does not change in a few
 * hours but by what the move day's own look reads afresh: its villagers (the ones to take are the ones it saw), illagers
 * by it, a player by the bot or it now (toPickup's look), and two villagers used (someone's at once).
 */
function freshFree(site: VillageSite, now: number): { judged: NonNullable<VillageSite['judged']>; area: NonNullable<VillageSite['area']> } | undefined {
  const j = site.judged, a = site.area;
  if (!j || j.kind !== 'free' || typeof j.v !== 'number' || j.v < JUDGE_V || !Number.isFinite(j.at) || now - j.at >= FRESH_FREE || now < j.at) return undefined;
  if (!a || ![a.x1, a.z1, a.x2, a.z2].every(Number.isFinite)) return undefined;
  return { judged: { ...j }, area: { x1: a.x1, z1: a.z1, x2: a.x2, z2: a.z2 } };
}

/** What of the run the move still needs once at the village: the hop and the start, home along the line, the yard. */
// (home behind the cart on foot the straight way, a fifth more for the turns: live, Nov 22-23, the walk home from the
// west village's line took 50 s for 205 blocks, every run, where the line's 370 cells at a walk reckoned 123 s)
// (never more than the walk along the line itself)
const moveRest = (line: RailLine, home: { x: number; z: number }) => PICKUP_MS + Math.min(horiz(line.cells[0], home) * 1.2, Math.max(horiz(line.cells[0], home), line.cells.length - line.yard)) / 3 * 1000 + BRAKE_WAIT + YARD_MS;

/** A failure with the cart on the line but the villager not in it: the line is given up (the take-up takes the cart). */
function lostIfOut(ctx: GoalContext, line: RailLine, why: string): WorkResult {
  if (line.villagerOut !== undefined) return lostOut(ctx, line, why);
  giveUp(ctx, line, why);
  return { gain: 0, text: `the line given up: ${why}` };
}

/** The yard's stretch laid: the bot to the fence's post from inside, what stands on it and the post dug (into villages.open first), the rails from the post in. Why not, or undefined. */
async function openYard(ctx: GoalContext, line: RailLine): Promise<string | undefined> {
  const inner = line.cells[Math.min(line.cells.length - 1, goalOf(line) + 2)];
  await ctx.call('goto', { ...inner, range: 1, careful: true, timeoutMs: 45_000 }, 60_000).catch(() => undefined);
  const changed = await fenceAsPlanned(ctx, line);
  if (changed) {
    if (!yardSteps(line).some(st => isLaid(line, stepAt(line, st)))) delete line.yardOpen;
    return changed;
  }
  // (what stands on the post first: a torch on it would pop off as the post goes, and never come back)
  for (const o of [...line.opens].sort((a, b) => b.at.y - a.at.y)) {
    const why = await digOut(ctx, o.at, o.block);
    if (why) return `the fence did not come out: ${why}`;
  }
  for (const st of yardSteps(line)) {
    const at = stepAt(line, st);
    // (one kept unsure is laid again: the bridge refuses a cell taken, and the read after finds it there)
    if (isLaid(line, at) && !unsureAt(line, at)) continue;
    const laid = laidCells(line);
    const args: RailLay = st.kind === 'cell' ? layArgs(line, st.i, laid, st.i + 1 < line.cells.length ? st.i + 1 : undefined)
      : st.kind === 'torch' ? { at: st.t.at, item: 'redstone_torch', lights: st.t.lights } : { at, item: 'cobblestone' };
    const r = await lay(ctx, line, st, args);
    if (!r.placed) return `${stepWord(line, st)} not laid: ${r.reason ?? 'no answer'}`;
    if (!r.ok) { giveUp(ctx, line, `${stepWord(line, st)} came out not as planned: ${r.reason ?? 'no answer'}`); return line.why; }
  }
  return undefined;
}

/** Blocks that hang on a block's side (they pop off when it goes). */
const HUNG = /(wall_torch|wall_sign|wall_hanging_sign|wall_banner|wall_head|wall_skull|ladder|lever|_button|tripwire_hook)$/;
const AIR = /^(minecraft:)?(air|cave_air|void_air)(\[|$)/;

/**
 * The fence's post and what stands on it read again on the move's day, right before they are dug: the plan read them
 * once, at its dry run, up to MAX_AGE ago (the yard restyled since, a lantern put on the post, a sign hung on it). Each
 * opening still the block the plan has (it goes back as that), nothing on top of the topmost (it would pop off as the
 * post goes, and never come back), nothing hung on the post's sides. Openings dug already (villages.open: a day cut
 * short) and the post with its rail down are not read again. Why not (the move stopped for the day), or undefined.
 */
async function fenceAsPlanned(ctx: GoalContext, line: RailLine): Promise<string | undefined> {
  const post = line.cells[goalOf(line) + 1];
  const open = villagesOf(ctx.world).open ?? [];
  const todo = line.opens.filter(o => !open.some(q => same(q.at, o.at)) && !(same(o.at, post) && isLaid(line, post)));
  if (!todo.length) return undefined;
  const top = Math.max(...line.opens.map(o => o.at.y));
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: post.x + dx, y: post.y, z: post.z + dz }));
  const at = await readAround(ctx, [post, ...sides, { x: post.x, y: top, z: post.z }]);
  const unread = `the fence's post at ${fmt(post)} not read before it is opened`;
  for (const o of todo) {
    const st = at(o.at.x, o.at.y, o.at.z);
    if (st === undefined) return unread;
    if (!st || idOf(st) !== idOf(o.block)) return `${st ? idOf(st) : 'nothing'} at ${fmt(o.at)} now, not the ${idOf(o.block)} the line was planned with: the fence not opened`;
  }
  const over = at(post.x, top + 1, post.z);
  if (over === undefined) return unread;
  if (over && !AIR.test(over)) return `${idOf(over)} on top of the fence's post at ${fmt({ x: post.x, y: top + 1, z: post.z })} now (it would pop off as the post goes): the fence not opened`;
  for (let y = post.y; y <= top; y++) {
    for (const sd of sides) {
      const st = at(sd.x, y, sd.z);
      // (the line's own torches aside)
      if (line.torches.some(q => same(q.at, { x: sd.x, y, z: sd.z }))) continue;
      if (st && HUNG.test(idOf(st))) return `${idOf(st)} hung by the fence's post at ${fmt({ x: sd.x, y, z: sd.z })} (it would pop off as the post goes): the fence not opened`;
    }
  }
  return undefined;
}

/** At most this many villagers' boat ways to the pickup searched in a run (each a search of seconds), and its size. */
const HOP_TRIES = 4;
const HOP_NODES = 40_000;
/** Planned again from where the boat is at most this many times on the hop, when the next leg no longer holds. */
const HOP_REPLANS = 3;
/** What a hop takes besides its drive: the walk to the villager, the boat down and up, getting in and out. */
const HOP_FIXED = 20_000;

/**
 * Where a hop to the pickup may drive (pure): the village's area as the judge drew it today (else as when the line was
 * planned) and the pickup, HOP_ROOM round them. A villager is let out only in there: its own village, or by the pickup
 * (where one of them stood when the line was planned). Undefined with no area known (the plan's straight hop only).
 */
const HOP_ROOM = 4;
export function hopBox(line: Pick<RailLine, 'pickup' | 'area'>, area?: { x1: number; z1: number; x2: number; z2: number }): { x1: number; z1: number; x2: number; z2: number } | undefined {
  const a = area ?? line.area;
  const p = line.pickup;
  if (!a) return undefined;
  return { x1: Math.min(a.x1, p.x) - HOP_ROOM, z1: Math.min(a.z1, p.z) - HOP_ROOM, x2: Math.max(a.x2, p.x) + HOP_ROOM, z2: Math.max(a.z2, p.z) + HOP_ROOM };
}
/** A boat a hop left at `at` is the line's: by its pickup, or in the box its hops drive in (by the village's area as last judged, or as planned). */
function byHop(world: WorldMemory, line: RailLine, at: { x: number; z: number }): boolean {
  if (horiz(at, { x: line.pickup.x + 0.5, z: line.pickup.z + 0.5 }) <= HOP + 8) return true;
  const within = (b?: { x1: number; z1: number; x2: number; z2: number }) => !!b && at.x >= b.x1 - 4 && at.x <= b.x2 + 5 && at.z >= b.z1 - 4 && at.z <= b.z2 + 5;
  return within(hopBox(line, siteFor(peekVillages(world).sites, line.site)?.area)) || within(hopBox(line));
}
/** A boat drive's time on land with the villager, and the drive's time-out, for `d` blocks. */
const hopMs = (d: number) => Math.round(d / BOAT_PACE * 1000 * 1.3);
const driveMs = (d: number) => Math.max(15_000, Math.round(d / BOAT_PACE * 1500) + 10_000);
const legsLength = (from: { x: number; z: number }, legs: readonly { x: number; z: number }[]) => {
  let d = 0, at = from;
  for (const q of legs) { d += horiz(at, q); at = q; }
  return d;
};

/** What the hop to the pickup goes on: the judge's candidates and job sites today, its area, the zones kept off, the time it may take. */
interface HopFrom {
  candidates: readonly Seen[];
  jobs: readonly { at: Pos }[];
  area?: { x1: number; z1: number; x2: number; z2: number };
  zones: readonly Zone[];
  /** the ms of the run the hop may take (what is left once the cart's start, the way home and the yard are kept) */
  room: () => number;
  /** the ground read for it already (the move day's look for an extension), read on where it falls short */
  ground?: Ground;
}

/**
 * An unemployed villager the judge allows, anywhere in its village, brought onto the pickup by boat: the nearest first,
 * its way to the pickup searched on the ground read for it (boatroute.ts planRoute: the boat's footprint and the drive's
 * slack, a drop of MAX_DROP at most, never a step up; FROM_ZONES off every build but the village's own and the
 * outposts' wider berth; within the village's area and the pickup, hopBox), nothing dug. The boat down against it, the
 * bot in front, the drive leg by leg (each leg judged again from where the boat is, the rest planned again when it no
 * longer holds), out to the side of the line at the pickup and the boat broken back into its item: the villager stands
 * on the pickup's rail. A drive that stops on the way takes the villager back to where the boat came down, and lets it
 * out there (in its village, where it stood), the boat taken back up: no villager is left by the line half way. Looked at
 * again just before the boat goes down: a player by (`late`: no move this run), the rain, what the villager is now.
 */
async function toPickup(ctx: GoalContext, line: RailLine, t: HopFrom, now: number): Promise<{ e: Seen } | { why: string; late?: true; hop?: true }> {
  const p = line.pickup;
  const mid = { x: p.x + 0.5, z: p.z + 0.5 };
  const box = hopBox(line, t.area);
  const y0 = Math.min(p.y, line.site.y) - MAX_DROP - 4;
  const g = t.ground ?? new Ground(y0, Math.min(64, Math.max(p.y, line.site.y) + 8 - y0 + 1));
  await g.read(ctx, (box?.x1 ?? p.x - HOP - 4), (box?.z1 ?? p.z - HOP - 4), (box?.x2 ?? p.x + HOP + 4), (box?.z2 ?? p.z + HOP + 4));
  const bounds = box ?? { x1: p.x - HOP - 4, z1: p.z - HOP - 4, x2: p.x + HOP + 4, z2: p.z + HOP + 4 };
  const inBox = (q: { x: number; z: number }) => q.x >= bounds.x1 && q.x < bounds.x2 + 1 && q.z >= bounds.z1 && q.z < bounds.z2 + 1;
  const route = (from: BoatAt, to = mid, within = 0.5) => planRoute(g, from, to, { zones: t.zones, bounds, within, maxNodes: HOP_NODES });
  const look = async () => {
    const round = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: PLAYER_SIGHT }).catch(() => undefined))?.entities ?? [];
    // (a player by the bot or the village right now: no move this run, the village still free)
    const player = playerNow(round, await here(ctx), siteFor(villagesOf(ctx.world).sites, line.site)?.area ?? t.area);
    return { round, player };
  };
  const first = await look();
  if (first.player) return { why: `${first.player}: no villager taken this run`, late: true };
  const ids = new Set(t.candidates.map(c => c.id));
  const order = first.round.filter(e => e.name === 'villager' && e.position && ids.has(e.id) && !notFree(e, t.jobs) && inBox(e.position))
    .sort((a, b) => horiz(a.position!, mid) - horiz(b.position!, mid));
  if (!order.length) return { why: `no unemployed villager the judge allows in the village at ${fmt(line.site)} to bring to the pickup at ${fmt(p)}` };
  const along = line.cells[HEAD.pickup - HEAD.launch - 1] ?? line.cells[0];
  let tried = 0, noWay = '', late = '', onPath = 0;
  for (const e0 of order) {
    aborted(ctx);
    // (on the pickup already, its middle: the cart takes it there as it stands)
    if (horiz(e0.position!, mid) <= 0.3) { say(ctx, `the villager (${e0.id}) stands on the pickup ${fmt(p)}`); return { e: e0 }; }
    if (tried >= HOP_TRIES) break;
    await yieldNow();
    const at0 = e0.position!;
    // (one on a path, farmland or the like has no cell a boat can start from: looked at again once it has wandered,
    // as the boat move does; a day that finds only such is no miss)
    if (!footprint(g, at0.x, at0.z, at0.y, false).ok) {
      onPath++;
      say(ctx, `the villager (${e0.id}) at ${fmt(at0)} stands on a path, farmland or the like: no boat starts there`);
      continue;
    }
    tried++;
    const plan0 = route({ x: at0.x, z: at0.z, level: at0.y });
    if (!plan0.ok) { noWay ||= `from the villager (${e0.id}) at ${fmt(at0)}: ${plan0.why}`; continue; }
    const need0 = horiz(await here(ctx), at0) / 3 * 1000 + hopMs(legsLength(at0, plan0.legs)) + HOP_FIXED;
    if (need0 > t.room()) { late ||= `too little of the run left to bring the villager (${e0.id}) ${Math.round(legsLength(at0, plan0.legs))} to the pickup (need ${Math.round(need0 / 1000)} s, ${Math.max(0, Math.round(t.room() / 1000))} s left)`; continue; }
    await ctx.call('goto', { x: Math.floor(at0.x), y: Math.floor(at0.y), z: Math.floor(at0.z), range: 2, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);
    // looked at again just before the boat goes down: a player come by, the rain, where the villager is and what it is now
    const again = await look();
    if (again.player) return { why: `${again.player}: no villager taken this run`, late: true };
    const sky = await ctx.status().catch(() => undefined);
    if (sky?.raining || sky?.thundering) return { why: 'it began to rain: no villager is moved in the rain', late: true };
    const e = again.round.find(x => x.id === e0.id && x.name === 'villager');
    if (!e?.position || !inBox(e.position) || notFree(e, t.jobs)) { say(ctx, `the villager (${e0.id}) ${!e?.position ? 'went out of sight' : !inBox(e.position) ? 'wandered out of the village' : notFree(e, t.jobs)}: not taken`); continue; }
    const r = await ctx.call<{ ok: boolean; reason?: string; id?: number; uuid?: string; position?: Pos; tookIt?: boolean }>('vehicle.place', { item: BOAT_ITEM, for: e.id, inVillage: true }, 20_000)
      .catch((x: Error) => ({ ok: false, reason: x.message } as { ok: boolean; reason?: string; id?: number; uuid?: string; position?: Pos; tookIt?: boolean }));
    if (!r.ok || r.id === undefined || !r.uuid) { say(ctx, `the boat did not go down for the villager (${e.id}): ${r.reason ?? 'no reply'}`); continue; }
    const boat: Boat = { id: r.id, uuid: r.uuid };
    const bp = r.position ?? e.position;
    const kept = villagesOf(ctx.world).boat = { uuid: r.uuid, at: { x: Math.floor(bp.x), y: Math.floor(bp.y - 0.01), z: Math.floor(bp.z) }, since: now };
    ctx.save?.();
    if (!r.tookIt) { await takeBoat(ctx, boat); continue; }
    // the way from where the boat came down (it is put beside the villager, not on it)
    const start: BoatAt = { x: bp.x, z: bp.z, level: bp.y };
    const plan = route(start);
    if (!plan.ok) {
      const why = await takeBoat(ctx, boat);
      if (why) return { why: `the boat with the villager (${e.id}) could not be taken up: ${why}` };
      say(ctx, `no boat way to the pickup from where the boat came down at ${fmt(bp)}: ${plan.why}; the villager (${e.id}) let out there, the boat taken back up`);
      noWay ||= `from where the boat came down at ${fmt(bp)}: ${plan.why}`;
      continue;
    }
    const m = await ctx.call<{ ok: boolean; reason?: string; controlling?: boolean }>('vehicle.mount', { id: boat.id, uuid: boat.uuid }, 15_000).catch((x: Error) => ({ ok: false, reason: x.message, controlling: false }));
    if (!m.ok || !m.controlling) { await letGo(ctx, boat); continue; }
    // the drive, leg by leg; each leg judged again from where the boat is (it stops within a block or so of a turn)
    const drive = async (to: { x: number; z: number }, within: number): Promise<string | undefined> => {
      const at = (await ridingOf(ctx))?.position;
      const ms = driveMs(at ? horiz(at, to) : HOP);
      const dr = await ctx.call<{ ok: boolean; reason?: string; at?: Pos }>('vehicle.drive', { to, within, timeoutMs: ms, maxDrop: MAX_DROP, maxOff: 2 }, ms + 15_000)
        .catch((x: Error) => ({ ok: false, reason: x.message, at: undefined }));
      if (dr.at && Number.isFinite(dr.at.x) && Number.isFinite(dr.at.y) && Number.isFinite(dr.at.z)) kept.at = { x: Math.floor(dr.at.x), y: Math.floor(dr.at.y - 0.01), z: Math.floor(dr.at.z) };
      return dr.ok ? undefined : `${dr.reason ?? 'no reply'}${dr.at ? ` at ${fmt(dr.at)}` : ''}`;
    };
    const legs = async (first: { x: number; z: number }[], to: { x: number; z: number }, end: number): Promise<string | undefined> => {
      let rest = first, replans = 0;
      while (rest.length) {
        aborted(ctx);
        const at = (await ridingOf(ctx))?.position;
        if (!at) return 'no longer in the boat';
        const from: BoatAt = { x: at.x, z: at.z, level: at.y };
        if (!checkLeg(g, from, rest[0], t.zones).ok) {
          if (++replans > HOP_REPLANS) return `the way kept failing from ${fmt(at)}`;
          await yieldNow();
          const re = route(from, to, end);
          if (!re.ok) return `no way on from ${fmt(at)}: ${re.why}`;
          rest = re.legs;
          continue;
        }
        const stop = await drive(rest[0], rest.length === 1 ? end : 1.2);
        if (stop) return stop;
        rest = rest.slice(1);
      }
      return undefined;
    };
    if (plan.legs.length > 1 || horiz(bp, mid) > HOP) say(ctx, `in the boat with the villager (${e.id}) at ${fmt(bp)}: to the pickup ${fmt(p)}, ${Math.round(legsLength(bp, plan.legs))} blocks in ${plan.legs.length} leg(s)`);
    const stopped = await legs(plan.legs, mid, 0.5);
    if (stopped) {
      // back to where the boat came down (where the villager stood, in its village), as far as it goes; let out there
      say(ctx, `the hop to the pickup stopped: ${stopped}`);
      const at = (await ridingOf(ctx))?.position;
      if (at && horiz(at, start) > 2) {
        const back = route({ x: at.x, z: at.z, level: at.y }, start, 1);
        const why = back.ok ? await legs(back.legs, start, 1) : back.why;
        if (why) say(ctx, `the way back to where the boat came down did not hold: ${why}`);
      }
      const out = await letGo(ctx, boat);
      if (!out.taken) return { why: `the hop to the pickup stopped (${stopped})${out.text}` };
      const drop = { ...kept.at, y: kept.at.y + 1 };
      const bf = (await boatDrop(ctx, drop)) ? '' : `; its drop not picked up by ${fmt(drop)}`;
      const why = `the hop to the pickup stopped (${stopped})${out.text.replace(/^; /, ': ')}${bf}`;
      say(ctx, why);
      // (no other hop today: the extension next, if any is left, with the boat back in the pockets)
      return { why, ...(bf ? {} : { hop: true as const }) };
    }
    // out to the side of the line (off the cart's way), the boat broken: the villager stands where it sat
    const dx = Math.sign(p.x - along.x), dz = Math.sign(p.z - along.z);
    await ctx.call('vehicle.dismount', { toward: { x: mid.x - dz * 3, z: mid.z + dx * 3 } }, 15_000).catch(() => undefined);
    await pause(500);
    const why = await takeBoat(ctx, boat);
    if (why) return { why: `the boat with the villager could not be taken up: ${why}` };
    // (broken, but its drop not picked up: stepped by it once; still none, no cart goes for the villager, whose way into
    // the hall at the brake is that boat)
    const drop = { ...kept.at, y: kept.at.y + 1 };
    if (!(await boatDrop(ctx, drop))) return { why: `the boat broken at the pickup did not come back into the pockets (its drop by ${fmt(drop)}): no boat for the way into the hall` };
    say(ctx, `the villager (${e.id}) on the pickup ${fmt(p)}`);
    return { e };
  }
  if (late) return { why: late, late: true };
  if (!tried && onPath) return { why: `the ${onPath} villager(s) to take stand on a path, farmland or the like: looked at again when they have wandered`, late: true };
  if (noWay) return { why: `no boat way to the pickup at ${fmt(p)} for a villager to take (${tried} tried): ${noWay}`, hop: true };
  return { why: `no villager could be taken onto the pickup at ${fmt(p)}`, hop: true };
}

// ------------------------------------------------------------------------------------------------ the extension

/**
 * A village's built block (what an extension keeps clear of inside the village's own boxes): its houses, fences, farms,
 * paths, lamps and job sites; not natural ground, plants, trees or water.
 */
const VILLAGE_BUILT = /(planks|stairs|slab|fence|door|glass|_bed$|wool|carpet|hay_block|farmland|^wheat$|^carrots$|^potatoes$|^beetroots$|torch|lantern|composter|bell|lectern|barrel|smoker|blast_furnace|cartography_table|fletching_table|smithing_table|stonecutter|loom|grindstone|cauldron|brewing_stand|stripped_|_wall$|bookshelf|terracotta|cobblestone|chest|crafting_table|dirt_path|ladder|sign|flower_pot|concrete|bricks)/;

/**
 * At most this many extensions of one line (the villagers wander uphill again: the existing misses then). Live, Nov 22:
 * the west village's villagers wandered off from each of two extensions' pickups by the move day; with an extension's
 * rails carried on the move day (EXT_CARRY), each further one is laid to a villager where it stands and the move made
 * in the same run.
 */
export const EXTENSIONS = 5;
/** Cobblestone the move takes out for an extension's fills, as the chests give it. */
const EARTH_CARRY = 24;
/** An extension's rails the move carries while one is left to make (most of a 64-rail extension; the rest from the bill). */
export const EXT_CARRY: Readonly<Record<string, number>> = { rail: 64, powered_rail: 8, redstone_torch: 8 };
/** The extension's search: the box round the village's area and the line's far end, and its size. */
const EXT_ROOM = 8;
const EXT_NODES = 150_000;

type FreeVerdict = Extract<Verdict, { kind: 'free' }>;

/** The line's cells an extension may join at (its launch's and the JOIN_TAIL after it, outside the yard's stretch). */
const joinable = (line: RailLine): RailCell[] => line.cells.slice(0, Math.min(JOIN_TAIL, Math.max(1, goalOf(line) + 1)));
/** The box an extension is planned in (pure): the hop's (the village's area and the pickup) and the line's far end with the tail it may join at, EXT_ROOM round it. */
function extendBox(line: RailLine, area?: { x1: number; z1: number; x2: number; z2: number }): { x1: number; z1: number; x2: number; z2: number } {
  const p = line.pickup;
  const h = hopBox(line, area) ?? { x1: p.x - HOP - 4, z1: p.z - HOP - 4, x2: p.x + HOP + 4, z2: p.z + HOP + 4 };
  // (the line's tail an extension may join at, JOIN_TAIL of its cells, and its stop)
  const ends = [line.stop.at, ...joinable(line)];
  return {
    x1: Math.min(h.x1, ...ends.map(e => e.x - EXT_ROOM)), z1: Math.min(h.z1, ...ends.map(e => e.z - EXT_ROOM)),
    x2: Math.max(h.x2, ...ends.map(e => e.x + EXT_ROOM)), z2: Math.max(h.z2, ...ends.map(e => e.z + EXT_ROOM))
  };
}

/** The ground round the village and the line's far end (the hop's and an extension's), its band from the pickup's, the bell's and the candidates' heights. */
async function villageGround(ctx: GoalContext, line: RailLine, t: HopFrom): Promise<Ground> {
  // (the band of heights over the head's ground and the tail it may join at alike)
  const ys = [line.pickup.y, line.site.y, ...joinable(line).map(c => c.y), line.stop.at.y, ...t.candidates.filter(e => e.position).map(e => Math.floor(e.position!.y))];
  const y0 = Math.min(...ys) - MAX_DROP - 4;
  const g = new Ground(y0, Math.min(64, Math.max(...ys) + 8 - y0 + 1));
  const b = extendBox(line, t.area);
  await g.read(ctx, b.x1, b.z1, b.x2, b.z2);
  return g;
}

/**
 * Whether a villager the judge allows can be brought onto the pickup by boat, by toPickup's own checks (its order and
 * box, a boat's footprint where it stands, a way searched on the ground read), nothing done: `reach` also when there is
 * none to take, none but on paths, or a player by (toPickup's words then); not, with the villagers no way reached it from.
 */
async function hopReach(ctx: GoalContext, line: RailLine, t: HopFrom, g: Ground, force = false): Promise<{ reach: true } | { reach: false; noWay: Seen[]; order: Seen[]; why: string }> {
  const p = line.pickup;
  const mid = { x: p.x + 0.5, z: p.z + 0.5 };
  const box = hopBox(line, t.area);
  const bounds = box ?? { x1: p.x - HOP - 4, z1: p.z - HOP - 4, x2: p.x + HOP + 4, z2: p.z + HOP + 4 };
  const inBox = (q: { x: number; z: number }) => q.x >= bounds.x1 && q.x < bounds.x2 + 1 && q.z >= bounds.z1 && q.z < bounds.z2 + 1;
  const round = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: PLAYER_SIGHT }).catch(() => undefined))?.entities;
  if (!round) return { reach: true };
  if (playerNow(round, await here(ctx), siteFor(villagesOf(ctx.world).sites, line.site)?.area ?? t.area)) return { reach: true };
  const ids = new Set(t.candidates.map(c => c.id));
  const order = round.filter(e => e.name === 'villager' && e.position && ids.has(e.id) && !notFree(e, t.jobs) && inBox(e.position))
    .sort((a, b) => horiz(a.position!, mid) - horiz(b.position!, mid));
  // (the real hop failed after this check found a way: every one in sight is one no boat brought, today)
  if (force) return order.length ? { reach: false, noWay: order, order, why: '' } : { reach: true };
  const noWay: Seen[] = [];
  // (one with no room for a boat where it stands: on a path, or among steps a levelled head's hop may cut)
  const stuck: Seen[] = [];
  let tried = 0, why = '';
  for (const e of order) {
    aborted(ctx);
    if (horiz(e.position!, mid) <= 0.3) return { reach: true };
    if (tried >= HOP_TRIES) break;
    await yieldNow();
    const at0 = e.position!;
    const fp = footprint(g, at0.x, at0.z, at0.y, false);
    if (!fp.ok) { stuck.push(e); why ||= `no room for a boat by the villager (${e.id}) at ${fmt(at0)}: ${fp.why} at ${fmt(fp.at)}`; continue; }
    tried++;
    const r = planRoute(g, { x: at0.x, z: at0.z, level: at0.y }, mid, { zones: t.zones, bounds, within: 0.5, maxNodes: HOP_NODES });
    if (r.ok) return { reach: true };
    noWay.push(e);
    why ||= `from the villager (${e.id}) at ${fmt(at0)}: ${r.why}`;
  }
  // (none a way reached: those with no room for a boat too, for an extension levelled by them)
  return noWay.length || (stuck.length && ctx.rails?.cut) ? { reach: false, noWay: [...noWay, ...stuck], order, why } : { reach: true };
}

/**
 * The extension planned on the ground read (pure but for the searches): to a pickup by a villager no boat way reached the
 * pickup from (the nearest to the line's end first), else by the bell (where the villagers gather), and kept only if a
 * villager the judge allows can be brought to its pickup by boat (or stands on it). Kept clear: the village's own houses
 * (its zones' boxes), its beds, job sites and bells; FROM_ZONES off every other build (and off those of the village's
 * own the line's area does not meet: zonesOnLine reads them as someone's), an outpost wider (wayZones); never into the yard.
 */
export function extensionFor(line: RailLine, g: Ground, t: {
  noWay: readonly Seen[]; order: readonly Seen[]; look: Pick<VillageLook, 'jobs' | 'beds' | 'bells' | 'zones'> & { seen?: readonly Seen[] }; v: Pick<FreeVerdict, 'own' | 'outposts'>;
  area?: { x1: number; z1: number; x2: number; z2: number }; yard: { x1: number; z1: number; x2: number; z2: number }; maxNodes?: number;
  /** the earthworks may be made (the runtime has the rails tools' cut and restore): tried when no head stands as the ground is */
  earth?: boolean;
  /** at most this many cuts and fills (EARTH_MAX) */
  earthMax?: number;
}): RailExtension | { ok: false; why: string } {
  const join = line.cells[0];
  const meets = (z: Zone, a?: { x1: number; z1: number; x2: number; z2: number }) => !!a && z.x1 <= a.x2 && z.x2 >= a.x1 && z.z1 <= a.z2 && z.z2 >= a.z1;
  const zones = [...wayZones(t.look, t.v), ...t.look.zones.filter(z => t.v.own.includes(z) && !meets(z, t.area))];
  const marks = [...t.look.jobs.map(j => j.at), ...t.look.beds, ...t.look.bells];
  const own = t.v.own;
  const ends = new Set([...joinable(line).map(c => key(c)), key(line.stop.at)]);
  // (the village's own builds kept clear block by block, not box by box: live, Nov 22, the west village's scan gave one
  // box of 87 by 68 round all of it, every villager inside, and no head could lie by any of them. A cell inside a box
  // of the village's own is kept clear when a built block of it stands within `pad` of it, a block or two up or down;
  // the line's own rails, torches and stop are none)
  const ours = new Set([...line.laid.map(b => key(b.at)), key(line.stop.at)]);
  const builtAt = (x: number, y: number, z: number): boolean => {
    const st = g.state(x, y, z);
    return !!st && !ours.has(`${x},${y},${z}`) && VILLAGE_BUILT.test(idOf(st));
  };
  const inOwn = (x: number, y: number, z: number, pad: number) => own.some(o => x >= o.x1 - pad && x <= o.x2 + pad && z >= o.z1 - pad && z <= o.z2 + pad && y >= o.y1 - 3 && y <= o.y2 + 1);
  const byBuilt = (x: number, y: number, z: number, pad: number): boolean => {
    if (!inOwn(x, y, z, pad)) return false;
    for (let dx = -pad; dx <= pad; dx++) for (let dz = -pad; dz <= pad; dz++) for (let dy = -2; dy <= 2; dy++) if (builtAt(x + dx, y + dy, z + dz)) return true;
    return false;
  };
  const avoid = (x: number, y: number, z: number): boolean => !ends.has(`${x},${y},${z}`)
    && (marks.some(m => Math.abs(m.x - x) <= 1 && Math.abs(m.z - z) <= 1 && Math.abs(m.y - y) <= 2) || byBuilt(x, y, z, 0));
  const bounds = extendBox(line, t.area);
  const reached = (r: RailExtension): boolean => {
    // (on the ground as the extension's cuts and fills leave it)
    const lv = earthed((x, y, z) => g.state(x, y, z), r.earth);
    const gg = r.earth.length ? { cell: (x: number, y: number, z: number) => cellOf(lv(x, y, z)) } : g;
    const mid = { x: r.pickup.x + 0.5, z: r.pickup.z + 0.5 };
    const hb = hopBox({ pickup: r.pickup, area: t.area ?? line.area });
    const box = hb ?? { x1: r.pickup.x - HOP - 4, z1: r.pickup.z - HOP - 4, x2: r.pickup.x + HOP + 4, z2: r.pickup.z + HOP + 4 };
    let tried = 0;
    for (const e of [...t.order].sort((a, b) => horiz(a.position!, mid) - horiz(b.position!, mid))) {
      if (horiz(e.position!, mid) <= 0.3) return true;
      if (tried >= HOP_TRIES) break;
      if (!footprint(gg, e.position!.x, e.position!.z, e.position!.y, false).ok) continue;
      tried++;
      if (planRoute(gg, { x: e.position!.x, z: e.position!.z, level: e.position!.y }, mid, { zones, bounds: box, within: 0.5, maxNodes: HOP_NODES }).ok) return true;
    }
    return false;
  };
  // (the line as it stands, its torches, and the bot's own fills under it from an extension before: ground)
  const lineNow = { cells: line.cells, stop: line.stop, torches: line.torches };
  const ground = (line.earth ?? []).filter(w => w.op === 'fill' && w.done).map(w => ({ x: w.x, y: w.y, z: w.z }));
  const joinTail = joinable(line).length;
  const plan = (candidates: { id: number; position?: Pos }[]) => planExtension(g, {
    candidates, yard: t.yard, zones, bounds, avoid, maxNodes: t.maxNodes ?? EXT_NODES, line: lineNow, ground, joinTail
  });
  const byVillager = plan([...t.noWay].sort((a, b) => horiz(a.position!, join) - horiz(b.position!, join)));
  if (byVillager.ok && reached(byVillager)) return byVillager;
  // (where the villagers gather: the sides of the bell nearest the line's end)
  const bells = [...t.look.bells].sort((a, b) => horiz(a, join) - horiz(b, join)).slice(0, 1);
  const sidesOf = bells.flatMap(b => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ id: -1, position: { x: b.x + dx + 0.5, y: b.y, z: b.z + dz + 0.5 } })));
  const byBell = sidesOf.length ? plan(sidesOf) : undefined;
  if (byBell?.ok && reached(byBell)) return byBell;
  const why0 = !byVillager.ok ? byVillager.why : 'no villager the judge allows could be brought by boat to the pickup it would have';
  const why = byBell && !byBell.ok && byVillager.ok ? `${why0}; by the bell: ${byBell.why}` : why0;
  if (!t.earth) return { ok: false, why };
  // the ground levelled (the user's of Nov 21): a head right beside a villager the judge allows (EARTH_NEAR), its
  // cells, the stop's and the torch's cut or filled level with where it stands, the boat's hop to it and the way's
  // steps too, within the earthworks' rules; never under a villager, a bed, a job site or a bell, in a house of the
  // village or by anyone else's build
  const villagers = [...(t.look.seen ?? []), ...t.order].filter(e => e.name === 'villager' && e.position).map(e => e.position!);
  const may = (x: number, y: number, z: number): boolean => !ends.has(`${x},${y},${z}`)
    && !marks.some(m => Math.abs(m.x - x) <= 1 && Math.abs(m.z - z) <= 1 && Math.abs(m.y - y) <= 2)
    && !byBuilt(x, y, z, 1)
    && !villagers.some(p => Math.abs(p.x - (x + 0.5)) < 0.9 && Math.abs(p.z - (z + 0.5)) < 0.9)
    && !zoneNear(zones, { x: x + 0.5, y, z: z + 0.5 }, FROM_ZONES);
  const near = [...t.order].sort((a, b) => horiz(a.position!, join) - horiz(b.position!, join));
  const levelled = planExtension(g, {
    candidates: near, yard: t.yard, zones, bounds, avoid, maxNodes: t.maxNodes ?? EXT_NODES * 2, line: lineNow, ground, joinTail,
    earth: { may, max: t.earthMax ?? EARTH_MAX }
  });
  if (levelled.ok && reached(levelled)) return levelled;
  return { ok: false, why: `${why}; levelled by a villager: ${levelled.ok ? 'no villager the judge allows could be brought by boat to its pickup' : levelled.why}` };
}

/** The extension written into the line (before anything of it goes down): the new head, the rails to the old launch's cell, the torches, the village's area as judged today. */
function applyExtension(line: RailLine, r: RailExtension, area: RailLine['area'], now: number): void {
  const join = line.cells[r.skip];
  // (the line from the join on; the cells before it bypassed, and their torches and the old trigger: no longer the
  // plan's, the record's strays, taken up before the laying goes on and by the take-up)
  const kept = line.cells.slice(r.skip + 1);
  line.cells = [...r.cells.map(c => ({ ...c })), ...kept];
  line.torches = [...line.torches.filter(t => !t.trigger && kept.some(c => same(c, t.lights))), ...r.torches.map(t => ({ ...t, at: { ...t.at }, lights: { ...t.lights } }))];
  line.stop = { at: { ...r.stop.at }, placed: r.stop.placed };
  line.pickup = { ...r.pickup };
  line.villager = r.villager;
  line.from = { ...r.from };
  if (area) line.area = { ...area };
  line.extended = { at: now, from: { x: join.x, y: join.y, z: join.z }, to: { ...r.pickup }, rails: r.cells.length, powered: r.powered, times: (line.extended?.times ?? 0) + 1 };
  // (its cuts and fills, each with what stood there: in the record before any is made, as the rails are)
  if (r.earth.length) line.earth = [...(line.earth ?? []), ...r.earth.map(w => ({ ...w }))];
  // the line is planned afresh at its far end and its ground read today: its MAX_AGE clock starts again
  line.at = now;
}

/** The last extension not all down yet. */
const extendedDown = (line: RailLine): boolean => {
  const e = line.extended;
  if (!e) return false;
  const fit = laidCells(line);
  for (let i = 0; i < Math.min(e.rails, line.cells.length); i++) if (!fit.has(i)) return true;
  return false;
};
/** Said after each laying of an extension: how much of it is down. */
function sayExtension(ctx: GoalContext, line: RailLine, put: number): void {
  const e = line.extended;
  if (!e) return;
  const fit = laidCells(line);
  let down = 0;
  for (let i = 0; i < Math.min(e.rails, line.cells.length); i++) if (fit.has(i)) down++;
  say(ctx, down >= e.rails
    ? `the extension into the village is down: ${e.rails} rails (${e.powered} powered) to the new pickup ${fmt(e.to)}, ${put} block(s) laid this run`
    : `the extension into the village: ${down} of ${e.rails} rails down, ${put} block(s) laid this run; the rest on the next run`);
}

/**
 * On the move day, after the look and its verdict (the brief's of Nov 21; `failed`: the real hop did not bring a
 * villager where the dry check found a way, the extension tried in the same run): when no villager the judge allows can be
 * brought to the pickup by boat (the hill between: "a step up (a boat climbs nothing)"), the line is extended into the
 * village (extensionFor), written into the record first, the old launch's powered rail, the old stop and the old trigger
 * taken up (upStrays: a plain rail goes where the launch was), and laid out to its new head while the move after it
 * still fits the run; then the move goes on from the new pickup (undefined). Not carried, out of time, or stopped: the
 * rest is laid on the next run (the bill first, if not carried), not a miss. Not to be planned: not made today, not a miss.
 */
async function extendFor(ctx: GoalContext, line: RailLine, t: HopFrom, look: VillageLook, v: FreeVerdict, clk: Clk, home: { x: number; z: number }, failed?: string): Promise<WorkResult | undefined> {
  const g = t.ground ?? await villageGround(ctx, line, t);
  t.ground = g;
  const reach = await hopReach(ctx, line, t, g, failed !== undefined);
  if (reach.reach) return failed === undefined ? undefined : notToday(ctx, line, `${failed}; no villager the judge allows in sight to extend the line to`, true);
  const hopWhy = failed !== undefined ? `the boat's hop did not bring a villager to the pickup at ${fmt(line.pickup)}: ${failed}`
    : `no boat way to the pickup at ${fmt(line.pickup)} for a villager to take (${reach.noWay.length} tried): ${reach.why}`;
  if ((line.extended?.times ?? 0) >= EXTENSIONS) return failed === undefined ? undefined : notToday(ctx, line, failed, 'miss');
  const yard = ctx.world.yard;
  if (!yard) return notToday(ctx, line, `${hopWhy}; the line not extended: no yard known`, true);
  const area = joinAreas(line.area, v.area);
  await yieldNow();
  const ext = { noWay: reach.noWay, order: reach.order, look, v, area, yard, earth: !!ctx.rails?.cut && !!ctx.rails?.restore };
  const r = extensionFor(line, g, ext);
  // (a failed plan's inputs and ground kept beside brain.log, for a replay offline)
  if (!r.ok) ctx.dump?.('extension', { why: r.why, line, ext, ground: g.dump() });
  if (!r.ok) return notToday(ctx, line, `${hopWhy}; and no extension of the line into the village: ${r.why}`, true);
  const from = line.cells[r.skip];
  applyExtension(line, r, area, clk.now());
  // (written before any of it goes down, the old launch's rail and the stop still in the record: a run cut short lays
  // on from here, the strays taken up first)
  line.stage = 'laying';
  ctx.save?.();
  say(ctx, `${hopWhy}`);
  say(ctx, `the line extended into the village: ${r.cells.length} rails (${r.powered} powered) from ${fmt(from)} to the new pickup ${fmt(r.pickup)}`);
  if (r.skip) say(ctx, `it joins the line ${r.skip} rails in from its old launch: the ${r.skip} before the join, their torches and the old stop taken up first`);
  say(ctx, `the extension's route ${r.route}; the launch, the stop${r.stop.placed ? ' (a cobblestone)' : ' (the ground)'} and the cart's start at its end, by the villager (${r.villager < 0 ? 'the bell' : r.villager}) at ${fmt(r.from)}`);
  if (r.earth.length) {
    const cuts = r.earth.filter(w => w.op === 'cut'), fills = r.earth.length - cuts.length;
    const kinds = [...new Set(cuts.map(w => idOf(w.was)))].join(', ');
    say(ctx, `the ground levelled for it: ${cuts.length} cut(s)${kinds ? ` (${kinds})` : ''}, ${fills} fill(s) of cobblestone${r.earth.some(w => w.hop) ? `, ${r.earth.filter(w => w.hop).length} of the cuts in the boat's hop` : ''}; every one in the record, put back by the take-up`);
  }
  const stray = await upStrays(ctx, line);
  if (stray) {
    const text = `the line extended into the village; ${stray}: the laying on the next run`;
    say(ctx, text);
    return { gain: 0, text, mark: 'same' };
  }
  // what it takes, carried (the move carried a torch for the trigger: one for the new one besides)
  const keys = fitKeys(line, true);
  const todo = outwardSteps(line).filter(st => !keys.has(key(stepAt(line, st))));
  const need: Record<string, number> = {};
  for (const st of todo) need[stepItem(line, st)] = (need[stepItem(line, st)] ?? 0) + 1;
  const trig = triggerOf(line);
  if (trig && !isLaid(line, trig.at)) need.redstone_torch = (need.redstone_torch ?? 0) + 1;
  if (pendingFills(line)) need.cobblestone = (need.cobblestone ?? 0) + pendingFills(line);
  const have = await countsNow(ctx);
  const short = Object.entries(need).filter(([item, n]) => (have.get(item) ?? 0) < n).map(([item, n]) => `${n - (have.get(item) ?? 0)} ${item}`);
  if (short.length) {
    line.stage = 'bill';
    ctx.save?.();
    const text = `the line extended into the village (${r.cells.length} rails): short of ${short.join(', ')} out here; the bill on the next run, then the laying`;
    say(ctx, text);
    return { gain: 0, text, mark: 'same' };
  }
  // laid now while the move after it still fits the run (the hop, the cart, home along the whole line, the yard)
  const laid = await layOn(ctx, line, todo, clk, () => moveRest(line, home) + MARGIN);
  sayExtension(ctx, line, laid.put);
  if (laid.kind === 'end') return laid.result;
  if (laid.kind === 'off') return { gain: laid.put, text: `the extension: laid ${laid.put}; ${OFF_NOW}` };
  if (laid.kind !== 'done') {
    clean(line);
    const text = `the extension laid ${laid.put} this run (${laid.kind === 'late' ? `the run's time: on from ${fmt(laid.at)}` : `out of ${laid.item}`}); the rest and the move on the next runs`;
    return { gain: laid.put, text, ...(laid.put ? {} : { mark: 'same' as const }) };
  }
  // whole: the move goes on from the new pickup (the hop's ground as the cuts and fills left it)
  for (const w of line.earth ?? []) if (w.done) g.set(w.x, w.y, w.z, w.op === 'cut' ? 'air' : 'cobblestone');
  line.stage = 'moving';
  ctx.save?.();
  await walkTo(ctx, line.pickup, 3);
  return undefined;
}

/** The boat's item back in the pockets once it is broken: its drop stepped by once if not; whether it is. */
async function boatDrop(ctx: GoalContext, at: Pos): Promise<boolean> {
  if ((await countsNow(ctx)).get(BOAT_ITEM)) return true;
  await ctx.call('goto', { ...at, range: 1, careful: true, timeoutMs: 10_000 }, 20_000).catch(() => undefined);
  await pause(600);
  return !!(await countsNow(ctx)).get(BOAT_ITEM);
}

/**
 * The bot's boat a hop to the pickup left there (villages.boat near the pickup: a restart, a death or a take that failed
 * between the boat going down and its take), the villager perhaps seated in it: looked for by its place (world.entities;
 * after a restart the client's own set is gone, so any boat by the pickup, the kept uuid first) and broken back
 * (vehicle.take with the kept uuid: the bridge refuses any boat but that one). The villager steps out where it sits, in its
 * own village. None kept there, or taken: undefined; none there with the bot by the pickup: forgotten. Why not, else.
 */
async function boatAtPickup(ctx: GoalContext, line: RailLine): Promise<string | undefined> {
  const v = villagesOf(ctx.world);
  const kept = v.boat;
  const mid = { x: line.pickup.x + 0.5, z: line.pickup.z + 0.5 };
  if (!kept || !byHop(ctx.world, line, kept.at)) return undefined;
  // (one a hop left out in the village, away from the pickup: looked for where it was left)
  if (horiz(await here(ctx), kept.at) > 16) await walkTo(ctx, { ...kept.at, y: kept.at.y + 1 }, 3);
  const round = (await ctx.call<{ entities?: (Seen & { uuid?: string })[] }>('world.entities', { maxDistance: 64 }).catch(() => undefined))?.entities;
  if (!round) return `the boat left at ${fmt(kept.at)} not looked for (nothing read)`;
  const boats = round.filter(x => /boat$/.test(x.name) && x.position && (x.uuid === kept.uuid || horiz(x.position, mid) <= HOP + 6 || horiz(x.position, kept.at) <= 6))
    .sort((a, b) => (a.uuid === kept.uuid ? -1 : 0) - (b.uuid === kept.uuid ? -1 : 0) || horiz(a.position!, kept.at) - horiz(b.position!, kept.at));
  if (!boats.length) {
    if (horiz(await here(ctx), kept.at) > 24) return `the boat left at ${fmt(kept.at)} not in sight`;
    delete v.boat;
    ctx.save?.();
    say(ctx, `the boat once left at ${fmt(kept.at)} is not there any more: forgotten`);
    return undefined;
  }
  const whys: string[] = [];
  for (const b of boats) {
    aborted(ctx);
    const p = b.position!;
    await ctx.call('goto', { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), range: 2, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);
    const r = await takeBoat(ctx, { id: b.id, uuid: kept.uuid });
    if (!r) { say(ctx, `the boat a hop cut short left at ${fmt(p)} taken back up (whoever sat in it out where it was)`); return undefined; }
    whys.push(r);
  }
  // (every boat there someone else's, the bridge's word by the kept uuid: the bot's own is gone)
  if (whys.every(w => /^not the bot's own/.test(w))) {
    delete v.boat;
    ctx.save?.();
    say(ctx, `the boat once left at ${fmt(kept.at)} is not there any more (the boats by the pickup are not the bot's): forgotten`);
    return undefined;
  }
  return `the boat left at ${fmt(kept.at)} not taken back up: ${whys.find(w => !/^not the bot's own/.test(w))}`;
}

/**
 * The cart on the launch and the trigger torch put down from behind the stop (the bot off the line's way): the cart
 * goes, and is watched until it takes someone in or comes to rest. `took`, `missed` (at rest, or out of sight with the
 * villager still on the pickup), or `fail`.
 */
type Launched = { took: true } | { missed: string } | { blocked: string } | { fail: string; out?: true } | { unsure: string };
async function launch(ctx: GoalContext, line: RailLine, e: Seen): Promise<Launched> {
  const trig = triggerOf(line);
  if (!trig) return { fail: 'no trigger torch in the plan' };
  const launchAt = line.cells[0];
  const stop = line.stop.at;
  const behind = { x: stop.x * 2 - launchAt.x, y: stop.y, z: stop.z * 2 - launchAt.z };
  await ctx.call('goto', { ...behind, range: 1, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
  // (an empty moving cart takes the first mob it runs into: a cat, a chicken or a baby villager on the head would ride
  // it home onto the brake, for good)
  const other = await mobOnHead(ctx, line, e.id);
  if (other) return { blocked: `${other}: the cart not put down` };
  const village = inVillage(line, launchAt);
  // (a cart a run cut short left on the launch, unnamed: found and taken back up first, the launch clear for this one)
  const stale = !line.cart && line.cartAt ? await findCartAt(ctx, line) : 'none';
  if (stale === 'found') {
    const back = await takeCart(ctx, line);
    if (back) return { fail: `the cart a run cut short left on the launch not taken back up: ${back}` };
  }
  // (written before the call, and named as soon as it answers: a run cut short as the cart goes down, a kill, or a
  // reply lost must not leave a cart on the launch that nothing in brain.json names)
  line.cartAt = { x: launchAt.x, y: launchAt.y, z: launchAt.z };
  ctx.save?.();
  const c = await ctx.rails!.placeCart(launchAt, village ? { inVillage: true } : {}).catch((x: Error): CartPlaced => ({ ok: false, reason: x.message }));
  if (c.ok && c.id !== undefined && c.uuid) {
    line.cart = { uuid: c.uuid, id: c.id };
    delete line.cartAt;
    ctx.save?.();
  }
  aborted(ctx);
  if (!line.cart) {
    // (a cart down all the same, the reply lost: the bot's own, named for the take-up; one there before this call is
    // not, unless a run cut short left one there unseen: never adopted)
    if (/^a minecart on that rail already/.test(c.reason ?? '') && stale !== 'unseen') { delete line.cartAt; ctx.save?.(); } else if (!/timed out|connection closed/.test(c.reason ?? '')) await findCartAt(ctx, line);
    else if (await findCartAt(ctx, line, false) === 'none') {
      // (a call that timed out is not called off: its use may wait on the client's ticks behind this first look, which
      // then sees no cart; looked at once more after a moment, the cart down by then if it is to come)
      await pause(LOST_LOOK_MS);
      await findCartAt(ctx, line);
    }
    return { fail: `no minecart on the launch at ${fmt(launchAt)}: ${c.reason ?? 'no reply'}` };
  }
  // (looked at again with the cart down, right before the trigger: a mob come onto the head meanwhile, the cart back up)
  const since = await mobOnHead(ctx, line, e.id);
  if (since) {
    const back = await takeCart(ctx, line);
    if (back) return { fail: `${since} as the cart went down, and the cart not taken back up: ${back}` };
    return { blocked: `${since}: the cart taken back up before the trigger` };
  }
  // (the villager it goes for, written before the trigger (the lay saves): a run cut short as the cart rolls takes into
  // the hall only that one, never whatever else the cart took)
  line.aimed = e.id;
  const r = await lay(ctx, line, { kind: 'torch', t: trig }, { at: trig.at, item: 'redstone_torch', lights: trig.lights, ...(inVillage(line, trig.at) ? { inVillage: true } : {}) });
  if (!r.placed) return afterTrigger(ctx, line, e.id, `the trigger torch not put down at ${fmt(trig.at)}: ${r.reason ?? 'no answer'}`);
  if (!r.ok) return afterTrigger(ctx, line, e.id, `the trigger torch is down but the launch not lit: ${r.reason ?? 'no answer'}`);
  const w = await ctx.call<CartWatched>('cart.watch', { id: c.id, uuid: c.uuid, until: 'either', timeoutMs: 20_000 }, 35_000)
    .catch((x: Error): CartWatched => ({ ok: false, reason: x.message }));
  aborted(ctx);
  if (w.reason === 'took') {
    if (w.took?.includes(e.id)) return { took: true };
    // (a mob of the village rolling home in the cart, through the open post: out of its village, the moves wait for the
    // lead; the take-up leaves a villager or a monster seated in it in the yard, never let out loose there)
    const what = (w.took ?? []).map(id => { const q = w.passengers?.find(x => x.id === id); return `${q?.name ?? 'a mob'}${q?.baby ? ' (a baby)' : ''} ${id}`; }).join(', ');
    return { fail: `the cart took another (${what}), not the villager (${e.id}): it rolls home with it`, out: true };
  }
  if (w.reason === 'at rest' || w.reason === 'timed out') return { missed: `the cart came to rest at ${w.at ? fmt(w.at) : 'where it is'} without it` };
  if (w.reason === 'out of sight') {
    const seen = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 24, type: 'villager' }).catch(() => undefined))?.entities ?? [];
    const still = seen.find(x => x.id === e.id && x.position && !x.vehicle);
    return still ? { fail: 'the cart ran out of sight without the villager' } : { took: true };
  }
  if (w.reason === 'died' || w.reason === 'cancelled') throw new Error('aborted');
  return afterTrigger(ctx, line, e.id, `the cart's watch ended: ${w.reason ?? 'no reply'}`);
}

/**
 * A launch that did not answer `took` or `missed` once its trigger was tried (the torch's reply lost, the launch read
 * unlit, the watch's reply lost or the client dropped): the cart may have gone all the same, the villager in it, so it
 * is read by its uuid before the move is called a failure. The villager it went for in it: `took`. Another mob: the
 * move lost (`out`: the moves off, its way home held). Empty and at rest, or out of sight with the villager seen on foot:
 * a plain failure (the take-up breaks the cart). Not read, or still rolling empty: `unsure`, the move kept under way for
 * the next run's resumeMove, which reads the cart by `aimed`.
 */
async function afterTrigger(ctx: GoalContext, line: RailLine, villager: number, why: string): Promise<Launched> {
  const { cart, read } = await cartNow(ctx, line);
  if (cart?.passengers?.some(q => q.id === villager)) return { took: true };
  const other = cart?.passengers?.find(q => q.id !== villager);
  if (other) return { fail: `${why}; the cart holds another (${other.name ?? 'a mob'}${other.baby ? ' (a baby)' : ''} ${other.id}), not the villager (${villager})`, out: true };
  if (cart && !cart.moving) return { fail: why };
  if (read && !cart) {
    const seen = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 24, type: 'villager' }).catch(() => undefined))?.entities;
    if (seen?.some(x => x.id === villager && x.position && !x.vehicle)) return { fail: `${why}; the cart out of sight, the villager still on foot` };
  }
  return { unsure: `${why}; the cart ${cart ? 'still rolling, empty' : 'not in sight'}` };
}

/**
 * A mob other than the villager `but` on the line's head, from the launch to the first lit rail (world.entities): what
 * and where, or undefined. A moving empty cart takes in any living mob but a player, an iron golem, or one riding.
 */
async function mobOnHead(ctx: GoalContext, line: RailLine, but: number): Promise<string | undefined> {
  const head = line.cells.slice(0, FIRST_BOOST - HEAD.launch + 1);
  const round = (await ctx.call<{ entities?: (Seen & { health?: number })[] }>('world.entities', { maxDistance: 32 }).catch(() => undefined))?.entities ?? [];
  const m = round.find(x => x.id !== but && x.position && x.health !== undefined && !/^(player|iron_golem)$/.test(x.name) && !x.vehicle
    && head.some(c => horiz(x.position!, { x: c.x + 0.5, z: c.z + 0.5 }) <= 1.5 && Math.abs(x.position!.y - c.y) < 2));
  return m ? `a ${m.name}${m.baby ? ' (a baby)' : ''} on the line's head at ${fmt(m.position!)}` : undefined;
}

/**
 * A cart put on the launch that nothing names (line.cartAt: the run cut short, a kill or the reply lost as cart.place
 * answered), looked for there by its place: the bot's own within 128 (cart.status), else any minecart on the launch
 * (world.entities: the client's own set is gone after a restart) named by cart.status by its id, which makes it the
 * bot's own again. `found` (line.cart named), `none` (the launch in sight with no cart on it: cartAt cleared), or
 * `unseen` (too far to tell, or not read: kept for a later look).
 */
async function findCartAt(ctx: GoalContext, line: RailLine, clear = true): Promise<'found' | 'none' | 'unseen'> {
  const at = line.cartAt;
  if (line.cart) { if (at) { delete line.cartAt; ctx.save?.(); } return 'found'; }
  if (!at || !isPos(at)) { delete line.cartAt; return 'none'; }
  const mid = { x: at.x + 0.5, z: at.z + 0.5 };
  const on = (q?: Pos) => !!q && horiz(q, mid) <= 1.5 && Math.abs(q.y - at.y) <= 1.5;
  const name = (c: { uuid: string; id?: number }) => { line.cart = c; delete line.cartAt; ctx.save?.(); return 'found' as const; };
  const own = (await ctx.call<CartStatus>('cart.status', {}).catch(() => undefined))?.carts?.find(x => x.uuid && on(x.position));
  if (own?.uuid) return name({ uuid: own.uuid, id: own.id });
  const seen = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 96, type: 'minecart' }).catch(() => undefined))?.entities;
  if (!seen) return 'unseen';
  const e = seen.find(x => on(x.position));
  if (e) {
    const c = (await ctx.call<CartStatus>('cart.status', { id: e.id }).catch(() => undefined))?.carts?.find(x => x.id === e.id);
    return c?.uuid ? name({ uuid: c.uuid, id: e.id }) : 'unseen';
  }
  if (horiz(await here(ctx), mid) > 48) return 'unseen';
  if (!clear) return 'none';
  delete line.cartAt;
  ctx.save?.();
  return 'none';
}
/** How long after a first look that found nothing a call that timed out is looked at again (its use done by then). */
const LOST_LOOK_MS = 2000;

/** A cart that missed taken back up (vehicle.take, walked to), and the trigger torch taken up (the launch unlit again). Why not, or undefined. */
async function recoverCart(ctx: GoalContext, line: RailLine): Promise<string | undefined> {
  const trig = triggerOf(line);
  if (trig && isLaid(line, trig.at)) {
    const t = await takeUp(ctx, line, trig.at);
    if (!t.ok) return `the trigger torch: ${t.reason ?? 'no answer'}`;
    forget(line, trig.at);
  }
  return takeCart(ctx, line);
}

/** The bot's cart walked to and broken back into its item (vehicle.take). Why not, or undefined. */
async function takeCart(ctx: GoalContext, line: RailLine): Promise<string | undefined> {
  if (!line.cart) return undefined;
  const { cart } = await cartNow(ctx, line);
  if (!cart) return 'not in sight';
  if (cart.position) await ctx.call('goto', { x: Math.floor(cart.position.x), y: Math.floor(cart.position.y), z: Math.floor(cart.position.z), range: 2, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);
  const r = await ctx.call<{ ok: boolean; reason?: string }>('vehicle.take', { id: cart.id, uuid: line.cart.uuid }, 30_000).catch((x: Error) => ({ ok: false, reason: x.message }));
  if (!r.ok) return r.reason ?? 'no reply';
  delete line.cart;
  delete line.aimed;
  ctx.save?.();
  return undefined;
}

/**
 * Home on foot along the line behind the cart: a stop every WALK_EVERY rails from the pickup to the fence, the cart
 * looked at from each (once in sight): the villager still in it, and not come to rest short of the brake (a cart within
 * the server's simulation distance that has stopped there stays stopped). At the fence, the cart on the brake. Why
 * not, or undefined.
 */
async function followHome(ctx: GoalContext, line: RailLine, villager: number, clk: Clk, from: number = HEAD.pickup - HEAD.launch): Promise<string | undefined> {
  const g = goalOf(line);
  const stuck = async (): Promise<string | undefined> => {
    const { cart, simulation } = await cartNow(ctx, line);
    if (!cart) return undefined;
    if (!cart.passengers?.some(q => q.id === villager)) return `the villager (${villager}) is out of the cart at ${cart.position ? fmt(cart.position) : '?'}`;
    const i = cellIndexAt(line, cart);
    if (!cart.moving && simulatedAt(cart, simulation) && !onBrake(line, i)) {
      await pause(3000);
      const again = (await cartNow(ctx, line)).cart;
      if (again && !again.moving && !onBrake(line, cellIndexAt(line, again))) return `the cart came to rest short of the brake at ${again.position ? fmt(again.position) : '?'}`;
    }
    return undefined;
  };
  for (let i = Math.max(0, Math.min(g, from)); i <= g; i = Math.min(g, i + WALK_EVERY)) {
    aborted(ctx);
    await walkTo(ctx, line.cells[i], 3);
    const why = await stuck();
    if (why) return why;
    if (i === g) break;
  }
  // at the fence: the cart on the brake, at rest
  const deadline = clk.now() + BRAKE_WAIT;
  for (let n = 0; ; n++) {
    aborted(ctx);
    const { cart } = await cartNow(ctx, line);
    if (cart && !cart.passengers?.some(q => q.id === villager)) return `the villager (${villager}) is out of the cart at ${cart.position ? fmt(cart.position) : '?'}`;
    if (cart && !cart.moving && onBrake(line, cellIndexAt(line, cart))) return undefined;
    // (the looks counted too: a clock that does not move on while it waits is no endless wait)
    if (clk.now() > deadline || n > BRAKE_WAIT / 2000) return cart ? `the cart not at rest on the brake (at ${cart.position ? fmt(cart.position) : '?'})` : 'the cart not in sight at the yard';
    if (cart?.id !== undefined) await ctx.call('cart.watch', { id: cart.id, uuid: line.cart!.uuid, until: 'rest', timeoutMs: 10_000 }, 20_000).catch(() => undefined);
    else await pause(2000);
  }
}

/**
 * At the brake: into the yard by the post's gap, the post's rail taken up and the fence put back as it was (the yard
 * shut before the villager is out), the cart broken (the villager steps out on the brake), the boat into the hall
 * (villagemove.ts boatIntoHall). Then the hall counted, the move said, and the take-up as far as the day goes.
 */
async function intoHall(ctx: GoalContext, line: RailLine, villager: number, clk: Clk): Promise<WorkResult> {
  const shut = await shutYard(ctx, line);
  if (shut) return lostOut(ctx, line, `${shut} (the villager left in the cart at the brake)`);
  // the cart broken: the villager steps out where it sat, in the shut yard
  const { cart } = await cartNow(ctx, line);
  if (!cart) return lostOut(ctx, line, 'the cart not in sight at the brake');
  // (the boat that takes it into the hall carried first, from the chests if the stash put it away: none, the villager
  // stays seated in the cart in the shut yard, the move under way, and the next run tries again)
  const noBoat = await boatShort(ctx, line, villager, 'kept seated in the cart on the brake');
  if (noBoat) return noBoat;
  // (the boat's way read first, the villager still seated: a read that fails leaves it in the cart, never loose)
  const way = await hallWay(ctx, line.entry);
  if ('why' in way) return lostOut(ctx, line, `${way.why} (the villager left in the cart at the brake, the yard shut)`);
  const at = cart.position;
  const took = await takeCart(ctx, line);
  if (took) {
    // (broken all the same, its reply lost: the cart gone from beside the bot, the villager out on the brake in the
    // shut yard, on into the hall as if it had answered)
    const again = await cartNow(ctx, line);
    if (!again.read || again.cart) return lostOut(ctx, line, `the cart could not be broken at the brake: ${took} (the villager left in it)`);
    delete line.cart;
    ctx.save?.();
  }
  const seen = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 24, type: 'villager' }).catch(() => undefined))?.entities ?? [];
  const e = seen.find(x => x.id === villager) ?? { id: villager, name: 'villager', ...(at ? { position: at } : {}) };
  return hallBy(ctx, line, e, clk, way);
}

/**
 * The yard shut behind the cart: into it by the post's gap, the post's rail taken up (unless close up has done it, the
 * move cut short: closeRailsYard) and the fence put back as it was. Why not, or undefined.
 */
async function shutYard(ctx: GoalContext, line: RailLine): Promise<string | undefined> {
  const g = goalOf(line);
  const post = line.cells[g + 1];
  const inside = line.cells[Math.min(line.cells.length - 1, g + 2)];
  await ctx.call('goto', { ...inside, range: 1, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);
  if (isLaid(line, post)) {
    const up = await takeUp(ctx, line, post);
    // (the fence back on the post already: its rail came up and the fence went back on a run cut short before brain.json
    // had it; nothing of the line's there to take up)
    const fenced = !up.ok && !!up.block && line.opens.some(o => same(o.at, post) && idOf(o.block) === up.block);
    if (!up.ok && !fenced) return `the fence's post rail not taken up at ${fmt(post)}: ${up.reason ?? 'no answer'}`;
    forget(line, post);
    // (written before the fence goes back: a restart after it must not find the post's rail still in the record)
    ctx.save?.();
  }
  await ctx.call('goto', { ...inside, range: 1, careful: true, timeoutMs: 15_000 }, 25_000).catch(() => undefined);
  const shut = await closeUp(ctx, o => line.opens.some(q => same(q.at, o.at)));
  return shut.left.length ? `the fence not put back: ${shut.left.join(', ')}` : undefined;
}

/** The villager out of the cart in the shut yard taken into the hall by boat, the move said, the take-up as far as the day goes. */
async function hallBy(ctx: GoalContext, line: RailLine, e: Seen, clk: Clk, way?: HallWay): Promise<WorkResult> {
  const world = ctx.world;
  const noBoat = await boatShort(ctx, line, e.id, 'waits in the shut yard');
  if (noBoat) return noBoat;
  const r = await boatIntoHall(ctx, { entry: line.entry, villager: e, now: clk.now, ...(way ? { way } : {}) });
  if (!r.ok) return lostOut(ctx, line, `${r.why}${r.held === 'boat' ? ' (the villager left seated in the boat in the yard)' : ' (the villager left in the yard, shut)'}`);
  const site = siteFor(villagesOf(world).sites, line.site);
  const count = await countHall(ctx, clk.now());
  if (site) site.moved = (site.moved ?? 0) + 1;
  const text = `moved an unemployed villager from the village at ${fmt(line.site)} to the hall by the rails home${count !== undefined ? ` (${count} in it now)` : ''}`;
  villagesOf(world).last = { at: clk.now(), text: text.slice(0, 160), moved: true };
  delete line.villagerOut;
  line.moved = true;
  line.stage = 'taking up';
  line.why = 'done: the villager is in the hall';
  ctx.save?.();
  say(ctx, `${text}; everything taken back up from here on`);
  ctx.gain(1);
  const rest = await takeUpRun(ctx, line, clk);
  return { gain: 1 + rest.gain, text: `${text}; ${rest.text}` };
}

/**
 * The boat for the way into the hall carried (one in the pockets, else from the chests or made): undefined, or the run's
 * end with the move kept under way (the villager as it is, in the shut yard: the next run tries again), said.
 */
async function boatShort(ctx: GoalContext, line: RailLine, villager: number, how: string): Promise<WorkResult | undefined> {
  const short = await carry(ctx, { [BOAT_ITEM]: 1 });
  if (!short) return undefined;
  line.stage = 'moving';
  ctx.save?.();
  const text = `the villager (${villager}) ${how}: short of ${short} for the way into the hall; again next run`;
  say(ctx, text);
  return { gain: 0, text, mark: 'same' };
}

/**
 * A move cut short (stage `moving`: a restart, survival, its timeout): the cart found on the brake with the villager in
 * it goes on into the hall; the cart elsewhere, or none, gives the line up (the take-up breaks the cart wherever it is);
 * none put down yet, the line is whole again (its yard stretch close up's).
 */
async function resumeMove(ctx: GoalContext, line: RailLine, clk: Clk): Promise<WorkResult> {
  // (cut short after the cart was broken at the brake, the boat's part not done: the villager is out of its village and
  // never back to 'whole', which would open the fence for a second one)
  if (!line.cart && line.villagerOut !== undefined) return resumeOut(ctx, line, line.villagerOut, clk);
  // (cut short as the cart went down: looked for on the launch; too far to see from here, the next move's launch looks)
  if (!line.cart && line.cartAt) await findCartAt(ctx, line);
  if (!line.cart) return notToday(ctx, line, 'the last move was cut short before the cart went down');
  const { cart, simulation, read } = await cartNow(ctx, line);
  // (only the villager the cart went for, by its id: a baby or a farmer it took instead is the wrong mob's, left seated)
  const want = line.villagerOut ?? line.aimed;
  const villager = want !== undefined && cart?.passengers?.some(q => q.id === want) ? want : undefined;
  const other = cart?.passengers?.find(q => q.id !== want);
  if (cart && villager === undefined && other) {
    return lostOut(ctx, line, `the last move was cut short: the cart at ${cart.position ? fmt(cart.position) : '?'} holds another (${other.name ?? 'a mob'}${other.baby ? ' (a baby)' : ''} ${other.id}), not the villager${want !== undefined ? ` (${want})` : ''}`);
  }
  if (cart && villager !== undefined) {
    if (line.villagerOut === undefined) { line.villagerOut = villager; ctx.save?.(); }
    if (!cart.moving && onBrake(line, cellIndexAt(line, cart))) {
      say(ctx, `the last move was cut short with the villager (${villager}) in the cart on the brake: on into the hall`);
      return intoHall(ctx, line, villager, clk);
    }
    // (still rolling home, or out on the line past the server's simulation distance, where a cart waits for the bot to
    // come near: followed home as the move does; one at rest short of the brake within it has stopped for good)
    if (cart.moving || !simulatedAt(cart, simulation)) return followOn(ctx, line, villager, clk, cart);
  }
  // (the villager out and the cart not in sight: broken at the brake before it was written so, when the brake is in
  // sight; else out on the line beyond what the client sees, looked for along it)
  if (!cart && line.villagerOut !== undefined) {
    const brake = line.cells[line.cells.length - 1];
    if (read && horiz(await here(ctx), brake) <= BRAKE_SIGHT) return resumeOut(ctx, line, line.villagerOut, clk);
    return followOn(ctx, line, line.villagerOut, clk);
  }
  // (launched for the villager, its took never heard, and the cart not in sight: it may be rolling home with it, or
  // frozen out on the line; looked for along it, by the villager it went for)
  if (!cart && launched(line)) return followOn(ctx, line, line.aimed!, clk);
  const why = `the last move was cut short: the cart ${cart ? `at ${cart.position ? fmt(cart.position) : '?'}${villager !== undefined ? ' with the villager in it' : ', empty'}` : 'not in sight'}`;
  return line.villagerOut !== undefined ? lostOut(ctx, line, why) : lostIfOut(ctx, line, why);
}

/** Within this of the brake, a cart.status that reads no cart means none at the brake (a cart is seen much farther). */
const BRAKE_SIGHT = 24;
/** Whether the server ticks a cart (within its simulation distance of the bot, as cart.status reads it): unread, it does. */
const simulatedAt = (cart: CartState, simulation: number | undefined) => cart.distance === undefined || simulation === undefined || cart.distance < simulation * 16 - 16;
/** The index of the line's cell nearest `p`. */
const nearestCell = (line: RailLine, p: { x: number; z: number }) => line.cells.reduce((b, c, i) => (horiz(c, p) < horiz(line.cells[b], p) ? i : b), 0);

/**
 * A move cut short with the villager in the cart out on the line (still rolling, or frozen past the server's simulation
 * distance): followed home as the move does, from the cell nearest the bot, or from the cart's own when the bot is
 * nearer home than it (the cart wakes as the bot comes near, and rolls home ahead). A cart not in sight from the yard is
 * looked for out along the line first. At the brake, on into the hall; a cart at rest short of it, the villager out of it,
 * or the cart not found, the move is given up (the moves off).
 */
async function followOn(ctx: GoalContext, line: RailLine, villager: number, clk: Clk, cart?: CartState): Promise<WorkResult> {
  const g = goalOf(line);
  const home = ctx.s.home ?? ctx.s.position;
  let bi = Math.min(g, nearestCell(line, await here(ctx)));
  if (!cart) {
    // (the bot behind it on the line, the cart ahead toward home: home after it; from the yard: out along the line)
    if (bi < g - WALK_EVERY) {
      say(ctx, `the last move was cut short with the villager (${villager}) in the cart, not in sight: on home along the line behind it`);
    } else {
      for (let i = g; ; i = Math.max(0, i - WALK_EVERY)) {
        aborted(ctx);
        if (clk.left() < horiz(line.cells[i], home) / 3 * 1000 + MARGIN + BRAKE_WAIT) return lostOut(ctx, line, 'the last move was cut short: the cart with the villager not found along the line in the run\'s time');
        await walkTo(ctx, line.cells[i], 3);
        const now = (await cartNow(ctx, line)).cart;
        if (now) { cart = now; break; }
        if (i === 0) return lostOut(ctx, line, 'the last move was cut short: the cart with the villager not found along the line');
      }
      bi = Math.min(g, nearestCell(line, await here(ctx)));
    }
  }
  const ci = cart ? cellIndexAt(line, cart) : -1;
  const from = ci >= 0 && ci <= bi ? ci : bi;
  if (cart) say(ctx, `the last move was cut short with the villager (${villager}) in the cart at ${cart.position ? fmt(cart.position) : '?'} (${cart.moving ? 'rolling home' : 'past the simulation distance'}): following it home`);
  const follow = await followHome(ctx, line, villager, clk, from);
  if (follow) return lostOut(ctx, line, `the last move was cut short, and following the cart home: ${follow}`);
  return intoHall(ctx, line, villager, clk);
}

/**
 * A move cut short with the cart broken at the brake: the villager found standing in the yard goes on into the hall by
 * boat (the yard shut first, as the move does); not seen there, or seated (the bot's boat, cut on its way), the move is
 * given up, said, the moves off.
 */
async function resumeOut(ctx: GoalContext, line: RailLine, villager: number, clk: Clk): Promise<WorkResult> {
  const shut = await shutYard(ctx, line);
  if (shut) return lostOut(ctx, line, `the last move was cut short after the cart was broken at the brake, and ${shut}`);
  const seen = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 64, type: 'villager' }).catch(() => undefined))?.entities ?? [];
  const e = seen.find(x => x.id === villager && x.position);
  if (!e || !inFence(ctx.world, e.position!) || e.vehicle) {
    return lostOut(ctx, line, `the last move was cut short after the cart was broken at the brake: the villager (${villager}) ${!e ? 'not seen' : e.vehicle ? `seated in a ${e.vehicle}` : `out of the yard at ${fmt(e.position!)}`}`);
  }
  // (standing in the yard: the cart was broken, its record not yet cleared when the move was cut short)
  if (line.cart) { delete line.cart; ctx.save?.(); }
  say(ctx, `the last move was cut short after the cart was broken at the brake: the villager (${villager}) in the yard, on into the hall`);
  return hallBy(ctx, line, e, clk);
}

// ------------------------------------------------------------------------------------------------ the take-up

/**
 * Taking it all back up (the brief's part 4): given up or done, whatever the switches. The cart first (broken back into
 * its item; one with a villager in it in the yard is left, never let out loose there, and said; out in the world the
 * villager steps out where it is), the yard's stretch from the brake out to the post and the fence put back, then out
 * to the far end of what is down and every block taken up walking home, in the record's order of the line. As far as
 * the day goes: the rest the next run. A block that will not come up (not the bot's own any more) is left and said.
 * All up, the line is forgotten.
 */
async function takeUpRun(ctx: GoalContext, line: RailLine, clk: Clk): Promise<WorkResult> {
  const home = ctx.s.home ?? ctx.s.position;
  let taken = 0;
  const said: string[] = [];
  if (!line.cart && line.cartAt) await findCartAt(ctx, line);
  if (line.cart) taken += await cartUp(ctx, line, said);
  // the yard's stretch, from the brake back to the post, and the fence; not while the cart with the villager is out and
  // not found (its way home: taken up, it would stop outside the shut fence, the villager let out there): after the line
  const held = cartOut(line);
  const yardUp: { taken: number; stop?: string } = held ? { taken: 0 } : await yardTakeUp(ctx, line);
  taken += yardUp.taken;
  if (yardUp.stop) said.push(yardUp.stop);
  // the line from its far end, walking home
  // (and the record's strays the plan has no step at: an extension's old stop or old trigger, a run cut short before
  // they came up)
  const steps = [...outwardSteps(line)].reverse().concat(triggerOf(line) ? [{ kind: 'torch', t: triggerOf(line)! } as Step] : []);
  const stepKeys = new Set([...steps, ...yardSteps(line)].map(st => key(stepAt(line, st))));
  const order = steps.filter(st => isLaid(line, stepAt(line, st)))
    .concat(straysOf(line).filter(b => !stepKeys.has(key(b.at))).map(b => ({ kind: 'stray', at: b.at, item: b.item }) as Step));
  // (from the far end in: the trigger and the stop by the launch first)
  order.sort((a, b) => rank(line, a) - rank(line, b));
  // (an extension's earthworks: what to put back into its cuts carried, as the chests give it)
  if (line.earth?.some(w => w.op === 'cut')) await carryRefills(ctx, line);
  if (order.length || line.earth?.length) {
    const firstAt = order.length ? stepAt(line, order[0]) : { x: line.earth![0].x, y: line.earth![0].y, z: line.earth![0].z };
    const gate = await outByGate(ctx, firstAt);
    if (gate.shut) said.push(`not out of the yard: ${gate.shut}`);
    else {
      let to = -1;
      let boatTried = false;
      let late = false;
      for (const st of order) {
        aborted(ctx);
        const p = stepAt(line, st);
        if (clk.left() < horiz(p, home) / 3 * 1000 + MARGIN) { said.push(`the day's end at ${fmt(p)}: the rest next run`); late = true; break; }
        if (to < 0 || horiz(await here(ctx), p) > 6) {
          await walkTo(ctx, p, 3);
          to = 0;
          // (a boat a hop cut short left at the pickup: broken back as the walk comes by it, the villager out in its village)
          if (!boatTried && villagesOf(ctx.world).boat && horiz(await here(ctx), line.pickup) <= 24 && byHop(ctx.world, line, villagesOf(ctx.world).boat!.at)) {
            boatTried = true;
            const b = await boatAtPickup(ctx, line);
            if (b) said.push(b);
          }
          // (a cart stopped out on the line, not in sight from home: found as the walk passes it, before its rail goes;
          // one a run cut short left on the launch, unnamed, found by its place as the walk comes to the launch)
          if (!line.cart && line.cartAt) await findCartAt(ctx, line);
          if (line.cart) taken += await cartUp(ctx, line, said, true);
        }
        const r = await takeUp(ctx, line, p);
        aborted(ctx);
        if (r.ok) {
          forget(line, p);
          if (r.dug) taken++;
          // (the column's earthworks undone once nothing of the line stands in it: its fills up, its cuts filled back)
          if (earthIn(line, p.x, p.z).length) taken += await earthUp(ctx, line, p.x, p.z, said);
          continue;
        }
        if (!notOurs(r.reason)) { said.push(unreached(line, st, r.reason ?? 'no answer')); continue; }
        (line.left ??= []).push(`${stepWord(line, st)}: ${r.reason ?? 'no answer'}`.slice(0, 120));
        forget(line, p);
        said.push(`${stepWord(line, st)} left: ${r.reason ?? 'no answer'}`);
        if (earthIn(line, p.x, p.z).length) taken += await earthUp(ctx, line, p.x, p.z, said);
      }
      // the earthworks left: the boat's hop's cuts, a column whose blocks came up on a run before, an extension given up
      // before all of it was laid (each cut read: one never made is as it was)
      const cols = [...new Set((line.earth ?? []).map(w => `${w.x},${w.z}`))];
      for (const c of late ? [] : cols) {
        aborted(ctx);
        const [x, z] = c.split(',').map(Number);
        const w = earthIn(line, x, z)[0];
        if (!w || line.laid.some(b => b.at.x === x && b.at.z === z)) continue;
        if (clk.left() < horiz(w, home) / 3 * 1000 + MARGIN) { said.push(`the day's end at ${fmt(w)}: the rest next run`); break; }
        taken += await earthUp(ctx, line, x, z, said);
      }
    }
  }
  // a cart not seen at the start (out along the line, past what the client holds): looked for again from out here; one
  // still not found once all of the line is up is said and let go (nothing to walk the line for any more)
  if (!line.cart && line.cartAt && !line.laid.length && await findCartAt(ctx, line) === 'unseen') {
    (line.left ??= []).push(`a minecart perhaps on the launch at ${fmt(line.cartAt)} (a run cut short as it went down; not seen)`);
    said.push('a minecart perhaps left on the launch: not seen');
    delete line.cartAt;
  }
  const yardKeys = new Set(yardSteps(line).map(st => key(stepAt(line, st))));
  if (line.cart && !line.laid.some(b => !yardKeys.has(key(b.at)))) {
    const { cart } = await cartNow(ctx, line);
    if (cart && villagerIn(cart) && cart.position && inFence(ctx.world, cart.position)) taken += await cartUp(ctx, line, said);
    else {
      const why = cart ? await takeCart(ctx, line) : 'not found';
      if (why) { (line.left ??= []).push(`the minecart ${line.cart.uuid}: ${why}`); said.push(`the cart left: ${why}`); delete line.cart; } else taken++;
    }
  }
  // (the yard's stretch held for a cart out: the line up and the cart found or let go, now)
  if (held && !cartOut(line) && (line.laid.some(b => yardKeys.has(key(b.at))) || (villagesOf(ctx.world).open ?? []).some(o => line.opens.some(q => same(q.at, o.at))))) {
    const late = await yardTakeUp(ctx, line);
    taken += late.taken;
    if (late.stop) said.push(late.stop);
  }
  const openLeft = (villagesOf(ctx.world).open ?? []).some(o => line.opens.some(q => same(q.at, o.at)));
  if (!line.laid.length && !line.earth?.length && !line.cart && !line.cartAt && !openLeft) {
    // (a boat the hop left at the pickup, not taken back: said with what was left, kept in villages.boat for the status)
    const boat = villagesOf(ctx.world).boat;
    if (boat && byHop(ctx.world, line, boat.at)) (line.left ??= []).push(`the boat at ${fmt(boat.at)} by the pickup or in the village, perhaps with a villager in it`);
    const left = line.left?.length ? `; left: ${line.left.slice(0, 3).join(', ')}` : '';
    const text = `everything of the line taken back up (${line.why ?? 'given up'})${left}`;
    const w = ctx.world.rails ??= {};
    w.last = { at: clk.now(), text: text.slice(0, 200) };
    delete w.line;
    const site = siteFor(villagesOf(ctx.world).sites, line.site);
    if (site?.rails) site.rails = { at: site.rails.at, ok: site.rails.ok, text: `${line.moved ? 'used and taken up' : 'given up and taken up'}: ${site.rails.text}`.slice(0, 200) };
    say(ctx, text);
    return { gain: taken, text: `${said.length ? `${said.join('; ')}; ` : ''}${text}` };
  }
  const text = `took up ${taken} block(s) (${line.why ?? 'given up'}); ${line.laid.length} still down${line.earth?.length ? `, ${line.earth.length} cut(s) or fill(s) not undone` : ''}${said.length ? `; ${said.join('; ')}` : ''}`;
  say(ctx, text);
  return { gain: taken, text, ...(taken ? {} : { mark: 'same' as const }) };
}

/** Whether the mob `id` is a monster (world.entities' category): one riding the cart in the yard is never let out there. */
async function monster(ctx: GoalContext, id: number): Promise<boolean> {
  // (as far as the client sees: the cart in sight, its rider is)
  const round = (await ctx.call<{ entities?: (Seen & { category?: string })[] }>('world.entities', { maxDistance: 256 }).catch(() => undefined))?.entities;
  const m = round?.find(x => x.id === id);
  // (unread, or not seen: kept in, as a monster would be)
  return !m || m.category === 'monster';
}

/** A villager riding the cart (a cart in the yard with one is never broken: it would be loose there). */
const villagerIn = (c: CartState) => !!c.passengers?.some(q => q.name === 'villager' || q.profession !== undefined);

/**
 * The bot's cart, if in sight, broken back into its item: out in the world whoever rides it steps out where it is; in
 * the yard only one with no villager or monster in it (a chicken the cart took is let out, a villager or a zombie
 * never loose there: left and said). `onTheWay`: looked for as the take-up walks the line, a cart not in sight there no matter. How many came up.
 */
async function cartUp(ctx: GoalContext, line: RailLine, said: string[], onTheWay = false): Promise<number> {
  const { cart } = await cartNow(ctx, line);
  if (!cart) return 0;
  const rider = cart.passengers?.[0];
  const yardKeeps = cart.position && inFence(ctx.world, cart.position) && (villagerIn(cart) || (rider && await monster(ctx, rider.id)));
  if (yardKeeps && cart.position) {
    if (onTheWay) return 0;
    const who = villagerIn(cart) ? 'a villager' : `a ${rider?.name ?? 'monster'}`;
    said.push(`the cart at ${fmt(cart.position)} left with ${who} (${rider?.id}) in it (never let out loose in the yard)`);
    (line.left ??= []).push(`minecart ${fmt(cart.position)} (${who} in it)`);
    delete line.cart;
    ctx.save?.();
    return 0;
  }
  const why = await takeCart(ctx, line);
  if (why) { if (!onTheWay) said.push(`the cart not taken up: ${why}`); return 0; }
  if (rider) said.push(`the ${rider.name ?? 'rider'} (${rider.id}) let out of the cart where it was`);
  return 1;
}

/**
 * A take-up's answer that the block is no longer the bot's to take (someone's block there now, or not the bot's own):
 * left at once. Anything else (not loaded, out of reach, a timeout, the bridge's reply lost, not in a world, an error)
 * leaves the block standing and the bot's: tried again (unreached).
 */
const notOurs = (reason: string | undefined) => /^(not a block of the line: |the bot did not put that )/.test(reason ?? '');

/**
 * A block the take-up did not get this run (not loaded, out of reach, the dig's reply lost or timed out): counted, and
 * left (said, into line.left, off the record) once it did not come up on UP_TRIES runs: walled in, under water, the
 * ground changed. What to say.
 */
function unreached(line: RailLine, st: Step, reason: string): string {
  const p = stepAt(line, st);
  const tries = (line.upTries ??= {});
  tries[key(p)] = (tries[key(p)] ?? 0) + 1;
  if (tries[key(p)] < UP_TRIES) return `${stepWord(line, st)} not reached: ${reason}; again next run`;
  delete tries[key(p)];
  (line.left ??= []).push(`${stepWord(line, st)}: not reached on ${UP_TRIES} runs (${reason})`.slice(0, 120));
  forget(line, p);
  return `${stepWord(line, st)} left: not reached on ${UP_TRIES} runs (${reason})`;
}

/** Where a step comes in the take-up: from the launch's end in (the stop and the trigger with the launch). */
function rank(line: RailLine, s: Step): number {
  if (s.kind === 'cell') return s.i;
  if (s.kind === 'stop') return -0.5;
  // (a stray by the cell nearest it: an old stop or trigger halfway along an extended line)
  if (s.kind === 'stray') return nearestCell(line, s.at) - 0.25;
  const i = line.cells.findIndex(c => same(c, s.t.lights));
  return i < 0 ? 0 : i + 0.5;
}

/** The yard's stretch taken up from the brake back to the post, from inside, and the fence's post put back after. */
async function yardTakeUp(ctx: GoalContext, line: RailLine): Promise<{ taken: number; stop?: string }> {
  let taken = 0;
  const steps = yardSteps(line).filter(st => isLaid(line, stepAt(line, st))).reverse();
  for (const st of steps) {
    aborted(ctx);
    const p = stepAt(line, st);
    const r = await takeUp(ctx, line, p);
    aborted(ctx);
    // (saved as each comes off the record: the fence goes back over the post's cell next, and a restart must not find
    // its rail still in the record under the fence: held from close up, and never taken up again)
    if (r.ok) { forget(line, p); ctx.save?.(); if (r.dug) taken++; continue; }
    if (!notOurs(r.reason)) {
      const why = unreached(line, st, r.reason ?? 'no answer');
      // (the rail in the post's gap still down: the fence cannot go back over it)
      if (isLaid(line, p)) return { taken, stop: why };
      ctx.save?.();
      continue;
    }
    (line.left ??= []).push(`${stepWord(line, st)}: ${r.reason ?? 'no answer'}`.slice(0, 120));
    forget(line, p);
    ctx.save?.();
  }
  const ours = (o: { at: Pos }) => line.opens.some(q => same(q.at, o.at));
  if ((villagesOf(ctx.world).open ?? []).some(ours)) {
    // (from inside the yard, by the post: the opening's cell is where the bot may stand)
    const inner = line.cells[Math.min(line.cells.length - 1, goalOf(line) + 2)];
    await ctx.call('goto', { ...inner, range: 1, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);
    const shut = await closeUp(ctx, ours);
    if (shut.left.length) return { taken, stop: `the fence not put back: ${shut.left.join(', ')}` };
  }
  if (!yardSteps(line).some(st => isLaid(line, stepAt(line, st)))) delete line.yardOpen;
  return { taken };
}

/**
 * A move cut short with its cart out (close up's, any hour): the fence shut behind a cart at rest on the brake, only
 * the post's rail taken up (the brake's rails and the cart with the villager in it left as they are, for the next run's
 * resumeMove: on into the hall). A cart still rolling home, or not in sight, is left its way in: the post stays open.
 */
async function closeRailsPost(ctx: GoalContext, line: RailLine): Promise<{ taken: number; text: string; stop?: string; waits?: true }> {
  const { cart } = await cartNow(ctx, line);
  if (!cart || cart.moving || !onBrake(line, cellIndexAt(line, cart))) {
    const stop = `the cart ${cart ? `not at rest on the brake (at ${cart.position ? fmt(cart.position) : '?'})` : 'not in sight'}: the post left open for it`;
    // (no failure: close up waits a while before it looks again, railsPostWaits)
    line.postLook = ctx.s.now;
    ctx.save?.();
    say(ctx, `the rails' post: ${stop}`);
    return { taken: 0, text: `the rails' post: ${stop}`, stop, waits: true };
  }
  const why = await shutYard(ctx, line);
  const text = `the rails' post: the fence shut behind the cart on the brake${why ? `, but ${why}` : ''} (the move goes on into the hall next run)`;
  say(ctx, text);
  return { taken: isLaid(line, line.cells[goalOf(line) + 1]) ? 0 : 1, text, ...(why ? { stop: why } : {}) };
}

/**
 * Close up's part (any hour, the bot in the yard): the yard's stretch of a move that did not go (or of a give-up) taken
 * back up and the fence's post put back. Said; why not, as close up throws.
 */
export async function closeRailsYard(ctx: GoalContext): Promise<{ taken: number; text: string; stop?: string; waits?: true }> {
  const line = peekLine(ctx.world);
  if (!line || !ctx.rails) return { taken: 0, text: 'the rails\' yard stretch: no rails tools', stop: 'no rails tools' };
  if (cartOut(line)) return closeRailsPost(ctx, line);
  const r = await yardTakeUp(ctx, line);
  const text = `the rails' yard stretch: ${r.taken} rail(s) taken up${r.stop ? `; ${r.stop}` : ', the fence back'}`;
  say(ctx, text);
  return { taken: r.taken, text, ...(r.stop ? { stop: r.stop } : {}) };
}
