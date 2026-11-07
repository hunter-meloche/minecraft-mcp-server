import type { Change } from '../diff.js';
import { applyAction, doable, priority, ready, satisfied, type Action } from './actions.js';
import { REACH, STEP, dist, eyeOf, placeRule, placeable, toward, type Dir } from './rules.js';
import { tasksFor, type Skipped, type Task } from './tasks.js';
import { planLoads, type Load } from './loads.js';
import {
  FLOOR, PASSABLE, REPLACEABLE, SUPPORT, Voxels, canLeave, descent, edgeSpots, entryPoint, idOf, isScaffold, key, nearestStandable, scaffoldState, steps,
  walkFrom, WALK, type Box, type P
} from './world.js';

/** What it scaffolds with, and what a standing scaffold block may be (dirt too). */
const THROWAWAY = /^(cobblestone|cobbled_deepslate|netherrack|andesite|diorite|granite|tuff|dirt)$/;

/**
 * Terraslicer: the structure's remaining work as a toolpath, worked out before a block is placed, the way a 3D
 * printer's slicer turns a model into moves. The work is split into objects (each building, the fence ring), finished
 * one at a time in a short tour; within an object the bot goes from station to station, a station being a spot it
 * stands on and everything it does from there. The stations are picked greedily on a copy of the world that the slicer
 * builds as it goes: from wherever the bot is, the spot that gets the most done per second of walking, counting what
 * each placed block makes placeable in turn (a wall row, a roof course).
 *
 * Supports, as a slicer's: where a block has nothing to be placed against (an eave over thin air), a temporary block
 * goes next to it first, chosen for how many stuck blocks it frees; where nothing it can walk to reaches the next
 * blocks (a roof ridge), it climbs on scaffold, a pillar under its feet and bridges ahead, chosen for the most stuck
 * blocks reached per scaffold block (a greedy set cover over a Dijkstra of walking, pillaring and bridging), and digs
 * its way down when done. Every scaffold block is taken down again in the plan.
 */

export interface Station {
  /** where it stands (feet) */
  at: P;
  actions: Action[];
  /** seconds of walking from the previous station (estimated) */
  walk: number;
  /** the object it belongs to */
  object: number;
  /** walked to by a way the slicer can't see (Baritone may know one): the first station of an object across water */
  hop?: boolean;
}

export interface SliceStats {
  objects: number;
  stations: number;
  place: number;
  dig: number;
  work: number;
  sign: number;
  /** scaffold blocks put up (and taken down: `scaffoldLeft` are not) */
  scaffold: number;
  scaffoldLeft: number;
  /** most scaffold blocks standing at once (what the bill needs of the scaffold block) */
  scaffoldPeak: number;
  hops: number;
  /** trips to the home chests for materials */
  loads: number;
  /** seconds of walking, and of the whole build (walking, the stations' overhead, the actions, the trips home) */
  walkSeconds: number;
  buildSeconds: number;
  /** cells it found no way to do, and cells it can't do at all */
  stuck: number;
  skipped: number;
}

export interface Toolpath {
  version: 1;
  start: P;
  stations: Station[];
  objects: { id: number; box: Box; tasks: number }[];
  /** the block it scaffolds with */
  scaffoldItem: string;
  /** the stations in pocketfuls: each starts at the home chests */
  loads: Load[];
  /** tasks it found no way to do (left for someone) */
  stuck: Skipped[];
  skipped: Skipped[];
  stats: SliceStats;
}

export interface SliceOptions {
  reach?: number;
  /** how many layers a placement may run ahead of the lowest unfinished one nearby (the slicer's layers, kept soft) */
  band?: number;
  /** seconds a station costs besides walking (the careful goto) */
  overhead?: number;
  /** stations tried in full per step (the rest only roughly scored) */
  candidates?: number;
  /** the throwaway block it scaffolds with */
  scaffoldItem?: string;
  /** most scaffold blocks for one climb */
  maxClimb?: number;
  /** inventory slots free for materials (the kit keeps the rest) */
  freeSlots?: number;
  /** scaffold the job put up before and left standing (a stopped run): taken down in this plan */
  scaffold?: P[];
  /** stop working on a plan after this long (ms) and report what's left */
  budgetMs?: number;
  /** spots ("x,y,z") Baritone couldn't walk to before: never stations (the model and Baritone disagree there) */
  avoid?: string[];
  /** told what the tour does and gives up on, as it goes (for tuning) */
  trace?: (msg: string) => void;
}

const DEFAULTS: Required<SliceOptions> = {
  reach: REACH, band: Infinity, overhead: 1.5, candidates: 8, scaffoldItem: 'cobblestone', maxClimb: 12, freeSlots: 20, scaffold: [], avoid: [], budgetMs: 30_000, trace: () => undefined
};

/** Seconds per action, for the estimate. */
const ACTION_SECONDS: Record<Action['op'], number> = { place: 0.25, dig: 0.6, work: 0.3, sign: 1.5, pillar: 0.7, descend: 0.6 };
/** What a scaffold block costs, in seconds: placing, digging it out again, picking it up. */
const BLOCK_COST = 2.5;

const colKey = (x: number, z: number) => `${x},${z}`;

/** The objects: tasks whose columns lie within `gap` of each other (a building, a fence ring, a lamppost). */
export function islands(tasks: Task[], gap = 2): Task[][] {
  const cols = new Map<string, number>();
  const parent: number[] = [];
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const t of tasks) {
    const k = colKey(t.at.x, t.at.z);
    if (!cols.has(k)) { cols.set(k, parent.length); parent.push(parent.length); }
  }
  for (const [k, i] of cols) {
    const [x, z] = k.split(',').map(Number);
    for (let dx = -gap; dx <= gap; dx++) for (let dz = -gap; dz <= gap; dz++) {
      const j = cols.get(colKey(x + dx, z + dz));
      if (j !== undefined) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
    }
  }
  const groups = new Map<number, Task[]>();
  for (const t of tasks) {
    const r = find(cols.get(colKey(t.at.x, t.at.z))!);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(t);
  }
  return [...groups.values()];
}

export function boxOf(ps: P[]): Box {
  const xs = ps.map(p => p.x), ys = ps.map(p => p.y), zs = ps.map(p => p.z);
  const x = Math.min(...xs), y = Math.min(...ys), z = Math.min(...zs);
  return { x, y, z, width: Math.max(...xs) - x + 1, height: Math.max(...ys) - y + 1, length: Math.max(...zs) - z + 1 };
}

const centre = (b: Box) => ({ x: b.x + b.width / 2, z: b.z + b.length / 2 });
const flat = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * The order to visit the objects in from `start`: nearest first, then 2-opt (reverse a stretch of the tour while that
 * shortens it). The tour is open: it ends at the last object.
 */
export function objectOrder(boxes: Box[], start: P): number[] {
  const left = boxes.map((_, i) => i);
  const order: number[] = [];
  let at = { x: start.x, z: start.z };
  while (left.length) {
    left.sort((a, b) => flat(at, centre(boxes[a])) - flat(at, centre(boxes[b])) || a - b);
    const next = left.shift()!;
    order.push(next);
    at = centre(boxes[next]);
  }
  const pt = (k: number) => (k < 0 ? { x: start.x, z: start.z } : centre(boxes[order[k]]));
  for (let improved = true, rounds = 0; improved && rounds < 50; rounds++) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) for (let j = i + 1; j < order.length; j++) {
      // edges (i-1, i) and (j, j+1) become (i-1, j) and (i, j+1)
      const before = flat(pt(i - 1), pt(i)) + (j + 1 < order.length ? flat(pt(j), pt(j + 1)) : 0);
      const after = flat(pt(i - 1), pt(j)) + (j + 1 < order.length ? flat(pt(i), pt(j + 1)) : 0);
      if (after < before - 1e-9) { order.splice(i, j - i + 1, ...order.slice(i, j + 1).reverse()); improved = true; }
    }
  }
  return order;
}

/** What the objects' tours share: the world as built so far, where the bot is, what's done. */
interface Run {
  v: Voxels; pos: P; done: Set<number>; stations: Station[]; opts: Required<SliceOptions>; deadline: number;
  nextId: number; scaffoldUp: number; scaffoldPeak: number; scaffoldTotal: number;
}

/** A station's work, tried on a copy of the world. */
interface Tried { at: P; actions: Action[]; done: number[]; w: Voxels; work: number; cost: number; hop: boolean }

const weight = (t: Task) => (t.kind === 'dig' ? 1.2 : t.attached || t.kind === 'sign' ? 0.8 : 1);
const NEIGHBOURS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const SIDES: Dir[] = ['north', 'south', 'east', 'west'];

/** One object's tour: its tasks (supports and their removal added as it goes) and the stations it adds. */
class Tour {
  readonly tasks: Task[] = [];
  private readonly spotsOf: number[][] = [];
  private readonly near = new Map<number, number[]>();
  private readonly abandoned = new Set<number>();
  private readonly dependents = new Map<number, number[]>();
  private readonly digsAround: number[][] = [];
  /** design placements by column (the layer band) */
  private readonly byCol = new Map<string, number[]>();
  /** cells the design still fills: no scaffold goes there */
  private readonly reserved = new Set<string>();
  /** removal task of each scaffold cell standing */
  private readonly removal = new Map<string, number>();
  /** task id to its index */
  private readonly indexOf = new Map<number, number>();
  private climbs = 0;
  /** a station of this object is down (hops are only for getting to an object) */
  private started = false;
  /** spots never to plan a station on (cell indices): Baritone couldn't walk there */
  private readonly avoid = new Set<number>();

  constructor(private readonly run: Run, initial: Task[], private readonly object: number, private readonly area: Box) {
    const digAt = new Map<string, number[]>();
    for (const k of run.opts.avoid) { const [x, y, z] = k.split(',').map(Number); const i = run.v.index({ x, y, z }); if (i >= 0) this.avoid.add(i); }
    initial.forEach(t => this.add(t));
    this.tasks.forEach((t, i) => {
      // scaffold left standing from before: its removal, as for scaffold put up in this plan
      if (t.scaffold && t.kind === 'dig') { this.removal.set(key(t.at), i); run.scaffoldUp++; run.scaffoldPeak = Math.max(run.scaffoldPeak, run.scaffoldUp); return; }
      if (t.kind === 'dig') { const k = key(t.at); if (!digAt.has(k)) digAt.set(k, []); digAt.get(k)!.push(i); }
      if (t.kind === 'place' && !t.attached) {
        const k = colKey(t.at.x, t.at.z);
        if (!this.byCol.has(k)) this.byCol.set(k, []);
        this.byCol.get(k)!.push(i);
      }
      if (t.kind === 'place' || t.kind === 'sign') this.reserved.add(key(t.at));
    });
    // a block isn't put next to a block still to be dug out: it could cover the face the dig needs (a floor laid over
    // the grass to be dug under it left the dig no way in)
    this.tasks.forEach((t, i) => {
      const out: number[] = [];
      if (t.kind === 'place' || t.kind === 'sign') {
        for (const [dx, dy, dz] of NEIGHBOURS) out.push(...(digAt.get(key({ x: t.at.x + dx, y: t.at.y + dy, z: t.at.z + dz })) ?? []));
      }
      this.digsAround[i] = out;
    });
  }

  /** Add a task (its reach lists too); returns its index. */
  private add(t: Task): number {
    const ti = this.tasks.length;
    this.tasks.push(t);
    this.indexOf.set(t.id, ti);
    this.digsAround[ti] = [];
    for (const n of t.needs) { if (!this.dependents.has(n)) this.dependents.set(n, []); this.dependents.get(n)!.push(ti); }
    const list: number[] = [];
    const c = { x: t.at.x + 0.5, y: t.at.y + 0.5, z: t.at.z + 0.5 };
    const bound = this.run.opts.reach + 0.75;
    const v = this.run.v;
    for (let dy = -6; dy <= 3; dy++) for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
      const p = { x: t.at.x + dx, y: t.at.y + dy, z: t.at.z + dz };
      const i = v.index(p);
      if (i < 0 || dist(eyeOf(p), c) > bound) continue;
      list.push(i);
      let l = this.near.get(i);
      if (!l) { l = []; this.near.set(i, l); }
      // in priority order: digs top down, then blocks bottom up, then the attached things, the tools, the signs
      const pr = priority(t);
      let at = l.length;
      while (at > 0 && priority(this.tasks[l[at - 1]]) > pr) at--;
      l.splice(at, 0, ti);
    }
    this.spotsOf.push(list);
    return ti;
  }

  private newTask(t: Omit<Task, 'id'>): number { return this.add({ ...t, id: this.run.nextId++ }); }

  private isDone(i: number) { return this.run.done.has(this.tasks[i].id); }

  private abandon(i: number) {
    if (this.abandoned.has(i) || this.isDone(i)) return;
    this.abandoned.add(i);
    for (const j of this.dependents.get(this.tasks[i].id) ?? []) this.abandon(j);
  }

  /** the unfinished design placements round task i at the lowest layer (what holds it back) */
  private lowest(i: number, local: Set<number>): { y: number; holders: number[] } {
    const t = this.tasks[i];
    let y = Infinity, holders: number[] = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      for (const j of this.byCol.get(colKey(t.at.x + dx, t.at.z + dz)) ?? []) {
        if (this.isDone(j) || local.has(this.tasks[j].id) || this.abandoned.has(j)) continue;
        if (this.tasks[j].at.y < y) { y = this.tasks[j].at.y; holders = [j]; } else if (this.tasks[j].at.y === y) holders.push(j);
      }
    }
    return { y, holders };
  }

  /** Within the band: a placement runs at most `band` layers above the lowest unfinished placement in the columns round it. */
  private gateOpen(i: number, local: Set<number>): boolean {
    const t = this.tasks[i];
    if (t.kind !== 'place' || t.attached || t.scaffold || !Number.isFinite(this.run.opts.band)) return true;
    return t.at.y <= this.lowest(i, local).y + this.run.opts.band;
  }

  private prereqsDone(t: Task, local: Set<number>) {
    const done = (n: number) => this.run.done.has(n) || local.has(n);
    return t.needs.every(done) && (t.after ?? []).every(n => done(n) || this.abandonedId(n));
  }
  private abandonedId(id: number) { const i = this.indexOf.get(id); return i !== undefined && this.abandoned.has(i); }
  private digsDone(i: number, local: Set<number>) {
    return this.digsAround[i].every(j => this.isDone(j) || local.has(this.tasks[j].id) || this.abandoned.has(j));
  }

  private readyIn(w: Voxels, i: number, local: Set<number>, gate = true): boolean {
    const t = this.tasks[i];
    if (this.isDone(i) || local.has(t.id) || this.abandoned.has(i) || !this.prereqsDone(t, local) || !this.digsDone(i, local)) return false;
    if (gate && !this.gateOpen(i, local)) return false;
    return ready(w, t);
  }

  /**
   * Everything doable from spot `si` in order, on a copy (each block placed makes the next possible). Taking scaffold
   * down only with `removal`: while there's work for it, it stands (else it was taken down after each block and put up
   * again, a block higher, for the next).
   */
  private chain(si: number, cost: number, hop: boolean, removal = false): Tried | undefined {
    const { run } = this;
    const at = run.v.at(si);
    let w = run.v.clone();
    const local = new Set<number>();
    const actions: Action[] = [];
    const done: number[] = [];
    const cand = this.near.get(si) ?? [];
    for (let guard = 0; guard < 400; guard++) {
      let picked: { i: number; a: Action } | undefined;
      for (const i of cand) {
        if (!removal && this.tasks[i].scaffold && this.tasks[i].kind === 'dig') continue;
        if (!this.readyIn(w, i, local)) continue;
        const a = doable(w, at, this.tasks[i], run.opts.reach);
        if (a) { picked = { i, a }; break; }
      }
      if (!picked) break;
      applyAction(w, picked.a);
      local.add(this.tasks[picked.i].id);
      done.push(this.tasks[picked.i].id);
      actions.push(picked.a);
    }
    if (!actions.length) return undefined;
    // never shut itself in: keep the longest start of the work after which it can still get out of the object (walking,
    // or digging down its own scaffold)
    if (!canLeave(w, at, this.area, true)) {
      let lo = 0, hi = actions.length - 1;
      let keep: Voxels | undefined;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const t = run.v.clone();
        for (const a of actions.slice(0, mid)) applyAction(t, a);
        if (canLeave(t, at, this.area, true)) { lo = mid; keep = t; } else hi = mid - 1;
      }
      if (!lo) return undefined;
      actions.length = lo;
      done.length = lo;
      w = keep ?? (() => { const t = run.v.clone(); for (const a of actions) applyAction(t, a); return t; })();
    }
    let work = 0;
    for (const id of done) work += weight(this.tasks[this.indexOf.get(id)!]);
    return { at, actions, done, w, work, cost, hop };
  }

  private commit(best: Tried) {
    const { run } = this;
    run.v = best.w;
    for (const id of best.done) run.done.add(id);
    for (const a of best.actions) if (a.op === 'dig' && a.scaffold) this.scaffoldGone(a.at);
    run.stations.push({ at: best.at, actions: best.actions, walk: Math.round(best.cost * 100) / 100, object: this.object, ...(best.hop ? { hop: true } : {}) });
    run.pos = best.at;
    this.started = true;
    run.opts.trace(`object ${this.object}: station ${run.stations.length} at ${key(best.at)} (${best.actions.length} actions, walk ${best.cost.toFixed(1)}s)`);
  }

  private scaffoldUp(at: P, after: number[]) {
    const r = this.newTask({ kind: 'dig', at, state: scaffoldState(this.run.opts.scaffoldItem), needs: [], after, scaffold: true });
    this.removal.set(key(at), r);
    this.run.scaffoldUp++;
    this.run.scaffoldTotal++;
    this.run.scaffoldPeak = Math.max(this.run.scaffoldPeak, this.run.scaffoldUp);
  }
  private scaffoldGone(at: P) {
    const r = this.removal.get(key(at));
    if (r === undefined) return;
    this.removal.delete(key(at));
    this.run.done.add(this.tasks[r].id);
    this.run.scaffoldUp--;
  }

  /**
   * The station to go to next for these ready tasks: every spot it can walk to roughly scored by the work in reach per
   * second of getting there, the best few tried in full (with chaining), the best of those by work per second.
   */
  private bestStation(list: number[], walk: { cost: Float64Array }, removal: boolean): Tried | undefined {
    const { run } = this;
    const opts = run.opts;
    const score = new Map<number, number>();
    let entry: { cost: Float64Array } | undefined;
    const add = (reachable: boolean) => {
      for (const i of list) for (const si of this.spotsOf[i]) {
        const p = run.v.at(si);
        if (!run.v.workable(p) || this.avoid.has(si) || (reachable && !Number.isFinite(walk.cost[si]))) continue;
        // getting to an object by a way it can't see is coming into the box from elsewhere: only to spots it can walk
        // to from the box's edge (a railed lookout ten blocks up has no drop beside it, and looked like the ground)
        if (!reachable && !Number.isFinite((entry ??= walkFrom(run.v, edgeSpots(run.v))).cost[si])) continue;
        score.set(si, (score.get(si) ?? 0) + weight(this.tasks[i]));
      }
    };
    add(true);
    let hop = false;
    // getting to a new object it can't walk to (across water, say): the way there is Baritone's to find. Within an
    // object, work it can't walk to is climbed to instead (a hop onto a roof is no way at all)
    if (!score.size && !this.started && !descent(run.v, run.pos)) { add(false); hop = score.size > 0; }
    const costOf = (si: number) => hop ? flat(run.pos, run.v.at(si)) * WALK * 1.5 + Math.abs(run.pos.y - run.v.at(si).y) : walk.cost[si];
    const ranked = [...score].map(([si, sc]) => ({ si, r: sc / (costOf(si) + opts.overhead) }))
      .sort((a, b) => b.r - a.r || a.si - b.si);
    let best: Tried | undefined, bestR = -1, good = 0;
    for (let k = 0; k < ranked.length && k < 400 && good < opts.candidates; k++) {
      const tried = this.chain(ranked[k].si, costOf(ranked[k].si), hop, removal);
      if (!tried) continue;
      good++;
      const r = tried.work / (tried.cost + opts.overhead);
      if (r > bestR) { best = tried; bestR = r; }
    }
    return best;
  }

  /** The tour: stations until nothing more can be done; returns the tasks left. */
  go(): number[] {
    const { run } = this;
    const opts = run.opts;
    for (let step = 0; step < 6000; step++) {
      if (Date.now() > run.deadline) { opts.trace(`object ${this.object}: out of time`); break; }
      // what's already as it should be (dug out by someone, built by hand) is done without a step
      for (let i = 0; i < this.tasks.length; i++) {
        if (!this.isDone(i) && !this.abandoned.has(i) && this.prereqsDone(this.tasks[i], new Set()) && satisfied(run.v, this.tasks[i])) run.done.add(this.tasks[i].id);
      }
      const open: number[] = [];
      for (let i = 0; i < this.tasks.length; i++) if (!this.isDone(i) && !this.abandoned.has(i)) open.push(i);
      if (!open.length) break;
      const none = new Set<number>();
      const readyNow = open.filter(i => this.readyIn(run.v, i, none));
      if (!readyNow.length) {
        if (this.retreat()) continue;
        if (this.overhang(open)) continue;
        if (this.unblockLayers(open)) continue;
        break;
      }
      const walk = walkFrom(run.v, run.pos);
      const isRemoval = (i: number) => this.tasks[i].scaffold === true && this.tasks[i].kind === 'dig';
      const design = readyNow.filter(i => !isRemoval(i));
      // the work first (the scaffold stays up while there's work for it)
      const best = design.length ? this.bestStation(design, walk, false) : undefined;
      if (best) { this.commit(best); continue; }
      // work doable from no spot it can walk to: climb to it (from up here, or after coming down)
      const unreached = design.filter(i => !this.spotsOf[i].some(si => Number.isFinite(walk.cost[si]) && !!doable(run.v, run.v.at(si), this.tasks[i], opts.reach)));
      if (unreached.length && this.climb(unreached, walk)) continue;
      // no work it can get at: take scaffold down, then come down itself
      const removals = readyNow.filter(isRemoval);
      const down = removals.length ? this.bestStation(removals, walk, true) : undefined;
      if (down) { this.commit(down); continue; }
      if (this.retreat()) continue;
      // scaffold left where it can't be got at from the ground: climb to it (its own removal is in the plan too)
      const lost = removals.filter(i => !this.spotsOf[i].some(si => Number.isFinite(walk.cost[si]) && !!doable(run.v, run.v.at(si), this.tasks[i], opts.reach)));
      if (lost.length && this.climb(lost, walk, true)) continue;
      const give = unreached.length ? unreached : readyNow;
      for (const i of give) this.abandon(i);
      opts.trace(`object ${this.object}: set aside ${give.length} out of reach (${give.slice(0, 3).map(i => `${this.tasks[i].kind} ${this.tasks[i].state} ${key(this.tasks[i].at)}`).join('; ')})`);
    }
    for (let k = 0; k < 10 && this.retreat(); k++) { /* down off every scaffold it ends on */ }
    return this.tasks.map((t, i) => (this.isDone(i) ? -1 : i)).filter(i => i >= 0);
  }

  /**
   * Up on scaffold with nothing left to do up there: walk to the top of a scaffold column and dig down it (the block
   * underfoot, one at a time), so it ends on the ground and the column is gone.
   */
  private retreat(): boolean {
    const { run } = this;
    // up means standing on its own scaffold, or somewhere it can't walk out of (a roof it climbed onto)
    const onScaffold = isScaffold(run.v.get({ x: run.pos.x, y: run.pos.y - 1, z: run.pos.z }));
    if (!onScaffold && canLeave(run.v, run.pos, this.area)) return false;
    const walk = walkFrom(run.v, run.pos);
    let best: { si: number; count: number; to: P } | undefined;
    for (let si = 0; si < walk.cost.length; si++) {
      if (!Number.isFinite(walk.cost[si])) continue;
      const d = descent(run.v, run.v.at(si));
      if (d && (!best || walk.cost[si] < walk.cost[best.si])) best = { si, ...d };
    }
    if (!best) return false;
    const at = run.v.at(best.si);
    const a: Action = { op: 'descend', at: { x: at.x, y: at.y - 1, z: at.z }, count: best.count, item: run.opts.scaffoldItem, scaffold: true };
    applyAction(run.v, a);
    for (let k = 0; k < best.count; k++) this.scaffoldGone({ x: at.x, y: at.y - 1 - k, z: at.z });
    run.stations.push({ at, actions: [a], walk: Math.round(walk.cost[best.si] * 100) / 100, object: this.object });
    run.pos = best.to;
    run.opts.trace(`object ${this.object}: down the scaffold at ${key(at)} (${best.count} blocks)`);
    return true;
  }

  /**
   * Blocks with nothing to place them against (an eave over thin air, a beam whose ends aren't there): a temporary
   * block on one of their sides, the one that frees the most stuck blocks (each block placed against it lets the next
   * one in the row go in), reached by a short chain of temporary blocks from something solid if need be.
   */
  private overhang(open: number[]): boolean {
    const { run } = this;
    const none = new Set<number>();
    const stuck = open.filter(i => {
      const t = this.tasks[i];
      if ((t.kind !== 'place' && t.kind !== 'sign') || t.scaffold || !this.prereqsDone(t, none) || !this.digsDone(i, none)) return false;
      const rule = t.rule ?? placeRule(t.state);
      return !rule.unsupported && run.v.is(t.at, REPLACEABLE) && !placeable(run.v, t.at, rule);
    });
    if (!stuck.length) return false;
    let best: { chain: P[]; freed: number[]; score: number; y: number } | undefined;
    const tried = new Set<string>();
    for (const i of stuck.slice(0, 300)) {
      const t = this.tasks[i];
      const rule = t.rule ?? placeRule(t.state);
      if (rule.attached) continue; // nothing attached rests on scaffold
      for (const d of rule.refs) {
        const r = toward(t.at, d);
        const k = key(r);
        if (tried.has(k) || !run.v.inside(r) || !run.v.is(r, REPLACEABLE) || this.reserved.has(k)) continue;
        tried.add(k);
        const chain = this.supportChain(r);
        if (!chain) continue;
        const freed = this.freedBy(chain, stuck);
        if (!freed.length) continue;
        const score = freed.length / chain.length;
        if (!best || score > best.score || (score === best.score && r.y < best.y)) best = { chain, freed, score, y: r.y };
      }
    }
    if (!best) return false;
    const item = run.opts.scaffoldItem;
    let prev: number | undefined;
    for (const c of best.chain) {
      const ti = this.newTask({ kind: 'place', at: c, state: scaffoldState(item), item, rule: placeRule(item), needs: prev === undefined ? [] : [this.tasks[prev].id], scaffold: true });
      prev = ti;
      this.scaffoldUp(c, best.freed.map(f => this.tasks[f].id).concat(this.tasks[ti].id));
    }
    run.opts.trace(`object ${this.object}: a support at ${best.chain.map(key).join(' > ')} frees ${best.freed.length}`);
    return true;
  }

  /** Free cells from `r` back to one beside something solid (at most 4), solid end first; undefined if none. */
  private supportChain(r: P): P[] | undefined {
    const v = this.run.v;
    const ok = (p: P) => v.inside(p) && v.is(p, REPLACEABLE) && !this.reserved.has(key(p));
    const touches = (p: P) => NEIGHBOURS.some(([dx, dy, dz]) => v.is({ x: p.x + dx, y: p.y + dy, z: p.z + dz }, SUPPORT));
    const prev = new Map<string, P | null>([[key(r), null]]);
    let frontier = [r];
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const next: P[] = [];
      for (const p of frontier) {
        if (touches(p)) {
          const out: P[] = [];
          for (let q: P | null = p; q; q = prev.get(key(q)) ?? null) out.push(q);
          return out; // p (beside the solid block) first, r last
        }
        for (const [dx, dy, dz] of NEIGHBOURS) {
          const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
          if (prev.has(key(q)) || !ok(q)) continue;
          prev.set(key(q), p);
          next.push(q);
        }
      }
      frontier = next;
    }
    return undefined;
  }

  /** The stuck blocks a support chain makes placeable, one after another (reach left to the tour). */
  private freedBy(chain: P[], stuck: number[]): number[] {
    const w = this.run.v.clone();
    for (const c of chain) w.set(c, scaffoldState(this.run.opts.scaffoldItem));
    const freed: number[] = [];
    const left = new Set(stuck);
    for (let changed = true; changed;) {
      changed = false;
      for (const i of left) {
        const t = this.tasks[i];
        if (!placeable(w, t.at, t.rule ?? placeRule(t.state))) continue;
        w.set(t.at, t.state);
        freed.push(i);
        left.delete(i);
        changed = true;
      }
    }
    return freed;
  }

  /**
   * Placements waiting only for the layer below to finish nearby, where what holds that layer up can't be done: those
   * holders are set aside so the rest can go on.
   */
  private unblockLayers(open: number[]): boolean {
    const none = new Set<number>();
    const freed = new Set<number>();
    for (const i of open) {
      const t = this.tasks[i];
      if (!this.prereqsDone(t, none) || !this.digsDone(i, none) || !ready(this.run.v, t) || this.gateOpen(i, none)) continue;
      for (const h of this.lowest(i, none).holders) if (!this.readyIn(this.run.v, h, none, false)) freed.add(h);
    }
    if (!freed.size) return false;
    this.run.opts.trace(`object ${this.object}: ${freed.size} stuck below hold back the layers over them: set aside`);
    for (const h of freed) this.abandon(h);
    return true;
  }

  /**
   * Out of reach from everywhere it can walk: climb. A Dijkstra from every spot it can walk to over walking, pillaring
   * (jump, a block under the feet) and bridging (a block ahead at the feet, step onto it), costing each scaffold block;
   * the spot that reaches the most of the stuck blocks per cost wins (greedy set cover). It climbs there, works, and
   * comes down later (retreat), the scaffold's removal in the plan.
   */
  private climb(unreached: number[], walk: { cost: Float64Array }, removal = false): boolean {
    const { run } = this;
    const v = run.v;
    const opts = run.opts;
    if (++this.climbs > 80) return false;
    const want = new Set(unreached);
    const n = v.size;
    const cost = new Float64Array(n).fill(Infinity);
    const blocks = new Uint8Array(n);
    const from = new Int32Array(n).fill(-1);
    const move = new Uint8Array(n); // 0 walk, 1 pillar, 2 bridge, 3 dig down its own scaffold
    // down to the bottom of the box: a climb starts from the ground (an object that's one stray block 8 up had no
    // ground in its region, so nothing to climb from)
    const lo = { x: this.area.x - 3, y: v.box.y, z: this.area.z - 3 };
    const hi = { x: this.area.x + this.area.width + 3, y: this.area.y + this.area.height + 3, z: this.area.z + this.area.length + 3 };
    const within = (p: P) => p.x >= lo.x && p.x < hi.x && p.y >= lo.y && p.y < hi.y && p.z >= lo.z && p.z < hi.z;
    const heap: { i: number; c: number }[] = [];
    const push = (i: number, c: number) => { heap.push({ i, c }); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p].c <= heap[k].c) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0]; const last = heap.pop()!; if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l].c < heap[m].c) m = l; if (r < heap.length && heap[r].c < heap[m].c) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    for (let i = 0; i < n; i++) if (Number.isFinite(walk.cost[i]) && within(v.at(i))) { cost[i] = walk.cost[i]; push(i, cost[i]); }
    const free = (p: P) => v.inside(p) && v.is(p, REPLACEABLE) && v.is(p, PASSABLE) && !this.reserved.has(key(p));
    let best: { i: number; covers: number[]; score: number } | undefined;
    while (heap.length) {
      const { i, c } = pop();
      if (c > cost[i]) continue;
      const f = v.at(i);
      // spots plain walking reaches were tried already: the candidates are those the climb opens
      if (!Number.isFinite(walk.cost[i]) && !v.inDoorway(f) && !this.avoid.has(i)) {
        const covers = (this.near.get(i) ?? []).filter(t => want.has(t) && !!doable(v, f, this.tasks[t], opts.reach));
        if (covers.length) {
          const score = covers.length / (c + opts.overhead);
          if (!best || score > best.score) best = { i, covers, score };
        }
      }
      const relax = (p: P, nc: number, nb: number, m: number) => {
        const j = v.index(p);
        if (j < 0 || !within(p) || nb > opts.maxClimb || nc >= cost[j]) return;
        cost[j] = nc; blocks[j] = nb; from[j] = i; move[j] = m;
        push(j, nc);
      };
      // walk on what stands (wall tops and roofs cost more by their drops: steps counts that in)
      steps(v, f, (p, d) => relax(p, c + d, blocks[i], 0));
      // dig down the scaffold column it stands on (from up on a pillar: down, then go and climb elsewhere)
      const d = descent(v, f);
      if (d) relax(d.to, c + 0.6 * d.count, blocks[i], 3);
      // pillar: the block goes where the feet are now
      const up = { x: f.x, y: f.y + 1, z: f.z };
      if (free(f) && v.is(up, PASSABLE) && v.is({ x: f.x, y: f.y + 2, z: f.z }, PASSABLE)) relax(up, c + 0.7 + BLOCK_COST, blocks[i] + 1, 1);
      // bridge: a block ahead at the floor, against the block underfoot, then step onto it
      for (const d of SIDES) {
        const to = toward(f, d);
        const floor = { x: to.x, y: to.y - 1, z: to.z };
        if (!v.is(to, PASSABLE) || !v.is({ x: to.x, y: to.y + 1, z: to.z }, PASSABLE) || v.is(floor, FLOOR) || !free(floor)) continue;
        relax(to, c + 0.8 + opts.overhead + BLOCK_COST, blocks[i] + 1, 2);
      }
    }
    if (!best) return false;
    // the moves back to where it starts walking from, in order
    const path: { i: number; m: number }[] = [];
    for (let i = best.i; from[i] >= 0 && !Number.isFinite(walk.cost[i]); i = from[i]) path.push({ i, m: move[i] });
    path.reverse();
    const startI = path.length ? from[path[0].i] : best.i;
    // walking to the first scaffold move is a station there (walking after scaffold moves is a station at the end of it)
    const item = opts.scaffoldItem;
    const placed: P[] = [];
    let station: Station = { at: v.at(startI), actions: [], walk: Math.round(walk.cost[startI] * 100) / 100, object: this.object };
    const stations: Station[] = [station];
    let feet = v.at(startI);
    const w = v; // the scaffold goes straight into the world: the climb is committed
    for (const { i, m } of path) {
      const to = w.at(i);
      if (m === 1) {
        const last = station.actions[station.actions.length - 1];
        if (last?.op === 'pillar' && last.at.x === feet.x && last.at.z === feet.z) last.count! += 1;
        else station.actions.push({ op: 'pillar', at: { ...feet }, count: 1, item, state: scaffoldState(item), scaffold: true });
        w.set(feet, scaffoldState(item));
        placed.push({ ...feet });
      } else if (m === 3) {
        // down the scaffold underfoot: the column comes out as it goes
        const dd = descent(w, feet)!;
        const a: Action = { op: 'descend', at: { x: feet.x, y: feet.y - 1, z: feet.z }, count: dd.count, item, scaffold: true };
        station.actions.push(a);
        applyAction(w, a);
        for (let k = 0; k < dd.count; k++) {
          const c = { x: feet.x, y: feet.y - 1 - k, z: feet.z };
          const pi = placed.findIndex(q => q.x === c.x && q.y === c.y && q.z === c.z);
          if (pi >= 0) placed.splice(pi, 1); else this.scaffoldGone(c);
        }
        station = { at: to, actions: [], walk: 0, object: this.object };
        stations.push(station);
      } else if (m === 2) {
        const floor = { x: to.x, y: to.y - 1, z: to.z };
        const d = (Object.keys(STEP) as Dir[]).find(k => STEP[k].x === feet.x - to.x && STEP[k].z === feet.z - to.z && STEP[k].y === 0)!;
        station.actions.push({ op: 'place', at: floor, item, state: scaffoldState(item), ref: d, scaffold: true });
        w.set(floor, scaffoldState(item));
        placed.push(floor);
        station = { at: to, actions: [], walk: WALK, object: this.object };
        stations.push(station);
      } else {
        // walking on: the station moves with it (a station per stretch walked)
        if (station.actions.length) { station = { at: to, actions: [], walk: WALK, object: this.object }; stations.push(station); }
        else { station.at = to; station.walk = Math.round((station.walk + WALK) * 100) / 100; }
      }
      feet = to;
    }
    // its removal waits for nothing: scaffold only comes down when no work is doable from where the bot is (waiting for
    // the blocks it went up for, it came down first, and the bridge it left up there was out of reach for good)
    for (const p of placed) this.scaffoldUp(p, []);
    // the work up there, from where the climb ends
    run.pos = feet;
    const work = this.chain(best.i, 0, false, removal);
    for (const s of stations) if (s.actions.length) { run.stations.push(s); run.opts.trace(`object ${this.object}: climb station ${run.stations.length} at ${key(s.at)} (${s.actions.map(a => a.op + (a.count ? `x${a.count}` : '')).join(', ')})`); }
    if (work) this.commit(work);
    run.opts.trace(`object ${this.object}: climbed ${placed.length} block(s) to ${key(feet)} for ${best.covers.length} out of reach`);
    return true;
  }
}

/** Why a task was left: for the report. */
function whyLeft(v: Voxels, t: Task, done: Set<number>): string {
  if (!t.needs.every(n => done.has(n))) return 'waits for a step before it that was left';
  if (t.scaffold) return 'scaffold it could not take down again';
  if (t.kind === 'dig') return 'no spot it can stand on reaches it';
  if (t.kind === 'work') return 'no spot it can stand on reaches it (or something stands on it)';
  if (!ready(v, t)) return t.rule?.refs.length === 1 ? `nothing ${t.rule.refs[0] === 'down' ? 'under it' : t.rule.refs[0] === 'up' ? 'over it' : `on its ${t.rule.refs[0]} side`} to place it against` : 'nothing next to it to place it against (or its cell is taken)';
  return 'out of reach from anywhere it can walk or climb to';
}

/**
 * Slice a structure's changes against the world round it (`world`: the work box, the structure's box and a margin),
 * starting where the bot will start (home, after taking its materials). Pure and deterministic.
 */
export function slice(world: Voxels, changes: Change[], start: P, options: SliceOptions = {}): Toolpath {
  const opts = { ...DEFAULTS, ...options };
  const { tasks, skipped } = tasksFor(changes);
  const groups = islands(tasks);
  const boxes = groups.map(g => boxOf(g.map(t => t.at)));
  // scaffold left standing (still a throwaway block there): marked as scaffold, its removal with the object it's by
  const v = world.clone();
  let nextId = tasks.length;
  for (const p of opts.scaffold) {
    const there = v.get(p);
    if (!there || !THROWAWAY.test(idOf(there))) continue;
    v.set(p, scaffoldState(idOf(there)));
    const t: Task = { id: nextId++, kind: 'dig', at: p, state: scaffoldState(idOf(there)), needs: [], scaffold: true };
    const near = boxes.findIndex(b => p.x >= b.x - 6 && p.x < b.x + b.width + 6 && p.z >= b.z - 6 && p.z < b.z + b.length + 6);
    if (near >= 0) groups[near].push(t);
    else { groups.push([t]); boxes.push(boxOf([p])); }
  }
  const order = objectOrder(boxes, start);
  // from where it is, or (coming from outside the box: home, far off) from where it walks in
  const from = (world.inside(start) ? nearestStandable(world, start) : undefined) ?? entryPoint(world, start) ?? start;
  const run: Run = {
    v, pos: from, done: new Set(), stations: [], opts, deadline: Date.now() + opts.budgetMs,
    nextId, scaffoldUp: 0, scaffoldPeak: 0, scaffoldTotal: 0
  };
  const stuck: Skipped[] = [];
  let scaffoldLeft = 0;
  for (const o of order) {
    const tour = new Tour(run, groups[o], o, boxes[o]);
    const left = tour.go();
    for (const i of left) {
      const t = tour.tasks[i];
      if (t.scaffold && t.kind === 'dig') scaffoldLeft++;
      if (t.scaffold && t.kind === 'place') continue; // a support never needed after all
      stuck.push({ at: t.at, want: t.kind === 'dig' ? 'air' : t.state, why: whyLeft(run.v, t, run.done) });
    }
  }
  const count = (op: Action['op']) => run.stations.reduce((n, s) => n + s.actions.filter(a => a.op === op && !a.scaffold).length, 0);
  const walkSeconds = run.stations.reduce((n, s) => n + s.walk, 0);
  const actionSeconds = run.stations.reduce((n, s) => n + s.actions.reduce((m, a) => m + ACTION_SECONDS[a.op] * (a.count ?? 1), 0), 0);
  const loads = planLoads(run.stations, opts.freeSlots, opts.scaffoldItem);
  // each load: to the chests at home and back out to its first station, and the chest work (about 15 s)
  const restockSeconds = loads.reduce((n, l) => n + 15 + 2 * flat(from, run.stations[l.from]?.at ?? from) * WALK, 0);
  const stats: SliceStats = {
    objects: groups.length, stations: run.stations.length, place: count('place'), dig: count('dig'), work: count('work'), sign: count('sign'),
    scaffold: run.scaffoldTotal, scaffoldLeft, scaffoldPeak: run.scaffoldPeak, hops: run.stations.filter(s => s.hop).length, loads: loads.length,
    walkSeconds: Math.round(walkSeconds), buildSeconds: Math.round(walkSeconds + run.stations.length * opts.overhead + actionSeconds + restockSeconds),
    stuck: stuck.length, skipped: skipped.length
  };
  return {
    version: 1, start: from, stations: run.stations, scaffoldItem: opts.scaffoldItem, loads,
    objects: order.map(o => ({ id: o, box: boxes[o], tasks: groups[o].length })), stuck, skipped, stats
  };
}
