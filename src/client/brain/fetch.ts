import type { GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { Critical } from './pockets.js';
import { JOB_SITE } from './village.js';
import type { HomeSide } from './yardgates.js';

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
 * This is the S0 half: the shapes, the memory made whole, the journal's write, what the rest of the brain asks
 * (heldByFetch, liftedFor, inHallOrLock, wardOut, placeGuard, journalItems, tripLive, openByDesign, fetchSafe) and the
 * status line. Nothing here calls the game. It imports types and village.ts alone (which imports no goal), so the
 * structures, tidy, repair and village.ts itself can ask it whichever module is loaded first.
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
  /** why no trip ran, per stage, counted while the reason stays the same (the status line prints them) */
  why?: Partial<Record<'prep' | 'dawn' | 'look', { at: number; n: number; text: string }>>;
  last?: { at: number; text: string; got: 0 | 1 };
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
  /** written and saved BEFORE the first act of that state */
  state: TripState;
  /** real ms: a live run renews it at every poll (<= 10 s); stale = nobody drives it */
  beat: number;
  /** PREP's parts done (ms): a cut PREP goes on from them */
  prep: { read?: number; kit?: number; lifts?: number };
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
  /** planned path cells: the clock's needLeft */
  path?: { toGate: number; yard: number };
  /** seconds, measured */
  times: Partial<Record<'out' | 'survey' | 'first' | 'hops' | 'gate' | 'yard' | 'lock' | 'door', number>>;
  counts: { hops: number; misses: number; wedges: number; pins: number };
  cut?: { at: number; why: string };
  /** plan, log and dump only: places and digs nothing */
  dry?: true;
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
  m.nextId = Math.max(fin(r.nextId) ? r.nextId : 1, 1 + Math.max(0, m.trip?.id ?? 0, ...m.journal.map(e => e.id)));
  if (dropped.length) m.halt ??= { at: Date.now(), why: `brain.json: ${dropped.join(', ')} could not be read and dropped (what stood there is no longer known: the lead looks round, then clears the halt)` };
  return m;
}

const KEYS = ['v', 'method', 'armed', 'trip', 'journal', 'wards', 'halt', 'shells', 'gates', 'why', 'last', 'nextId'] as const;

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

// ------------------------------------------------------------------------------------------------ the status

const WHY: Record<'prep' | 'dawn' | 'look', (n: number) => string> = {
  prep: n => `not prepared ${n} day(s)`, dawn: n => `dawn missed ${n} time(s)`, look: n => `no trip after ${n} look(s)`
};

/**
 * brain-status, `Fetch:` (pure over the memory): what stops everything first (`HALT`), the trip or the switches, the
 * wards and where each is, the gates, the lock and the ring as last read, what is out by the journal, why no trip
 * ran, the last one's end. "Do not restart" while a villager is being led.
 */
export function fetchLine(world: WorldMemory, now: number): string {
  const f = sound(world.fetch), t = f.trip, live = tripLive(world, now), parts: string[] = [];
  const name = (w: Ward) => `ward ${w.key.slice(0, 4)}..`;
  if (f.halt) parts.push(`HALT: ${f.halt.why}`);
  const led = t?.ward ? f.wards.find(w => w.key === t.ward) : undefined;
  if (!t) parts.push(`${f.method ?? 'boat'}, ${f.armed === undefined ? 'not armed' : `armed ${f.armed}`}`, 'idle');
  else if (live) parts.push(`LEADING (trip ${t.id}, ${t.hop ? `hop ${t.hop.n}` : t.state})${led ? ` ${name(led)} ${led.last.profession} ${led.last.health}/20 at ${fmt(led.last.at)}` : ''}`);
  else if (t.cut) parts.push(`trip ${t.id} cut in ${t.state}: ${t.cut.why}`);
  else if (t.state !== 'prep') parts.push(`trip ${t.id}${t.dry ? ' (dry)' : ''}: ${t.state}`);
  else if (t.prepared) parts.push(`prepared for village ${t.site}: out at dawn by the ${t.gate.side} gate`);
  else parts.push(`preparing for village ${t.site} (done: ${(['read', 'kit', 'lifts'] as const).filter(k => fin(t.prep[k])).join(', ') || 'nothing yet'})`);
  for (const w of f.wards) {
    if (live && w === led) continue;
    // (R-8's end: an astray ward's two days are over, nothing is held for it any more, and the lead is asked)
    const asks = w.where === 'astray' && !w.dim && now - w.last.t >= ASTRAY_HOLD;
    parts.push(w.where === 'lock' ? `${name(w)} in the lock since ${w.last.tod}`
      : `${name(w)} ${w.where}${w.dim ? ' in the Nether' : ''}, last at ${fmt(w.last.at)}${w.note ? `: ${w.note}` : ''}`
        + (asks ? ` (2 game days on: its lifts go back and the guards lift; villager-moves {halt:false, arm:1} leads it in by day, {forget:"${w.key}"} lets it go)` : ''));
  }
  if (!f.wards.length) parts.push('no ward');
  const h = world.zones?.['hall:gate']?.[0];
  if (h && f.gates?.open.some(g => same(g, h)) && openByDesign(world, h)) parts.push('H open (it goes in when it will)');
  const left = (f.gates?.leftOpen ?? []).filter(g => !openByDesign(world, g));
  if (left.length) parts.push(`gate(s) left open at ${left.map(fmt).join(', ')}`);
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
  }
  for (const k of ['prep', 'dawn', 'look'] as const) {
    const y = f.why?.[k];
    if (y) parts.push(`${WHY[k](y.n)}: ${y.text}${y.n >= 3 ? ' (the lead)' : ''}`);
  }
  if (f.last) parts.push(`last: ${f.last.text}`);
  return `Fetch: ${parts.join('; ')}${live ? '. Do not restart' : ''}`;
}
