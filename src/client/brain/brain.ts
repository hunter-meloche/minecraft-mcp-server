import fs from 'fs';
import path from 'path';
import { brainRun, type ClientRuntime, type InventoryItem } from '../tools.js';
import { worldIdFromSeed } from '../../build-protection.js';
import { activityAt } from './schedule.js';
import { BrainMemory, findLandmarks, type Pos, type WorldMemory } from './memory.js';
import { tidyGoal } from './tidy.js';
import { treeFarm } from './farming.js';
import { pens } from './pens.js';
import { deepTrip } from './deep.js';
import { caneRound } from './cane.js';
import { enchantGoal } from './enchant.js';
import { anvilGoal } from './anvil.js';
import { brewGoal } from './brewing.js';
import { wartRound } from './wart.js';
import { hallChoresGoal, hallChoresText, hallInSight, noteHall } from './hallchores.js';
import { HeatMap } from './paths.js';
import { signsGoal } from './signs.js';
import { driftGoal, structureGoal } from '../structures/job.js';
import { StructureStore } from '../structures/store.js';
import { compile } from '../structures/format.js';
import { builtColumns, structureSiteBoxes } from '../structures/site.js';
import { LoopWatch, sameResult, type Outcome, type Run } from './loops.js';
import { clock, explainIdle, idleLine, idleNow, idleOverLine, idleReport, tally, tallyRoll, todayLine, type IdleCause } from './idlelog.js';

/**
 * Staying alive: never backed off by the loop watch, and the only goals that cut a trip short out there. Leaving the
 * Nether is one (a trip down there is home by dusk, and whatever stops one leaves the bot there).
 */
export const SURVIVAL: ReadonlySet<string> = new Set(['wake', 'out from under', 'out of a pit', 'break out', 'recover', 'retreat', 'out of the hall', 'shelter', 'food', 'leave nether']);
/**
 * What may cut a critical section of a run short (pockets.ts out.critical: a villager's gate step, the lock, the whole
 * of a chores visit inside the villager hall): flight alone. Not the shelter, not food, not out of the hall: on Nov 24
 * the farm and the pens round cut a chores visit with the bot inside twice in four minutes, and the next goal's plain
 * walk out by the gate is how a villager leaves with it.
 */
export const CRITICAL_CUTS: ReadonlySet<string> = new Set(['retreat', 'out of a pit', 'out from under', 'break out', 'recover']);
/**
 * How long a run that holds a lead (out.ledBy) may go before the brain stops it for its time, whatever the goal's own
 * timeout: the trip's clock ends a lead (8990 with the bell alive, 11800 at the latest: 10 minutes from dawn), DOOR's
 * wait is 90 s and a rescue's walk out a few minutes more. The cap is a net for a lead that never ends, not a clock.
 */
export const LEAD_TIMEOUT_MS = 20 * 60_000;
/**
 * Never the loop watch's to hold: the villager care goal. Its rows that find nothing, and its turns with the chores, are
 * what the watch calls going round, and a goal that shuts the gates a villager would leave by must not be silenced.
 */
export const NO_LOOP_HOLD: ReadonlySet<string> = new Set(['villager care']);
import { breakOut, fromGate, nearHome, onHomeLevel, returnIdle, shelterGoal, wake, type Decline, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import { outFromUnder, outOfPit } from './underyard.js';
import { food, larder, recoverGoal, retreat } from './food.js';
import { farm, furnaceLine, kit, lights, packOres, smelt, sortStorage, stash, stock } from './chores.js';
import { repairGoal } from './repair.js';
import { readBox } from './milestones.js';
import { projectGoal } from './project.js';
import { TREE } from './tree.js';
import { communityStatus, donateGoal, missionGoal } from './community.js';
import { yardGrowGoal, yardGrowStatus } from './yardgrow.js';
import { storageGoal } from './storehouse.js';
import { bedGoal } from './home.js';
import { clearOut, dryBlocked, ladderOf, pick, releaseOldestDry, shareHolds, skippedLine, taskOf, workGoals, workLine, workTick } from './work.js';
import { NEAR_HOME, liveCritical, out as afield } from './pockets.js';
import { statusAnswer } from './chatstatus.js';
import { getOut, wedgedOut } from './wedge.js';
import { penFences, strictGates, strictSet } from './yardgates.js';
import { holdHarmless, unsafeInHand } from './fluidpick.js';
import { NETHER, OVERWORLD, allOwnPortals, leaveNetherGoal, netherLine, netherOf, notePortals, type PortalShape } from './nether.js';
import { netherSparesGoal, regearGoal } from './regear.js';
import { homeSetGoal, netherGearLine } from './netherset.js';
import { oneSpareSet, unreachableLine } from './chests.js';
import { goldGoal } from './netherbarter.js';
import { homeBed } from './villagers.js';
import { closeUpGoal, dryNext, tooFarFor } from './villagemove.js';
import { railsHomeLine } from './railshome.js';
import { VILLAGE_RANGE, lureOn, movesOn, noteBells, noteSeen, peekVillages, villagersLine, villagesOf, type Seen } from './village.js';
import { smithDropsGoal } from './netherite.js';
import { shellsGoal } from './hallshells.js';
import { careNotes, noteLock, outOfHallGoal, villagerCareGoal } from './villagercare.js';
import { UNSUPERVISED, fetchLine, fetchOf, fetchSafe, heldByFetch, peekFetch, tripLive, wardOut, wardSeen, type FetchMemory } from './fetch.js';
import { lockOf } from './villagerwalk.js';

// (the wedge watch's step-out lives in wedge.ts; its tests know it by this file)
export { wedgedOut };

/**
 * The bot's own low-level AI for the client backend, built like a mob's goal selector on a villager's schedule: every
 * few seconds it reads the bot's state, picks the most urgent goal that wants to run, and runs it with the same tool
 * handlers the LLM calls. The game client's Guardian keeps the tick-rate reflexes (fighting, eating, hazards).
 * Any tool call from the LLM that does more than look takes over: the brain drops what it was doing and waits until
 * the LLM has been quiet for a while.
 */

export interface BrainOptions {
  /** brain.json: landmarks per world (default: memory only) */
  memoryFile?: string;
  /** brain.log: one line per decision (default: none) */
  logFile?: string;
  tickMs?: number;
  /** how long an LLM tool call keeps the brain out */
  leaseMs?: number;
  goals?: Goal[];
  now?: () => number;
}

/** A real day (the goals' once-a-day lines go by the UTC day). */
const DAY_MS = 24 * 60 * 60_000;
/** The idle watchdog: standing still by day this long with nothing to do, every hold is let go. */
const IDLE_FIRST = 3 * 60_000;
/** ...and once it has stood this long, the count starts afresh (the next let-go comes IDLE_FIRST after that). */
const IDLE_ROUND = 16 * 60_000;

interface Running {
  goal: Goal; reason: string; started: number; abort: AbortController; done: Promise<void>;
  /** the counted daytime it has used and what it has brought in so far: booked on the idle tally when it ends */
  used: { ms: number; gain: number };
}

/**
 * The hand-over: a run that lasted this long is followed by the next decision at once, not at the next 5 s tick (a
 * twelfth of the daytime went into those waits). A run over sooner did nothing or failed at once: it waits for the
 * ordinary tick, so nothing can go round faster than the tick does. And so does whatever follows a survival goal: the
 * loop watch never holds one of those, so the tick is the only thing between its turns when it goes round with
 * nothing to show (2026-11-08: "done food in 3s: ... now carrying 0 food points", 51 times in a row).
 */
const HAND_OVER_MS = 2000;
/** While a lock stands and the bot is by it, the gate watch looks into the lock this often (villagercare.ts noteLock). */
const LOCK_LOOK_MS = 30_000;
/** An idle streak led by a hold lasts this long before one of the holds is let go early. */
const HOLD_IDLE_MS = 60_000;
/** Idle this long while a rung of the work queue waits on its dry marks (whatever leads the idle time): the oldest mark is let go. */
const DRY_IDLE_MS = 30_000;
/** The holds that may be let go early: a run that got wedged or stuck, ran out of time, or failed (not a loop's, not "until morning"). */
const ORDINARY_HOLD = /^(wedged$|stuck$|timed out$|failed: )/;

/**
 * Whether a box read (discover's: x fastest, then z, then y) saw the whole of the hall's floor: none of its cells
 * inside the box null. A hall outside the box is no part of the read, and counts as seen, as it did.
 */
function hallWhole(world: WorldMemory, box: { x: number; y: number; z: number; width: number; height: number; length: number }, blocks: (string | null)[]): boolean {
  const h = world.zones?.hall?.[0];
  if (!h || !Number.isFinite(h.width) || !Number.isFinite(h.length)) return true;
  const y = h.y + 1 - box.y;
  if (y < 0 || y >= box.height) return true;
  for (let z = Math.max(h.z, box.z); z < Math.min(h.z + h.length!, box.z + box.length); z++) {
    for (let x = Math.max(h.x, box.x); x < Math.min(h.x + h.width!, box.x + box.width); x++) {
      const b = blocks[(x - box.x) + (z - box.z) * box.width + y * box.width * box.length];
      if (b === null || b === undefined) return false;
    }
  }
  return true;
}

/**
 * Whether the same read saw the whole of the lock (its six inside cells, feet and head: `lock:inside`): none of them
 * null. A lock outside the box, or none, counts as seen. With hallWhole it makes a look WHOLE for the wards (idle-plan
 * V 3.2 R-9): only such a look lowers one (a blind look just after a rejoin reads every cell null and sees nobody).
 */
function lockWhole(world: WorldMemory, box: { x: number; y: number; z: number; width: number; height: number; length: number }, blocks: (string | null)[]): boolean {
  for (const c of world.zones?.['lock:inside'] ?? []) {
    for (const y of [c.y, c.y + 1]) {
      const x = c.x - box.x, h = y - box.y, z = c.z - box.z;
      if (x < 0 || h < 0 || z < 0 || x >= box.width || h >= box.height || z >= box.length) continue;
      const b = blocks[x + z * box.width + h * box.width * box.length];
      if (b === null || b === undefined) return false;
    }
  }
  return true;
}

/** The landmarks one look finds that a cell the fetch holds would mislead: a job block lifted for a villager, a lure of the bot's own. */
const HELD_MARKS = ['bed', 'furnace', 'table', 'anvil', 'smithing', 'portal', 'fletching', 'brewing'] as const;

/**
 * The other players about, for the Fetch: line (fetch.ts fetchLine: with one awake the night is not skipped, and a
 * ward left out has a real night ahead, F-6): those the looks saw in the last OTHERS_MS, by where. The bridge names no
 * player in its looks and lists none online: a sighting is the evidence there is.
 */
const OTHERS_MS = 5 * 60_000;
function othersAbout(world: WorldMemory, now: number): string[] {
  return peekVillages(world).players.filter(p => now - p.at >= 0 && now - p.at < OTHERS_MS).sort((a, b) => b.at - a.at).slice(0, 2)
    .map(p => `a player seen at (${p.x}, ${p.z}) ${Math.max(1, Math.round((now - p.at) / 60_000))} min ago`);
}

/** The lure's switches as the villager-moves tool turns them (idle-plan V 5.5). */
export interface FetchSwitches { method?: 'lure' | 'boat'; arm?: number | 'free'; dry?: boolean; halt?: false; bell?: false; forget?: string }

/**
 * The goals in the order they are tried: the most urgent first. Each urgency is asked once: inside the sort it was
 * asked at every comparison, and the stock trip's makes a kit plan each time (a decision over the live homestead took
 * 5.7 ms of the bot's core, 3.4 ms with each asked once)
 */
function inOrder(s: Snapshot, world: WorldMemory, goals: Goal[]): Goal[] {
  const p = new Map(goals.map(g => [g, g.urgency?.(s, world) ?? g.priority] as const));
  return [...goals].sort((a, b) => p.get(b)! - p.get(a)!);
}

/** The most urgent goal that wants to run (and isn't waiting out a failure), with its reason. */
export function decide(s: Snapshot, world: WorldMemory, goals: Goal[], retryAt: Map<string, number>): { goal: Goal; reason: string } | undefined {
  for (const goal of inOrder(s, world, goals)) {
    if ((retryAt.get(goal.name) ?? 0) > s.now || (s.sleeping && !goal.whileAsleep)) continue;
    const reason = goal.wants(s, world);
    if (reason) return { goal, reason };
  }
  return undefined;
}

export class Brain {
  enabled = false;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  /** a tick was asked for while one was under way: it follows that one, once */
  private again = false;
  /** the tick that follows at once (after a run's end, or one asked for mid-tick): at most one waits at a time */
  private chained?: ReturnType<typeof setTimeout>;
  private running?: Running;
  private leaseUntil = 0;
  private leaseTool = '';
  private retryAt = new Map<string, number>();
  /**
   * The loop watch's back-offs (goal -> until): the morning and the idle watchdog let every hold go, and that undid
   * them (2026-11-09: the enchanting room and the stash took turns 51 times in an hour, the "morning: project may try
   * again" 3.5 min after the LOOP, which wasn't reported again for half an hour); they run their 10 minutes.
   */
  private loopHold = new Map<string, number>();
  /**
   * Why each held goal is held (`wedged`, `stuck`, `timed out`, `failed: ...`, `3 failures: until morning`,
   * `loop: ...`), set and let go together with retryAt: the idle log and brain-status name what is in the way, not
   * only that something is. `loopWhy`: the loop watch's own, put back with its holds.
   */
  private holdWhy = new Map<string, string>();
  private loopWhy = new Map<string, string>();
  private log: string[] = [];
  private memory: BrainMemory;
  private goals: Goal[];
  private last?: Snapshot;
  /** the running goal's latest step, and the status line the game client shows */
  private step?: string;
  private shown?: string;
  /** consecutive failures per goal */
  private fails = new Map<string, number>();
  /** where the bot has stood still since when, while a Baritone process runs (the stuck watchdog) */
  private stillAt = '';
  private stillSince = 0;
  /** the stand-still (its stillSince) the wedge check has looked at already */
  private wedgeLooked = -1;
  /** the stand-still (its stillSince) the watch has said it leaves to a villager's lead (said once) */
  private ledStillSaid = -1;
  /** goals left "until the morning": let go when the game's morning comes (sleeping brings it at once) */
  private morningHold = new Set<string>();
  /** the idle watchdog: where the bot has stood by day since when, and how far it has escalated */
  private idleAt?: { x: number; z: number };
  private idleSince = 0;
  private idleStage = 0;
  /** when the walk home with nothing to do last ended by itself: the next look still belongs to it (idleTrack) */
  private walkedHomeAt?: number;
  /** the game clock at the last look: a new day has come when it wraps */
  private tod = 0;
  /** the idle tally's clock: when daytime was last booked (markTime) */
  private lastMark?: number;
  /** the idle streak under way (counted daytime with nothing running): how long, under which lead causes, and its last log line */
  private streak?: { ms: number; by: Partial<Record<IdleCause, number>>; lineAt?: number; lead?: IdleCause };
  /** when an idle tick last saved the tally */
  private idleSaved?: number;
  /** how long the idle streak has been led by a hold, since it began or since a hold was last let go early */
  private holdIdle = 0;
  /** the same for idle time while any rung of the work queue declines `dry` (its marks) */
  private dryIdle = 0;
  /**
   * the goals let go early: not a second time until a hold on them has run its full time (or the morning, or the idle
   * watchdog, unless that goal is backed off or failing the same way over and over: letGoAll)
   */
  private freedEarly = new Set<string>();
  /**
   * each goal's failures in a row with the same result (its text, numbers aside, as the loop watch reads them): a
   * goal that failed so twice is not let go early (releaseHold), and the let-go of every hold leaves its early
   * release's mark on it (letGoAll). A run that ends well ends the row; nothing else does, the morning and the idle
   * watchdog included (live on Nov 14 the watchdog's let-go undid the early release's mark, the next early release
   * freed the stash again, and it failed "nothing could be put away" four times in 246 s: a LOOP)
   */
  private sameFails = new Map<string, { result: string; n: number }>();
  /** what has gone wrong in the measuring and been noted (each kind once) */
  private mishaps = new Set<string>();
  /** each goal's `daily` line, by the (UTC) day it was last said: in this process only, so a restart says it again */
  private saidOn = new Map<string, number>();
  private worldId?: string;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly leaseMs: number;

  constructor(private rt: ClientRuntime, private opts: BrainOptions = {}) {
    this.memory = new BrainMemory(opts.memoryFile);
    const structures = this.structures;
    this.goals = opts.goals ?? [wake, outFromUnder, outOfPit, breakOut, recoverGoal(() => rt.lastDeath()), smithDropsGoal, leaveNetherGoal(), retreat, outOfHallGoal, shelterGoal(), food, villagerCareGoal, homeSetGoal, regearGoal, kit, closeUpGoal, stash, storageGoal, goldGoal, smelt, larder, farm, structureGoal(structures, b => rt.protectBuilt(b), (c, r) => rt.builtNear(c, r)), missionGoal, bedGoal, yardGrowGoal, stock, deepTrip, repairGoal(rt), tidyGoal(rt), treeFarm, pens, caneRound, wartRound, enchantGoal, anvilGoal, brewGoal, this.withHolds(shellsGoal), hallChoresGoal, netherSparesGoal, lights, donateGoal, sortStorage, packOres, signsGoal, driftGoal(structures), projectGoal(TREE), ...workGoals(() => rt.lastDeath(), undefined, () => this.now()), returnIdle];
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 5000;
    this.leaseMs = opts.leaseMs ?? 10 * 60_000;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.leaseUntil = 0; // handed back on purpose: no waiting out the LLM's quiet time
    // the idle tally counts the autopilot's daytime only: its clock starts afresh, and no idle streak spans the time off
    if (on) this.lastMark = undefined;
    this.note(on ? 'autonomy on' : 'autonomy off');
    if (!on) this.measure('time', () => this.endStreak()); // after its cause in the log, as when a goal starts
    void this.show();
    if (on && !this.timer) {
      this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
      this.timer.unref?.();
    }
    if (!on) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      // and no tick waiting to follow: a brain that is off looks at nothing
      if (this.chained) clearTimeout(this.chained);
      this.chained = undefined;
      this.again = false;
      void this.stopRunning('autonomy turned off');
    }
  }

  /**
   * A tick right now, not on the 5 s beat: after a run's end (the hand-over) or when one was asked for while another
   * was under way. Only one waits at a time, none for a brain that is off, and like the interval it does not keep the
   * process alive.
   */
  private soon(): void {
    if (!this.enabled || this.chained) return;
    this.chained = setTimeout(() => {
      this.chained = undefined;
      void this.tick();
    }, 0);
    this.chained.unref?.();
  }

  setLeash(blocks: number): void {
    if (!this.worldId) throw new Error('not in a world yet');
    this.memory.world(this.worldId).leash = blocks;
    this.memory.save();
  }

  /**
   * The nether-trips switch (the nether-trips tool): anything that goes through a portal waits for it. Said in the log
   * with who turned it (`nether trips on (by the lead)`), and saved at once.
   */
  setNetherTrips(on: boolean, by: string): void {
    if (!this.worldId) throw new Error('not in a world yet');
    netherOf(this.memory.world(this.worldId)).trips = on;
    this.note(`nether trips ${on ? 'on' : 'off'} (by ${by})`);
    this.memory.save();
  }

  /**
   * The fortress trips' own switch (the nether-trips tool's `fortress`): off after a death on one (nether.ts netherTick)
   * until the lead turns it back on; off by hand too. Said in the log with who turned it, and saved at once.
   */
  setFortressTrips(on: boolean, by: string): void {
    if (!this.worldId) throw new Error('not in a world yet');
    const n = netherOf(this.memory.world(this.worldId));
    if (on) { if (n.fortress) delete n.fortress.off; }
    else (n.fortress ??= {}).off = { at: this.now(), why: `switched off by ${by}` };
    this.note(`nether fortress trips ${on ? 'on' : 'off'} (by ${by})`);
    this.memory.save();
  }

  /**
   * The bastion trips' own switch (the nether-trips tool's `bastion`, P6): off after a death on one (nether.ts
   * netherTick) until the lead turns it back on; off by hand too. Said in the log with who turned it, and saved at once.
   */
  setBastionTrips(on: boolean, by: string): void {
    if (!this.worldId) throw new Error('not in a world yet');
    const n = netherOf(this.memory.world(this.worldId));
    if (on) { if (n.bastion) delete n.bastion.off; }
    else (n.bastion ??= {}).off = { at: this.now(), why: `switched off by ${by}` };
    this.note(`nether bastion trips ${on ? 'on' : 'off'} (by ${by})`);
    this.memory.save();
  }

  /**
   * The villager-moves switch (the villager-moves tool): the villagers rung moves a villager home only while it is on.
   * Said in the log with who turned it (`villager moves on (by the lead)`), and saved at once.
   */
  setVillagerMoves(on: boolean, by: string): void {
    if (!this.worldId) throw new Error('not in a world yet');
    this.memory.world(this.worldId).villagerMoves = on;
    this.note(`villager moves ${on ? 'on' : 'off'} (by ${by})`);
    this.memory.save();
  }

  /**
   * The rails switch (the villager-moves tool's `rails`): a rails home the boat move needs is laid only while it is on
   * (and the moves on). Off with a line under way gives the line up: it is taken back up. Said and saved at once.
   */
  setRailsHome(on: boolean, by: string): void {
    if (!this.worldId) throw new Error('not in a world yet');
    this.memory.world(this.worldId).railsHome = on;
    this.note(`rails home ${on ? 'on' : 'off'} (by ${by})`);
    this.memory.save();
  }

  /**
   * The lure's switches (the villager-moves tool, idle-plan V 5.5), every one the lead's: `method` ('lure': the
   * job-site lure; 'boat': the move as before), `arm` (how many trips, brings and rescues, may still begin: 'free' is
   * refused until S1.5 is in), `dry` (every trip plans, logs and dumps and places nothing: the trip prepared now and
   * the ones after, until turned off), `halt: false` (the halt cleared: new trips may begin again), `bell: false` (the
   * wards' village bells no longer bind them: the lead knows them long away), `forget` (a ward let go of: its key or
   * uuid, or 8 or more of its first characters). Checked whole before anything is written: a refusal throws and changes
   * nothing. The method is not changed under a villager being led, nor is the led ward forgotten. Each change is said
   * in the log with who made it, and saved at once. Returns what was done, a line each.
   */
  setFetch(o: FetchSwitches, by: string): string[] {
    if (!this.worldId) throw new Error('not in a world yet');
    const world = this.memory.world(this.worldId), now = this.now(), seen = peekFetch(world);
    if (o.arm === 'free' && !UNSUPERVISED) throw new Error('arm "free" waits for S1.5 (the computed yard and the unattended morning after): every trip is supervised until then; arm a number (arm: 1)');
    if (typeof o.arm === 'number' && (!Number.isInteger(o.arm) || o.arm < 0)) throw new Error(`arm ${o.arm}: a whole number of trips, 0 or more`);
    const live = tripLive(world, now);
    if (o.method && o.method !== (seen.method ?? 'boat') && live) throw new Error(`a villager is being led (trip ${seen.trip?.id}): the method stays while it is (villager-moves {enabled:false} lets the trip release it or finish)`);
    // the dry switch stays as it is once a trip is prepared or under way (S1 review N7): dry on mid-lead counted the
    // bot's job sites as lifted and the way stopped keeping off them; dry off mid-way set a dry trip out real with no
    // lifts made. Before PREP's lifts, or once the trip is restoring, it may change
    const t = seen.trip;
    if (o.dry !== undefined && t && t.state !== 'restore' && (t.state !== 'prep' || !!t.prepared) && !!o.dry !== !!t.dry) throw new Error(`trip ${t.id} is ${t.state === 'prep' ? 'prepared' : t.state}${t.dry ? ' dry' : ''}: the dry switch stays as it is until the trip is over (villager-moves {enabled:false} puts a prepared trip back)`);
    let forget: FetchMemory['wards'][number] | undefined;
    if (o.forget !== undefined) {
      const k = o.forget.trim(), hits = seen.wards.filter(w => w.key === k || w.uuid === k || (k.length >= 8 && (w.key.startsWith(k) || w.uuid?.startsWith(k))));
      if (!hits.length) throw new Error(`no ward ${k} on the records${seen.wards.length ? ` (the wards: ${seen.wards.map(w => w.key).join(', ')})` : ''}`);
      if (hits.length > 1) throw new Error(`${k} names ${hits.length} wards: give more of its key`);
      forget = hits[0];
      if (live && seen.trip?.ward === forget.key) throw new Error(`ward ${forget.key} is being led (trip ${seen.trip.id}): it is not let go of mid-way`);
    }
    const f = fetchOf(world), said: string[] = [];
    if (o.method && o.method !== (f.method ?? 'boat')) { f.method = o.method; said.push(`method ${o.method}${o.method === 'lure' ? ' (the job-site lure; the rails home retired)' : ' (the boat\'s move as before)'}`); }
    if (o.arm !== undefined) {
      if (o.arm === 0) delete f.armed; else f.armed = o.arm;
      said.push(o.arm === 0 ? 'not armed: no trip begins' : `armed ${o.arm}: ${o.arm} trip(s) may begin`);
    }
    if (o.dry !== undefined) {
      // (the switch beside the record: the trip prepared now is made dry too, and every one after until it is turned off)
      const raw = f as FetchMemory & { dry?: true };
      if (o.dry) raw.dry = true; else delete raw.dry;
      if (f.trip && f.trip.state !== 'restore') { if (o.dry) f.trip.dry = true; else delete f.trip.dry; }
      said.push(o.dry ? `dry: trips plan, log and dump, and place nothing${f.trip ? ` (trip ${f.trip.id} too)` : ''}` : 'not dry: the next trip is a real one');
    }
    if (o.halt === false) {
      said.push(f.halt ? `the halt cleared (it was: ${f.halt.why})` : 'no halt to clear');
      delete f.halt;
    }
    if (o.bell === false) {
      const bound = f.wards.filter(w => w.bell);
      for (const w of bound) w.bell = false;
      said.push(bound.length ? `the bell cleared for ${bound.map(w => `ward ${w.key.slice(0, 8)}`).join(', ')}: it is led by the light of day, not by 8700` : 'no ward bound by a bell');
    }
    if (forget) {
      const key = forget.key;
      f.wards = f.wards.filter(w => w.key !== key);
      said.push(`ward ${key.slice(0, 8)} let go of (it was ${forget.where}, last at (${Math.floor(forget.last.at.x)}, ${Math.floor(forget.last.at.y)}, ${Math.floor(forget.last.at.z)}))`);
    }
    for (const line of said) this.note(`villagers: ${line} (by ${by})`);
    this.memory.save();
    return said;
  }

  /**
   * The LLM ran a tool: step back now and stay out until it has been quiet for a while. Not while a villager is being
   * led or a run is in a step only flight may cut short (a gate held for a villager, the whole of a chores visit
   * inside the villager hall): the tool is refused with why, since stopping the run there leaves a gate open by a
   * villager or the bot inside the hall. set-autonomy {enabled:false} takes the bot over all the same (the run's exit
   * handler runs first: the gate is shut).
   */
  async manual(tool: string): Promise<void> {
    const busy = this.busyWhy();
    if (busy) throw new Error(`Not now (${tool}): ${busy}, and only flight cuts that short. set-autonomy {enabled:false} takes the bot over (the run's exit handler runs first), or ask again in a few minutes`);
    this.leaseUntil = this.now() + this.leaseMs;
    this.leaseTool = tool;
    void this.show();
    if (this.running) await this.stopRunning(`the LLM took over (${tool})`);
  }

  /** Why the bot may not be taken over now (fetch.ts fetchSafe without the place: a villager led, a critical section), or undefined. */
  private busyWhy(): string | undefined {
    const now = this.now(), critical = liveCritical(now);
    const world = this.worldId ? this.memory.world(this.worldId) : undefined;
    if (!world) return critical ? 'a run is in a step only flight may cut short' : undefined;
    const r = fetchSafe(world, undefined, now, critical);
    return r.safe ? undefined : r.why;
  }

  /**
   * Whether a restart (or a take-over) is safe now, for the fetch-safe tool and scripts/safe-restart.sh: not while a
   * villager is being led, nor in a critical section, nor with the bot in the villager hall or its lock (`at`: where
   * it stands, in the overworld only; else the last look's).
   */
  safeNow(at?: { x: number; y: number; z: number }, dimension?: string): { safe: boolean; why?: string } {
    const world = this.worldId ? this.memory.world(this.worldId) : undefined;
    const now = this.now();
    if (!world) return liveCritical(now) ? { safe: false, why: 'a run is in a step only flight may cut short' } : { safe: true };
    const s = this.last;
    const where = (dimension ?? s?.dimension) === OVERWORLD ? at ?? s?.position : undefined;
    return fetchSafe(world, where, now, liveCritical(now));
  }

  /**
   * The autopilot off, and the running goal stopped and waited for, 5 s at most (its exit handler: a held gate released
   * shut, a lure anchored): set-autonomy {enabled:false} answers only then, so the LLM's next acting call never runs
   * beside the handler (idle-plan V 6.2, D24: the takeover comes with the exit handler first). The goal it stopped, if any.
   */
  async turnOff(): Promise<string | undefined> {
    const r = this.running;
    this.setEnabled(false);
    if (r) await Promise.race([r.done, new Promise(res => setTimeout(res, 5000))]);
    return r?.goal.name;
  }

  /**
   * For a restart (fetch-safe {stop}, the harness's /stop): the autopilot off in this process, the running goal
   * stopped and waited for (turnOff), and brain.json saved. The goal it stopped, if any.
   */
  async stopForRestart(): Promise<string | undefined> {
    const was = await this.turnOff();
    this.memory.save();
    return was;
  }

  /** One look and decision; the timer calls it, tests call it directly. */
  async tick(): Promise<void> {
    if (!this.enabled) return;
    // asked for while one is under way (the interval's, or the one a run's end asks for): it follows this one, so it
    // is never lost; and however many ask, one follows, so it is never doubled
    if (this.ticking) { this.again = true; return; }
    this.ticking = true;
    this.again = false; // this one looks for all that asked before it began
    // what this tick saw, for the idle tally: stays unset when the tick was skipped (the LLM's, no world to look at)
    let seen: Snapshot | undefined;
    try {
      if (this.now() < this.leaseUntil) return;
      const s = await this.sense();
      if (!s || !this.worldId) return;
      seen = s;
      const world = this.memory.world(this.worldId);
      world.id = this.worldId;
      if (this.attached !== this.worldId) this.attach(world);
      // the spare set's record as one set (chests.ts oneSpareSet): two were stored on Nov 15, the second is plain stock
      const loose = oneSpareSet(world);
      if (loose.length) this.note(`spare set: one set kept, ${loose.length} pieces of a second let go as plain stock (${loose.map(p => `${p.name} in slot ${p.slot} of (${p.chest.x}, ${p.chest.y}, ${p.chest.z})`).join(', ')})`);
      await this.discover(s, world);
      this.countDay(s);
      this.walked(s, world);
      // the home zone is the yard as it grows (its rectangle; the game client keeps a margin round it), with the pens'
      // fence rings: Baritone's paths place nothing by those either (the client mod's band, Protection.java)
      if (world.yard && s.home) {
        const y = world.yard;
        this.rt.setHomeZone?.({ x1: y.x1, z1: y.z1, x2: y.x2, z2: y.z2 }, penFences(world).map(({ x1, z1, x2, z2 }) => ({ x1, z1, x2, z2 })));
      }
      // its own portals (the home one, and its Nether side once it has one), which the protection sync sends the
      // bridge whenever they change or the bridge has none (nothing then counts them as anyone's build)
      this.measure('portals', () => this.rt.setOwnPortals?.(allOwnPortals(world)));
      await this.seePortals(s, world);
      await this.seeVillages(s, world);
      await this.gateWatch(s, world).catch((e: unknown) => {
        if (this.mishaps.has('gates')) return;
        this.mishaps.add('gates');
        this.note(`gate watch failed (noted once): ${String((e as Error)?.message ?? e)}`);
      });
      this.idleTrack(s);
      this.workQueue(s, world);
      this.measure('daily', () => this.dailyLines(s, world));
      // seated in a boat (or a minecart) with no run to steer it: out of it before anything else starts
      if (!this.running && s.riding) { await this.outOfVehicle(s, world); return; }
      const r = this.running;
      if (r) {
        // stuck: a Baritone job that hasn't moved the bot a block in 3 minutes (pathing round in circles, wedged)
        const here = `${Math.floor(s.position.x)},${Math.floor(s.position.y)},${Math.floor(s.position.z)}`;
        if (here !== this.stillAt || !s.process) { this.stillAt = here; this.stillSince = this.now(); }
        // a run leading a villager for the fetch (its trip live, or its own section at a yard gate or the lock): neither
        // the wedge stop nor the stuck stop cuts it. Stopped there, its exit handler released the gate with the bot in
        // the gateway, and the step-out dug a post beside G with the ward outside, "left for the repair round" (S1
        // safety N10, S1 follow-up R6). Its own clock, its guards and its section are its net; said once a stand-still.
        // Not by out.ledBy: the pens round leads an animal with it, and that walk is stepped out of as ever
        const crit = afield.critical;
        const fetchLed = (tripLive(world, this.now()) && !SURVIVAL.has(r.goal.name))
          || (!!crit && crit.by === r.abort.signal && this.now() < crit.until && (crit.why === 'gate' || crit.why === 'lock'));
        if (fetchLed && s.process && this.now() - this.stillSince > 30_000) {
          if (this.ledStillSaid !== this.stillSince) {
            this.ledStillSaid = this.stillSince;
            this.note(`${r.goal.name} has not moved a block for ${Math.round((this.now() - this.stillSince) / 1000)}s at ${here}, leading a villager: not stopped (the lead's own clock and guards end it)`);
          }
        }
        // half a minute without a block's movement: wedged against a fence? step out by hand (Baritone never will).
        // A walk with an animal on its lead too: it never waits in or by a gateway (pens.ts standsClear), so one
        // standing in a gate this long is wedged, and only the brain gets it out (live, Nov 13: wedged in the north gate)
        if (!fetchLed && s.process && this.now() - this.stillSince > 30_000 && this.wedgeLooked !== this.stillSince) {
          this.wedgeLooked = this.stillSince;
          const box = { x: Math.floor(s.position.x) - 1, y: Math.floor(s.position.y), z: Math.floor(s.position.z) - 1, width: 3, height: 2, length: 3 };
          const { blocks } = await this.rt.call<{ blocks: (string | null)[] }>('world.region', box).catch(() => ({ blocks: [] as (string | null)[] }));
          const out = wedgedOut(s.position, blocks ?? []);
          if (out) {
            await this.stopRunning(`${r.goal.name} is wedged in the ${out.block} at ${here}: stepping out`);
            // a step to the open cell on the bot's side of it, twice; then one of its own fences is dug out, stepped
            // out of and put back (live, Nov 13: 1 h 45 min in the cow pen's corner post, every step-out into the post).
            // Up to 20 s with no run to stop: it asks before each dig, step and put-back whether the bot is still the
            // autopilot's (the LLM's tool, or autonomy off, would otherwise run beside it)
            // and nothing dug while a villager is out (fetch.ts wardOut): a post of the yard's ring, a gate, a block of
            // the lock or the portal's ring dug and not put back is a gap a villager walks out by. The steps are made;
            // a wedge they do not free is said and left (S1 follow-up R6)
            const held = wardOut(world, this.now());
            let digHeld = false;
            const mayGo = () => {
              if (!this.enabled || this.now() < this.leaseUntil) return false;
              if (held) { digHeld = true; return false; }
              return true;
            };
            const got = await getOut(this.rt, world, s.position, blocks ?? [], mayGo).catch(() => undefined);
            const line = digHeld && got?.line ? got.line.replace(/; left to the one who took over$/, '; not dug: a villager is out (no post, gate or block of the lock is dug then)') : got?.line;
            if (line) this.note(line);
            this.holdFor(r.goal.name, this.now() + 5000, 'wedged');
            return;
          }
        }
        if (!fetchLed && s.process && this.now() - this.stillSince > 3 * 60_000) {
          this.stillSince = this.now();
          await this.stopRunning(`${r.goal.name} looks stuck (no movement for 3 min at ${here})`);
          this.holdFor(r.goal.name, this.now() + 3 * 60_000, 'stuck');
          return;
        }
        // (a run that leads a villager, out.ledBy its own with a trip live or inside its own section at a yard gate or
        // the lock (fetchLed; or the trip live by now, after the wedge's read), is cut by no clock of the brain's but at
        // LEAD_TIMEOUT_MS: a lead runs by the trip's own clock, to 8990 or 11800, and care's 10 minutes would cut a
        // resume or a rescue anywhere, a gate held open included; 6.2: only survival cuts a lead. The section counts as
        // the beat does: gateIn's and lockIn's walks, waits and reads before their poll loops can outlast the beat's
        // 90 s, and a run past its own timeout was cut there, G released shut on the ward in the gateway (S1 follow-up
        // Y-1). Not the pens round's lead of an animal, which holds out.ledBy too but never a 'gate' or 'lock' section:
        // its own 8 minutes, as ever)
        const leads = afield.ledBy === r.abort.signal && !r.abort.signal.aborted && (fetchLed || tripLive(world, this.now()));
        if (this.now() - r.started > (leads ? Math.max(r.goal.timeoutMs, LEAD_TIMEOUT_MS) : r.goal.timeoutMs)) {
          await this.stopRunning(`${r.goal.name} ran out of time`);
          this.holdFor(r.goal.name, this.now() + r.goal.retryMs, 'timed out');
          return;
        }
        if (r.goal.interruptible === false) return;
        const p = (g: Goal) => g.urgency?.(s, world) ?? g.priority;
        // a goal can say its want is not worth stopping this one for (the stash with room still to spare): it is left
        // out here, and takes over when this one ends. Survival is never asked, and a goal that cannot say cuts in
        const cuts = (g: Goal) => { try { return g.cuts?.(s, world) ?? true; } catch { return true; } };
        // one rule for a trip of the work queue that is out beyond the chores' reach of home: only survival cuts it
        // short, and the kit when the bot has no pickaxe left to work with. Anything else (the stash, smelting, the
        // stock, the kit's other wants) can wait for it to come home: each cost a trip its walk out, and the trip
        // makes its own room. Nearer home, and for every other run, the goals say themselves what is worth a stop.
        // (The kit goal itself wants only within reach of home, so out here the trip ends itself: a trip down with
        // no pickaxe left comes up, deep.ts oreTrip, and the kit sees to one at home.) Down the mine under the yard's
        // edge is out here too, however near home across the ground: smelt cut three deep trips there on Nov 12
        const tripOut = afield.trip && !!taskOf(r.goal) && !nearHome(s, NEAR_HOME);
        // and wherever it is, a run walking an animal home (on a lead, or after its food: the cows rung, the pens
        // round's stray): it would be let go where the run stopped. Only this run's own word counts (its signal)
        const leading = !!afield.ledBy && afield.ledBy === r.abort.signal;
        // and a run in a critical section of its own (a villager's gate step, the lock, the whole of a chores visit
        // inside the hall: pockets.ts out.critical): only flight cuts it, whatever else would (idle-plan V 6.2)
        const c = afield.critical;
        const critical = !!c && c.by === r.abort.signal && this.now() < c.until;
        const may = (g: Goal) => critical ? CRITICAL_CUTS.has(g.name) : SURVIVAL.has(g.name) || (!leading && (tripOut ? g.name === kit.name && !s.items.some(i => i.name.endsWith('_pickaxe')) : cuts(g)));
        const next = decide(s, world, this.goals.filter(g => p(g) > p(r.goal) && may(g)), this.retryAt);
        if (next) await this.stopRunning(`${next.goal.name} is more urgent (${next.reason})`);
        return;
      }
      this.idleWatch(s);
      const choice = decide(s, world, this.goals, this.retryAt);
      if (choice) this.start(choice.goal, choice.reason, s, world);
    } catch (e) {
      this.note(`tick failed: ${(e as Error).message}`);
    } finally {
      // after the decision: a tick that started something books no idle time
      this.measure('time', () => this.markTime(seen));
      this.ticking = false;
      await this.show();
      if (this.again) { this.again = false; this.soon(); }
    }
  }

  /**
   * Where the bot has stood with nothing to do, for the idle watchdog: moving 3 blocks (or night, or no home) starts
   * the count again, and so does a goal at work, however still the bot stands for it (2026-11-10: "stash looks stuck
   * (no movement for 3 min)", and at the next look "idle 3 min by day: let go of stash 175s": the 3 minutes it had
   * stood stuck were counted as idle, so the hold was undone as soon as it was set). Not the walk home with nothing to
   * do: that is idle time like the standing about before and after it, and each walk started the watchdog's 3 minutes
   * afresh. While it runs, and at the first look after it ended by itself (the bot has walked on since the last one),
   * the bot's place is taken as it is and the count goes on.
   */
  private idleTrack(s: Snapshot): void {
    const here = { x: s.position.x, z: s.position.z };
    const run = this.running?.goal;
    const walkHome = run?.name === returnIdle.name || (this.walkedHomeAt !== undefined && this.now() - this.walkedHomeAt <= 15_000);
    this.walkedHomeAt = undefined;
    const atWork = !!run && run.name !== returnIdle.name;
    const moved = !this.idleAt || Math.hypot(here.x - this.idleAt.x, here.z - this.idleAt.z) > 3;
    if (atWork || (moved && !(walkHome && this.idleAt)) || s.activity !== 'work' || s.sleeping || !s.home) {
      this.idleAt = here;
      this.idleSince = this.now();
      this.idleStage = 0;
    } else if (walkHome) this.idleAt = here;
  }

  /**
   * By day with nothing running, standing still: after IDLE_FIRST every hold is let go (backoffs, a goal left until
   * the morning) so whatever was waiting tries again, and after IDLE_ROUND of it the count starts afresh. It starts
   * nothing itself. (At 6 min it used to forage: the stock trip without the stock goal's own conditions, or a cow
   * fetched for the pen. It started 47 times from the step-3 build to Nov 12, and of the dozen cows it went for none
   * came in. The cows rung and the stock goal do both now, with their own waits; a hungry bot is the food goal's,
   * which wants by day whenever it carries under 20 food points, and goes for food the same way.)
   */
  private idleWatch(s: Snapshot): void {
    if (s.activity !== 'work' || s.sleeping || !s.home) return;
    const idle = this.now() - this.idleSince;
    const mins = Math.round(idle / 60_000);
    if (this.idleStage === 0 && idle >= IDLE_FIRST) {
      this.idleStage = 1;
      const held = [...this.retryAt].filter(([g, t]) => t > this.now() && !this.looping(g)).map(([g, t]) => `${g} ${Math.round((t - this.now()) / 1000)}s`);
      // the marks of what was looked for and not found (`fruitless:*`) stay, the stock trips' as spare time's did
      // (retired in anti-idle step 6): letting them go only sent the bot straight back to where there was nothing
      // (2026-11-08: "spare time: 0 iron ... Unable to find any path" every 3.5 min for an hour; 2026-11-10: "let
      // go of fruitless:sugar_cane" every 10 to 20 min all day, each one more fruitless cane walk); they lapse by
      // themselves
      this.letGoAll();
      this.note(`idle ${mins} min by day: let go of ${held.join(', ') || 'nothing (nothing was held)'}`);
      return;
    }
    // (the same 16-minute round as when it foraged in between: a hold is let go once in that long, no more often)
    if (this.idleStage === 1 && idle >= IDLE_ROUND) {
      this.idleStage = 0;
      this.idleSince = this.now();
    }
  }

  status(): string {
    const lines: string[] = [];
    const world = this.worldId ? this.memory.world(this.worldId) : undefined;
    lines.push(`Autonomy ${this.enabled ? 'on' : 'off'}${world ? ` (leash ${world.leash} blocks)` : ''}.`);
    // (said first, where the maintenance run looks: a restart now stops the client with a gate held for a villager)
    const led = world && tripLive(world, this.now()) ? peekFetch(world).trip : undefined;
    if (led) lines.push(`A villager is being led (trip ${led.id}, ${led.hop ? `hop ${led.hop.n}` : led.state}): do not restart (scripts/safe-restart.sh waits for it).`);
    const lease = this.leaseUntil - this.now();
    if (lease > 0) lines.push(`Paused for the LLM for ${(lease / 60_000).toFixed(1)} more min (last tool: ${this.leaseTool}).`);
    const s = this.last;
    // what is in the way right now, as the idle log books it: the held goals, and why nothing runs. By day, awake,
    // with the autopilot in charge, "nothing to do" has a reason: the one the idle time is booked under
    let why: Decline[] = [];
    let idle: string | undefined;
    this.measure('status', () => {
      if (!s || !world) return;
      why = explainIdle({ ...s, now: this.now() }, world, this.goals, this.retryAt, this.holdWhy);
      if (this.enabled && lease <= 0 && s.activity === 'work' && !s.sleeping && s.home) idle = idleNow(why);
    });
    if (s) {
      lines.push(`Activity: ${s.activity} (time of day ${s.timeOfDay}${s.sleeping ? ', asleep' : ''}). Health ${s.health}, food ${s.food}, ${s.slotsUsed}/36 slots used.`);
      // (and how far below or above it: "16 blocks away" from a cave 55 under the yard read as home)
      const level = s.home && !onHomeLevel(s.position, s.home) ? Math.round(s.position.y - s.home.y) : 0;
      const off = level < 0 ? `, ${-level} below it` : level > 0 ? `, ${level} above it` : '';
      lines.push(s.home ? `Home (${s.home.x}, ${s.home.y}, ${s.home.z}), ${Number.isFinite(s.distHome) ? Math.round(s.distHome) + ' blocks away' + off : 'in another dimension'}.` : 'No home set (set-home).');
      // others' builds (a friend's base, a village): what it keeps its hands off
      if (s.foreign?.zones) {
        const surface = s.foreign.surface ?? s.foreign.zones, under = s.foreign.zones - surface;
        const near = s.foreign.nearest === null ? '' : ` (the nearest ${Math.round(s.foreign.nearest)} blocks away)`;
        lines.push(`Others' builds seen: ${surface} on the surface${near}${under ? `, ${under} under ground (mineshafts, dungeons: their blocks stay, the rock round them is mined)` : ''}. It breaks nothing in a build, and leaves their animals and chests alone.`);
      }
    }
    if (this.running) lines.push(`Now: ${this.running.goal.name} (${this.running.reason}) for ${Math.round((this.now() - this.running.started) / 1000)}s.`);
    else lines.push(idle ?? 'Now: nothing to do.');
    if (world) {
      const l = world.landmarks;
      const p = (q?: { x: number; y: number; z: number }) => (q ? `(${q.x}, ${q.y}, ${q.z})` : 'none');
      // (and what it cooks, as the smelt left it: it loads the furnace and goes)
      lines.push(`Landmarks: bed ${p(l.bed)}, chests ${l.chests.length}, furnace ${p(l.furnace)}${furnaceLine(world, this.now())}, table ${p(l.table)}, farmland ${l.farmland.length}.`);
      // (a chest the stores and takes could not get to, left out for a while: which, since when)
      const far = unreachableLine(world, this.now());
      if (far) lines.push(far);
    }
    const waiting = [...this.retryAt].filter(([, t]) => t > this.now()).map(([g, t]) => `${g} ${Math.round((t - this.now()) / 1000)}s`);
    if (waiting.length) lines.push(`Retrying later: ${waiting.join(', ')}.`);
    const prog = world?.progress;
    if (prog) {
      lines.push(`Progress: ${prog.done.length ? `done ${prog.done.join(', ')}` : 'nothing finished yet'}` +
        `${prog.current ? `; working on ${prog.current.id} (step ${prog.current.step + 1})` : ''}` +
        `${prog.need ? `; short of ${Object.entries(prog.need).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''}.`);
      for (const j of prog.journal.slice(-6)) lines.push(`  ${new Date(j.at).toISOString().slice(11, 16)} ${j.text}`);
    }
    lines.push(...communityStatus(world), ...yardGrowStatus(world));
    if (world?.yard) lines.push(`Yard: x ${world.yard.x1}..${world.yard.x2}, z ${world.yard.z1}..${world.yard.z2}, ground y ${world.yard.y}.`);
    // the Nether: the switch, the stage, the clean trips, the deaths, the portals known
    if (world) this.measure('status', () => lines.push(netherLine(world, this.now())));
    // the Nether gear: the EPF against fire dressed for it, and what the fortress's and the tunnel's 20 are short of
    if (world && s) this.measure('status', () => lines.push(netherGearLine(s.items, world)));
    // the villagers: the switch, the hall and its villagers, the villages known and judged, the last move
    if (world) this.measure('status', () => lines.push(villagersLine(world, this.now(), s?.home ? tooFarFor(world, s.home) : undefined, hallChoresText(world, this.now(), s?.counts.get('emerald') ?? 0))));
    // the rails home (the villager move's fallback): the switch, the line's state
    if (world) this.measure('status', () => lines.push(railsHomeLine(world, this.now())));
    // the villager fetch (fetch.ts): the lock, the ring, the gates left open, the journal; only where it has a record
    if (world?.fetch) {
      this.measure('status', () => {
        const notes = [...careNotes(world, this.now()), ...(dryNext(world) && !peekFetch(world).trip ? ['dry: the next trip plans and places nothing'] : [])];
        lines.push(fetchLine(world, this.now(), notes, lureOn(world) ? othersAbout(world, this.now()) : []));
      });
    }
    if (world) this.measure('status', () => {
      // from the idle tally, in real time (the old line counted ticks: one that started a goal weighed like an idle one)
      const today = todayLine(world);
      if (today) lines.push(today);
      // the work queue: what waits on dry marks goes with what is blocked, and its own line says where it stands
      const ladder = ladderOf(this.goals);
      lines.push(...idleReport(world, why, s && ladder.length ? dryBlocked({ ...s, now: this.now() }, world, ladder) : []));
      if (ladder.length) lines.push(workLine(world, this.now(), ladder));
    });
    const loops = this.loops.found.filter(f => this.now() - f.at < 60 * 60_000);
    if (loops.length) lines.push('Loops in the last hour (fix these in the code):', ...loops.map(f => `- ${new Date(f.at).toISOString().slice(11, 19)} ${f.loop.kind}: ${f.loop.summary}`));
    if (this.log.length) lines.push('Recent:', ...this.log.slice(-20).map(l => `- ${l}`));
    return lines.join('\n');
  }

  /** where the bot has walked, per world: its routes, which the lights round lights (walked) */
  private heat?: { world: string; map: HeatMap; last?: Pos; saved: number };
  private readonly structures = new StructureStore();
  private readonly loops = new LoopWatch();
  /** why the running goal was stopped (what stopped it), for the loop watch */
  private stopWhy?: string;

  /**
   * Count the cells walked since the last tick into the world's heat map (its routes, which the lights round lights).
   * Ticks are 5 s apart, a dozen blocks of walking: the cells between are filled in along a straight line.
   */
  private walked(s: Snapshot, world: WorldMemory): void {
    if (s.dimension !== 'overworld' || s.sleeping) return;
    if (this.heat?.world !== this.worldId) this.heat = { world: this.worldId!, map: HeatMap.fromJSON(world.heat), saved: this.now() };
    const h = this.heat!;
    const p = s.position, last = h.last;
    h.last = p;
    if (!last) return;
    const d = Math.hypot(p.x - last.x, p.z - last.z);
    if (d < 1 || d > 40) return; // standing about, or a teleport / respawn
    const steps = Math.ceil(d);
    for (let i = 1; i <= steps; i++) h.map.visit({ x: last.x + (p.x - last.x) * i / steps, z: last.z + (p.z - last.z) * i / steps });
    if (this.now() - h.saved > 60_000) { world.heat = h.map.toJSON(); h.saved = this.now(); }
  }

  /** A new game day (the clock wrapped): the tally's day is closed, old routes fade, and what was held may try again. */
  private countDay(s: Snapshot): void {
    if (s.timeOfDay < this.tod - 12_000) {
      // the day that ended as the idle tally counted it: one `day:` line, and its sums kept for the week
      this.measure('day', () => {
        const line = this.worldId ? tallyRoll(this.memory.world(this.worldId)) : '';
        if (line) this.note(line);
      });
      // a new day: old routes fade, so a path no longer walked stops being lit
      if (this.heat) { this.heat.map.decay(0.9); if (this.worldId) this.memory.world(this.worldId).heat = this.heat.map.toJSON(); }
      // a new day: what failed in the dark (no hunting at night) or waited a while may try again now; with a bed
      // the morning comes a minute after dusk, and the food goal sat out a 5 minute retry, hungry, in daylight
      const waiting = [...this.retryAt].filter(([g, t]) => t > this.now() && !this.looping(g)).map(([g]) => g);
      if (waiting.length) this.note(`morning: ${waiting.join(', ')} may try again`);
      this.letGoAll();
    }
    this.tod = s.timeOfDay;
  }

  /**
   * The chests the LLM's structures have as their own cells ("x,y,z"): those are the structure's, not home storage.
   * Not every chest in a structure's box: the lamp walk's box (a path round the yard) took in the storage house's
   * southern chests, and every landmark scan dropped them from the home's storage again.
   */
  private structureChests(world: WorldMemory): Set<string> {
    const out = new Set<string>();
    if (!world.id) return out;
    for (const n of this.structures.listStructures(world.id)) {
      try {
        const s = this.structures.loadStructure(world.id, n);
        if (!s || s.homeStorage) continue;
        for (const c of compile(this.structures.designOf(s), s.anchor, s.rotation ?? 0).cells) {
          if (/(^|:)(chest|trapped_chest|barrel)(\[|$)/.test(c.want)) out.add(`${c.at.x},${c.at.y},${c.at.z}`);
        }
      } catch { /* a structure that won't compile has no chests */ }
    }
    return out;
  }

  /**
   * The boxes of the LLM's structures in this world, as structure-site keeps off them: the improvement runs' builds
   * keep no zone, and the portal site keeps 8 from every build (portal.ts portalAvoid). Not a whole homestead's box
   * (site.ts structureSiteBoxes): that is the yard itself.
   */
  private structureBoxes(world: WorldMemory): { x: number; z: number; width: number; length: number }[] {
    if (!world.id) return [];
    const id = world.id;
    return structureSiteBoxes(this.structures.listStructures(id).map(n => { try { return this.structures.loadStructure(id, n); } catch { return undefined; } }),
      s => { const c = compile(this.structures.designOf(s), s.anchor, s.rotation ?? 0); return { ...c.box, cols: builtColumns(c.cells) }; });
  }


  /** The memory of the world the bot is in (chests, zones, jobs), once it knows which world that is. */
  worldMemory(): WorldMemory | undefined {
    return this.worldId ? this.memory.world(this.worldId) : undefined;
  }

  /** Save the memory now (after a tool changed it). */
  saveMemory(): void { this.memory.save(); }

  /** The answer to "claudebot status" in the server chat: what it's doing, how it is, what it's building. */
  chatStatus(): string {
    const world = this.worldId ? this.memory.world(this.worldId) : undefined;
    const cur = world?.progress?.current;
    const title = cur ? TREE.find(m => m.id === cur.id)?.title : undefined;
    return statusAnswer({ line: this.statusLine(), health: this.last?.health, food: this.last?.food, project: title, done: world?.progress?.done.length });
  }

  /** One line for the bot's own window: what the autopilot is doing right now. */
  statusLine(): string {
    if (!this.enabled) return 'Autopilot off';
    const lease = this.leaseUntil - this.now();
    if (lease > 0) return `Autopilot paused: LLM in control (${this.leaseTool}), back in ${Math.ceil(lease / 60_000)} min`;
    const r = this.running;
    if (r) return `Autopilot: ${r.goal.name} - ${this.step ?? r.reason}`;
    if (this.last?.sleeping) return 'Autopilot: asleep';
    return `Autopilot: idle${this.last ? ` (${this.last.activity === 'work' ? 'day' : this.last.activity === 'return' ? 'evening' : 'night'})` : ''}`;
  }

  /** Send the status line to the game client when it changed (shown on its HUD and window title). */
  private async show(): Promise<void> {
    const text = this.statusLine();
    if (text === this.shown) return;
    this.shown = text;
    // outside any goal's run: an aborted run's bridge calls fail on purpose, this one must not
    await brainRun.exit(() => this.rt.call('hud.set', { text })).catch(() => { this.shown = undefined; });
  }

  private note(text: string): void {
    const line = `${new Date(this.now()).toISOString().slice(11, 19)} ${text}`;
    this.log.push(line);
    if (this.log.length > 100) this.log.splice(0, this.log.length - 100);
    if (this.opts.logFile) {
      try {
        fs.mkdirSync(path.dirname(this.opts.logFile), { recursive: true });
        fs.appendFileSync(this.opts.logFile, `${new Date(this.now()).toISOString()} ${text}\n`);
      } catch { /* the log is a convenience */ }
    }
  }

  private async sense(): Promise<Snapshot | undefined> {
    const st = await this.rt.status().catch(() => undefined);
    if (!st?.inWorld || !st.position) return undefined;
    this.worldId = worldIdFromSeed(st.hashedSeed ?? undefined) ?? undefined;
    const inv = await this.rt.call<{ items: InventoryItem[]; held?: { name: string } | null }>('inventory');
    const counts = new Map<string, number>();
    for (const it of inv.items) counts.set(it.name, (counts.get(it.name) ?? 0) + it.count);
    const home = this.rt.home(st);
    const dimension = st.dimension ?? 'overworld';
    const s: Snapshot = {
      now: this.now(),
      timeOfDay: st.timeOfDay ?? 0,
      activity: activityAt(st.timeOfDay ?? 0, !!st.thundering),
      health: st.health ?? 20,
      food: st.food ?? 20,
      position: st.position,
      dimension,
      sleeping: !!st.sleeping,
      raining: !!st.raining,
      thundering: !!st.thundering,
      process: st.process ?? null,
      items: inv.items,
      counts,
      slotsUsed: inv.items.filter(i => i.slot < 36).length,
      home,
      distHome: home && home.dimension === dimension ? Math.hypot(home.x - st.position.x, home.z - st.position.z) : Infinity,
      boxedIn: st.boxedIn,
      xpLevel: st.xpLevel,
      foreign: st.foreign,
      // what the bot has drunk and whether it burns (the Nether's lava work and the potions read them); an older
      // jar sends neither: no effects, not burning
      effects: Array.isArray(st.effects) ? st.effects.filter(e => typeof e?.name === 'string') : [],
      onFire: !!st.onFire,
      ...(inv.held !== undefined ? { held: inv.held?.name ?? '' } : {}),
      ...(st.riding && typeof st.riding.id === 'number' ? { riding: { id: st.riding.id, uuid: st.riding.uuid, name: st.riding.name, own: st.riding.own, position: st.riding.position } } : {})
    };
    this.last = s;
    return s;
  }

  /** when the portals of others were last asked for (seePortals) */
  private portalsAt = -Infinity;

  /**
   * The lit portals of others the bridge has seen in the dimension the bot is in (foreign.portals), kept in the world's
   * memory every 5 minutes: the bridge's list lasts a client session, and where the bot's own Nether-side portal can
   * go (nether.ts netherPortalSpot) depends on the community's portals on both sides, seen days apart. An older jar
   * without the call: nothing kept.
   */
  private async seePortals(s: Snapshot, world: WorldMemory): Promise<void> {
    if (this.now() - this.portalsAt < 5 * 60_000 || (s.dimension !== OVERWORLD && s.dimension !== NETHER)) return;
    this.portalsAt = this.now();
    const r = await this.rt.call<{ dimension?: string; portals?: PortalShape[] }>('foreign.portals', { dimension: s.dimension }).catch(() => undefined);
    if (!Array.isArray(r?.portals)) return;
    this.measure('portals', () => notePortals(world, r.dimension ?? s.dimension, r.portals!));
  }

  /** the world the brain last came into in this process (attach) */
  private attached?: string;

  /**
   * The first look at a world in this process: the villager fetch's record made whole and saved (fetch.ts fetchOf: a
   * journal entry, a ward or a trip brain.json holds that cannot be read is dropped, and said by a halt that stands until
   * the lead has looked; saved now, not at the next run's end). A world with no record is left without one.
   */
  private attach(world: WorldMemory): void {
    this.attached = this.worldId;
    if (world.fetch === undefined) return;
    const f = fetchOf(world);
    if (f.halt) this.note(`villagers: HALT: ${f.halt.why}`);
    this.memory.save();
  }

  /** the gate watch: when the bridge was last asked how the strict gates stand, and when the lock was last looked into */
  private gatesAt = -Infinity;
  private lockAt = -Infinity;
  /** the strict set as last sent: for which world, how many gates, when */
  private strictSent?: { world: string; n: number; at: number };
  /** the bridge keeps strict gates (it answered gates.status in this process): a jar with the gate holds */
  private holdsKept = false;

  /**
   * A goal that builds with the bridge's gate holds (the shells: the lock and the portal's ring, each built with the
   * hall's gate strict, its own gate strict once it stands): until the bridge has answered gates.status in this
   * process it declines, so a world on a jar without the holds is left as it was, with no build tried and failed every
   * few minutes.
   */
  private withHolds(goal: Goal): Goal {
    const no: Decline = { cause: 'unneeded', text: 'the bridge keeps no strict gates (an older jar, or its client not up yet): nothing built' };
    const gate = (s: Snapshot, world: WorldMemory): Gate => (!this.holdsKept ? no : goal.gate ? goal.gate(s, world) : (goal.wants(s, world) ? { want: goal.wants(s, world)! } : no));
    return { ...goal, gate, ...fromGate(gate) };
  }

  /**
   * The gate watch (idle-plan V 4.6, 3.3), in the overworld once the yard has a gate the bridge is to keep strict
   * (yardgates.ts strictGates: the yard's, the villager hall's, the lock's, the portal ring's):
   *   - the strict set sent whole (gates.auto on, then gates.strict with the lock's pair and guard) at the start, and
   *     again whenever the bridge counts another number than the brain's own: a relaunched client keeps none (the
   *     bridge's sets live in the client), and a gate opened across the relaunch is then the bridge's to report again;
   *   - while a lock stands, the hall has villagers, a ward exists or a shell is being built: how the strict gates
   *     stand, every tick, into `fetch.gates` (open, and what the bridge calls leftOpen: open, nobody holding it, and
   *     the bot out of reach of it or it open 5 s), on the brain's own clock, the cells as the zones hold them. A row
   *     the bridge reads `loaded: false` is as it was last seen and is left out. The care goal acts on it;
   *   - while a lock stands and the bot is by it, who is in the lock, every half minute (villagercare.ts noteLock):
   *     care's rows for a villager shut in there and for the hall's gate left open behind it go by that look.
   * Otherwise the bridge is asked once a minute, for the count alone. A jar without the holds answers nothing: nothing
   * is written or sent, it is asked again once a minute, and the shells goal builds nothing (withHolds).
   */
  private async gateWatch(s: Snapshot, world: WorldMemory): Promise<void> {
    if (s.dimension !== OVERWORLD || !this.worldId) return;
    const want = strictGates(world);
    this.strictFell(world, want.length);
    if (!want.length) return;
    const f = world.fetch ? peekFetch(world) : undefined, lock = lockOf(world);
    const counted = (world.villages as { hall?: { count?: unknown } } | undefined)?.hall?.count;
    const hall = (typeof counted === 'number' && counted > 0) || (world.hallChores?.census?.villagers?.length ?? 0) > 0;
    const watching = !!lock || hall || !!f?.wards.length || !!f?.shells?.building;
    const now = this.now();
    // (every tick only once the bridge has answered: a jar without the holds is asked once a minute, in case one comes up)
    if (now - this.gatesAt < (watching && this.holdsKept ? 0 : 60_000)) return;
    this.gatesAt = now;
    type Row = { x: number; y: number; z: number; open?: boolean; loaded?: boolean; leftOpen?: boolean };
    const st = await this.rt.call<{ count?: number; strict?: Row[] }>('gates.status', {}).catch(() => undefined);
    if (!st || typeof st.count !== 'number' || !Array.isArray(st.strict)) return;
    this.holdsKept = true;
    const sent = this.strictSent;
    const fresh = sent?.world !== this.worldId;
    if (fresh || (st.count !== want.length && (st.count === 0 || now - sent!.at >= 60_000))) {
      // (the closer asked on only at the start, or for a client that keeps nothing, and never under a walk leading an
      // animal: the pens' walk asks it off for a while and would find it on again mid-walk)
      if ((fresh || st.count === 0) && !afield.ledBy) await this.rt.call('gates.auto', { enabled: true }).catch(() => undefined);
      const r = await this.rt.call<{ strict?: number; pairs?: number; guard?: number }>('gates.strict', strictSet(world) as unknown as Record<string, unknown>).catch((e: Error) => ({ error: e.message }));
      this.strictSent = { world: this.worldId, n: want.length, at: now };
      const kept = 'error' in r ? `not taken (${r.error})` : `${r.strict ?? '?'} strict gate(s)${r.pairs ? `, ${r.pairs} pair(s)` : ''}${r.guard ? `, ${r.guard} guard(s)` : ''}`;
      this.note(`gates: the strict set sent (${fresh ? 'at the start' : `the bridge counted ${st.count}, the brain ${want.length}: a relaunched client`}): ${kept}`);
      return;
    }
    if (!watching) return;
    const cell = (r: Row) => ({ x: Math.floor(r.x), y: Math.floor(r.y), z: Math.floor(r.z) });
    const rows = st.strict.filter(r => !!r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z) && r.loaded !== false);
    fetchOf(world).gates = { at: now, open: rows.filter(r => r.open === true).map(cell), leftOpen: rows.filter(r => r.leftOpen === true).map(cell) };
    // (who is in the lock: from by it only, where a look sees all of it)
    if (lock && now - this.lockAt >= LOCK_LOOK_MS && Math.hypot(s.position.x - lock.p.x, s.position.z - lock.p.z) <= 96 && onHomeLevel(s.position, s.home)) {
      this.lockAt = now;
      const r = await this.rt.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 128 }).catch(() => undefined);
      if (Array.isArray(r?.entities)) {
        noteLock(world, r.entities, now);
        // (and the wards with it: no box read here, so this look raises a ward, never lowers one: R-9)
        this.seeWards(world, r.entities, false, s.timeOfDay);
      }
    }
  }

  /**
   * The tripwire (S1 follow-up R7): the strict gates fewer than the set last sent the bridge while a villager trip
   * exists (not restoring) or a villager is out. On Nov 27 they fell 7 -> 6 -> 3 as the yard grew and its old side came
   * down; with a trip on, that fall is the hazard itself (a gate the closer forgets, a side of the yard open). The halt
   * stops every new trip and is said; the smaller set is still sent, since the bridge must match the world. With the
   * yard held while a trip exists (fetch.ts yardHeld) it should never fire. Nothing with no trip and no ward out.
   */
  private strictFell(world: WorldMemory, n: number): void {
    const sent = this.strictSent;
    if (!sent || sent.world !== this.worldId || n >= sent.n || world.fetch === undefined) return;
    const t = peekFetch(world).trip, now = this.now();
    if (!(t && t.state !== 'restore') && !wardOut(world, now)) return;
    const f = fetchOf(world);
    if (f.halt) return;
    const why = `the strict gates fell from ${sent.n} to ${n} while a villager trip is ${t && t.state !== 'restore' ? `${t.state} (trip ${t.id})` : 'out (a ward led, in the lock or astray)'}: the yard's fence or a gate changed under it`;
    f.halt = { at: now, why };
    this.note(`villagers: HALT: ${why}`);
    this.memory.save();
  }

  /**
   * The wards brought up to one of the brain's own looks (idle-plan V 3.2 R-9, fetch.ts wardSeen): the gate watch's
   * look into the lock and discover's look at the hall, overworld looks both. `whole`: the same read saw every cell of
   * the hall's floor and the lock (only such a look lowers a ward). The lock's gate P counts shut as the gate watch read
   * it in the last 15 s. A ward someone has taken (theirs, never contested) and a ward whose place changed are said.
   * Saved when anything of the fetch's record changed. Nothing without a ward on the records: a world with none has no
   * record made for it.
   */
  private seeWards(world: WorldMemory, seen: readonly Seen[], whole: boolean, tod: number): void {
    const f = world.fetch ? peekFetch(world) : undefined;
    if (!f?.wards.length) return;
    const now = this.now(), g = f.gates, p = world.zones?.['lock:gate']?.[0];
    const pShut = !!p && !!g && now - g.at <= 15_000 && !g.open.some(o => o.x === p.x && o.y === p.y && o.z === p.z);
    // (the record's own wards, which wardSeen writes: where each stood before the look)
    const before = JSON.stringify(world.fetch), was = new Map(fetchOf(world).wards.map(w => [w, w.where] as const));
    for (const x of wardSeen(world, seen, whole, now, { tod, pShut })) {
      if (x.taken) this.note(`villagers: ward ${x.ward.key.slice(0, 8)} ${x.taken}`);
      else if (x.seen && was.has(x.ward) && was.get(x.ward) !== x.ward.where) this.note(`villagers: ward ${x.ward.key.slice(0, 8)} now ${x.ward.where}${x.ward.note ? `: ${x.ward.note}` : ''}`);
    }
    if (JSON.stringify(world.fetch) !== before) this.memory.save();
  }

  /** when the bells the scans saw were last asked for (seeVillages) */
  private villagesAt = -Infinity;

  /**
   * With the villager-moves switch on, every 10 minutes: the bells the bridge's scans have seen within VILLAGE_RANGE of
   * home (foreign.marks: on any walk this client session), kept as village sites for the villagers rung. Off, nothing
   * is asked (the sightings of villagers and players in the runs' own looks are kept either way). An older jar without
   * the call: nothing kept.
   */
  private async seeVillages(s: Snapshot, world: WorldMemory): Promise<void> {
    if (!movesOn(world) || s.dimension !== OVERWORLD || !s.home || this.now() - this.villagesAt < 10 * 60_000) return;
    this.villagesAt = this.now();
    const home = s.home;
    // (the range's box in its four quarters: 640 round home is 1281 across, and the bridge reads a box of 1024 at most)
    const bells: { x: number; y: number; z: number; name: string }[] = [];
    let answered = false;
    for (const [qx, qz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const x1 = qx < 0 ? home.x - VILLAGE_RANGE : home.x + 1, z1 = qz < 0 ? home.z - VILLAGE_RANGE : home.z + 1;
      const x2 = qx < 0 ? home.x : home.x + VILLAGE_RANGE, z2 = qz < 0 ? home.z : home.z + VILLAGE_RANGE;
      const r = await this.rt.call<{ at?: { x: number; y: number; z: number; name: string }[] }>('foreign.marks', { x1, z1, x2, z2, match: '^bell$', max: 64 }).catch(() => undefined);
      if (!Array.isArray(r?.at)) continue;
      answered = true;
      bells.push(...r.at);
    }
    if (!answered) return;
    this.measure('villages', () => {
      const fresh = noteBells(world, bells.filter(m => m.name === 'bell'), this.now(), home);
      if (fresh) this.note(`villagers: ${fresh} village(s) seen on the walks (their bells), within ${VILLAGE_RANGE} of home`);
    });
  }

  /** when the bot was last got out of a vehicle no run steers (outOfVehicle) */
  private outAt = -Infinity;

  /**
   * In a boat or a minecart with no run to steer it: a villager move stopped from outside whose own let-go did not get
   * the bot out, or a restart (the server seats a player who comes back in the vehicle it left in). Nothing else may
   * start while seated: a walk's Baritone keys steer the boat, with the villager behind and no look at drops or lava.
   * Out of it toward home (anyhow, else), and the bot's own boat broken back into its item (the villager in it steps
   * out where it is). Tried every 20 s while it rides; nothing else starts meanwhile (the Guardian still fights, and
   * gets out at low health).
   */
  private async outOfVehicle(s: Snapshot, world: WorldMemory): Promise<void> {
    if (this.now() - this.outAt < 20_000) return;
    this.outAt = this.now();
    const v = s.riding!;
    const what = v.name ?? 'boat';
    const home = s.home ?? s.position;
    type Reply = { ok: boolean; reason?: string };
    const fail = (e: unknown): Reply => ({ ok: false, reason: (e as Error).message });
    let off = await this.rt.call<Reply>('vehicle.dismount', { toward: { x: home.x, z: home.z } }, 15_000).catch(fail);
    if (!off.ok) off = await this.rt.call<Reply>('vehicle.dismount', { force: true }, 15_000).catch(fail);
    if (!off.ok) { this.note(`villagers: still in the ${what} with no run to steer it: ${off.reason ?? 'no reply'}`); return; }
    // the bot's own: put down by a move (its uuid kept in villages.boat across a restart, when the bridge's own set is gone)
    const kept = world.villages?.boat;
    let took = '';
    if (v.own || (kept && v.uuid && kept.uuid === v.uuid)) {
      await new Promise(res => setTimeout(res, 500));
      const r = await this.rt.call<Reply>('vehicle.take', { id: v.id, ...(v.uuid ? { uuid: v.uuid } : {}) }, 30_000).catch(fail);
      if (r.ok) { if (kept?.uuid === v.uuid) delete villagesOf(world).boat; took = ', its boat taken back up'; } else took = `; its boat left (${r.reason ?? 'no reply'})`;
    }
    const at = v.position ? ` at (${Math.floor(v.position.x)}, ${Math.floor(v.position.y)}, ${Math.floor(v.position.z)})` : '';
    this.note(`villagers: out of the ${what}${at}, no run steering it (a move stopped from outside, or a restart)${took}`);
    this.memory.save();
  }

  /** Look around home for the bed, chests, furnace, table and farmland: once, then every 10 minutes while near it. */
  /**
   * Leave out the landmarks in someone else's build (an older client without the call: as they are). Never what's in
   * the bot's own yard or by home, whatever the mod says: a zone wrongly over the homestead once took its own bed and
   * chests away.
   */
  private async dropForeign(world: WorldMemory, home: Pos): Promise<void> {
    const l = world.landmarks;
    const y = world.yard;
    const ours = (p: Pos) => (y && p.x >= y.x1 - 6 && p.x <= y.x2 + 6 && p.z >= y.z1 - 6 && p.z <= y.z2 + 6) || Math.hypot(p.x - home.x, p.z - home.z) <= 24;
    const all = [l.bed, ...(l.beds ?? []), ...l.chests, l.furnace, l.table, l.anvil, l.smithing, l.portal, l.fletching, l.brewing, ...l.farmland].filter((p): p is Pos => !!p && !ours(p));
    if (!all.length) return;
    const r = await this.rt.call<{ inside?: boolean[] }>('foreign.at', { positions: all.map(p => [p.x, p.y, p.z]) }).catch(() => undefined);
    if (!Array.isArray(r?.inside)) return;
    const inside = r.inside;
    const theirs = new Set(all.filter((_, i) => inside[i]).map(p => `${p.x},${p.y},${p.z}`));
    if (!theirs.size) return;
    const mine = (p?: Pos) => (p && !theirs.has(`${p.x},${p.y},${p.z}`) ? p : undefined);
    l.bed = mine(l.bed);
    l.furnace = mine(l.furnace);
    l.table = mine(l.table);
    if (l.anvil) l.anvil = mine(l.anvil);
    if (l.smithing) l.smithing = mine(l.smithing);
    if (l.portal) l.portal = mine(l.portal);
    if (l.beds) l.beds = l.beds.filter(p => mine(p));
    if (l.fletching) l.fletching = mine(l.fletching);
    if (l.brewing) l.brewing = mine(l.brewing);
    l.chests = l.chests.filter(p => mine(p));
    l.farmland = l.farmland.filter(p => mine(p));
    this.note(`landmarks: left ${theirs.size} of someone else's alone (their chests, bed or farm)`);
  }

  private async discover(s: Snapshot, world: WorldMemory): Promise<void> {
    if (!s.home || s.distHome > 48) return;
    if (world.landmarks.foundAt && this.now() - world.landmarks.foundAt < 10 * 60_000) return;
    // around home, or the whole yard once it's known (a storage house can stand further out than 12 blocks)
    const y = world.yard;
    const box = y
      ? { x: Math.min(y.x1, s.home.x - 12), y: Math.min(y.y, s.home.y) - 3, z: Math.min(y.z1, s.home.z - 12),
        width: Math.max(y.x2, s.home.x + 12) - Math.min(y.x1, s.home.x - 12) + 1, height: 10,
        length: Math.max(y.z2, s.home.z + 12) - Math.min(y.z1, s.home.z - 12) + 1 }
      : { x: s.home.x - 12, y: s.home.y - 4, z: s.home.z - 12, width: 25, height: 11, length: 25 };
    const blocks = await readBox({ call: (m, p, t) => this.rt.call(m, p, t) }, box);
    const before = JSON.stringify({ ...world.landmarks, foundAt: 0 });
    // what it could not see (unloaded, just after a rejoin) stays as it was known (keepUnseen)
    const known = world.landmarks;
    world.landmarks = { ...findLandmarks(box, blocks, s.home, known), foundAt: this.now() };
    // and a cell the villager fetch holds is not what the look says it is (idle-plan V 6.3): a job block lifted out of a
    // villager's way stays known where it goes back (the workshop's smithing table lifted for a trip must not drop
    // landmarks.smithing, which the netherite job and its gate read), and a lure of the bot's own in the yard is no
    // fletching table of the hall's
    for (const k of HELD_MARKS) {
      const was = known[k], is = world.landmarks[k];
      if (was && heldByFetch(world, was)) world.landmarks[k] = was;
      else if (is && heldByFetch(world, is)) { if (was) world.landmarks[k] = was; else delete world.landmarks[k]; }
    }
    // a chest inside one of the LLM's structures is that structure's (a valuables chest in a hut 40 blocks out), not
    // home storage: the kit walked out to it at dusk, and the shelter pulled it back, three times over
    const theirs = this.structureChests(world);
    world.landmarks.chests = world.landmarks.chests.filter(c => !theirs.has(`${c.x},${c.y},${c.z}`));
    // nothing in someone else's build is the bot's: a friend's chest by home is not home storage, their bed not its bed,
    // their farmland not its farm (the mod knows the builds round the bot it didn't make)
    await this.dropForeign(world, s.home);
    // the villager hall's beds are the villagers' (villagers.ts): the bot sleeps in its own, the nearest of the rest
    world.landmarks.bed = homeBed(world.landmarks, world);
    // who is in the villager hall (hallchores.ts noteHall): the chores want only for villagers seen there, and one
    // brought in, or born, is seen from here without them running. Only from within 64 of the hall on home's level
    // (hallInSight): further, or down the mine under the yard, the look misses some, and an empty look counts it empty
    if (hallInSight(world, s.position, s.home)) {
      const r = await this.rt.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 128, type: 'villager' }).catch(() => undefined);
      if (Array.isArray(r?.entities)) {
        // whole: no cell of the hall's floor read null (just after a rejoin every one does, and the look sees nobody:
        // noteHall lowers no count then); with the time of day, whose job block is whose builds from these looks too
        const whole = hallWhole(world, box, blocks);
        const count = noteHall(world, r.entities, this.now(), whole, s.timeOfDay);
        if (count !== undefined) villagesOf(world).hall = { count, at: this.now() };
        noteLock(world, r.entities, this.now());
        // (the wards: a look that read the hall's floor and the lock whole may lower one, R-9)
        this.seeWards(world, r.entities, whole && lockWhole(world, box, blocks), s.timeOfDay);
      }
    }
    if (JSON.stringify({ ...world.landmarks, foundAt: 0 }) !== before) {
      const l = world.landmarks;
      this.note(`landmarks: bed ${l.bed ? 'found' : 'none'}, ${l.chests.length} chest(s), furnace ${l.furnace ? 'found' : 'none'}, table ${l.table ? 'found' : 'none'}, ${l.farmland.length} farmland` +
        `${l.anvil ? ', an anvil' : ''}${l.smithing ? ', a smithing table' : ''}${l.portal ? ', a lit portal' : ''}${l.brewing ? ', a brewing stand' : ''}`);
    }
    this.memory.save();
  }

  private start(goal: Goal, reason: string, s: Snapshot, world: WorldMemory): void {
    // one run at a time, whoever asks: the interval's tick and the one a run's end asks for both come through here.
    // And none for a brain switched off, or with the LLM at the bot, while this tick was looking: nothing would stop it
    if (this.running || !this.enabled || this.now() < this.leaseUntil) return;
    // it starts with a hold behind it that ran its full time: it may be let go early again another time
    if (this.retryAt.has(goal.name)) this.freedEarly.delete(goal.name);
    const abort = new AbortController();
    // added to as the run goes, not handed over at its end: a run stopped midway keeps the time it used and what it got
    const used = { ms: 0, gain: 0 };
    const ctx: GoalContext = {
      s, world, signal: abort.signal,
      act: async (tool, args = {}) => {
        const fn = this.rt.actions[tool];
        if (!fn) throw new Error(`no tool ${tool}`);
        const r = await fn(args);
        if (abort.signal.aborted) throw new Error('aborted');
        return { ok: !r.isError, text: r.content.map(c => (c as { text?: string }).text ?? '').join(' ') };
      },
      call: <T>(m: string, p?: Record<string, unknown>, t?: number) => {
        const r = this.rt.call<T>(m, p, t);
        // every look round a run makes, remembered for the villages' judge: the players seen anywhere in the
        // overworld (the judge notes one seen by a village), and villagers out in the world (village.ts noteSeen)
        if (m === 'world.entities') {
          r.then(x => this.measure('villages', () => {
            const seen = (x as { entities?: Seen[] } | undefined)?.entities;
            if (Array.isArray(seen)) noteSeen(world, seen, this.now(), this.last?.dimension ?? s.dimension);
          })).catch(() => undefined);
        }
        return r;
      },
      status: () => this.rt.status(),
      progress: text => { this.step = text; this.note(`${goal.name}: ${text}`); void this.show(); },
      gain: n => {
        if (!Number.isFinite(n) || n <= 0) return;
        used.gain += n;
        run.gain = used.gain; // the loop watch's record of this run
      },
      builds: () => this.structureBoxes(world),
      rails: this.rt.rails,
      own: this.rt.own,
      // (a restart mid-run never reaches the run's save: what a run must keep through one it saves at once)
      save: () => this.measure('save', () => this.memory.save()),
      dump: (name, data) => {
        if (!this.opts.logFile) return;
        try {
          // a folder per kind: a trip's records (`fetch-*`) would else push the rails' out, and the fixture's source with them
          const fetch = name.startsWith('fetch-');
          const dir = path.join(path.dirname(this.opts.logFile), fetch ? 'fetch-debug' : 'rails-debug');
          fs.mkdirSync(dir, { recursive: true });
          // (the last few kept: one a failed move day, five and the new one; a trip's 20 with the new one)
          const old = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
          for (const f of old.slice(0, Math.max(0, old.length - (fetch ? 19 : 5)))) fs.rmSync(path.join(dir, f), { force: true });
          fs.writeFileSync(path.join(dir, `${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${name}.json`), JSON.stringify(data));
        } catch { /* a debug record only */ }
      }
    };
    this.note(`start ${goal.name}: ${reason}`);
    // a rung of the work queue: why each rung above it did not run instead, from the answers this choice was made by
    this.measure('skipped', () => {
      const line = skippedLine(goal, s, world, this.goals, g => this.heldWords(g, s.now));
      if (line) this.note(line);
    });
    // the stuck watchdog counts from now: it kept the last job's clock, and every retry after a stuck stop was
    // "stuck" 5 s in (the shelter's 3-minute retries at the south fence never got to walk or wall in)
    this.stillAt = '';
    const started = this.now();
    const run = this.loops.begin(goal.name, reason, started);
    // no run starts with a full bucket or a fire starter in hand (the bridge's guard refuses a stray use of one, and
    // the brain keeps it out of the hand anyway): a run cut short leaves in hand whatever it held, the casting's lava
    // bucket or the plot's water one, and the next goal's walk to a door is a right click with it (live, Nov 14: the
    // stash walked into the storage house with a water bucket and poured it in front of the door). Nor the empty
    // bucket, which the guard lets through: its use along the look takes up the first source it meets
    const body = unsafeInHand(s.held) ? () => holdHarmless(ctx).then(() => goal.run(ctx)) : () => goal.run(ctx);
    const done = brainRun.run({ signal: abort.signal }, body)
      .then(text => {
        this.retryAt.delete(goal.name);
        this.holdWhy.delete(goal.name);
        this.fails.delete(goal.name);
        this.sameFails.delete(goal.name);
        this.note(`done ${goal.name} in ${Math.round((this.now() - started) / 1000)}s: ${text}`);
        this.loopCheck(run, 'done', text);
      })
      .catch((e: Error) => {
        // stopped for something more urgent (or the LLM) is no failure: it may go again as soon as it's wanted
        if (!abort.signal.aborted) {
          this.holdFor(goal.name, this.now() + goal.retryMs, `failed: ${String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 60)}`);
          const result = sameResult(String(e?.message ?? e));
          const row = this.sameFails.get(goal.name);
          this.sameFails.set(goal.name, { result, n: row?.result === result ? row.n + 1 : 1 });
          // three failures in a row: something is in the way today; leave it until the next morning
          const n = (this.fails.get(goal.name) ?? 0) + 1;
          this.fails.set(goal.name, n);
          if (n >= 3 && s && goal.failHoldMs !== undefined) {
            // a goal that gets the bot out of where it is stuck is not left for the night: a while, and it looks again
            const min = Math.round(goal.failHoldMs / 60_000);
            this.holdFor(goal.name, this.now() + goal.failHoldMs, `3 failures: ${min} min`);
            this.fails.delete(goal.name);
            this.note(`${goal.name} failed 3 times in a row: left for ${min} min`);
          } else if (n >= 3 && s) {
            const tod = this.last?.timeOfDay ?? s.timeOfDay;
            const toMorning = (((24_000 - tod) % 24_000) || 24_000) * 50;
            this.holdFor(goal.name, this.now() + toMorning, '3 failures: until morning');
            this.morningHold.add(goal.name);
            this.fails.delete(goal.name);
            this.note(`${goal.name} failed 3 times in a row: left until the morning`);
          }
        }
        this.note(`${abort.signal.aborted ? 'stopped' : 'failed'} ${goal.name}: ${e.message}`);
        this.loopCheck(run, abort.signal.aborted ? 'stopped' : 'failed', this.stopWhy ?? e.message);
      })
      .finally(() => {
        const mine = this.running?.abort === abort;
        // a critical section the run left set as it ended is over with it (its own code ends it; this is the net), and
        // so is a lead's hold (a lead that ended by a throw: care's row 3 must not take it for a run still at the trip)
        if (afield.critical?.by === abort.signal) delete afield.critical;
        if (afield.ledBy === abort.signal) afield.ledBy = undefined;
        // booked before the run is let go of: the stretch since the last tick is still its own
        this.measure('run', () => this.bookRun(goal, used, mine));
        if (mine) this.running = undefined;
        void this.show();
        // chest contents and chore times it learned; a save that fails (a full disk) is noted, and neither goes
        // unhandled nor keeps the next goal waiting
        this.measure('save', () => this.memory.save());
        // while the autopilot has the bot (not switched off, not the LLM's): the tick that would start something
        const ours = this.enabled && this.now() >= this.leaseUntil;
        // the walk home that ended by itself: the look that follows still belongs to it (the idle watchdog's count goes on)
        if (mine && ours && goal.name === returnIdle.name) this.walkedHomeAt = this.now();
        // the hand-over: the next goal starts now, not up to 5 s on. Not after a run that was over at once, nor after
        // a survival goal, which nothing holds when it goes round: those keep the tick's beat (see HAND_OVER_MS)
        if (mine && ours && !SURVIVAL.has(goal.name) && this.now() - started >= HAND_OVER_MS) this.soon();
      });
    this.running = { goal, reason, started, abort, done, used };
    this.step = undefined;
    void this.show();
  }

  /**
   * After each run: going round in circles? Log it (brain.log, loops.log beside it, and brain-status) for someone to
   * fix in the code, and back the losing goal off for 10 minutes meanwhile; never a survival goal (then the other one).
   */
  private loopCheck(run: Run, outcome: Outcome, text: string): void {
    this.stopWhy = undefined;
    const loop = this.loops.end(run, outcome, text, this.now());
    const again = loop ? undefined : this.loops.repeat;
    const held = (g: string) => !SURVIVAL.has(g) && !NO_LOOP_HOLD.has(g);
    const victimOf = (l: { victim: string; goals: string[] }) => held(l.victim) ? l.victim : l.goals.find(held);
    if (again) {
      // reported once per half hour, but backed off each time it comes back
      const v = victimOf(again);
      // only a loop the goal has gone round again since its last hold (not the old turns, still in the window)
      const since = (this.loopHold.get(v ?? '') ?? 0) - 10 * 60_000;
      if (v && again.runs.some(r => r.goal === v && r.at >= since)) { this.hold(v, again.kind); this.note(`LOOP again (${again.kind}: ${again.goals.join(' and ')}); ${v} backed off for 10 min`); }
      return;
    }
    if (!loop) return;
    const victim = victimOf(loop);
    if (victim) this.hold(victim, loop.kind);
    this.note(`LOOP (${loop.kind}): ${loop.summary}${victim ? `; ${victim} backed off for 10 min` : ''}`);
    if (this.opts.logFile) {
      try {
        fs.appendFileSync(path.join(path.dirname(this.opts.logFile), 'loops.log'),
          JSON.stringify({ at: new Date(this.now()).toISOString(), ...loop, backedOff: victim ?? null }) + '\n');
      } catch { /* a convenience */ }
    }
  }

  private hold(goal: string, kind: string): void {
    const until = this.now() + 10 * 60_000;
    this.holdFor(goal, until, `loop: ${kind}`);
    this.loopHold.set(goal, until);
    this.loopWhy.set(goal, `loop: ${kind}`);
  }

  /** Hold a goal back until then, and keep why (in a few words: it is read in the idle log and in brain-status). */
  private holdFor(goal: string, until: number, why: string): void {
    this.retryAt.set(goal, until);
    this.holdWhy.set(goal, why);
  }

  private looping = (goal: string) => (this.loopHold.get(goal) ?? 0) > this.now();

  /** It failed with the same result twice in a row or more (sameFails), and has not run well since. */
  private repeating = (goal: string) => (this.sameFails.get(goal)?.n ?? 0) >= 2;

  /**
   * Every hold let go (the morning, the idle watchdog's 3 minutes): the holds, the failures counted, "until morning",
   * and the early releases' marks. Not the loop watch's back-offs (put back: keepLoopHolds), and not the early
   * release's mark on a goal backed off or failing the same way over and over: the next early release would free it
   * again a minute later, and the loop it was held for goes round once more (the stash, 10:40-10:43Z on Nov 14).
   */
  private letGoAll(): void {
    this.retryAt.clear();
    this.keepLoopHolds();
    this.fails.clear();
    this.morningHold.clear();
    for (const g of [...this.freedEarly]) if (!this.looping(g) && !this.repeating(g)) this.freedEarly.delete(g);
  }

  /** After every hold was let go: the loop watch's back-offs still running are put back. */
  private keepLoopHolds(): void {
    // the whys went with the holds; a loop hold put back says again what it is
    this.holdWhy.clear();
    for (const [g, t] of this.loopHold) {
      if (t > this.now()) this.holdFor(g, t, this.loopWhy.get(g) ?? 'loop');
      else { this.loopHold.delete(g); this.loopWhy.delete(g); }
    }
  }

  /**
   * The measuring (the idle tally, its log lines, the status section) must never stop a tick from deciding: whatever
   * goes wrong in it is noted once per kind and otherwise let be.
   */
  private measure(kind: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (this.mishaps.has(kind)) return;
      this.mishaps.add(kind);
      try { this.note(`idle log: ${kind} failed (noted once): ${String((e as Error)?.message ?? e)}`); } catch { /* not even that */ }
    }
  }

  /**
   * Book the real time since the last call on the idle tally (at most 15 s: a tick that hung, or a clock that jumped,
   * is not a quarter of an hour of idleness). Only counted daytime: awake by day with a home, in a tick that looked
   * (`s` unset: the LLM has the bot, or there was no world to see; thunder is `rest`). With a run under way the time
   * is that run's, booked when it ends; with none it is idle time under the cause that leads, and the streak of it is
   * logged: once it has lasted 15 s, then each minute, and when the lead cause changes, but never more than once in
   * 15 s however the lead flips (17,000 ticks a real day).
   */
  private markTime(s: Snapshot | undefined): void {
    const now = this.now();
    const dt = this.lastMark === undefined ? 0 : Math.max(0, Math.min(now - this.lastMark, 15_000));
    this.lastMark = now;
    const world = this.worldId ? this.memory.world(this.worldId) : undefined;
    if (!s || !world || s.activity !== 'work' || s.sleeping || !s.home) { this.endStreak(); return; }
    if (this.running) { this.running.used.ms += dt; this.endStreak(); return; }
    const why = explainIdle(s, world, this.goals, this.retryAt, this.holdWhy);
    const lead = why[0].cause;
    tally(world, 'idle', dt, lead);
    const st = this.streak ??= { ms: 0, by: {} };
    st.ms += dt;
    st.by[lead] = (st.by[lead] ?? 0) + dt;
    if (st.ms >= 15_000 && (st.lineAt === undefined || now - st.lineAt >= 60_000 || (lead !== st.lead && now - st.lineAt >= 15_000))) {
      st.lineAt = now;
      st.lead = lead;
      this.note(idleLine(st.ms, why));
    }
    // on its own: whatever goes wrong in it, the time above is booked. And before the save below: one that cannot be
    // made (a full disk) throws out of here, and the hold's minute must not lose that tick
    this.measure('release', () => this.releaseHold(s, world, lead, dt));
    this.measure('dry', () => this.releaseDry(s, world, dt));
    // a run's end saves the tally with the rest; standing idle nothing would, and a restart lost the day so far
    if (this.idleSaved === undefined) this.idleSaved = now;
    else if (now - this.idleSaved >= 60_000) { this.idleSaved = now; this.memory.save(); }
  }

  /**
   * A hold let go early. When the idle time has been led by a hold for a minute, the bot stands about because a goal
   * with something to do waits out a back-off (five minutes after a walk that failed, three after one that stuck)
   * and nothing else wants to run meanwhile. One hold goes: the first, in the order the goals are tried, that is an
   * ordinary one (wedged, stuck, timed out, failed) on a goal that wants to run now. Never the loop watch's (that
   * goal went round in circles: its 10 minutes are the point), never "until morning" (three failures in a row:
   * something is in the way today), and never a goal that failed with the same result twice in a row (sameFails: a
   * third try would say the same, and it waits its hold out). The count of failures stays, so a third in a row still
   * means the morning. A goal let go early and held again is not let go early a second time until a hold on it has
   * run its full time (start), or the morning or the idle watchdog let everything go (letGoAll): without that a goal
   * that fails at once would be tried again every minute, all day. The minute starts again after each release.
   */
  private releaseHold(s: Snapshot, world: WorldMemory, lead: IdleCause, dt: number): void {
    if (lead !== 'hold') { this.holdIdle = 0; return; }
    this.holdIdle += dt;
    if (this.holdIdle < HOLD_IDLE_MS) return;
    for (const g of inOrder(s, world, this.goals)) {
      const why = this.holdWhy.get(g.name) ?? '';
      if (!((this.retryAt.get(g.name) ?? 0) > s.now) || !ORDINARY_HOLD.test(why)) continue;
      if (this.looping(g.name) || this.repeating(g.name) || this.morningHold.has(g.name) || this.freedEarly.has(g.name)) continue;
      let wants: string | null = null;
      try { wants = g.wants(s, world); } catch { /* it cannot say what it would do: it stays held */ }
      if (!wants) continue;
      this.retryAt.delete(g.name);
      this.holdWhy.delete(g.name);
      this.freedEarly.add(g.name);
      this.holdIdle = 0;
      this.note(`idle ${HOLD_IDLE_MS / 1000}s on a hold: let go of ${g.name} (${why})`);
      this.again = true; // the tick that follows this one at once starts it
      return;
    }
  }

  /**
   * The same for the work queue's dry marks, sooner: 30 s of counted idle time while a rung of the ladder waits on
   * its dry marks lets the oldest mark go, of a variant that could run otherwise. Whatever leads the idle time: with
   * the real ladder the deep rung's hour, its probation or the blocked project always outranked `dry`, and the bot
   * stood five minutes at a time by a coal trip that only waited on its mark. Once per mark: a try that comes back
   * dry again waits its whole, longer time (work.ts). The half minute starts again after each.
   */
  private releaseDry(s: Snapshot, world: WorldMemory, dt: number): void {
    const waits = ladderOf(this.goals).some(t => { const c = pick(t, s, world); return 'decline' in c && c.decline.cause === 'dry'; });
    if (!waits) { this.dryIdle = 0; return; }
    this.dryIdle += dt;
    if (this.dryIdle < DRY_IDLE_MS) return;
    this.dryIdle = 0;
    const key = releaseOldestDry(world, s.now, s, ladderOf(this.goals));
    if (!key) return;
    this.note(`idle ${DRY_IDLE_MS / 1000}s on dry marks: let go of ${key}`);
    this.again = true; // the tick that follows this one at once starts it
  }

  /** The brain's words for a goal it keeps back (`held until 14:32 (failed: ...)`), as the idle log says them; undefined when it is not held. */
  private heldWords(g: Goal, now: number): string | undefined {
    const until = this.retryAt.get(g.name) ?? 0;
    if (!(until > now)) return undefined;
    const why = this.holdWhy.get(g.name);
    return `held until ${clock(until)}${why ? ` (${why})` : ''}`;
  }

  /**
   * The work queue's part of a tick, before anything is decided. Its flags are lowered whenever no run of its is the
   * running goal (a run the brain gave up on that never unwound must not leave "a trip is out" standing: the stash
   * and the kit would wait for it for ever), and the brain's holds are shared with it (roundDue). Then its
   * housekeeping (work.ts workTick: deaths, old stamps, the day's count, the tiers), with what it did in the log.
   * Nothing more with no rung on the ladder.
   */
  private workQueue(s: Snapshot, world: WorldMemory): void {
    if (!this.running || !taskOf(this.running.goal)) clearOut();
    // the home rounds ask whether a trip could go instead: one this brain holds back cannot
    shareHolds(world, this.retryAt);
    const ladder = ladderOf(this.goals);
    if (!ladder.length) return;
    this.measure('work', () => { for (const line of workTick(s, world, () => this.rt.lastDeath(), ladder)) this.note(line); });
  }

  /**
   * The goals' lines for once a day (Goal.daily: the farm waiting on a full larder), each the first time it holds on a
   * (UTC) day. A goal that has said its line today is not asked again until the next.
   */
  private dailyLines(s: Snapshot, world: WorldMemory): void {
    const day = Math.floor(this.now() / DAY_MS);
    for (const g of this.goals) {
      if (!g.daily || this.saidOn.get(g.name) === day) continue;
      const line = g.daily(s, world);
      if (!line) continue;
      this.saidOn.set(g.name, day);
      this.note(`${g.name}: ${line}`);
    }
  }

  /** The idle streak is over (something runs, or the counted daytime stopped): say so when it was worth a line. */
  private endStreak(): void {
    const st = this.streak;
    this.streak = undefined;
    this.holdIdle = 0;
    this.dryIdle = 0;
    if (st && st.ms >= 15_000) this.note(idleOverLine(st.ms, st.by));
  }

  /**
   * A run ended: book the counted daytime it used. The walk back to the yard (goal `idle`) is idle time, the bot was
   * away with nothing to do; a run that was to bring something in (`gains`) and brought nothing is `empty`, busy to
   * no gain; everything else is busy. `mine`: it is still the run in hand (then the stretch since the last tick is
   * its own too).
   */
  private bookRun(goal: Goal, used: { ms: number; gain: number }, mine: boolean): void {
    if (mine) this.markTime(this.last);
    const world = this.worldId ? this.memory.world(this.worldId) : undefined;
    if (!world) return;
    if (goal.name === returnIdle.name) tally(world, 'idle', used.ms, 'away');
    else if (goal.gains && !used.gain) tally(world, 'empty', used.ms);
    else tally(world, 'busy', used.ms);
  }

  private async stopRunning(why: string): Promise<void> {
    const r = this.running;
    if (!r) return;
    this.stopWhy = why;
    this.note(`stopping ${r.goal.name}: ${why}`);
    r.abort.abort();
    await this.rt.call('cancel').catch(() => undefined);
    // let the job wind down (its next bridge call fails at once) so the caller doesn't race it
    await Promise.race([r.done, new Promise(res => setTimeout(res, 5000))]);
  }
}
