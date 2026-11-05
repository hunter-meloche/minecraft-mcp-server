import fs from 'fs';
import path from 'path';
import { brainRun, type ClientRuntime, type InventoryItem } from '../tools.js';
import { worldIdFromSeed } from '../../build-protection.js';
import { activityAt } from './schedule.js';
import { BrainMemory, findLandmarks, type WorldMemory } from './memory.js';
import { returnIdle, shelterGoal, wake, type Goal, type GoalContext, type Snapshot } from './goals.js';
import { food, recoverGoal, retreat } from './food.js';
import { farm, kit, lights, smelt, stash, stock } from './chores.js';
import { repairGoal } from './repair.js';

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
  for (const goal of [...goals].sort((a, b) => b.priority - a.priority)) {
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
  private worldId?: string;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly leaseMs: number;

  constructor(private rt: ClientRuntime, private opts: BrainOptions = {}) {
    this.memory = new BrainMemory(opts.memoryFile);
    this.goals = opts.goals ?? [wake, recoverGoal(() => rt.lastDeath()), retreat, shelterGoal(), food, kit, stash, smelt, farm, stock, repairGoal(rt), lights, returnIdle];
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 5000;
    this.leaseMs = opts.leaseMs ?? 10 * 60_000;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.leaseUntil = 0; // handed back on purpose: no waiting out the LLM's quiet time
    this.note(on ? 'autonomy on' : 'autonomy off');
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
      await this.discover(s, world);
      const r = this.running;
      if (r) {
        if (this.now() - r.started > r.goal.timeoutMs) {
          await this.stopRunning(`${r.goal.name} ran out of time`);
          this.retryAt.set(r.goal.name, this.now() + r.goal.retryMs);
          return;
        }
        if (r.goal.interruptible === false) return;
        const next = decide(s, world, this.goals.filter(g => g.priority > r.goal.priority), this.retryAt);
        if (next) await this.stopRunning(`${next.goal.name} is more urgent (${next.reason})`);
        return;
      }
      const choice = decide(s, world, this.goals, this.retryAt);
      if (choice) this.start(choice.goal, choice.reason, s, world);
    } catch (e) {
      this.note(`tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
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
    if (this.log.length) lines.push('Recent:', ...this.log.slice(-20).map(l => `- ${l}`));
    return lines.join('\n');
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
      distHome: home && home.dimension === dimension ? Math.hypot(home.x - st.position.x, home.z - st.position.z) : Infinity
    };
    this.last = s;
    return s;
  }

  /** Look around home for the bed, chests, furnace, table and farmland: once, then every 10 minutes while near it. */
  private async discover(s: Snapshot, world: WorldMemory): Promise<void> {
    if (!s.home || s.distHome > 48) return;
    if (world.landmarks.foundAt && this.now() - world.landmarks.foundAt < 10 * 60_000) return;
    const box = { x: s.home.x - 12, y: s.home.y - 4, z: s.home.z - 12, width: 25, height: 11, length: 25 };
    const { blocks } = await this.rt.call<{ blocks: (string | null)[] }>('world.region', box, 30_000);
    const before = JSON.stringify({ ...world.landmarks, foundAt: 0 });
    world.landmarks = { ...findLandmarks(box, blocks, s.home), foundAt: this.now() };
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
      progress: text => this.note(`${goal.name}: ${text}`)
    };
    this.note(`start ${goal.name}: ${reason}`);
    const started = this.now();
    const done = brainRun.run({ signal: abort.signal }, () => goal.run(ctx))
      .then(text => {
        this.retryAt.delete(goal.name);
        this.note(`done ${goal.name} in ${Math.round((this.now() - started) / 1000)}s: ${text}`);
      })
      .catch((e: Error) => {
        // stopped for something more urgent (or the LLM) is no failure: it may go again as soon as it's wanted
        if (!abort.signal.aborted) this.retryAt.set(goal.name, this.now() + goal.retryMs);
        this.note(`${abort.signal.aborted ? 'stopped' : 'failed'} ${goal.name}: ${e.message}`);
      })
      .finally(() => {
        if (this.running?.abort === abort) this.running = undefined;
        this.memory.save(); // chest contents and chore times it learned
      });
    this.running = { goal, reason, started, abort, done };
  }

  private async stopRunning(why: string): Promise<void> {
    const r = this.running;
    if (!r) return;
    this.note(`stopping ${r.goal.name}: ${why}`);
    r.abort.abort();
    await this.rt.call('cancel').catch(() => undefined);
    // let the job wind down (its next bridge call fails at once) so the caller doesn't race it
    await Promise.race([r.done, new Promise(res => setTimeout(res, 5000))]);
  }
}
