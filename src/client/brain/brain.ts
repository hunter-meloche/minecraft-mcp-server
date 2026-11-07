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

/** Staying alive: never backed off by the loop watch. */
const SURVIVAL = new Set(['wake', 'break out', 'recover', 'retreat', 'shelter', 'food']);
import { breakOut, returnIdle, shelterGoal, wake, type Goal, type GoalContext, type Snapshot } from './goals.js';
import { food, larder, recoverGoal, retreat } from './food.js';
import { farm, kit, lights, smelt, sortStorage, stash, stock } from './chores.js';
import { repairGoal } from './repair.js';
import { readBox } from './milestones.js';
import { projectGoal } from './project.js';
import { TREE } from './tree.js';

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

interface Running { goal: Goal; reason: string; started: number; abort: AbortController; done: Promise<void> }

/** The most urgent goal that wants to run (and isn't waiting out a failure), with its reason. */
export function decide(s: Snapshot, world: WorldMemory, goals: Goal[], retryAt: Map<string, number>): { goal: Goal; reason: string } | undefined {
  const p = (g: Goal) => g.urgency?.(s, world) ?? g.priority;
  for (const goal of [...goals].sort((a, b) => p(b) - p(a))) {
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
  private running?: Running;
  private leaseUntil = 0;
  private leaseTool = '';
  private retryAt = new Map<string, number>();
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
  /** today's daytime ticks, and how many of them had nothing to do */
  private day = { tod: 0, work: 0, idle: 0, lastIdle: 0 };
  private worldId?: string;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly leaseMs: number;

  constructor(private rt: ClientRuntime, private opts: BrainOptions = {}) {
    this.memory = new BrainMemory(opts.memoryFile);
    const structures = this.structures;
    this.goals = opts.goals ?? [wake, breakOut, recoverGoal(() => rt.lastDeath()), retreat, shelterGoal(), food, kit, stash, smelt, larder, farm, structureGoal(structures, b => rt.protectBuilt(b), (c, r) => rt.builtNear(c, r)), stock, deepTrip, repairGoal(rt), tidyGoal(rt), treeFarm, pens, caneRound, enchantGoal, lights, sortStorage, signsGoal, driftGoal(structures), projectGoal(TREE), returnIdle];
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 5000;
    this.leaseMs = opts.leaseMs ?? 10 * 60_000;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.leaseUntil = 0; // handed back on purpose: no waiting out the LLM's quiet time
    this.note(on ? 'autonomy on' : 'autonomy off');
    void this.show();
    if (on && !this.timer) {
      this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
      this.timer.unref?.();
    }
    if (!on) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      void this.stopRunning('autonomy turned off');
    }
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
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      if (this.now() < this.leaseUntil) return;
      const s = await this.sense();
      if (!s || !this.worldId) return;
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
      const r = this.running;
      if (r) {
        // stuck: a Baritone job that hasn't moved the bot a block in 3 minutes (pathing round in circles, wedged)
        const here = `${Math.floor(s.position.x)},${Math.floor(s.position.y)},${Math.floor(s.position.z)}`;
        if (here !== this.stillAt || !s.process) { this.stillAt = here; this.stillSince = this.now(); }
        if (s.process && this.now() - this.stillSince > 3 * 60_000) {
          this.stillSince = this.now();
          await this.stopRunning(`${r.goal.name} looks stuck (no movement for 3 min at ${here})`);
          this.retryAt.set(r.goal.name, this.now() + 3 * 60_000);
          return;
        }
        if (this.now() - r.started > r.goal.timeoutMs) {
          await this.stopRunning(`${r.goal.name} ran out of time`);
          this.retryAt.set(r.goal.name, this.now() + r.goal.retryMs);
          return;
        }
        if (r.goal.interruptible === false) return;
        const p = (g: Goal) => g.urgency?.(s, world) ?? g.priority;
        const next = decide(s, world, this.goals.filter(g => p(g) > p(r.goal)), this.retryAt);
        if (next) await this.stopRunning(`${next.goal.name} is more urgent (${next.reason})`);
        return;
      }
      const choice = decide(s, world, this.goals, this.retryAt);
      if (choice) this.start(choice.goal, choice.reason, s, world);
    } catch (e) {
      this.note(`tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
      await this.show();
    }
  }

  status(): string {
    const lines: string[] = [];
    const world = this.worldId ? this.memory.world(this.worldId) : undefined;
    lines.push(`Autonomy ${this.enabled ? 'on' : 'off'}${world ? ` (leash ${world.leash} blocks)` : ''}.`);
    const lease = this.leaseUntil - this.now();
    if (lease > 0) lines.push(`Paused for the LLM for ${(lease / 60_000).toFixed(1)} more min (last tool: ${this.leaseTool}).`);
    const s = this.last;
    if (s) {
      lines.push(`Activity: ${s.activity} (time of day ${s.timeOfDay}${s.sleeping ? ', asleep' : ''}). Health ${s.health}, food ${s.food}, ${s.slotsUsed}/36 slots used.`);
      lines.push(s.home ? `Home (${s.home.x}, ${s.home.y}, ${s.home.z}), ${Number.isFinite(s.distHome) ? Math.round(s.distHome) + ' blocks away' : 'in another dimension'}.` : 'No home set (set-home).');
      // others' builds (a friend's base, a village): what it keeps its hands off
      if (s.foreign?.zones) {
        const surface = s.foreign.surface ?? s.foreign.zones, under = s.foreign.zones - surface;
        const near = s.foreign.nearest === null ? '' : ` (the nearest ${Math.round(s.foreign.nearest)} blocks away)`;
        lines.push(`Others' builds seen: ${surface} on the surface${near}${under ? `, ${under} under ground (mineshafts, dungeons: their blocks stay, the rock round them is mined)` : ''}. It breaks nothing in a build, and leaves their animals and chests alone.`);
      }
    }
    if (this.running) lines.push(`Now: ${this.running.goal.name} (${this.running.reason}) for ${Math.round((this.now() - this.running.started) / 1000)}s.`);
    else lines.push('Now: nothing to do.');
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
    if (this.day.work) lines.push(`Today: idle ${Math.round(100 * this.day.idle / this.day.work)}% of daytime${this.day.lastIdle ? ` (yesterday ${this.day.lastIdle}%)` : ''}.`);
    const loops = this.loops.found.filter(f => this.now() - f.at < 60 * 60_000);
    if (loops.length) lines.push('Loops in the last hour (fix these in the code):', ...loops.map(f => `- ${new Date(f.at).toISOString().slice(11, 19)} ${f.loop.kind}: ${f.loop.summary}`));
    if (this.log.length) lines.push('Recent:', ...this.log.slice(-20).map(l => `- ${l}`));
    return lines.join('\n');
  }

  /** Count today's daytime ticks and the idle ones (a new day starts when the clock wraps). */
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

  private countDay(s: Snapshot): void {
    if (s.timeOfDay < this.day.tod - 12_000) {
      // a new day: old routes fade, so a path no longer walked stops being lit
      if (this.heat) { this.heat.map.decay(0.9); if (this.worldId) this.memory.world(this.worldId).heat = this.heat.map.toJSON(); }
      if (this.day.work) this.day.lastIdle = Math.round(100 * this.day.idle / this.day.work);
      this.day.work = this.day.idle = 0;
    }
    this.day.tod = s.timeOfDay;
    if (s.activity !== 'work' || s.sleeping) return;
    this.day.work++;
    if (!this.running) this.day.idle++;
  }

  /** The boxes of the structures placed in this world. */
  private structureBoxes(world: WorldMemory): { x: number; y: number; z: number; width: number; height: number; length: number }[] {
    if (!world.id) return [];
    return this.structures.listStructures(world.id).flatMap(n => {
      try {
        const s = this.structures.loadStructure(world.id!, n);
        return s && !s.homeStorage ? [compile(this.structures.designOf(s), s.anchor, s.rotation ?? 0).box] : [];
      } catch { return []; }
    });
  }

  /** The memory of the world the bot is in (chests, zones, jobs), once it knows which world that is. */
  worldMemory(): WorldMemory | undefined {
    return this.worldId ? this.memory.world(this.worldId) : undefined;
  }

  /** Save the memory now (after a tool changed it). */
  saveMemory(): void { this.memory.save(); }

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
    const boxes = this.structureBoxes(world);
    world.landmarks.chests = world.landmarks.chests.filter(c => !boxes.some(b => c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height && c.z >= b.z && c.z < b.z + b.length));
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
    const abort = new AbortController();
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
      progress: text => { this.step = text; this.note(`${goal.name}: ${text}`); void this.show(); }
    };
    this.note(`start ${goal.name}: ${reason}`);
    const started = this.now();
    const run = this.loops.begin(goal.name, reason, started);
    const done = brainRun.run({ signal: abort.signal }, () => goal.run(ctx))
      .then(text => {
        this.retryAt.delete(goal.name);
        this.fails.delete(goal.name);
        this.note(`done ${goal.name} in ${Math.round((this.now() - started) / 1000)}s: ${text}`);
        this.loopCheck(run, 'done', text);
      })
      .catch((e: Error) => {
        // stopped for something more urgent (or the LLM) is no failure: it may go again as soon as it's wanted
        if (!abort.signal.aborted) {
          this.retryAt.set(goal.name, this.now() + goal.retryMs);
          // three failures in a row: something is in the way today; leave it until the next morning
          const n = (this.fails.get(goal.name) ?? 0) + 1;
          this.fails.set(goal.name, n);
          if (n >= 3 && s) {
            const tod = this.last?.timeOfDay ?? s.timeOfDay;
            const toMorning = (((24_000 - tod) % 24_000) || 24_000) * 50;
            this.retryAt.set(goal.name, this.now() + toMorning);
            this.fails.delete(goal.name);
            this.note(`${goal.name} failed 3 times in a row: left until the morning`);
          }
        }
        this.note(`${abort.signal.aborted ? 'stopped' : 'failed'} ${goal.name}: ${e.message}`);
        this.loopCheck(run, abort.signal.aborted ? 'stopped' : 'failed', this.stopWhy ?? e.message);
      })
      .finally(() => {
        if (this.running?.abort === abort) this.running = undefined;
        void this.show();
        this.memory.save(); // chest contents and chore times it learned
      });
    this.running = { goal, reason, started, abort, done };
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
    if (!loop) return;
    const victim = !SURVIVAL.has(loop.victim) ? loop.victim : loop.goals.find(g => !SURVIVAL.has(g));
    if (victim) this.retryAt.set(victim, this.now() + 10 * 60_000);
    this.note(`LOOP (${loop.kind}): ${loop.summary}${victim ? `; ${victim} backed off for 10 min` : ''}`);
    if (this.opts.logFile) {
      try {
        fs.appendFileSync(path.join(path.dirname(this.opts.logFile), 'loops.log'),
          JSON.stringify({ at: new Date(this.now()).toISOString(), ...loop, backedOff: victim ?? null }) + '\n');
      } catch { /* a convenience */ }
    }
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
