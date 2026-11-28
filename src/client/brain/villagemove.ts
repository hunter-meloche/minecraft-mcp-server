import type { Decline, Goal, GoalContext, Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { Zone } from './courtesy.js';
import { brainRun, type Status } from '../tools.js';
import { MIN_WORK, alongSide, byYard, inFence, outByGate, roundFrom, type HomeSide, type WorkResult, type WorkTask } from './work.js';
import { prepare } from './project.js';
import { CHEST_SPARE, FOOD_TARGET, gatherFood, readyFoodPoints } from './food.js';
import { FROM_ZONES, Ground, MAX_DROP, checkLeg, entryOf, footprint, keepOff, planRoute, readBand, yardEntry, yardInside, type BoatAt, type Entry } from './boatroute.js';
import { closeRailsYard, heldByRails, peekLine, railsOn, railsPostWaits, railsYardOpen, startLine } from './railshome.js';
import type { Bearing } from './nether.js';
import { planRails, railsLine, type RailPlan } from './railroute.js';
import { chestTotals } from './chests.js';
import { WORK_AT, daylightLeft } from './schedule.js';
import { noteHall } from './hallchores.js';
import {
  AREA_GROW, FETCH_WAIT, HALL_FRESH, HALL_WANTS, ILLAGER, JOB_SITE, JUDGE_V, MARKERS_NEAR, OUTPOST_CLEAR, PLAYER_NOW, VILLAGE_MARK, VILLAGE_RANGE, VILLAGE_REACH, ZONES_NEAR, byJobSite, fetchWait, freshFree, joinAreas,
  judgeVillage, knownVillage, lureOn, movesOn, noteSeen, noteVillage, peekVillages, pennedIn, reachOf, rejudge, siteNow, siteOf, siteOpen, usedHow, variantOf, villageArea, villagesOf, wholeLook,
  type LookZone, type Seen, type Verdict, type VillageLook, type VillageSite
} from './village.js';
import { GAME_DAY, IN_BY, fetchOf, floorOk, needMs as lureNeedMs, needParts, noteWhy, peekFetch, startLate, startNeed, wardOut, type FetchMemory, type NeedParts, type Trip as FetchTrip } from './fetch.js';
import { onYardFence, yardGates, yardWhy } from './yardgates.js';
import { lockOf } from './villagerwalk.js';

/**
 * The villager move (P5c of the progression plan), run supervised behind the villager-moves switch: the `villagers` rung
 * of the work queue brings one unemployed adult villager a run from a village judged free (village.ts) to the bot's
 * own hall (villagers.ts), by boat. Villagers cannot be leashed (26.3: AbstractVillager.canBeLeashed is false) and follow
 * no one, emeralds or not; a boat put down against one takes it into its back seat on the next tick, the bot gets in
 * front and steers (the bridge's vehicle.* calls, Vehicle.java). The way: the boat's route home judged on the ground
 * before the villager is taken (boatroute.ts: flat, downhill or water, 2 wide, 16 off every build of others), read as
 * the bot walks out to the village; at the yard, the fence's posts straight out from the hall's panel and the panel
 * itself (3 wide: the boat is 1.375 across) dug from the boat, driven through, the villager let out in the room, the
 * boat broken back into its item, the panel and the fence put back as they were; where the ground outside the fence
 * there lets no boat by (or a gate stands in it), in by another panel of the fence and across the yard to a panel in
 * the hall's yard-facing wall (boatroute.ts yardEntry). A move that runs past its budget, or finds the way blocked, gives up: home without the
 * villager, the boat taken back up, everything it opened put back; one cut short (survival, its timeout, the LLM) gets
 * out of the boat and breaks it all the same, outside the run, and leaves what it opened in `villages.open` for the
 * `close up` goal (and the brain gets a bot seated in a boat with no run to steer it out first, a restart's among them:
 * brain.ts outOfVehicle). Every step is said
 * (`villagers: ...`). With the switch off nothing of it runs: the rung offers nothing, the sightings are only remembered.
 * When no boat way home is found, the rails fallback (the user's) is planned on the same ground and said: a dry run with
 * the rails switch off; with it on, the line is kept to be laid (railshome.ts, its own rung: the bill, the laying over
 * days, the move by minecart, the take-up).
 */

const MINUTE = 60_000;
/** The boat's pace on land, blocks a second (0.1 a tick; on water 8): how long the way home with a villager takes. */
export const BOAT_PACE = 2;
/**
 * A move's budget: the walk out to a village at the range's end (640 at 3 a second, 213 s), the look round it (a minute
 * or two), the boat home on land (416 s with its turns) and the yard's openings: 14 min. A work day is 575 s (WORK_AT
 * to RETURN_AT), and the budget is cut to what the day leaves (work.ts budgetFor): a move from farther than about 447 by
 * land does not fit one, and is not set out on (moveNeedMs); the search out to 640 goes on the next run where the day
 * stopped it, and a village it finds free past that is said to be too far for a day's move (tooFarWord). The run's timeout is 4 min more (work.ts timeoutOf), which holds the walk home from out there (213 s at
 * the range's end) after a give-up.
 */
export const MOVE_BUDGET = 14 * MINUTE;
/** The look round a village (the scans' viewpoints, the pens read), as the day counts it. */
const LOOK_MS = 60_000;
/** A work day, ms: WORK_AT to RETURN_AT, less the 15 s work.ts budgetFor keeps in hand. */
export const DAY_MS = daylightLeft(WORK_AT) * 50 - 15_000;
/**
 * What of the day a move from `dist` out needs (pure): the walk out at 3 a second, the look round the village, the boat
 * home in a straight line at its pace on land (homeMs: a third more for its turns, the yard's part). More than DAY_MS:
 * no move sets out from there (a villager is never left out in the wild at dusk).
 */
export const moveNeedMs = (dist: number): number => Math.round(dist / 3 * 1000) + LOOK_MS + homeMs({ x: 0, z: 0 }, [{ x: dist, z: 0 }]);
/**
 * Why a free village `dist` from home is never moved from, or undefined when a move from there fits the day (pure: the
 * gate the rung's variants keep, moveNeedMs over DAY_MS). Said where the find or the look would promise the move, and
 * in brain-status: a village 448 to 640 out was called free, "the move next run", and never offered.
 */
export function tooFarWord(dist: number): string | undefined {
  const need = moveNeedMs(dist);
  return need <= DAY_MS ? undefined : `but too far for a day's move (${Math.round(dist)} from home: it needs ${Math.round(need / 1000)} s, the day has ${Math.round(DAY_MS / 1000)} s)`;
}
/** A site's tally word in brain-status for one judged free that is too far for a day's move from `home` (tooFarWord). */
export const tooFarFrom = (home: { x: number; z: number }) => (site: { x: number; z: number }): boolean => !!tooFarWord(horiz(site, home));
/** What a look at a village `dist` out needs (pure): there and back at 3 a second, and the look. */
export const lookNeedMs = (dist: number): number => Math.round(2 * dist / 3 * 1000) + LOOK_MS;
/** How far a search goes on past where it was looked along to, at the least, for a run to be worth setting out on. */
const SEARCH_STRETCH = 128;
/** What of the day a search of a bearing looked along to `from` needs (pure): out to `from` and SEARCH_STRETCH on and back, at a walk. */
export const searchNeedMs = (from: number): number => Math.round(2 * Math.min(VILLAGE_RANGE, from + SEARCH_STRETCH) / 3 * 1000) + MIN_WORK.far;
/** A search's stops: 32 apart (work.ts alongSide). The day's end is judged a stop ahead. */
const SEARCH_LEG = 32;
/** Illagers this near the bot, or an ominous banner OUTPOST_CLEAR and a stop ahead, turn a walk out back. */
const ILLAGER_SIGHT = 64;
/** How far short of a stop a walk out may end (its goto's `range`): the next stop may come that much nearer too. */
const STOP_RANGE = 8;
/** The stops of the walk out, blocks apart: the ground round each is read for the boat's way back. */
const SURVEY_LEG = 48;
/** The band either side of the line from the yard to the village that is read for the way home. */
const BAND = 16;
/** Read round the bot no further than this (the client has the chunks within about 96 loaded). */
const READ_NEAR = 80;
/** The longest walk to one of the look's viewpoints (its goto's time out), as the day counts it. */
export const VIEWPOINT_MS = 75_000;
/** The look round a village: how far round its middle the bells, beds and villagers are looked for. */
const LOOK = 96;
/** The most extra places walked to for the scans to see all of a village. */
export const VIEWPOINTS = 4;
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
/** Read round the yard this far for a way in across it: the stop 2.5 out from its fence and the boat's footprint there. */
const YARD_READ = 5;
/** The boat's item: five oak planks at a table (26.3's oak_boat.json; progress.ts RECIPES). */
export const BOAT_ITEM = 'oak_boat';
const SIDES: HomeSide[] = ['north', 'east', 'south', 'west'];
/**
 * The four bearings between the sides, searched after them (the Nether scout's eight, nether.ts BEARINGS): a side's line
 * sees about 96 either side of it (render distance 6), and the quarters between went unseen. Live on Nov 15 north, east
 * and south found nothing within 384, west a village 164 out.
 */
const DIAGONALS: Bearing[] = ['north-east', 'south-east', 'south-west', 'north-west'];
const SEARCHES: Bearing[] = [...SIDES, ...DIAGONALS];
const isSearch = (v: string): v is Bearing => (SEARCHES as string[]).includes(v);

const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const fmt = (p: { x: number; y?: number; z: number }) => `(${Math.floor(p.x)}, ${p.y === undefined ? '' : `${Math.floor(p.y)}, `}${Math.floor(p.z)})`;
const idOf = (state: string) => state.replace(/^minecraft:/, '').replace(/\[.*$/, '');
const pause = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
/**
 * The rung's sleep for a lure trip (its LureClock): a real wait that ends with an error the moment the run is given up.
 * The brain gives a stopped run 5 s; LOCK's 20 s and the guards' 20 s sleeps outlasted that, so the trip's exit handler
 * (a held gate released shut, the ward's lure anchored) ran up to 20 s late, beside the wedge watch's step-out or the
 * LLM's first tool (S1 review #24). Care's clock ends its waits the same way.
 */
export const runSleep = (signal: AbortSignal) => (ms: number): Promise<void> => new Promise<void>((res, rej) => {
  if (signal.aborted) { rej(new Error('aborted')); return; }
  const stop = () => { clearTimeout(t); rej(new Error('aborted')); };
  const t = setTimeout(() => { signal.removeEventListener('abort', stop); res(); }, Math.max(0, ms));
  signal.addEventListener('abort', stop, { once: true });
});
/** A turn for everything else waiting (the brain's ticks, the bridge's replies) between searches of whole seconds. */
export const yieldNow = () => new Promise<void>(res => setImmediate(res));

/**
 * How long the boat takes home from `from` along `legs` (pure): at the boat's pace on land, a third more for its turns
 * and stops, and the yard's part after (a way in across the yard: its legs among `legs`, yardLegs). Judged before a
 * villager is taken: a drive timed out halfway home lets it out in the wild, between its village and the hall.
 */
export function homeMs(from: { x: number; z: number }, legs: readonly { x: number; z: number }[]): number {
  let d = 0, at = from;
  for (const q of legs) { d += horiz(at, q); at = q; }
  return Math.round(d / BOAT_PACE * 1000 * 1.3) + YARD_MS;
}

// ------------------------------------------------------------------------------------------------ the lure's gates (idle-plan V, S1)

/**
 * The lure's prepared trip at dawn (idle-plan V 6.1): over the kit's 70, under food's 76 and the villager care's 75.
 * PREP left the kit whole and the bot fed the evening before; without it the home chores (the stash 60, the farm 47,
 * the pens 46) took the first minutes of a morning that has 89 s to spare (F-14).
 */
export const DAWN_URGENCY = 71;
/** A lure trip's run: the west village's 346 s (4.4) from the walk out to the lock shut, and room for a slow hop or two. */
export const LURE_BUDGET = 9 * MINUTE;
/** The variants of the lure: a prepared trip's dawn, and a whole look at a village (nothing placed). */
const BRING = 'bring:', LOOK_AT = 'look:';
/** PREP's hours (2.2, decision 5): its reads and kit from the afternoon before, its lifts last, to bedtime. */
const PREP_FROM = 6000, PREP_TO = 12_300;
/** The hour a trip's ward must be in the lock by, as the verdict's age is reckoned (the bell's pull at 9000, 4.1). */
const TRIP_END = 9000;
/** A bad omen on the bot makes a raid of the first village it walks into (26.3: raid_omen once inside). */
const OMEN = /^(bad_omen|raid_omen)$/;

/** The fetch's record as the gates read it (fetch.ts peekFetch: a copy, nothing made), or undefined in a world without one. */
const fetchNow = (world: WorldMemory): FetchMemory | undefined => (world.fetch === undefined ? undefined : peekFetch(world));
/** Trips that may still begin (villager-moves {arm}): a count above 0 (`free`: S1.5, refused by the tool until then). */
const armedOk = (f: Pick<FetchMemory, 'armed'>): boolean => f.armed === 'free' || (typeof f.armed === 'number' && f.armed > 0);
/** A trip prepared and waiting for its dawn (2.2: `prep` with `prepared` stamped). */
function preparedTrip(world: WorldMemory): FetchTrip | undefined {
  const t = fetchNow(world)?.trip;
  return t && t.state === 'prep' && t.prepared ? t : undefined;
}
/**
 * The dry switch (villager-moves {dry}, rollout step 3): every trip plans, logs and dumps and places nothing while it is
 * on. The fetch's record keeps it (FetchMemory.dry: a switch turned before a trip exists must hold for the PREP and the
 * morning after; a trip's own `dry` is that trip's record): PREP makes its new trip dry by it, and the run its trip.
 */
export const dryNext = (world: WorldMemory): boolean => (world.fetch as Partial<FetchMemory> | undefined)?.dry === true;
/**
 * A trip's village as remembered (the live site: a run writes on it), by the `x,z` its name ends in: fetch.ts keeps a
 * trip's site as village.ts variantOf names it ("village x,z"), and reads a bare "x,z" alike.
 */
function tripSiteOf(world: WorldMemory, name: string): VillageSite | undefined {
  const m = /(-?\d+),\s*(-?\d+)\s*$/.exec(name);
  return m ? (world.villages?.sites ?? []).find(q => q.x === Number(m[1]) && q.z === Number(m[2])) : undefined;
}
/** Wards on their way to the hall (fetch.ts: led, or in the lock): the hall counts them as its own (idle-plan V 5.2, B4). */
const wardsOnWay = (world: WorldMemory): number => fetchNow(world)?.wards.filter(w => w.where === 'led' || w.where === 'lock').length ?? 0;

/**
 * What a lure trip from home to `site` needs, s: the seconds its start must have in hand (fetch.ts startNeed, 4.4: the
 * lock shut by 8700 with the margin, and the first hop's own rule met), by the parts the records have: the trip's own
 * yard gate and yard way once PREP chose them (`t`), else the yard gate nearest the village with its way to the lock's
 * S_out reckoned along the cells (no walker on whole cells has a shorter one), else from home itself. Pure.
 */
export function lureNeed(world: WorldMemory, site: Pick<VillageSite, 'x' | 'z' | 'fetch'>, home: { x: number; z: number }, t?: Pick<FetchTrip, 'gate'>): { s: number; parts: NeedParts } {
  let outer: { x: number; z: number } = home, yard = 0;
  if (t) { outer = t.gate.outer; yard = t.gate.yard; } else {
    const g = yardGates(world).map(q => ({ q, d: horiz(q.outer, site) })).sort((a, b) => a.d - b.d)[0]?.q;
    const lock = lockOf(world);
    if (g) { outer = g.outer; if (lock) yard = Math.abs(g.inner.x - lock.sOut.x) + Math.abs(g.inner.z - lock.sOut.z); }
  }
  const parts = needParts(site, home, outer, yard);
  return { s: startNeed(parts), parts };
}
/** A trip that fits one morning (pure): set out at the bot's dawn (WORK_AT), the ward in the lock by IN_BY (fetch.ts startLate). */
export const fitsMorning = (needS: number): boolean => startLate(WORK_AT, needS) === undefined;
/** The seconds of one morning, the bot's dawn to IN_BY (460: about 200 blocks straight). */
const morningS = () => Math.floor((IN_BY - (WORK_AT - 24_000)) / 20);
/** A site's tally word in brain-status for one judged free that is too far (village.ts villagersLine): one morning under the lure, a day's move else. */
export const tooFarFor = (world: WorldMemory, home: { x: number; z: number }): ((site: VillageSite) => boolean) =>
  (lureOn(world) ? site => !fitsMorning(lureNeed(world, site, home).s) : tooFarFrom(home));

/** The real ms from now to the 9000 of the next morning's trip (2.2: a verdict must be under 72 h old then). */
const toTripEnd = (tod: number): number => ((((WORK_AT - tod) % 24_000) + 24_000) % 24_000 + TRIP_END - (WORK_AT - 24_000)) * 50;
/** The unemployed adults the judge counted at a free word's look (its words say so: "7 villagers, 2 unemployed adult(s) to take"); undefined where they do not. */
const takersAt = (site: VillageSite): number | undefined => {
  const m = /(\d+) unemployed adult\(s\) to take/.exec(site.judged?.why ?? '');
  return m ? Number(m[1]) : undefined;
};

/**
 * Where a village open to the lure stands (pure, idle-plan V 4.1): `far` (its trip does not fit one morning: neither
 * brought from nor looked at, A9); `look` (it wants a whole look first: no free word of today's judge on a whole look
 * that will still be under FRESH_FREE old by the trip's 9000, someone's to an older judge, no count for the floor or
 * one too old, no unemployed adult at its last look a day ago); `wait` (nothing a look would change yet: no unemployed
 * adult at a look under a day old, no take left at the floor); `prep` (ready for tomorrow's trip to be prepared). With
 * why, and the trip's need.
 */
export function lureState(world: WorldMemory, site: VillageSite, s: Pick<Snapshot, 'now' | 'timeOfDay'>, home: { x: number; z: number }): { kind: 'far' | 'look' | 'wait' | 'prep'; why: string; needS: number } {
  const needS = lureNeed(world, site, home).s, at = fmt(site);
  if (!fitsMorning(needS)) return { kind: 'far', why: `the village at ${at} is too far for one morning (${Math.round(horiz(site, home))} from home: needs ${needS} s, a morning has ${morningS()} s): needs the relay`, needS };
  const by = s.now + toTripEnd(s.timeOfDay), j = site.judged;
  if (rejudge(site)) return { kind: 'look', why: `the village at ${at} is someone's to an older judge: judged again first`, needS };
  if (!freshFree(site, by)) {
    const word = !j ? 'not judged yet' : j.kind !== 'free' ? `judged ${j.kind} (${j.why})` : `its free word (${clockAgo(s.now, j.at)}) will be over 72 h old by the trip`;
    return { kind: 'look', why: `the village at ${at}: ${word}: a whole look first`, needS };
  }
  const takers = takersAt(site);
  if (takers === 0) {
    return s.now - j!.at >= FETCH_WAIT['no unemployed'] ? { kind: 'look', why: `the village at ${at} had no unemployed adult at its last look (${clockAgo(s.now, j!.at)}): looked at again`, needS }
      : { kind: 'wait', why: `no unemployed adult in the village at ${at} at its last look (${clockAgo(s.now, j!.at)})`, needS };
  }
  const floor = floorOk(site, by);
  if (!floor.ok) return { kind: / a whole look first$/.test(floor.text) ? 'look' : 'wait', why: `the village at ${at}: ${floor.text}`, needS };
  return { kind: 'prep', why: `the village at ${at}: free, ${floor.text}, needs ${needS} s`, needS };
}
/** How long ago, for the words (h, else min). */
const clockAgo = (now: number, at: number) => { const m = Math.round((now - at) / MINUTE); return m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

/**
 * Tomorrow's trip (2.2's first row; the care's row 10 and the work queue's stay-in ask it): the village a lure trip
 * would be prepared for now, the nearest by its need of those ready for one (lureState `prep`); or why none, the first
 * thing in the way: the switches (the method, the moves, a halt, not armed), what the fetch still holds (a trip, a
 * ward, the journal: care's first), the hall (stocked), the lock and the portal's ring as last read, then the villages.
 * The hours and where the bot stands are the caller's. Pure.
 */
export function lureSite(s: Pick<Snapshot, 'now' | 'timeOfDay' | 'position'> & { home?: { x: number; z: number } }, world: WorldMemory): { site: VillageSite; variant: string; needS: number } | { why: string } {
  if (!lureOn(world)) return { why: 'the method is not the lure (villager-moves {method: "lure"})' };
  if (!movesOn(world)) return { why: 'villager moves are off' };
  const f = peekFetch(world);
  if (f.halt) return { why: `HALT: ${f.halt.why}` };
  if (!armedOk(f)) return { why: 'not armed (villager-moves {arm: 1} lets one trip begin)' };
  if (f.trip) return { why: `trip ${f.trip.id} is ${f.trip.state}` };
  if (f.wards.length) return { why: `${f.wards.length} ward(s) on the records: the care's first` };
  if (f.journal.length) return { why: `the journal holds ${f.journal.length} change(s) not undone: the care's first` };
  const hall = hallWhy(s, world);
  if (hall) return { why: hall.text };
  const sh = f.shells;
  if (!lockOf(world)) return { why: 'the lock does not stand yet' };
  if (!sh) return { why: 'the lock and the portal\'s ring not read yet' };
  if (sh.building) return { why: `the ${sh.building === 'lock' ? 'lock' : 'portal\'s ring'} being built` };
  if (sh.lock.length) return { why: `the lock is not ready: ${sh.lock[0]}` };
  if (sh.ring.length) return { why: `the portal's ring is not ready: ${sh.ring[0]}` };
  // (the yard whole on the records: no growth's fence move under way, the ring round the box as it stands, every gate
  // on its line; a trip prepared on a yard about to open was the S1 follow-up's blocker, path P1)
  const yw = yardWhy(world);
  if (yw) return { why: `the yard is not whole: ${yw}` };
  const home = s.home ?? s.position, sites = peekVillages(world).sites;
  const all = sites.filter(q => siteOpen(q, home, s.now, 'lure')).map(q => ({ q, st: lureState(world, q, s, home) })).sort((a, b) => a.st.needS - b.st.needS);
  const go = all.find(x => x.st.kind === 'prep');
  if (go) return { site: go.q, variant: variantOf(go.q), needS: go.st.needS };
  // (none open: the nearest free one that waits, and why; the searches go on meanwhile)
  const shut = sites.filter(q => q.judged?.kind === 'free' && !siteOpen(q, home, s.now, 'lure')).sort((a, b) => horiz(a, home) - horiz(b, home))[0];
  return { why: all[0]?.st.why ?? (shut ? shutWhy(shut, home, s.now) : 'no village known open to a trip (the searches go on)') };
}
/** Why siteOpen keeps a free village shut to the lure, in words (pure): out of range, or its last trip's wait (fetchWait) with the hours left. */
function shutWhy(site: VillageSite, home: { x: number; z: number }, now: number): string {
  const at = fmt(site), w = fetchWait(site.fetch);
  if (horiz(site, home) > VILLAGE_RANGE) return `the village at ${at} is beyond ${VILLAGE_RANGE} of home`;
  if (w > 0 && now - site.fetch!.at < w) return `the village at ${at} waits ${Math.ceil((site.fetch!.at + w - now) / (60 * MINUTE))} h more (${site.fetch!.kind}: ${site.fetch!.why})`;
  return `the village at ${at} is not open to a trip`;
}

/**
 * The work queue's stay-in (idle-plan V 6.3; work.ts common): from 6000 to bedtime the rungs that leave the yard stay
 * home while tomorrow's trip is owed its reads and its kit (PREP's first two parts: the evening alone has 65-75 s before
 * the shelter beds the bot, F-13). Owed: a trip in `prep` whose kit is not stamped yet, or none and a village to prepare
 * one for (lureSite) that PREP has not declined today (one decline a day: the afternoon is the chores' then). Bounded by
 * the switches: the method, the moves, armed, no halt. Said, or undefined. Pure.
 */
export function prepStayIn(s: Pick<Snapshot, 'now' | 'timeOfDay' | 'home' | 'position'>, world: WorldMemory): string | undefined {
  if (!lureOn(world) || !movesOn(world)) return undefined;
  const tod = ((s.timeOfDay % 24_000) + 24_000) % 24_000;
  if (tod < PREP_FROM || tod >= PREP_TO) return undefined;
  const f = peekFetch(world), t = f.trip, said = 'staying in to prepare tomorrow\'s villager trip';
  if (f.halt || !armedOk(f)) return undefined;
  if (t) return t.state === 'prep' && !Number.isFinite(t.prep.kit) ? `${said} (trip ${t.id}: its kit not packed yet)` : undefined;
  const no = f.why?.prep, day: unknown = world.idle?.today?.day;
  if (no && (typeof day === 'number' && day > 0 && typeof no.day === 'number' ? no.day === day : s.now - no.at < GAME_DAY)) return undefined;
  const site = lureSite(s, world);
  return 'site' in site ? `${said} (the village at ${fmt(site.site)})` : undefined;
}

/** Why a prepared trip does not set out now (2.2's `prep` -> `out`; pure, a Decline): the halt, not armed, a bad omen, the clock (4.4's start rule). */
function bringWhy(s: Snapshot, world: WorldMemory): Decline | null {
  const f = fetchNow(world), t = f?.trip;
  if (!f || !t || t.state !== 'prep' || !t.prepared) return { cause: 'unneeded', text: 'villagers: no trip prepared' };
  if (f.halt) return { cause: 'hold', text: `villagers: HALT (${f.halt.why}): no trip sets out until the lead clears it (villager-moves {halt:false})` };
  if (!armedOk(f)) return { cause: 'hold', text: 'villagers: not armed: no trip sets out (villager-moves {arm: 1} lets one)' };
  const yw = yardWhy(world);
  if (yw) return { cause: 'hold', text: `villagers: the yard is not whole: ${yw}: no trip sets out` };
  if (!onYardFence(world, t.gate.at)) return { cause: 'hold', text: `villagers: the trip's ${t.gate.side} gate (${Math.floor(t.gate.at.x)}, ${Math.floor(t.gate.at.y)}, ${Math.floor(t.gate.at.z)}) is no longer on the yard's fence: no trip sets out` };
  const omen = (s.effects ?? []).find(e => OMEN.test(e.name.replace(/^minecraft:/, '')));
  if (omen) return { cause: 'hold', text: `villagers: ${omen.name.replace(/^minecraft:/, '').replace('_', ' ')} on the bot: no trip sets out (the village it walks into would be raided)` };
  const site = tripSiteOf(world, t.site);
  if (!site) return { cause: 'unneeded', text: `villagers: the trip's village (${t.site}) is no longer known` };
  const late = startLate(s.timeOfDay, lureNeed(world, site, s.home ?? s.position, t).s);
  return late ? { cause: 'late', text: `villagers: the trip ${late}` } : null;
}

/**
 * The rung's variants under the lure (idle-plan V 5.2): a prepared trip's `bring:<site>` alone at its dawn (the morning
 * is the trip's); none while a trip is under way or a villager is out (the care's, and the yard holds its lifts); else a
 * `look:<site>` for each village open to it that wants a whole look and whose trip would fit one morning, the nearest
 * by its need first, then the searches as before. The boat's `village x,z` moves are never offered.
 */
function lureVariants(s: Snapshot, world: WorldMemory, searches: { id: string; dist: number; needMs: number; first?: true }[]): { id: string; dist: number; first?: true; needMs?: number }[] {
  const home = s.home ?? s.position, f = fetchNow(world), t = f?.trip;
  if (t?.state === 'prep' && t.prepared) {
    const site = tripSiteOf(world, t.site);
    return site ? [{ id: `${BRING}${t.site}`, dist: Math.round(horiz(site, home)), first: true, needMs: lureNeedMs(lureNeed(world, site, home, t).parts) }] : [];
  }
  if ((t && t.state !== 'prep' && t.state !== 'restore') || wardOut(world, s.now)) return [];
  const looks = peekVillages(world).sites.filter(q => siteOpen(q, home, s.now, 'lure')).map(q => ({ q, st: lureState(world, q, s, home) }))
    .filter(x => x.st.kind === 'look').sort((a, b) => a.st.needS - b.st.needS)
    .map(x => ({ id: `${LOOK_AT}${variantOf(x.q)}`, dist: Math.round(horiz(x.q, home)), first: true as const, needMs: lookNeedMs(horiz(x.q, home)) }));
  return [...looks, ...searches.filter(x => x.first), ...searches.filter(x => !x.first)];
}

/** What the rung says under the lure with no variant at all: a trip under way, a villager out. */
function lureNone(s: Snapshot, world: WorldMemory): Decline | null {
  const f = fetchNow(world), t = f?.trip;
  if (t && t.state !== 'prep' && t.state !== 'restore') return { cause: 'unneeded', text: `villagers: trip ${t.id} is ${t.state} (the villager care's)` };
  if (t?.state === 'prep' && t.prepared && !tripSiteOf(world, t.site)) return { cause: 'unneeded', text: `villagers: the trip's village (${t.site}) is no longer known` };
  if (wardOut(world, s.now)) return { cause: 'hold', text: 'villagers: a villager is on its way: no search and no look until it is in' };
  return null;
}

// ------------------------------------------------------------------------------------------------ the rung's gates

/**
 * Why the rung has nothing to do (pure): the switch off; no hall; the hall with its villagers as last counted (under
 * half an hour ago: older, the run looks again first), and the lure's wards on their way to it (led, or in the lock:
 * the hall's own once in).
 */
function hallWhy(s: Pick<Snapshot, 'now'>, world: WorldMemory): Decline | null {
  if (!movesOn(world)) return { cause: 'unneeded', text: 'villager moves are off' };
  if (!world.zones?.hall?.length) return { cause: 'unneeded', text: 'no villager hall yet' };
  const h = peekVillages(world).hall, way = wardsOnWay(world);
  if (h && s.now - h.at < HALL_FRESH && h.count + way >= HALL_WANTS) return { cause: 'stocked', text: `the hall has ${h.count} villagers${way ? ` and ${way} on its way` : ''} (${HALL_WANTS} wanted)` };
  return null;
}

/**
 * The `villagers` rung (worktasks.ts LADDER, rank 4.4: above the Nether and the deep trips, whose mornings it would
 * otherwise never get; it is a few moves in all). Its variants: each village known and open to it (within the range,
 * not someone's, its boat way not failed today: `first`, tried ahead of the turn), then the four sides of home, searched
 * out to VILLAGE_RANGE as the cows' are (`alongSide`), then the four bearings between them (DIAGONALS). Never in the
 * rain (the plan's word), never at night (the shared gates), never with a move's openings not put back. The way home
 * with a villager is at the boat's pace on land (`backPace`, and each variant's own need: moveNeedMs), so a move that
 * sets out has the day to come home in; one from a village too far out for that is not offered. A village judged
 * someone's by an older judge for a reason today's may undo (rejudge) is a look only (lookNeedMs). A search the day cut
 * short goes on from where it stopped, ahead of the turn (`searched`), at a walk's need (searchNeedMs).
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
    const v = peekVillages(world);
    // (under the lure its own variants, and the searches as before: idle-plan V 5.2)
    if (lureOn(world)) return lureVariants(s, world, searchesOf(v));
    // (the rails home as the gates read it: a village the boat found no way from is gone to again at once with the rails
    // switch on, its no-boat branch keeping the line, but none while a line is under way)
    const line = peekLine(world);
    const rails = { on: railsOn(world) && movesOn(world), ...(line ? { line: line.site } : {}) };
    const sites = v.sites.filter(q => siteOpen(q, home, s.now, rails)).map(q => ({ q, dist: horiz(q, home) }))
      .map(x => ({ ...x, need: rejudge(x.q) ? lookNeedMs(x.dist) : moveNeedMs(x.dist) }))
      // (a move that cannot be home with its villager by the day's end is never set out on: not offered at all)
      .filter(x => x.need <= DAY_MS).sort((a, b) => a.dist - b.dist);
    const searches = searchesOf(v);
    return [...sites.map(x => ({ id: variantOf(x.q), dist: Math.round(x.dist), first: true as const, needMs: x.need })), ...searches.filter(x => x.first), ...searches.filter(x => !x.first)];
  },
  none: (s, world) => hallWhy(s, world) ?? (lureOn(world) ? lureNone(s, world) : null) ?? { cause: 'unneeded', text: 'villagers: nothing to do' },
  ready: (s, world, variant) => {
    if (s.raining || s.thundering) return { cause: 'late', text: 'raining: no villager is moved in the rain' };
    const open = peekVillages(world).open?.length;
    if (open) return { cause: 'unneeded', text: `${open} block(s) of the hall or the fence left open by a move: close up first` };
    // (a prepared trip's dawn: the lead's switches, a bad omen, the clock)
    if (variant.startsWith(BRING)) return bringWhy(s, world);
    return null;
  },
  // the dawn is the trip's (idle-plan V 6.1): while its prepared trip would set out, over the kit and the home chores;
  // and from its set-out to the first flip (out, survey, first: the rung's own run, no lead's hold yet), the same, or
  // smelt (66), the kit (70) or the stash cut the walk out near home, and care's row 3 sent the trip to RESTORE with
  // its arm spent (S1 review N11). Asked of the running rung too (work.ts: never under TRIP_URGENCY)
  urgent: (s, world) => {
    if (!lureOn(world) || !movesOn(world)) return undefined;
    const state = fetchNow(world)?.trip?.state;
    if (state === 'out' || state === 'survey' || state === 'first') return DAWN_URGENCY;
    const t = preparedTrip(world);
    return t && villagersTask.ready(s, world, `${BRING}${t.site}`) === null ? DAWN_URGENCY : undefined;
  },
  run: async (ctx, variant, budgetMs, now) => {
    const began = now();
    // (a lure trip's budget is its morning's: idle-plan V 5.2; its looks and searches keep the rung's)
    const lure = lureOn(ctx.world), budget = lure && variant.startsWith(BRING) ? Math.min(budgetMs, LURE_BUDGET) : budgetMs;
    const enough = () => now() - began > budget;
    const left = () => began + budget - now();
    // the hall counted first, whichever way the run goes: a count over half an hour old lets the gates through, and a
    // full hall sent no one on a move but did send the side search out to 384 (the lure's wards on their way count too)
    const counted = await countHall(ctx, now());
    const way = lure ? wardsOnWay(ctx.world) : 0;
    if (counted !== undefined && counted + way >= HALL_WANTS) return { gain: 0, text: `the hall has ${counted} villagers already${way ? ` and ${way} on its way` : ''}: none moved`, mark: 'same' };
    if (isSearch(variant)) return searchSide(ctx, variant, enough, left, now);
    if (lure) return lureRun(ctx, variant, { now, began, budgetMs: budget, enough });
    // (made whole first: a site folded into its village's judged one since the variant was chosen is no village of its own)
    villagesOf(ctx.world);
    const site = siteOf(ctx.world, variant);
    if (!site) return { gain: 0, text: `no ${variant} known any more`, mark: 'forget' };
    if (rejudge(site)) return relook(ctx, site, { now, began, budgetMs, enough });
    return moveFrom(ctx, site, { now, began, budgetMs, enough });
  }
};

/** The searches of the eight bearings, as the rung offers them: one a day cut short goes on from where it stopped, ahead of the turn. */
function searchesOf(v: Pick<ReturnType<typeof peekVillages>, 'searched'>): { id: string; dist: number; needMs: number; first?: true }[] {
  return SEARCHES.map(id => {
    const from = v.searched?.[id]?.out ?? 0;
    return { id, dist: VILLAGE_RANGE, needMs: searchNeedMs(from), ...(from > 0 ? { first: true as const } : {}) };
  });
}

/**
 * A run of the rung under the lure: a prepared trip's dawn (lure.ts fetchRun: its walk out, the village, the hops home,
 * the gate, the lock; made dry while the dry switch is on), or a whole look at a village. A boat's move chosen before
 * the method was switched is not made.
 */
async function lureRun(ctx: GoalContext, variant: string, clk: Clock): Promise<WorkResult> {
  // (made whole first: a site folded into its village's judged one since the variant was chosen is no village of its own)
  villagesOf(ctx.world);
  if (variant.startsWith(BRING)) {
    const name = variant.slice(BRING.length), site = tripSiteOf(ctx.world, name);
    const t = fetchOf(ctx.world).trip;
    if (!site || !t || t.site !== name) return { gain: 0, text: `no trip prepared for ${name} any more`, untried: true };
    if (dryNext(ctx.world) && !t.dry) { t.dry = true; ctx.save?.(); }
    // (loaded when first asked: the lure's acts import half the brain, and this rung is loaded by the work queue. Its
    // waits run on the rung's clock with a real sleep that the run's end cuts short: a LureClock, fetch.ts)
    const { fetchRun } = await import('./lure.js');
    return fetchRun(ctx, site, rungClock(ctx, clk));
  }
  if (variant.startsWith(LOOK_AT)) {
    const name = variant.slice(LOOK_AT.length), site = siteOf(ctx.world, name);
    if (!site) return { gain: 0, text: `no ${name} known any more`, mark: 'forget' };
    return lookRun(ctx, site, clk);
  }
  return { gain: 0, text: `[${variant}] the boat's move is not made under the lure (method lure)`, mark: 'forget' };
}

/** The clock a lure trip of the rung runs on: the rung's time, budget and `enough`, and its sleep that the run's end cuts short (runSleep). */
export const rungClock = (ctx: Pick<GoalContext, 'signal'>, clk: Clock): Clock & { sleep: (ms: number) => Promise<void> } => ({ ...clk, sleep: runSleep(ctx.signal) });

/**
 * The lure's look (a `look:` variant, idle-plan V 4.1): out to a village by the gate that way, a WHOLE look round it
 * (every viewpoint the run's time allows) and today's judge; nothing placed, no villager touched, nothing carried for a
 * trip. Its word is kept (noteVerdict), and with it, from a look that saw all of it, the count the floor keeps
 * (`site.whole`). What came of it for a trip is counted while it stays the same (`fetch.why.look`, the Fetch: line:
 * at 3 it asks the lead), and cleared once the village is ready for one to be prepared.
 */
async function lookRun(ctx: GoalContext, site: VillageSite, clk: Clock): Promise<WorkResult> {
  const { now, enough } = clk;
  say(ctx, `to the village at ${fmt(site)} for a whole look (its count and its unemployed adults, for a lure trip): nothing placed`);
  const gate = await outByGate(ctx, site);
  if (gate.shut) return { gain: 0, text: `the village at ${fmt(site)} not looked at: ${gate.shut}`, untried: true };
  const stopped = await walkOut(ctx, gate.at ?? await here(ctx), site, enough);
  // (turned back by danger: no mark, so the wrapper's dry mark waits the longer each time; only the day's end the same)
  if (stopped) { say(ctx, stopped); return { gain: 0, text: stopped, ...(/^turned back/.test(stopped) ? {} : { mark: 'same' as const }) }; }
  const left = () => clk.began + clk.budgetMs - now();
  const home = ctx.s.home ?? ctx.s.position;
  const look = await lookVillage(ctx, { x: site.x, y: site.y, z: site.z }, now(), homeBy(enough, left, home));
  const v = judgeVillage(look);
  const kept = noteVerdict(ctx.world, site, look, v, now());
  const word = wordOn(v, kept);
  const seen = `${look.looked.chunks} of ${look.looked.of} chunks seen`;
  const tod = (await ctx.status().catch(() => undefined))?.timeOfDay ?? ctx.s.timeOfDay;
  const st = kept && word.kind === 'free' ? lureState(ctx.world, kept, { now: now(), timeOfDay: tod }, home) : undefined;
  const text = v.kind === 'none' ? `nothing of the village at ${fmt(site)} seen (${v.why}): looked at again later`
    : `looked at the village at ${fmt(site)} (${seen}): ${word.kind === 'free' ? `free (${word.why})${st ? `; for a trip: ${st.kind === 'prep' ? 'ready to prepare' : st.why}` : ''}`
      : word.kind === 'theirs' ? `someone's, left alone: ${word.why}` : word.why}`;
  say(ctx, text);
  noteWhy(ctx.world, 'look', st?.kind === 'prep' ? undefined : text.slice(0, 200), now());
  ctx.save?.();
  // (judged: its word stands. Nothing seen there: tried again later, the longer each time)
  return { gain: 0, text, ...(v.kind === 'none' ? {} : { mark: 'first' as const }) };
}

// ------------------------------------------------------------------------------------------------ looks

/** Where the bot stands now (status), else where the snapshot had it. */
export const here = async (ctx: GoalContext): Promise<Pos> => (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
/** One step of the rung said (`villagers: ...`, brain.log): the boat's move and the lure's trip alike (lure.ts). */
export const say = (ctx: GoalContext, text: string) => ctx.progress(`villagers: ${text}`);

/** The villagers inside the hall's box (world.entities from home or the hall), noted with the time; undefined when not seen. */
export async function countHall(ctx: GoalContext, now: number): Promise<number | undefined> {
  const hall = ctx.world.zones?.hall?.[0];
  if (!hall?.width || !hall.length) return undefined;
  const { x, y, z, width, length } = { ...hall, width: hall.width, length: hall.length };
  const r = await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 128, type: 'villager' }).catch(() => undefined);
  if (!Array.isArray(r?.entities)) return undefined;
  const inside = r.entities.filter(e => e.position && e.position.x >= x && e.position.x < x + width
    && e.position.z >= z && e.position.z < z + length && Math.abs(e.position.y - (y + 1)) <= 3);
  villagesOf(ctx.world).hall = { count: inside.length, at: now };
  // (the chores' census too: a villager brought in is the hall's from this look on)
  noteHall(ctx.world, r.entities, now);
  return inside.length;
}

/**
 * A village in sight from where the bot stands: a bell within 96 (world.findBlocks: the chunks loaded round it), else
 * three villagers out in the world near each other. Not one already judged (someone's, waiting, free) or found with no
 * boat way home: the side walks on past it (live in a probe, the north side walked back into a village it had judged
 * someone's every 20 minutes, and never searched beyond it). The villagers and players seen are remembered either way.
 */
export async function villageInSight(ctx: GoalContext, now: number): Promise<Pos | undefined> {
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

/** A banner the scans saw, and whether the bridge read it as an ominous one (a pillager outpost's: Foreign.java). */
type BannerMark = { x: number; y: number; z: number; name: string; ominous?: boolean };

/** A village a banner may be by: a site (its judged area, if any), or one just seen. */
type VillageAt = { x: number; z: number; area?: { x1: number; z1: number; x2: number; z2: number } };

/**
 * An ominous banner by a village (pure): the judge's to weigh (within ZONES_NEAR of its area a build with one is another
 * build), not a walk's to turn back from. The game keeps its pillager outposts 10 chunks off a village (the 26.3 jar's
 * pillager_outposts structure set), a watchtower about 120 and more from the bell and 57 and more off the area the judge
 * draws: one this near is a player's, a raid captain's banner for a trophy. Taken for an outpost, the north-west
 * village's one white wall banner (Nov 15) would turn its re-look back a leg short of it every 20 minutes, and keep the
 * search from finding a village with one. Within ZONES_NEAR of its area, or VILLAGE_REACH and AREA_GROW of a village
 * with none known yet.
 */
export function byVillage(villages: readonly VillageAt[], b: { x: number; z: number }): boolean {
  return villages.some(v => (v.area
    ? Math.hypot(Math.max(0, v.area.x1 - b.x, b.x - v.area.x2), Math.max(0, v.area.z1 - b.z, b.z - v.area.z2)) < ZONES_NEAR
    : horiz(v, b) <= VILLAGE_REACH + AREA_GROW));
}

/**
 * A pillager outpost within `r` of `p`: an ominous banner there, not by a village known or `also` (byVillage). Said
 * with where; undefined for none (or no answer: an older jar tells no banner apart, and the look goes on as before).
 * The banners are read where they hang (foreign.banners: the block entities of the chunks the client holds, about 96
 * round the bot at render distance 6), not from the scans' markers, which reach 48 round it: an ominous banner 64 to
 * 111 ahead of a stop was unknown there, and the bot walked its next leg to within 15 of it. A stop sees one 96 off at
 * the least, and turns back from one within OUTPOST_CLEAR and a leg on (and the STOP_RANGE short of a stop): a move's
 * walk out comes no nearer one than 96 - 56 = 40 (past the pillagers' 32 of sight), a search's 96 - 40 = 56. An older
 * jar has no foreign.banners: the scans' markers then (foreign.marks), as before.
 */
export async function outpostNear(ctx: GoalContext, p: { x: number; z: number }, r: number, also: readonly VillageAt[] = []): Promise<string | undefined> {
  const held = await ctx.call<{ at?: BannerMark[] }>('foreign.banners', { x: Math.floor(p.x), z: Math.floor(p.z), r: Math.ceil(r), max: 32 }).catch(() => undefined);
  const b = Array.isArray(held?.at) ? held : await ctx.call<{ at?: BannerMark[] }>('foreign.marks', {
    x1: Math.floor(p.x - r), z1: Math.floor(p.z - r), x2: Math.floor(p.x + r), z2: Math.floor(p.z + r), match: '.*_banner', max: 32
  }).catch(() => undefined);
  const villages = [...peekVillages(ctx.world).sites, ...also];
  const near = (b?.at ?? []).filter(m => m.ominous && horiz(m, p) <= r && !byVillage(villages, m)).sort((a, c) => horiz(a, p) - horiz(c, p))[0];
  return near ? `a pillager outpost (its ominous banner at ${fmt(near)}, ${Math.round(horiz(near, p))} off)` : undefined;
}

/**
 * What turns a walk out back from where the bot stands (danger, not courtesy): illagers within ILLAGER_SIGHT, or a
 * pillager outpost within OUTPOST_CLEAR and a stop on (`ahead`, and the STOP_RANGE a walk may end short of it), not one
 * by a village (`also`: one in sight). Said, or undefined.
 */
export async function dangerAt(ctx: GoalContext, at: { x: number; y?: number; z: number }, ahead = SEARCH_LEG, also: readonly VillageAt[] = []): Promise<string | undefined> {
  const r = await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: ILLAGER_SIGHT }).catch(() => undefined);
  const ill = (r?.entities ?? []).filter(e => ILLAGER.test(e.name) && e.position).sort((a, b) => horiz(a.position!, at) - horiz(b.position!, at))[0];
  if (ill) return `a ${ill.name} at ${fmt(ill.position!)}, ${Math.round(horiz(ill.position!, at))} off`;
  return outpostNear(ctx, at, OUTPOST_CLEAR + ahead + STOP_RANGE, also);
}

/**
 * A look's end that keeps the walk home (pure but for the clock): the run's time out, or a walk to `to` (a viewpoint, the
 * village) and home from there no longer fits what the run has left. The run's budget is the day's (a backPace task:
 * work.ts budgetFor keeps no walk home back), and a look of up to VIEWPOINTS walks went on to its end and walked home
 * after dusk from 300 out and more.
 */
const homeBy = (enough: () => boolean, left: () => number, home: { x: number; z: number }) =>
  (to?: { x: number; z: number }): boolean => enough() || (!!to && left() < VIEWPOINT_MS + horiz(to, home) / 3 * 1000);

/**
 * The look round a village for the judge: its bells, beds and job sites as the scans saw them (foreign.marks), the
 * creatures round it (each villager's own few cells read for a pen), the markers in its area and 16 round it, how much
 * of that the scans have seen (walking to up to VIEWPOINTS more places when not all), the builds of others, the players
 * remembered, the world spawn. `middle`: where the village is thought to be.
 */
export async function lookVillage(ctx: GoalContext, middle: Pos, now: number, enough: (to?: { x: number; z: number }) => boolean): Promise<VillageLook> {
  const seen = new Map<number, Seen>();
  const visited: { x: number; z: number }[] = [await here(ctx)];
  let marks: { at: { x: number; y: number; z: number; name: string }[] } = { at: [] };
  let kinds: Record<string, number> = {};
  let ominous: Record<string, number> | undefined;
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
    const k = await ctx.call<{ kinds?: Record<string, number>; ominous?: Record<string, number>; chunks?: number; of?: number }>('foreign.marks', {
      x1: a.x1 - MARKERS_NEAR, z1: a.z1 - MARKERS_NEAR, x2: a.x2 + MARKERS_NEAR, z2: a.z2 + MARKERS_NEAR, y1: a.y1 - MARKERS_NEAR, y2: a.y2 + MARKERS_NEAR
    }).catch(() => undefined);
    kinds = k?.kinds ?? {};
    // (an empty object is a word too: none of them ominous. None at all: an older jar, which tells no banner apart)
    ominous = k?.ominous;
    looked = { chunks: k?.chunks ?? 0, of: k?.of ?? 1 };
    if (looked.chunks >= looked.of || round === VIEWPOINTS || enough()) break;
    // the scans see 48 round the bot: on to the corner of the box farthest from where it has looked
    const box = { x1: a.x1 - MARKERS_NEAR, z1: a.z1 - MARKERS_NEAR, x2: a.x2 + MARKERS_NEAR, z2: a.z2 + MARKERS_NEAR };
    const pull = (lo: number, hi: number, v: number) => (v === lo ? Math.min(hi, lo + 40) : Math.max(lo, hi - 40));
    const corners = [[box.x1, box.z1], [box.x2, box.z1], [box.x1, box.z2], [box.x2, box.z2]].map(([x, z]) => ({ x: pull(box.x1, box.x2, x), z: pull(box.z1, box.z2, z) }));
    const far = corners.map(c => ({ c, d: Math.min(...visited.map(v => horiz(v, c))) })).sort((p, q) => q.d - p.d).filter(x => x.d >= 40);
    // (never to a corner by a pillager outpost: the look goes on from the others, or waits on the chunks unseen)
    let next: { c: { x: number; z: number }; d: number } | undefined;
    for (const x of far) {
      const danger = await outpostNear(ctx, x.c, OUTPOST_CLEAR, [{ x: middle.x, z: middle.z, area: a }]);
      if (!danger) { next = x; break; }
      say(ctx, `not looking round the village from (${x.c.x}, ${x.c.z}): ${danger}`);
    }
    if (!next || enough(next.c)) break;
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
  const near = await zonesRead(ctx, zones, villageArea({ ...parts, seen: [...seen.values()] }));
  return {
    ...parts, seen: [...seen.values()], penned, kinds, ...(ominous ? { ominous } : {}), looked, zones: near, players: peekVillages(ctx.world).players,
    ...(st.spawn ? { spawn: st.spawn } : {}), ...(unread.length ? { unread } : {})
  };
}

/** The most builds near a village read whole for the judge (each one foreign.marks call). */
const ZONES_READ = 32;

/**
 * The builds of others near the village (on the surface, within ZONES_NEAR and OUTPOST_CLEAR of its area), each read
 * whole (foreign.marks over its box: the zone names only its six commonest kinds, and the judge tells a village's
 * outbuilding or a pillager outpost by all it is built of, and its ominous banners). A read that did not answer leaves
 * the zone as it was: no outbuilding, no outpost, the courteous side. The zones farther off are kept as they are.
 */
async function zonesRead(ctx: GoalContext, zones: Zone[], area: ReturnType<typeof villageArea>): Promise<LookZone[]> {
  if (!area) return zones;
  const off = (z: Zone) => Math.hypot(Math.max(0, area.x1 - z.x2, z.x1 - area.x2), Math.max(0, area.z1 - z.z2, z.z1 - area.z2));
  const near = zones.filter(z => (z.surface ?? true) && off(z) < ZONES_NEAR + OUTPOST_CLEAR).sort((a, b) => off(a) - off(b)).slice(0, ZONES_READ);
  const out: LookZone[] = [];
  for (const z of zones) {
    if (!near.includes(z)) { out.push(z); continue; }
    const r = await ctx.call<{ kinds?: Record<string, number>; ominous?: Record<string, number> }>('foreign.marks', {
      x1: z.x1, z1: z.z1, x2: z.x2, z2: z.z2, y1: z.y1, y2: z.y2
    }).catch(() => undefined);
    if (!r?.kinds || typeof r.kinds !== 'object') { out.push(z); continue; }
    const ominous = Object.values(r.ominous ?? {}).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    out.push({ ...z, all: { ...r.kinds }, ...(ominous ? { ominous } : {}) });
  }
  return out;
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
 * site moved to its bell, with the area the judge saw; the village's other sites (within SAME_VILLAGE of it, or in that
 * area: noted from its villagers as the look went round) folded into it, one village one verdict (village.ts
 * foldSites: a site of it judged someone's before keeps that word, and all the ground it covered). Returns the site
 * kept (none: no village there, forgotten; but a site someone's is never forgotten, and is returned).
 */
export function noteVerdict(world: WorldMemory, site: VillageSite, look: VillageLook, v: Verdict, now: number): VillageSite | undefined {
  const counts = { bells: look.bells.length, beds: look.beds.length, jobs: look.jobs.length, villagers: look.seen.filter(e => e.name === 'villager').length };
  const w = villagesOf(world);
  // (the run's own site, or the one a fold took it into as the look went round (another site of the village, noted
  // from its villagers, judged someone's before, and the fold takes this one into it): that one's word is this village's. Else
  // the site as it was by its place, moved to its bell: not another one made beside it)
  const own = siteNow(w.sites, site) ?? w.sites.find(q => q.x === site.x && q.z === site.z);
  if (v.kind === 'none') {
    // (nothing seen there: forgotten, but never a site someone's, a word kept for good)
    if (own?.judged?.kind === 'theirs') return own;
    if (own) w.sites = w.sites.filter(q => q !== own);
    return undefined;
  }
  const kept = own ?? noteVillage(world, look.bells[0] ?? site, counts, now);
  // (someone's on it already stays someone's: a fold may have made the village's someone's site the one found here;
  // the judge's narrower word does not undo it, and the ground it covered stays its as it moves to the bell and takes
  // the judge's area. But for an older judge's word today's may undo (rejudge: another build, a player's marker or
  // banner, a player seen, a villager penned in), which this verdict replaces, area and all)
  const held = kept.judged?.kind === 'theirs' && !rejudge(kept) ? reachOf(kept) : undefined;
  const was = held && v.kind !== 'theirs' ? kept.judged : undefined;
  const bell = look.bells[0];
  if (bell) { kept.x = bell.x; kept.y = bell.y; kept.z = bell.z; }
  // (today's judge's word, with its version; under the lure a wait counts the equal ones in a row, which double its
  // wait from the fourth: village.ts waitAgain)
  const judged: NonNullable<VillageSite['judged']> = { at: now, kind: v.kind, why: v.why.slice(0, 160), ...(v.kind === 'theirs' ? { rule: v.rule } : {}), v: JUDGE_V };
  const lure = lureOn(world), before = kept.judged;
  if (lure && v.kind === 'wait') {
    const gist = (s: unknown) => String(s).replace(/-?\d+(\.\d+)?/g, '#');
    judged.n = before?.kind === 'wait' && gist(before.why) === gist(judged.why) ? (typeof before.n === 'number' && before.n >= 1 ? before.n : 1) + 1 : 1;
  }
  Object.assign(kept, counts, { seenAt: now, judged: was ?? judged });
  // (under the lure, a look that saw all of it free: its count for the floor, no take since. A part look keeps the
  // count it has: idle-plan V 4.1, F-15)
  const whole = lure && !was ? wholeLook(look, v, now) : undefined;
  if (whole) kept.whole = whole;
  const area = v.area ? { x1: v.area.x1, z1: v.area.z1, x2: v.area.x2, z2: v.area.z2 } : undefined;
  if (area || held) kept.area = held ? joinAreas(area, held) : area;
  // (made whole again: the fold, in place. Folded, the site it went into: not the nearest, which may be one not judged)
  return siteNow(villagesOf(world).sites, kept);
}

/** The word on a village after the judge's (pure): the verdict, or someone's where a site of the village was judged so before. */
export const wordOn = (v: Verdict, kept: VillageSite | undefined): { kind: Verdict['kind']; why: string } =>
  (kept?.judged?.kind === 'theirs' && v.kind !== 'theirs' ? { kind: 'theirs', why: kept.judged.why } : v);

// ------------------------------------------------------------------------------------------------ the search

/**
 * Along one side of home for a village, or one bearing between two sides, out to the range (the cows' way: stops 32
 * apart, by the side's own gate, or one on either side of the bearing): found, the bot walks to its middle and looks it
 * over, and the judge's word is kept. The move is the next run's (from the known site, `first`), which reads the boat's
 * way home on its walk out. Out to 640 and back with the looks is more than a day's work: the search stops while the
 * walk home from a stop on still fits what the run has left (`left`), and the next run goes on from the farthest stop
 * looked from (`villages.searched`), walking out past the rest. Illagers by a stop, or a pillager outpost ahead, turn
 * the bearing back (danger, not courtesy: nothing of a move goes within OUTPOST_CLEAR of one).
 */
async function searchSide(ctx: GoalContext, side: Bearing, enough: () => boolean, left: () => number, now: () => number): Promise<WorkResult> {
  const home = ctx.s.home ?? ctx.s.position;
  const before = peekVillages(ctx.world).searched?.[side];
  const from = before && before.out < VILLAGE_RANGE ? before.out : 0;
  say(ctx, `looking ${side} for a village, out to ${VILLAGE_RANGE}${from ? ` (looked along to ${from} before: on from there)` : ''}`);
  let farthest = from;
  let me: Pos = ctx.s.position;
  // (the day's end: the walk home from the next stop no longer fits what the run has left)
  const short = () => enough() || left() < (horiz(me, home) + SEARCH_LEG) / 3 * 1000;
  const sight = async (): Promise<Pos | { danger: string } | undefined> => {
    me = await here(ctx);
    // (a village in sight first: an ominous banner by it is the judge's to weigh, not an outpost to turn back from)
    const village = await villageInSight(ctx, now());
    const danger = await dangerAt(ctx, me, SEARCH_LEG, village ? [village] : []);
    if (danger) return { danger };
    farthest = Math.max(farthest, Math.round(horiz(me, home)));
    return village;
  };
  // (the stops an earlier run looked from, walked through: the danger looked for there all the same (a patrol since, an
  // outpost the chunks now loaded show), and where the bot is kept for the day's end)
  const pass = async (): Promise<{ danger: string } | undefined> => {
    me = await here(ctx);
    const danger = await dangerAt(ctx, me);
    return danger ? { danger } : undefined;
  };
  const found = await alongSide<Pos | { danger: string }>(ctx, side, 'village', sight, short, { blocks: VILLAGE_RANGE, name: 'the village range' }, from, pass);
  const mem = villagesOf(ctx.world);
  const drop = () => { if (mem.searched) { delete mem.searched[side]; if (!Object.keys(mem.searched).length) delete mem.searched; } };
  const keep = (out: number) => { if (out > 0 && out < VILLAGE_RANGE) (mem.searched ??= {})[side] = { out, at: now() }; else drop(); };
  if (found.found && 'danger' in found.found) {
    drop();
    const text = `turned back ${side} at ${fmt(me)}, ${Math.round(horiz(me, home))} from home: ${found.found.danger}`;
    say(ctx, text);
    return { gain: 0, text };
  }
  if (!found.found) {
    if (found.short) keep(farthest); else drop();
    return { gain: 0, text: found.text, ...(found.short ? { mark: 'same' as const } : {}) };
  }
  const at = found.found;
  // (the walk over and the look, and home from there, by the day's end: else the next run goes on from this stop and
  // sees it again)
  const by = homeBy(enough, left, home);
  if (by(at)) {
    keep(farthest);
    const text = `a village in sight at ${fmt(at)}, but the day is too short to walk over and look at it: the next run, from ${farthest} out`;
    say(ctx, text);
    return { gain: 0, text, mark: 'same' };
  }
  // (found: the move is the next run's, and the bearing's next search walks past it from home, as past any known village)
  drop();
  say(ctx, `a village in sight at ${fmt(at)}, ${Math.round(horiz(at, ctx.s.home ?? ctx.s.position))} from home: walking over to look at it`);
  // (careful: walk only, nothing broken or put down in a village not judged yet; one not got to is looked at from where
  // the walk ended, and waits when the scans did not see it all)
  await ctx.call('goto', { x: at.x, y: at.y, z: at.z, xz: true, range: 8, careful: true, timeoutMs: 90_000 }, 105_000).catch(() => undefined);
  if (ctx.signal.aborted) throw new Error('aborted');
  const site = noteVillage(ctx.world, at, {}, now());
  const look = await lookVillage(ctx, at, now(), by);
  const v = judgeVillage(look);
  const word = wordOn(v, noteVerdict(ctx.world, site, look, v, now()));
  const far = tooFarWord(horiz(at, ctx.s.home ?? ctx.s.position));
  const text = `found a village at ${fmt(at)}: ${word.kind === 'free' ? `free (${word.why}): ${far ?? 'the move next run'}` : word.kind === 'theirs' ? `someone's, left alone: ${word.why}` : word.why}`;
  say(ctx, text);
  return { gain: 0, text, mark: 'first' };
}

/**
 * Out to a village known, carefully, a leg at a time (SURVEY_LEG apart), turned back by danger at a stop (illagers,
 * a pillager outpost ahead: dangerAt) or the run's time: why it stopped, or undefined once there. `each`: what is done
 * at each stop (the move reads the boat's way home there).
 */
export async function walkOut(ctx: GoalContext, from: { x: number; z: number }, site: VillageSite, enough: () => boolean, each?: () => Promise<void>): Promise<string | undefined> {
  const target = { x: site.x + 0.5, z: site.z + 0.5 };
  const d = horiz(from, target);
  const legs = Math.max(1, Math.ceil(d / SURVEY_LEG));
  for (let i = 1; i <= legs; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    if (enough()) return `the run's time ran out on the way out to the village at ${fmt(site)}`;
    const p = { x: Math.round(from.x + (target.x - from.x) * i / legs), z: Math.round(from.z + (target.z - from.z) * i / legs) };
    // (the line starts outside the panel's fence: to a village on the far side, its first stops lie in the yard, which
    // the walk out has just left by the gate that way; the band there was read from home before it set out)
    if (inFence(ctx.world, p)) continue;
    // careful by the yard (walk only: nothing broken or put down there), and as it comes up to the village, which is not
    // judged yet: a walk not got to its stop reads from where it ended
    const careful = byYard(ctx.world, await here(ctx), p) || horiz(p, target) <= LOOK;
    await ctx.call('goto', { x: p.x, y: site.y, z: p.z, xz: true, range: 8, ...(careful ? { careful: true } : {}), timeoutMs: 90_000 }, 105_000).catch(() => undefined);
    // (danger, not courtesy: illagers by the stop, or an outpost within OUTPOST_CLEAR of the next one)
    const at = await here(ctx);
    const danger = await dangerAt(ctx, at, SURVEY_LEG);
    if (danger) return `turned back at ${fmt(at)} on the way out to the village at ${fmt(site)}: ${danger}`;
    await each?.();
  }
  return undefined;
}

/**
 * A village judged someone's by an older judge for a reason today's may undo (village.ts rejudge: another build by it,
 * a player's marker or banner, a player seen, a villager penned in) is looked at and judged again, once: out to it a leg at a time
 * (by the gate that way), the look round it, today's judge, its word kept for good (JUDGE_V). Free, the move is the
 * next run's. No villager is touched, nothing is carried for a move.
 */
async function relook(ctx: GoalContext, site: VillageSite, clk: Clock): Promise<WorkResult> {
  const { now, enough } = clk;
  const was = site.judged?.why ?? '';
  say(ctx, `to the village at ${fmt(site)} to judge it again (someone's to an older judge: ${was})`);
  const gate = await outByGate(ctx, site);
  if (gate.shut) return { gain: 0, text: `the village at ${fmt(site)} not judged again: ${gate.shut}`, untried: true };
  const stopped = await walkOut(ctx, gate.at ?? await here(ctx), site, enough);
  // (turned back by danger: no mark, so the wrapper's dry mark waits the longer each time; only the day's end the same.
  // As 'same' a site whose way out passes an outpost was walked out to and back every 20 minutes of daylight)
  if (stopped) { say(ctx, stopped); return { gain: 0, text: stopped, ...(/^turned back/.test(stopped) ? {} : { mark: 'same' as const }) }; }
  const left = () => clk.began + clk.budgetMs - now();
  const look = await lookVillage(ctx, { x: site.x, y: site.y, z: site.z }, now(), homeBy(enough, left, ctx.s.home ?? ctx.s.position));
  const v = judgeVillage(look);
  const kept = noteVerdict(ctx.world, site, look, v, now());
  const word = wordOn(v, kept);
  // (nothing of it seen from there: its old word stands until a look that sees it)
  const text = v.kind === 'none' ? `nothing of the village at ${fmt(site)} seen to judge it again (${v.why}): its word stands, looked at again later`
    : `judged the village at ${fmt(site)} again (was someone's: ${was}): ${word.kind === 'free' ? `free (${word.why}): ${tooFarWord(horiz(site, ctx.s.home ?? ctx.s.position)) ?? 'the move next run'}`
      : word.kind === 'theirs' ? `someone's, left alone: ${word.why}` : word.why}`;
  say(ctx, text);
  // (judged: its word stands, and the move, if any, is the next run's. Nothing seen there: tried again later, the
  // longer each time)
  return { gain: 0, text, ...(v.kind === 'none' ? {} : { mark: 'first' as const }) };
}

// ------------------------------------------------------------------------------------------------ the move

/**
 * A run's clock as the rung hands it on: `now` the wrapper's, `began` when the run set out, its budget, and `enough`
 * once the budget is spent (the lure's trip starts from it too: lure.ts fetchRun).
 */
export interface Clock { now: () => number; began: number; budgetMs: number; enough: () => boolean }

/** The bot's own boat (vehicle.place's): its id now and the uuid that names it after a restart. */
export interface Boat { id: number; uuid: string }
/** What the vehicle calls answer: ok, or why not. */
type Reply = { ok: boolean; reason?: string };
type Placed = Reply & { id?: number; uuid?: string; position?: Pos; tookIt?: boolean };

/** What the bot rides (status.riding), or undefined on foot. */
export const ridingOf = async (ctx: GoalContext): Promise<Status['riding']> => (await ctx.status().catch(() => undefined))?.riding ?? undefined;

/** The block under a creature's feet (a boat put down on its top face comes down where the creature stands). */
const under = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y - 0.01), z: Math.floor(p.z) });

/** One block a move dug: what it was, so it goes back as it was. */
type Opened = { at: Pos; block: string };

/**
 * Dig a block from where the bot sits or stands (dig.here: no walking, no Baritone), written into `villages.open`
 * first, so a run cut short leaves it for `close up`. Air: nothing to do. Returns why not, or undefined.
 */
export async function digOut(ctx: GoalContext, at: Pos, block: string | null | undefined): Promise<string | undefined> {
  if (ctx.signal.aborted) throw new Error('aborted');
  if (!block || /^(minecraft:)?(air|cave_air)(\[|$)/.test(block)) return undefined;
  const v = villagesOf(ctx.world);
  (v.open ??= []).push({ at: { ...at }, block });
  // (kept on disk before the dig: a restart mid-run would forget the opening, a gap in the fence or the hall for good)
  ctx.save?.();
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

/**
 * Put back everything a move left open (or those of `which`), the lowest first, walking carefully into reach of each.
 * Not the rails home's opening in the fence while its rail stands in it (railshome.ts held: the take-up's to put back
 * once the rail is up; put back now it would only meet the rail, "already a block")
 */
export async function closeUp(ctx: GoalContext, which?: (o: Opened) => boolean): Promise<{ put: number; left: string[] }> {
  const todo = [...(villagesOf(ctx.world).open ?? [])].filter(o => (which ? which(o) : !heldByRails(ctx.world, o.at))).sort((a, b) => a.at.y - b.at.y);
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
  const straight = entryOf(world);
  // (no hall, no panel, no room beside it: no way in at all. A gate or a corner in the fence straight out from the panel
  // leaves the way in across the yard, as a hill there does)
  if ('why' in straight && !straight.fence) return { gain: 0, text: `no way into the hall: ${straight.why}`, untried: true };
  // the ground: from under the yard's floor (the boat's lowest) to over the village's, with room for the rails' climbs
  // and dips (their dry run plans on the same reads when the boat finds no way)
  const level = world.yard!.y + 1;
  const y0 = Math.min(level - MAX_DROP - 3, Math.min(site.y, level) - RAILS_BELOW);
  const top = Math.max(site.y + 12, level + 8, Math.max(site.y, level) + RAILS_ABOVE);
  const ground = new Ground(y0, Math.min(64, top - y0 + 1));
  let entry: Entry, fence: Opened[], wall: Opened[];
  if ('why' in straight) {
    const r = await acrossYard(ctx, ground, site, 'the fence there holds a gate or a corner');
    if (!('entry' in r)) return r;
    ({ entry, fence, wall } = r);
  } else {
    entry = straight;
    // the yard's part, read from here: the fence's posts and what stands on them, the hall's wall
    const yardBox = boxOf([entry.out, entry.front, entry.inside, ...entry.fence, ...entry.wall], 4);
    await ground.read(ctx, yardBox.x1, yardBox.z1, yardBox.x2, yardBox.z2);
    ({ fence, wall } = openingsOf(ground, entry));
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
      // straight out from the panel the ground outside lets no boat by (live on Nov 15 the hall's panel faced the hill
      // the yard is cut into): in by another panel of the fence and across the yard
      const r = await acrossYard(ctx, ground, site, `${inside.why} at ${fmt(inside.at)}`);
      if (!('entry' in r)) return r;
      ({ entry, fence, wall } = r);
    }
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
    // any ready food the chests hold first (food.ts gatherFood), then bread: none may be stored (Nov 21)
    await gatherFood(ctx, ride, true, true).catch(() => undefined);
    fed = readyFoodPoints(await countsNow(ctx));
  }
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
  const stopped = await walkOut(ctx, entry.out, site, enough, async () => { await readBand(ctx, ground, entry.out, target, BAND, await here(ctx), READ_NEAR); });
  // (turned back by danger: no mark, the dry mark's wait growing each time; only the day's end the same)
  if (stopped) {
    if (/^turned back/.test(stopped)) { say(ctx, stopped); return { gain: 0, text: stopped }; }
    return { gain: 0, text: stopped, mark: 'same' };
  }
  if (ctx.signal.aborted) throw new Error('aborted');

  // the village looked over and judged
  const look = await lookVillage(ctx, { x: site.x, y: site.y, z: site.z }, now(), enough);
  const v = judgeVillage(look);
  const kept = noteVerdict(world, site, look, v, now());
  const forgotten: WorkResult = { gain: 0, text: `no village at ${fmt(site)} any more: forgotten`, mark: 'forget' };
  if (!kept) return forgotten;
  // (nothing seen there now, but a site someone's kept for it: that word)
  const word = wordOn(v, kept);
  if (v.kind === 'theirs' || word.kind === 'theirs') {
    say(ctx, `the village at ${fmt(site)} is someone's, left alone: ${word.why}`);
    return { gain: 0, text: `left the village at ${fmt(site)} alone: ${word.why}`, mark: 'forget' };
  }
  if (v.kind === 'none') return forgotten;
  if (v.kind === 'wait') return { gain: 0, text: `the village at ${fmt(site)}: ${v.why}` };
  say(ctx, `the village at ${fmt(site)} is free to take from: ${v.why}`);
  if (!v.candidates.length) return { gain: 0, text: `no villager to take at ${fmt(site)}: ${v.why}` };
  // (a player by the bot or the village right now: nothing done this run, the village still free. Looked at again just
  // before the boat goes down, too)
  const by = playerNow((await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: PLAYER_SIGHT }).catch(() => undefined))?.entities ?? [], await here(ctx), v.area);
  if (by) {
    const text = `no villager taken at ${fmt(site)} this run: ${by}`;
    say(ctx, text);
    return { gain: 0, text };
  }
  // its ground, for the boat's first legs out of it and the ways home (the boat's and the rails' dry run): the whole box
  // their searches keep within, as far as READ_NEAR round it, not its area alone. The walk out reads only the band
  // BAND either side of the straight line home; a way round what blocks that band runs by the village, outside its area
  // (live, the west village (-693, 2262): on Nov 18 its area reached z 2191, a villager wandered north, and the rails
  // went round a ridge through x -701..-673, z 2196..2207; from Nov 19 its area began at z 2204, that ground was never
  // read, and the rails' search, shut in the area and the band, got no nearer than (-683, 2204))
  const bounds = boxOf([entry.out, target, { x: v.area.x1, z: v.area.z1 }, { x: v.area.x2, z: v.area.z2 }], BAND);
  await ground.read(ctx, Math.max(bounds.x1, Math.floor(target.x) - READ_NEAR), Math.max(bounds.z1, Math.floor(target.z) - READ_NEAR),
    Math.min(bounds.x2, Math.floor(target.x) + READ_NEAR), Math.min(bounds.z2, Math.floor(target.z) + READ_NEAR));
  // the way home keeps off every build but its own (a pillager outpost by it is no one's build, but danger: the way home
  // keeps OUTPOST_CLEAR off it, where FROM_ZONES keeps 16 off a build of others)
  const zones = wayZones(look, v);
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
  const homeTakes = homeMs(chosen.e.position!, [...chosen.legs, ...yardLegs(entry)]);
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
 * The rails fallback when the boat finds no way home: planned on the ground the walk out read and said; with the rails
 * switch off (as it ships) a dry run, nothing laid, as P5c had it; with it on (and the moves on) the line is kept to be
 * laid (railshome.ts startLine: the `rails` rung makes the bill, lays it over days, moves the villager and takes it all
 * back up), unless a line is under way already. From by the villagers the judge allows (the nearest to the bot first) to the yard's fence the boat's way in
 * comes by (straight out from the hall's panel, or the panel of a way in across the yard: the same entry), 16 off every
 * build but the village's own: the route, the bill against the stores (the chests as last seen and the pockets), every
 * block it would put down and take back up (kept for the villager-moves tool), what it would open. Its line is kept on
 * the site. Returns what the run's result says of it.
 */
function railsDryRun(ctx: GoalContext, t: {
  site: VillageSite; ground: Ground; entry: Entry; fence: Opened[]; zones: Zone[]; bounds: { x1: number; z1: number; x2: number; z2: number };
  candidates: Seen[]; me: Pos; at: number;
}): string {
  // (the line comes in by the fence the boat's way comes in by: straight out from the hall's panel, or across the yard)
  const panel = t.entry.yard?.post ?? (ctx.world.zones?.['hall:panel'] ?? []).filter(p => p && typeof p.y === 'number').sort((a, b) => a.y - b.y)[0];
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
  // the rails switch on: the line kept to be laid (the rails rung's from here: the bill first)
  if (railsOn(ctx.world) && movesOn(ctx.world)) {
    const line = startLine(ctx.world, r, t.site, t.entry, t.at);
    if (line) {
      say(ctx, `rails home planned and kept to be laid (the rails switch is on): ${railsLine(r)}`);
      say(ctx, `rails: the route ${r.route}; the bill first, then laid from the yard's fence out over as many days as it takes; the fence at ${r.opens.map(o => `${idOf(o.block)} ${fmt(o.at)}`).join(', ')} opened on the move's day only`);
      return `rails home planned and kept to be laid: ${r.length} rails, ${r.bill.iron_ingot} iron, ${r.bill.gold_ingot} gold; the bill next`;
    }
    // (the switch is on: not the dry run's words, which would read as the switch not working)
    const under = peekLine(ctx.world);
    const text = `rails home planned only: ${under ? `the line to the village at ${fmt(under.site)}` : 'a line'} is under way (one at a time)`;
    say(ctx, `${text}: ${railsLine(r)}`);
    return text;
  }
  say(ctx, `rails home planned (a dry run, nothing laid): ${railsLine(r)}`);
  say(ctx, `rails: the route ${r.route}; it would open the fence at ${r.opens.map(o => `${idOf(o.block)} ${fmt(o.at)}`).join(', ')} and take every rail, torch${r.stop.placed ? ' and the stop' : ''} back up after`);
  return `rails home planned (a dry run, nothing laid): ${r.length} rails, ${r.bill.iron_ingot} iron, ${r.bill.gold_ingot} gold, about ${Math.round(r.seconds.total / 60)} min`;
}

/**
 * What a way in digs out, read off the ground: the fence's posts, each after what stands on it (a torch on a post pops
 * off as its post goes, and would never be put back), and the hall's wall. A block not read is ''.
 */
function openingsOf(ground: Ground, entry: Entry): { fence: Opened[]; wall: Opened[] } {
  const fence: Opened[] = [];
  for (const p of entry.fence) {
    const over = { x: p.x, y: p.y + 1, z: p.z };
    const top = ground.state(over.x, over.y, over.z);
    if (top && !/^(minecraft:)?(air|cave_air)(\[|$)/.test(top)) fence.push({ at: over, block: top });
    fence.push({ at: p, block: ground.state(p.x, p.y, p.z) ?? '' });
  }
  return { fence, wall: entry.wall.map(p => ({ at: p, block: ground.state(p.x, p.y, p.z) ?? '' })) };
}

/**
 * The way in across the yard where straight out from the hall's panel will not do (`blocked`: why not), the whole yard
 * read for it from here (boatroute.ts yardEntry): the entry, what it opens (judged as air on `ground` from here on), and
 * said; or the run's result when there is none.
 */
async function acrossYard(ctx: GoalContext, ground: Ground, site: VillageSite, blocked: string): Promise<{ entry: Entry; fence: Opened[]; wall: Opened[] } | WorkResult> {
  const yard = ctx.world.yard!;
  await ground.read(ctx, yard.x1 - YARD_READ, yard.z1 - YARD_READ, yard.x2 + YARD_READ, yard.z2 + YARD_READ);
  const entry = yardEntry(ground, ctx.world, site);
  if ('why' in entry) return { gain: 0, text: `the boat's way into the hall is blocked: ${blocked}; and across the yard: ${entry.why}`, untried: true };
  const { fence, wall } = openingsOf(ground, entry);
  const notRead = [...fence, ...wall].find(o => !o.block);
  if (notRead) return { gain: 0, text: `the way into the hall across the yard not read at ${fmt(notRead.at)}`, untried: true };
  for (const o of [...fence, ...wall]) ground.set(o.at.x, o.at.y, o.at.z, 'air');
  const way = entry.yard!;
  const span = (ps: Pos[]) => `${fmt(ps[0])}..${fmt(ps[ps.length - 1])}`;
  say(ctx, `the boat's way into the hall: straight out from its panel ${blocked}; in by the yard's ${way.side} fence at ${span(entry.fence)} instead, ` +
    `across the yard in ${way.legs.length} leg(s), into the hall by a panel in its ${entry.side} wall at ${span(entry.wall)}`);
  return { entry, fence, wall };
}

/** The yard's part of the way home past `out`, in order: in through the fence to `through`, the legs across the yard (none straight out). */
const yardLegs = (entry: Entry): { x: number; z: number }[] => (entry.yard ? [entry.yard.through, ...entry.yard.legs] : []);

/** A box round some points (x1..z2), grown by `by`. */
function boxOf(ps: { x: number; z: number }[], by: number) {
  return {
    x1: Math.floor(Math.min(...ps.map(p => p.x))) - by, z1: Math.floor(Math.min(...ps.map(p => p.z))) - by,
    x2: Math.floor(Math.max(...ps.map(p => p.x))) + by, z2: Math.floor(Math.max(...ps.map(p => p.z))) + by
  };
}

/**
 * The zones a boat way out of a village keeps FROM_ZONES off (pure): every build round it but the village's own, a
 * pillager outpost by it grown so the way keeps OUTPOST_CLEAR off it (no one's build, but danger). The way home's and
 * the rails' hop to their pickup.
 */
export function wayZones(look: Pick<VillageLook, 'zones'>, v: { own: readonly Zone[]; outposts: readonly Zone[] }): Zone[] {
  const grow = OUTPOST_CLEAR - FROM_ZONES;
  return look.zones.filter(z => !v.own.includes(z))
    .map(z => (v.outposts.includes(z) ? { ...z, x1: z.x1 - grow, z1: z.z1 - grow, x2: z.x2 + grow, z2: z.z2 + grow, y1: z.y1 - grow, y2: z.y2 + grow } : z));
}

interface Trip {
  site: VillageSite; entry: Entry; ground: Ground; zones: Zone[]; fence: Opened[]; wall: Opened[];
  plan: (from: BoatAt) => ReturnType<typeof planRoute>;
  villager: Seen; jobs: readonly { at: Pos }[]; clk: Clock;
}

/** Why a villager the judge allowed is no longer one to take, looked at again just before the boat goes down; '' if it still is. */
export function notFree(e: Seen, jobs: readonly { at: Pos }[]): string {
  if (e.profession !== 'none') return `has a job now (${e.profession ?? 'none said'})`;
  if (e.baby) return 'is a baby';
  if (e.named) return 'is named';
  if (e.vehicle) return `rides a ${e.vehicle}`;
  if (e.leashed) return 'is on a lead';
  // (traded with since: a player's)
  const used = usedHow(e);
  if (used) return used;
  if (byJobSite(e, jobs)) return 'stands by a job site';
  return '';
}

/** How far round the bot a look for players at move time reaches (a village's area is up to some 100 across). */
export const PLAYER_SIGHT = 128;

/**
 * A player within PLAYER_NOW of the bot or of the village's area right now (pure): what is said of it, or undefined.
 * The judge no longer makes a village someone's for a player seen by it (the user's word of Nov 20: "A player utilizing
 * it should know to give them some distance"), but nothing is taken with one standing by.
 */
export function playerNow(seen: readonly Seen[], me: { x: number; z: number }, area?: { x1: number; z1: number; x2: number; z2: number }): string | undefined {
  for (const e of seen) {
    if (e.name !== 'player' || !e.position) continue;
    const d = horiz(e.position, me);
    if (d <= PLAYER_NOW) return `a player at ${fmt(e.position)}, ${Math.round(d)} from the bot`;
    const off = area ? Math.hypot(Math.max(0, area.x1 - e.position.x, e.position.x - area.x2), Math.max(0, area.z1 - e.position.z, e.position.z - area.z2)) : Infinity;
    if (off <= PLAYER_NOW) return `a player at ${fmt(e.position)}, ${Math.round(off)} from the village`;
  }
  return undefined;
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
      // (one within PLAYER_NOW of the bot or the village: nothing taken this run, the village still free)
      const round = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: PLAYER_SIGHT }).catch(() => undefined))?.entities ?? [];
      noteSeen(world, round, now(), ctx.s.dimension);
      const player = playerNow(round, await here(ctx), site.area);
      if (player) return await giveUp(`${player}: no villager taken this run`);
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
    const needHome = homeMs(pos, [...route, ...yardLegs(entry)]);
    if (left() < needHome) return await giveUp(`not enough of the run left to bring the villager home (need ${secs(needHome)} s, ${secs(left())} s left)`);
    const m = await ctx.call<Reply & { controlling?: boolean }>('vehicle.mount', { id: boat.id, uuid: boat.uuid }, 15_000).catch((x): Reply & { controlling?: boolean } => ({ ok: false, reason: (x as Error).message }));
    if (!m.ok) return await giveUp(`could not get into the boat: ${m.reason ?? 'no reply'}`);
    if (!m.controlling) return await giveUp('in the boat, but not in the front seat (not steering)');
    say(ctx, `in the boat with the villager (${e.id}): home in ${route.length} leg(s)`);

    // the drive home, leg by leg, to the stop outside the fence. `inside`: from the fence on (through it, across the
    // yard, into the hall) a drive gets the time its way takes, whatever is left of the run's budget: timed out there,
    // the villager let out would be loose in the yard (the run's own timeout still bounds the run)
    const drive = async (to: { x: number; z: number }, within: number, what: string, inside = false): Promise<string | undefined> => {
      if (ctx.signal.aborted) throw new Error('aborted');
      const at = await ridingOf(ctx);
      const p = at?.position;
      const dist = p ? horiz(p, to) : 0;
      const ms = Math.max(20_000, Math.min(15 * MINUTE, Math.round(dist / BOAT_PACE * 1500) + 10_000, inside ? Infinity : Math.max(20_000, left())));
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
    // a post of the 3-wide gap), before anything is dug. In by a panel of the fence elsewhere, the yard is crossed
    // between the two, its own builds kept off (keepOff) as the way was planned
    const own = keepOff(ground, world);
    const throughFrom = async (to: { x: number; z: number }, what: string, g: Pick<Ground, 'cell'> = ground): Promise<string | undefined> => {
      const at = (await ridingOf(ctx))?.position;
      if (!at) return 'no longer in the boat';
      const leg = checkLeg(g, { x: at.x, z: at.z, level: at.y }, to);
      return leg.ok ? undefined : `the boat stopped where its way ${what} does not hold, at ${fmt(at)}: ${leg.why} at ${fmt(leg.at)}`;
    };
    const yard = entry.yard;
    const offFence = await throughFrom(yard?.through ?? entry.front, 'through the fence', yard ? own : ground);
    if (offFence) return await giveUp(offFence);
    for (const o of t.fence) {
      const why = await digOut(ctx, o.at, o.block);
      if (why) return await giveUp(`the fence did not come out: ${why}`);
    }
    say(ctx, `the fence open at ${t.fence.filter(o => o.at.y === entry.level).map(o => fmt(o.at)).join(', ')}`);
    const through = yard ? await drive(yard.through, 0.5, `through the fence into the yard at ${fmt(yard.through)}`, true)
      : await drive(entry.front, 0.5, `through the fence to the hall at ${fmt(entry.front)}`, true);
    if (through) return await giveUp(through);
    if (yard) {
      // across the yard leg by leg, each judged again from where the boat is, the rest planned again when it no longer
      // holds; nothing in the yard dug on the way
      let legs = [...yard.legs];
      let k = 0, again = 0;
      while (legs.length) {
        // (no give-up for the run's time here, and no drive cut to what is left of it: inside the fence, the villager let
        // out would be loose in the yard, by the bot's beds and doors; the hall is a few legs on, and the run's own
        // timeout still bounds the run)
        if (ctx.signal.aborted) throw new Error('aborted');
        const at = await ridingOf(ctx);
        if (!at?.position) return await giveUp('no longer in the boat');
        const from: BoatAt = { x: at.position.x, z: at.position.z, level: at.position.y };
        if (!checkLeg(own, from, legs[0]).ok) {
          if (++again > 5) return await giveUp(`the way across the yard kept failing from ${fmt(at.position)}`);
          await yieldNow();
          const r = planRoute(own, from, entry.front, { bounds: yardInside(world.yard!), within: 1, corners: false });
          if (!r.ok) return await giveUp(`no way across the yard from ${fmt(at.position)}: ${r.why}`);
          legs = r.legs;
          continue;
        }
        // (every leg to within the bridge's least, 0.5: the legs round the yard's builds hug them at the slack's edge, and
        // from a stop 1.2 short of a turn the next leg cuts its corner, and the way planned again from there is that turn
        // once more, the drive "there" at once: live round the portal it gave up in the yard)
        const last = legs.length === 1;
        const stopped = await drive(legs[0], 0.5, last ? `across the yard to the hall at ${fmt(legs[0])}` : `across the yard, leg ${++k} to ${fmt(legs[0])}`, true);
        if (stopped) return await giveUp(stopped);
        legs = legs.slice(1);
      }
    }
    const offWall = await throughFrom(entry.inside, 'into the hall');
    if (offWall) return await giveUp(offWall);
    for (const o of t.wall) {
      const why = await digOut(ctx, o.at, o.block);
      if (why) return await giveUp(`the hall's wall did not come out: ${why}`);
    }
    say(ctx, `the hall's panel open at ${fmt(t.wall[0].at)} (${t.wall.length} blocks)`);
    const into = await drive(entry.inside, 0.8, 'into the hall', true);
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

/** What boatIntoHall needs read before the villager is out of its cart (the yard known, its ground, the hall's wall). */
export interface HallWay { yard: NonNullable<WorldMemory['yard']>; ground: Ground; wall: Opened[]; own: Pick<Ground, 'cell'> }

/**
 * The yard's ground and the hall's wall read for boatIntoHall, before anything is done with the villager: the rails
 * home reads them with the villager still seated in its cart on the brake, so a failure here leaves it seated, never
 * loose in the yard. Why not, or the way.
 */
export async function hallWay(ctx: GoalContext, entry: Entry): Promise<HallWay | { why: string }> {
  const yard = ctx.world.yard;
  if (!yard) return { why: 'no yard known' };
  const ground = new Ground(entry.level - MAX_DROP - 3, 16);
  await ground.read(ctx, yard.x1 - 1, yard.z1 - 1, yard.x2 + 1, yard.z2 + 1);
  const wall: Opened[] = entry.wall.map(p => ({ at: p, block: ground.state(p.x, p.y, p.z) ?? '' }));
  const notRead = wall.find(o => !o.block);
  if (notRead) return { why: `the hall's wall not read at ${fmt(notRead.at)}` };
  for (const o of wall) ground.set(o.at.x, o.at.y, o.at.z, 'air');
  return { yard, ground, wall, own: keepOff(ground, ctx.world) };
}

/**
 * A villager standing in the yard taken into the hall by boat (the rails home's last part, railshome.ts: the cart broken
 * on its brake, the fence already shut behind it), as a move's own yard part does: the boat against it (it wanders, so
 * looked at again before each try, a boat that missed taken back up), the bot in front, across the yard to the hall's
 * front stop on the yard's own ground (its builds kept off: keepOff), the hall's wall dug from the boat, into the room,
 * out, the boat broken, the wall put back from inside, out by the hall's gate. A boat that never took the villager
 * leaves it in the shut yard (`loose`); one that took it and stopped on the way leaves it seated in the boat (`boat`:
 * a boat with no one in front goes nowhere), the bot out, never let out loose: the lead's then. Its own steps, not
 * boatHome's: that one's give-ups let a villager out where the boat is, here the yard.
 */
export async function boatIntoHall(ctx: GoalContext, t: { entry: Entry; villager: Seen; now: () => number; way?: HallWay }): Promise<{ ok: true; text: string; count?: number } | { ok: false; why: string; held: 'boat' | 'loose' }> {
  const world = ctx.world;
  const { entry } = t;
  const way = t.way ?? await hallWay(ctx, entry);
  if ('why' in way) return { ok: false, why: way.why, held: 'loose' };
  const { yard, ground, wall, own } = way;
  let e = t.villager;
  let boat: Boat | undefined;
  for (let i = 0; i < PLACE_TRIES && !boat; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    if (e.position) await ctx.call('goto', { ...under(e.position), y: Math.floor(e.position.y), range: 2, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);
    const round = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 24, type: 'villager' }).catch(() => undefined))?.entities ?? [];
    const fresh = round.find(x => x.id === e.id && x.position);
    if (!fresh) return { ok: false, why: `the villager (${e.id}) went out of sight in the yard`, held: 'loose' };
    e = fresh;
    const r = await ctx.call<Placed>('vehicle.place', { item: BOAT_ITEM, for: e.id }, 20_000).catch((x): Placed => ({ ok: false, reason: (x as Error).message }));
    if (!r.ok || r.id === undefined || !r.uuid) { say(ctx, `the boat did not go down in the yard: ${r.reason ?? 'no reply'}`); continue; }
    const placed: Boat = { id: r.id, uuid: r.uuid };
    villagesOf(world).boat = { uuid: r.uuid, at: under(r.position ?? e.position!), since: t.now() };
    if (!r.tookIt) {
      say(ctx, 'the villager was not taken into the boat: the boat back up, again');
      const why = await takeBoat(ctx, placed);
      if (why) return { ok: false, why: `the boat missed the villager and did not come back up: ${why}`, held: 'loose' };
      continue;
    }
    boat = placed;
  }
  if (!boat) return { ok: false, why: `the boat could not be put down against the villager (${e.id}) in the yard`, held: 'loose' };
  const b = boat;
  // stopped on the way: the bot out, the villager left seated in the boat (what was dug of the wall put back, if it goes)
  const seated = async (why: string): Promise<{ ok: false; why: string; held: 'boat' }> => {
    await ctx.call('vehicle.dismount', { toward: { x: entry.inside.x, z: entry.inside.z } }, 15_000).catch(() => undefined);
    await closeUp(ctx, o => t.entry.wall.some(w => w.x === o.at.x && w.y === o.at.y && w.z === o.at.z)).catch(() => undefined);
    return { ok: false, why, held: 'boat' };
  };
  const m = await ctx.call<Reply & { controlling?: boolean }>('vehicle.mount', { id: b.id, uuid: b.uuid }, 15_000).catch((x): Reply & { controlling?: boolean } => ({ ok: false, reason: (x as Error).message }));
  if (!m.ok || !m.controlling) return seated(`could not get into the boat in front: ${m.reason ?? 'not steering'}`);
  const drive = async (to: { x: number; z: number }, within: number, what: string): Promise<string | undefined> => {
    if (ctx.signal.aborted) throw new Error('aborted');
    const p = (await ridingOf(ctx))?.position;
    const ms = Math.max(20_000, Math.round((p ? horiz(p, to) : 0) / BOAT_PACE * 1500) + 10_000);
    const r = await ctx.call<{ ok: boolean; reason?: string; at?: Pos }>('vehicle.drive', { to, within, timeoutMs: ms, maxDrop: MAX_DROP, maxOff: 3 }, ms + 15_000)
      .catch(x => ({ ok: false, reason: (x as Error).message, at: undefined }));
    const kept = villagesOf(world).boat;
    if (kept && r.at && Number.isFinite(r.at.x) && Number.isFinite(r.at.y) && Number.isFinite(r.at.z)) kept.at = under(r.at);
    return r.ok ? undefined : `the drive ${what} stopped: ${r.reason ?? 'no reply'}${r.at ? ` at ${fmt(r.at)}` : ''}`;
  };
  // across the yard to the hall's front stop, leg by leg, the rest planned again where a leg no longer holds
  let again = 0;
  for (let n = 0; ; n++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    if (n > 20) return seated('the way across the yard kept failing');
    const at = (await ridingOf(ctx))?.position;
    if (!at) return seated('no longer in the boat');
    if (horiz(at, entry.front) <= 0.6) break;
    const r = planRoute(own, { x: at.x, z: at.z, level: at.y }, entry.front, { bounds: yardInside(yard), within: 0.5, corners: false });
    if (!r.ok) return seated(`no way across the yard to the hall from ${fmt(at)}: ${r.why}`);
    const stopped = await drive(r.legs[0], 0.5, `across the yard to ${fmt(r.legs[0])}`);
    if (stopped && ++again > 5) return seated(stopped);
    if (r.legs.length === 1 && !stopped) break;
  }
  const at = (await ridingOf(ctx))?.position;
  if (!at) return seated('no longer in the boat');
  const into = checkLeg(ground, { x: at.x, z: at.z, level: at.y }, entry.inside);
  if (!into.ok) return seated(`the boat stopped where its way into the hall does not hold, at ${fmt(at)}: ${into.why} at ${fmt(into.at)}`);
  for (const o of wall) {
    const why = await digOut(ctx, o.at, o.block);
    if (why) return seated(`the hall's wall did not come out: ${why}`);
  }
  say(ctx, `the hall's panel open at ${fmt(wall[0].at)} (${wall.length} blocks)`);
  const inside = await drive(entry.inside, 0.8, 'into the hall');
  if (inside) return seated(inside);
  const deeper = { x: entry.inside.x - entry.dir[0] * 4, z: entry.inside.z - entry.dir[1] * 4 };
  const off = await ctx.call<{ ok: boolean; reason?: string }>('vehicle.dismount', { toward: deeper }, 15_000).catch(x => ({ ok: false, reason: (x as Error).message }));
  if (!off.ok) return seated(`could not get out in the hall: ${off.reason ?? 'no reply'}`);
  await pause(500);
  const took = await takeBoat(ctx, b);
  say(ctx, `the villager (${e.id}) let out in the hall; the panel back`);
  const c = wall[Math.floor(wall.length / 4)].at;
  await ctx.call('goto', { x: c.x - entry.dir[0] * 2, y: c.y, z: c.z - entry.dir[1] * 2, range: 1, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
  const back = await closeUp(ctx, o => wall.some(w => w.at.x === o.at.x && w.at.y === o.at.y && w.at.z === o.at.z));
  if (entry.gate) {
    const g = entry.gate;
    const gside = g.z === entry.hall.z ? [0, -1] : g.z === entry.hall.z + entry.hall.length - 1 ? [0, 1] : g.x === entry.hall.x ? [-1, 0] : [1, 0];
    await ctx.call('goto', { x: g.x + gside[0] * 2, y: g.y, z: g.z + gside[1] * 2, range: 1, careful: true, timeoutMs: 45_000 }, 60_000).catch(() => undefined);
  }
  const count = await countHall(ctx, t.now());
  return {
    ok: true, ...(count !== undefined ? { count } : {}),
    text: `the villager (${e.id}) into the hall${took ? `; the boat left in the hall (${took})` : ''}${back.left.length ? `; could not put back ${back.left.join(', ')}` : ''}`
  };
}

/** Break the bot's own boat back into its item (vehicle.take: an axe, never a sword); why not, or undefined. */
export async function takeBoat(ctx: GoalContext, boat: Boat): Promise<string | undefined> {
  const r = await ctx.call<{ ok: boolean; reason?: string }>('vehicle.take', { id: boat.id, uuid: boat.uuid }, 30_000).catch(x => ({ ok: false, reason: (x as Error).message }));
  if (r.ok) { delete villagesOf(ctx.world).boat; return undefined; }
  return r.reason ?? 'no reply';
}

/**
 * Giving up with the boat out: out of it if the bot sits in it (onto land, the way home if it can), the boat broken
 * back into its item (the villager steps out where it was: left there, unharmed). Says what it left behind, and
 * whether the boat is its item again.
 */
export async function letGo(ctx: GoalContext, boat: Boat | undefined): Promise<{ text: string; taken: boolean }> {
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
    const open = (peekVillages(world).open ?? []).filter(o => !heldByRails(world, o.at)).length;
    // (the post left open for a cart out that is not looked at now: a given-up line's take-up shuts it, or a look a while
    // ago found the cart not at rest on the brake)
    const rails = railsYardOpen(world) && !railsPostWaits(world, s.now);
    if ((!open && !rails) || s.sleeping || s.dimension !== 'overworld' || !roundFrom(s, world, 24)) return null;
    if (open) return `${open} block(s) of the hall or the fence left open by a villager move`;
    const line = peekLine(world);
    return line?.stage === 'moving' && line.cart ? 'the rails home\'s post left open by a move cut short with its cart out'
      : line?.stage === 'taking up' ? 'the rails home\'s yard stretch left down by a line given up' : 'the rails home\'s yard stretch left down by a move that did not go';
  },
  run: async ctx => {
    // (the rails' yard stretch first: its rail stands in the fence's opening, which goes back once it is up)
    const rails = railsYardOpen(ctx.world) && !railsPostWaits(ctx.world, ctx.s.now) ? await closeRailsYard(ctx) : undefined;
    const r = await closeUp(ctx);
    // (the post left open for a cart still out is no failure: looked at again in a while)
    if (rails?.stop && !rails.waits && !rails.taken && !r.put) throw new Error(rails.text);
    if (r.left.length && !r.put && !rails?.taken) throw new Error(`could not put back ${r.left.join(', ')}`);
    return `${rails ? `${rails.text}; ` : ''}put back ${r.put} block(s) a villager move left open${r.left.length ? `; not ${r.left.join(', ')}` : ''}`;
  }
};
