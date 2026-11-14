import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Brain } from '../../src/client/brain/brain.js';
import { brainRun, type ClientRuntime, type InventoryItem } from '../../src/client/tools.js';
import { shelterGoal, type Goal, type GoalContext, type Snapshot } from '../../src/client/brain/goals.js';
import { goHome } from '../../src/client/brain/homeward.js';
import { leaveYard } from '../../src/client/brain/yardgates.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import sinon from 'sinon';
import { fetchForPens, pens, penWay, standsClear } from '../../src/client/brain/pens.js';
import { out as afield } from '../../src/client/brain/pockets.js';
import { LADDER } from '../../src/client/brain/worktasks.js';
import { DRY_WAIT, alongSide, dryUntil, markDry, needMs, penCount, pick, sitesOf, workGoals, workOf, workTick, type WorkTask } from '../../src/client/brain/work.js';

/**
 * The cows rung (worktasks.ts `cows`), the fetch on a lead and the pens round (pens.ts), over a stand-in pasture that
 * answers as the client and the game do: world.entities with each creature's distance from the bot and its marks
 * (on a lead, named, tamed, by someone's build), dropped items as `item` entities; entity.use within 4.5 blocks only,
 * a lead put on with a lead in hand and taken off (falling as an item where the animal stands) by a use with
 * anything else; a led animal pulled after the bot in a straight line to 2 blocks off it (PathfinderMob, Leashable),
 * stopped where a fence cell is in its way (the yard's fence, the pen's, a shut gate; an open one it goes through),
 * and the lead breaking past 12 (Leashable); a tempted one to 2.5 (TemptGoal), within 10, wheat in hand, which finds
 * its own way round, through an open gate only; Baritone opening a gate the bot walks through, a walk to within 1 of
 * a cell ending at the first cell within 1 of it on the bot's side (GoalNear), and the client's closer shutting a gate
 * once the bot is 2.2 past it while gates.auto is on (Gates.java). Shaped like the live homestead: the
 * cow pen at (-558, 2165) 7 x 7 with its gate south at (-555, 63, 2171), the yard's four gates, home in the storage
 * house, leads, string and slime balls in the chests.
 */

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 12, 20, 0, 0);
const HOME: Pos = { x: -549, y: 63, z: 2183 };
const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
const PEN = { x: -558, y: 62, z: 2165, width: 7, length: 7 };
const GATE: Pos = { x: -555, y: 63, z: 2171 };
const YARD_GATES: Pos[] = [{ x: -549, y: 63, z: 2119 }, { x: -533, y: 63, z: 2183 }, { x: -549, y: 63, z: 2215 }, { x: -565, y: 63, z: 2183 }];
const GEAR_CHEST: Pos = { x: -547, y: 64, z: 2182 };
const DROPS_CHEST: Pos = { x: -547, y: 65, z: 2179 };
const FARM_CHEST: Pos = { x: -547, y: 63, z: 2182 };
const k = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const mid = (c: Pos): Pos => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });

/** The live memory: the cow pen and its gate, the yard's gates, the chests, the enchanting room blocked on cane and leather. */
function liveWorld(over: Partial<WorldMemory> = {}, chests: Record<string, Record<string, number>> = {}): WorldMemory {
  return {
    landmarks: { chests: [{ ...GEAR_CHEST }, { ...DROPS_CHEST }, { ...FARM_CHEST }], farmland: [], foundAt: T0 }, leash: 96, yard: { ...YARD },
    chestItems: {
      [k(GEAR_CHEST)]: { stone_shovel: 1, bucket: 8, lead: 2 }, [k(DROPS_CHEST)]: { leather: 7, string: 15, slime_ball: 9, bone: 44 },
      [k(FARM_CHEST)]: { wheat: 1021 }, ...chests
    },
    zones: { 'pen:cow': [{ ...PEN }], 'pen:cow:gate': [{ ...GATE }], 'fence:gate': YARD_GATES.map(g => ({ ...g })), fence: [{ x: -565, y: 62, z: 2119, width: 33, length: 97 }] },
    progress: { done: ['pen-cow'], journal: [], blocked: { id: 'enchanting/2', n: 94, at: T0 - MINUTE, need: { sugar_cane: 135, leather: 45 } } },
    lastDone: {},
    ...over
  } as WorldMemory;
}

const countsOf = (items: InventoryItem[]) => {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return counts;
};
const look = (items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot => ({
  now: T0, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { ...HOME }, dimension: 'overworld', sleeping: false, raining: false,
  thundering: false, process: null, items, counts: countsOf(items), slotsUsed: items.filter(i => i.slot < 36).length, home: { ...HOME, dimension: 'overworld' },
  distHome: 0, ...over
});
const KIT: InventoryItem[] = [{ slot: 0, name: 'diamond_sword', count: 1 }, { slot: 1, name: 'iron_pickaxe', count: 1 }, { slot: 2, name: 'bread', count: 32 }];

interface Cow { id: number; name: string; position: Pos; baby?: boolean; named?: boolean; tamed?: boolean; leashed?: boolean; foreign?: boolean; buildDistance?: number }

/**
 * The bot in the pasture. `breakOn`: the leg (a careful walk with an animal on the lead, counted from 1) on which the
 * led one is caught on something and left 13 blocks back, and the lead breaks; `vanishOn` the same, the animal gone
 * (killed). `graze`: an animal that has walked 12 blocks on by the time the bot first comes within 8 of it.
 * `dropsLost`: a lead that comes off falls where it cannot be seen (into water). `shortOnce`: the first walk to an
 * animal ends 4 short of it and says it could not get there (Baritone on a ledge). `lag`: a led animal trails this
 * far behind after each walk (the game pulls it from 6), and closes in 2 at each look while the bot stands.
 * `showsLate`: the client shows a lead put on only after this many looks. `stopShort`: that walk out along a side
 * (counted from 1) ends 10 short and says so. Like the client, every call of a run the brain has given up fails.
 */
class Pasture {
  me: Pos = mid(HOME);
  items: InventoryItem[];
  held?: string;
  led = new Set<number>();
  drops: { id: number; item: string; position: Pos }[] = [];
  open = new Map<string, boolean>();
  /** gates the bot opened by walking through them, for the client's closer */
  opened = new Set<string>();
  gatesAuto = true;
  sprint = true;
  /** what was done, in order (walks, uses, toggles, the client switches) */
  log: string[] = [];
  careful: boolean[] = [];
  legs = 0;
  chests: Record<string, Record<string, number>>;
  /** the furthest the bot ever stood from home */
  farthest = 0;
  /** where it stood under the yard, if a walk took it down there */
  under?: Pos;
  /** every place the bot stood, after each walk */
  stood: Pos[] = [];
  /** how each straight step (steer) was to end: how near its point, and sneaking */
  steers: { within?: number; sneak: boolean }[] = [];
  /** where the bot stood at each look while an animal was on its lead (the waits for it are looks) */
  ledLooks: Pos[] = [];
  private nextDrop = 900;
  private nextCalf = 700;
  /** fed to breed and not yet paired: in love */
  private inLove = new Set<number>();
  /** when each was last fed to breed (the game's 5 min before it breeds again) */
  private bred = new Map<number, number>();
  private grazed = new Set<number>();
  private walkedTo = false;
  private sideWalks = 0;
  /** looks the client has yet to make before it shows a lead just put on */
  private unshown = new Map<number, number>();

  constructor(public cows: Cow[], world: WorldMemory, items: InventoryItem[],
    public opts: {
      breakOn?: number[]; vanishOn?: number; graze?: number; dropsLost?: boolean; shortOnce?: boolean; abortOn?: { leg: number; abort: () => void };
      /** with two on leads: only this one vanishes on `vanishOn` (else every led one) */
      vanishId?: number;
      lag?: number; showsLate?: number; stopShort?: number;
      /** abort the run as soon as this gate is opened */
      abortOnOpen?: { gate: Pos; abort: () => void };
      /** the first walk on the lead that ends within `within` of home waits there for `until` (the test looks then); `at` says when it has */
      holdNear?: { within: number; until: Promise<void>; at?: () => void };
      /**
       * the caves under the yard: a walk to "any height at this x and z" (xz) from inside the fence to a place on or
       * past it finds a way down one first and ends 41 under the lawn (live, Nov 13: the cows' walk from 32 out north
       * to the north gate, to (-536, 21, 2155)); so does one from anywhere to a column the live cave reaches (x -549,
       * z 2103 to 2151, Baritone's cache: the cave under the north gate runs on under the 80-out stop) unless it starts
       * within 16 of it, where the way over the ground is the shorter; a walk to a block (GoalBlock, GoalNear) goes
       * over the ground
       */
      caves?: boolean;
      /** yard gates (x,z) that let nobody through (gone, or a block in the gateway): a walk to the cell outside one stops inside */
      blocked?: string[];
      /**
       * someone's build by this cow that the mod has not looked at yet: it shows (buildDistance) once the bot asks for
       * a fresh look (foreign.zones), as the mod's scan of the chunks round the bot
       */
      scanReveals?: { id: number; buildDistance: number };
      /**
       * blocks of a build world memory does not know ("x,y,z": its block): a look at more than one block (world.region)
       * answers them, and air round them (the walks and the animals go through them all the same)
       */
      solid?: Record<string, string>;
      /**
       * the game's own close-in on a lead (PathfinderMob.closeRangeLeashBehaviour): within this of the bot a led one
       * walks its own way to 2 off it, through an open gate, as a tempted one does; further off, the straight pull
       */
      follow?: number;
      /** doors of a build world memory does not know: a walk through one opens it (Baritone), the closer shuts it behind */
      doors?: Pos[];
      /** where a culled cow's drops fall (default: a leather and two beef where it died) */
      cullDrops?: (c: Cow) => { item: string; position: Pos }[];
    } = {}) {
    this.items = items.map(i => ({ ...i }));
    this.chests = structuredClone(world.chestItems ?? {});
  }

  count(name: string) { return this.items.filter(i => i.slot < 36 && i.name === name).reduce((n, i) => n + i.count, 0); }
  add(name: string, n: number) {
    const has = this.items.find(i => i.slot < 36 && i.name === name);
    if (has) { has.count += n; return; }
    let slot = 0;
    while (this.items.some(i => i.slot === slot)) slot++;
    this.items.push({ slot, name, count: n });
  }
  take(name: string, n: number) {
    const has = this.items.find(i => i.slot < 36 && i.name === name);
    if (!has) return;
    has.count -= n;
    if (has.count <= 0) this.items = this.items.filter(i => i !== has);
  }

  private inPenBox = (p: { x: number; z: number }) => p.x >= PEN.x && p.x < PEN.x + PEN.width && p.z >= PEN.z && p.z < PEN.z + PEN.length;
  private pastYard = (p: { x: number; z: number }) => Math.floor(p.x) > YARD.x1 && Math.floor(p.x) < YARD.x2 && Math.floor(p.z) > YARD.z1 && Math.floor(p.z) < YARD.z2;
  isOpen = (g: Pos) => this.open.get(k(g)) ?? false;
  /** the yard's gate a walk from a to b goes through (the nearest to where it crosses) */
  private yardGateFor(a: Pos, b: Pos): Pos {
    const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    return [...YARD_GATES].sort((g, h) => horiz(mid(g), m) - horiz(mid(h), m))[0];
  }

  /**
   * The way from a to b over the fences: through the yard's gate and the pen's where it crosses them, or undefined
   * when a gate it must pass is shut (`opens`: the bot's own walk, which opens what it passes, as Baritone does).
   */
  private way(a: Pos, b: Pos, opens: boolean): Pos[] | undefined {
    const pts: Pos[] = [a];
    const gates: Pos[] = [];
    if (this.pastYard(a) !== this.pastYard(b)) gates.push(this.yardGateFor(a, b));
    if (this.inPenBox(a) !== this.inPenBox(b)) gates.push(GATE);
    // out of the pen before the yard's gate when leaving; the yard's before the pen's when coming in
    if (this.inPenBox(a)) gates.sort(g => (k(g) === k(GATE) ? -1 : 1));
    for (const g of gates) {
      if (!this.isOpen(g)) {
        if (!opens) return undefined;
        this.open.set(k(g), true);
        this.opened.add(k(g));
        this.log.push(`baritone opens ${k(g)}`);
      }
      pts.push(mid(g));
    }
    pts.push(b);
    return pts;
  }

  /** along a way, `d` blocks from its start */
  private along(pts: Pos[], d: number): Pos {
    let left = d;
    for (let i = 1; i < pts.length; i++) {
      const seg = horiz(pts[i - 1], pts[i]);
      if (left <= seg) { const t = seg ? left / seg : 0; return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i].y, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t }; }
      left -= seg;
    }
    return { ...pts[pts.length - 1] };
  }
  private length = (pts: Pos[]) => pts.slice(1).reduce((n, p, i) => n + horiz(pts[i], p), 0);

  /** a cell a fence fills: the yard's fence line and the pen's, a gate in them while shut (a blocked one always) */
  fenceAt(x: number, z: number): boolean {
    const gate = [...YARD_GATES, GATE].find(g => g.x === x && g.z === z);
    if (gate) return !this.isOpen(gate) || !!this.opts.blocked?.includes(`${gate.x},${gate.z}`);
    const ring = (x1: number, z1: number, x2: number, z2: number) => ((x === x1 || x === x2) && z >= z1 && z <= z2) || ((z === z1 || z === z2) && x >= x1 && x <= x2);
    return ring(YARD.x1, YARD.z1, YARD.x2, YARD.z2) || ring(PEN.x, PEN.z, PEN.x + PEN.width - 1, PEN.z + PEN.length - 1);
  }

  /**
   * A led one pulled toward the bot along the straight line between them, `by` blocks at most, to `stop` off it, and
   * no further than the last point before a fence cell on that line: a lead pulls straight and snags on fences.
   */
  pull(c: Cow, stop: number, by = Infinity) {
    const d = horiz(c.position, this.me);
    const go = Math.min(by, d - stop);
    if (go <= 0) return;
    const ux = (this.me.x - c.position.x) / d, uz = (this.me.z - c.position.z) / d;
    const n = Math.ceil(go / 0.05);
    let got = 0;
    for (let i = 1; i <= n; i++) {
      const s = go * i / n;
      if (this.fenceAt(Math.floor(c.position.x + ux * s), Math.floor(c.position.z + uz * s))) break;
      got = s;
    }
    c.position = { ...c.position, x: c.position.x + ux * got, z: c.position.z + uz * got };
  }

  /** A led one within `opts.follow` of the bot: its own way to 2 off it (`by` at most), when no shut gate is in it. */
  closeIn(c: Cow, by = Infinity): boolean {
    if (!this.opts.follow || horiz(c.position, this.me) > this.opts.follow) return false;
    // (through a gate only: the stand-in knows no way round a fence, and the straight pull is the rest)
    const w = this.way(c.position, this.me, false);
    if (!w || w.length < 3) return false;
    const len = this.length(w);
    if (len > 2) c.position = this.along(w, Math.min(by, len - 2));
    return true;
  }

  /** The bot walks to `to`; the client's closer, the led and the tempted animals, the lead breaking, what is picked up. */
  walk(to: Pos, label: string) {
    const from = this.me;
    // (the gates it passes, opened on the way, and the doors)
    this.way(from, to, true);
    for (const d of this.opts.doors ?? []) {
      const n = Math.ceil(horiz(from, to) / 0.1);
      const through = Array.from({ length: n + 1 }, (_, i) => i / Math.max(n, 1))
        .some(f => Math.floor(from.x + (to.x - from.x) * f) === d.x && Math.floor(from.z + (to.z - from.z) * f) === d.z);
      if (through && !this.isOpen(d)) { this.open.set(k(d), true); this.opened.add(k(d)); this.log.push(`baritone opens ${k(d)}`); }
    }
    this.me = { ...to };
    this.stood.push({ ...this.me });
    this.farthest = Math.max(this.farthest, horiz(this.me, HOME));
    // the client's closer shuts what the bot opened as it gets 2.2 past it, while it is on
    if (this.gatesAuto) {
      for (const g of [...this.opened]) {
        const [x, y, z] = g.split(',').map(Number);
        if (horiz(mid({ x, y, z }), this.me) > 2.2) { this.open.set(g, false); this.opened.delete(g); this.log.push(`the closer shuts ${g}`); }
      }
    }
    if (label === 'goto careful' && this.led.size) this.legs++;
    for (const c of this.cows) {
      const ledNow = this.led.has(c.id);
      if (ledNow && this.opts.vanishOn === this.legs && (this.opts.vanishId ?? c.id) === c.id && label === 'goto careful') { this.cows = this.cows.filter(x => x !== c); this.led.delete(c.id); this.drop(c.position); continue; }
      if (ledNow && this.opts.breakOn?.includes(this.legs) && label === 'goto careful') {
        // caught on something as the bot went on: left 13 back the way it came, past what the lead holds
        const back = horiz(from, this.me) ? { x: (from.x - this.me.x) / horiz(from, this.me), z: (from.z - this.me.z) / horiz(from, this.me) } : { x: 1, z: 0 };
        c.position = { x: this.me.x + back.x * 13, y: c.position.y, z: this.me.z + back.z * 13 };
        this.opts.breakOn = this.opts.breakOn.filter(n => n !== this.legs);
      } else if (ledNow) {
        // after the bot on the lead, straight, to 2 off it (`lag`), as far as a fence lets it
        if (!this.closeIn(c)) this.pull(c, this.opts.lag ?? 2);
      } else if (this.held && ['wheat'].includes(this.held) && horiz(c.position, this.me) <= 10 && !c.baby) {
        // after the bot to 2.5 off it tempted, its own way round, through the gates (a shut one stops it at the fence)
        const w = this.way(c.position, this.me, false);
        if (w) { const len = this.length(w); if (len > 2.5) c.position = this.along(w, len - 2.5); }
      } else if (this.opts.graze === c.id && !this.grazed.has(c.id) && horiz(c.position, this.me) <= 8) {
        this.grazed.add(c.id);
        c.position = { ...c.position, x: c.position.x + 12 };
      }
      if (ledNow && horiz(c.position, this.me) > 12) {
        this.led.delete(c.id);
        c.leashed = false;
        this.drop(c.position);
        this.log.push(`the lead breaks (the cow ${Math.round(horiz(c.position, this.me))} off)`);
      }
    }
    for (const d of [...this.drops]) if (horiz(d.position, this.me) <= 1.5) { this.drops = this.drops.filter(x => x !== d); this.add(d.item, 1); this.log.push(`picks up a ${d.item}`); }
  }

  drop(at: Pos) {
    if (!this.opts.dropsLost) this.drops.push({ id: this.nextDrop++, item: 'lead', position: { ...at } });
  }

  /**
   * A straight walk from inside the pen at a point past its fence: the bot ends pressed against the fence, its middle
   * as near the point as the posts let it, 0.075 into the fence's own cells (its box 0.6 wide, a post 0.25), and picks
   * up what is within 1.5 of it there.
   */
  press(to: Pos) {
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    this.me = { x: clamp(to.x, PEN.x + 0.925, PEN.x + PEN.width - 1 + 0.075), y: this.me.y, z: clamp(to.z, PEN.z + 0.925, PEN.z + PEN.length - 1 + 0.075) };
    this.stood.push({ ...this.me });
    for (const d of [...this.drops]) if (horiz(d.position, this.me) <= 1.5) { this.drops = this.drops.filter(x => x !== d); this.add(d.item, 1); this.log.push(`picks up a ${d.item}`); }
  }

  ctx(world: WorldMemory, signal: AbortSignal = new AbortController().signal, said: string[] = []): GoalContext {
    const at = (a: Record<string, unknown>): Pos => ({ x: Number(a.x), y: Number(a.y), z: Number(a.z) });
    const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
    // (as tools.ts: once the brain gives a run up, every call it makes fails at once; its tidy-up runs outside the run)
    const given = () => !!brainRun.getStore()?.signal.aborted;
    return {
      s: look(this.items), world, signal,
      progress: text => { said.push(text); },
      gain: () => undefined,
      status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...this.me }, dimension: 'overworld' }),
      call: (async (method: string, p: Record<string, unknown> = {}) => {
        if (given()) throw new Error('aborted: the brain gave this job up');
        if (method === 'inventory') return { items: this.items.map(i => ({ ...i })) };
        if (method === 'world.entities') {
          const max = Number(p.maxDistance ?? 32);
          if (p.type === 'item') return { entities: this.drops.filter(d => Math.hypot(d.position.x - this.me.x, d.position.z - this.me.z) <= max).map(d => ({ id: d.id, name: 'item', category: 'misc', item: d.item, count: 1, position: { ...d.position }, distance: horiz(d.position, this.me) })) };
          const shown = (c: Cow) => {
            if (!this.led.has(c.id)) return !!c.leashed;
            const left = this.unshown.get(c.id) ?? 0;
            if (left > 0) { this.unshown.set(c.id, left - 1); return false; }
            return true;
          };
          const seen = this.cows.map(c => ({ ...c, category: 'creature', position: { ...c.position }, distance: Math.round(horiz(c.position, this.me) * 100) / 100, ...(shown(c) ? { leashed: true } : {}) }))
            .filter(e => e.distance <= max).sort((a, b) => a.distance - b.distance);
          // the bot stands: a led one that lags is pulled in, 2 a look, to 2 off it, as far as a fence lets it
          if (this.led.size) this.ledLooks.push({ ...this.me });
          for (const c of this.cows) if (this.led.has(c.id) && !this.closeIn(c, 2)) this.pull(c, 2, 2);
          return { entities: seen };
        }
        if (method === 'useOn') {
          // the bridge's own click: within 4.5 of the eye or not at all, and no walk
          const g = at(p);
          const d = horiz(mid(g), this.me);
          if (d > 4.5) return { used: false, reason: 'too far', distance: d };
          this.open.set(k(g), !this.isOpen(g));
          this.opened.delete(k(g));
          this.log.push(`useOn ${k(g)}`);
          return { used: true };
        }
        if (method === 'world.region') {
          const [w, h, l] = [p.width, p.height, p.length].map(n => Number(n ?? 1));
          if (!this.opts.solid || w * h * l === 1) return { blocks: [`oak_fence_gate[facing=south,open=${this.isOpen(at(p))}]`] };
          // (x fastest, then z, then y)
          const o = at(p);
          return { blocks: Array.from({ length: w * h * l }, (_, i) => this.opts.solid![`${o.x + i % w},${o.y + Math.floor(i / (w * l))},${o.z + Math.floor(i / w) % l}`] ?? 'air') };
        }
        if (method === 'item.select') {
          if (!this.count(String(p.name))) throw new Error(`no ${p.name} in inventory`);
          this.held = String(p.name);
          return { held: p.name };
        }
        if (method === 'sprint.set') { this.sprint = !!p.allowed; this.log.push(`sprint ${p.allowed ? 'on' : 'off'}`); return { allowed: p.allowed }; }
        if (method === 'gates.auto') {
          // (off, it forgets what it took as the bot's: Gates.java; on again, it takes only what opens from then on)
          this.gatesAuto = !!p.enabled;
          if (!p.enabled) this.opened.clear();
          this.log.push(`gates.auto ${p.enabled ? 'on' : 'off'}`);
          return { enabled: p.enabled };
        }
        if (method === 'foreign.zones') {
          const r = this.opts.scanReveals;
          const c = r && this.cows.find(x => x.id === r.id);
          if (c && horiz(c.position, this.me) <= 48) c.buildDistance = r.buildDistance;
          return { zones: [] };
        }
        if (method === 'goto') {
          this.careful.push(!!p.careful);
          const to = p.xz ? { x: Number(p.x) + 0.5, y: 63, z: Number(p.z) + 0.5 } : mid(at(p));
          this.log.push(`goto ${p.careful ? 'careful ' : ''}${Math.floor(to.x)},${Math.floor(to.z)}`);
          const caveColumn = Math.floor(to.x) === -549 && Math.floor(to.z) >= 2103 && Math.floor(to.z) <= 2151 && horiz(this.me, to) > 16;
          if (this.opts.caves && p.xz && ((this.pastYard(this.me) && !this.pastYard(to)) || caveColumn)) {
            this.me = { x: -535.5, y: 21, z: 2155.5 };
            this.under = { ...this.me };
            this.log.push('down a cave under the yard');
            return { arrived: false };
          }
          // a gate nobody gets through: the walk out through it stops at it, inside
          const shut = YARD_GATES.find(g => this.opts.blocked?.includes(`${g.x},${g.z}`) && this.pastYard(this.me) && !this.pastYard(to) && horiz(mid(g), to) <= 3);
          if (shut) { this.walk({ x: shut.x + 0.5 + (mid(HOME).x - shut.x - 0.5) * 2 / horiz(mid(shut), mid(HOME)), y: 63, z: shut.z + 0.5 + (mid(HOME).z - shut.z - 0.5) * 2 / horiz(mid(shut), mid(HOME)) }, 'goto careful'); return { arrived: false }; }
          if (p.xz && this.opts.stopShort === ++this.sideWalks) {
            // stopped 10 short (water, a cliff), and says so
            const d = horiz(this.me, to);
            this.walk(d > 10 ? { x: to.x + (this.me.x - to.x) * 10 / d, y: 63, z: to.z + (this.me.z - to.z) * 10 / d } : { ...this.me }, p.careful ? 'goto careful' : 'goto');
            return { arrived: false };
          }
          // with an animal on the lead, a walk to within 1 of a cell ends as Baritone's GoalNear does: at the first cell
          // within 1 of it, the one on the bot's side (a walk to the cell 1 inside a gate from outside stood in the gateway)
          const near = this.led.size && !p.xz && Number(p.range ?? 1) === 1 && horiz(this.me, to) > 1
            ? [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: to.x + dx, y: to.y, z: to.z + dz })).sort((a, b) => horiz(a, this.me) - horiz(b, this.me))[0] : to;
          this.walk(near, p.careful ? 'goto careful' : 'goto');
          if (this.opts.abortOn && this.legs === this.opts.abortOn.leg) { this.opts.abortOn.abort(); }
          const hold = this.opts.holdNear;
          if (hold && this.led.size && horiz(this.me, mid(HOME)) <= hold.within) { this.opts.holdNear = undefined; hold.at?.(); await hold.until; }
          return { arrived: true };
        }
        if (method === 'steer') {
          // straight at the point, no pathfinding (the stand-in knows no fence in the way of one)
          this.steers.push({ within: p.within === undefined ? undefined : Number(p.within), sneak: p.sneak === true });
          this.walk({ x: Number(p.x), y: Number(p.y), z: Number(p.z) }, 'steer');
          this.log.push(`steer ${Math.floor(Number(p.x))},${Math.floor(Number(p.z))}`);
          return { reached: true };
        }
        if (method === 'entity.use') {
          if (p.item) {
            if (!this.count(String(p.item))) throw new Error(`no ${p.item} in inventory`);
            this.held = String(p.item);
          }
          const c = this.cows.find(x => x.id === Number(p.id));
          if (!c) throw new Error(`no entity with id ${p.id} nearby`);
          const d = horiz(c.position, this.me);
          if (d > 4.5) throw new Error(`too far: ${Math.round(d * 10) / 10} blocks to the cow (max 4.5)`);
          this.log.push(`entity.use #${c.id}${p.item ? ` ${p.item}` : ''}`);
          // the game: a mob on this player's lead comes off whatever is in hand (but shears or a name tag), and the
          // lead falls where it stands; with a lead in hand, on it goes, off anything else's lead (a fence post's knot)
          if (this.led.has(c.id) && this.held !== 'name_tag') { this.led.delete(c.id); c.leashed = false; this.drop(c.position); return { result: 'Success', success: true }; }
          if (this.held === 'lead') {
            c.leashed = false; this.led.add(c.id); this.take('lead', 1);
            if (this.opts.showsLate) this.unshown.set(c.id, this.opts.showsLate);
            return { result: 'Success', success: true };
          }
          if (this.held === 'wheat' && !c.baby) {
            // fed to breed: the client says Consume for food on an adult, whatever the server makes of it. In love
            // unless fed within the game's 5 min, and two in love within 8 of each other make a calf between them
            const now = Date.now();
            if (now - (this.bred.get(c.id) ?? -Infinity) >= 5 * MINUTE) { this.inLove.add(c.id); this.bred.set(c.id, now); this.take('wheat', 1); }
            const pair = [...this.inLove].map(id => this.cows.find(x => x.id === id)).filter((x): x is Cow => !!x);
            if (pair.length >= 2 && horiz(pair[0].position, pair[1].position) <= 8) {
              this.cows.push({ id: this.nextCalf++, name: 'cow', position: { ...pair[0].position }, baby: true });
              for (const x of pair.slice(0, 2)) this.inLove.delete(x.id);
              this.log.push('a calf is born');
            }
            return { result: 'Consume', success: true };
          }
          return { result: 'Pass', success: false };
        }
        return {};
      }) as GoalContext['call'],
      act: async (tool, a = {}) => {
        if (given()) throw new Error('aborted: the brain gave this job up');
        this.log.push(tool === 'take-from-chest' || tool === 'craft-item' ? `${tool} ${a.item ?? a.outputItem} ${a.count ?? a.amount}` : `${tool}${tool === 'use-item-on-block' ? ` ${k(at(a))}` : ''}`);
        if (tool === 'go-home') { this.walk(mid(HOME), 'go-home'); return { ok: true, text: 'Home' }; }
        if (tool === 'move-to-position') {
          const target = at(a);
          const r = Number(a.range ?? 1);
          const d = horiz(this.me, target);
          // to within `range` of it, on the line from where the bot stands
          const stop = (n: number) => (d > n ? { x: target.x + (this.me.x - target.x) * n / d, y: target.y, z: target.z + (this.me.z - target.z) * n / d } : { ...this.me });
          if (this.opts.shortOnce && !this.walkedTo) {
            this.walkedTo = true;
            this.walk(stop(r + 4), 'move');
            return { ok: false, text: `Could not reach ${fmt(target)}: no path found. Stopped ${r + 4} blocks away.` };
          }
          this.walkedTo = true;
          this.walk(stop(r), 'move');
          return { ok: true, text: `Successfully moved to position near ${fmt(target)}` };
        }
        if (tool === 'use-item-on-block') {
          const g = at(a);
          // (out of reach, it walks to within 3 on the bot's side of it: tools.ts goNear, a plain goto, not careful)
          const d = horiz(mid(g), this.me);
          if (d > 4.5) {
            const to = { x: mid(g).x + (this.me.x - mid(g).x) * 3 / d, y: this.me.y, z: mid(g).z + (this.me.z - mid(g).z) * 3 / d };
            this.log.push(`goto ${Math.floor(to.x)},${Math.floor(to.z)}`);
            this.walk(to, 'goto');
          }
          this.open.set(k(g), !this.isOpen(g));
          this.opened.delete(k(g));
          if (this.opts.abortOnOpen && k(this.opts.abortOnOpen.gate) === k(g) && this.isOpen(g)) this.opts.abortOnOpen.abort();
          return { ok: true, text: `Used the held item on oak_fence_gate at ${fmt(g)}` };
        }
        if (tool === 'take-from-chest') {
          const c = this.chests[k(at(a))] ??= {};
          const item = String(a.item);
          const n = Math.min(Number(a.count), c[item] ?? 0);
          c[item] = (c[item] ?? 0) - n;
          if (!c[item]) delete c[item];
          if (n) this.add(item, n);
          const holds = Object.entries(c).map(([i, m]) => `${i} x${m}`).join(', ') || 'nothing';
          return { ok: true, text: `Took ${n} ${item} from the chest at ${fmt(at(a))}. It holds: ${holds}.` };
        }
        if (tool === 'attack-entity') {
          // the fight: Baritone's own walk up to it (through what it passes, opening gates), the kill, the drops where
          // it fell (opts.cullDrops); then, unless `collect: false`, picked up as tools.ts does it: a walk to each, and
          // to one in a fence's cell, from inside the pen, the straight walk at it that ends pressed into the fence
          const c = this.cows.find(x => `#${x.id}` === a.target && horiz(x.position, this.me) <= Number(a.maxDistance ?? 16));
          if (!c) return { ok: true, text: `No ${a.target} within ${a.maxDistance ?? 16} blocks` };
          this.walk({ ...c.position }, 'fight');
          this.cows = this.cows.filter(x => x !== c);
          this.log.push(`killed #${c.id}`);
          const fell = this.opts.cullDrops?.(c) ?? ['leather', 'beef', 'beef'].map(item => ({ item, position: { ...c.position } }));
          const dropped = fell.map(f => ({ id: this.nextDrop++, item: f.item, position: { ...f.position } }));
          this.drops.push(...dropped);
          if (a.collect !== false) {
            for (const d of dropped) {
              if (!this.drops.includes(d) || horiz(d.position, c.position) > 3) continue;
              if (this.fenceAt(Math.floor(d.position.x), Math.floor(d.position.z)) && this.inPenBox(this.me)) this.press(d.position);
              else this.walk({ ...d.position }, 'drop');
            }
          }
          return { ok: true, text: 'Killed cow with 2 swing(s), 2 landed (diamond_sword x2) in 1s. Health 20/20, food 20/20.' };
        }
        if (tool === 'craft-item' && a.outputItem === 'lead') {
          // the game's recipe, not the brain's table (26.3's data/minecraft/recipe/lead.json: five string, two leads):
          // this fake once took the brain's 4 string and a slime ball, and passed while the game crafted none
          const times = Number(a.amount ?? 1);
          const have = this.count('string');
          if (have < 5 * times) return { ok: false, text: `missing ingredients for lead: needs string x${5 * times - have} (have ${have})` };
          this.take('string', 5 * times);
          this.add('lead', 2 * times);
          return { ok: true, text: `Successfully crafted lead ${times} time(s)` };
        }
        return { ok: false, text: `no ${tool} here` };
      }
    };
  }
}

const cow = (id: number, x: number, z: number, over: Partial<Cow> = {}): Cow => ({ id, name: 'cow', position: { x: x + 0.5, y: 63, z: z + 0.5 }, ...over });
const rung = (name: string): WorkTask => LADDER.find(t => t.name === name)!;
const goalOf = (task: WorkTask, clock: { now: number }) => workGoals(() => undefined, [task], () => clock.now)[0];
/** the pen's inside, off its fence */
const penned = (c: Cow) => c.position.x >= PEN.x + 1 && c.position.x < PEN.x + PEN.width - 1 && c.position.z >= PEN.z + 1 && c.position.z < PEN.z + PEN.length - 1;

function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
}

// ---- the fetch on a lead

test('a wild cow is put on a lead and walked in: through the yard\'s gate (shut behind it), off the lead inside, the lead picked up, the gate shut', async (t) => {
  // a cow 80 east of home, out past the yard's east gate: not in sight from home (48), seen from the second stop
  const world = liveWorld();
  const herd = [cow(7, -469, 2183)];
  const pa = new Pasture(herd, world, KIT);
  const said: string[] = [];
  const r = await fetchForPens(pa.ctx(world, undefined, said), 'east', { now: () => T0 });
  t.deepEqual(r, { gain: 1, text: 'cow: on the lead from 81 out; led in' });
  t.true(penned(herd[0]), JSON.stringify(herd[0].position));
  // two leads from the chests (none was carried: two are kept on hand), one on it and off it in the pen, both carried
  t.true(pa.log.includes('take-from-chest lead 2'));
  t.deepEqual(pa.log.filter(l => l.startsWith('entity.use')), ['entity.use #7 lead', 'entity.use #7']);
  t.is(pa.count('lead'), 2);
  t.deepEqual(pa.drops, []);
  // every walk on the lead is careful (walk only), none sprinting; the client's closer was off from the yard's gate on
  // and is on again, and the sprint
  t.true(pa.log.indexOf('sprint off') < pa.log.indexOf('entity.use #7 lead'));
  const onLead = pa.log.slice(pa.log.indexOf('entity.use #7 lead'), pa.log.indexOf('entity.use #7'));
  t.true(onLead.filter(l => l.startsWith('goto')).every(l => l.startsWith('goto careful')), onLead.join('\n'));
  t.deepEqual(pa.log.slice(-2), ['sprint on', 'gates.auto on']);
  // the yard's east gate: Baritone opened it on the way out (the closer shut it behind), and on the way in with the
  // cow behind, the bot shut it once the cow was through; the pen's gate opened for them and shut behind the bot
  t.false(pa.isOpen(YARD_GATES[1]));
  t.false(pa.isOpen(GATE));
  t.deepEqual(pa.log.filter(l => l.startsWith('use-item-on-block')), [`use-item-on-block ${k(YARD_GATES[1])}`, `use-item-on-block ${k(GATE)}`, `use-item-on-block ${k(GATE)}`]);
  t.false(pa.log.includes('the closer shuts -533,63,2183') && pa.log.lastIndexOf('the closer shuts -533,63,2183') > pa.log.indexOf('entity.use #7 lead'), 'the closer never shut it on the cow');
  // what it saw and did is written down: the pen holds one now, and the place it was seen is forgotten
  t.like(penCount(world, 'cow'), { adults: 1, babies: 0, at: T0 });
  t.deepEqual(sitesOf(world, 'cow'), []);
  t.true(said.includes('looking east for wild cows, 32 blocks out'));
  t.true(said.includes('fetching a cow for the pen: 48 blocks off, 81 from home'));
});

test('the walk to the cow ending a few blocks short still gets the lead on (live: "no path found ... 3.61 blocks away"), and one that grazed on is closed in on', async (t) => {
  const world = liveWorld();
  const herd = [cow(7, -503, 2183)];
  const pa = new Pasture(herd, world, KIT, { shortOnce: true });
  t.deepEqual(await fetchForPens(pa.ctx(world), 'east', { now: () => T0 }), { gain: 1, text: 'cow: on the lead from 47 out; led in' });
  const grazing = [cow(8, -503, 2183)];
  const pb = new Pasture(grazing, liveWorld(), KIT, { graze: 8 });
  t.deepEqual(await fetchForPens(pb.ctx(liveWorld()), 'east', { now: () => T0 }), { gain: 1, text: 'cow: on the lead from 59 out; led in' });
  t.true(penned(grazing[0]));
});

test('a lead that breaks is picked up and said where: put on again once, and a second break ends the fetch', async (t) => {
  // caught on something on the third leg: the lead breaks, falls by the cow, is picked up, and goes on again
  const world = liveWorld();
  const herd = [cow(7, -469, 2183)];
  const pa = new Pasture(herd, world, KIT, { breakOn: [3] });
  const once = await fetchForPens(pa.ctx(world), 'east', { now: () => T0 });
  t.deepEqual(once, { gain: 1, text: 'cow: on the lead from 81 out; the lead broke 73 from the gate (the cow 13 off), put on again; led in' });
  t.true(penned(herd[0]));
  t.is(pa.count('lead'), 2);
  // twice: the second time the fetch ends where it broke, the lead picked up; where the cow stood is kept for next time
  const w2 = liveWorld();
  const h2 = [cow(7, -469, 2183)];
  const pb = new Pasture(h2, w2, KIT, { breakOn: [3, 9] });
  const twice = await fetchForPens(pb.ctx(w2), 'east', { now: () => T0 });
  // (a cow found and not brought in: the side holds cows, and its next try waits a first mark's time, mark 'first')
  t.deepEqual(twice, { gain: 0, text: 'cow: on the lead from 81 out; the lead broke 73 from the gate (the cow 13 off), put on again; the lead broke 62 from the gate (the cow 13 off); the lead picked up', mark: 'first' });
  t.is(pb.count('lead'), 2);
  t.deepEqual(pb.drops, []);
  t.deepEqual(sitesOf(w2, 'cow').map(p => k(p)), [k({ x: Math.floor(h2[0].position.x), y: 63, z: Math.floor(h2[0].position.z) })]);
  // a lead that fell where it cannot be seen: said so
  const w3 = liveWorld();
  const pc = new Pasture([cow(7, -469, 2183)], w3, KIT, { breakOn: [3], dropsLost: true });
  t.deepEqual(await fetchForPens(pc.ctx(w3), 'east', { now: () => T0 }), { gain: 0, text: 'cow: on the lead from 81 out; the lead broke 73 from the gate (the cow 13 off); the lead not found where it fell', mark: 'first' });
  // and a cow gone on the way (killed): where it was last seen
  const w4 = liveWorld();
  const pd = new Pasture([cow(7, -469, 2183)], w4, KIT, { vanishOn: 2 });
  t.deepEqual(await fetchForPens(pd.ctx(w4), 'east', { now: () => T0 }),
    { gain: 0, text: 'cow: on the lead from 81 out; lost on the way (last seen 2 off at (-473, 63, 2183)); the lead picked up', mark: 'first' });
});

test('a fetch cut short with the cow on the lead lets go of it, and puts the gates and the sprint back', async (t) => {
  const world = liveWorld();
  const herd = [cow(7, -469, 2183)];
  const ac = new AbortController();
  const pa = new Pasture(herd, world, KIT, { abortOn: { leg: 4, abort: () => ac.abort() } });
  await t.throwsAsync(fetchForPens(pa.ctx(world, ac.signal), 'east', { now: () => T0 }), { message: 'aborted' });
  // off the lead where it stood (nothing walked to after: the run is given up), the client's switches as they were
  t.deepEqual(pa.log.filter(l => l.startsWith('entity.use')), ['entity.use #7 lead', 'entity.use #7']);
  t.is(pa.led.size, 0);
  // (cut short before the yard's gate: the client's closer was never turned off)
  t.deepEqual(pa.log.slice(-2), ['entity.use #7', 'sprint on']);
  t.true(pa.gatesAuto && pa.sprint);
  // cut short past it, on the way to the pen: the closer is on again too
  const w2 = liveWorld();
  const ac2 = new AbortController();
  const pb = new Pasture([cow(7, -469, 2183)], w2, KIT, { abortOn: { leg: 18, abort: () => ac2.abort() } });
  await t.throwsAsync(fetchForPens(pb.ctx(w2, ac2.signal), 'east', { now: () => T0 }), { message: 'aborted' });
  t.true(pb.log.includes('gates.auto off'));
  t.deepEqual(pb.log.slice(-3), ['entity.use #7', 'sprint on', 'gates.auto on']);
  t.is(pb.led.size, 0);
});

test('a fetch that ends past the yard\'s gate, short of the pen, shuts that gate behind it: lost on the way, the lead broken twice', async (t) => {
  // live, the closer is off from the yard's gate on, and an already open gate is never taken as the bot's once it is
  // on again: the gate stood open until the shelter's dusk sweep. Legs 16 and 17 are just past the east gate
  const w1 = liveWorld();
  const p1 = new Pasture([cow(7, -469, 2183)], w1, KIT, { vanishOn: 16 });
  const lost = await fetchForPens(p1.ctx(w1), 'east', { now: () => T0 });
  t.regex(lost.text, /^cow: on the lead from 81 out; lost on the way \(last seen 2 off at \(-5[23]\d, 63, 2183\)\)/);
  t.false(p1.isOpen(YARD_GATES[1]), p1.log.join('\n'));
  t.true(p1.gatesAuto);
  const w2 = liveWorld();
  const p2 = new Pasture([cow(7, -469, 2183)], w2, KIT, { breakOn: [16, 17] });
  const broke = await fetchForPens(p2.ctx(w2), 'east', { now: () => T0 });
  t.regex(broke.text, /the lead broke \d+ from the gate \(the cow 13 off\), put on again; the lead broke \d+ from the gate \(the cow 13 off\); the lead picked up$/);
  t.false(p2.isOpen(YARD_GATES[1]), p2.log.join('\n'));
  // and walked up to carefully: from the lead on, no plain walk (use-item-on-block's own, to a gate out of reach)
  t.false(p2.log.slice(p2.log.indexOf('entity.use #7 lead')).some(l => /^goto -/.test(l)), p2.log.join('\n'));
});

test('a fetch the brain gives up in the pen\'s gateway: the cow let go, the pen\'s gate clicked shut from where the bot stands', async (t) => {
  // live, every call of the run fails once the brain gives it up: the shut after the walk across the pen never came
  const world = liveWorld();
  const ac = new AbortController();
  const pa = new Pasture([cow(7, -503, 2183)], world, KIT, { abortOnOpen: { gate: GATE, abort: () => ac.abort() } });
  const ctx = pa.ctx(world, ac.signal);
  await t.throwsAsync(brainRun.run({ signal: ac.signal }, () => fetchForPens(ctx, 'east', { now: () => T0 })), { message: /aborted/ });
  t.false(pa.isOpen(GATE), pa.log.join('\n'));
  t.true(pa.log.includes(`useOn ${k(GATE)}`), pa.log.join('\n'));
  t.is(pa.led.size, 0);
  t.true(pa.gatesAuto && pa.sprint);
});

test('a fetch the brain gives up on its first leg in past the yard\'s gate, before the gate is shut behind the cow: the gate clicked shut from where the bot stands, in reach', async (t) => {
  // after the pass the cow stands in the gateway, and the gate can be shut only once the bot is a leg further in: from
  // 6 in a run given up there clicked from out of reach (6, against 4.5), and the gate stood open till the dusk sweep
  const world = liveWorld();
  const ac = new AbortController();
  const pa = new Pasture([cow(7, -503, 2183)], world, KIT);
  const base = pa.ctx(world, ac.signal);
  const call = (async (method: string, p?: Record<string, unknown>, ms?: number) => {
    const r = await base.call(method, p, ms);
    if (method === 'goto' && pa.led.size && pa.me.x < -535.5 && pa.me.x > -541 && Math.floor(pa.me.z) === 2183) ac.abort();
    return r;
  }) as GoalContext['call'];
  await t.throwsAsync(brainRun.run({ signal: ac.signal }, () => fetchForPens({ ...base, call }, 'east', { now: () => T0 })), { message: /aborted/ });
  t.false(pa.isOpen(YARD_GATES[1]), pa.log.join('\n'));
  t.true(pa.log.includes(`useOn ${k(YARD_GATES[1])}`), pa.log.join('\n'));
  t.is(pa.led.size, 0);
  t.true(pa.gatesAuto && pa.sprint);
  // not given up, the walk to 4 in ending a little past the cell's middle (Baritone's to a block): clicked from there,
  // in reach, no walk back toward the gate past the cow
  const w2 = liveWorld();
  const pb = new Pasture([cow(7, -503, 2183)], w2, KIT);
  const b2 = pb.ctx(w2);
  const call2 = (async (method: string, p?: Record<string, unknown>, ms?: number) => {
    const r = await b2.call(method, p, ms);
    if (method === 'goto' && pb.led.size && p?.x === -537 && p?.z === 2183) pb.me = { ...pb.me, x: pb.me.x - 0.35 };
    return r;
  }) as GoalContext['call'];
  t.deepEqual(await fetchForPens({ ...b2, call: call2 }, 'east', { now: () => T0 }), { gain: 1, text: 'cow: on the lead from 47 out; led in' });
  const click = pb.log.indexOf(`use-item-on-block ${k(YARD_GATES[1])}`);
  t.is(pb.log.slice(0, click).filter(l => l.startsWith('goto')).at(-1), 'goto careful -537,2183', pb.log.join('\n'));
});

test('a fetch given up with the cow lagging on the lead: it closes in as the bot stands, and comes off the lead', async (t) => {
  // live, a 4-block leg leaves a led cow up to 6 behind, past the 4.5 the use key reaches: one use at once left it on
  // the lead, dragged after whatever the bot did next
  const world = liveWorld();
  const ac = new AbortController();
  const pa = new Pasture([cow(7, -469, 2183)], world, KIT, { lag: 6, abortOn: { leg: 3, abort: () => ac.abort() } });
  const ctx = pa.ctx(world, ac.signal);
  await t.throwsAsync(brainRun.run({ signal: ac.signal }, () => fetchForPens(ctx, 'east', { now: () => T0 })), { message: /aborted/ });
  t.is(pa.led.size, 0, pa.log.join('\n'));
  t.deepEqual(pa.log.filter(l => l.startsWith('entity.use')), ['entity.use #7 lead', 'entity.use #7']);
  // nothing walked to after the run was given up
  t.deepEqual(pa.log.slice(pa.log.lastIndexOf('entity.use #7 lead')).filter(l => /^goto/.test(l)).length, 3);
  // and with the run going on, the lagging cow is waited for after each leg (heelLead) and comes in
  const w2 = liveWorld();
  const pb = new Pasture([cow(7, -469, 2183)], w2, KIT, { lag: 6 });
  t.deepEqual(await fetchForPens(pb.ctx(w2), 'east', { now: () => T0 }), { gain: 1, text: 'cow: on the lead from 81 out; led in' });
});

test('a lead the client is slow to show: the fetch says so, and takes it off again before it walks home with the cow behind', async (t) => {
  const world = liveWorld();
  const pa = new Pasture([cow(7, -503, 2183)], world, KIT, { showsLate: 5 });
  const r = await fetchForPens(pa.ctx(world), 'east', { now: () => T0 });
  t.deepEqual(r, { gain: 0, text: 'cow: would not take the lead (the client used the lead on it, but it did not show on a lead)', mark: 'first' });
  t.is(pa.led.size, 0, pa.log.join('\n'));
  t.is(pa.count('lead'), 2, 'the lead picked up again');
  t.deepEqual(pa.drops, []);
});

test('a fetch given up just as the lead goes on (the next look refused): the cow comes off the lead all the same, also when the client shows it late', async (t) => {
  // the brain gives the run up while entity.use with the lead is under way (survival, the LLM, a higher chore: the run
  // is not yet walking the cow home): the bridge's use still goes through, the next look is refused, and leashOn throws
  for (const showsLate of [0, 1]) {
    const world = liveWorld();
    const ac = new AbortController();
    const pa = new Pasture([cow(7, -503, 2183)], world, KIT, { showsLate });
    const ctx = pa.ctx(world, ac.signal);
    const call = ctx.call;
    ctx.call = (async (method: string, p?: Record<string, unknown>) => {
      const r = await call(method, p);
      if (method === 'entity.use' && p?.item === 'lead') ac.abort();
      return r;
    }) as GoalContext['call'];
    await t.throwsAsync(brainRun.run({ signal: ac.signal }, () => fetchForPens(ctx, 'east', { now: () => T0 })), { message: /aborted/ });
    t.is(pa.led.size, 0, `showsLate ${showsLate}: ${pa.log.join('\n')}`);
    t.deepEqual(pa.log.filter(l => l.startsWith('entity.use')), ['entity.use #7 lead', 'entity.use #7'], `showsLate ${showsLate}`);
    t.true(pa.sprint);
  }
});

// (serial: ledBy is the module's, and the fetches of the tests that run at once set it too)
test.serial('the walk back to shut the yard\'s gate behind a fetch that ended short is the walk\'s too: only survival may cut it until the gate is shut', async (t) => {
  // live, ledBy was cleared before the finally walked back to the gate: a chore more urgent than the pens round's
  // stray fetch cut in on that walk, and the gate stood open until the dusk sweep
  const world = liveWorld();
  const pa = new Pasture([cow(7, -469, 2183)], world, KIT, { breakOn: [16, 17] });
  const ctx = pa.ctx(world);
  const call = ctx.call, act = ctx.act;
  const seen: string[] = [];
  ctx.call = (async (method: string, p?: Record<string, unknown>) => {
    if (method === 'goto') seen.push(`goto ${p!.x},${p!.z}: ${afield.ledBy === ctx.signal ? 'led' : 'free'}`);
    return call(method, p);
  }) as GoalContext['call'];
  ctx.act = async (tool, a = {}) => {
    if (tool === 'use-item-on-block') seen.push(`click ${a.x},${a.z}: ${afield.ledBy === ctx.signal ? 'led' : 'free'}`);
    return act(tool, a);
  };
  const r = await fetchForPens(ctx, 'east', { now: () => T0 });
  t.regex(r.text, /the lead broke \d+ from the gate \(the cow 13 off\); the lead picked up$/);
  // after the second break (the lead picked up): back to 2 from the east gate, and the click, both still the walk's
  t.deepEqual(seen.slice(-2), ['goto -531,2183: led', 'click -533,2183: led']);
  t.false(pa.isOpen(YARD_GATES[1]));
  // and once the run is done, nothing is held
  t.is(afield.ledBy, undefined);
});

test('the fetch keeps to the cow range: a cow seen 255 out that grazes on past it is not followed', async (t) => {
  const world = liveWorld();
  const pa = new Pasture([cow(7, -294, 2183)], world, KIT, { graze: 7 });
  t.deepEqual(await fetchForPens(pa.ctx(world), 'east', { now: () => T0 }), { gain: 0, text: 'cow: it wandered past the cow range', mark: 'first' });
  t.true(pa.farthest <= 256, `${pa.farthest}`);
  t.false(pa.log.some(l => l.startsWith('entity.use')));
});

test('the walks out along a side are careful in and by the yard, plain beyond it; one that stops short looks from there; a run out of time says how far it looked', async (t) => {
  // north: 32 out is inside the yard and 64 out the north gate itself, nothing to look for there: out through the
  // north gate (2 in, 2 out), and the walk from there to 96 starts by the fence; on, plain, to the cow range's last
  // stop, 240 out
  const w1 = liveWorld();
  const p1 = new Pasture([], w1, KIT);
  t.deepEqual(await fetchForPens(p1.ctx(w1), 'north', { now: () => T0 }), { gain: 0, text: 'no wild cows north within the cow range (256 from home)' });
  t.deepEqual(p1.log.filter(l => l.startsWith('goto')),
    ['goto careful -549,2121', 'goto careful -549,2117', 'goto careful -549,2087', 'goto -549,2055', 'goto -549,2023', 'goto -549,1991', 'goto -549,1959', 'goto -549,1943']);
  // east: out through the east gate, then careful by the fence on the first leg, then plain
  const w2 = liveWorld();
  const p2 = new Pasture([], w2, KIT);
  await fetchForPens(p2.ctx(w2), 'east', { now: () => T0 });
  t.deepEqual(p2.log.filter(l => l.startsWith('goto')),
    ['goto careful -535,2183', 'goto careful -531,2183', 'goto careful -517,2183', 'goto -485,2183', 'goto -453,2183', 'goto -421,2183', 'goto -389,2183', 'goto -357,2183', 'goto -325,2183', 'goto -309,2183']);
  // the second walk out stops 10 short: looked round from there, and no further
  const w3 = liveWorld();
  const p3 = new Pasture([], w3, KIT, { stopShort: 2 });
  t.deepEqual(await fetchForPens(p3.ctx(w3), 'east', { now: () => T0 }), { gain: 0, text: 'no wild cows east within the cow range: got no further than 55 blocks out' });
  // the run's time out after the first stop: not "none within the leash", and its mark's count stays
  const w4 = liveWorld();
  let asked = 0;
  t.deepEqual(await fetchForPens(new Pasture([], w4, KIT).ctx(w4), 'east', { now: () => T0, enough: () => asked++ > 0 }),
    { gain: 0, text: 'no wild cows seen east as far as 32 blocks out: the run\'s time ran out', mark: 'same' });
  // where one was seen within the yard's edge, walked to carefully
  const w5 = liveWorld({ work: { dry: {}, next: {}, sites: { cow: [{ x: -540, y: 63, z: 2130 }] }, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } } });
  const p5 = new Pasture([], w5, KIT);
  t.deepEqual(await fetchForPens(p5.ctx(w5), 'in sight', { now: () => T0 }), { gain: 0, text: 'no wild cow where one was seen at (-540, 63, 2130): forgotten' });
  t.deepEqual(p5.log.filter(l => l.startsWith('goto')), ['goto careful -540,2130']);
});

test('the walks out of the yard go through a gate, careful and to its cells: none goes "any height" from inside the fence, where a cave under the yard answers it', async (t) => {
  // live on Nov 13 the cows' walk from 32 out north (inside the yard) to 64 out (the north gate itself) went down to
  // (-536, 21, 2155), 41 under the lawn. With the caves of that day under the stand-in yard: the north side out by its
  // gate, every walk inside the fence careful, never a walk to "any height" from in there, and never under the yard
  const w1 = liveWorld();
  const p1 = new Pasture([], w1, KIT, { caves: true });
  const said: string[] = [];
  t.deepEqual(await fetchForPens(p1.ctx(w1, undefined, said), 'north', { now: () => T0 }), { gain: 0, text: 'no wild cows north within the cow range (256 from home)' });
  t.is(p1.under, undefined, p1.log.join('\n'));
  t.deepEqual(p1.log.filter(l => l.startsWith('goto')).slice(0, 4), ['goto careful -549,2121', 'goto careful -549,2117', 'goto careful -549,2087', 'goto -549,2055']);
  t.deepEqual(p1.careful.slice(0, 3), [true, true, true]);
  t.true(said.includes('out of the yard by its north gate (-549, 63, 2119)'));
  // a cow seen from home, out past the east fence: the walk to it goes out by the east gate too (the walk to an
  // animal is to its own block: careful by the yard)
  const w2 = liveWorld();
  const herd = [cow(7, -510, 2190)];
  const p2 = new Pasture(herd, w2, KIT, { caves: true });
  t.deepEqual(await fetchForPens(p2.ctx(w2), 'north', { now: () => T0 }), { gain: 1, text: 'cow: on the lead from 40 out; led in' });
  t.is(p2.under, undefined);
  t.deepEqual(p2.log.filter(l => l.startsWith('goto')).slice(0, 3), ['goto careful -535,2183', 'goto careful -531,2183', 'goto careful -510,2190']);
  t.true(penned(herd[0]));
  // where one was seen outside the yard: out by the gate nearest the way there, then on
  const w3 = liveWorld({ work: { dry: {}, next: {}, sites: { cow: [{ x: -600, y: 63, z: 2183 }] }, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } } });
  const p3 = new Pasture([], w3, KIT, { caves: true });
  t.deepEqual(await fetchForPens(p3.ctx(w3), 'in sight', { now: () => T0 }), { gain: 0, text: 'no wild cow where one was seen at (-600, 63, 2183): forgotten' });
  t.is(p3.under, undefined);
  t.deepEqual(p3.log.filter(l => l.startsWith('goto')), ['goto careful -563,2183', 'goto careful -567,2183', 'goto careful -600,2183']);
  // and from outside the yard already (a bed 16 out, a fetch that ended out there), straight on: no gate to go by
  const w4 = liveWorld();
  const p4 = new Pasture([], w4, KIT, { caves: true });
  p4.me = { x: -520.5, y: 63, z: 2183.5 };
  await fetchForPens(p4.ctx(w4), 'east', { now: () => T0 });
  t.deepEqual(p4.log.filter(l => l.startsWith('goto')).slice(0, 3), ['goto careful -517,2183', 'goto -485,2183', 'goto -453,2183']);
});

test('a side whose gate lets nobody through is not walked by another gate (its walk to "any height" at the stop would find the cave), and gets a dry mark; a sighting goes by the next gate, to its own block', async (t) => {
  // the north gate blocked (a block in the gateway; live, the cells in front of it Baritone keeps out of): no other
  // gate, and no walk to 80 out north at all. Out by the west gate, the walk from there to "any height" at 80 out
  // is 82 long, and the cave under the north gate runs on under that stop: down it went
  const w1 = liveWorld();
  const p1 = new Pasture([], w1, KIT, { caves: true, blocked: ['-549,2119'] });
  const said: string[] = [];
  t.deepEqual(await fetchForPens(p1.ctx(w1, undefined, said), 'north', { now: () => T0 }), { gain: 0, text: 'no wild cows looked for north: no way out of the yard by the north gate (-549, 63, 2119)' });
  t.is(p1.under, undefined, p1.log.join('\n'));
  t.deepEqual(said.filter(l => l.startsWith('out of the yard')), ['out of the yard by its north gate (-549, 63, 2119)']);
  t.deepEqual(p1.log.filter(l => l.startsWith('goto')), ['goto careful -549,2121', 'goto careful -549,2117']);
  t.false(p1.log.some(l => /^goto (careful )?-549,2103/.test(l)), p1.log.join('\n'));
  t.true(p1.careful.every(c => c));
  // through the wrapper: a dry mark like a side with none (it waits the longer each time the gate stays shut), and the
  // turn goes on to the next side; not a held failure that comes back to north, three of which held the rung all day
  const clock = { now: T0 };
  const goal = goalOf(rung('cows'), clock);
  const w2 = liveWorld();
  const p2 = new Pasture([], w2, KIT, { caves: true, blocked: ['-549,2119'] });
  t.is(await goal.run(p2.ctx(w2)), '[north] no wild cows looked for north: no way out of the yard by the north gate (-549, 63, 2119); back home');
  t.deepEqual(workOf(w2).dry['cows:north'], { n: 1, at: T0 });
  t.is(workOf(w2).next.cows, 1);
  t.like(pick(rung('cows'), look(KIT), w2), { variant: 'east' });
  // where one was seen north of the yard, over the cave: the north gate blocked, out by the next (the west), and on
  // from there to the place's own block (careful by the yard), never to "any height" there
  const w3 = liveWorld({ work: { dry: {}, next: {}, sites: { cow: [{ x: -549, y: 66, z: 2110 }] }, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } } });
  const p3 = new Pasture([], w3, KIT, { caves: true, blocked: ['-549,2119'] });
  const xz: boolean[] = [];
  const ctx3 = p3.ctx(w3);
  const call = ctx3.call;
  ctx3.call = (async (method: string, p: Record<string, unknown> = {}, ms?: number) => {
    if (method === 'goto') xz.push(!!p.xz);
    return call(method, p, ms);
  }) as GoalContext['call'];
  t.deepEqual(await fetchForPens(ctx3, 'in sight', { now: () => T0 }), { gain: 0, text: 'no wild cow where one was seen at (-549, 66, 2110): forgotten' });
  t.is(p3.under, undefined, p3.log.join('\n'));
  t.deepEqual(p3.log.filter(l => l.startsWith('goto')), ['goto careful -549,2121', 'goto careful -549,2117', 'goto careful -563,2183', 'goto careful -567,2183', 'goto careful -549,2110']);
  t.deepEqual(xz, [false, false, false, false, false]);
  // every gate blocked: no way out on foot to where it was seen, and nothing walked to out there (no mark: untried)
  const w4 = liveWorld({ work: { dry: {}, next: {}, sites: { cow: [{ x: -600, y: 63, z: 2183 }] }, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } } });
  const p4 = new Pasture([], w4, KIT, { caves: true, blocked: YARD_GATES.map(g => `${g.x},${g.z}`) });
  const r4 = await fetchForPens(p4.ctx(w4), 'in sight', { now: () => T0 });
  t.like(r4, { gain: 0, untried: true });
  t.regex(r4.text, /^no wild cow looked for where one was seen: no way out of the yard by the west gate \(-565, 63, 2183\) or /);
  t.is(p4.under, undefined);
  t.false(p4.log.some(l => /^goto (careful )?-600,2183/.test(l)), p4.log.join('\n'));
  t.true(p4.careful.every(c => c));
});

test('no lead and none to craft: the wheat lure, which also goes right across the pen; two leads crafted from five string when none is stored', async (t) => {
  // no lead stored, 3 string: none to make one
  const world = liveWorld({}, { [k(GEAR_CHEST)]: { bucket: 8 }, [k(DROPS_CHEST)]: { leather: 7, string: 3, slime_ball: 9 } });
  const herd = [cow(7, -503, 2183)];
  const pa = new Pasture(herd, world, [...KIT, { slot: 3, name: 'wheat', count: 10 }]);
  const r = await fetchForPens(pa.ctx(world), 'east', { now: () => T0 });
  t.deepEqual(r, { gain: 1, text: 'cow: no lead to be had (short of 2 string for one): on the wheat from 47 out; led in' });
  t.true(penned(herd[0]), JSON.stringify(herd[0].position));
  t.false(pa.log.some(l => l.startsWith('entity.use')));
  // 15 string in the chests: two leads made the kit's way from five of them (the slime balls left be), one walks the
  // cow home
  const w2 = liveWorld({}, { [k(GEAR_CHEST)]: { bucket: 8 } });
  const pb = new Pasture([cow(7, -503, 2183)], w2, KIT);
  t.deepEqual(await fetchForPens(pb.ctx(w2), 'east', { now: () => T0 }), { gain: 1, text: 'cow: on the lead from 47 out; led in' });
  t.deepEqual(pb.log.filter(l => /^(take-from-chest|craft-item)/.test(l)), ['take-from-chest string 5', 'craft-item lead 1']);
  t.is(pb.count('lead'), 2);
  t.is(pb.count('slime_ball'), 0);
  // neither a lead, nor what makes one, nor wheat: nothing is tried
  const w3 = liveWorld({}, { [k(GEAR_CHEST)]: { bucket: 8 }, [k(DROPS_CHEST)]: { leather: 7 }, [k(FARM_CHEST)]: { bone_meal: 3 } });
  const pc = new Pasture([cow(7, -503, 2183)], w3, KIT);
  t.deepEqual(await fetchForPens(pc.ctx(w3), 'east', { now: () => T0 }), { gain: 0, text: 'cow: no lead to be had (short of 5 string for one), and no wheat to lure one with' });
});

test('a named, tamed or someone\'s animal is never leashed: on a lead (a knot on someone\'s post), named, tamed, by someone\'s build, in their pen', async (t) => {
  const theirs = [
    cow(1, -503, 2183, { leashed: true }), cow(2, -500, 2186, { named: true }), cow(3, -500, 2180, { tamed: true }),
    cow(4, -505, 2190, { buildDistance: 10 }), cow(5, -505, 2176, { foreign: true }), cow(6, -498, 2183, { baby: true })
  ];
  const world = liveWorld();
  const pa = new Pasture(theirs, world, KIT);
  const r = await fetchForPens(pa.ctx(world), 'east', { now: () => T0 });
  t.deepEqual(r, { gain: 0, text: 'no wild cows east within the cow range (256 from home)' });
  t.false(pa.log.some(l => l.startsWith('entity.use')));
  t.deepEqual(sitesOf(world, 'cow'), []);
  // the pens round leaves them be too, near the pen as they are
  // (in the bot's own yard an animal is its own, by a friend's build or not: those two stand outside the fence, 24 and
  // 23 from home)
  const near = [
    ...[theirs[0], theirs[1], theirs[2], theirs[5]].map(c => ({ ...c, position: { ...c.position, x: c.position.x - 40, z: c.position.z - 15 } })),
    cow(4, -525, 2183, { buildDistance: 10 }), cow(5, -526, 2178, { foreign: true })
  ];
  const w2 = liveWorld();
  const pb = new Pasture(near, w2, [...KIT, { slot: 3, name: 'wheat', count: 10 }]);
  t.is(await pens.run(pb.ctx(w2)), 'cow: 0 cow in the pen and none within 32 to lure; 0 cow ready to breed');
  t.false(pb.log.some(l => l.startsWith('entity.use')));
  // a cow past the cow range (seen 22 off from the last stop, 240 out) is not fetched either
  const w3 = liveWorld();
  const pc = new Pasture([cow(8, -287, 2183)], w3, KIT);
  t.deepEqual(await fetchForPens(pc.ctx(w3), 'east', { now: () => T0 }), { gain: 0, text: 'no wild cows east within the cow range (256 from home)' });
});

// ---- into the pen with a cow on the lead (live, Nov 13: wedged in the north gate twice; a cow left outside the pen)

/** within 1 of a gate (the yard's or the pen's), or in it: where no wait for a led animal may be */
const byGate = (p: Pos) => [...YARD_GATES, GATE].some(g => Math.max(Math.abs(Math.floor(p.x) - g.x), Math.abs(Math.floor(p.z) - g.z)) < 2);

test('the stand-in lead pulls as the game\'s: straight at the bot, to 2 off it, and no further than a fence in the way; through an open gate', (t) => {
  const world = liveWorld();
  // north of the pen, the bot south of it: drawn straight at it, it stops at the pen's north fence
  const c = cow(7, -555, 2158);
  const pa = new Pasture([c], world, KIT);
  pa.led.add(7);
  pa.me = { x: -554.5, y: 63, z: 2174.5 };
  pa.walk({ x: -554.5, y: 63, z: 2175.5 }, 'goto careful');
  t.true(c.position.z < PEN.z && c.position.z > PEN.z - 0.1 && c.position.x === -554.5, JSON.stringify(c.position));
  // on the gate's line south of it, the bot in the pen, the gate open: in through the gateway, to 2 off the bot
  const d = cow(8, -555, 2176);
  const pb = new Pasture([d], world, KIT);
  pb.led.add(8);
  pb.open.set(k(GATE), true);
  pb.me = { x: -554.5, y: 63, z: 2166.5 };
  pb.walk({ x: -554.5, y: 63, z: 2166.5 }, 'goto careful');
  t.deepEqual(d.position, { x: -554.5, y: 63, z: 2168.5 });
  // a block to the side of the gate's line: the pull catches it on the post beside the gate
  const e = cow(9, -553, 2176);
  const pc = new Pasture([e], world, KIT);
  pc.led.add(9);
  pc.open.set(k(GATE), true);
  pc.me = { x: -554.5, y: 63, z: 2166.5 };
  pc.walk({ x: -554.5, y: 63, z: 2166.5 }, 'goto careful');
  t.true(e.position.z >= GATE.z + 1, JSON.stringify(e.position));
});

test('the way round the pen to its gate: 3 out on its shut sides, 6 out on the gate\'s side and in along the gate\'s line; a nearer berth where the yard or a build is in the way; straight to the gate with none', (t) => {
  const world = liveWorld();
  const p = { x1: PEN.x, z1: PEN.z, x2: PEN.x + PEN.width - 1, z2: PEN.z + PEN.length - 1, kind: 'cow' as const };
  const way = { gate: GATE, side: 'south' as const, outside: { ...GATE, z: GATE.z + 1 }, inside: { ...GATE, z: GATE.z - 2 }, deep: { ...GATE, z: GATE.z - 5 } };
  const cells = (pts: Pos[]) => pts.map(q => `${q.x},${q.z}`);
  // from 2 inside the north gate (live): down the east side, along the south side to the gate's line, in to 2 out
  t.deepEqual(cells(penWay(world, p, way, { x: -548.5, z: 2121.5 })), ['-549,2162', '-549,2177', '-555,2177', '-555,2173']);
  // from 2 inside the west gate: the other way round
  t.deepEqual(cells(penWay(world, p, way, { x: -562.5, z: 2183.5 })), ['-561,2177', '-555,2177', '-555,2173']);
  // from the north-west, close by the pen's north fence: onto the ring, round the west side
  t.deepEqual(cells(penWay(world, p, way, { x: -556.5, z: 2163.5 })), ['-557,2162', '-561,2162', '-561,2177', '-555,2177', '-555,2173']);
  // the storage house a block nearer (its box at z 2177): the gate's side 5 out
  const built = liveWorld({ zones: { ...liveWorld().zones, storage: [{ x: -552, y: 62, z: 2177, width: 7, length: 9 }] } });
  t.deepEqual(cells(penWay(built, p, way, { x: -548.5, z: 2121.5 })), ['-549,2162', '-549,2176', '-555,2176', '-555,2173']);
  // the yard's west fence 2 off the pen: 2 out on that side
  const tight = liveWorld({ yard: { ...YARD, x1: -561 } });
  t.deepEqual(cells(penWay(tight, p, way, { x: -548.5, z: 2121.5 })), ['-550,2163', '-550,2175', '-555,2175', '-555,2173']);
  // no room at all: to 2 out, straight, as before
  const none = liveWorld({ yard: { ...YARD, x1: -560 } });
  t.deepEqual(cells(penWay(none, p, way, { x: -548.5, z: 2121.5 })), ['-555,2173']);
  // where a walk on the lead may stop and wait: 2 clear of every gate and door, not on a fence, not in a pen or a build
  const ok = standsClear(liveWorld({ zones: { ...liveWorld().zones, 'storage:door': [{ x: -549, y: 63, z: 2186 }], plot: [{ x: -545, y: 62, z: 2161, width: 9, length: 9 }] } }));
  t.deepEqual([[-549, 2121], [-549, 2120], [-548, 2120], [-547, 2121], [-555, 2173], [-554, 2172], [-549, 2184], [-555, 2168], [-565, 2150], [-541, 2165], [-546, 2165]].map(([x, z]) => ok({ x, z })),
    [true, false, false, true, true, false, true, false, false, false, true]);
});

test('the live way in from the north gate: lined up on the gate, through it in one walk, round the pen and in along its gate\'s line, the cow behind the bot: in it comes; no wait in or by a gateway', async (t) => {
  // live on Nov 13 at 16:06: to where a cow was seen north of the yard, on the lead from 71 out, home by the north
  // gate and round the pen to its south gate: the cow, drawn straight after the bot, ended outside the pen's north
  // fence, "at the gate it would not come in (it stood 2 off at (-555, 63, 2164))". At 15:56 and 15:59 the walks home
  // stood in the north gate for the waits and the wedge watch stopped them there
  const world = liveWorld({ work: { dry: {}, next: {}, sites: { cow: [{ x: -564, y: 68, z: 2108 }] }, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } } });
  const herd = [cow(7, -561, 2112)];
  const pa = new Pasture(herd, world, KIT);
  const said: string[] = [];
  t.deepEqual(await fetchForPens(pa.ctx(world, undefined, said), 'in sight', { now: () => T0 }), { gain: 1, text: 'cow: on the lead from 71 out; led in' });
  t.true(penned(herd[0]), JSON.stringify(herd[0].position));
  t.true(said.includes('out of the yard by its north gate (-549, 63, 2119)'), said.join('\n'));
  // on the lead: to 6 out on the north gate's line, 2 out, through to 2 in in one walk, on along the gate's line to 4
  // in (the gate shut from there) and 6 (the cow out of the gateway behind the bot before it turns); down the pen's east side 3 out (its corner passed
  // within a block and a half, a leg's end), along its south side 6 out to the gate's line, in along it to 2 out; in
  // to 2 in, and to the far row
  const onLead = pa.log.slice(pa.log.indexOf('entity.use #7 lead'), pa.log.indexOf('entity.use #7')).filter(l => l.startsWith('goto'));
  const stops = ['goto careful -549,2113', 'goto careful -549,2117', 'goto careful -549,2121', 'goto careful -549,2123', 'goto careful -549,2125', 'goto careful -549,2161', 'goto careful -549,2177', 'goto careful -555,2177', 'goto careful -555,2173', 'goto careful -555,2169', 'goto careful -555,2166'];
  let was = -1;
  for (const stop of stops) { const i = onLead.indexOf(stop, was + 1); t.true(i > was, `${stop}:\n${onLead.join('\n')}`); was = i; }
  t.true(onLead.every(l => l.startsWith('goto careful')));
  // the north gate shut behind the cow from 4 in, in reach: no walk back to it past the cow (a run given up in that
  // walk left it open, the click of a run given up walking nowhere)
  const click = pa.log.indexOf(`use-item-on-block ${k(YARD_GATES[0])}`);
  t.is(pa.log.slice(0, click).filter(l => l.startsWith('goto')).at(-1), 'goto careful -549,2123', pa.log.join('\n'));
  // through the north gate in one walk: from 2 out (3 out, the walk to within 1 of it) straight to 2 in
  const through = onLead.indexOf('goto careful -549,2121');
  t.is(onLead[through - 1], 'goto careful -549,2117');
  // every look while it was on the lead (the waits for it are looks) 2 clear of the gates: none in a gateway or by one
  t.true(pa.ledLooks.length >= 15, `${pa.ledLooks.length}`);
  t.deepEqual(pa.ledLooks.filter(byGate).map(p => `${Math.floor(p.x)},${Math.floor(p.z)}`), []);
  // both gates shut behind, the closer on again
  t.false(pa.isOpen(YARD_GATES[0]) || pa.isOpen(GATE));
  t.true(pa.gatesAuto);
});

test('a stray north of the pen is walked round it on the lead, not drawn against its far fence; one that stays out of line at the gate is not walked in with', async (t) => {
  // the pens round's own lure goes by the same walk: a stray in the yard north of the pen, one cow in the pen
  const world = liveWorld();
  const herd = [cow(1, -556, 2168), cow(2, -552, 2155)];
  const pa = new Pasture(herd, world, KIT);
  const text = await pens.run(pa.ctx(world));
  t.true(text.startsWith('cow: on the lead from 28 out; led in'), text);
  t.true(penned(herd[1]), JSON.stringify(herd[1].position));
  t.deepEqual(pa.ledLooks.filter(byGate), []);
  // never into the pen but by its gate from its gate's side: no walk on the lead to a cell of the pen before the gate opened
  const onLead = pa.log.slice(pa.log.indexOf('entity.use #2 lead'), pa.log.indexOf(`use-item-on-block ${k(GATE)}`));
  t.false(onLead.some(l => /^baritone opens/.test(l) && l.endsWith(k(GATE))), onLead.join('\n'));
  // a cow that will not come round behind the bot (caught on something 2 east of the gate's line, south of the
  // pen): waited for, out along the gate's line and in again twice, not walked in with; let go there, said where
  const w2 = liveWorld();
  const h2 = [cow(7, -503, 2183)];
  const pb = new Pasture(h2, w2, KIT);
  const pull = pb.pull.bind(pb);
  pb.pull = (c, stop, by) => { pull(c, stop, by); if (c.position.z > GATE.z && c.position.x < GATE.x + 2) c.position = { ...c.position, x: GATE.x + 2 }; };
  const stuck = await fetchForPens(pb.ctx(w2), 'east', { now: () => T0 });
  t.regex(stuck.text, /^cow: on the lead from 47 out; it would not come round to the gate \(it stood 2 off at \(-553, 63, 217\d\)\): let go of it there, the lead picked up$/, stuck.text);
  t.false(pb.log.includes(`use-item-on-block ${k(GATE)}`), 'the pen\'s gate never opened for it');
  t.is(pb.log.filter(l => l === 'goto careful -555,2177').length, 3, pb.log.join('\n'));
  t.is(pb.led.size, 0);
  t.is(pb.count('lead'), 2);
});

test('a door the walk to the pen passes, of a build world memory does not know, is shut behind the bot: the closer is on from the yard\'s gate shut behind the cow (or all the way, for a stray in the yard) till the pen\'s gate', async (t) => {
  // live, the cottage's and the windmill's doors are not in world memory and lie out of the dusk sweep's box: one
  // the walk went through with the closer off stood open through the night, the bed behind it
  const DOOR: Pos = { x: -551, y: 63, z: 2177 };
  const ends = (pa: Pasture) => {
    t.false(pa.isOpen(DOOR), pa.log.join('\n'));
    t.true(pa.log.includes(`baritone opens ${k(DOOR)}`) && pa.log.includes(`the closer shuts ${k(DOOR)}`), pa.log.join('\n'));
    // (off again for the pen's gate: the bot opens and shuts that one itself)
    const opens = pa.log.indexOf(`use-item-on-block ${k(GATE)}`);
    t.is(pa.log.lastIndexOf('gates.auto off', opens), opens - 1, pa.log.join('\n'));
    t.false(pa.isOpen(GATE));
    t.true(pa.gatesAuto);
  };
  // a stray north of the pen, in the yard: no yard's gate to pass, the closer on all the way to the pen's gate
  const world = liveWorld();
  const pa = new Pasture([cow(1, -556, 2168), cow(2, -552, 2155)], world, KIT, { doors: [DOOR] });
  t.regex(await pens.run(pa.ctx(world)), /^cow: on the lead from 28 out; led in/);
  t.is(pa.log.slice(0, pa.log.indexOf('entity.use #2')).filter(l => l === 'gates.auto off').length, 1, pa.log.join('\n'));
  ends(pa);
  // from 71 out north: off from the north gate's pass, on again once the gate is shut behind the cow
  const w2 = liveWorld({ work: { dry: {}, next: {}, sites: { cow: [{ x: -564, y: 68, z: 2108 }] }, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } } });
  const pb = new Pasture([cow(7, -561, 2112)], w2, KIT, { doors: [DOOR] });
  t.deepEqual(await fetchForPens(pb.ctx(w2), 'in sight', { now: () => T0 }), { gain: 1, text: 'cow: on the lead from 71 out; led in' });
  const shutNorth = pb.log.indexOf(`use-item-on-block ${k(YARD_GATES[0])}`);
  t.true(shutNorth > 0 && pb.log[shutNorth + 1] === 'gates.auto on', pb.log.join('\n'));
  ends(pb);
  t.false(pb.isOpen(YARD_GATES[0]));
});

/** the live storage house, its door and the plot, as world memory has them (the stand-in pasture knows no buildings) */
const BUILT = {
  storage: [{ x: -552, y: 62, z: 2178, width: 7, length: 9 }], 'storage:door': [{ x: -549, y: 63, z: 2186 }],
  plot: [{ x: -545, y: 62, z: 2161, width: 9, length: 9 }]
};
const inHouse = (q: { x: number; z: number }) => Math.floor(q.x) >= -552 && Math.floor(q.x) < -545 && Math.floor(q.z) >= 2178 && Math.floor(q.z) < 2187;
/** the cells walked to, as the log has them */
const walkedTo = (log: string[]) => log.filter(l => l.startsWith('goto')).map(l => { const [x, z] = l.split(' ').at(-1)!.split(',').map(Number); return { x, z }; });

test('the way round the pen keeps out of the builds world memory knows: in by the yard\'s south gate or its east gate, or a stray south of the storage house, never through the house with the cow on the lead', async (t) => {
  // from the south gate the ring's nearest cell, its corner behind the storage house, lay straight through the house
  // (its door, the home cell, its north wall), the cow drawn after the bot; from the east gate through its corner
  for (const [side, x, z] of [['south', -549, 2245], ['east', -503, 2183]] as const) {
    const world = liveWorld({ zones: { ...liveWorld().zones, ...BUILT } });
    const herd = [cow(7, x, z)];
    const pa = new Pasture(herd, world, KIT);
    const r = await fetchForPens(pa.ctx(world), side, { now: () => T0 });
    t.regex(r.text, /^cow: on the lead from \d+ out; led in$/, `${side}: ${r.text}`);
    t.true(penned(herd[0]), `${side}: ${JSON.stringify(herd[0].position)}`);
    const onLead = pa.log.slice(pa.log.indexOf('entity.use #7 lead'), pa.log.indexOf('entity.use #7'));
    t.deepEqual(walkedTo(onLead).filter(inHouse), [], `${side}:\n${onLead.join('\n')}`);
    t.deepEqual(pa.ledLooks.filter(inHouse), [], side);
  }
  // the pens round's lure of a stray just south of the house: round the house's west side, not through its door
  const world = liveWorld({ zones: { ...liveWorld().zones, ...BUILT } });
  const herd = [cow(1, -556, 2168), cow(2, -549, 2200)];
  const pa = new Pasture(herd, world, KIT);
  t.regex(await pens.run(pa.ctx(world)), /^cow: on the lead from 18 out; led in/);
  t.true(penned(herd[1]));
  t.deepEqual(walkedTo(pa.log.slice(pa.log.indexOf('entity.use #2 lead'))).filter(inHouse), []);
  t.deepEqual(pa.ledLooks.filter(inHouse), []);
  // the way itself: from 6 in at the south gate onto the ring west of the house, a block clear of its corner; with
  // no house known, down x -549 to the ring's corner behind it, as before
  const p = { x1: PEN.x, z1: PEN.z, x2: PEN.x + PEN.width - 1, z2: PEN.z + PEN.length - 1, kind: 'cow' as const };
  const way = { gate: GATE, side: 'south' as const, outside: { ...GATE, z: GATE.z + 1 }, inside: { ...GATE, z: GATE.z - 2 }, deep: { ...GATE, z: GATE.z - 5 } };
  const cells = (pts: Pos[]) => pts.map(q => `${q.x},${q.z}`);
  t.deepEqual(cells(penWay(world, p, way, { x: -548.5, z: 2209.5 })), ['-556,2177', '-555,2177', '-555,2173']);
  t.deepEqual(cells(penWay(liveWorld(), p, way, { x: -548.5, z: 2209.5 })), ['-549,2177', '-555,2177', '-555,2173']);
});

test('in by the yard\'s west gate, or from beside a gate but off its line: lined up on the gate first, on in along its line after the pass, and the cow comes in', async (t) => {
  // under the lead's straight pull every fetch by the west gate failed: from 2 in, the cow in the gateway behind the
  // bot, the first leg turned 6 south toward the ring and pulled it onto the post beside the gate ("got no nearer
  // than 11 to the gate"); and a cow leashed 4 from the east gate, to its side, was brought straight in at the gate
  // from the side, onto the post there ("got no nearer than 21")
  const world = liveWorld();
  const herd = [cow(7, -600, 2183)];
  const pa = new Pasture(herd, world, KIT);
  t.deepEqual(await fetchForPens(pa.ctx(world), 'west', { now: () => T0 }), { gain: 1, text: 'cow: on the lead from 51 out; led in' });
  t.true(penned(herd[0]), JSON.stringify(herd[0].position));
  const onLead = pa.log.slice(pa.log.indexOf('entity.use #7 lead'), pa.log.indexOf('entity.use #7')).filter(l => l.startsWith('goto'));
  // through the west gate from 2 out to 2 in, on to 4 and 6 in on its line, then south to the ring
  const pass = onLead.indexOf('goto careful -563,2183');
  t.deepEqual(onLead.slice(pass - 1, pass + 3), ['goto careful -567,2183', 'goto careful -563,2183', 'goto careful -561,2183', 'goto careful -559,2183'], onLead.join('\n'));
  t.deepEqual(pa.ledLooks.filter(byGate), []);
  t.false(pa.isOpen(YARD_GATES[3]) || pa.isOpen(GATE));
  // a cow by the east gate, 3 to its side: out to 6 on the gate's line first, then in
  const w2 = liveWorld();
  const h2 = [cow(7, -528, 2180)];
  const pb = new Pasture(h2, w2, KIT);
  t.deepEqual(await fetchForPens(pb.ctx(w2), 'in sight', { now: () => T0 }), { gain: 1, text: 'cow: on the lead from 22 out; led in' });
  t.true(penned(h2[0]), JSON.stringify(h2[0].position));
  const led2 = pb.log.slice(pb.log.indexOf('entity.use #7 lead'), pb.log.indexOf('entity.use #7')).filter(l => l.startsWith('goto'));
  t.deepEqual(led2.slice(0, 5), ['goto careful -527,2183', 'goto careful -531,2183', 'goto careful -535,2183', 'goto careful -537,2183', 'goto careful -539,2183'], led2.join('\n'));
});

test('a led cow that stays caught on a fence is let go after two steps back toward it, not walked on leg after leg; the yard\'s gate shut behind', async (t) => {
  // one that cannot follow (caught by the post beside the east gate, outside): every stop had its legs, each with
  // up to 18 s of waiting for it, and a lure, which has no time limit of its own, ran into the pens round's 8 minutes
  const world = liveWorld();
  const herd = [cow(7, -503, 2183)];
  const pa = new Pasture(herd, world, KIT);
  const pull = pa.pull.bind(pa);
  pa.pull = (c, stop, by) => { pull(c, stop, by); if (c.position.x < -531.95) c.position = { ...c.position, x: -531.95, z: 2182.5 }; };
  const r = await fetchForPens(pa.ctx(world), 'east', { now: () => T0 });
  t.is(r.text, 'cow: on the lead from 47 out; the cow was caught on the fence at (-532, 63, 2182): let go of it there, the lead picked up');
  // through the gate to 2 in; the leg to 4 in, the wait for it (a step back toward it, to 2 in: no nearer the gate)
  // and the step back toward the stop before, twice; the leg to 4 in once more and the wait: let go there (the walk
  // out to it to take the lead off follows)
  const onLead = pa.log.slice(pa.log.indexOf('entity.use #7 lead'), pa.log.indexOf('entity.use #7')).filter(l => l.startsWith('goto'));
  const pass = onLead.indexOf('goto careful -535,2183');
  t.deepEqual(onLead.slice(pass, pass + 9).map(l => l.split(' ').at(-1)),
    ['-535,2183', '-537,2183', '-535,2183', '-535,2183', '-537,2183', '-535,2183', '-535,2183', '-537,2183', '-535,2183'], onLead.join('\n'));
  t.is(onLead.filter(l => l === 'goto careful -537,2183').length, 3, onLead.join('\n'));
  t.false(pa.isOpen(YARD_GATES[1]) || pa.isOpen(GATE));
  t.true(pa.gatesAuto);
  t.is(pa.led.size, 0);
  t.is(pa.count('lead'), 2);
});

test('a led cow held by what world memory does not know (a build, a post) is let go after three legs the waits for it took back, not walked on leg after leg', async (t) => {
  // held once it is in the yard, west of x -541 (as by the windmill's corner): no fence world memory knows is in the
  // way, so the snag rule never saw it, and every stop had its legs, each with the waits for it: 100 led walks and
  // 5 minutes for one fetch ("got no nearer than 12 to the gate"), a lure's three tries past the pens round's 8 minutes
  const world = liveWorld();
  const herd = [cow(7, -503, 2183)];
  const pa = new Pasture(herd, world, KIT);
  const pull = pa.pull.bind(pa);
  pa.pull = (c, stop, by) => { pull(c, stop, by); if (c.position.x < -540.5) c.position = { ...c.position, x: -540.5 }; };
  const r = await fetchForPens(pa.ctx(world), 'east', { now: () => T0 });
  t.regex(r.text, /^cow: on the lead from 47 out; the cow would not follow \(it stood \d off at \(-541, 63, 21\d\d\)\): let go of it there, the lead picked up$/, r.text);
  t.true(pa.legs <= 25, `${pa.legs} led walks`);
  t.false(pa.log.includes(`use-item-on-block ${k(GATE)}`));
  t.false(pa.isOpen(YARD_GATES[1]) || pa.isOpen(GATE));
  t.true(pa.gatesAuto);
  t.is(pa.led.size, 0);
  t.is(pa.count('lead'), 2);
});

test('two on leads at the pen\'s gate, one lined up and one not: the one that would not come round is let go before the gate opens, the other walked in', async (t) => {
  const world = liveWorld();
  const herd = [cow(7, -469, 2183), cow(8, -466, 2187)];
  const pa = new Pasture(herd, world, KIT);
  // (the second caught on something 2 east of the gate's line, south of the pen)
  const pull = pa.pull.bind(pa);
  pa.pull = (c, stop, by) => { pull(c, stop, by); if (c.id === 8 && c.position.z > GATE.z && c.position.x < GATE.x + 2) c.position = { ...c.position, x: GATE.x + 2 }; };
  t.deepEqual(await fetchForPens(pa.ctx(world), 'east', { now: () => T0 }),
    { gain: 1, text: 'cow: on two leads from 81 out; the second cow would not come round to the gate (it stood 2 off at (-553, 63, 2174)): let go of it there; led in' });
  t.true(penned(herd[0]));
  t.false(penned(herd[1]));
  // off its lead (and the lead picked up) before the pen's gate opened: never walked out to through the open gate
  const off8 = pa.log.indexOf('entity.use #8');
  t.true(off8 > 0 && off8 < pa.log.indexOf(`use-item-on-block ${k(GATE)}`), pa.log.join('\n'));
  t.is(pa.count('lead'), 2);
  t.false(pa.isOpen(YARD_GATES[1]) || pa.isOpen(GATE));
  // the second held 3 or 4 east of the line: the walk up to it to take the lead off, and onto the lead, takes the bot
  // off the cell 2 out; back to it, and the first waited for again before the gate opens (walked in from where the
  // let-go left the bot, the first was drawn in at the gate from the side, onto the post, and neither was penned)
  for (const by of [3, 4]) {
    const w2 = liveWorld();
    const h2 = [cow(7, -469, 2183), cow(8, -466, 2187)];
    const pb = new Pasture(h2, w2, KIT);
    const pull2 = pb.pull.bind(pb);
    pb.pull = (c, stop, n) => { pull2(c, stop, n); if (c.id === 8 && c.position.z > GATE.z && c.position.x < GATE.x + by) c.position = { ...c.position, x: GATE.x + by }; };
    const r = await fetchForPens(pb.ctx(w2), 'east', { now: () => T0 });
    t.regex(r.text, new RegExp(`^cow: on two leads from 81 out; the second cow would not come round to the gate \\(it stood ${by} off at \\(${GATE.x + by}, 63, 217\\d\\)\\): let go of it there; led in$`), `${by}: ${r.text}`);
    t.true(penned(h2[0]), `${by}: ${JSON.stringify(h2[0].position)}`);
    t.is(r.gain, 1);
    t.false(pb.isOpen(YARD_GATES[1]) || pb.isOpen(GATE));
  }
});

test('at the cell 2 in, with the pen\'s gate open behind the bot, a led one that lags is waited for one round of looks, not three', async (t) => {
  // in the pen no cell is one to step back to: the old three rounds were 18 s of the gate open with the herd inside
  const world = liveWorld();
  const herd = [cow(7, -503, 2183)];
  const pa = new Pasture(herd, world, KIT);
  // (it stops following once the bot is in the pen)
  const pull = pa.pull.bind(pa);
  pa.pull = (c, stop, by) => { if (pa.me.z >= GATE.z) pull(c, stop, by); };
  const r = await fetchForPens(pa.ctx(world), 'east', { now: () => T0 });
  t.regex(r.text, /^cow: on the lead from 47 out; at the gate it would not come in/);
  t.is(pa.ledLooks.filter(q => Math.floor(q.x) === GATE.x && Math.floor(q.z) === GATE.z - 2).length, 8);
  t.false(pa.isOpen(GATE));
});

test('a build world memory does not know 2 out from the pen\'s gate (the cottage\'s wall by the sheep pen\'s): no ring through it, and the lead and the food go to the cell outside the gate as before', (t) => {
  // live, the cottage's south wall stands in the sheep pen's gate's cell 2 out, the cottage between it and the 6 out,
  // and every ring round the pen went through the cottage: a walk to a cell in its wall, and by its door to its bed
  const sp = { x1: -542, z1: 2196, x2: -536, z2: 2202, kind: 'sheep' as const };
  const world = liveWorld({ zones: { ...liveWorld().zones, 'pen:sheep': [{ x: -542, y: 62, z: 2196, width: 7, length: 7 }], 'pen:sheep:gate': [{ x: -539, y: 63, z: 2196 }] } });
  const way = { gate: { x: -539, y: 63, z: 2196 }, side: 'north' as const, outside: { x: -539, y: 63, z: 2195 }, inside: { x: -539, y: 63, z: 2198 }, deep: { x: -539, y: 63, z: 2201 } };
  const wall = (c: { x: number; z: number }) => c.x >= -544 && c.x <= -536 && c.z >= 2188 && c.z <= 2194 && (c.x === -544 || c.x === -536 || c.z === 2188 || c.z === 2194);
  const cells = (pts: Pos[]) => pts.map(q => `${q.x},${q.z}`);
  t.deepEqual(cells(penWay(world, sp, way, { x: -548.5, z: 2190.5 })), ['-544,2192', '-539,2192', '-539,2194']);
  t.deepEqual(cells(penWay(world, sp, way, { x: -548.5, z: 2190.5 }, c => !wall(c))), ['-539,2194']);
});

test('the look round the pen: a block world memory does not know on the ring has the walk take the next berth in; a patch of pink petals there does not', async (t) => {
  const stops = async (block: string) => {
    const world = liveWorld();
    const herd = [cow(7, -503, 2183)];
    const pa = new Pasture(herd, world, KIT, { solid: { '-549,63,2170': block } });
    t.deepEqual(await fetchForPens(pa.ctx(world), 'east', { now: () => T0 }), { gain: 1, text: 'cow: on the lead from 47 out; led in' });
    t.true(penned(herd[0]), `${block}: ${JSON.stringify(herd[0].position)}`);
    return pa.log.slice(pa.log.indexOf('entity.use #7 lead'), pa.log.indexOf('entity.use #7')).filter(l => l.startsWith('goto')).map(l => l.split(' ').at(-1));
  };
  // (on the ring 3 out, down the pen's east side: x -549)
  t.true((await stops('pink_petals')).includes('-549,2177'));
  // a block there: the ring 2 out, its gate's side 4 out
  const round = await stops('cobblestone');
  t.false(round.some(c => c!.startsWith('-549,')), round.join(' '));
  t.true(round.includes('-553,2175') && round.includes('-555,2175'), round.join(' '));
});

test('the walk to the pen with a wall 2 out from its gate that world memory does not know: to the cell outside the gate, and in, as before, on the lead and on the food; no walk into the wall', async (t) => {
  // (the cow pen as the sheep pen stands to the cottage: a wall the length of its gate's side, 2 out)
  const solid: Record<string, string> = {};
  for (let x = -562; x <= -548; x++) for (const y of [63, 64]) solid[`${x},${y},${GATE.z + 2}`] = 'stone_bricks';
  const walls = (q: { x: number; z: number }) => !!solid[`${q.x},63,${q.z}`];
  // on the lead, a stray west of the gate in the row between the pen's fence and the wall: along the row to the cell
  // outside the gate, the gate opened and in, as before, the cow after the bot by the game's own close-in (in the row
  // it never stands on the gate's line: the wait for it to come round there let go of every one, 3 a pens round)
  const world = liveWorld();
  const herd = [cow(1, -556, 2168), cow(2, -561, GATE.z + 1)];
  const pa = new Pasture(herd, world, KIT, { solid, follow: 6 });
  const text = await pens.run(pa.ctx(world));
  t.regex(text, /^cow: on the lead from \d+ out; led in/, text);
  t.true(penned(herd[1]), JSON.stringify(herd[1].position));
  t.false(text.includes('would not come round'), text);
  const onLead = pa.log.slice(pa.log.indexOf('entity.use #2 lead'));
  const [outside, opens, inside] = ['goto careful -555,2172', `use-item-on-block ${k(GATE)}`, 'goto careful -555,2169'].map(l => onLead.indexOf(l));
  t.true(outside >= 0 && outside < opens && opens < inside, onLead.join('\n'));
  t.deepEqual(walkedTo(pa.log).filter(walls), [], pa.log.join('\n'));
  t.false(pa.isOpen(GATE));
  // strays west and east of the pen, the walk straight to the cell outside the gate past the pen's corner: walked on
  // round it, as before, not stepped back toward and let go ("caught on the fence"), as on the way round to a gate
  for (const [x, z] of [[-563, 2168], [-546, 2168]]) {
    const wx = liveWorld();
    const hx = [cow(1, -556, 2168), cow(2, x, z)];
    const px = new Pasture(hx, wx, KIT, { solid, follow: 6 });
    const tx = await pens.run(px.ctx(wx));
    t.regex(tx, /^cow: on the lead from \d+ out; led in/, `${x},${z}: ${tx}`);
    t.true(penned(hx[1]), `${x},${z}: ${JSON.stringify(hx[1].position)}`);
  }
  // (the stand-in's straight pull, with no close-in: in, as before, and the cow left at the gate across the post)
  const w1 = liveWorld();
  const p1 = new Pasture([cow(1, -556, 2168), cow(2, -561, GATE.z + 1)], w1, KIT, { solid });
  t.regex(await pens.run(p1.ctx(w1)), /^cow: on the lead from \d+ out; at the gate it would not come in/);
  t.true(p1.log.includes('goto careful -555,2169'), p1.log.join('\n'));
  t.false(p1.isOpen(GATE));
  // on the wheat (no lead to be had): to the cell outside the gate, in, and it follows
  const w2 = liveWorld({}, { [k(GEAR_CHEST)]: { bucket: 8 }, [k(DROPS_CHEST)]: { leather: 7 } });
  const h2 = [cow(1, -556, 2168), cow(2, -561, GATE.z + 1)];
  const pb = new Pasture(h2, w2, [...KIT, { slot: 3, name: 'wheat', count: 10 }], { solid });
  t.regex(await pens.run(pb.ctx(w2)), /on the wheat from \d+ out; led in/);
  t.true(penned(h2[1]));
  t.true(pb.log.includes('goto careful -555,2172'), pb.log.join('\n'));
  t.deepEqual(walkedTo(pb.log).filter(walls), [], pb.log.join('\n'));
});

// ---- past the leash (the user, Nov 13: "allowed to wander further to find its cows")

test('the cows go past the leash to their range: a cow 152 out is fetched on the lead; one 300 out is never walked to; the rest keep the leash', async (t) => {
  // east from home: the stops every 32 out to 240, past the leash of 96
  const world = liveWorld();
  const herd = [cow(7, -398, 2183)];
  const pa = new Pasture(herd, world, KIT);
  const said: string[] = [];
  t.deepEqual(await fetchForPens(pa.ctx(world, undefined, said), 'east', { now: () => T0 }), { gain: 1, text: 'cow: on the lead from 152 out; led in' });
  t.true(penned(herd[0]), JSON.stringify(herd[0].position));
  t.true(said.includes('looking east for wild cows, 128 blocks out'), said.join('\n'));
  t.true(said.includes('fetching a cow for the pen: 23 blocks off, 152 from home'), said.join('\n'));
  const onLead = pa.log.slice(pa.log.indexOf('entity.use #7 lead'), pa.log.indexOf('entity.use #7'));
  t.true(onLead.filter(l => l.startsWith('goto')).every(l => l.startsWith('goto careful')), onLead.join('\n'));
  t.like(penCount(world, 'cow'), { adults: 1 });
  // 300 out: past the range, and never walked to (the last stop is 240 out, its look 48 round it)
  const w2 = liveWorld();
  const p2 = new Pasture([cow(8, -249, 2183)], w2, KIT);
  t.deepEqual(await fetchForPens(p2.ctx(w2), 'east', { now: () => T0 }), { gain: 0, text: 'no wild cows east within the cow range (256 from home)' });
  t.true(p2.farthest <= 241, `${p2.farthest}`);
  t.false(p2.log.some(l => l.startsWith('entity.use')));
  // the rest keep the leash: wild cane's sides and the surface coal 96 out, a side walk with no bound of its own to 80
  const cane = liveWorld({ progress: { done: [], journal: [], blocked: { id: 'enchanting/2', n: 1, at: T0, need: { sugar_cane: 50 } } } });
  t.deepEqual(rung('cane').variants(look(KIT), cane).map(v => `${v.id} ${v.dist}`), ['north 96', 'east 96', 'south 96', 'west 96']);
  t.deepEqual(rung('surface').variants(look(KIT), liveWorld()).map(v => `${v.id} ${v.dist}`), ['coal 96']);
  t.deepEqual(rung('cows').variants(look(KIT), liveWorld()).map(v => `${v.id} ${v.dist}`), ['north 256', 'east 256', 'south 256', 'west 256']);
  const w3 = liveWorld();
  const p3 = new Pasture([cow(9, -397, 2183)], w3, KIT);
  t.deepEqual(await alongSide(p3.ctx(w3), 'east', 'wild cane', async () => undefined), { text: 'no wild cane east within the leash (96 from home)' });
  t.true(p3.farthest <= 81, `${p3.farthest}`);
});

test('past the leash the land is new to the bot: a cow by someone\'s farm that the mod had not looked at yet is judged by a fresh look from beside it, and left', async (t) => {
  const world = liveWorld();
  const pa = new Pasture([cow(9, -399, 2183)], world, KIT, { scanReveals: { id: 9, buildDistance: 12 } });
  t.deepEqual(await fetchForPens(pa.ctx(world), 'east', { now: () => T0 }), { gain: 0, text: 'cow: would not take the lead (it is gone from sight, or is someone\'s)', mark: 'first' });
  t.false(pa.log.some(l => l.startsWith('entity.use')), pa.log.join('\n'));
  t.is(pa.led.size, 0);
  t.true(pa.sprint && pa.gatesAuto);
});

test('a fetch from 200 out is home by dusk: 260 s of the day with the walk home at the lead\'s pace, so it sets out until tod 5800 (a side at the range, 256, until 4680); its budget holds the walk home and its timeout the budget', async (t) => {
  const task = rung('cows');
  // the lead's pace as bringIn walks it: 4-block careful legs and the waits for the cow, 1.5 blocks a second
  t.is(task.backPace, 1.5);
  t.is(needMs(200, 'far', task.backPace), 260_000);
  t.is(needMs(256, 'far', task.backPace), 316_000);
  // (at the leash's walking pace it would have been 193 s: set out at tod 7140, the cow let go on the way at dusk)
  t.is(Math.round(needMs(200, 'far')), 193_333);
  const work = (sites: Pos[]): NonNullable<WorldMemory['work']> => ({ dry: {}, next: {}, sites: { cow: sites }, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } });
  const seen = liveWorld({ work: work([{ x: -349, y: 63, z: 2183 }]) });
  const ask = (w: WorldMemory, tod: number) => pick(task, look(KIT, { timeOfDay: tod }), w);
  t.like(ask(seen, 5800), { variant: 'in sight', dist: 200 });
  t.deepEqual(ask(seen, 5801), { decline: { cause: 'late', text: '4.3 min of daylight left (cows needs 4.3)' } });
  t.like(ask(liveWorld(), 4680), { variant: 'north', dist: 256 });
  t.deepEqual(ask(liveWorld(), 4681), { decline: { cause: 'late', text: '5.3 min of daylight left (cows needs 5.3)' } });
  // seen 40 out and 200 out: the fetch walks on to the second when the first holds none, so it is the second's day
  // that counts (by the nearest alone it set out at tod 8400, walked on to 200 and led a cow home from there at dusk)
  const two = liveWorld({ work: work([{ x: -509, y: 63, z: 2183 }, { x: -349, y: 63, z: 2183 }]) });
  t.like(ask(two, 5800), { variant: 'in sight', dist: 200 });
  t.deepEqual(ask(two, 5801), { decline: { cause: 'late', text: '4.3 min of daylight left (cows needs 4.3)' } });
  t.like(ask(two, 8400), { decline: { cause: 'late' } });
  // (the nearest two only: a third, farther still, is not walked to)
  t.like(ask(liveWorld({ work: work([{ x: -509, y: 63, z: 2183 }, { x: -349, y: 63, z: 2183 }, { x: -299, y: 63, z: 2183 }]) }), 5800), { variant: 'in sight', dist: 200 });
  // the budget the run is given: the rung's 6 min, the whole way there and back on the lead in it; at the last tod it
  // may set out, what the day leaves less a margin; the brain's timeout covers the budget and the walk home after
  let got = 0;
  const probe: WorkTask = { ...task, run: async (_ctx, _variant, budgetMs) => { got = budgetMs; return { gain: 0, text: 'looked' }; } };
  const goal = goalOf(probe, { now: T0 });
  t.is(goal.timeoutMs, 10 * MINUTE);
  const pa = new Pasture([], seen, KIT);
  t.is(await goal.run(pa.ctx(seen)), '[in sight] looked');
  t.is(got, 6 * MINUTE);
  t.true(got >= needMs(200, 'far', task.backPace) && goal.timeoutMs >= got + 200 / 3 * 1000 + 30_000);
  const lastCall = liveWorld({ work: work([{ x: -349, y: 63, z: 2183 }]) });
  t.is(await goal.run({ ...new Pasture([], lastCall, KIT).ctx(lastCall), s: look(KIT, { timeOfDay: 5800 }) }), '[in sight] looked');
  t.is(got, 245_000);
});

test('two wild cows grazing together come in on two leads, the pen\'s pair in one walk; one of two lost on the way, the other walked on in; with one lead to be had, one cow', async (t) => {
  // two 80 east, 5 apart, seen from the stop 64 out
  const world = liveWorld();
  const herd = [cow(7, -469, 2183), cow(8, -466, 2187)];
  const pa = new Pasture(herd, world, KIT);
  const said: string[] = [];
  t.deepEqual(await fetchForPens(pa.ctx(world, undefined, said), 'east', { now: () => T0 }), { gain: 2, text: 'cow: on two leads from 81 out; both led in' });
  t.true(herd.every(penned), JSON.stringify(herd.map(c => c.position)));
  // (the second seen from beside the first: from the stop 32 out, 48 off, it was out of sight)
  t.true(said.includes('fetching a cow for the pen: 48 blocks off, 81 from home'), said.join('\n'));
  t.true(said.includes('a second cow by it, 7 off: on the other lead'), said.join('\n'));
  // both on, both off in the pen, both leads carried again (two from the chests: two kept on hand)
  t.deepEqual(pa.log.filter(l => l.startsWith('entity.use')), ['entity.use #7 lead', 'entity.use #8 lead', 'entity.use #7', 'entity.use #8']);
  t.is(pa.count('lead'), 2);
  t.deepEqual(pa.drops, []);
  // every walk with a cow on its lead careful, the yard's gate and the pen's shut behind them
  const onLead = pa.log.slice(pa.log.indexOf('entity.use #7 lead'), pa.log.indexOf('entity.use #7'));
  t.true(onLead.filter(l => l.startsWith('goto')).every(l => l.startsWith('goto careful')), onLead.join('\n'));
  t.false(pa.isOpen(YARD_GATES[1]) || pa.isOpen(GATE));
  t.like(penCount(world, 'cow'), { adults: 2 });
  // the second lost on the way (killed): said, its lead picked up, the first walked on in; where it was last seen kept
  const w2 = liveWorld();
  const h2 = [cow(7, -469, 2183), cow(8, -466, 2187)];
  const pb = new Pasture(h2, w2, KIT, { vanishOn: 4, vanishId: 8 });
  const r2 = await fetchForPens(pb.ctx(w2), 'east', { now: () => T0 });
  t.regex(r2.text, /^cow: on two leads from 81 out; the second cow lost on the way \(last seen \d+ off at \(-\d+, 63, \d+\)\); the lead picked up; led in$/);
  t.is(r2.gain, 1);
  t.true(penned(h2[0]));
  t.is(pb.count('lead'), 2);
  t.is(sitesOf(w2, 'cow').length, 1);
  // one lead in the chests and no string to make another: one cow a run, as before
  const w3 = liveWorld({}, { [k(GEAR_CHEST)]: { lead: 1 }, [k(DROPS_CHEST)]: { leather: 7 } });
  const h3 = [cow(7, -469, 2183), cow(8, -466, 2187)];
  const pc = new Pasture(h3, w3, KIT);
  t.deepEqual(await fetchForPens(pc.ctx(w3), 'east', { now: () => T0 }), { gain: 1, text: 'cow: on the lead from 81 out; led in' });
  t.true(penned(h3[0]));
  t.false(penned(h3[1]));
  t.deepEqual(pc.log.filter(l => l.startsWith('entity.use')), ['entity.use #7 lead', 'entity.use #7']);
});

test('the first of two coming off its lead on the way to the second is seen to at once: no lead put on the second, the first put on again and walked in', async (t) => {
  // caught on something on the first leg toward the second (7 off): left 13 back, its lead broken. Leading the second
  // on regardless would have the bot walk two home with only one on a lead
  const world = liveWorld();
  const herd = [cow(7, -469, 2183), cow(8, -466, 2187)];
  const pa = new Pasture(herd, world, KIT, { breakOn: [1] });
  const r = await fetchForPens(pa.ctx(world), 'east', { now: () => T0 });
  t.regex(r.text, /^cow: on the lead from 81 out; no second cow on a lead \(the first came off its lead on the way to it\); the lead broke \d+ from the gate \(the cow \d+ off\), put on again; led in$/);
  t.is(r.gain, 1);
  t.true(penned(herd[0]));
  t.false(penned(herd[1]));
  t.deepEqual(pa.log.filter(l => l.startsWith('entity.use')), ['entity.use #7 lead', 'entity.use #7 lead', 'entity.use #7']);
  t.is(pa.count('lead'), 2);
  t.deepEqual(pa.drops, []);
});

test('a place a cow was seen far out that the walk got nowhere near is kept, and said: the walk had the time its length needs; one got to and empty is forgotten', async (t) => {
  // 250 out east, across what stops the walk 60 short of it (water): from there the look (48) does not reach it
  const site = { x: -299, y: 63, z: 2183 };
  const work = (): NonNullable<WorldMemory['work']> => ({ dry: {}, next: {}, sites: { cow: [{ ...site }] }, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } });
  const world = liveWorld({ work: work() });
  const pa = new Pasture([], world, KIT);
  const ctx = pa.ctx(world);
  const call = ctx.call;
  const asked: { timeoutMs: number; bridge?: number }[] = [];
  ctx.call = (async (method: string, p?: Record<string, unknown>, ms?: number) => {
    if (method === 'goto' && p?.x === site.x && p.z === site.z) {
      asked.push({ timeoutMs: Number(p.timeoutMs), bridge: ms });
      return call(method, { ...p, x: site.x - 60 });
    }
    return call(method, p, ms);
  }) as GoalContext['call'];
  // (no mark of its own: the run's dry mark, which doubles, so a place across water draws no 250-block walk each time)
  t.deepEqual(await fetchForPens(ctx, 'in sight', { now: () => T0 }), { gain: 0, text: 'got no nearer than 60 to where a cow was seen at (-299, 63, 2183)' });
  t.deepEqual(sitesOf(world, 'cow'), [site]);
  // from the yard's east gate, 232 to go: at 2 a second, past the 90 s a walk within the leash was given
  t.is(asked.length, 1);
  t.true(asked[0].timeoutMs >= 115_000, JSON.stringify(asked));
  t.is(asked[0].bridge, asked[0].timeoutMs + 15_000);
  // got to, and none there: forgotten
  const w2 = liveWorld({ work: work() });
  t.deepEqual(await fetchForPens(new Pasture([], w2, KIT).ctx(w2), 'in sight', { now: () => T0 }), { gain: 0, text: 'no wild cow where one was seen at (-299, 63, 2183): forgotten' });
  t.deepEqual(sitesOf(w2, 'cow'), []);
});

test('the cows\' range is their own: a new range lets their terrain marks go at once (live, every side had doubled four times within the leash) and the cane\'s stay; a leash set past it is the range', (t) => {
  const world = liveWorld();
  const w = workOf(world);
  w.land = '-549,2183,96';
  const marked = (n: number) => ({ n, at: T0 - 10 * MINUTE });
  w.dry = { 'cows:north': marked(5), 'cows:east': marked(4), 'cows:south': marked(4), 'cows:west': marked(4), 'cows:in sight': marked(1), 'cane:south': marked(6) };
  const s = look(KIT);
  t.like(pick(rung('cows'), s, world), { decline: { cause: 'dry' } });
  t.deepEqual(workTick(s, world, () => undefined), ['work: cows reach 256 from home now (was 96): 5 terrain mark(s) let go']);
  t.deepEqual(Object.keys(w.dry), ['cane:south']);
  t.deepEqual(w.ranges, { cows: 256 });
  t.like(pick(rung('cows'), s, world), { variant: 'north' });
  t.deepEqual(workTick(s, world, () => undefined), []);
  // kept in brain.json, and what is not a range there dropped
  t.deepEqual(workOf(liveWorld({ work: JSON.parse(JSON.stringify(w)) })).ranges, { cows: 256 });
  t.false('ranges' in workOf(liveWorld({ work: { ...JSON.parse(JSON.stringify(w)), ranges: { cows: 'far', cane: -1 } } })));
  // the leash set to 300: every terrain mark goes with the land, as ever, and the cows' range is the leash
  markDry(world, 'cows:north', T0);
  world.leash = 300;
  t.deepEqual(workTick(s, world, () => undefined), ['work: a new home or leash: 2 terrain mark(s) let go']);
  t.deepEqual(w.ranges, { cows: 300 });
  t.like(pick(rung('cows'), s, world), { variant: 'north', dist: 300 });
});

test('a leash past 360 holds the cows to 360: what the fetch\'s 10 minutes hold out and back on the lead, so a side sets out (at 400 every run said "not setting out" and was chosen again at once)', async (t) => {
  const task = rung('cows');
  const world = liveWorld({ leash: 400 });
  t.deepEqual(task.variants(look(KIT), world).map(v => `${v.id} ${v.dist}`), ['north 360', 'east 360', 'south 360', 'west 360']);
  let got = 0;
  const probe: WorkTask = { ...task, run: async (_ctx, _variant, budgetMs) => { got = budgetMs; return { gain: 0, text: 'looked' }; } };
  const goal = goalOf(probe, { now: T0 });
  t.is(await goal.run(new Pasture([], world, KIT).ctx(world)), '[north] looked');
  // the whole way out and back on the lead in its budget, and the brain's timeout over that and the walk home
  t.is(got, needMs(360, 'far', task.backPace));
  t.true(goal.timeoutMs! >= got + 360 / 3 * 1000 + 30_000, `${goal.timeoutMs}`);
});

// ---- the pens round

test('the pens round writes work.pen and the sightings each time it looks, and walks a stray in on a lead', async (t) => {
  // one cow in the pen; two wild ones 40 and 45 off, out of the round's reach to lure (32)
  const world = liveWorld();
  const herd = [cow(1, -556, 2168), cow(2, -549 + 40, 2183), cow(3, -549, 2183 - 45), cow(4, -548, 2175, { named: true })];
  const pa = new Pasture(herd, world, [...KIT, { slot: 3, name: 'wheat', count: 10 }]);
  t.is(await pens.run(pa.ctx(world)), 'cow: 1 cow in the pen and none within 32 to lure; 1 cow ready to breed');
  t.deepEqual(workOf(world).pen.cow, { adults: 1, babies: 0, at: T0 });
  // the nearest first; the named one is no sighting
  t.deepEqual(sitesOf(world, 'cow'), [{ x: -509, y: 63, z: 2183 }, { x: -549, y: 63, z: 2138 }]);
  // a stray 20 off: on the lead and in, a second in the pen
  const w2 = liveWorld();
  const h2 = [cow(1, -556, 2168), cow(2, -540, 2175)];
  const pb = new Pasture(h2, w2, [...KIT, { slot: 3, name: 'wheat', count: 10 }]);
  const text = await pens.run(pb.ctx(w2));
  t.true(text.startsWith('cow: on the lead from 12 out; led in; '), text);
  t.true(penned(h2[1]));
  t.true(pb.log.includes('entity.use #2 lead'));
  t.is(workOf(w2).pen.cow.adults, 2);
});

/** the bot outside the pen's fence (the gate's cell outside it, or anywhere off the pen) */
const outOfPen = (p: Pos) => !(p.x >= PEN.x && p.x < PEN.x + PEN.width && p.z >= PEN.z && p.z < PEN.z + PEN.length);
/** the gate clicks and the closer, in order */
const gateLog = (pa: Pasture) => pa.log.filter(l => /^(use-item-on-block|gates\.auto|baritone opens|useOn)/.test(l));

// (serial: the game's clock is faked for the breeding cooldown, and the round's own record of who was fed is the module's)
test.serial('the pens round breeds its pair from inside the pen: fed with wheat, the gate shut behind the bot both ways and the wheat put away before it leaves; on the game\'s cooldown not fed again, and after it fed again', async (t) => {
  const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
  t.teardown(() => clock.restore());
  const world = liveWorld();
  // (the far one in the pen's corner, 3.6 from the cell inside the gate: out of the use key's reach from there)
  const herd = [cow(51, -557, 2166), cow(52, -554, 2168)];
  const pa = new Pasture(herd, world, [...KIT, { slot: 3, name: 'wheat', count: 10 }]);
  t.is(await pens.run(pa.ctx(world)), 'cow: fed 2 to breed; cow: 0 cow ready to breed');
  // (the nearer first)
  t.deepEqual(pa.log.filter(l => l.startsWith('entity.use') || l === 'a calf is born'), ['entity.use #52 wheat', 'entity.use #51 wheat', 'a calf is born']);
  t.deepEqual(workOf(world).pen.cow, { adults: 2, babies: 1, at: T0 });
  // in by the gate and shut behind, out again and shut behind, the client's closer off meanwhile; every walk careful:
  // up to the far one (to the inside cell by it nearest the bot, not onto its own), and back to the gate from the
  // corner before the click (out of reach, it walks there plain)
  t.deepEqual(gateLog(pa), ['gates.auto off', ...Array.from({ length: 4 }, () => `use-item-on-block ${k(GATE)}`), 'gates.auto on']);
  t.false(pa.isOpen(GATE));
  t.true(pa.careful.every(c => c));
  t.true(pa.log.includes('goto careful -556,2167'), pa.log.join('\n'));
  t.false(pa.log.some(l => l === 'move-to-position' || /^goto -/.test(l)), pa.log.join('\n'));
  t.true(outOfPen(pa.me), JSON.stringify(pa.me));
  // the wheat away (a sword in hand) before the gate opened to go out: the herd stayed in, the calf with it
  t.is(pa.held, 'diamond_sword');
  t.is(pa.cows.length, 3);
  t.true(pa.cows.every(penned), JSON.stringify(pa.cows.map(c => c.position)));
  // a round at once after: the two on the game's 5 min (the client cannot see it): not fed again, nothing walked
  const walks = pa.log.length;
  t.is(await pens.run(pa.ctx(world)), 'cow: 0 cow ready to breed');
  t.deepEqual(pa.log.slice(walks), []);
  // six minutes on: fed again, a second calf
  clock.tick(6 * MINUTE);
  t.is(await pens.run(pa.ctx(world)), 'cow: fed 2 to breed; cow: 0 cow ready to breed');
  t.is(pa.cows.filter(c => c.baby).length, 2);
  t.false(pa.isOpen(GATE));
});

/**
 * A pens round over the pasture with two cows to breed in the pen, its calls and tools passed through `hook` (the
 * test's own stand-in for what the brain or the bridge does), run as the brain runs it: once given up, every call
 * fails. What it came to, and the pasture.
 */
async function penRound(ids: [number, number], hook: (ac: AbortController, base: GoalContext) => Partial<GoalContext>) {
  const world = liveWorld();
  const pa = new Pasture([cow(ids[0], -556, 2167), cow(ids[1], -554, 2168)], world, [...KIT, { slot: 3, name: 'wheat', count: 10 }]);
  const ac = new AbortController();
  const base = pa.ctx(world, ac.signal);
  const ctx: GoalContext = { ...base, ...hook(ac, base) };
  const r = await brainRun.run({ signal: ac.signal }, () => pens.run(ctx).then(text => ({ text }), (e: Error) => ({ error: e.message })));
  return { r, pa };
}
const OUTSIDE_GATE = { x: GATE.x, z: GATE.z + 1 };

test('a pens round given up or failing on its way out of the pen leaves the gate shut and the client\'s closer on: given up on the walk out, given up as the gate opens, a look at the gate that fails', async (t) => {
  // given up as the bot walks out (the brain's cancel ends the walk): its every call fails from then on, and the gate
  // it opened with the closer off stood open, the herd inside, until the dusk sweep
  let fed = 0;
  const walkOut = await penRound([151, 152], (ac, base) => ({
    call: (async (method: string, p: Record<string, unknown> = {}) => {
      if (method === 'entity.use' && p.item === 'wheat') fed++;
      if (fed >= 2 && method === 'goto' && p.x === OUTSIDE_GATE.x && p.z === OUTSIDE_GATE.z && p.range === 0) {
        await base.call(method, p);
        ac.abort();
        throw new Error('aborted: the brain gave this job up');
      }
      return base.call(method, p);
    }) as GoalContext['call']
  }));
  t.false(walkOut.pa.isOpen(GATE), walkOut.pa.log.join('\n'));
  t.true(walkOut.pa.log.includes(`useOn ${k(GATE)}`));
  t.true(walkOut.pa.gatesAuto);
  t.is(walkOut.pa.held, 'diamond_sword');
  t.true(walkOut.pa.cows.every(penned));
  // given up as the click opens the gate to go out (the tool's answer comes back to a run given up: it throws): the
  // run threw before the closer was on again, and every gate and door Baritone opened after stood open
  let clicks = 0;
  const opening = await penRound([153, 154], (ac, base) => ({
    act: async (tool, a = {}) => {
      if (tool !== 'use-item-on-block' || ++clicks < 3) return base.act(tool, a);
      await base.act(tool, a);
      ac.abort();
      throw new Error('aborted');
    }
  }));
  t.is(clicks, 3);
  t.false(opening.pa.isOpen(GATE), opening.pa.log.join('\n'));
  t.true(opening.pa.gatesAuto);
  t.is(opening.pa.held, 'diamond_sword');
  t.true(opening.pa.cows.every(penned));
  // the look at the gate fails once on the way out (a bridge timeout): out all the same, the gate shut behind
  let feeds = 0;
  let failed = false;
  const region = await penRound([155, 156], (_ac, base) => ({
    call: (async (method: string, p: Record<string, unknown> = {}) => {
      if (method === 'entity.use' && p.item === 'wheat') feeds++;
      if (feeds >= 2 && !failed && method === 'world.region') { failed = true; throw new Error('timeout: world.region'); }
      return base.call(method, p);
    }) as GoalContext['call']
  }));
  t.true(failed);
  t.deepEqual(region.r, { text: 'cow: fed 2 to breed; cow: 0 cow ready to breed' });
  t.false(region.pa.isOpen(GATE), region.pa.log.join('\n'));
  t.true(region.pa.gatesAuto);
  t.true(outOfPen(region.pa.me), JSON.stringify(region.pa.me));
  // and failing as the bot goes in: the round fails, the closer on again
  const enter = await penRound([157, 158], (_ac, base) => ({
    call: (async (method: string, p: Record<string, unknown> = {}) => {
      if (method === 'world.region') throw new Error('timeout: world.region');
      return base.call(method, p);
    }) as GoalContext['call']
  }));
  t.deepEqual(enter.r, { error: 'timeout: world.region' });
  t.deepEqual(gateLog(enter.pa), ['gates.auto off', 'gates.auto on']);
  t.true(enter.pa.gatesAuto);
});

test('a pens round whose walk to the pen\'s gate ends short goes no further: no click on the gate from out of reach (it walks there plain), the closer left on', async (t) => {
  const r = await penRound([159, 160], (_ac, base) => ({
    call: (async (method: string, p: Record<string, unknown> = {}) => {
      // (the walk to the cell outside the gate gets nowhere: a block in the way)
      if (method === 'goto' && p.x === OUTSIDE_GATE.x && p.z === OUTSIDE_GATE.z && p.range === 1) return { arrived: false };
      return base.call(method, p);
    }) as GoalContext['call']
  }));
  t.deepEqual(r.r, { text: 'cow: could not get into the pen by its gate (-555, 63, 2171)' });
  t.deepEqual(gateLog(r.pa), []);
  t.false(r.pa.log.some(l => l === 'move-to-position' || /^goto -/.test(l) || l.startsWith('entity.use')), r.pa.log.join('\n'));
  t.true(r.pa.gatesAuto);
  t.false(r.pa.isOpen(GATE));
});

test('the pens round culls above 6 adults only, from inside the pen: never a calf, never someone\'s, never one outside the fence, never below 6; the drops picked up, the gate shut after', async (t) => {
  // seven adults of its own, two calves, a named one and one on someone's lead in the pen, a wild one by the fence
  const own = [[-557, 2166], [-556, 2166], [-555, 2166], [-554, 2166], [-553, 2166], [-557, 2168], [-556, 2168]].map(([x, z], i) => cow(61 + i, x, z));
  const calves = [cow(71, -555, 2168, { baby: true }), cow(72, -554, 2168, { baby: true })];
  const theirs = [cow(81, -553, 2168, { named: true }), cow(82, -553, 2169, { leashed: true })];
  const outside = cow(91, -551, 2167);
  const world = liveWorld();
  const pa = new Pasture([...own, ...calves, ...theirs, outside], world, KIT);
  const text = await pens.run(pa.ctx(world));
  // one culled, and the six bred on (wheat from the chests): the calves grow into the next surplus
  t.is(text, 'cow: culled one (Killed cow with 2 swing(s), 2 landed (diamond_sword x2) in 1); cow: fed 2 to breed; cow: fed 2 to breed');
  const killed = pa.log.filter(l => l.startsWith('killed #'));
  t.is(killed.length, 1);
  t.true(own.some(c => killed[0] === `killed #${c.id}`), killed.join());
  // the calves, someone's two and the one outside the fence are all there still, and none was fed or hit
  for (const c of [...calves, ...theirs, outside]) t.true(pa.cows.includes(c), `#${c.id}`);
  t.false(pa.log.some(l => /^entity\.use #(7[12]|8[12]|91)\b/.test(l)), pa.log.join('\n'));
  // the count is of the pen's own adults inside the fence: 6 left
  t.like(workOf(world).pen.cow, { adults: 6 });
  // the drops picked up where it fell, inside the pen: the fight walked nowhere through the gate
  t.is(pa.count('leather'), 1);
  t.false(gateLog(pa).some(l => l.startsWith('baritone opens')), gateLog(pa).join('\n'));
  t.false(pa.isOpen(GATE));
  t.true(outOfPen(pa.me));
  // six adults and four calves: a full pen, nothing culled or fed
  const w2 = liveWorld();
  const full = [...[-557, -556, -555, -554, -553, -557].map((x, i) => cow(161 + i, x, i < 5 ? 2166 : 2168)), ...[-556, -555, -554, -553].map((x, i) => cow(171 + i, x, 2169, { baby: true }))];
  const pb = new Pasture(full, w2, KIT);
  t.is(await pens.run(pb.ctx(w2)), 'cow: the pen is full (6 adults, 4 babies)');
  t.false(pb.log.some(l => l.startsWith('killed') || l.startsWith('entity.use')));
  t.false(pb.log.some(l => l.startsWith('use-item-on-block')), 'nobody went in');
});

test('live, Nov 13: a cull in the cow pen\'s corner by its corner post, the drops in the post\'s cell, on top of it and past it: every walk of the visit on the pen\'s inside cells, never the fence\'s; what fell past the fence left', async (t) => {
  // seven adults: the one alone in the south-west corner, by the post at (-558, 63, 2171), is the one culled. Live
  // the fight's own pick-up walked at a drop by that post and pressed the bot into the corner, its block the post's
  // (-558, 63, 2171), and the wedge watch stopped every job there for 1 h 45 min
  const row = [[-557, 2166], [-556, 2166], [-555, 2166], [-554, 2166], [-553, 2166], [-553, 2167]].map(([x, z], i) => cow(301 + i, x, z));
  const corner = cow(311, -557, 2170);
  const world = liveWorld();
  const pa = new Pasture([...row, corner], world, KIT, {
    cullDrops: c => (c.id !== corner.id ? [] : [
      { item: 'leather', position: { x: -557.2, y: 63, z: 2171.2 } }, // in the post's cell, inside the corner
      { item: 'beef', position: { x: -557.5, y: 64.5, z: 2171.5 } }, // on top of the post
      { item: 'beef', position: { x: -558.6, y: 63, z: 2172.4 } } // past it, outside the pen
    ])
  });
  // an earlier cull's leather past the west fence, lying there before this fight: not this cull's to count
  const old = { x: -559.6, y: 63, z: 2168.5 };
  pa.drops.push({ id: 4000, item: 'leather', position: { ...old } });
  const text = await pens.run(pa.ctx(world));
  t.true(text.startsWith('cow: culled one (Killed cow with 2 swing(s), 2 landed (diamond_sword x2) in 1), 1 drop(s) left by the fence; '), text);
  t.true(pa.log.includes(`killed #${corner.id}`));
  // the bot's block never a cell of the pen's fence ring (its gateway's included), every walk careful
  const ring = (q: Pos) => {
    const x = Math.floor(q.x), z = Math.floor(q.z), x2 = PEN.x + PEN.width - 1, z2 = PEN.z + PEN.length - 1;
    return ((x === PEN.x || x === x2) && z >= PEN.z && z <= z2) || ((z === PEN.z || z === z2) && x >= PEN.x && x <= x2);
  };
  t.deepEqual(pa.stood.filter(ring), []);
  t.true(pa.careful.every(c => c));
  // the two in reach of the corner's inside cell picked up from its middle; the one past the fence where it lies
  t.true(pa.log.includes('goto careful -557,2170'), pa.log.join('\n'));
  t.true(pa.log.includes('steer -557,2170'), pa.log.join('\n'));
  // the step ends within 0.1 of the cell's middle, sneaking: a drop on the post's far edge is 1.25 off it on the
  // axis, and the game picks up to 1.425 (the bot's box and the item's, and a block)
  t.deepEqual(pa.steers, [{ within: 0.1, sneak: true }]);
  t.is(pa.count('leather'), 1);
  t.is(pa.count('beef'), 1);
  t.deepEqual(pa.drops.map(d => d.position), [old, { x: -558.6, y: 63, z: 2172.4 }]);
  // out by the gate, shut behind
  t.false(pa.isOpen(GATE));
  t.true(outOfPen(pa.me));
});

// ---- walks that set out from inside a pen

/** Where the shelter's walk home set out from at night on Nov 13: in the cow pen, by its west fence. */
const IN_PEN: Pos = { x: -557, y: 63, z: 2170 };
/** what a walk out of the pen did, in order: the walks, the clicks on the gate, Baritone's own way through it, the closer */
const exitLog = (pa: Pasture) => pa.log.filter(l => /^(goto|use-item-on-block|useOn|baritone opens|the closer|go-home|move-to-position)/.test(l));
const PEN_WAY_OUT = ['goto careful -555,2169', `use-item-on-block ${k(GATE)}`, 'goto careful -555,2172', `use-item-on-block ${k(GATE)}`];

test('live, Nov 13: the shelter at night from inside the cow pen walks out by the pen\'s gate, carefully, the gate shut behind, then home to bed; and the brain sends the pens\' rings with the yard\'s', async (t) => {
  // live the walk home from (-557, 63, 2170) was go-home's own way, over the pen's west fence: wedged in it five times
  // in four minutes ("shelter is wedged in the oak_fence at -558,63,2170: stepping out")
  const bed = { x: -537, y: 63, z: 2193 };
  const world = liveWorld({ landmarks: { ...liveWorld().landmarks, bed } });
  const pa = new Pasture([cow(1, -554, 2167), cow(2, -556, 2167)], world, KIT);
  pa.me = mid(IN_PEN);
  const ctx = pa.ctx(world);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cows-'));
  const file = path.join(dir, 'brain.json');
  const logFile = path.join(dir, 'brain.log');
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': world }));
  const reply = (r: { ok: boolean; text: string }) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) });
  const actions = Object.fromEntries(['go-home', 'move-to-position', 'use-item-on-block'].map(tool => [tool, async (a: Record<string, unknown>) => reply(await ctx.act(tool, a))]));
  const zones: unknown[][] = [];
  const rt = {
    actions,
    call: (async (method: string, p?: Record<string, unknown>) => (method === 'bed.sleep' ? { sleeping: true } : ctx.call(method, p))) as ClientRuntime['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...pa.me }, block: { x: Math.floor(pa.me.x), y: 63, z: Math.floor(pa.me.z) }, timeOfDay: 13_000,
      hashedSeed: '1', dimension: 'overworld', sleeping: false, thundering: false, process: null, health: 20, food: 20 }),
    home: () => ({ ...HOME, dimension: 'overworld' }),
    lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: (...a: unknown[]) => { zones.push(a); },
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => T0, goals: [shelterGoal()], logFile, memoryFile: file });
  brain.setEnabled(true);
  await brain.tick();
  for (let i = 0; i < 10; i++) await settle();
  brain.setEnabled(false);
  const said = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => l.slice(25)).filter(l => !/^(autonomy|landmarks:|idle )/.test(l));
  t.deepEqual(said, [
    'start shelter: night: get home',
    'shelter: out of the cow pen by its gate (-555, 63, 2171)',
    'done shelter in 0s: walked home, asleep in the bed at (-537, 63, 2193)'
  ]);
  // to the cell 2 in from the gate, the gate opened, through to the cell outside, the gate shut; then go-home from there
  t.deepEqual(exitLog(pa).slice(0, 5), [...PEN_WAY_OUT, 'go-home']);
  t.false(pa.log.some(l => l === `baritone opens ${k(GATE)}`), pa.log.join('\n'));
  t.false(pa.isOpen(GATE));
  t.true(pa.careful.every(c => c));
  t.true(pa.cows.every(penned));
  t.true(horiz(pa.me, mid(HOME)) < 1);
  // the yard's rectangle, and the pen's ring with it: the client mod's band round both
  t.deepEqual(zones.at(-1), [{ x1: YARD.x1, z1: YARD.z1, x2: YARD.x2, z2: YARD.z2 }, [{ x1: -558, z1: 2165, x2: -552, z2: 2171 }]]);
});

test('a walk out of the yard from inside a pen leaves the pen by its gate first, shut behind; then the yard by the gate toward where it goes (the east one for the mine start), not the one nearest the pen', async (t) => {
  const world = liveWorld();
  const pa = new Pasture([cow(1, -554, 2167)], world, KIT);
  pa.me = mid(IN_PEN);
  const said: string[] = [];
  const out = await leaveYard(pa.ctx(world, undefined, said), { x: -493, z: 2183 });
  t.like(out, { gate: YARD_GATES[1] });
  t.deepEqual(said, ['out of the cow pen by its gate (-555, 63, 2171)', 'out of the yard by its east gate (-533, 63, 2183)']);
  // (from the pen's gate the west gate is the nearer: 14 to its cell inside, the east 22)
  t.deepEqual(exitLog(pa).slice(0, 6), [...PEN_WAY_OUT, 'goto careful -535,2183', 'goto careful -531,2183']);
  t.false(pa.isOpen(GATE));
  t.true(pa.cows.every(penned));
  // the trips' walk home between their legs, from inside the pen: the same way out, then go-home
  const pb = new Pasture([cow(1, -554, 2167)], world, KIT);
  pb.me = mid(IN_PEN);
  t.deepEqual(await goHome(pb.ctx(world), 300_000), { ok: true, text: 'Home' });
  t.deepEqual(exitLog(pb), [...PEN_WAY_OUT, 'go-home']);
  t.false(pb.isOpen(GATE));
});

test('only from inside a pen\'s fence: pressed against a post from inside it walks out by the gate; pressed against one from outside, at home, or in the gateway on its far side, no pen walk and no look at the gate; the sheep pen by its own gate', async (t) => {
  const world = liveWorld();
  const from = async (at: Pos, w = world) => {
    const pa = new Pasture([], w, KIT);
    pa.me = { ...at };
    const said: string[] = [];
    await goHome(pa.ctx(w, undefined, said), 300_000);
    return { said, log: exitLog(pa), pa };
  };
  // the bot's middle 0.075 into the west fence's cell (its box 0.6 wide, the post 0.25), from inside and from outside
  t.deepEqual((await from({ x: -557.075, y: 63, z: 2168.5 })).log, [...PEN_WAY_OUT, 'go-home']);
  for (const at of [{ x: -557.925, y: 63, z: 2168.5 }, { ...mid(HOME) }, { x: -554.5, y: 63, z: 2171.8 }]) {
    const r = await from(at);
    t.deepEqual(r.said, [], JSON.stringify(at));
    t.false(r.log.some(l => l.startsWith('use-item-on-block') || l.startsWith('goto careful')), JSON.stringify(at));
  }
  // the sheep pen, its gate north: in by 2 from it, out to the cell north of it
  const sheep = liveWorld({ zones: { ...liveWorld().zones, 'pen:sheep': [{ x: -542, y: 62, z: 2196, width: 7, length: 7 }], 'pen:sheep:gate': [{ x: -539, y: 63, z: 2196 }] } });
  const r = await from({ x: -540.5, y: 63, z: 2200.5 }, sheep);
  t.deepEqual(r.said, ['out of the sheep pen by its gate (-539, 63, 2196)']);
  t.deepEqual(r.log, ['goto careful -539,2198', 'use-item-on-block -539,63,2196', 'goto careful -539,2195', 'use-item-on-block -539,63,2196', 'go-home']);
});

test('a pen whose gateway a cow stands in: one try out, the gate shut behind from where the bot stands, said, and the walk home goes on as it would have; given up on the way out, the gate is clicked shut and nothing walks on', async (t) => {
  const world = liveWorld();
  const pa = new Pasture([cow(1, -554, 2167), cow(2, -555, 2171)], world, KIT);
  pa.me = mid(IN_PEN);
  const base = pa.ctx(world);
  const said: string[] = [];
  const ctx: GoalContext = {
    ...pa.ctx(world, undefined, said),
    // (the cow in the gateway: the walk through it gets nowhere)
    call: (async (method: string, p: Record<string, unknown> = {}) => (method === 'goto' && p.x === OUTSIDE_GATE.x && p.z === OUTSIDE_GATE.z ? { arrived: false } : base.call(method, p))) as GoalContext['call']
  };
  t.deepEqual(await goHome(ctx, 300_000), { ok: true, text: 'Home' });
  t.deepEqual(said, ['out of the cow pen by its gate (-555, 63, 2171)', 'no way out of the cow pen by its gate (-555, 63, 2171), shut behind: on by Baritone\'s own way']);
  // opened, the walk out got nowhere (the stand-in's walk is not made), shut again from the cell inside (in reach), and
  // go-home once: Baritone's own way (the stand-in's opens the gate, and the closer shuts it behind the bot)
  t.deepEqual(exitLog(pa).slice(0, 4), [PEN_WAY_OUT[0], PEN_WAY_OUT[1], PEN_WAY_OUT[3], 'go-home']);
  t.is(pa.log.filter(l => l === 'go-home').length, 1);
  t.is(pa.log.filter(l => l === PEN_WAY_OUT[0]).length, 1);
  t.false(pa.isOpen(GATE));
  // given up as the gate opens to go out (the brain's stop): the click shut from where the bot stands, outside the
  // run, and no go-home
  const ac = new AbortController();
  const pb = new Pasture([cow(1, -554, 2167)], world, KIT, { abortOnOpen: { gate: GATE, abort: () => ac.abort() } });
  pb.me = mid(IN_PEN);
  const cut = pb.ctx(world, ac.signal);
  const r = await brainRun.run({ signal: ac.signal }, () => goHome(cut, 300_000).then(x => ({ x }), (e: Error) => ({ error: e.message })));
  t.deepEqual(r, { error: 'aborted' });
  t.false(pb.isOpen(GATE), pb.log.join('\n'));
  t.true(pb.log.includes(`useOn ${k(GATE)}`));
  t.false(pb.log.includes('go-home'));
  t.true(pb.cows.every(penned));
});

// ---- the rung

test('the cows rung: unneeded with 2 adults, wanted with 0 or 1 whatever the project needs and with a stale count, out to the cow range, in sight before the sides; and pure', (t) => {
  const task = rung('cows');
  const ask = (w: WorldMemory, items: InventoryItem[] = KIT, over: Partial<Snapshot> = {}) => {
    const c = pick(task, look(items, over), w);
    return 'decline' in c ? `${c.decline.cause}: ${c.decline.text}` : `${c.variant}: ${c.why}`;
  };
  const work = (pen?: { adults: number; at: number }, sites: Pos[] = []): NonNullable<WorldMemory['work']> => ({
    dry: {}, next: {}, sites: sites.length ? { cow: sites } : {}, pen: pen ? { cow: { ...pen, babies: 0 } } : {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] }
  });
  const worlds = {
    live: liveWorld(),
    pair: liveWorld({ work: work({ adults: 2, at: T0 - 5 * MINUTE }) }),
    one: liveWorld({ work: work({ adults: 1, at: T0 - 5 * MINUTE }) }),
    stale: liveWorld({ work: work({ adults: 2, at: T0 - 31 * MINUTE }) }),
    met: liveWorld({}, { [k(DROPS_CHEST)]: { leather: 45 } }),
    free: liveWorld({ progress: { done: [], journal: [] } }),
    nopen: liveWorld({ zones: {} }),
    unread: liveWorld({ chestItems: {} }),
    nothing: liveWorld({}, { [k(GEAR_CHEST)]: { bucket: 8 }, [k(DROPS_CHEST)]: { leather: 7, string: 3 }, [k(FARM_CHEST)]: { bone_meal: 3 } }),
    seen: liveWorld({ work: work(undefined, [{ x: -509, y: 63, z: 2183 }, { x: -440, y: 63, z: 2183 }]) }),
    // the one cow seen on Nov 13, 147 out (past the leash, within the range), and one 300 out (past the range)
    far: liveWorld({ work: work(undefined, [{ x: -438, y: 67, z: 2279 }, { x: -249, y: 63, z: 2183 }]) }),
    gone: liveWorld({ work: work(undefined, [{ x: -249, y: 63, z: 2183 }]) })
  };
  for (const w of Object.values(worlds)) freeze(w);
  const before = JSON.stringify(worlds);
  // the sides go out to the cow range, past the leash
  t.is(ask(worlds.live), 'north: 256 blocks out');
  t.is(ask(worlds.pair), 'unneeded: the pen has 2 cows (they breed the rest)');
  t.is(ask(worlds.one), 'north: 256 blocks out');
  // half an hour old: not known any more, and a look is allowed
  t.is(ask(worlds.stale), 'north: 256 blocks out');
  // the herd is farmed for good: with the project's leather in, or no project waiting on any, the pen is still stocked
  t.is(ask(worlds.met), 'north: 256 blocks out');
  t.is(ask(worlds.free), 'north: 256 blocks out');
  t.is(ask(worlds.nopen), 'unneeded: no cow pen with a gate');
  t.is(ask(worlds.unread), 'unneeded: the chests are not all looked into yet');
  t.is(ask(worlds.nothing), 'kit: nothing to lead a cow home with (no lead, no 5 string for one, no wheat)');
  // a lead carried is something to lead one with
  t.is(ask(worlds.nothing, [...KIT, { slot: 3, name: 'lead', count: 1 }]), 'north: 256 blocks out');
  // where one was seen, ahead of the sides' turn, as far out as the farther of the two nearest places it was seen
  // (the fetch walks on to the second when the first holds none)
  t.deepEqual(task.variants(look(KIT), worlds.seen).map(v => `${v.id} ${v.dist}${v.first ? ' first' : ''}`), ['in sight 109 first', 'north 256', 'east 256', 'south 256', 'west 256']);
  // 147 out is within the range; 300 out is not offered
  t.deepEqual(task.variants(look(KIT), worlds.far).map(v => `${v.id} ${v.dist}${v.first ? ' first' : ''}`), ['in sight 147 first', 'north 256', 'east 256', 'south 256', 'west 256']);
  t.deepEqual(task.variants(look(KIT), worlds.gone).map(v => v.id), ['north', 'east', 'south', 'west']);
  const turned = liveWorld({ work: { ...work(undefined, [{ x: -509, y: 63, z: 2183 }]), next: { cows: 2 } } });
  freeze(turned);
  t.is(ask(turned), 'in sight: 40 blocks out');
  // unneeded before anything that would keep it at home
  const full = Array.from({ length: 36 }, (_, slot): InventoryItem => ({ slot, name: 'cobblestone', count: 64 }));
  t.is(ask(worlds.pair, full), 'unneeded: the pen has 2 cows (they breed the rest)');
  t.is(JSON.stringify(worlds), before);
});

test('the cows rung: a penned cow is gain; a side with none is a terrain mark that goes on doubling; where one was seen and none is any more is forgotten', async (t) => {
  const clock = { now: T0 };
  const goal = goalOf(rung('cows'), clock);
  // east first (the side a test wants: the queue's turn is the memory's)
  const world = liveWorld();
  workOf(world).next.cows = 1;
  const herd = [cow(7, -469, 2183)];
  const pa = new Pasture(herd, world, KIT);
  t.is(await goal.run(pa.ctx(world)), '[east] cow: on the lead from 81 out; led in; back home');
  t.deepEqual(workOf(world).dry, {});
  t.is(workOf(world).next.cows, 1);
  t.like(workOf(world).last, { task: 'cows', variant: 'east', gain: 1 });
  // the pen has its one now; a second is still wanted, after a deep trip (one unblocker trip a day before it)
  t.is(goal.wants(look(KIT), world), 'east: 256 blocks out (one such trip today already: the deep trip first)');

  // a side with no cow: a terrain mark, 20 min after the first, and past 160 min it goes on doubling
  const w2 = liveWorld();
  const pb = new Pasture([], w2, KIT);
  t.is(await goal.run(pb.ctx(w2)), '[north] no wild cows north within the cow range (256 from home); back home');
  t.deepEqual(workOf(w2).dry['cows:north'], { n: 1, at: T0 });
  t.is(dryUntil(w2, 'cows:north'), T0 + DRY_WAIT[0]);
  t.is(workOf(w2).next.cows, 1);
  // the stops out: every 32 north of home past the yard, to 240, none past the cow range; past the leash
  const outs = pb.log.filter(l => l.startsWith('goto')).map(l => { const [x, z] = l.split(' ').at(-1)!.split(',').map(Number); return Math.round(horiz({ x, z }, HOME)); });
  t.true(outs.every(d => d <= 256 - 16 + 1), outs.join(' '));
  t.is(Math.max(...outs), 240);
  workOf(w2).dry['cows:north'] = { n: 4, at: T0 - 200 * MINUTE };
  workOf(w2).next.cows = 0;
  t.is(goal.wants(look(KIT), w2), 'north: 256 blocks out, 4 dry before (dry 4 times: after the deep trip)');
  await goal.run(new Pasture([], w2, KIT).ctx(w2));
  t.deepEqual(workOf(w2).dry['cows:north'], { n: 5, at: T0 });
  t.is(dryUntil(w2, 'cows:north') - T0, 320 * MINUTE);

  // seen 40 east, gone by now: the place is forgotten, and `in sight` waits on its own mark
  const w3 = liveWorld({ work: { dry: {}, next: {}, sites: { cow: [{ x: -509, y: 63, z: 2183 }] }, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } } });
  t.is(goal.wants(look(KIT), w3), 'in sight: 40 blocks out');
  const pc = new Pasture([], w3, KIT);
  t.is(await goal.run(pc.ctx(w3)), '[in sight] no wild cow where one was seen at (-509, 63, 2183): forgotten; back home');
  t.deepEqual(sitesOf(w3, 'cow'), []);
  t.deepEqual(workOf(w3).dry['cows:in sight'], { n: 1, at: T0 });
  t.is(goal.wants(look(KIT), w3), 'north: 256 blocks out (one such trip today already: the deep trip first)');
  // and found there: walked in, the sides' turn left where it was
  const w4 = liveWorld({ work: { dry: {}, next: { cows: 2 }, sites: { cow: [{ x: -509, y: 63, z: 2183 }] }, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } } });
  const pd = new Pasture([cow(9, -469, 2190)], w4, KIT);
  t.is(await goal.run(pd.ctx(w4)), '[in sight] cow: on the lead from 81 out; led in; back home');
  t.is(workOf(w4).next.cows, 2);
});

test('the cows rung: a side where a cow was found and not brought in gets a first mark, not one more; a pen with its pair after all leaves the count as it was', async (t) => {
  const clock = { now: T0 };
  const goal = goalOf(rung('cows'), clock);
  // east had come back dry four times (160 min); this time a cow is found there and lost on the way
  const world = liveWorld();
  workOf(world).next.cows = 1;
  workOf(world).dry['cows:east'] = { n: 4, at: T0 - 200 * MINUTE };
  const pa = new Pasture([cow(7, -469, 2183)], world, KIT, { vanishOn: 2 });
  t.regex(await goal.run(pa.ctx(world)), /^\[east\] cow: on the lead from 81 out; lost on the way/);
  t.deepEqual(workOf(world).dry['cows:east'], { n: 1, at: T0 });
  t.is(dryUntil(world, 'cows:east'), T0 + DRY_WAIT[0]);
  t.is(workOf(world).next.cows, 2);
  // the pens round's count half an hour old, and the pen has its pair after all: nothing is learnt of the side
  const w2 = liveWorld({ work: { dry: { 'cows:north': { n: 3, at: T0 - 100 * MINUTE } }, next: {}, sites: {}, pen: { cow: { adults: 2, babies: 0, at: T0 - 31 * MINUTE } }, tier: 0, deep: { starts: [], clean: 0, deaths: [] } } });
  const pb = new Pasture([cow(1, -556, 2168), cow(2, -554, 2168)], w2, KIT);
  t.is(await goal.run(pb.ctx(w2)), '[north] the cow pen has 2 already: none fetched');
  t.deepEqual(workOf(w2).dry['cows:north'], { n: 3, at: T0 });
  t.is(goal.wants(look(KIT), w2), null);
});

// ---- the log

const settle = () => new Promise(r => setTimeout(r, 20));

test.serial('done work: cows, as brain.log says it', async (t) => {
  const world = liveWorld();
  workOf(world).next.cows = 1;
  const pa = new Pasture([cow(7, -469, 2183)], world, KIT);
  const ctx = pa.ctx(world);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cows-'));
  const file = path.join(dir, 'brain.json');
  const logFile = path.join(dir, 'brain.log');
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': world }));
  const reply = (r: { ok: boolean; text: string }) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) });
  const actions = Object.fromEntries(['go-home', 'move-to-position', 'take-from-chest', 'use-item-on-block', 'craft-item'].map(tool => [tool, async (a: Record<string, unknown>) => reply(await ctx.act(tool, a))]));
  const rt = {
    actions,
    call: (async (method: string, p?: Record<string, unknown>) => ctx.call(method, p)) as ClientRuntime['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...pa.me }, block: { x: Math.floor(pa.me.x), y: 63, z: Math.floor(pa.me.z) }, timeOfDay: 1000,
      hashedSeed: '1', dimension: 'overworld', sleeping: false, thundering: false, process: null, health: 20, food: 20 }),
    home: () => ({ ...HOME, dimension: 'overworld' }),
    lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  const goals: Goal[] = workGoals(() => undefined, [rung('cane patch'), rung('cows')], () => T0);
  const brain = new Brain(rt, { tickMs: 1e9, now: () => T0, goals, logFile, memoryFile: file });
  brain.setEnabled(true);
  await brain.tick();
  for (let i = 0; i < 10; i++) await settle();
  const said = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => l.slice(25)).filter(l => !/^(autonomy|landmarks:|idle )/.test(l));
  t.deepEqual(said, [
    'start work: cows: east: 256 blocks out',
    'work: cows: skipped: cane patch (unneeded: no cane to plant)',
    'work: cows: looking east for wild cows, 32 blocks out',
    'work: cows: out of the yard by its east gate (-533, 63, 2183)',
    'work: cows: fetching a cow for the pen: 48 blocks off, 81 from home',
    'done work: cows in 0s: [east] cow: on the lead from 81 out; led in; back home'
  ]);
  brain.setEnabled(false);
  await settle();
});

/**
 * The cows rung in a brain over the pasture with one more goal, `other` (it wants once `due` is set and the bot is
 * within 10 of home): the fetch's walk on the lead waits where it first comes within 9 of home, the brain looks once
 * more there, and the walk goes on. What the brain said, and the pasture.
 */
async function leadPastHome(other: (due: () => boolean) => Goal) {
  const world = liveWorld();
  workOf(world).next.cows = 1;
  let release!: () => void;
  let reached!: () => void;
  const near = new Promise<void>(r => { reached = r; });
  const pa = new Pasture([cow(7, -469, 2183)], world, KIT, { holdNear: { within: 9, until: new Promise<void>(r => { release = r; }), at: () => reached() } });
  const ctx = pa.ctx(world);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cows-'));
  const file = path.join(dir, 'brain.json');
  const logFile = path.join(dir, 'brain.log');
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': world }));
  const reply = (r: { ok: boolean; text: string }) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) });
  const actions = Object.fromEntries(['go-home', 'move-to-position', 'take-from-chest', 'use-item-on-block', 'craft-item'].map(tool => [tool, async (a: Record<string, unknown>) => reply(await ctx.act(tool, a))]));
  const rt = {
    actions,
    call: (async (method: string, p?: Record<string, unknown>) => ctx.call(method, p)) as ClientRuntime['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...pa.me }, block: { x: Math.floor(pa.me.x), y: 63, z: Math.floor(pa.me.z) }, timeOfDay: 1000,
      hashedSeed: '1', dimension: 'overworld', sleeping: false, thundering: false, process: null, health: 20, food: 20 }),
    home: () => ({ ...HOME, dimension: 'overworld' }),
    lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  let due = false;
  const goals: Goal[] = [other(() => due), ...workGoals(() => undefined, [rung('cows')], () => T0)];
  const brain = new Brain(rt, { tickMs: 1e9, now: () => T0, goals, logFile, memoryFile: file });
  brain.setEnabled(true);
  await brain.tick();
  await near;
  const there = { ...pa.me };
  due = true;
  await brain.tick();
  release();
  for (let i = 0; i < 10; i++) await settle();
  const said = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => l.slice(25)).filter(l => !/^(autonomy|landmarks:|idle )/.test(l));
  return { pa, there, said, brain };
}

test.serial('a cow on the lead is not let go for a home round: the walk from the yard\'s gate to the pen passes within 10 of home, where only survival cuts it', async (t) => {
  // the cows implementer's finding: from the east gate the way to the pen comes within 10 of home, inside the trip
  // rule's reach, and a home round more urgent than the trip (smelt 66, the kit 70, the stash 60) stopped the run
  // there: the cow was let go loose in the yard and its lead left lying
  const smelt = (due: () => boolean): Goal => ({
    name: 'smelt', priority: 66, wants: s => (due() && s.distHome <= 10 ? 'check the furnace for finished smelting' : null), run: async () => 'nothing to smelt', timeoutMs: 60_000, retryMs: 60_000
  });
  const a = await leadPastHome(smelt);
  t.true(horiz(a.there, HOME) <= 10, `the bot at ${JSON.stringify(a.there)}`);
  t.false(a.said().some(l => /^stopping work: cows/.test(l)), a.said().join('\n'));
  t.true(a.said().includes('done work: cows in 0s: [east] cow: on the lead from 81 out; led in; back home'), a.said().join('\n'));
  t.true(penned(a.pa.cows[0]));
  // the walk in done and the lead off, the home round has its turn
  await a.brain.tick();
  await settle();
  t.true(a.said().includes('start smelt: check the furnace for finished smelting'));
  a.brain.setEnabled(false);
  await settle();

  // survival still cuts it short there: the cow is let go where it stands, and the run says what it had brought in
  const shelter = (due: () => boolean): Goal => ({
    name: 'shelter', priority: 80, wants: () => (due() ? 'evening: head home before dark' : null), run: async () => 'walked home', timeoutMs: 60_000, retryMs: 60_000
  });
  const b = await leadPastHome(shelter);
  t.true(b.said().includes('stopping work: cows: shelter is more urgent (evening: head home before dark)'), b.said().join('\n'));
  t.is(b.pa.led.size, 0);
  t.false(penned(b.pa.cows[0]));
  b.brain.setEnabled(false);
  await settle();
});
