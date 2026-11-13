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
import { HeatMap } from './paths.js';
import { signsGoal } from './signs.js';
import { driftGoal, structureGoal } from '../structures/job.js';
import { StructureStore } from '../structures/store.js';
import { compile } from '../structures/format.js';
import { LoopWatch, type Outcome, type Run } from './loops.js';
import { clock, explainIdle, idleLine, idleNow, idleOverLine, idleReport, tally, tallyRoll, todayLine, type IdleCause } from './idlelog.js';

/** Staying alive: never backed off by the loop watch. */
const SURVIVAL = new Set(['wake', 'out from under', 'break out', 'recover', 'retreat', 'shelter', 'food']);
import { breakOut, nearHome, onHomeLevel, returnIdle, shelterGoal, wake, type Decline, type Goal, type GoalContext, type Snapshot } from './goals.js';
import { outFromUnder } from './underyard.js';
import { food, larder, recoverGoal, retreat } from './food.js';
import { farm, kit, lights, smelt, sortStorage, stash, stock } from './chores.js';
import { repairGoal } from './repair.js';
import { readBox } from './milestones.js';
import { projectGoal } from './project.js';
import { TREE } from './tree.js';
import { communityStatus, donateGoal, missionGoal } from './community.js';
import { yardGrowGoal, yardGrowStatus } from './yardgrow.js';
import { storageGoal } from './storehouse.js';
import { bedGoal } from './home.js';
import { spareGoal } from './spare.js';
import { clearOut, dryBlocked, ladderOf, pick, releaseOldestDry, shareHolds, skippedLine, taskOf, workGoals, workLine, workTick } from './work.js';
import { NEAR_HOME, out as afield } from './pockets.js';
import { statusAnswer } from './chatstatus.js';

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

/** The idle watchdog: standing still by day this long with nothing to do, every hold is let go. */
const IDLE_FIRST = 3 * 60_000;
/** ...and once it has stood this long, the count starts afresh (the next let-go comes IDLE_FIRST after that). */
const IDLE_ROUND = 16 * 60_000;

interface Running {
  goal: Goal; reason: string; started: number; abort: AbortController; done: Promise<void>;
  /** the counted daytime it has used and what it has brought in so far: booked on the idle tally when it ends */
  used: { ms: number; gain: number };
}

/** Blocks the bot can stand partly inside of (thin ones): a fence, wall, pane, bars, a shut gate. */
const THIN = /(fence|_wall(\[|$)|pane|iron_bars|chain(\[|$))/;
/** What the bot can step into: air and the small plants and lights that don't block a walk. */
const OPEN = /^(minecraft:)?(air|cave_air|short_grass|tall_grass|fern|large_fern|dandelion|poppy|\w+_tulip|cornflower|oxeye_daisy|azure_bluet|allium|blue_orchid|lily_of_the_valley|torch|wall_torch|snow\[layers=1\])(\[|$)/;

/**
 * Wedged: the bot's feet cell (floored) holds a thin block it stands against, so Baritone plans from inside the
 * fence and walks into it for ever. Three times one night at the south fence (-547, 63, 2199), right after hunts
 * outside it: food, shelter and every retry "looks stuck" for half an hour, hungry, out of bed. `blocks` is the
 * 3x2x3 region from (x-1, y, z-1) round the floored position, x fastest, then z, then y. Returns the thin block and
 * the centre of the open side cell nearest the bot to step to, or undefined when it isn't wedged (or can't step out).
 */
export function wedgedOut(pos: Pos, blocks: (string | null)[]): { block: string; to: Pos } | undefined {
  const at = (dx: number, dy: number, dz: number) => (blocks[(dx + 1) + (dz + 1) * 3 + dy * 9] ?? '').replace(/^minecraft:/, '');
  const feet = at(0, 0, 0);
  if (!THIN.test(feet) || /open=true/.test(feet)) return undefined;
  const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .filter(([dx, dz]) => OPEN.test(at(dx, 0, dz)) && OPEN.test(at(dx, 1, dz)))
    .map(([dx, dz]) => ({ x: fx + dx + 0.5, y: fy, z: fz + dz + 0.5 }))
    .sort((a, b) => Math.hypot(a.x - pos.x, a.z - pos.z) - Math.hypot(b.x - pos.x, b.z - pos.z));
  return sides.length ? { block: feet.replace(/\[.*$/, ''), to: sides[0] } : undefined;
}

/**
 * The hand-over: a run that lasted this long is followed by the next decision at once, not at the next 5 s tick (a
 * twelfth of the daytime went into those waits). A run over sooner did nothing or failed at once: it waits for the
 * ordinary tick, so nothing can go round faster than the tick does. And so does whatever follows a survival goal: the
 * loop watch never holds one of those, so the tick is the only thing between its turns when it goes round with
 * nothing to show (2026-11-08: "done food in 3s: ... now carrying 0 food points", 51 times in a row).
 */
const HAND_OVER_MS = 2000;
/** An idle streak led by a hold lasts this long before one of the holds is let go early. */
const HOLD_IDLE_MS = 60_000;
/** Idle this long while a rung of the work queue waits on its dry marks (whatever leads the idle time): the oldest mark is let go. */
const DRY_IDLE_MS = 30_000;
/** The holds that may be let go early: a run that got wedged or stuck, ran out of time, or failed (not a loop's, not "until morning"). */
const ORDINARY_HOLD = /^(wedged$|stuck$|timed out$|failed: )/;

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
  /** the goals let go early: not a second time until a hold on them has run its full time (or the morning, or the idle watchdog) */
  private freedEarly = new Set<string>();
  /** what has gone wrong in the measuring and been noted (each kind once) */
  private mishaps = new Set<string>();
  private worldId?: string;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly leaseMs: number;

  constructor(private rt: ClientRuntime, private opts: BrainOptions = {}) {
    this.memory = new BrainMemory(opts.memoryFile);
    const structures = this.structures;
    this.goals = opts.goals ?? [wake, outFromUnder, breakOut, recoverGoal(() => rt.lastDeath()), retreat, shelterGoal(), food, kit, stash, storageGoal, smelt, larder, farm, structureGoal(structures, b => rt.protectBuilt(b), (c, r) => rt.builtNear(c, r)), missionGoal, bedGoal, yardGrowGoal, stock, deepTrip, repairGoal(rt), tidyGoal(rt), treeFarm, pens, caneRound, enchantGoal, lights, donateGoal, sortStorage, signsGoal, driftGoal(structures), projectGoal(TREE), ...workGoals(() => rt.lastDeath(), undefined, () => this.now()), spareGoal, returnIdle];
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

  /** The LLM ran a tool: step back now and stay out until it has been quiet for a while. */
  async manual(tool: string): Promise<void> {
    this.leaseUntil = this.now() + this.leaseMs;
    this.leaseTool = tool;
    void this.show();
    if (this.running) await this.stopRunning(`the LLM took over (${tool})`);
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
      await this.discover(s, world);
      this.countDay(s);
      this.walked(s, world);
      // the home zone is the yard as it grows (its rectangle; the game client keeps a margin round it)
      if (world.yard && s.home) {
        const y = world.yard;
        this.rt.setHomeZone?.({ x1: y.x1, z1: y.z1, x2: y.x2, z2: y.z2 });
      }
      this.idleTrack(s);
      this.workQueue(s, world);
      const r = this.running;
      if (r) {
        // stuck: a Baritone job that hasn't moved the bot a block in 3 minutes (pathing round in circles, wedged)
        const here = `${Math.floor(s.position.x)},${Math.floor(s.position.y)},${Math.floor(s.position.z)}`;
        if (here !== this.stillAt || !s.process) { this.stillAt = here; this.stillSince = this.now(); }
        // half a minute without a block's movement: wedged against a fence? step out by hand (Baritone never will).
        // A walk with an animal on its lead too: it never waits in or by a gateway (pens.ts standsClear), so one
        // standing in a gate this long is wedged, and only the brain gets it out (live, Nov 13: wedged in the north gate)
        if (s.process && this.now() - this.stillSince > 30_000 && this.wedgeLooked !== this.stillSince) {
          this.wedgeLooked = this.stillSince;
          const box = { x: Math.floor(s.position.x) - 1, y: Math.floor(s.position.y), z: Math.floor(s.position.z) - 1, width: 3, height: 2, length: 3 };
          const { blocks } = await this.rt.call<{ blocks: (string | null)[] }>('world.region', box).catch(() => ({ blocks: [] as (string | null)[] }));
          const out = wedgedOut(s.position, blocks ?? []);
          if (out) {
            await this.stopRunning(`${r.goal.name} is wedged in the ${out.block} at ${here}: stepping out`);
            await this.rt.call('steer', { ...out.to, within: 0.25, timeoutMs: 2000 }, 5000).catch(() => undefined);
            this.holdFor(r.goal.name, this.now() + 5000, 'wedged');
            return;
          }
        }
        if (s.process && this.now() - this.stillSince > 3 * 60_000) {
          this.stillSince = this.now();
          await this.stopRunning(`${r.goal.name} looks stuck (no movement for 3 min at ${here})`);
          this.holdFor(r.goal.name, this.now() + 3 * 60_000, 'stuck');
          return;
        }
        if (this.now() - r.started > r.goal.timeoutMs) {
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
        const may = (g: Goal) => SURVIVAL.has(g.name) || (!leading && (tripOut ? g.name === kit.name && !s.items.some(i => i.name.endsWith('_pickaxe')) : cuts(g)));
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
      // the marks of what was looked for and not found (`fruitless:*`) stay, the stock trips' like spare time's:
      // letting them go only sent the bot straight back to where there was nothing (2026-11-08: "spare time: 0 iron
      // ... Unable to find any path" every 3.5 min for an hour; 2026-11-10: "let go of fruitless:sugar_cane" every 10
      // to 20 min all day, each one more fruitless cane walk); they lapse by themselves
      this.retryAt.clear();
      this.keepLoopHolds();
      this.fails.clear();
      this.morningHold.clear();
      this.freedEarly.clear();
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
      lines.push(`Landmarks: bed ${p(l.bed)}, chests ${l.chests.length}, furnace ${p(l.furnace)}, table ${p(l.table)}, farmland ${l.farmland.length}.`);
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
      this.retryAt.clear();
      this.keepLoopHolds();
      this.fails.clear();
      this.morningHold.clear();
      this.freedEarly.clear();
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
    const inv = await this.rt.call<{ items: InventoryItem[] }>('inventory');
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
      foreign: st.foreign
    };
    this.last = s;
    return s;
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
    const all = [l.bed, ...l.chests, l.furnace, l.table, ...l.farmland].filter((p): p is Pos => !!p && !ours(p));
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
    world.landmarks = { ...findLandmarks(box, blocks, s.home), foundAt: this.now() };
    // a chest inside one of the LLM's structures is that structure's (a valuables chest in a hut 40 blocks out), not
    // home storage: the kit walked out to it at dusk, and the shelter pulled it back, three times over
    const theirs = this.structureChests(world);
    world.landmarks.chests = world.landmarks.chests.filter(c => !theirs.has(`${c.x},${c.y},${c.z}`));
    // nothing in someone else's build is the bot's: a friend's chest by home is not home storage, their bed not its bed,
    // their farmland not its farm (the mod knows the builds round the bot it didn't make)
    await this.dropForeign(world, s.home);
    if (JSON.stringify({ ...world.landmarks, foundAt: 0 }) !== before) {
      const l = world.landmarks;
      this.note(`landmarks: bed ${l.bed ? 'found' : 'none'}, ${l.chests.length} chest(s), furnace ${l.furnace ? 'found' : 'none'}, table ${l.table ? 'found' : 'none'}, ${l.farmland.length} farmland`);
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
      call: (m, p, t) => this.rt.call(m, p, t),
      status: () => this.rt.status(),
      progress: text => { this.step = text; this.note(`${goal.name}: ${text}`); void this.show(); },
      gain: n => {
        if (!Number.isFinite(n) || n <= 0) return;
        used.gain += n;
        run.gain = used.gain; // the loop watch's record of this run
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
    const done = brainRun.run({ signal: abort.signal }, () => goal.run(ctx))
      .then(text => {
        this.retryAt.delete(goal.name);
        this.holdWhy.delete(goal.name);
        this.fails.delete(goal.name);
        this.note(`done ${goal.name} in ${Math.round((this.now() - started) / 1000)}s: ${text}`);
        this.loopCheck(run, 'done', text);
      })
      .catch((e: Error) => {
        // stopped for something more urgent (or the LLM) is no failure: it may go again as soon as it's wanted
        if (!abort.signal.aborted) {
          this.holdFor(goal.name, this.now() + goal.retryMs, `failed: ${String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 60)}`);
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
    const victimOf = (l: { victim: string; goals: string[] }) => !SURVIVAL.has(l.victim) ? l.victim : l.goals.find(g => !SURVIVAL.has(g));
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
   * goal went round in circles: its 10 minutes are the point) and never "until morning" (three failures in a row:
   * something is in the way today). The count of failures stays, so a third in a row still means the morning. A goal
   * let go early and held again is not let go early a second time until a hold on it has run its full time (start),
   * or the morning or the idle watchdog let everything go: without that a goal that fails at once would be tried
   * again every minute, all day. The minute starts again after each release.
   */
  private releaseHold(s: Snapshot, world: WorldMemory, lead: IdleCause, dt: number): void {
    if (lead !== 'hold') { this.holdIdle = 0; return; }
    this.holdIdle += dt;
    if (this.holdIdle < HOLD_IDLE_MS) return;
    for (const g of inOrder(s, world, this.goals)) {
      const why = this.holdWhy.get(g.name) ?? '';
      if (!((this.retryAt.get(g.name) ?? 0) > s.now) || !ORDINARY_HOLD.test(why)) continue;
      if (this.looping(g.name) || this.morningHold.has(g.name) || this.freedEarly.has(g.name)) continue;
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
