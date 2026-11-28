import type { GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { Critical } from './pockets.js';
import { JOB_SITE, VILLAGE_MIN, type Seen, type VillageSite } from './village.js';
import type { HomeSide } from './yardgates.js';
import { RETURN_AT, WORK_AT } from './schedule.js';
import { placerFacing } from '../schematic.js';

/**
 * The records of the villager fetch by the job-site lure (idle-plan V, sections 2 and 3): the journal of everything
 * the bot did to the world for a villager and has not undone (a lure put down, a job block of its own lifted out of a
 * villager's way, a gate held: written and SAVED before the act), and the wards, the villagers it answers for (custody
 * by the game's own uuid, across runs, nights and restarts). Kept per world in brain.json (world.fetch).
 *
 * Why a record before every act: on Nov 23-24 the lead drove two villagers home by hand with nothing written down. A
 * lure table stood in the west village for a day with a villager working at it; the workshop's smithing table, lifted
 * out of the way, was put back while a villager was still out and took it a third time; and the second villager was
 * lost (out by the hall's gate, over the bot's own scaffold on the fence, into the Nether portal). Each was a thing
 * done and then not known.
 *
 * S0's half: the shapes, the memory made whole, the journal's write, what the rest of the brain asks (heldByFetch,
 * liftedFor, inHallOrLock, wardOut, placeGuard, journalItems, tripLive, openByDesign, fetchSafe) and the status line.
 * S1's: the numbers and the clock (need, the start rule, clock, the floor, why no trip ran), the trip's moves from
 * state to state (2.2), the wards brought up to a look by their uuid (wardSeen), and the undo of every kind of entry
 * with the order of a restore (UNDO, undo, restoreAll). The undo acts through the run's context alone; it imports
 * types, village.ts, schedule.ts and schematic.ts (none of which imports a goal), and loads the two goal modules it
 * calls into (yardgates.ts's shutGate, project.ts's prepare) only when it first asks them, so the structures, tidy,
 * repair and village.ts itself can ask this file whichever module is loaded first.
 */

// ------------------------------------------------------------------------------------------------ the shapes

export interface FetchMemory {
  v: 1;
  /** villager-moves {method}: absent or 'boat' = today's moveFrom (inert while moves are off); 'lure' = this design */
  method?: 'lure' | 'boat';
  /** supervised start: trips (brings and rescues) that may still begin (villager-moves {arm: n}); 'free' from S1.5 */
  armed?: number | 'free';
  /** the trip under way, in preparation, or cut short: at most one */
  trip?: Trip;
  /** every change the bot made and has not undone, oldest first; pushed and SAVED (ctx.save) before its act */
  journal: Change[];
  /** villagers the bot answers for */
  wards: Ward[];
  /** harm or a broken layer: no new trip until the lead clears it (villager-moves {halt:false}); care goes on working */
  halt?: { at: number; why: string };
  /** the lock and the ring as last read: faults (empty = ready); written by the shells goal, care, PREP, the plan tool */
  shells?: { at: number; lock: string[]; ring: string[]; building?: 'lock' | 'ring'; mirror?: boolean };
  /** the gate watch's last read (brain.ts tick): strict gates open, and those the bridge calls leftOpen */
  gates?: { at: number; open: Pos[]; leftOpen: Pos[] };
  /** why no trip ran, per stage, counted while the reason stays the same (noteWhy; the status line prints them); `day`: the game day last counted */
  why?: Partial<Record<'prep' | 'dawn' | 'look', { at: number; n: number; text: string; day?: number }>>;
  last?: { at: number; text: string; got: 0 | 1 };
  /**
   * villager-moves {dry}: the switch for trips to come (rollout step 3): set before a trip exists, it holds for the PREP
   * and the morning after; PREP's new trip is made `dry` by it (a trip's own `dry` is that trip's record)
   */
  dry?: true;
  /** journal ids (kept over every id in the journal and over the trip's, so a trip numbered from it is numbered once) */
  nextId: number;
}

export type TripState = 'prep' | 'out' | 'survey' | 'first' | 'hop' | 'gate' | 'yardhop' | 'lock' | 'door' | 'restore';
/** A yard gate with a lane outside and a villager's way to the lock inside (`yard`: the cells of that way). */
export interface YardGateWay { at: Pos; side: HomeSide; inner: Pos; outer: Pos; yard: number }
export interface Trip {
  id: number;
  kind: 'bring' | 'rescue';
  /** village.ts variantOf(site) */
  site: string;
  /** written and saved BEFORE the first act of that state (tripTo) */
  state: TripState;
  /** real ms that state was entered: its seconds go to `times` when it is left */
  entered?: number;
  /** real ms: a live run renews it at every poll (<= 10 s); stale = nobody drives it */
  beat: number;
  /** PREP's parts done (ms): a cut PREP goes on from them; `dry`: its lifts were only said (a dry trip's), so a trip made real after owes them */
  prep: { read?: number; kit?: number; lifts?: number; dry?: true };
  /** stamped AFTER the last part, on that game day (hallchores.ts gameDay) */
  prepared?: { at: number; day: number };
  /** chosen by PREP: the bot leaves by it and reads the band along its way */
  gate: YardGateWay;
  /** the other gates PREP found a lane and a yard way for: fallbacks, hop by hop */
  spare: YardGateWay[];
  lure: 'fletching_table';
  hop?: { n: number; lure?: Pos; next?: Pos; placedAt?: number; replaced: number };
  /** Ward.key once somebody took the first lure */
  ward?: string;
  began?: { at: number; tod: number; day: number };
  /** beyond the release range of its village, or below a step it cannot climb back: no release */
  committed?: 'far' | 'drop';
  /** free job sites that are not the bot's, other villages: the way keeps off */
  avoid: { at: Pos; r: number; why: string }[];
  /** the path cells still to go, to the yard gate and across the yard (the run renews them at each hop): the clock's needLeft */
  path?: { toGate: number; yard: number };
  /** seconds, measured */
  times: Partial<Record<'out' | 'survey' | 'first' | 'hops' | 'gate' | 'yard' | 'lock' | 'door', number>>;
  counts: { hops: number; misses: number; wedges: number; pins: number };
  cut?: { at: number; why: string };
  /** plan, log and dump only: places and digs nothing */
  dry?: true;
  /** said as `halt` when the trip ends, however it ends (4.3: a second villager pinned beyond 96, the lead's to lead home or back) */
  haltAtEnd?: string;
}

/** What every journal entry holds: `trip` 0 = made outside a trip (the shells goal); `tries`: undo attempts that failed. */
interface Entry { id: number; trip: number; at: Pos; t: number; tries?: number }
export type Change =
  | Entry & { k: 'lure'; item: string; st: 'planned' | 'down' | 'unsure'; role: 'village' | 'hop' | 'anchor' | 'yard' | 'lock' | 'pin'; inVillage?: true }
  /** `block`: the full state string, for the put-back */
  | Entry & { k: 'lift'; block: string; item: string; st: 'planned' | 'done'; why: 'job site' | 'wedge' | 'socket' }
  /** the lock's build plugs the hall's doorway with it (hallshells.ts) */
  | Entry & { k: 'cover'; item: string; what: 'hall door'; st: 'planned' | 'down' }
  /** `until`: the hold's end; none for the hall's gate opened behind the lock's shut one */
  | Entry & { k: 'gate'; which: 'yard' | 'lock' | 'hall'; until?: number }
  /** a block's drop not yet picked up */
  | Entry & { k: 'drop'; item: string };
type Sans<T, K extends string> = T extends unknown ? Omit<T, K> : never;
/** An entry as it is handed to `journal`, which numbers it. */
export type NewChange = Sans<Change, 'id'>;

export interface Ward {
  /** the entity uuid; 'at:x,y,z@t' only while the bridge gives none (an old jar) */
  key: string;
  /** the id, and the brain process it was read in (ids die with unloads) */
  uuid?: string; id?: number; session?: string;
  /** its village and where it stood at the first flip */
  from: { site: string; at: Pos };
  since: number;
  /** its village's bell still calls it at 9000: true from the first flip, cleared only on the lead's word */
  bell: boolean;
  where: 'led' | 'lock' | 'astray' | 'dead';
  dim?: 'nether';
  last: { at: Pos; t: number; tod: number; health: number; profession: string };
  /** as first read (17 of 20 on both live ones): the baseline, never 20 by default */
  health0: number;
  /** the lure of the bot's it was left at (an anchor, a pin) */
  tether?: Pos;
  /** <= 120 chars: why it is where it is */
  note?: string;
}

/** A game day in real ms with no night slept through (24000 ticks). */
export const GAME_DAY = 20 * 60_000;
/** How long an astray ward near home holds the lifts and the guards from when it was last seen (R-8), and how near. */
export const ASTRAY_HOLD = 2 * GAME_DAY;
export const ASTRAY_NEAR = 160;
/** A trip's beat younger than this is a run driving it (a live run renews it every 10 s at most). */
export const BEAT_LIVE = 90_000;
const STATES: readonly string[] = ['prep', 'out', 'survey', 'first', 'hop', 'gate', 'yardhop', 'lock', 'door', 'restore'];
/** The states with a villager on a lure and no wall round it: from the first lure to the lock's gate shut. */
const LEADING: readonly string[] = ['first', 'hop', 'gate', 'yardhop', 'lock'];

// ------------------------------------------------------------------------------------------------ made whole

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';
const isPos = (p: unknown): p is Pos => isObj(p) && fin(p.x) && fin(p.y) && fin(p.z);
const cell = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const mid = (c: Pos): Pos => ({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 });
const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;
const fmt = (p: Pos) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
const idOf = (name: string) => name.replace(/^minecraft:/, '').replace(/\[.*$/, '');

/**
 * Sound enough to be worked: where, when, whose trip, and the kind's own fields. The labels' values (a role, a why, a
 * state of the entry) are not judged: an entry a later version wrote with a label this one does not know is still a
 * block of the bot's to take up, and every undo reads the cell before it acts.
 */
const isChange = (c: unknown): c is Change => isObj(c) && fin(c.id) && fin(c.trip) && isPos(c.at) && fin(c.t) && (
  c.k === 'lure' ? str(c.item) && str(c.st) && str(c.role)
    : c.k === 'lift' ? str(c.block) && str(c.item) && str(c.st) && str(c.why)
      : c.k === 'cover' ? str(c.item) && str(c.st) && str(c.what)
        : c.k === 'gate' ? str(c.which) && (c.until === undefined || fin(c.until))
          : c.k === 'drop' && str(c.item));
const isWard = (w: unknown): w is Ward => isObj(w) && str(w.key) && isObj(w.from) && str(w.from.site) && isPos(w.from.at) && fin(w.since)
  && typeof w.bell === 'boolean' && str(w.where) && isObj(w.last) && isPos(w.last.at) && fin(w.last.t) && fin(w.last.tod) && fin(w.last.health)
  && str(w.last.profession) && fin(w.health0) && (w.tether === undefined || isPos(w.tether));
const isWay = (g: unknown): g is YardGateWay => isObj(g) && isPos(g.at) && str(g.side) && isPos(g.inner) && isPos(g.outer) && fin(g.yard);
/** (a state this version does not drive is no trip: the journal and the wards carry everything that is owed) */
const isTrip = (t: unknown): t is Trip => isObj(t) && fin(t.id) && str(t.kind) && str(t.site) && str(t.state) && STATES.includes(t.state) && fin(t.beat)
  && isObj(t.prep) && isWay(t.gate) && Array.isArray(t.spare) && t.spare.every(isWay) && str(t.lure) && Array.isArray(t.avoid) && isObj(t.times) && isObj(t.counts);
const isWhy = (y: unknown): y is { at: number; n: number; text: string } => isObj(y) && fin(y.at) && fin(y.n) && str(y.text);

/**
 * What brain.json holds, read sound (pure: a new record over the same entries, the lists themselves kept where
 * nothing in them is dropped). A malformed journal entry, ward or trip is dropped, and said: it sets `halt`, since a
 * thing the bot did for a villager is then no longer known, and the status line holds that until the lead has looked
 * (brain.json itself cannot tear: memory.ts writes it beside and renames it). The rest (the switches, the last reads,
 * the counts) is dropped silently: off, or read again. But `halt` itself: malformed, it stands (see below).
 */
function sound(raw: unknown): FetchMemory {
  const r = isObj(raw) ? raw : {};
  const dropped: string[] = [];
  const list = <T>(v: unknown, ok: (e: unknown) => e is T, one: string, many: string): T[] => {
    if (!Array.isArray(v)) return [];
    const good = v.filter(ok), bad = v.length - good.length;
    if (!bad) return v as T[];
    dropped.push(bad === 1 ? `1 ${one}` : `${bad} ${many}`);
    return good;
  };
  const m: FetchMemory = { v: 1, journal: list(r.journal, isChange, 'journal entry', 'journal entries'), wards: list(r.wards, isWard, 'ward', 'wards'), nextId: 1 };
  if (r.method === 'lure' || r.method === 'boat') m.method = r.method;
  if (r.armed === 'free' || (fin(r.armed) && r.armed >= 0)) m.armed = r.armed;
  if (isTrip(r.trip)) m.trip = r.trip;
  else if (r.trip !== undefined) dropped.push('the trip');
  // the switch that stops new trips fails SHUT: a halt that is there and cannot be read (written by hand with no `at`,
  // or as a bare `true` or a sentence: in S0 the file is the lead's only way to it) is a halt all the same, with its
  // own words where it has any. Only what says "none" in so many words (null, false) is none
  const h = r.halt;
  if (isObj(h) && fin(h.at) && str(h.why)) m.halt = h as FetchMemory['halt'];
  else if (h !== undefined && h !== null && h !== false) {
    const why = isObj(h) && str(h.why) && h.why.trim() ? h.why : str(h) && h.trim() ? h : 'brain.json: a halt that could not be read';
    m.halt = { at: isObj(h) && fin(h.at) ? h.at : Date.now(), why };
  }
  const s = r.shells;
  if (isObj(s) && fin(s.at) && Array.isArray(s.lock) && s.lock.every(str) && Array.isArray(s.ring) && s.ring.every(str)) m.shells = s as FetchMemory['shells'];
  const g = r.gates;
  if (isObj(g) && fin(g.at) && Array.isArray(g.open) && g.open.every(isPos) && Array.isArray(g.leftOpen) && g.leftOpen.every(isPos)) m.gates = g as FetchMemory['gates'];
  if (isObj(r.why) && Object.values(r.why).every(isWhy)) m.why = r.why as FetchMemory['why'];
  if (isObj(r.last) && fin(r.last.at) && str(r.last.text)) m.last = r.last as FetchMemory['last'];
  if (r.dry === true) m.dry = true;
  m.nextId = Math.max(fin(r.nextId) ? r.nextId : 1, 1 + Math.max(0, m.trip?.id ?? 0, ...m.journal.map(e => e.id)));
  if (dropped.length) m.halt ??= { at: Date.now(), why: `brain.json: ${dropped.join(', ')} could not be read and dropped (what stood there is no longer known: the lead looks round, then clears the halt)` };
  return m;
}

const KEYS = ['v', 'method', 'armed', 'trip', 'journal', 'wards', 'halt', 'shells', 'gates', 'why', 'last', 'dry', 'nextId'] as const;

/**
 * The fetch's memory, made whole in the world (a write: runs and tools, never a gate). The same object every time,
 * made whole in place, and the same entries: a run holds the record and the entry `journal` gave it across its awaits.
 */
export function fetchOf(world: WorldMemory): FetchMemory {
  const raw: unknown = world.fetch, m = sound(raw);
  if (!isObj(raw)) return (world.fetch = m);
  for (const k of KEYS) {
    if (m[k] === undefined) delete raw[k];
    else raw[k] = m[k];
  }
  return raw as unknown as FetchMemory;
}

/** The same to read only (the gates, the status): a copy, whole; nothing in the world is written, and nothing of the world is in it. */
export function peekFetch(world: WorldMemory): FetchMemory {
  return structuredClone(sound(world.fetch));
}

/**
 * The journal alone, read sound and nothing made (heldByFetch is asked cell by cell over a whole yard: with nothing
 * out, which is nearly always, it costs a look at an empty list).
 */
const entriesOf = (world: WorldMemory): Change[] => {
  const j: unknown = world.fetch?.journal;
  return Array.isArray(j) ? j.filter(isChange) : [];
};

// ------------------------------------------------------------------------------------------------ the journal

type Run = Pick<GoalContext, 'world' | 'save'>;

/**
 * An entry written before its act (R-1): numbered, pushed and brain.json saved, then given back for the reply to
 * settle. The caller acts only after this returns: a kill at any instant then leaves either an entry `planned` with
 * the cell as it was (the undo's read drops it) or one with the block there (the read makes it `down`), never a block
 * of the bot's that nothing knows of.
 */
export function journal<C extends NewChange>(ctx: Run, change: C): Extract<Change, { k: C['k'] }> {
  const f = fetchOf(ctx.world);
  const entry = { ...change, id: f.nextId++ } as unknown as Extract<Change, { k: C['k'] }>;
  f.journal.push(entry);
  ctx.save?.();
  return entry;
}

/** The act's reply written on its entry (a lost reply: `unsure`, and the next read of the cell decides). Not saved: the run's next write is. */
export function settle<C extends Extract<Change, { st: string }>>(entry: C, st: C['st']): C {
  entry.st = st;
  return entry;
}

/** An entry undone, or found already as it should be, by a read of its cell: off the journal, and saved. */
export function dropEntry(ctx: Run, entry: Pick<Change, 'id'>): void {
  const f = fetchOf(ctx.world), i = f.journal.findIndex(e => e.id === entry.id);
  if (i >= 0) f.journal.splice(i, 1);
  ctx.save?.();
}

// ------------------------------------------------------------------------------------------------ what the brain asks

/**
 * A cell the fetch holds (R-6): a job block lifted from it, a lure or a cover of the bot's standing in it. Repair, tidy,
 * the structures' drift and the landmark scan leave such a cell as it is: the block missing is meant, and the one
 * standing there is no stray.
 */
export function heldByFetch(world: WorldMemory, at: Pos): boolean {
  const p = cell(at);
  return entriesOf(world).some(e => (e.k === 'lift' || e.k === 'cover' || e.k === 'lure') && same(e.at, p));
}

/** A zone's block is held (the workshop's `workshop:smithing`, the stand's): the goal that works at it declines "lifted for a villager". */
export function liftedFor(world: WorldMemory, zoneKey: string): boolean {
  return (world.zones?.[zoneKey] ?? []).some(z => isPos(z) && heldByFetch(world, z));
}

/** Inside the hall's box at its floor's level (as hallchores.ts inHallBox counts: this file imports no goal). */
function inHall(world: WorldMemory, p: Pos): boolean {
  const h = world.zones?.hall?.[0];
  return !!h && fin(h.width) && fin(h.length) && p.x >= h.x && p.x < h.x + h.width && p.z >= h.z && p.z < h.z + h.length && Math.abs(p.y - (h.y + 1)) <= 3;
}

/**
 * In the villager hall or in its lock: the hall's box, or the lock's footprint (its six inside cells, `lock:inside`,
 * with the walls and the gate's row round them). Those cells are the hall chores' alone: tidy, the lights and the
 * drop pick-ups keep out, and the bot found standing there outside a chores visit is taken out through the lock (a
 * plain walk out by the gate is how a villager leaves with it). The lock counts once it stands (its landmark zones,
 * written when the build is whole), not from its footprint's reservation.
 */
export function inHallOrLock(world: WorldMemory, at: Pos): boolean {
  const p = cell(at);
  if (inHall(world, p)) return true;
  const inside = (world.zones?.['lock:inside'] ?? []).filter(isPos);
  if (!inside.length) return false;
  const xs = inside.map(c => c.x), zs = inside.map(c => c.z);
  return p.x >= Math.min(...xs) - 1 && p.x <= Math.max(...xs) + 1 && p.z >= Math.min(...zs) - 1 && p.z <= Math.max(...zs) + 1 && Math.abs(p.y - inside[0].y) <= 3;
}

/** Home across the ground as the world's own records have it (the gates that ask wardOut hold no snapshot): the bed, else the yard's middle, else the hall. */
function homeOf(world: WorldMemory): { x: number; z: number } | undefined {
  const y = world.yard;
  return world.landmarks?.bed ?? (y ? { x: (y.x1 + y.x2) / 2, z: (y.z1 + y.z2) / 2 } : world.zones?.hall?.[0]);
}

/** An astray ward that still holds the lifts and the guards (R-8): in the overworld, last seen within 160 of home, under 2 game days ago. */
function astrayHolds(world: WorldMemory, w: Ward, now: number): boolean {
  const home = homeOf(world);
  return w.where === 'astray' && !w.dim && now - w.last.t < ASTRAY_HOLD && (!home || Math.hypot(w.last.at.x - home.x, w.last.at.z - home.z) <= ASTRAY_NEAR);
}

/**
 * A villager is on its way, or may come by (R-8): the one thing the rest of the brain asks. A trip from PREP's lifts
 * to its restore (prepared with the lifts done, or out); a ward `led` or in the lock; a ward astray in the overworld,
 * last seen within 160 of home, for 2 game days from then. While it is true no lifted job block goes back and none is
 * put up in the yard, the pens lead nothing through a yard gate and the yard does not grow: a free job block within 48
 * of a jobless villager takes it (the workshop's smithing table did, three times, put back too early the third). The
 * astray ward's 2 days are its end: one that is found but cannot be fetched would hold the yard for good, so after
 * them the lifts go back, the status line asks the lead, and its rescue begins with PREP's lifts again.
 */
export function wardOut(world: WorldMemory, now: number): boolean {
  const f = sound(world.fetch), t = f.trip;
  // (a trip restoring holds nothing by itself: its lifts are what the restore puts back last, once this is false)
  if (t && t.state !== 'restore' && (t.state !== 'prep' || fin(t.prep.lifts))) return true;
  return f.wards.some(w => w.where === 'led' || w.where === 'lock' || astrayHolds(world, w, now));
}

/**
 * The yard's box, fence and gates hold still (the yard-follow-up's R3): a trip exists that is not restoring (from PREP's
 * first read on: its gate, its lane and its yard way were read on the yard as it stood then), or a villager is out
 * (wardOut). Grow yard, growStep and the perimeter's take-down wait on it: wardOut alone is false through PREP until
 * its lifts are stamped, and a growth in that window moved the box under a prepared trip (the dawn path P1). The
 * rebuild of a ring already taken down is not held: it closes the yard.
 */
export function yardHeld(world: WorldMemory, now: number): boolean {
  const t = sound(world.fetch).trip;
  return (!!t && t.state !== 'restore') || wardOut(world, now);
}

/**
 * Why a job-site block may not be put up now, or undefined: while a ward is out no goal places one outside the hall's
 * box (the brewing milestone's stand, a structure job's cell, the repair of a lifted one). `at`: the cell, where the
 * caller knows it (one inside the hall is the chores' own business: the free lectern there is what draws the ward in).
 */
export function placeGuard(world: WorldMemory, item: string, now: number, at?: Pos): string | undefined {
  if (!JOB_SITE.test(idOf(item)) || (at && inHall(world, cell(at))) || !wardOut(world, now)) return undefined;
  return 'waiting: a villager is on its way';
}

/** The lifted blocks' items: carried until they go back, so the stash leaves them in the pockets. */
export function journalItems(world: WorldMemory): string[] {
  return [...new Set(entriesOf(world).flatMap(e => (e.k === 'lift' ? [e.item] : [])))];
}

/**
 * A villager is being led by a run right now: a trip between its first lure and the lock's gate shut whose beat is
 * under 90 s old. A person's acting tool call is refused then, the shelter does not cut the run for thunder by day,
 * and a restart waits (fetchSafe).
 */
export function tripLive(world: WorldMemory, now: number): boolean {
  const t = sound(world.fetch).trip;
  return !!t && LEADING.includes(t.state) && now - t.beat < BEAT_LIVE;
}

/**
 * A gate that is open because the design has it so: the hall's gate with a journal `gate {which:'hall'}`, and the
 * lock's gate shut in the same read of the gates (DOOR's own state: the ward in the lock goes in when it will, and
 * may take the night). The gate watch and care's shutting leave it; without this they shut it, care's next row opened
 * it again, and the loop watch held both.
 */
export function openByDesign(world: WorldMemory, gate: Pos): boolean {
  const f = sound(world.fetch), h = world.zones?.['hall:gate']?.[0], p = world.zones?.['lock:gate']?.[0];
  return !!h && !!p && !!f.gates && same(cell(gate), h) && f.journal.some(e => e.k === 'gate' && e.which === 'hall' && same(e.at, h)) && !f.gates.open.some(g => same(g, p));
}

/**
 * Whether the bot may be restarted or taken over now (the fetch-safe tool, scripts/safe-restart.sh): not while a
 * villager is being led, not inside a critical section (`critical`: pockets.ts liveCritical), not with the bot in the
 * hall or the lock. The unit's stop kills the game client with the brain, and the bridge's hold on an open gate dies
 * with the client: a gate held for a villager then stands open until the bot is back, about 90 s.
 */
export function fetchSafe(world: WorldMemory, at: Pos | undefined, now: number, critical?: Critical): { safe: boolean; why?: string } {
  const t = sound(world.fetch).trip;
  if (t && tripLive(world, now)) return { safe: false, why: `a villager is being led (trip ${t.id}, ${t.hop ? `hop ${t.hop.n}` : t.state})` };
  if (critical) return { safe: false, why: critical.why === 'hall' ? 'the bot is inside the villager hall' : `a villager is at the ${critical.why === 'gate' ? 'yard gate' : 'lock'}` };
  if (at && inHallOrLock(world, at)) return { safe: false, why: 'the bot stands in the villager hall or its lock' };
  return { safe: true };
}

// ------------------------------------------------------------------------------------------------ the numbers (S1)

/**
 * The clock's times of day (ticks, 4.4). IN_BY: the lock's gate read shut by then, the deadline event: a trip that
 * ends in the yard at 9000 is the state that lost villager 2 (Nov 24, the bell's pull at 9000 + 4 s). LAST_P: from
 * then the lock's gate shuts on a ward's feet in its cell. BELL: a ward with its bell turns for it at 9000, so what is
 * not in the lock by then is stopped. NIGHT: nothing of a trip held or down after it (the bot abed by 12542).
 */
export const IN_BY = 8700;
export const LAST_P = 8900;
export const BELL = 8990;
export const NIGHT = 11_800;
/**
 * A hop (4.2, 4.3): aimed at HOP_LEN straight, never over HOP_MAX, its path at most HOP_PATH cells found in HOP_NODES
 * nodes (of the game's 48 and 768: the planner's margin), at least HOP_MIN on; across the yard YARD_HOP. About 60 hops
 * of 22-25 were driven by hand on Nov 23-24, and every one with a walkable way and no nearer free job block arrived in
 * 4-18 s. HOP_S: a hop's seconds in the clock until three trips are timed.
 */
export const HOP_LEN = 22;
export const HOP_MAX = 24;
export const HOP_PATH = 36;
export const HOP_NODES = 600;
export const HOP_MIN = 8;
export const YARD_HOP = 16;
export const HOP_S = 15;
/** The keep-offs: a free job site within RIVAL_R (the game's 48, and 8) of the way takes the ward; no spot within TRAP_R of a pit it cannot leave. */
export const RIVAL_R = 56;
export const TRAP_R = 10;
/** Let go only within RELEASE_R of its village (inside Manhattan 100 it walks straight back to its bell), and only with COMMIT x the time left in hand. */
export const RELEASE_R = 96;
export const COMMIT = 1.3;
/** The watch (s): a miss when not 3 nearer in APPROACH_S (the first lure: APPROACH_FIRST_S), slow past ARRIVE_S, still for STILL_S. */
export const APPROACH_S = 12;
export const APPROACH_FIRST_S = 15;
export const ARRIVE_S = 45;
export const STILL_S = 15;
/** A gate held open at most GATE_OPEN_MAX (ms; 35 s with a villager in its gateway), each hold HOLD_MS (the bridge shuts it when the hold ends). */
export const GATE_OPEN_MAX = 25_000;
export const HOLD_MS = 20_000;
/** Spots for the first lure before `no claim`; misses in a row, and in a trip, before `stalled`; the bot's own job sites lifted at most; lure blocks carried. */
export const FIRST_TRIES = 3;
export const MISSES = 3;
export const MISSES_TRIP = 6;
export const NEUTRAL_MAX = 6;
export const LURES = 4;
/** A free word on a village, and the count of its last whole look, hold this long (railshome.ts's, here for the lure: the floor's look). */
export const FRESH_FREE = 72 * 60 * 60_000;
/** `villager-moves {arm: 'free'}` is refused until S1.5's computed yard and unattended morning are in (4.10): every trip of S1 is supervised. */
export const UNSUPERVISED = false;

/**
 * `need`'s terms (s, 4.4): the walk out at 3.5 b/s (4.0 measured on the rails' walks), a look from one viewpoint, the
 * first lure (13-15 s live), a hop for each HOP_LEN to the yard gate and each YARD_HOP across the yard, the gate
 * (9.7 s live), the lock, a margin. A corridor not yet measured is the straight way stretched by a quarter. The rung's
 * variant asks NEED_PAD_S more: work.ts lateFor measures to 11000, the clock to 8700.
 */
const WALK_BS = 3.5, STRETCH = 1.25, VIEW_S = 15, FIRST_S = 20, GATE_S = 15, LOCK_S = 20, MARGIN_S = 45, NEED_PAD_S = 115;
/** A drop of the bot's own is walked to this long after it fell, then forgotten (R-2). */
const DROP_KEEP = 5 * 60_000;
/** Undo tries that fail before an entry is said as stuck (and a village lure stops new trips: R-4). */
const TRIES = 3;
/**
 * The bot's eye over its feet, and how near the eye must be to a cell's middle before a click at it: then every face of
 * it and the point a place clicks are within the bridge's 4.5, and place-block's own walk (a plain one) never starts.
 */
const EYE = 1.62;
const REACH = 4;

/** What every wait of a trip runs on (lure.ts; a test hands one of game time): real ms, and a sleep. The time of day always comes from `status`. */
export interface LureClock { now(): number; sleep(ms: number): Promise<void> }

/**
 * This brain process (a ward's `session`). The client's entity ids are the server's, and a villager unloaded and loaded
 * again comes back under a new one: an id is matched only within the process that read it, and only where the look
 * gives no uuid (a jar from before Nov 25).
 */
export const SESSION = `${process.pid.toString(36)}-${Date.now().toString(36)}`;

/** The time of day as the work day runs: from 23500 on (the bot's dawn) the minutes before 0, as a negative. */
const morning = (tod: number) => { const t = ((tod % 24_000) + 24_000) % 24_000; return t >= WORK_AT ? t - 24_000 : t; };
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
/** The idle tally's game day (as hallchores.ts gameDay: this file imports no goal). */
const gameDay = (world: WorldMemory): number => { const d: unknown = world.idle?.today?.day; return fin(d) ? d : 0; };

// ------------------------------------------------------------------------------------------------ the clock (4.4)

/** What a morning's trip is made of: the walk out and the way home in blocks (the corridor's cells once measured), the yard way's cells; `outS` the walk out as a dry run timed it. */
export interface NeedParts { out: number; toGate: number; yard: number; outS?: number }

/** `need` term by term (villager-plan prints them): seconds each. */
export function needTerms(p: NeedParts): { term: string; s: number }[] {
  const hops = Math.ceil(Math.max(0, p.toGate) / HOP_LEN), yard = Math.ceil(Math.max(0, p.yard) / YARD_HOP);
  const timed = fin(p.outS) && p.outS > 0;
  return [
    { term: timed ? 'the walk out, as timed' : `the walk out, ${Math.round(p.out)} at ${WALK_BS} b/s`, s: timed ? Math.round(p.outS!) : Math.round(Math.max(0, p.out) / WALK_BS) },
    { term: 'a look from one viewpoint', s: VIEW_S },
    { term: 'the first lure', s: FIRST_S },
    { term: `${hops} hop(s) to the yard gate, ${Math.round(p.toGate)} cells`, s: hops * HOP_S },
    { term: 'the yard gate', s: GATE_S },
    { term: `${yard} hop(s) across the yard, ${Math.round(p.yard)} cells`, s: yard * HOP_S },
    { term: 'the lock', s: LOCK_S },
    { term: 'the margin', s: MARGIN_S }
  ];
}

/**
 * The seconds from setting out to the lock's gate shut on the ward (4.4). The west village (out ~180, the way home
 * ~210, the yard's way ~30): 346 s, 6920 ticks, so a start by time of day 1780 has the lock shut by 8700. The two live
 * trips took 234 s all in.
 */
export const need = (p: NeedParts): number => needTerms(p).reduce((a, t) => a + t.s, 0);
/** The rung's variant: the start's seconds (startNeed) and NEED_PAD_S, in ms (work.ts lateFor's own clock runs to 11000, the start rule's to 8700). */
export const needMs = (p: NeedParts): number => (startNeed(p) + NEED_PAD_S) * 1000;

/**
 * A site's parts as the records have them: the walk out from `from` (where the bot sets out), the way home from it to
 * the yard gate's outer cell (the corridor's measured cells, `site.fetch.pathLen`, else the straight way and a
 * quarter), the yard way's cells (PREP's), the walk out's seconds where a dry run timed them. Hand-written records
 * are guarded: what is not a positive number is not known.
 */
export function needParts(site: Pick<VillageSite, 'x' | 'z' | 'fetch'>, from: { x: number; z: number }, gate: { x: number; z: number }, yard: number): NeedParts {
  const f: unknown = site.fetch, path = isObj(f) && fin(f.pathLen) && f.pathLen > 0 ? f.pathLen : undefined, outS = isObj(f) && fin(f.outS) && f.outS > 0 ? f.outS : undefined;
  return { out: horiz(from, site), toGate: path ?? STRETCH * horiz(site, gate), yard: Math.max(0, yard), ...(outS === undefined ? {} : { outS }) };
}

/** The seconds still to go from a hop (4.4's needLeft): a hop each HOP_LEN of the cells to the yard gate and the gate itself, a hop each YARD_HOP of the yard's, the lock. */
export const needLeft = (toGate: number, yard: number): number =>
  Math.ceil(Math.max(0, toGate) / HOP_LEN) * HOP_S + (toGate > 0 ? GATE_S : 0) + Math.ceil(Math.max(0, yard) / YARD_HOP) * HOP_S + LOCK_S;

/**
 * The seconds a trip must have in hand when it sets out, or when its first lure goes down (4.4's start rule as the
 * first hop's own rule asks it): the ward in the lock by IN_BY with the margin (`need`), and also what clock rule 3
 * asks at the first hop, the walk out, the look and the first lure and then COMMIT x what is still to go from there
 * (needLeft). B2 found the two apart (Nov 25): on `need` alone a trip set out near its limit had its first hop let go
 * by rule 3 (the west village: 346 s, but 86 + 1.3 x 215 = 366 at the first hop), so the safe side is the larger.
 * The parts from the village itself (`out` 0) are the first lure's.
 */
export function startNeed(p: NeedParts): number {
  const lead = needTerms(p).slice(0, 3).reduce((a, t) => a + t.s, 0);
  return Math.max(need(p), Math.ceil(lead + COMMIT * needLeft(p.toGate, p.yard)));
}

/**
 * The start rule (4.4, B3): no trip sets out, and no first lure goes down, that the clock says cannot have the ward in
 * the lock by IN_BY (`needS`: startNeed's seconds, so the first hop's rule 3 lets it go on too). Undefined when it
 * fits; else the decline, with its seconds ("needs 366 s to have it in the lock by 8700, 310 s left: tomorrow"), which
 * `fetch.why.dawn` counts.
 */
export function startLate(tod: number, needS: number): string | undefined {
  const t = morning(tod);
  if (t + Math.max(0, needS) * 20 <= IN_BY) return undefined;
  return `needs ${Math.round(needS)} s to have it in the lock by ${IN_BY}, ${Math.max(0, Math.floor((IN_BY - t) / 20))} s left: tomorrow`;
}

/** The clock's answer: what to do, by which of 4.4's five rules, the seconds to spare against that rule's deadline, and why in words. */
export interface ClockSays { go: 'on' | 'run on' | 'release' | 'stop'; rule: 1 | 2 | 3 | 4 | 5; inHandS: number; text: string }

/**
 * The clock's answer at a hop (4.4): `on`; `run on` (committed and late: the waits cut, no hold for a player); `release`
 * (not committed, and the time left does not fit with COMMIT x in hand: let go near its village, on ground it walks
 * back); `stop` (the bell came first: the lure up, the ward astray, the lead decides). Rule 1 is a ward whose bell the
 * lead cleared: on while the lock's gate can be shut by NIGHT with it inside the fence, or the bot home by RETURN_AT
 * (the shelter's cut) with it outside. Before the first flip there is no ward: the bell's rules.
 *
 * Deadlines are the game's ticks as read at the poll, waits are real time: on a slow server the time of day decides,
 * and `needLeft`'s seconds (20 ticks each) err to its side.
 */
export function clock(tod: number, needLeftS: number, ward: Pick<Ward, 'bell'> | undefined, trip: Pick<Trip, 'committed'>, o: { inside?: boolean } = {}): ClockSays {
  const t = morning(tod), ticks = Math.max(0, needLeftS) * 20;
  const inHand = (by: number, k = 1) => Math.floor((by - t - k * ticks) / 20);
  if (ward && !ward.bell) {
    const by = o.inside ? NIGHT : RETURN_AT, s = inHand(by), what = o.inside ? 'the lock\'s gate shut' : 'home';
    return s >= 0 ? { go: 'on', rule: 1, inHandS: s, text: `no bell: ${what} by ${by}, ${s} s in hand` }
      : { go: 'stop', rule: 1, inHandS: s, text: `no bell, but not ${what} by ${by}: ${-s} s short` };
  }
  const fits = inHand(IN_BY);
  if (!trip.committed) {
    const margin = inHand(IN_BY, COMMIT);
    return margin >= 0 ? { go: 'on', rule: 2, inHandS: fits, text: `in the lock by ${IN_BY}: ${fits} s in hand` }
      : { go: 'release', rule: 3, inHandS: fits, text: `${Math.round(needLeftS)} s left and ${fits} s in hand: short of ${COMMIT} x the time left before ${IN_BY}` };
  }
  if (fits >= 0) return { go: 'on', rule: 2, inHandS: fits, text: `in the lock by ${IN_BY}: ${fits} s in hand` };
  if (t < BELL) return { go: 'run on', rule: 4, inHandS: fits, text: `committed (${trip.committed}) and ${-fits} s late for ${IN_BY}: on to the lock before the bell (${BELL})` };
  return { go: 'stop', rule: 5, inHandS: fits, text: `the bell (${BELL}) came first, committed (${trip.committed}), the lock's gate not shut` };
}

/**
 * The floor (4.1, F-15): one viewpoint cannot count a village 126 x 121, so a take is allowed by the last WHOLE look,
 * under 72 h old, less the takes since: `villagers - takes >= VILLAGE_MIN` (the user's floor of 5). The west village
 * (7 seen, 2 taken): "1 take left at the floor of 5", then `wait`. Hand-written numbers are guarded.
 */
export function floorOk(site: Pick<VillageSite, 'whole'>, now: number): { ok: boolean; left: number; text: string } {
  const w: unknown = site.whole;
  if (!isObj(w) || !fin(w.at) || !fin(w.villagers) || !fin(w.takes)) return { ok: false, left: 0, text: 'not counted whole yet: a whole look first' };
  const left = Math.max(0, Math.floor(w.villagers - w.takes - VILLAGE_MIN + 1));
  if (now - w.at > FRESH_FREE) return { ok: false, left, text: `counted whole ${Math.round((now - w.at) / 3_600_000)} h ago: a whole look first` };
  if (!left) return { ok: false, left, text: `${w.villagers} seen, ${w.takes} taken: no take left at the floor of ${VILLAGE_MIN}` };
  return { ok: true, left, text: `${left} take${left === 1 ? '' : 's'} left at the floor of ${VILLAGE_MIN}` };
}

/**
 * Why no trip ran, by stage (B16, F-42), written where it is found (PREP's decline, the dawn's seconds in hand, the
 * look's result) and printed in `Fetch:`; at 3 the line asks the lead. The same reason (its words, the numbers in them
 * aside: "310 s in hand" one dawn is "295 s in hand" the next) counts on, once a game day for PREP and the dawn and
 * once a look for the looks; another reason starts again at 1; none clears the stage. A write: the caller saves.
 */
export function noteWhy(world: WorldMemory, k: 'prep' | 'dawn' | 'look', text: string | undefined, now: number): number {
  const f = fetchOf(world);
  if (text === undefined) {
    if (f.why) { delete f.why[k]; if (!Object.keys(f.why).length) delete f.why; }
    return 0;
  }
  const gist = (s: string) => s.replace(/-?\d+(\.\d+)?/g, '#');
  const day = gameDay(world), was = f.why?.[k];
  const again = !!was && gist(was.text) === gist(text);
  const newDay = !!was && (day > 0 && fin(was.day) ? was.day !== day : now - was.at >= GAME_DAY);
  const n = !was || !again ? 1 : k === 'look' || newDay ? was.n + 1 : was.n;
  // (`at`: when it was last counted, so a day with no game day known is a game day's time from then)
  (f.why ??= {})[k] = { at: was && again && n === was.n ? was.at : now, n, text, ...(day > 0 ? { day } : {}) };
  return n;
}

// ------------------------------------------------------------------------------------------------ the trip (2.2)

/**
 * Where a trip may go from each state (2.2's table): on through its steps, back a step where the table has one (the
 * next gate of `spare`, hop by hop; into the yard again from the lock), and to `restore` from anywhere (a release, a
 * stop, a decline, a cut out or survey). Staying in a state is always allowed (the next hop; a run going on from a cut).
 */
const NEXT: Record<TripState, readonly TripState[]> = {
  prep: ['out', 'restore'], out: ['survey', 'restore'], survey: ['first', 'restore'], first: ['hop', 'restore'], hop: ['gate', 'restore'],
  gate: ['yardhop', 'hop', 'restore'], yardhop: ['lock', 'restore'], lock: ['door', 'yardhop', 'restore'], door: ['restore'], restore: []
};
/** The seconds each state took, as `times` keeps them (the `timing:` log line). */
const TIMED: Partial<Record<TripState, keyof Trip['times']>> = { out: 'out', survey: 'survey', first: 'first', hop: 'hops', gate: 'gate', yardhop: 'yard', lock: 'lock', door: 'door' };

/**
 * A trip begun (2.2): `prep` for a bring (care row 10: saved when PREP's first part begins), or a rescue the lead armed,
 * joining at `hop` outside the fence or `yardhop` inside it. Numbered from the journal's ids, so a trip is numbered
 * once. At most one: a second throws (the journal and the wards are one trip's).
 */
export function newTrip(ctx: Run, o: { site: string; gate: YardGateWay; spare?: YardGateWay[]; state?: 'prep' | 'hop' | 'yardhop'; ward?: string; dry?: boolean }, now: number): Trip {
  const f = fetchOf(ctx.world);
  if (f.trip) throw new Error(`trip ${f.trip.id} is ${f.trip.state}: one trip at a time`);
  const state = o.state ?? 'prep';
  const t: Trip = {
    id: f.nextId++, kind: state === 'prep' ? 'bring' : 'rescue', site: o.site, state, beat: now, entered: now, prep: {}, gate: o.gate, spare: o.spare ?? [],
    lure: 'fletching_table', avoid: [], times: {}, counts: { hops: 0, misses: 0, wedges: 0, pins: 0 }, ...(o.ward ? { ward: o.ward } : {}), ...(o.dry ? { dry: true as const } : {})
  };
  f.trip = t;
  ctx.save?.();
  return t;
}

/**
 * The trip on to `to`, written and SAVED before the first act of that state (a kill then finds the state it was in:
 * 3.3's recovery is by state). A move 2.2 has no row for throws: it is a bug, and the record must not say what did not
 * happen. Leaving a state adds its seconds to `times`; `out` stamps `began` (with the time of day read, `o.tod`); any
 * move ends a cut (the run that goes on from it is the trip's again).
 */
export function tripTo(ctx: Run, to: TripState, now: number, o: { tod?: number } = {}): Trip {
  const t = fetchOf(ctx.world).trip;
  if (!t) throw new Error(`no trip to move on to ${to}`);
  if (to !== t.state && !NEXT[t.state].includes(to)) throw new Error(`trip ${t.id}: no way from ${t.state} to ${to}`);
  if (to !== t.state) {
    const k = TIMED[t.state];
    if (k && fin(t.entered)) t.times[k] = (t.times[k] ?? 0) + Math.max(0, Math.round((now - t.entered) / 1000));
    t.entered = now;
  }
  if (to === 'out' && !t.began && fin(o.tod)) t.began = { at: now, tod: o.tod, day: gameDay(ctx.world) };
  t.state = to;
  t.beat = now;
  delete t.cut;
  ctx.save?.();
  return t;
}

/** A live run's beat (every poll, 10 s at most): not saved, since a restart finds every beat stale whatever the file says. */
export function beat(world: WorldMemory, now: number): void {
  const t = fetchOf(world).trip;
  if (t) t.beat = now;
}

/** The exit handler's last act (3.3): the trip marked cut, and why, saved; care's row 3 goes on from it by day. */
export function cutTrip(ctx: Run, why: string, now: number): Trip | undefined {
  const t = fetchOf(ctx.world).trip;
  if (!t) return undefined;
  t.cut = { at: now, why: why.slice(0, 120) };
  ctx.save?.();
  return t;
}

/** A trip's end as the run knows it (in the hall, released, stopped, declined): `last` written, the trip on to `restore`, saved. restoreAll deletes it once its entries are undone. */
export function endTrip(ctx: Run, text: string, got: 0 | 1, now: number): void {
  const f = fetchOf(ctx.world);
  f.last = { at: now, text: text.slice(0, 200), got };
  if (f.trip?.haltAtEnd) f.halt ??= { at: now, why: f.trip.haltAtEnd.slice(0, 300) };
  if (f.trip && f.trip.state !== 'restore') tripTo(ctx, 'restore', now);
  else ctx.save?.();
}

// ------------------------------------------------------------------------------------------------ the wards seen

/** A row of a look at the world's entities (world.entities), with what the watch reads of a villager. */
export type Looked = Seen & { health?: number };
/**
 * A ward in a look: the row that is it and how it was known (`uuid`; `id`, within this process and only where the
 * look gives no uuid; `near`, the fallback of a jar with none), where that row stands (the lock's six cells, the
 * hall's box), and `taken` when someone has it (it is off the wards then).
 */
export interface WardSight { ward: Ward; seen?: Looked; by?: 'uuid' | 'id' | 'near'; inLock: boolean; inHall: boolean; taken?: string }

/** The profession a lure gives (S1: the fletching table, fixed). */
const GIVES: Record<string, string> = { fletching_table: 'fletcher' };
/** The fallback binds a ward to the lure's worker this near it (an employed villager keeps within ~9 of its block). */
const NEAR_LURE = 9;

/** In the lock's six inside cells (the landmark zones `lock:inside`), at their floor's level. */
function inLockBox(world: WorldMemory, p: Pos): boolean {
  const c = cell(p);
  return (world.zones?.['lock:inside'] ?? []).some(z => isPos(z) && z.x === c.x && z.z === c.z && Math.abs(c.y - z.y) <= 1);
}

/** The hall's census as last counted (hallchores.ts noteHall), by uuid and by id: who lives there. */
function censusOf(world: WorldMemory): { uuid?: string; id?: number }[] {
  const c: unknown = world.hallChores?.census;
  const vs = isObj(c) && Array.isArray(c.villagers) ? c.villagers : [];
  return vs.filter(isObj).map(v => ({ ...(str(v.uuid) ? { uuid: v.uuid } : {}), ...(fin(v.id) ? { id: v.id } : {}) }));
}

/**
 * Every ward found in a look and its record brought up to it (the tick's watch, `discover`, the hop loop's polls: an
 * overworld look). Known by its uuid; else by the id this process read it under; else, for a ward of a jar that gave
 * no uuid, the nearest worker of the lure within 9 of it (`o.lure`), never a villager in the hall's box or its census
 * (a resident is not taken for the ward: F-33). Seen, its `last` is what the look says (`o.tod`: the time of day read
 * with it); a new id is bound to it, a uuid where it had none (and its key, and the trip's, with it).
 *
 * And `where` from the boxes, by R-9: only a WHOLE look lowers. A ward in the lock seen outside the lock and the hall is
 * astray; one astray (or led, with no run leading it) seen in the lock with its gate read shut (`o.pShut`) or in the
 * hall's box is in the lock (contained: care's row 5 counts it home once it is in the hall). Health read 0: dead. One
 * that goes astray or dead sets `halt`. A ward named, on a lead or in a vehicle not the bot's is someone's: off the
 * wards, never contested (`taken`).
 *
 * An astray ward's `last.t` is not renewed while it stays astray: R-8's two days run from when it went astray, and
 * a ward seen daily from home would else hold the lifts and the guards for good. A write: the caller saves.
 */
export function wardSeen(world: WorldMemory, seen: readonly Looked[], whole: boolean, now: number, o: { tod?: number; lure?: Pos; pShut?: boolean } = {}): WardSight[] {
  const f = fetchOf(world);
  if (!f.wards.length) return [];
  const rows = seen.filter(e => isObj(e) && e.name === 'villager' && isPos(e.position));
  const live = tripLive(world, now), census = censusOf(world);
  const found = new Map<Ward, { e: Looked; by: NonNullable<WardSight['by']> }>();
  for (const w of f.wards) {
    const u = rows.find(e => str(e.uuid) && (e.uuid === w.uuid || e.uuid === w.key));
    const i = u ? undefined : rows.find(e => fin(w.id) && w.session === SESSION && e.id === w.id && (!e.uuid || !w.uuid));
    if (u || i) found.set(w, { e: (u ?? i)!, by: u ? 'uuid' : 'id' });
  }
  const t = f.trip, lure = o.lure, kind = GIVES[t?.lure ?? 'fletching_table'];
  const bound = new Set([...found.values()].map(v => v.e));
  for (const w of f.wards) {
    if (found.has(w) || w.uuid || !w.key.startsWith('at:') || !lure || t?.ward !== w.key) continue;
    const near = rows.filter(e => !bound.has(e) && e.profession === kind && horiz(e.position!, mid(lure)) <= NEAR_LURE && !inHall(world, cell(e.position!))
      && !census.some(c => (c.uuid && c.uuid === e.uuid) || (c.id !== undefined && c.id === e.id)))
      .sort((a, b) => horiz(a.position!, mid(lure)) - horiz(b.position!, mid(lure)))[0];
    if (near) { found.set(w, { e: near, by: 'near' }); bound.add(near); }
  }
  const out: WardSight[] = [];
  for (const w of [...f.wards]) {
    const hit = found.get(w);
    if (!hit) { out.push({ ward: w, inLock: false, inHall: false }); continue; }
    const { e, by } = hit, at = { ...e.position! }, inLock = inLockBox(world, at), inBox = inHall(world, cell(at));
    const car = e.vehicleId === undefined ? undefined : seen.find(v => isObj(v) && v.id === e.vehicleId);
    const taken = e.named || e.customName ? `named${e.customName ? ` "${e.customName}"` : ''}` : e.leashed ? 'on a lead'
      : e.vehicleId !== undefined && !car?.own ? `in a ${car?.name ?? e.vehicle ?? 'vehicle'} not the bot's` : undefined;
    if (taken) {
      f.wards = f.wards.filter(x => x !== w);
      out.push({ ward: w, seen: e, by, inLock, inHall: inBox, taken: `taken by someone (${taken}) at ${fmt(at)}: theirs, never contested` });
      continue;
    }
    w.id = e.id;
    w.session = SESSION;
    if (str(e.uuid) && !w.uuid) {
      if (t?.ward === w.key) t.ward = e.uuid;
      w.uuid = e.uuid;
      w.key = e.uuid;
    }
    const health = fin(e.health) ? e.health : w.last.health;
    const was = w.where;
    let where: Ward['where'] = was, note = '';
    if (health <= 0) { where = 'dead'; note = `health read 0 at ${fmt(at)}`; }
    else if (was === 'dead') { where = 'astray'; note = `seen alive at ${fmt(at)}`; }
    else if (was !== 'lock' && !live && ((inLock && o.pShut) || (inBox && whole))) { where = 'lock'; note = inBox ? 'seen in the hall' : 'seen in the lock, its gate shut'; }
    else if (was === 'lock' && whole && !inLock && !inBox) { where = 'astray'; note = `out of the lock: seen at ${fmt(at)}`; }
    w.last = { at, t: was === 'astray' && where === 'astray' ? w.last.t : now, tod: fin(o.tod) ? o.tod : w.last.tod, health, profession: e.profession ?? w.last.profession };
    if (where !== was) {
      w.where = where;
      w.note = note.slice(0, 120);
      // (in S1 a ward astray or dead is the lead's: no new trip until a person has looked, as care's row 1 does)
      if (where === 'astray' || where === 'dead') f.halt ??= { at: now, why: `ward ${w.key.slice(0, 8)} ${where === 'dead' ? 'is dead' : 'is astray'}: ${note}` };
    }
    // (an overworld look: back from the Nether, if it was ever gone there)
    delete w.dim;
    out.push({ ward: w, seen: e, by, inLock, inHall: inBox });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ undo (R-2, R-3, R-4)

/** What an undo came to: `ok`, the entry is off the journal (undone, found as it should be, or forgotten); else it is kept, `tried` when an act was made and failed (R-4 counts those). */
export interface Undone { ok: boolean; text: string; tried?: boolean }

/**
 * What the bridge's place puts a block into as into air (tools.ts ROOM: the 26.3 jar's canBeReplaced): a lifted
 * block's cell holding one is empty for the put-back.
 */
const ROOM = new RegExp('^(air|cave_air|void_air|water|lava|bubble_column|fire|soul_fire|light|structure_void|short_grass|tall_grass|fern|large_fern|dead_bush|bush'
  + '|red_shrub|short_dry_grass|tall_dry_grass|leaf_litter|seagrass|tall_seagrass|vine|glow_lichen|resin_clump|hanging_roots|crimson_roots|warped_roots|nether_sprouts)$');
const room = (state: string) => ROOM.test(idOf(state)) || /^(minecraft:)?snow(\[layers=1\])?$/.test(state);
const propsOf = (state: string): Record<string, string> =>
  Object.fromEntries((/\[(.*)\]$/.exec(state)?.[1] ?? '').split(',').filter(Boolean).map(kv => kv.split('=') as [string, string]));
const SIDES: Record<string, [number, number]> = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
const GATE_NAME: Record<string, string> = { yard: 'yard\'s gate', lock: 'lock\'s gate', hall: 'hall\'s gate' };
/** A reason that is not a failed act: the cell far off, the run given up. */
const NOT_TRIED = /^(not loaded|aborted)/;

const stopped = (ctx: Pick<GoalContext, 'signal'>) => { if (ctx.signal.aborted) throw new Error('aborted'); };
const stateAt = async (ctx: Pick<GoalContext, 'call'>, p: Pos): Promise<string | undefined> =>
  (await ctx.call<{ blocks?: (string | null)[] }>('world.region', { x: p.x, y: p.y, z: p.z, width: 1, height: 1, length: 1 }).catch(() => undefined))?.blocks?.[0] ?? undefined;
const gateOpen = async (ctx: Pick<GoalContext, 'call'>, g: Pos): Promise<boolean | undefined> => { const s = await stateAt(ctx, g); return s === undefined ? undefined : /open=true/.test(s); };
const here = async (ctx: Pick<GoalContext, 'status' | 's'>): Promise<Pos> => (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
const eyeTo = (me: Pos, c: Pos) => Math.hypot(me.x - c.x - 0.5, me.y + EYE - c.y - 0.5, me.z - c.z - 0.5);
const carried = async (ctx: Pick<GoalContext, 'call'>, item: string): Promise<number> =>
  ((await ctx.call<{ items?: { name: string; count: number; slot: number }[] }>('inventory').catch(() => undefined))?.items ?? [])
    .filter(i => i.slot < 36 && i.name === item).reduce((a, i) => a + i.count, 0);
/** The run's own clock where the caller hands none: its snapshot's time, and the real time since. */
const runClock = (ctx: Pick<GoalContext, 's'>): (() => number) => { const t0 = Date.now(); return () => ctx.s.now + (Date.now() - t0); };

/**
 * yardgates.ts shutGate (the careful walk into reach, the lock's two gates from its post, the bridge's own click, the
 * read back) and project.ts prepare (the pockets, the chests, a craft), loaded when first asked: both import the
 * goals, which import this file, and a static import here would load them in another order (this file is asked by
 * village.ts, the structures, tidy and repair whichever is loaded first).
 */
const shutGate = async (ctx: GoalContext, g: Pos): Promise<boolean> => (await import('./yardgates.js')).shutGate(ctx, g);
const prepare = async (ctx: GoalContext, item: string): Promise<Record<string, number>> => (await import('./project.js')).prepare(ctx, item, 1);

/** A careful walk (Baritone breaks and places nothing by a villager) into a click's reach of a cell, or onto `stand`; whether the bot is in reach of the cell then. */
async function into(ctx: GoalContext, c: Pos, stand?: Pos): Promise<boolean> {
  if (!stand && eyeTo(await here(ctx), c) <= REACH) return true;
  const to = stand ?? c;
  await ctx.call('goto', { x: to.x, y: to.y, z: to.z, range: stand ? 0 : 2, careful: true, timeoutMs: 45_000 }, 60_000).catch(() => undefined);
  stopped(ctx);
  return eyeTo(await here(ctx), c) <= REACH;
}
/** One of `item` in the pockets: carried, else from the chests, else made (B13: a lifted block lost with the bot is made again). */
async function ensure(ctx: GoalContext, item: string): Promise<string | undefined> {
  if (await carried(ctx, item) > 0) return undefined;
  const short = await prepare(ctx, item).catch((e: Error) => ({ [e.message]: 0 }));
  stopped(ctx);
  if (await carried(ctx, item) > 0) return undefined;
  return `no ${item}, and none made (short of ${Object.entries(short).map(([k, n]) => (n ? `${k} ${n}` : k)).join(', ') || 'it'})`;
}
/** The lock's gate read shut, shut first if it reads open (it is never left open onto the socket's hole); undefined: not read. */
async function lockShut(ctx: GoalContext, p: Pos): Promise<boolean | undefined> {
  const open = await gateOpen(ctx, p);
  if (open !== true) return open === undefined ? undefined : true;
  return (await shutGate(ctx, p)) && (await gateOpen(ctx, p)) === false;
}

/**
 * A lure or a cover taken up (R-2, R-5): own.take reads the cell, digs only the bot's own `item` (dig.here, never
 * `force`) and takes the protection record off. A lure after a careful walk into reach; the build's plug from where
 * the bot stands, with no walk of its own (it is in the hall's doorway inside the lock: hallshells.ts plugOut goes in
 * by the lock's gate first, and a walk "up to it" from the yard would be one through that gate).
 */
async function takeUp(ctx: GoalContext, e: Extract<Change, { k: 'lure' | 'cover' }>, now: () => number): Promise<Undone> {
  if (!ctx.own) return { ok: false, text: 'this runtime takes up no blocks of its own (own.take)' };
  const stay = e.k === 'cover';
  if (!stay) await into(ctx, e.at);
  const r = await ctx.own.take(e.at, e.item, { adopt: true, stay });
  if (r.ok) {
    // (a drop that did not come in: walked onto within 5 minutes, else forgotten)
    if (r.dug && r.pickedUp === false) journal(ctx, { k: 'drop', trip: e.trip, at: { ...e.at }, item: e.item, t: now() });
    dropEntry(ctx, e);
    return { ok: true, text: r.dug ? `took up the ${e.item} at ${fmt(e.at)}${r.pickedUp === false ? ' (its drop not picked up yet)' : ''}` : `nothing at ${fmt(e.at)} any more${r.block ? ` (${r.block})` : ''}: off the journal` };
  }
  // another block in the cell: never dug (someone broke the bot's and put their own: theirs; or the bot's own other block, kept)
  if (r.block) {
    dropEntry(ctx, e);
    return { ok: true, text: `${r.block} stands at ${fmt(e.at)} where its ${e.item} was: ${/^the bot's own/.test(r.reason ?? '') ? 'the bot\'s own, left' : 'someone\'s now, never dug'}` };
  }
  return { ok: false, tried: !NOT_TRIED.test(r.reason ?? ''), text: `the ${e.item} at ${fmt(e.at)} not taken up: ${r.reason ?? 'no answer'}` };
}

/** The socket's wall block back (own.put from the post: the bot's own again, protected before it goes down). */
async function wallIn(ctx: GoalContext, e: Extract<Change, { k: 'lift' }>): Promise<Undone> {
  const none = await ensure(ctx, e.item);
  if (none) return { ok: false, tried: true, text: `the socket at ${fmt(e.at)} stays open: ${none}` };
  const r = await ctx.own!.put(e.at, e.item, { stay: true });
  if (!r.placed) return { ok: false, tried: !NOT_TRIED.test(r.reason ?? ''), text: `the socket's wall block did not go back at ${fmt(e.at)}: ${r.reason ?? 'not placed'}` };
  dropEntry(ctx, e);
  return { ok: true, text: `put the wall block back in the socket at ${fmt(e.at)}${r.ok ? '' : ` (${r.block})`}` };
}

/** Where the lock's gate and the bot's post are (its landmark zones), or why the socket waits. */
function lockAt(world: WorldMemory): { p: Pos; post: Pos } | undefined {
  const z = world.zones ?? {}, p = z['lock:gate']?.[0], post = z['lock:post']?.[0];
  return isPos(p) && isPos(post) ? { p, post } : undefined;
}
async function atPost(ctx: GoalContext, lock: { p: Pos; post: Pos }, socket: Pos): Promise<Undone | undefined> {
  const shut = await lockShut(ctx, lock.p);
  if (shut !== true) return { ok: false, tried: shut === false, text: shut === false ? `the lock's gate at ${fmt(lock.p)} does not read shut: its socket waits` : `the lock's gate at ${fmt(lock.p)} could not be read` };
  if (!(await into(ctx, socket, lock.post))) return { ok: false, tried: true, text: `no way on foot to the lock's post at ${fmt(lock.post)}` };
  return undefined;
}

/**
 * The lock's lure out of its socket and the wall block back in the same act (R-3, DOOR step 1): the lock's gate read
 * shut first, from the post (the hole, one high, is open a second; the sill outside it). The wall's own entry is
 * dropped with it, or left for its own undo when the block does not go back.
 */
async function socketOut(ctx: GoalContext, e: Extract<Change, { k: 'lure' }>, now: () => number): Promise<Undone> {
  const lock = lockAt(ctx.world);
  if (!lock) return takeUp(ctx, e, now);
  if (!ctx.own) return { ok: false, text: 'this runtime takes up no blocks of its own (own.take)' };
  const not = await atPost(ctx, lock, e.at);
  if (not) return not;
  const r = await ctx.own.take(e.at, e.item, { stay: true, adopt: true });
  if (!r.ok && !r.block) return { ok: false, tried: !NOT_TRIED.test(r.reason ?? ''), text: `the lock's lure at ${fmt(e.at)} not taken out: ${r.reason ?? 'no answer'}` };
  dropEntry(ctx, e);
  const wall = fetchOf(ctx.world).journal.find((x): x is Extract<Change, { k: 'lift' }> => x.k === 'lift' && x.why === 'socket' && same(x.at, e.at));
  const out = r.ok ? `took the lock's lure out of its socket at ${fmt(e.at)}` : `${r.block} stands in the socket at ${fmt(e.at)}`;
  if (!wall) return { ok: true, text: out };
  // (the bot's own wall block back already: a kill after DOOR's put-back left the two records)
  if (!r.ok) {
    if (r.block === idOf(wall.block)) { dropEntry(ctx, wall); return { ok: true, text: `${out}: the wall block is back` }; }
    return { ok: true, text: `${out}: someone's, never dug` };
  }
  const back = await wallIn(ctx, wall);
  return { ok: true, text: back.ok ? `${out} and put the wall block back` : `${out}; ${back.text}` };
}

/** The socket's wall block alone (a kill in DOOR step 1 left the cell air: one high, the lock's gate shut, the sill outside): from the post, the gate read shut first. */
async function socketBack(ctx: GoalContext, e: Extract<Change, { k: 'lift' }>): Promise<Undone> {
  const lock = lockAt(ctx.world), st = await stateAt(ctx, e.at);
  if (st === undefined) return { ok: false, text: `the socket at ${fmt(e.at)} could not be read` };
  if (idOf(st) === idOf(e.block)) { dropEntry(ctx, e); return { ok: true, text: `the socket's wall block stands at ${fmt(e.at)}` }; }
  if (!room(st)) return { ok: false, tried: true, text: `the socket at ${fmt(e.at)} holds ${idOf(st)}: left as it is` };
  if (!lock || !ctx.own) return { ok: false, text: !lock ? 'no lock stands to put its socket back in' : 'this runtime puts down no blocks of its own (own.put)' };
  return (await atPost(ctx, lock, e.at)) ?? wallIn(ctx, e);
}

/**
 * A job block or a thin block of the bot's own put back where it was lifted (R-2): the cell read first (it stands
 * there: done; another block: someone's, or the bot's own build, never dug, and not put back), the item carried, else
 * from the chests, else made; then place-block after a careful walk into reach. A block that faces a way (a lectern,
 * a loom, a bench's stairs) goes back facing it: the bot stands two cells back along the way the placer looks, and
 * the place turns it to the cell.
 */
async function putBack(ctx: GoalContext, e: Extract<Change, { k: 'lift' }>): Promise<Undone> {
  const what = `the ${e.item} at ${fmt(e.at)}`;
  let st = await stateAt(ctx, e.at);
  if (st === undefined) { await into(ctx, e.at); st = await stateAt(ctx, e.at); }
  if (st === undefined) return { ok: false, text: `${fmt(e.at)} not loaded: ${what} goes back when the bot is by it` };
  if (idOf(st) === idOf(e.block)) { dropEntry(ctx, e); return { ok: true, text: `${what} stands again` }; }
  if (!room(st)) { dropEntry(ctx, e); return { ok: true, text: `${idOf(st)} stands at ${fmt(e.at)} where the ${e.item} was lifted: not put back, never dug` }; }
  const none = await ensure(ctx, e.item);
  if (none) return { ok: false, tried: true, text: `${what} not put back: ${none}` };
  const facing = propsOf(e.block).facing, look = facing && SIDES[facing] ? SIDES[placerFacing(idOf(e.block), facing)] : undefined;
  const stand = look ? { x: e.at.x - 2 * look[0], y: e.at.y, z: e.at.z - 2 * look[1] } : undefined;
  if (!((stand && await into(ctx, e.at, stand)) || await into(ctx, e.at))) return { ok: false, tried: true, text: `no way on foot into reach of ${fmt(e.at)}` };
  let said = '';
  for (let i = 0; i < 2; i++) {
    stopped(ctx);
    const r = await ctx.act('place-block', { ...e.at, item: e.item, faceDirection: 'down' }).catch((x: Error) => ({ ok: false, text: x.message }));
    said = r.text;
    const there = /already a block \(([a-z_:]+)/.exec(r.text)?.[1];
    if (/^Placed/.test(r.text) || (there && idOf(there) === idOf(e.block))) { dropEntry(ctx, e); return { ok: true, text: `put ${what} back` }; }
    if (there) { dropEntry(ctx, e); return { ok: true, text: `${idOf(there)} stands at ${fmt(e.at)} where the ${e.item} was lifted: not put back, never dug` }; }
    if (!/where you're standing/.test(r.text)) break;
    await ctx.call('goto', { ...e.at, away: 2, careful: true, timeoutMs: 10_000 }, 20_000).catch(() => undefined);
  }
  return { ok: false, tried: true, text: `${what} not put back: ${said.slice(0, 100)}` };
}

/** A gate held for a ward read, shut if open (yardgates.ts shutGate: careful walk, the bridge's click, read back), its hold let go, read shut: off the journal. */
async function gateShut(ctx: GoalContext, e: Extract<Change, { k: 'gate' }>): Promise<Undone> {
  const name = `${GATE_NAME[e.which] ?? 'gate'} at ${fmt(e.at)}`, open = await gateOpen(ctx, e.at);
  if (open === undefined) return { ok: false, text: `the ${name} could not be read` };
  if (open && !(await shutGate(ctx, e.at))) return { ok: false, tried: true, text: `the ${name} does not read shut` };
  // (the hold off: the bridge's own shut-if-open with it, which never opens a gate; a jar with no holds has no hold to let go)
  await ctx.call('gates.release', { x: e.at.x, y: e.at.y, z: e.at.z, shut: true }).catch(() => undefined);
  if (await gateOpen(ctx, e.at) !== false) return { ok: false, tried: true, text: `the ${name} does not read shut` };
  dropEntry(ctx, e);
  return { ok: true, text: open ? `shut the ${name}` : `the ${name} reads shut: its hold let go` };
}

/** A drop of the bot's own walked onto (carefully) within 5 minutes of its fall, else forgotten; off the journal either way. */
async function pickUp(ctx: GoalContext, e: Extract<Change, { k: 'drop' }>, now: () => number): Promise<Undone> {
  if (now() - e.t > DROP_KEEP) { dropEntry(ctx, e); return { ok: true, text: `the ${e.item} dropped at ${fmt(e.at)} over 5 minutes ago: forgotten` }; }
  const had = await carried(ctx, e.item);
  await ctx.call('goto', { x: e.at.x, y: e.at.y, z: e.at.z, range: 0, careful: true, timeoutMs: 15_000 }, 25_000).catch(() => undefined);
  stopped(ctx);
  const got = await carried(ctx, e.item) > had;
  dropEntry(ctx, e);
  return { ok: true, text: got ? `picked up the ${e.item} at ${fmt(e.at)}` : `walked onto the ${e.item} dropped at ${fmt(e.at)}: not there, forgotten` };
}

type UndoOf<K extends Change['k']> = (ctx: GoalContext, e: Extract<Change, { k: K }>, now: () => number) => Promise<Undone>;
/**
 * The undo of each kind (R-2): the cell read, and at most one act; an entry dropped only once a read confirms. Each is
 * idempotent: asked again, or after a kill at any call of its own, it finds the cell as it should be and drops the
 * entry with no act. The plug (`cover`) is the shells goal's and care's (hallshells.ts plugOut: in by the lock's
 * gate), the hall's gate opened behind the lock's shut one is care's row 5: restoreAll asks neither.
 */
export const UNDO: { [K in Change['k']]: UndoOf<K> } = {
  lure: (ctx, e, now) => (e.role === 'lock' ? socketOut(ctx, e, now) : takeUp(ctx, e, now)),
  cover: (ctx, e, now) => takeUp(ctx, e, now),
  lift: (ctx, e) => (e.why === 'socket' ? socketBack(ctx, e) : putBack(ctx, e)),
  gate: (ctx, e) => gateShut(ctx, e),
  drop: (ctx, e, now) => pickUp(ctx, e, now)
};

/**
 * One journal entry undone (R-2), by its id: gone already, nothing to do. A failed act counts a try (R-4): a lure in
 * a village failing 3 times sets `halt` and is never dropped for it (a table left standing in a village for a day is
 * what this whole record is for: the lead takes it up); any other is kept and said as stuck.
 */
export async function undo(ctx: GoalContext, entry: Pick<Change, 'id'>, o: { now?: () => number } = {}): Promise<Undone> {
  stopped(ctx);
  const f = fetchOf(ctx.world), e = f.journal.find(x => x.id === entry.id);
  if (!e) return { ok: true, text: 'off the journal already' };
  const now = o.now ?? runClock(ctx);
  const r = await (UNDO[e.k] as UndoOf<Change['k']>)(ctx, e as never, now);
  if (!r.ok && r.tried && f.journal.includes(e)) {
    e.tries = (e.tries ?? 0) + 1;
    if (e.k === 'lure' && e.inVillage && e.tries >= TRIES) {
      f.halt ??= { at: now(), why: `the lure in the village at ${fmt(e.at)} would not come up ${e.tries} times (${r.text.slice(0, 80)}): the lead takes it up, then clears the halt` };
    }
    ctx.save?.();
  }
  return r;
}

/**
 * A `planned` or `unsure` entry made true by a read of its cell (X1; 3.3's resume begins with it). Killed between the
 * journal's write and the act, the cell is as it was; between the act and its reply, the block is there. A lure or a
 * cover standing: `down`. Nothing there: off the journal, and own.take's own read takes the protection record off
 * with it (a record with no block by the house is a free fletching table the repair round would stand there: I-12).
 * A lift whose block still stands: nothing was lifted, off the journal; its cell empty: `done`. Answers what the
 * entry is now: 'down', 'done', 'gone', or undefined (not one to reconcile, or its cell not read).
 */
export async function reconcile(ctx: GoalContext, entry: Pick<Change, 'id'>): Promise<'down' | 'done' | 'gone' | undefined> {
  const e = fetchOf(ctx.world).journal.find(x => x.id === entry.id);
  if (!e) return 'gone';
  if (e.k === 'gate' || e.k === 'drop') return undefined;
  if (e.st === 'down' || e.st === 'done') return e.st;
  const st = await stateAt(ctx, e.at);
  if (st === undefined) return undefined;
  if (e.k === 'lift') {
    if (idOf(st) === idOf(e.block) || !room(st)) { dropEntry(ctx, e); return 'gone'; }
    settle(e, 'done');
    ctx.save?.();
    return 'done';
  }
  if (idOf(st) === idOf(e.item)) { settle(e, 'down'); ctx.save?.(); return 'down'; }
  // (the item is not there: own.take digs nothing, and takes the bot's record of the cell off)
  await ctx.own?.take(e.at, e.item, { stay: true, pickup: false });
  dropEntry(ctx, e);
  return 'gone';
}

/**
 * What restoreAll undoes now, in R-3's order, and the lifts held for a ward (pure: care's row 8 asks it without acting).
 * The gates first; the lures outside the fence, a village's first; the other lures (the lock's with its socket's wall
 * block, in the same act) and a socket's wall block alone; drops; the bot's own thin blocks lifted from a wedge; and
 * LAST, only while no ward is out (wardOut): its job blocks (put back early, the smithing table took the second
 * villager a third time). Left out: a trip's own entries while that trip is not restoring (its run, or its resume,
 * holds them), the build's plug (`cover`: the shells' and care's row 2) and the hall's gate opened behind the lock's
 * shut one (care's row 5). Held: a lure that tethers a ward still out (4.3: a pin beyond 96 made its villager a second
 * ward, astray at it; taken up, it would be jobless far from its village): the lead's, said by care's row 9. Oldest
 * first within each step.
 */
export function restoreOrder(world: WorldMemory, now: number): { todo: Change[]; held: Change[] } {
  const f = sound(world.fetch), t = f.trip, yard = world.yard;
  const inYard = (p: Pos) => !!yard && p.x >= yard.x1 && p.x <= yard.x2 && p.z >= yard.z1 && p.z <= yard.z2;
  const step = (e: Change) => (e.k === 'gate' ? 0 : e.k === 'lure' ? (inYard(e.at) ? 3 : e.inVillage ? 1 : 2) : e.k === 'drop' ? 4
    : e.k === 'lift' ? (e.why === 'socket' ? 3 : e.why === 'job site' ? 6 : 5) : 7);
  const free = !wardOut(world, now), todo: Change[] = [], held: Change[] = [];
  const tether = (e: Change) => e.k === 'lure' && f.wards.some(w => (w.where === 'astray' || w.where === 'led') && !!w.tether && same(w.tether, e.at));
  for (const e of f.journal) {
    if ((t && e.trip === t.id && t.state !== 'restore') || e.k === 'cover' || (e.k === 'gate' && e.which === 'hall')) continue;
    if (tether(e)) { held.push(e); continue; }
    // (a socket's wall block goes back with the lock's lure that stands in its place)
    if (e.k === 'lift' && e.why === 'socket' && f.journal.some(x => x.k === 'lure' && x.role === 'lock' && same(x.at, e.at))) continue;
    if (e.k === 'lift' && e.why === 'job site' && !free) held.push(e);
    else todo.push(e);
  }
  return { todo: todo.sort((a, b) => step(a) - step(b)), held };
}

/**
 * RESTORE (R-3, care's row 8, a trip's end): every entry of restoreOrder undone in its order (`which`: those the caller
 * is by, e.g. care leaves a village's lure to row 7's walk out), and a trip in `restore` deleted once nothing of it is
 * left but the lifts held for a ward. "restored n; held k (a ward is out)", and what would not come undone: an entry
 * failing three times is said, never dropped (R-4).
 */
export async function restoreAll(ctx: GoalContext, o: { now?: () => number; which?: (e: Change) => boolean } = {}): Promise<{ undone: number; held: number; failed: string[]; text: string }> {
  const now = o.now ?? runClock(ctx), f = fetchOf(ctx.world);
  const { todo, held } = restoreOrder(ctx.world, now());
  let undone = 0;
  const failed: string[] = [];
  for (const e of todo.filter(x => !o.which || o.which(x))) {
    stopped(ctx);
    const r = await undo(ctx, e, { now });
    if (r.ok) undone++;
    else failed.push(`${e.k} ${'item' in e ? `${e.item} ` : ''}at ${fmt(e.at)}${(e.tries ?? 0) >= TRIES ? ` (${e.tries} tries)` : ''}: ${r.text}`);
  }
  const t = f.trip;
  if (t?.state === 'restore' && !f.journal.some(e => e.trip === t.id && !held.includes(e))) {
    delete f.trip;
    ctx.save?.();
  }
  const text = `restored ${undone}${held.length ? `; held ${held.length} (a ward is out)` : ''}${failed.length ? `; not undone: ${failed.join('; ')}` : ''}`;
  return { undone, held: held.length, failed, text };
}

// ------------------------------------------------------------------------------------------------ the status

/** A trip's village as the line names it: its variant is "village x,z" (village.ts variantOf). */
const villageOf = (site: string) => (/^village /.test(site) ? site : `village ${site}`);
/** A trip's village among the sites as remembered (read only), by the `x,z` its variant ends in. */
function siteNamed(world: WorldMemory, name: string): VillageSite | undefined {
  const m = /(-?\d+),\s*(-?\d+)\s*$/.exec(name), sites: unknown = world.villages?.sites;
  return m && Array.isArray(sites) ? sites.find((s): s is VillageSite => isObj(s) && s.x === Number(m[1]) && s.z === Number(m[2])) : undefined;
}

const WHY: Record<'prep' | 'dawn' | 'look', (n: number) => string> = {
  prep: n => `not prepared ${n} day(s)`, dawn: n => `dawn missed ${n} time(s)`, look: n => `no trip after ${n} look(s)`
};

/**
 * brain-status, `Fetch:` (pure over the memory): what stops everything first (`HALT`), the trip or the switches, the
 * wards and where each is, the gates, the lock and the ring as last read, what is out by the journal, why no trip
 * ran, the last one's end. "Do not restart" while a villager is being led. `notes`: the care goal's word on the gates
 * (villagercare.ts careNotes: one that will not stay shut), after the gates left open. `online`: the other players on
 * the server now: with one awake the night is not skipped, and a ward left out has a real night ahead (F-6).
 */
export function fetchLine(world: WorldMemory, now: number, notes: readonly string[] = [], online: readonly string[] = []): string {
  const f = sound(world.fetch), t = f.trip, live = tripLive(world, now), parts: string[] = [];
  const name = (w: Ward) => `ward ${w.key.slice(0, 4)}..`;
  if (f.halt) parts.push(`HALT: ${f.halt.why}`);
  const led = t?.ward ? f.wards.find(w => w.key === t.ward) : undefined;
  if (!t) parts.push(`${f.method ?? 'boat'}, ${f.armed === undefined ? 'not armed' : `armed ${f.armed}`}`, 'idle');
  else if (live) {
    // (the hops still to go, and the clock on them, from the path cells the run keeps)
    const path = t.path && fin(t.path.toGate) && fin(t.path.yard) ? t.path : undefined;
    const left = path ? Math.ceil(Math.max(0, path.toGate) / HOP_LEN) + Math.ceil(Math.max(0, path.yard) / YARD_HOP) : undefined;
    parts.push(`LEADING (trip ${t.id}, ${t.hop ? `hop ${t.hop.n}${left === undefined ? '' : ` of ~${t.hop.n + left}`}` : t.state})${led ? ` ${name(led)} ${led.last.profession} ${led.last.health}/20 at ${fmt(led.last.at)}` : ''}`);
    if (led && path) {
      const c = clock(led.last.tod, needLeft(path.toGate, path.yard), led, t);
      parts.push(c.rule === 2 ? `in the lock by ${IN_BY} (now ${Math.round(led.last.tod)}: ${c.inHandS} s in hand)` : `the clock: ${c.go}, ${c.text}`);
    }
  } else if (t.cut) parts.push(`trip ${t.id} cut in ${t.state}: ${t.cut.why}`);
  else if (t.state !== 'prep') parts.push(`trip ${t.id}${t.dry ? ' (dry)' : ''}: ${t.state}`);
  else if (t.prepared) {
    const site = siteNamed(world, t.site), from = homeOf(world) ?? t.gate.outer;
    parts.push(`prepared for ${villageOf(t.site)}: out at dawn by the ${t.gate.side} gate${site ? ` (needs ${need(needParts(site, from, t.gate.outer, t.gate.yard))} s)` : ''}`);
  } else parts.push(`preparing for ${villageOf(t.site)} (done: ${(['read', 'kit', 'lifts'] as const).filter(k => fin(t.prep[k])).join(', ') || 'nothing yet'})`);
  for (const w of f.wards) {
    if (live && w === led) continue;
    // (R-8's end: an astray ward's two days are over, nothing is held for it any more, and the lead is asked)
    const asks = w.where === 'astray' && !w.dim && now - w.last.t >= ASTRAY_HOLD;
    parts.push(w.where === 'lock' ? `${name(w)} in the lock since ${w.last.tod}`
      : `${name(w)} ${w.where}${w.dim ? ' in the Nether' : ''}, last at ${fmt(w.last.at)}${w.note ? `: ${w.note}` : ''}`
        + (w.where === 'astray' && !w.dim && online.length ? ` (${online.join(', ')} ${online.length === 1 ? 'is' : 'are'} online: a real night)` : '')
        + (asks ? ` (2 game days on: its lifts go back and the guards lift; villager-moves {halt:false, arm:1} leads it in by day, {forget:"${w.key}"} lets it go)` : ''));
  }
  if (!f.wards.length) parts.push('no ward');
  const h = world.zones?.['hall:gate']?.[0];
  if (h && f.gates?.open.some(g => same(g, h)) && openByDesign(world, h)) parts.push('H open (it goes in when it will)');
  const left = (f.gates?.leftOpen ?? []).filter(g => !openByDesign(world, g));
  if (left.length) parts.push(`gate(s) left open at ${left.map(fmt).join(', ')}`);
  parts.push(...notes);
  const shell = (what: 'lock' | 'ring', name: string, ready: string, faults = f.shells?.[what]) => (f.shells?.building === what ? `${name} being built`
    : !faults ? `${name} not read yet` : faults.length ? `${name}: ${faults[0]}${faults.length > 1 ? ` (and ${faults.length - 1} more)` : ''}` : ready);
  parts.push(shell('lock', 'the lock', 'lock ready'), shell('ring', 'the portal\'s ring', 'portal ringed'));
  if (!f.journal.length) parts.push('journal empty');
  else {
    const kinds = ['lure', 'lift', 'cover', 'gate', 'drop'] as const;
    parts.push(`out: ${kinds.map(k => [f.journal.filter(e => e.k === k).length, k] as const).filter(([n]) => n).map(([n, k]) => `${n} ${k}`).join(', ')}`);
    const lifted = f.journal.flatMap(e => (e.k === 'lift' && e.why === 'job site' ? [`${e.item} at ${fmt(e.at)}`] : []));
    if (lifted.length) parts.push(`lifted: ${lifted.join(', ')}${wardOut(world, now) ? ' (back once no villager is out)' : ''}`);
    // (a lure left in a village that no run is at: the first thing owed)
    for (const e of f.journal) if (e.k === 'lure' && e.inVillage && !(live && e.trip === t?.id)) parts.push(`owed: a ${e.role === 'pin' ? 'pin' : 'lure'} in the village at ${fmt(e.at)}: taken up first thing by day`);
    // (an entry whose undo failed three times: kept, and said until a person looks: R-4)
    const stuck = f.journal.filter(e => (e.tries ?? 0) >= TRIES);
    if (stuck.length) parts.push(`stuck after ${TRIES} tries: ${stuck.map(e => `${e.k}${'item' in e ? ` ${e.item}` : ''} at ${fmt(e.at)}`).join(', ')} (the lead)`);
  }
  for (const k of ['prep', 'dawn', 'look'] as const) {
    const y = f.why?.[k];
    if (y) parts.push(`${WHY[k](y.n)}: ${y.text}${y.n >= 3 ? ' (the lead)' : ''}`);
  }
  if (f.last) parts.push(`last: ${f.last.text}`);
  return `Fetch: ${parts.join('; ')}${live ? '. Do not restart' : ''}`;
}
