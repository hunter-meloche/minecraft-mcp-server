import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { brainRun, type ClientRuntime, type InventoryItem } from '../../src/client/tools.js';
import type { Goal, GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { Zone } from '../../src/client/brain/courtesy.js';
import { Brain, decide } from '../../src/client/brain/brain.js';
import { Ground, cellOf, checkLeg, entryOf, footprint, keepOff, planRoute, settle, yardEntry, yardPanel, type Entry } from '../../src/client/brain/boatroute.js';
import {
  HALL_WANTS, JUDGE_V, OUTPOST_CLEAR, VILLAGE_MADE, VILLAGE_RANGE, ZONES_NEAR, foldedInto, judgeVillage, knownVillage, noteSeen, noteVillage, outpostMade, peekVillages, pennedIn, rejudge, siteOpen,
  villagersLine, villagesOf, type LookZone, type Seen, type VillageLook, type VillageSite
} from '../../src/client/brain/village.js';
import { BOAT_PACE, DAY_MS, MOVE_BUDGET, closeUpGoal, homeMs, lastRailPlan, lookNeedMs, moveNeedMs, searchNeedMs, tooFarFrom, tooFarWord, villagersTask } from '../../src/client/brain/villagemove.js';
import { railsText } from '../../src/client/brain/railroute.js';
import { peekLine, railsHomeLine, railsTask, type RailLine } from '../../src/client/brain/railshome.js';
import { pick, workGoals } from '../../src/client/brain/work.js';
import { LADDER } from '../../src/client/brain/worktasks.js';
import { RECIPES, recipeFor } from '../../src/client/brain/progress.js';
import { activityAt } from '../../src/client/brain/schedule.js';
import { liveWorld, lookAt, realGoals, KEPT, WORN } from '../helpers/homestead.js';

/**
 * The villager move (P5c of the progression plan): the courtesy judge of a village (village.ts), the boat's way home
 * (boatroute.ts), and the move itself (villagemove.ts) over a stand-in world that answers as the bridge does
 * (Vehicle.java, the 26.3 boat checked against the jar): a boat put down for a villager goes down beside it, its box just
 * clear of the villager's (the game's boat item refuses a box any mob or the bot is in), and takes into its back seat a
 * villager standing within 0.2 of its box (never while it would also take another); the bot boards it in front and
 * steers; the drive moves it along a straight line and stops before a block at the boat's level (a step up, a wall:
 * it climbs nothing); dig.here and place-block within reach (4.5 from the eyes: a seated bot's 1.21 over the boat's
 * bottom); out of the boat 1.27 the way it faces; the boat broken back into its item, its passenger left where it
 * stood; the chunks round the bot loaded within 96 (world.region reads null further out). Shaped like the live
 * homestead (Nov 15): the yard x -565..-533, z 2119..2215, its birch fence, the north gate (-549, 63, 2119), the hall
 * at (-561, 62, 2126) 11 x 9 with its panel (-556, 63-64, 2126) in the north wall and its gate south (-556, 63, 2134); a
 * village 300 north on flat grass, its bell at (-556, 63, 1880).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 15, 14, 0, 0);
const HOME: Pos = { x: -549, y: 63, z: 2183 };
const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
const HALL = { x: -561, y: 62, z: 2126, width: 11, length: 9 };
const PANEL: Pos[] = [{ x: -556, y: 63, z: 2126 }, { x: -556, y: 64, z: 2126 }];
const HALL_GATE: Pos = { x: -556, y: 63, z: 2134 };
const NORTH_GATE: Pos = { x: -549, y: 63, z: 2119 };
const BELL: Pos = { x: -556, y: 63, z: 1880 };
const SPAWN = { x: -352, y: 63, z: 194 };
const FENCE = 'birch_fence[east=true,north=false,south=false,waterlogged=false,west=true]';
const k = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
/** The rung's searches when no village is open to it: the four sides, then the four bearings between them (Nov 15: the quarters between the sides went unseen). */
const SEARCHES = ['north', 'east', 'south', 'west', 'north-east', 'south-east', 'south-west', 'north-west'];
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** The live homestead's memory for the move: the hall built, the yard and its north gate, the switch on (unless `over` says). */
function hallWorld(over: Partial<WorldMemory> = {}): WorldMemory {
  return {
    landmarks: { chests: [], farmland: [] }, leash: 96, yard: { ...YARD }, chestItems: {}, lastDone: {},
    zones: {
      hall: [{ ...HALL }], 'hall:panel': PANEL.map(p => ({ ...p })), 'hall:gate': [{ ...HALL_GATE }], 'hall:inside': [{ x: -556, y: 63, z: 2130 }],
      'fence:gate': [{ ...NORTH_GATE }], fence: [{ x: YARD.x1, y: YARD.y, z: YARD.z1, width: YARD.x2 - YARD.x1 + 1, length: YARD.z2 - YARD.z1 + 1 }]
    },
    progress: { done: ['hall'], journal: [] },
    villagerMoves: true,
    villages: { sites: [{ x: BELL.x, y: BELL.y, z: BELL.z, villagers: 6, seenAt: T0 - 60 * MINUTE }], players: [] },
    ...over
  } as WorldMemory;
}

const countsOf = (items: InventoryItem[]) => {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return counts;
};
const snap = (items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot => ({
  now: T0, timeOfDay: 1000, activity: activityAt(over.timeOfDay ?? 1000), health: 20, food: 20, position: { ...HOME }, dimension: 'overworld', sleeping: false, raining: false,
  thundering: false, process: null, items, counts: countsOf(items), slotsUsed: items.filter(i => i.slot < 36).length, home: { ...HOME, dimension: 'overworld' },
  distHome: 0, ...over
});
/** What the bot carries for a move: the boat, the fence's posts, the wall's planks, a torch, an axe, a sword, bread. */
const KIT = (): InventoryItem[] => [
  { slot: 0, name: 'diamond_sword', count: 1 }, { slot: 1, name: 'diamond_axe', count: 1 }, { slot: 2, name: 'bread', count: 32 },
  { slot: 3, name: 'oak_boat', count: 1 }, { slot: 4, name: 'birch_fence', count: 4 }, { slot: 5, name: 'oak_planks', count: 8 }, { slot: 6, name: 'torch', count: 8 }
];

// ------------------------------------------------------------------------------------------------ the stand-in world

interface Villager extends Seen { position: Pos }

/**
 * The village's villagers: unemployed adults (101, 107), a farmer, a baby, a nitwit, a librarian, one by a lectern (106).
 * All at level 1, as a village makes them: one above it has been traded with by a player (the village is someone's).
 */
const VILLAGERS = (): Villager[] => [
  { id: 101, name: 'villager', position: { x: -556.5, y: 63, z: 1890.5 }, profession: 'none', level: 1, baby: false },
  { id: 102, name: 'villager', position: { x: -566.5, y: 63, z: 1878.5 }, profession: 'farmer', level: 1, baby: false },
  { id: 103, name: 'villager', position: { x: -550.5, y: 63, z: 1876.5 }, profession: 'none', level: 1, baby: true },
  { id: 104, name: 'villager', position: { x: -545.5, y: 63, z: 1872.5 }, profession: 'nitwit', level: 1, baby: false },
  { id: 105, name: 'villager', position: { x: -540.5, y: 63, z: 1882.5 }, profession: 'librarian', level: 1, baby: false },
  { id: 106, name: 'villager', position: { x: -561.5, y: 63, z: 1884.5 }, profession: 'none', level: 1, baby: false },
  { id: 107, name: 'villager', position: { x: -548.5, y: 63, z: 1866.5 }, profession: 'none', level: 1, baby: false }
];
/** The bells, beds and job sites the scans saw in the village, and what else of its markers (no player's among them). */
const MARKS = (): { name: string; at: Pos }[] => [
  { name: 'bell', at: { ...BELL } },
  { name: 'white_bed', at: { x: -570, y: 63, z: 1872 } }, { name: 'white_bed', at: { x: -541, y: 63, z: 1887 } }, { name: 'red_bed', at: { x: -544, y: 63, z: 1870 } },
  { name: 'lectern', at: { x: -561, y: 63, z: 1886 } }, { name: 'composter', at: { x: -568, y: 63, z: 1880 } }
];
/** The village's houses as the bridge's zones (on the surface): its own. */
const VILLAGE_ZONES = (): Zone[] => [
  { x1: -576, y1: 59, z1: 1866, x2: -564, y2: 70, z2: 1878, markers: 80, surface: true, sample: 'oak_planks' },
  { x1: -547, y1: 59, z1: 1880, x2: -536, y2: 70, z2: 1892, markers: 70, surface: true, sample: 'oak_planks' }
];

interface Boat { id: number; uuid: string; pos: Pos; passengers: number[] }

/**
 * The world as the bridge answers for it. `blocks` over a flat grass world at y 62, the yard's birch fence round its
 * box at y 63 (a torch on the post at (-556, 64, 2119)), the north gate, the hall's walls (logs at the corners, planks,
 * 3 high, a plank roof) and its gate. The village's houses stand as solid blocks. `opts.stopAt`: the drive leg (from 1)
 * that stops halfway with that reason; `offBy`: the leg that ends that far off to the side (x); a block walked takes a
 * quarter of a second, one driven half a second (the boat's 2 a second on land).
 */
class Land {
  t = T0;
  me: Pos = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  items: InventoryItem[];
  blocks = new Map<string, string>();
  villagers: Villager[];
  players: Seen[] = [];
  /** the markers the scans saw (a banner's `ominous`: the bridge read it as a pillager outpost's, Foreign.java) */
  marks: { name: string; at: Pos; ominous?: true }[];
  zones: Zone[];
  boat?: Boat;
  riding = false;
  log: string[] = [];
  said: string[] = [];
  legs = 0;
  /** where the bot stood at each world.region read (the chunks loaded round it) */
  reads = 0;
  constructor(public world: WorldMemory, public opts: {
    stopAt?: { leg: number; reason: string }; offBy?: { leg: number; dx: number }; looked?: number; noUnload?: boolean; houses?: { x1: number; z1: number; x2: number; z2: number }[];
    /**
     * the scans' reach (foreign.marks: only the markers this near the bot, as Foreign.scan's 48 round it), and `oldJar`:
     * no foreign.banners (unset: the banners in the chunks held, 96 round the bot, read where they hang)
     */
    scans?: number; oldJar?: boolean;
    /** the brain stops the run as this drive (from 1) gets under way: its signal aborted, the bridge's cancel ends the drive halfway */
    abortAt?: { leg: number; abort: AbortController };
    /**
     * the drive ends as the bridge's does (Vehicle.java): "arrived" the tick the boat is within its `within` of the end
     * (at once, unmoved, where it starts that near), at full speed, and it glides this much on: it stops `within - coast`
     * short of the end, on its line. Unset, it stops on the end itself
     */
    coast?: number;
  } = {}) {
    this.items = KIT();
    this.villagers = VILLAGERS();
    this.marks = MARKS();
    this.zones = VILLAGE_ZONES();
    for (const h of opts.houses ?? [{ x1: -575, z1: 1868, x2: -566, z2: 1876 }, { x1: -546, z1: 1882, x2: -538, z2: 1890 }]) {
      for (let x = h.x1; x <= h.x2; x++) for (let z = h.z1; z <= h.z2; z++) for (let y = 63; y <= 66; y++) this.blocks.set(`${x},${y},${z}`, 'oak_planks');
    }
  }

  /** the world's block (what was dug or placed, else the homestead and the land) */
  block(x: number, y: number, z: number): string {
    const b = this.blocks.get(`${x},${y},${z}`);
    if (b !== undefined) return b;
    if (y <= 61) return 'dirt';
    if (y === 62) return 'grass_block[snowy=false]';
    const ring = ((x === YARD.x1 || x === YARD.x2) && z >= YARD.z1 && z <= YARD.z2) || ((z === YARD.z1 || z === YARD.z2) && x >= YARD.x1 && x <= YARD.x2);
    if (y === 63 && ring) return x === NORTH_GATE.x && z === NORTH_GATE.z ? 'birch_fence_gate[facing=north,open=false]' : FENCE;
    if (y === 64 && x === -556 && z === YARD.z1) return 'torch';
    const inHall = x >= HALL.x && x < HALL.x + HALL.width && z >= HALL.z && z < HALL.z + HALL.length;
    if (inHall && y >= 63 && y <= 66) {
      if (y === 66) return 'oak_planks';
      const edgeX = x === HALL.x || x === HALL.x + HALL.width - 1, edgeZ = z === HALL.z || z === HALL.z + HALL.length - 1;
      if (x === HALL_GATE.x && z === HALL_GATE.z && y <= 64) return y === 63 ? 'oak_fence_gate[facing=south,open=false]' : 'air';
      if (edgeX && edgeZ) return 'oak_log[axis=y]';
      if (edgeX || edgeZ) return 'oak_planks';
    }
    return 'air';
  }
  private solidAt(x: number, y: number, z: number) { return cellOf(this.block(x, y, z)).kind !== 'open'; }
  private eye() { return this.riding && this.boat ? { ...this.boat.pos, y: this.boat.pos.y + 1.21 } : { ...this.me, y: this.me.y + 1.62 }; }
  private reach(p: Pos, by = 4.5) { const e = this.eye(); return Math.hypot(e.x - p.x - 0.5, e.y - p.y - 0.5, e.z - p.z - 0.5) <= by; }
  private walk(to: { x: number; z: number }, y = 63) {
    const d = horiz(this.me, to);
    this.me = { x: to.x, y, z: to.z };
    this.t += Math.round(d * 250);
  }
  private loaded(x: number, z: number) { return this.opts.noUnload || Math.hypot(x + 0.5 - this.me.x, z + 0.5 - this.me.z) <= 96; }
  /**
   * Where the bridge's vehicle.place {for} puts the boat for a villager standing at `v` (Vehicle.beside): its centre
   * 0.6875 + 0.3 + 0.1 off along one axis, the side nearest the bot first; refused where a block stands at its level
   * under its box, or its box meets the bot's or any villager's (the game's boat item refuses it), or it is out of reach.
   */
  private beside(v: Pos): { pos: Pos } | { why: string } {
    const d = 0.6875 + 0.3 + 0.1;
    const sides = [[d, 0], [-d, 0], [0, d], [0, -d]].map(([dx, dz]) => ({ x: v.x + dx, y: v.y, z: v.z + dz })).sort((a, b) => horiz(a, this.me) - horiz(b, this.me));
    const why: string[] = [];
    const meets = (a: Pos, half: number) => (q: Pos) => Math.abs(q.x - a.x) < half + 0.3 && Math.abs(q.z - a.z) < half + 0.3 && Math.abs(q.y - a.y) < 1;
    for (const q of sides) {
      let wall = false;
      for (let x = Math.floor(q.x - 0.6875); x <= Math.floor(q.x + 0.6875); x++) for (let z = Math.floor(q.z - 0.6875); z <= Math.floor(q.z + 0.6875); z++) if (this.solidAt(x, 63, z)) wall = true;
      if (wall) { why.push('no room'); continue; }
      if (meets(q, 0.6875)(this.me) || this.villagers.some(o => meets(q, 0.6875)(o.position))) { why.push('a mob or the bot in the boat\'s room'); continue; }
      const e = this.eye();
      if (Math.hypot(e.x - q.x, e.y - q.y, e.z - q.z) > 4.5) { why.push('too far'); continue; }
      return { pos: q };
    }
    return { why: `no spot beside the villager for a boat (${why.join('; ')})` };
  }
  private villagerAt(x: number, y: number, z: number) {
    return this.villagers.some(v => Math.floor(v.position.x) === x && Math.floor(v.position.z) === z && (Math.floor(v.position.y) === y || Math.floor(v.position.y) + 1 === y));
  }

  inventory() { return { items: this.items.map(i => ({ ...i })) }; }
  status() {
    return {
      inWorld: true, username: 'claudebot', screen: null, position: { ...this.me }, block: { x: Math.floor(this.me.x), y: Math.floor(this.me.y), z: Math.floor(this.me.z) },
      dimension: 'overworld', timeOfDay: 1000, health: 20, food: 20, spawn: { ...SPAWN },
      riding: this.riding && this.boat ? { id: this.boat.id, uuid: this.boat.uuid, position: { ...this.boat.pos }, seat: 0, controlling: true, passengers: this.boat.passengers.map(id => ({ id })) } : null
    };
  }
  take(name: string, n = 1) {
    const it = this.items.find(i => i.name === name && i.count >= n);
    if (!it) return false;
    it.count -= n;
    if (!it.count) this.items = this.items.filter(i => i !== it);
    return true;
  }
  give(name: string, n = 1) {
    const it = this.items.find(i => i.name === name);
    if (it) it.count += n; else this.items.push({ slot: 20 + this.items.length, name, count: n });
  }

  call(method: string, p: Record<string, unknown> = {}): unknown {
    const n = (key: string) => Number(p[key]);
    switch (method) {
      case 'inventory': return this.inventory();
      case 'world.region': {
        this.reads++;
        const out: (string | null)[] = [];
        for (let y = 0; y < n('height'); y++) for (let z = 0; z < n('length'); z++) for (let x = 0; x < n('width'); x++) {
          const bx = n('x') + x, by = n('y') + y, bz = n('z') + z;
          out.push(this.loaded(bx, bz) ? this.block(bx, by, bz) : null);
        }
        return { blocks: out };
      }
      case 'world.entities': {
        const max = Number(p.maxDistance ?? 32);
        const all: Seen[] = [
          ...this.villagers.map(v => ({ ...v, position: { ...v.position }, ...(this.boat?.passengers.includes(v.id) ? { vehicle: 'oak_boat', vehicleId: this.boat.id } : {}) })),
          ...this.players,
          ...(this.boat ? [{ id: this.boat.id, name: 'oak_boat', position: { ...this.boat.pos }, own: true, uuid: this.boat.uuid, passengers: [...this.boat.passengers] }] : [])
        ];
        return { entities: all.filter(e => (!p.type || e.name === p.type) && e.position && Math.hypot(e.position.x - this.me.x, e.position.y - this.me.y, e.position.z - this.me.z) <= max) };
      }
      case 'world.findBlocks': {
        const max = Number(p.maxDistance ?? 32);
        return { positions: this.marks.filter(m => m.name === p.block && horiz(m.at, this.me) <= max).map(m => ({ ...m.at })) };
      }
      case 'foreign.zones': return { dimension: 'overworld', zones: this.zones.map(z => ({ ...z })) };
      case 'foreign.banners': {
        if (this.opts.oldJar) return {};
        const at = this.marks.filter(m => /_banner$/.test(m.name) && horiz(m.at, this.me) <= 96 && horiz(m.at, { x: n('x'), z: n('z') }) <= n('r'))
          .map(q => ({ ...q.at, name: q.name, ...(q.ominous ? { ominous: true } : {}) }));
        return { dimension: 'overworld', at, chunks: 1 };
      }
      case 'foreign.marks': {
        const seen = (q: Pos) => this.opts.scans === undefined || horiz(q, this.me) <= this.opts.scans;
        const inBox = (q: Pos) => seen(q) && q.x >= n('x1') && q.x <= n('x2') && q.z >= n('z1') && q.z <= n('z2') && (p.y1 === undefined || q.y >= n('y1')) && (p.y2 === undefined || q.y <= n('y2'));
        const re = p.match ? new RegExp(String(p.match)) : undefined;
        const kinds: Record<string, number> = {}, ominous: Record<string, number> = {};
        for (const m of this.marks.filter(q => inBox(q.at))) {
          kinds[m.name] = (kinds[m.name] ?? 0) + 1;
          if (m.ominous) ominous[m.name] = (ominous[m.name] ?? 0) + 1;
        }
        const chunks = Math.floor(n('x2') / 16) - Math.floor(n('x1') / 16) + 1, rows = Math.floor(n('z2') / 16) - Math.floor(n('z1') / 16) + 1;
        const of = chunks * rows;
        const at = re ? this.marks.filter(q => inBox(q.at) && re.test(q.name)).map(q => ({ ...q.at, name: q.name, ...(q.ominous ? { ominous: true } : {}) })) : [];
        return { kinds, ominous, at, chunks: this.opts.looked ?? of, of };
      }
      case 'goto': {
        const careful = p.careful === true;
        const to = { x: n('x') + 0.5, z: n('z') + 0.5 };
        let at = to;
        if (p.away) at = { x: this.me.x + 2, z: this.me.z };
        else if (Number(p.range ?? 0) > 0 && horiz(this.me, to) > Number(p.range)) {
          const d = horiz(this.me, to), r = Number(p.range) / d;
          at = { x: to.x + (this.me.x - to.x) * r, z: to.z + (this.me.z - to.z) * r };
        }
        this.log.push(`goto ${fmt({ x: n('x'), y: n('y'), z: n('z') })}${careful ? ' careful' : ''}`);
        this.walk(at);
        return { arrived: true };
      }
      case 'vehicle.place': {
        if (!p.inVillage) return { ok: false, reason: 'in someone\'s build (a zone)' };
        let pos: Pos;
        if (p.x !== undefined) {
          // (on the top face of the block given, its middle)
          const at = { x: n('x'), y: n('y'), z: n('z') };
          if (!this.reach(at)) return { ok: false, reason: 'too far' };
          pos = { x: at.x + 0.5, y: at.y + 1, z: at.z + 0.5 };
        } else {
          const mob = this.villagers.find(v => v.id === Number(p.for));
          if (p.for === undefined || !mob) return { ok: false, reason: `no creature with id ${String(p.for)} nearby` };
          const spot = this.beside(mob.position);
          if ('why' in spot) return { ok: false, reason: spot.why };
          pos = spot.pos;
        }
        // (the game's boat item refuses a box any villager stands in: on top of one, no boat)
        if (this.villagers.some(v => Math.abs(v.position.x - pos.x) < 0.9875 && Math.abs(v.position.z - pos.z) < 0.9875 && Math.abs(v.position.y - pos.y) < 1)) return { ok: false, reason: 'no boat appeared (Fail[])' };
        if (!this.take(String(p.item))) return { ok: false, reason: `no ${String(p.item)} carried` };
        // a mob within 0.2 of the boat's box is taken in
        const takes = this.villagers.filter(v => Math.abs(v.position.x - pos.x) < 0.6875 + 0.2 + 0.3 && Math.abs(v.position.z - pos.z) < 0.6875 + 0.2 + 0.3 && Math.abs(v.position.y - pos.y) < 1);
        if (takes.some(v => v.id !== Number(p.for))) { this.give(String(p.item)); return { ok: false, reason: 'the boat would take another too' }; }
        this.boat = { id: 900, uuid: 'b0a7-0001', pos: { ...pos }, passengers: takes.slice(0, 2).map(v => v.id) };
        const at = { x: Math.floor(pos.x), y: Math.floor(pos.y - 0.01), z: Math.floor(pos.z) };
        this.log.push(`boat down at ${fmt(at)}${takes.length ? `, villager ${takes[0].id} in` : ''}`);
        return { ok: true, id: 900, uuid: this.boat.uuid, position: { ...pos }, passengers: [...this.boat.passengers], boarded: takes[0]?.id ?? null, tookIt: takes[0]?.id === Number(p.for) };
      }
      case 'vehicle.mount': {
        if (!this.boat || n('id') !== this.boat.id) return { ok: false, reason: 'no such boat' };
        if (horiz(this.me, this.boat.pos) > 4) return { ok: false, reason: 'too far' };
        this.riding = true;
        this.me = { ...this.boat.pos };
        this.log.push('into the boat');
        return { ok: true, id: this.boat.id, seat: 0, controlling: true, passengers: [] };
      }
      case 'vehicle.drive': {
        if (!this.riding || !this.boat) return { ok: false, reason: 'not in a boat' };
        const to = p.to as { x: number; z: number };
        this.legs++;
        const from = { ...this.boat.pos };
        const d = horiz(from, to);
        // (the drive stops before a block at the boat's level, as the bridge's look ahead does: the boat climbs nothing)
        let end = { x: to.x, z: to.z }, reason = 'arrived';
        for (let s = 0.5; s <= d; s += 0.5) {
          const q = { x: from.x + (to.x - from.x) * s / d, z: from.z + (to.z - from.z) * s / d };
          for (const [ox, oz] of [[0, 0], [0.68, 0], [-0.68, 0], [0, 0.68], [0, -0.68]]) {
            if (this.solidAt(Math.floor(q.x + ox), 63, Math.floor(q.z + oz))) { reason = 'a step up ahead (a boat climbs nothing)'; break; }
          }
          if (reason !== 'arrived') { end = { x: from.x + (to.x - from.x) * (s - 1) / d, z: from.z + (to.z - from.z) * (s - 1) / d }; break; }
        }
        if (this.opts.stopAt?.leg === this.legs) { reason = this.opts.stopAt.reason; end = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 }; }
        // (the brain stops the run as the boat goes: the bridge's cancel ends the drive where it is)
        if (this.opts.abortAt?.leg === this.legs) { this.opts.abortAt.abort.abort(); reason = 'cancelled'; end = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 }; }
        if (this.opts.coast !== undefined && reason === 'arrived' && d > 0) {
          const within = Math.max(0.5, Number(p.within ?? 1.5));
          const short = d <= within ? d : within - this.opts.coast;
          end = { x: to.x - (to.x - from.x) / d * short, z: to.z - (to.z - from.z) / d * short };
        }
        // (the bridge's time limit: past timeoutMs the drive ends where the boat has got to at its pace, "timed out")
        const went = horiz(from, end), limit = Math.max(1000, Number(p.timeoutMs ?? 120_000));
        if (went / BOAT_PACE * 1000 > limit) {
          const f = limit / 1000 * BOAT_PACE / went;
          end = { x: from.x + (end.x - from.x) * f, z: from.z + (end.z - from.z) * f };
          reason = 'timed out';
        }
        // (arrived within the drive's half block, but that much off to one side)
        if (this.opts.offBy?.leg === this.legs) end = { x: end.x + this.opts.offBy.dx, z: end.z };
        this.boat.pos = { x: end.x, y: 63, z: end.z };
        this.me = { ...this.boat.pos };
        for (const v of this.villagers.filter(q => this.boat!.passengers.includes(q.id))) v.position = { ...this.boat.pos };
        this.t += Math.round(horiz(from, end) / BOAT_PACE * 1000);
        this.log.push(`drive to (${Math.round(to.x * 10) / 10}, ${Math.round(to.z * 10) / 10})${reason === 'arrived' ? '' : `: ${reason}`}`);
        return { ok: reason === 'arrived', reason, at: { ...this.boat.pos }, seconds: Math.round(horiz(from, end) / BOAT_PACE) };
      }
      case 'vehicle.dismount': {
        if (!this.riding || !this.boat) return { ok: true, wasRiding: false };
        const t = (p.toward as { x: number; z: number } | undefined) ?? { x: this.boat.pos.x + 1, z: this.boat.pos.z };
        const d = horiz(this.boat.pos, t) || 1;
        this.riding = false;
        this.me = { x: this.boat.pos.x + (t.x - this.boat.pos.x) / d * 1.27, y: 63, z: this.boat.pos.z + (t.z - this.boat.pos.z) / d * 1.27 };
        this.log.push('out of the boat');
        return { ok: true, wasRiding: true, at: { ...this.me } };
      }
      case 'vehicle.take': {
        if (!this.boat || n('id') !== this.boat.id) return { ok: false, reason: 'no such boat' };
        if (this.riding) return { ok: false, reason: 'riding it' };
        if (horiz(this.me, this.boat.pos) > 4) return { ok: false, reason: 'too far' };
        for (const v of this.villagers.filter(q => this.boat!.passengers.includes(q.id))) v.position = { ...this.boat.pos };
        this.log.push(`boat taken up at (${Math.round(this.boat.pos.x * 10) / 10}, ${Math.round(this.boat.pos.z * 10) / 10})`);
        this.boat = undefined;
        this.give('oak_boat');
        return { ok: true, hits: 1, item: 'oak_boat', pickedUp: true, passengersOut: [] };
      }
      case 'dig.here': {
        const at = { x: n('x'), y: n('y'), z: n('z') };
        const was = this.block(at.x, at.y, at.z);
        if (was === 'air') return { dug: false, reason: 'air' };
        if (!this.reach(at)) return { dug: false, reason: 'out of reach or out of sight' };
        this.blocks.set(k(at), 'air');
        this.log.push(`dig ${was.replace(/\[.*$/, '')} ${fmt(at)}${this.riding ? ' from the boat' : ''}`);
        return { dug: true, block: was };
      }
      case 'status': return this.status();
      default: return {};
    }
  }

  act(tool: string, p: Record<string, unknown> = {}): { ok: boolean; text: string } {
    if (tool === 'go-home') {
      this.walk({ x: HOME.x + 0.5, z: HOME.z + 0.5 });
      this.log.push('go-home');
      return { ok: true, text: 'Arrived home' };
    }
    if (tool === 'place-block') {
      const at = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
      const item = String(p.item);
      const was = this.block(at.x, at.y, at.z);
      if (was !== 'air') return { ok: true, text: `There's already a block (${was}) at ${fmt(at)}` };
      if (!this.reach(at)) return { ok: true, text: `Failed to place block at ${fmt(at)}: too far` };
      if (Math.floor(this.me.x) === at.x && Math.floor(this.me.z) === at.z && (at.y === Math.floor(this.me.y) || at.y === Math.floor(this.me.y) + 1)) return { ok: true, text: 'You can\'t place a block where you\'re standing or one block above' };
      if (this.villagerAt(at.x, at.y, at.z)) return { ok: true, text: `Failed to place block at ${fmt(at)}: the server did not accept it` };
      if (!this.take(item)) return { ok: true, text: `No ${item} in inventory to place` };
      const state = item === 'birch_fence' ? FENCE : item;
      this.blocks.set(k(at), state);
      this.log.push(`place ${item} ${fmt(at)}`);
      return { ok: true, text: `Placed ${state} at ${fmt(at)} using down face` };
    }
    return { ok: false, text: `no tool ${tool}` };
  }

  ctx(over: Partial<GoalContext> = {}): GoalContext {
    // (as the runtime: once the brain gives a run up, every call it makes is refused, but those made outside it)
    const given = () => { if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up'); };
    return {
      s: snap(this.items), world: this.world, signal: new AbortController().signal,
      act: async (tool, args = {}) => { given(); return this.act(tool, args); },
      call: (async (m: string, p?: Record<string, unknown>) => { given(); return this.call(m, p); }) as GoalContext['call'],
      status: (async () => { given(); return this.status(); }) as GoalContext['status'],
      progress: (text: string) => { this.said.push(text); },
      gain: () => undefined,
      ...over
    };
  }
}

/** The rung as the brain runs it (work.ts's wrapper: the hour, the marks, the walk home), on the stand-in world's clock. */
const rung = (land: Land) => workGoals(() => undefined, [villagersTask], () => land.t)[0];

// ------------------------------------------------------------------------------------------------ the judge

/** The live village as a look round it sees it: free. */
function freeLook(over: Partial<VillageLook> = {}): VillageLook {
  const marks = MARKS();
  return {
    bells: marks.filter(m => m.name === 'bell').map(m => m.at),
    beds: marks.filter(m => /_bed$/.test(m.name)).map(m => m.at),
    jobs: marks.filter(m => /lectern|composter/.test(m.name)).map(m => ({ name: m.name, at: m.at })),
    seen: VILLAGERS(), penned: new Set(), kinds: { oak_planks: 300, white_bed: 2, red_bed: 1, bell: 1, lectern: 1, composter: 1, torch: 12, glass_pane: 16, lantern: 2 },
    looked: { chunks: 30, of: 30 }, zones: VILLAGE_ZONES(), players: [], spawn: { x: SPAWN.x, z: SPAWN.z },
    ...over
  };
}

test('the courtesy judge: the live village is free, and of its seven only the two unemployed adults may be taken (no farmer, baby, nitwit or librarian, nor the one by the lectern)', (t) => {
  const v = judgeVillage(freeLook());
  t.is(v.kind, 'free');
  if (v.kind !== 'free') return;
  t.deepEqual(v.candidates.map(e => e.id), [101, 107]);
  t.is(v.villagers, 7);
  t.is(v.why, '7 villagers, 2 unemployed adult(s) to take (2 employed, 1 babies, 1 nitwits, 1 by a job site)');
  // its own houses are the zones that meet its area: the way home leaves them out of its 16
  t.is(v.own.length, 2);
  t.deepEqual(v.area, { x1: -594, z1: 1842, x2: -517, z2: 1914, y1: 39, y2: 87 });
});

test('the courtesy judge since Nov 20: someone\'s only near the spawn or with a trading setup in use (two villagers named, traded with, on a lead or riding); a pen, a player seen, a sign, another build are noted, the village free', (t) => {
  const theirs = (look: VillageLook) => { const v = judgeVillage(look); return v.kind === 'theirs' ? v.why : `not theirs: ${v.kind} ${v.why}`; };
  const free = (look: VillageLook) => { const v = judgeVillage(look); return v.kind === 'free' ? v : undefined; };
  // two villagers named: a setup in use, someone's
  const named = VILLAGERS();
  named[3] = { ...named[3], named: true, customName: 'Bob' };
  named[0] = { ...named[0], named: true };
  t.is(theirs(freeLook({ seen: named })), '2 villagers used by a player: (-557, 63, 1890) is named, (-546, 63, 1872) is named (Bob)');
  // two traded with (above level 1, or with trade xp where reported)
  const traded = VILLAGERS();
  traded[1] = { ...traded[1], level: 3 };
  traded[4] = { ...traded[4], xp: 12 };
  t.is(theirs(freeLook({ seen: traded })), '2 villagers used by a player: (-567, 63, 1878) is at level 3, (-541, 63, 1882) has 12 trade xp');
  // a lead and a seat count alike
  const tied = VILLAGERS();
  tied[1] = { ...tied[1], vehicle: 'minecart', vehicleId: 7 };
  tied[2] = { ...tied[2], leashed: true };
  t.like(judgeVillage(freeLook({ seen: tied })), { kind: 'theirs', rule: 'villager' });
  // one named villager: free, but that villager never taken
  const one = VILLAGERS();
  one[0] = { ...one[0], named: true, customName: 'Bob' };
  const v1 = free(freeLook({ seen: one }));
  t.truthy(v1);
  t.deepEqual(v1?.candidates.map(e => e.id), [107]);
  t.regex(v1?.why ?? '', /1 used by a player/);
  t.regex(v1?.why ?? '', /noted: a villager \(-557, 63, 1890\) is named \(Bob\) \(not taken\)/);
  // one villager penned in: skipped, the village free
  const pen = free(freeLook({ penned: new Set([101]) }));
  t.deepEqual(pen?.candidates.map(e => e.id), [107]);
  t.regex(pen?.why ?? '', /1 penned in/);
  // what only a player puts down, in it or within 16: noted, the village free
  for (const [kind, n] of [['oak_sign', 1], ['rail', 6], ['redstone_wire', 3], ['nether_portal', 6], ['white_banner', 1], ['white_concrete', 40]] as const) {
    const v = free(freeLook({ kinds: { ...freeLook().kinds, [kind]: n } }));
    t.truthy(v, kind);
    t.deepEqual(v?.notes, [`a player's marks within 16: ${kind} x${n}`]);
    t.deepEqual(v?.candidates.map(e => e.id), [101, 107]);
  }
  // a player seen within 64 of its area, ever: noted, the village free
  const area = judgeVillage(freeLook());
  if (area.kind !== 'free') return t.fail();
  t.deepEqual(free(freeLook({ players: [{ x: area.area.x2 + 63, z: 1880, at: T0 - 3 * 24 * 60 * MINUTE }] }))?.notes, ['a player was seen 63 from it, at (-454, 1880) (14:00)']);
  t.deepEqual(free(freeLook({ players: [{ x: area.area.x2 + 70, z: 1880, at: T0 }] }))?.notes, []);
  // near the world spawn: within 256 of it, someone's still
  t.is(theirs(freeLook({ spawn: { x: -556, z: 1914 + 200 } })), 'within 256 of the world spawn (200 off)');
  // another build of others next to it: noted, the village free
  const other: Zone = { x1: -500, y1: 60, z1: 1870, x2: -490, y2: 70, z2: 1880, markers: 30, surface: true, sample: 'stone_bricks' };
  t.deepEqual(free(freeLook({ zones: [...VILLAGE_ZONES(), other] }))?.notes, ['another build 17 from it (x -500..-490, z 1870..1880, stone_bricks)']);
  t.deepEqual(free(freeLook({ zones: [...VILLAGE_ZONES(), { ...other, x1: -460, x2: -450 }] }))?.notes, [], '57 off: not even noted');
  t.deepEqual(free(freeLook({ zones: [...VILLAGE_ZONES(), { ...other, surface: false }] }))?.notes, [], 'a mineshaft under it is the world\'s');
});

test('the courtesy judge: a village of fewer than 5, or not all seen yet, waits; nothing there is no village', (t) => {
  const four = VILLAGERS().slice(0, 4);
  t.like(judgeVillage(freeLook({ seen: four })), { kind: 'wait', why: '4 villager(s) seen, 5 or more wanted' });
  t.like(judgeVillage(freeLook({ looked: { chunks: 20, of: 30 } })), { kind: 'wait', why: 'not all of it seen yet (20 of 30 chunks)' });
  t.like(judgeVillage({ ...freeLook(), bells: [], beds: [], jobs: [], seen: [] }), { kind: 'none' });
  // the rules that make it someone's come before the wait: two named villagers in a village of four is someone's still;
  // one alone is no setup, and the village waits
  const named = four.map((e, i) => (i > 1 ? e : { ...e, named: true }));
  t.is(judgeVillage(freeLook({ seen: named })).kind, 'theirs');
  t.is(judgeVillage(freeLook({ seen: four.map((e, i) => (i ? e : { ...e, named: true })) })).kind, 'wait');
  // no unemployed adult: free, with none to take, and why
  const busy = VILLAGERS().map(e => (e.profession === 'none' && !e.baby ? { ...e, profession: 'mason' } : e));
  t.like(judgeVillage(freeLook({ seen: busy })), { kind: 'free', candidates: [], why: '7 villagers, 0 unemployed adult(s) to take (5 employed, 1 babies, 1 nitwits)' });
});

test('penned in: a villager in a trading hall\'s cell or a small fenced pen is; one in the open, or in a house with a door, is not', (t) => {
  const grid = (cells: Record<string, string>) => (x: number, y: number, z: number) => cells[`${x},${y},${z}`] ?? (y <= 62 ? 'grass_block' : 'air');
  const feet = { x: 0, y: 63, z: 0 };
  t.false(pennedIn(grid({}), feet));
  // a 1 x 1 cell walled round, two high
  const cell: Record<string, string> = {};
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [63, 64]) cell[`${dx},${y},${dz}`] = 'glass';
  t.true(pennedIn(grid(cell), feet));
  // a 3 x 3 fenced pen (a fence is 1.5 high: no one steps onto it)
  const pen: Record<string, string> = {};
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (Math.abs(x) === 2 || Math.abs(z) === 2) pen[`${x},63,${z}`] = 'oak_fence';
  t.true(pennedIn(grid(pen), feet));
  // a closed fence gate in it keeps it a pen (villagers open no gate); a door in a house's wall does not
  pen['2,63,0'] = 'oak_fence_gate[facing=east,open=false]';
  t.true(pennedIn(grid(pen), feet));
  const house: Record<string, string> = {};
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (Math.abs(x) === 2 || Math.abs(z) === 2) { house[`${x},63,${z}`] = 'oak_planks'; house[`${x},64,${z}`] = 'oak_planks'; }
  house['2,63,0'] = 'oak_door[half=lower,open=false]';
  house['2,64,0'] = 'oak_door[half=upper,open=false]';
  t.false(pennedIn(grid(house), feet));
});

// ------------------------------------------------------------------------------------------------ the way home

/** A flat world for the route: grass at 62, with these blocks set (`x,y,z` -> state), read whole. */
function flat(cells: Record<string, string> = {}, box = { x1: -20, z1: -20, x2: 60, z2: 20 }): Ground {
  const g = new Ground(58, 12);
  for (let x = box.x1; x <= box.x2; x++) for (let z = box.z1; z <= box.z2; z++) for (let y = 58; y < 70; y++) g.set(x, y, z, cells[`${x},${y},${z}`] ?? (y <= 62 ? 'grass_block' : 'air'));
  return g;
}

test('the boat climbs nothing: a slab, a carpet, the 1/16 from a path onto grass, the bank out of water at its own level; a step down of 2 is fine, of 3 not, into water any', (t) => {
  const col = (cells: Record<number, string>) => (y: number) => cellOf(cells[y] ?? (y <= 62 ? 'grass_block' : 'air'));
  t.deepEqual(settle(col({}), 63), { level: 63, water: false });
  t.like(settle(col({ 63: 'oak_slab[type=bottom,waterlogged=false]' }), 63), { blocked: 'a step up (a boat climbs nothing)', y: 63 });
  t.like(settle(col({ 63: 'white_carpet' }), 63), { blocked: 'a step up (a boat climbs nothing)' });
  // on a path block (15/16), the grass beside it is a 1/16 step up
  t.like(settle(col({}), 62 + 15 / 16), { blocked: 'a step up (a boat climbs nothing)', y: 62 });
  t.like(settle(col({ 62: 'dirt_path' }), 63), { level: 62 + 15 / 16, water: false });
  // out of water: the bank at the water's own level is a step up; one a block lower is a step down
  const surface = 62 + 8 / 9;
  t.like(settle(col({ 62: 'water[level=0]' }), 63), { level: surface, water: true });
  t.like(settle(col({}), surface), { blocked: 'a step up (a boat climbs nothing)' });
  t.like(settle(col({ 62: 'air', 61: 'grass_block' }), surface), { level: 62, water: false });
  // down: 2 fine, 3 not, water at any depth
  t.like(settle(col({ 62: 'air', 61: 'air' }), 63), { level: 61 });
  t.like(settle(col({ 62: 'air', 61: 'air', 60: 'air' }), 63), { blocked: 'a drop of more than 2' });
  t.like(settle(col({ 62: 'air', 61: 'air', 60: 'water[level=0]' }), 63), { level: 60 + 8 / 9, water: true });
  // what hurts or breaks: lava under a step, a lily pad, a flow, a wall, a block too low over the passengers' heads
  t.like(settle(col({ 62: 'air', 61: 'lava[level=0]' }), 63), { blocked: 'lava' });
  t.like(settle(col({ 63: 'lily_pad', 62: 'water[level=0]' }), surface), { blocked: 'a lily pad (a boat breaks it)' });
  t.like(settle(col({ 62: 'water[level=3]' }), 63), { blocked: 'flowing water' });
  t.like(settle(col({ 63: 'stone', 64: 'stone' }), 63), { blocked: 'a wall' });
  t.like(settle(col({ 64: 'oak_slab[type=top,waterlogged=false]' }), 63), { blocked: 'a block too low over the boat' });
  // grass, flowers, a torch, a rail: the boat goes over them
  for (const plant of ['short_grass', 'poppy', 'torch', 'rail[shape=north_south]', 'wheat[age=7]']) t.deepEqual(settle(col({ 63: plant }), 63), { level: 63, water: false }, plant);
});

test('the way is judged 3 wide (the boat\'s 1.375 and the drive\'s few tenths off its line either side): a 1-wide and a 2-wide gap refused, 3 wide let by', (t) => {
  const walls = (gap: number) => {
    const cells: Record<string, string> = {};
    for (let z = -10; z <= 10; z++) for (const y of [63, 64]) if (z < 0 || z >= gap) cells[`10,${y},${z}`] = 'stone';
    return flat(cells);
  };
  const across = (gap: number) => checkLeg(walls(gap), { x: 0, z: gap / 2, level: 63 }, { x: 20, z: gap / 2 });
  t.like(across(1), { ok: false, why: 'a wall' });
  t.like(across(2), { ok: false, why: 'a wall' });
  t.like(across(3), { ok: true, level: 63 });
  // and over the fence line itself (a fence is 1.5 high): no way across
  t.like(checkLeg(flat({ '10,63,0': 'birch_fence', '10,63,1': 'birch_fence', '10,63,-1': 'birch_fence' }), { x: 0, z: 0.5, level: 63 }, { x: 20, z: 0.5 }), { ok: false, why: 'a wall' });
});

test('the way keeps 16 from every build of others (3D box distance): 15 off refused, 17 off let by; the village\'s own left out by the caller', (t) => {
  const zone = (off: number): Zone => ({ x1: 10, y1: 60, z1: off + 1, x2: 14, y2: 68, z2: off + 5, surface: true });
  // the boat's line along z 0.5: the zone's nearest side `off` blocks from it (its box from z off+1)
  t.like(checkLeg(flat(), { x: 0, z: 0.5, level: 63 }, { x: 30, z: 0.5 }, [zone(15)]), { ok: false, why: 'within 16 of someone\'s build (x 10..14, z 16..20)' });
  t.like(checkLeg(flat(), { x: 0, z: 0.5, level: 63 }, { x: 30, z: 0.5 }, [zone(17)]), { ok: true });
  t.like(checkLeg(flat(), { x: 0, z: 0.5, level: 63 }, { x: 30, z: 0.5 }, []), { ok: true });
  // (a mineshaft 40 under the way is far off: the distance is in 3D)
  t.like(checkLeg(flat(), { x: 0, z: 0.5, level: 63 }, { x: 30, z: 0.5 }, [{ x1: 10, y1: 10, z1: -5, x2: 14, y2: 20, z2: 5, surface: false }]), { ok: true });
});

test('a house in the way: the straight line refused, a way round found in straight legs, each judged whole; a wall across everything: none, and why', (t) => {
  const house: Record<string, string> = {};
  for (let x = 20; x <= 26; x++) for (let z = -6; z <= 6; z++) for (let y = 63; y <= 66; y++) house[`${x},${y},${z}`] = 'oak_planks';
  const g = flat(house);
  const from = { x: 0.5, z: 0.5, level: 63 }, to = { x: 50.5, z: 0.5 };
  t.false(checkLeg(g, from, to).ok);
  const r = planRoute(g, from, to, { bounds: { x1: -20, z1: -20, x2: 60, z2: 20 } });
  t.true(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  t.true(r.legs.length >= 2 && r.legs.length <= 4, JSON.stringify(r.legs));
  t.deepEqual(r.legs[r.legs.length - 1], to);
  let at = { ...from };
  for (const leg of r.legs) {
    const c = checkLeg(g, at, leg);
    t.true(c.ok, `${JSON.stringify(at)} -> ${JSON.stringify(leg)}: ${JSON.stringify(c)}`);
    at = { x: leg.x, z: leg.z, level: c.ok ? c.level : 63 };
  }
  // a bank a block high across the whole way (a wall wherever it is met)
  const hill: Record<string, string> = {};
  for (let z = -20; z <= 20; z++) for (let x = 30; x <= 32; x++) hill[`${x},63,${z}`] = 'stone';
  const none = planRoute(flat(hill), from, to, { bounds: { x1: -20, z1: -20, x2: 60, z2: 20 } });
  t.false(none.ok);
  if (!none.ok) t.regex(none.why, /^no way round: straight on, a wall at \(30, 63, -1\); it got no nearer than 2\d$/);
  // unread ground is no way: said as such
  const half = new Ground(58, 12);
  for (let x = -5; x <= 10; x++) for (let z = -5; z <= 5; z++) for (let y = 58; y < 70; y++) half.set(x, y, z, y <= 62 ? 'grass_block' : 'air');
  t.like(checkLeg(half, from, to), { ok: false, why: 'not read', unread: true });
});

test('downhill is fine, and the level carried down leg to leg: from a village on a terrace 2 up, down the step, on to the yard', (t) => {
  const terrace: Record<string, string> = {};
  for (let x = -20; x <= 10; x++) for (let z = -20; z <= 20; z++) { terrace[`${x},63,${z}`] = 'grass_block'; terrace[`${x},64,${z}`] = 'grass_block'; }
  const g = flat(terrace);
  t.like(checkLeg(g, { x: 0.5, z: 0.5, level: 65 }, { x: 40.5, z: 0.5 }), { ok: true, level: 63 });
  // and back up it: refused
  t.like(checkLeg(g, { x: 40.5, z: 0.5, level: 63 }, { x: 0.5, z: 0.5 }), { ok: false, why: 'a wall' });
  t.like(footprint(g, 40.5, 0.5, 65, false), { ok: true, level: 63 });
});

// ------------------------------------------------------------------------------------------------ the way into the hall

test('the way into the live hall: the panel and a column either side of it (3 wide, 2 high), the fence\'s three posts straight out from it, the stops outside the fence, before the wall and in the room', (t) => {
  const e = entryOf(hallWorld()) as Entry;
  t.is(e.side, 'north');
  t.deepEqual(e.wall, [
    { x: -557, y: 63, z: 2126 }, { x: -556, y: 63, z: 2126 }, { x: -555, y: 63, z: 2126 },
    { x: -557, y: 64, z: 2126 }, { x: -556, y: 64, z: 2126 }, { x: -555, y: 64, z: 2126 }
  ]);
  t.deepEqual(e.fence, [{ x: -557, y: 63, z: 2119 }, { x: -556, y: 63, z: 2119 }, { x: -555, y: 63, z: 2119 }]);
  t.deepEqual(e.out, { x: -555.5, z: 2116.5 });
  t.deepEqual(e.front, { x: -555.5, z: 2124 });
  t.deepEqual(e.inside, { x: -555.5, z: 2130.5 });
  t.deepEqual(e.gate, HALL_GATE);
  t.is(e.level, 63);
  // no hall, no panel, a gate in the fence where the posts would come out: no way in straight out, and why (the gate's:
  // the fence's side, which leaves the way in across the yard)
  t.deepEqual(entryOf(hallWorld({ zones: {} })), { why: 'no villager hall built' });
  const w = hallWorld();
  w.zones!['fence:gate'] = [{ x: -556, y: 63, z: 2119 }];
  t.deepEqual(entryOf(w), { why: 'the fence straight out from the panel holds a corner or a gate', fence: true });
});

// ------------------------------------------------------------------------------------------------ the rung's gates

test('the switch off: the rung offers nothing and says so, at any hour, with or without the hall; decide picks nothing of it on the live homestead', (t) => {
  for (const tod of [0, 1000, 5000, 10_000, 13_000]) {
    const w = hallWorld({ villagerMoves: undefined });
    const s = snap(KIT(), { timeOfDay: tod });
    t.deepEqual(villagersTask.variants(s, w), []);
    t.like(pick(villagersTask, s, w), tod < 11_000 ? { decline: { cause: 'unneeded', text: 'villager moves are off' } } : { decline: { cause: 'late' } });
  }
  t.deepEqual(villagersTask.variants(snap(KIT()), hallWorld({ villagerMoves: false })), []);
  // the live homestead: nothing of it is ever picked, and the rung says why
  const goals = realGoals();
  const g = goals.find(x => x.name === 'work: villagers')!;
  t.truthy(g);
  for (const tod of [0, 1000, 3000, 6000, 9000]) for (const items of [KEPT.map(([name, count], slot) => ({ slot, name, count })), WORN.map(i => ({ ...i }))]) {
    const w = liveWorld();
    const s = lookAt(items, tod);
    t.is(g.wants(s, w), null);
    t.is(g.declines!(s, w)?.text, 'villager moves are off');
    const d = decide(s, w, goals, new Map());
    t.false(!!d && (d.goal.name === 'work: villagers' || d.goal.name === 'close up'), d?.goal.name);
  }
});

test('the rung\'s gates: no hall, the hall full (as counted under half an hour ago), rain, a move\'s openings not put back; else the villages known first, then the four sides and the four bearings between them to the range (640 since Nov 17)', (t) => {
  const s = snap(KIT());
  t.like(pick(villagersTask, s, hallWorld({ zones: {} })), { decline: { cause: 'unneeded', text: 'no villager hall yet' } });
  const full = hallWorld();
  full.villages!.hall = { count: HALL_WANTS, at: T0 - 10 * MINUTE };
  t.like(pick(villagersTask, s, full), { decline: { cause: 'stocked', text: 'the hall has 3 villagers (3 wanted)' } });
  full.villages!.hall = { count: HALL_WANTS, at: T0 - 40 * MINUTE };
  // (a fresh look: pick keeps its answer for the snapshot it was asked with)
  t.like(pick(villagersTask, snap(KIT()), full), { variant: 'village -556,1880', first: true }, 'an old count is looked at again');
  t.like(pick(villagersTask, snap(KIT(), { raining: true }), hallWorld()), { decline: { cause: 'late', text: 'raining: no villager is moved in the rain' } });
  const open = hallWorld();
  open.villages!.open = [{ at: { x: -556, y: 63, z: 2126 }, block: 'oak_planks' }];
  t.like(pick(villagersTask, s, open), { decline: { text: '1 block(s) of the hall or the fence left open by a move: close up first' } });
  // the village known first (its distance the day it needs), then the sides out to the range
  t.deepEqual(villagersTask.variants(s, hallWorld()).map(v => `${v.id} ${v.dist}${v.first ? ' first' : ''}`),
    ['village -556,1880 303 first', ...SEARCHES.map(b => `${b} ${VILLAGE_RANGE}`)]);
  // someone's: never again; its boat way failed today: not until tomorrow; too small: in 6 hours; beyond the range: not at all
  const w = hallWorld();
  const site = w.villages!.sites[0];
  site.judged = { at: T0 - MINUTE, kind: 'theirs', why: 'within 256 of the world spawn (200 off)', rule: 'spawn', v: JUDGE_V };
  t.deepEqual(villagersTask.variants(s, w).map(v => v.id), SEARCHES);
  // (an older word for a player seen by it no longer decides since Nov 20: offered for a look)
  site.judged = { at: T0 - MINUTE, kind: 'theirs', why: 'a player was seen 20 from it' };
  t.deepEqual(villagersTask.variants(s, w).map(v => v.id)[0], 'village -556,1880');
  site.judged = undefined;
  site.noBoat = { at: T0 - 60 * MINUTE, why: 'a hill' };
  t.deepEqual(villagersTask.variants(s, w).map(v => v.id)[0], 'north');
  site.noBoat.at = T0 - 25 * 60 * MINUTE;
  t.deepEqual(villagersTask.variants(s, w).map(v => v.id)[0], 'village -556,1880');
  w.villages!.sites.push({ x: -549, y: 63, z: 2183 - VILLAGE_RANGE - 10, seenAt: T0 });
  t.false(villagersTask.variants(s, w).some(v => v.id === `village -549,${2183 - VILLAGE_RANGE - 10}`));
  // the day a move needs: there at 3 a second, the look round the village (a minute), back at the boat's 2 on land with
  // a third more for its turns, and the yard's minute (418 s from 303 out); a search's first stretch needs 145 s (out
  // 128 and back at a walk, and a minute)
  t.like(pick(villagersTask, snap(KIT(), { timeOfDay: 2500 }), hallWorld()), { variant: 'village -556,1880' });
  t.like(pick(villagersTask, snap(KIT(), { timeOfDay: 3000 }), hallWorld()), { variant: 'north' }, 'the move late (400 s left), a search not');
  t.like(pick(villagersTask, snap(KIT(), { timeOfDay: 8500 }), hallWorld()), { decline: { cause: 'late' } });
});

test('the rung only looks: asked over hours, weathers, switches and memories, the world is left as it was', (t) => {
  for (const w of [hallWorld(), hallWorld({ villagerMoves: undefined }), hallWorld({ villages: undefined }), hallWorld({ zones: {} })]) {
    const before = JSON.stringify(w);
    for (const tod of [0, 3000, 8000, 12_000]) for (const raining of [false, true]) {
      const s = snap(KIT(), { timeOfDay: tod, raining });
      pick(villagersTask, s, w);
      villagersTask.variants(s, w);
      villagersTask.none?.(s, w);
      closeUpGoal.wants(s, w);
    }
    villagersLine(w, T0);
    t.is(JSON.stringify(w), before);
  }
});

test('the boat is five oak planks at a table, as the game has it; the rung is 4.4 on the ladder with its range of its own and the boat\'s pace home', (t) => {
  t.deepEqual(RECIPES.oak_boat, { makes: 1, from: { oak_planks: 5 } });
  t.deepEqual(recipeFor('oak_planks'), { makes: 4, from: { oak_log: 1 } });
  const r = LADDER.find(x => x.name === 'villagers')!;
  t.is(r.rank, 4.4);
  t.is(r.range!(hallWorld()), VILLAGE_RANGE);
  t.is(r.range!(hallWorld({ leash: 500 })), VILLAGE_RANGE);
  t.is(r.backPace, BOAT_PACE);
  t.is(r.budgetMs, MOVE_BUDGET);
  t.is(workGoals(() => undefined, LADDER, () => T0).find(g => g.name === 'work: villagers')!.timeoutMs, MOVE_BUDGET + 4 * MINUTE);
});

// ------------------------------------------------------------------------------------------------ the move, end to end

const POSTS: Pos[] = [{ x: -557, y: 63, z: 2119 }, { x: -556, y: 63, z: 2119 }, { x: -555, y: 63, z: 2119 }];
const TORCH: Pos = { x: -556, y: 64, z: 2119 };
const WALL: Pos[] = [-557, -556, -555].flatMap(x => [63, 64].map(y => ({ x, y, z: 2126 })));
const inHall = (p: Pos) => p.x >= HALL.x + 1 && p.x < HALL.x + HALL.width - 1 && p.z >= HALL.z + 1 && p.z < HALL.z + HALL.length - 1;
/** The yard's fence and the hall's wall stand as they were built. */
const asBuilt = (land: Land) => ({
  posts: POSTS.map(p => land.block(p.x, p.y, p.z)), torch: land.block(TORCH.x, TORCH.y, TORCH.z), wall: WALL.map(p => land.block(p.x, p.y, p.z))
});
const BUILT = { posts: [FENCE, FENCE, FENCE], torch: 'torch', wall: WALL.map(() => 'oak_planks') };

test('the move end to end: walked out reading the way home, the village judged free, an unemployed adult taken into the boat, driven home, the fence and the hall\'s panel dug from the boat and put back as they were, the boat taken up; every step said', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -556,1880] moved an unemployed villager from the village at (-556, 63, 1880) to the hall (1 in it now); back home');
  // the villager in the room, the others where they were; the boat its item again
  const v = land.villagers.find(e => e.id === 101)!;
  t.true(inHall({ x: Math.floor(v.position.x), y: 63, z: Math.floor(v.position.z) }), JSON.stringify(v.position));
  t.true(land.villagers.filter(e => e.id !== 101).every(e => e.position.z < 1900));
  t.is(land.boat, undefined);
  t.is(land.items.find(i => i.name === 'oak_boat')?.count, 1);
  t.deepEqual(asBuilt(land), BUILT);
  // what was done, in order: the boat against the villager, in, home, the fence (the torch before its post) and the
  // wall from the boat, into the room, out, the boat up, the wall back from inside (the bottom row first), out by the
  // hall's gate, the fence back (posts, then the torch on top)
  const done = land.log.filter(l => !l.startsWith('goto') || /careful/.test(l));
  t.deepEqual(done.slice(done.findIndex(l => l.startsWith('boat down'))), [
    // (beside the villager at (-556.5, 63, 1890.5), on the bot's side: the game refuses a boat whose box meets a mob's)
    'boat down at (-557, 62, 1889), villager 101 in',
    'into the boat',
    'drive to (-555.5, 2116.5)',
    'dig birch_fence (-557, 63, 2119) from the boat', 'dig torch (-556, 64, 2119) from the boat', 'dig birch_fence (-556, 63, 2119) from the boat', 'dig birch_fence (-555, 63, 2119) from the boat',
    'drive to (-555.5, 2124)',
    ...WALL.filter(p => p.y === 63).concat(WALL.filter(p => p.y === 64)).map(p => `dig oak_planks ${fmt(p)} from the boat`),
    'drive to (-555.5, 2130.5)',
    'out of the boat',
    'boat taken up at (-555.5, 2130.5)',
    'goto (-556, 63, 2128) careful',
    ...WALL.filter(p => p.y === 63).concat(WALL.filter(p => p.y === 64)).map(p => `place oak_planks ${fmt(p)}`),
    'goto (-556, 63, 2136) careful',
    'goto (-557, 63, 2119) careful',
    ...POSTS.map(p => `place birch_fence ${fmt(p)}`),
    `place torch ${fmt(TORCH)}`,
    'go-home'
  ]);
  // every walk in and by the yard careful (walk only: nothing broken or placed on the way), the way out by the north gate
  t.true(land.log.includes('goto (-549, 63, 2121) careful') && land.log.includes('goto (-549, 63, 2117) careful'), land.log.join(' | '));
  t.true(land.log.includes('goto (-557, 63, 1890) careful'), 'to the villager on foot, carefully, in the village');
  // the walk out's stops within 96 of the village careful too (it is not judged yet), as is the first from by the yard
  const stops = land.log.filter(l => /^goto \(-55\d, 63, (1[89]|20)\d\d\)/.test(l) && !l.startsWith('goto (-557, 63, 1890)'));
  t.true(stops.filter(l => Number(/, (\d+)\)/.exec(l)![1]) <= 1880 + 96).length >= 2, stops.join(' | '));
  for (const l of stops) if (Number(/, (\d+)\)/.exec(l)![1]) <= 1880 + 96) t.regex(l, /careful$/);
  // the memory: the hall counted, the site judged free with one moved from it, nothing left open, no boat out
  const mem = peekVillages(world);
  // (counted in the yard, before the walk home)
  t.is(mem.hall?.count, 1);
  t.true(mem.hall!.at > T0 && mem.hall!.at < land.t);
  t.like(mem.sites[0], { x: -556, z: 1880, moved: 1, villagers: 7, bells: 1, beds: 3, jobs: 2, judged: { kind: 'free' } });
  t.is(mem.open, undefined);
  t.is(mem.boat, undefined);
  t.like(mem.last, { moved: true, text: 'moved an unemployed villager from the village at (-556, 63, 1880) to the hall (1 in it now)' });
  // every step said, `villagers: ...`
  t.deepEqual(land.said.filter(l => l.startsWith('villagers: ')), [
    'villagers: to the village at (-556, 63, 1880), 303 from home, reading the boat\'s way back as it goes',
    'villagers: the village at (-556, 63, 1880) is free to take from: 7 villagers, 2 unemployed adult(s) to take (2 employed, 1 babies, 1 nitwits, 1 by a job site)',
    'villagers: the boat down against an unemployed villager (101) at (-557, 63, 1890)',
    'villagers: in the boat with the villager (101): home in 1 leg(s)',
    'villagers: to the yard\'s fence at (-556, 2116): there in 114 s',
    'villagers: the fence open at (-557, 63, 2119), (-556, 63, 2119), (-555, 63, 2119)',
    'villagers: through the fence to the hall at (-556, 2124): there in 4 s',
    'villagers: the hall\'s panel open at (-557, 63, 2126) (6 blocks)',
    'villagers: into the hall: there in 3 s',
    'villagers: the villager (101) let out in the hall; the panel back',
    'villagers: moved an unemployed villager from the village at (-556, 63, 1880) to the hall (1 in it now)'
  ]);
  // the way home was read before the villager was taken, as the bot walked out: no region read at all after the place
  t.true(land.reads > 10, `${land.reads} reads`);
});

test('the give-up path: the drive stops on the way home (a block the look missed): out of the boat, the boat taken up and the villager left where it stands, nothing opened, home without it', async (t) => {
  const world = hallWorld();
  const land = new Land(world, { stopAt: { leg: 1, reason: 'stuck' } });
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -556,1880] gave up: the drive to the yard\'s fence at (-556, 2116) stopped: stuck at (-556, 63, 2002); the villager let out at (-556, 63, 2002), the boat taken back up; back home');
  t.is(land.boat, undefined);
  t.is(land.items.find(i => i.name === 'oak_boat')?.count, 1);
  const v = land.villagers.find(e => e.id === 101)!;
  t.false(inHall({ x: Math.floor(v.position.x), y: 63, z: Math.floor(v.position.z) }));
  t.deepEqual(asBuilt(land), BUILT);
  const mem = peekVillages(world);
  t.is(mem.open, undefined);
  t.is(mem.boat, undefined);
  t.like(mem.last, { moved: false });
  t.false(land.log.some(l => l.startsWith('dig ')));
  // under way home, the villager let out away from its village: the moves wait for the lead
  t.false(world.villagerMoves);
  t.true(land.said.includes('villagers: villager moves off (by the move: the drive to the yard\'s fence at (-556, 2116) stopped: stuck at (-556, 63, 2002))'), land.said.join(' | '));
  t.regex(villagersLine(world, land.t), /^Villagers: moves off; /);
});

test('the give-up path in the yard: the drive through the fence stops, the boat taken up there, the fence and its torch put back as they were', async (t) => {
  const world = hallWorld();
  const land = new Land(world, { stopAt: { leg: 2, reason: 'stuck' } });
  const text = await rung(land).run(land.ctx());
  t.regex(text, /^\[village -556,1880\] gave up: the drive through the fence to the hall at \(-556, 2124\) stopped: stuck at \(-556, 63, 2120\); the villager let out at \(-556, 63, 2120\), the boat taken back up; put back 4 block\(s\); back home$/);
  t.deepEqual(asBuilt(land), BUILT);
  t.is(peekVillages(world).open, undefined);
  t.is(land.boat, undefined);
  t.false(land.log.some(l => l.startsWith('dig oak_planks')), 'the hall\'s wall never opened');
});

test('the boat stops off the fence opening\'s middle (as the drive may): the way through it judged again from there and refused before anything is dug; the villager left outside, the boat taken up', async (t) => {
  const world = hallWorld();
  const land = new Land(world, { offBy: { leg: 1, dx: 1 } });
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -556,1880] gave up: the boat stopped where its way through the fence does not hold, at (-555, 63, 2116): a wall at (-554, 63, 2119); ' +
    'the villager let out at (-555, 63, 2116), the boat taken back up; back home');
  t.false(land.log.some(l => l.startsWith('dig ')));
  t.deepEqual(asBuilt(land), BUILT);
  t.is(land.boat, undefined);
});

test('rain begun since the run set out: no villager is taken, nothing touched', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  const status = land.status.bind(land);
  land.status = () => ({ ...status(), raining: horiz(land.me, BELL) < 40 }) as ReturnType<Land['status']>;
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -556,1880] gave up: it began to rain: no villager is taken in the rain; back home');
  t.false(land.log.some(l => l.startsWith('boat down') || l.startsWith('dig ')));
  t.true(world.villagerMoves, 'given up before the drive: the switch as it was');
});

test('a player comes by as the bot is about to take a villager (within 32 of it): nothing taken this run, the village still free (Nov 20); one farther off is no matter', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  const call = land.call.bind(land);
  land.call = (m, p = {}) => {
    // (once the bot has walked over to the villager, after the judge's look)
    if (m === 'world.entities' && land.log.includes('goto (-557, 63, 1890) careful')) land.players = [{ id: 77, name: 'player', position: { x: -530, y: 63, z: 1900 } }];
    return call(m, p);
  };
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -556,1880] gave up: a player at (-530, 63, 1900), 27 from the bot: no villager taken this run; back home');
  t.false(land.log.some(l => l.startsWith('boat down')));
  t.like(peekVillages(world).sites[0].judged, { kind: 'free' });
  t.like(peekVillages(world).players, [{ x: -530, y: 63, z: 1900 }]);
  t.is(villagersTask.variants(snap(KIT(), { now: land.t }), world)[0].id, 'village -556,1880', 'offered again');
  // 57 off the village's area (x2 -517) and some 100 from the bot: the move goes on
  const w2 = hallWorld();
  const l2 = new Land(w2);
  const call2 = l2.call.bind(l2);
  l2.call = (m, p = {}) => {
    if (m === 'world.entities' && l2.log.includes('goto (-557, 63, 1890) careful')) l2.players = [{ id: 77, name: 'player', position: { x: -460, y: 63, z: 1880 } }];
    return call2(m, p);
  };
  t.regex(await rung(l2).run(l2.ctx()), /^\[village -556,1880\] moved an unemployed villager from the village at \(-556, 63, 1880\) to the hall/);
});

test('the budget runs out on the walk out: the move gives up before anything is touched, home', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  // (a walk five times as slow: a hill road, Baritone round water)
  const walk = (land as unknown as { walk: (to: { x: number; z: number }, y?: number) => void }).walk.bind(land);
  (land as unknown as { walk: (to: { x: number; z: number }, y?: number) => void }).walk = (to, y) => { const t0 = land.t; walk(to, y); land.t = t0 + (land.t - t0) * 12; };
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -556,1880] the run\'s time ran out on the way out to the village at (-556, 63, 1880); back home');
  t.false(land.log.some(l => l.startsWith('boat down') || l.startsWith('dig ')));
  t.deepEqual(asBuilt(land), BUILT);
});

test('a village judged someone\'s at the look (two of its villagers named: a setup in use): left alone, nothing touched, and never gone to again', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  land.villagers[1].named = true;
  land.villagers[2].named = true;
  const text = await rung(land).run(land.ctx());
  t.regex(text, /^\[village -556,1880\] left the village at \(-556, 63, 1880\) alone: 2 villagers used by a player: .*; back home$/);
  t.false(land.log.some(l => l.startsWith('boat down')));
  t.like(peekVillages(world).sites[0].judged, { kind: 'theirs', rule: 'villager', v: JUDGE_V });
  t.deepEqual(villagersTask.variants(snap(KIT()), world).map(v => v.id), SEARCHES);
});

test('since Nov 20 a sign by a village is noted and the move goes on; a player in the village at the look is noted, and the move waits for a run with none within 32', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  land.marks.push({ name: 'oak_sign', at: { x: -560, y: 64, z: 1900 } });
  t.regex(await rung(land).run(land.ctx()), /^\[village -556,1880\] moved an unemployed villager from the village at \(-556, 63, 1880\) to the hall/);
  t.true(land.said.some(l => /free to take from: .*noted: a player's marks within 16: oak_sign x1/.test(l)), land.said.filter(l => /free to take/.test(l)).join(' | '));
  const w2 = hallWorld();
  const l2 = new Land(w2);
  l2.players.push({ id: 77, name: 'player', position: { x: -520, y: 63, z: 1880 } });
  t.is(await rung(l2).run(l2.ctx()), '[village -556,1880] no villager taken at (-556, 63, 1880) this run: a player at (-520, 63, 1880), 0 from the village; back home');
  t.false(l2.log.some(l => l.startsWith('boat down')));
  t.like(peekVillages(w2).sites[0].judged, { kind: 'free' });
  t.regex(peekVillages(w2).sites[0].judged!.why, /noted: a player was seen 0 from it/);
  t.is(villagersTask.variants(snap(KIT(), { now: l2.t }), w2)[0].id, 'village -556,1880');
});

test('the search: no village known, the north side walked out by the north gate, a bell in sight, walked over and judged; the move is the next run\'s', async (t) => {
  const world = hallWorld({ villages: { sites: [], players: [] } });
  const land = new Land(world);
  t.deepEqual(villagersTask.variants(snap(KIT()), world).map(v => v.id), SEARCHES);
  const text = await rung(land).run(land.ctx());
  t.is(text, '[north] found a village at (-556, 63, 1880): free (7 villagers, 2 unemployed adult(s) to take (2 employed, 1 babies, 1 nitwits, 1 by a job site)): the move next run; back home');
  t.like(peekVillages(world).sites[0], { x: -556, y: 63, z: 1880, judged: { kind: 'free' } });
  t.false(land.log.some(l => l.startsWith('boat down')));
  // walked over carefully: nothing broken or put down in a village not judged yet
  t.true(land.log.includes('goto (-556, 63, 1880) careful'), land.log.filter(l => l.startsWith('goto')).join(' | '));
  // the next run goes to it first
  t.deepEqual(villagersTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id)[0], 'village -556,1880');
});

test('a hall full as counted from home: none fetched, and the rung says the hall has its villagers for half an hour', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  land.villagers.push(...[1, 2, 3].map(i => ({ id: 200 + i, name: 'villager', position: { x: -558.5 + i, y: 63, z: 2130.5 }, profession: 'none', baby: false })));
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -556,1880] the hall has 3 villagers already: none moved');
  t.like(pick(villagersTask, snap(KIT(), { now: land.t + MINUTE }), world), { decline: { cause: 'stocked', text: 'the hall has 3 villagers (3 wanted)' } });
});

test('close up: what a move cut short left open (the hall\'s wall, the fence and its torch) put back as soon as the bot is in the yard, whatever the switch; and nothing else wants while it waits', async (t) => {
  const world = hallWorld({ villagerMoves: undefined });
  const land = new Land(world);
  for (const p of [...WALL, ...POSTS, TORCH]) land.blocks.set(k(p), 'air');
  world.villages!.open = [
    { at: TORCH, block: 'torch' }, ...POSTS.map(p => ({ at: p, block: FENCE })), ...WALL.map(p => ({ at: p, block: 'oak_planks' }))
  ];
  const s = snap(KIT());
  t.is(closeUpGoal.wants(s, world), '10 block(s) of the hall or the fence left open by a villager move');
  t.false(closeUpGoal.cuts!(s, world), 'it never stops a run for it');
  t.is(closeUpGoal.wants(snap(KIT(), { position: { x: -400, y: 63, z: 2183 }, distHome: 149 }), world), null, 'not from out of the yard');
  const text = await closeUpGoal.run(land.ctx());
  t.is(text, 'put back 10 block(s) a villager move left open');
  t.deepEqual(asBuilt(land), BUILT);
  t.is(peekVillages(world).open, undefined);
  t.is(closeUpGoal.wants(s, world), null);
});

test('the sightings: a player seen anywhere in the overworld is remembered (each place once, the newest time), villagers out in the world make a site; the Nether\'s are not', (t) => {
  const world = hallWorld({ villages: undefined });
  t.false(noteSeen(world, [{ id: 1, name: 'cow', position: { x: 0, y: 63, z: 0 } }], T0));
  t.is(world.villages, undefined, 'nothing written for nothing seen');
  t.true(noteSeen(world, [{ id: 9, name: 'player', position: { x: -400.4, y: 70, z: 2000.6 } }, { id: 101, name: 'villager', position: { x: -556.5, y: 63, z: 1890.5 } }], T0));
  t.deepEqual(world.villages!.players, [{ x: -400, y: 70, z: 2001, at: T0 }]);
  t.like(world.villages!.sites, [{ x: -557, y: 63, z: 1890, villagers: 1 }]);
  noteSeen(world, [{ id: 9, name: 'player', position: { x: -405, y: 70, z: 2004 } }], T0 + MINUTE);
  t.deepEqual(world.villages!.players, [{ x: -400, y: 70, z: 2001, at: T0 + MINUTE }]);
  // the hall's own villagers are no village
  noteSeen(world, [{ id: 300, name: 'villager', position: { x: -555.5, y: 63, z: 2130.5 } }], T0);
  t.is(world.villages!.sites.length, 1);
  t.false(noteSeen(world, [{ id: 9, name: 'player', position: { x: -70, y: 70, z: 260 } }], T0, 'the_nether'));
  t.is(world.villages!.players.length, 1);
});

test('the villager-moves switch on the brain: said in the log with who turned it, kept in brain.json, the Villagers line in brain-status; the runs\' looks remember the players they see', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'villagers-brain-')), 'brain.json');
  const look: Goal = { name: 'look', priority: 1, timeoutMs: 10_000, retryMs: 10_000, wants: () => 'a look', run: async ctx => { await ctx.call('world.entities', { maxDistance: 96 }); return 'looked'; } };
  const rt = {
    actions: {},
    call: async (m: string) => (m === 'inventory' ? { items: [] } : m === 'world.region' ? { blocks: [] }
      : m === 'world.entities' ? { entities: [{ id: 5, name: 'player', position: { x: -500, y: 64, z: 2000 }, distance: 50 }] } : {}),
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...HOME }, block: { ...HOME }, timeOfDay: 1000, hashedSeed: '7', dimension: 'overworld', health: 20, food: 20 }),
    home: () => ({ ...HOME, dimension: 'overworld' }), lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => T0, goals: [look], memoryFile: file });
  t.throws(() => brain.setVillagerMoves(true, 'the lead'), { message: 'not in a world yet' });
  brain.setEnabled(true);
  await brain.tick();
  for (let i = 0; i < 50 && !brain.worldMemory()?.villages; i++) await new Promise(r => setTimeout(r, 5));
  t.deepEqual(brain.worldMemory()!.villages!.players, [{ x: -500, y: 64, z: 2000, at: T0 }]);
  t.regex(brain.status(), /\nVillagers: moves off; no villager hall yet; no village known/);
  brain.setVillagerMoves(true, 'the lead');
  t.true(brain.worldMemory()!.villagerMoves === true);
  t.regex(brain.status(), /villager moves on \(by the lead\)/);
  t.regex(brain.status(), /\nVillagers: moves on; /);
  brain.setVillagerMoves(false, 'maintenance');
  t.regex(brain.status(), /villager moves off \(by maintenance\)/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, WorldMemory>;
  t.false(Object.values(saved)[0].villagerMoves);
  brain.setEnabled(false);
});

test('with the switch on, the bells the bridge\'s scans saw on any walk (within the range of home, 640, not by the yard) become village sites, asked every 10 minutes (in four quarters: the bridge reads 1024 across at most); off, nothing is asked', async (t) => {
  let now = T0;
  const asked: Record<string, unknown>[] = [];
  const rt = {
    actions: {},
    call: async (m: string, p: Record<string, unknown> = {}) => {
      if (m === 'inventory') return { items: [] };
      if (m === 'world.region') return { blocks: [] };
      if (m === 'foreign.marks') {
        asked.push(p);
        return { kinds: { bell: 3 }, at: [{ ...BELL, name: 'bell' }, { x: -550, y: 63, z: 2140, name: 'bell' }, { x: -549, y: 70, z: 2183 - 500, name: 'bell' }], chunks: 1, of: 1 };
      }
      return {};
    },
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...HOME }, block: { ...HOME }, timeOfDay: 1000, hashedSeed: '8', dimension: 'overworld', health: 20, food: 20 }),
    home: () => ({ ...HOME, dimension: 'overworld' }), lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => now, goals: [] });
  brain.setEnabled(true);
  await brain.tick();
  t.deepEqual(asked, [], 'the switch off: nothing asked');
  const world = brain.worldMemory()!;
  world.yard = { ...YARD };
  brain.setVillagerMoves(true, 'the lead');
  now += 11 * MINUTE;
  await brain.tick();
  t.is(asked.length, 4);
  t.like(asked[0], { x1: HOME.x - 640, x2: HOME.x, z1: HOME.z - 640, z2: HOME.z, match: '^bell$' });
  t.like(asked[3], { x1: HOME.x + 1, x2: HOME.x + 640, z1: HOME.z + 1, z2: HOME.z + 640, match: '^bell$' });
  for (const a of asked) t.true((Number(a.x2) - Number(a.x1) + 1) * (Number(a.z2) - Number(a.z1) + 1) <= 1024 * 1024, 'a box the bridge reads');
  // the village 303 out and the one 500 out (within 640 now); not the bell by the yard's north fence
  t.deepEqual(world.villages!.sites.map(q => `${q.x},${q.y},${q.z} ${q.bells}`), ['-556,63,1880 1', '-549,70,1683 1']);
  t.regex(brain.status(), /villagers: 2 village\(s\) seen on the walks \(their bells\), within 640 of home/);
  now += 5 * MINUTE;
  await brain.tick();
  t.is(asked.length, 4, 'not again within 10 minutes');
  brain.setEnabled(false);
});

test('brain-status\'s Villagers line: the switch, the hall and its count, the villages known and how judged (someone\'s, and why), what a move left, the last move', (t) => {
  t.is(villagersLine(hallWorld({ villagerMoves: undefined, villages: undefined }), T0), 'Villagers: moves off; the hall at (-561, 62, 2126): not counted yet (3 wanted); no village known');
  const w = hallWorld();
  w.villages!.hall = { count: 1, at: T0 - 12 * MINUTE };
  w.villages!.sites.push({ x: -300, y: 70, z: 2300, seenAt: T0, judged: { at: T0, kind: 'theirs', why: 'a player was seen 20 from it' } });
  w.villages!.sites.push({ x: -700, y: 64, z: 2400, seenAt: T0, noBoat: { at: T0, why: 'a hill' } });
  w.villages!.last = { at: T0 - 30 * MINUTE, text: 'moved an unemployed villager from the village at (-556, 63, 1880) to the hall (1 in it now)', moved: true };
  w.villages!.open = [{ at: TORCH, block: 'torch' }];
  t.is(villagersLine(w, T0), 'Villagers: moves on; the hall at (-561, 62, 2126): 1 of 3 villagers (counted 12 min ago); 3 village(s) known (1 not judged, 1 theirs, 1 no boat way); ' +
    'someone\'s: (-300, 2300): a player was seen 20 from it (to be judged again: an older word); 1 block(s) of the hall or the fence still open; last move 13:30: moved an unemployed villager from the village at (-556, 63, 1880) to the hall (1 in it now)');
});

// ------------------------------------------------------------------------------------------------ the rails fallback (a dry run)

/**
 * A ridge right across the way home from z 2000: up 14 a block a block, flat for 3, down 14 (a boat climbs none of it;
 * its top, y 77, is over what the boat's own read of the ground reached, y 75: the read reaches over for the rails).
 */
const HIGH = [...Array.from({ length: 14 }, (_, i) => i + 1), 14, 14, ...Array.from({ length: 14 }, (_, i) => 14 - i)];
function ridge(land: Land, up: number[] = HIGH, z0 = 2000): void {
  up.forEach((h, i) => { for (let x = -660; x <= -450; x++) for (let y = 63; y < 63 + h; y++) land.blocks.set(`${x},${y},${z0 + i}`, y === 62 + h ? 'grass_block[snowy=false]' : 'dirt'); });
}
/** What a move does in the world: a boat put down, got into, a block dug or placed. */
const acted = (land: Land) => land.log.filter(l => /^(boat down|into the boat|dig |place |drive |boat taken|out of the boat)/.test(l));

test('no boat way home (a ridge across the way): the rails are planned on the ground the walk out read, a dry run with the switch on: said and kept, nothing laid, nothing touched', async (t) => {
  const world = hallWorld();
  t.true(world.villagerMoves, 'the switch is on');
  const land = new Land(world);
  ridge(land);
  const before = JSON.stringify(land.items);
  const text = await rung(land).run(land.ctx());
  t.regex(text, /^\[village -556,1880\] no boat way home from the village at \(-556, 63, 1880\): no way round: straight on, a wall at \(-55\d, 63, 2000\); it got no nearer than \d+; rails home planned \(a dry run, nothing laid\): \d+ rails, \d+ iron, \d+ gold, about \d+ min; back home$/);
  // nothing done in the world: no boat, no dig, no rail, nothing taken from the pockets
  t.deepEqual(acted(land), []);
  t.is(JSON.stringify(land.items), before);
  // the plan: from by a villager the judge allows, over the ridge (up 14 lit, down 14), into the yard by the panel's column
  const plan = lastRailPlan(world)!;
  t.truthy(plan);
  t.true([101, 107].includes(plan.villager));
  t.is(plan.climb, 14);
  t.is(plan.drop, 14);
  t.is(plan.cells.filter(c => c.role === 'climb').length, 14);
  t.is(Math.max(...plan.cells.map(c => c.y)), 77);
  t.deepEqual(plan.cells.slice(-plan.yard).map(c => `${c.x},${c.y},${c.z} ${c.kind}`), [2119, 2120, 2121, 2122, 2123, 2124].map(z => `-556,63,${z} ${z >= 2123 ? 'brake' : 'rail'}`));
  t.deepEqual(plan.opens, [{ at: { x: -556, y: 63, z: 2119 }, block: FENCE }, { at: { x: -556, y: 64, z: 2119 }, block: 'torch' }]);
  // never through the village's houses, never into the yard but by its last stretch
  t.false(plan.cells.some(c => land.block(c.x, c.y, c.z) !== 'air' && !/fence|torch/.test(land.block(c.x, c.y, c.z))));
  t.false(plan.cells.some(c => c.z >= YARD.z1 && c.z <= YARD.z2 && c.x >= YARD.x1 && c.x <= YARD.x2 && c.x !== -556));
  // the memory: no boat way (tried again in 24 h), the rails' plan in short; the status line says it
  const site = peekVillages(world).sites[0];
  t.like(site, { noBoat: { at: site.noBoat!.at }, rails: { ok: true } });
  t.regex(site.rails!.text, /^\d+ rails \(up 14, down 14\), \d+ iron, \d+ gold, about \d+ min$/);
  t.regex(villagersLine(world, land.t), /; 1 village\(s\) known \(1 no boat way\); rails from \(-556, 1880\) planned \(a dry run, nothing laid\): \d+ rails \(up 14, down 14\)/);
  // every step said: the boat's failure, the plan, the route
  const said = land.said.filter(l => l.startsWith('villagers: '));
  t.true(said.some(l => /^villagers: no boat way home from the village at \(-556, 63, 1880\): no way round/.test(l)));
  // one search, seconds long, for the ridge: the second villager's would meet the same ridge
  t.is(said.filter(l => l.startsWith('villagers: no boat way home from by the villager (')).length, 1, said.join(' | '));
  t.true(said.some(l => /^villagers: rails home planned \(a dry run, nothing laid\): \d+ rails from the pickup by the villager \(10[17]\) at \(-5\d\d, 63, 18\d\d\) to the brake in the yard: /.test(l)), said.join(' | '));
  t.true(said.some(l => /^villagers: rails: the route .*\(up 14, down 14\).*; it would open the fence at birch_fence \(-556, 63, 2119\), torch \(-556, 64, 2119\) and take every rail, torch and the stop back up after$/.test(l)), said.join(' | '));
  // in full for the villager-moves tool: every block, the order back up
  t.regex(railsText(plan), /\nTaken back up walking home after the cart: the trigger torch/);
  // the village is not offered again today (the boat's way failed), nor anything laid on the next look
  t.deepEqual(villagersTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), SEARCHES);
});

test('no boat way home with the rails switch on (P5e): the line is kept to be laid, the bill first; still nothing touched on this run, and the next move from there waits as before', async (t) => {
  const world = hallWorld({ railsHome: true });
  const land = new Land(world);
  ridge(land);
  const before = JSON.stringify(land.items);
  const text = await rung(land).run(land.ctx());
  t.regex(text, /; rails home planned and kept to be laid: \d+ rails, \d+ iron, \d+ gold; the bill next; back home$/);
  t.deepEqual(acted(land), []);
  t.is(JSON.stringify(land.items), before);
  const line = peekLine(world)!;
  t.truthy(line);
  t.like(line, { stage: 'bill', laid: [], runs: 0, yard: 6 });
  t.is(line.cells.length, lastRailPlan(world)!.cells.length);
  t.deepEqual(line.opens, [{ at: { x: -556, y: 63, z: 2119 }, block: FENCE }, { at: { x: -556, y: 64, z: 2119 }, block: 'torch' }]);
  t.like(line.site, { x: -556, z: 1880 });
  t.truthy(line.area, 'the village\'s area kept: its own builds, and where rails go down as `inVillage`');
  t.true(land.said.some(l => /^villagers: rails home planned and kept to be laid \(the rails switch is on\): /.test(l)), land.said.join(' | '));
  t.regex(railsHomeLine(world, land.t), /^Rails home: on; the line to the village at \(-556, 63, 1880\), planned \d+ min ago: planned: \d+ rails, the bill to make\.$/);
  // the rails rung's from here (the bill at home), and the villagers rung passes the village by as with no boat way
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), ['bill']);
  t.deepEqual(villagersTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), SEARCHES);
  // the moves off: nothing is kept, the dry run only
  const off = hallWorld({ railsHome: true, villagerMoves: undefined });
  t.is(peekLine(off), undefined);
});

test('no boat way home with the rails switch on and a line under way already (one at a time): said so, not as a dry run (the switch is on)', async (t) => {
  const first = hallWorld({ railsHome: true });
  const one = new Land(first);
  ridge(one);
  await rung(one).run(one.ctx());
  const kept = peekLine(first)!;
  const world = hallWorld({ railsHome: true, rails: { line: JSON.parse(JSON.stringify(kept)) as RailLine } });
  const land = new Land(world);
  ridge(land);
  const text = await rung(land).run(land.ctx());
  t.regex(text, /; rails home planned only: the line to the village at \(-556, 63, 1880\) is under way \(one at a time\); back home$/);
  t.notRegex(text, /a dry run/);
  t.false(land.said.some(l => /dry run/.test(l)), land.said.join(' | '));
  t.is(peekLine(world)!.at, kept.at, 'the line under way kept as it was');
});

test('no boat way and no rails way either (a wall of two across the way): said and kept, still nothing touched', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  ridge(land, [2, 2, 2, 2]);
  const text = await rung(land).run(land.ctx());
  t.regex(text, /; no rails way home either: no rails way to the yard's fence at \(-556, 63, 2118\); it got no nearer than \d+ \(at \(-5\d\d, 63, 1999\)\); back home$/);
  t.deepEqual(acted(land), []);
  t.like(peekVillages(world).sites[0].rails, { ok: false });
  t.regex(villagersLine(world, land.t), /; rails from \(-556, 1880\) not planned: no rails way to the yard's fence/);
});

/**
 * A wall two high right across the way home at z 1950, 50 out of the village (past its area, z 1842..1914), but for a
 * gap at x -512..-504: past the band the walk out reads (the tiles within 16 and a tile's reach of the line home,
 * x -608..-513) and within the box the searches keep to (the area's x2 -517, and BAND past it).
 */
function wallWithGap(land: Land, gap = { x1: -512, x2: -504 }): void {
  for (let x = -660; x <= -450; x++) {
    if (x >= gap.x1 && x <= gap.x2) continue;
    for (const z of [1950, 1951]) for (const y of [63, 64]) land.blocks.set(`${x},${y},${z}`, 'dirt');
  }
}

test('the way home round what blocks the line home by the village, outside its area and the band the walk out read: the ground of the whole box the searches keep to is read round the village, and the boat goes round by the gap (live Nov 19-21: the west village\'s rails shut in its area at (-683, 2204))', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  wallWithGap(land);
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -556,1880] moved an unemployed villager from the village at (-556, 63, 1880) to the hall (1 in it now); back home');
  // (round by the gap, never through the wall)
  const drives = land.log.filter(l => l.startsWith('drive to'));
  t.true(drives.some(l => { const m = /\((-?[\d.]+), (-?[\d.]+)\)/.exec(l)!; return Number(m[1]) >= -512 && Number(m[1]) <= -503; }), drives.join(' | '));
  t.false(land.log.some(l => /stuck|step up/.test(l)), land.log.join(' | '));
});

test('the rails\' dry run round what blocks the line home by the village, outside its area and the band: planned through the gap (the ground read over the whole box the searches keep to)', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  wallWithGap(land);
  // (no boat way: a ridge across the way nearer home, which the rails climb)
  ridge(land);
  const text = await rung(land).run(land.ctx());
  t.regex(text, /; rails home planned \(a dry run, nothing laid\): \d+ rails, \d+ iron, \d+ gold, about \d+ min; back home$/);
  t.deepEqual(acted(land), []);
  const plan = lastRailPlan(world)!;
  t.true(plan.cells.some(c => c.z === 1950 && c.x >= -512 && c.x <= -504), 'through the gap');
  t.false(plan.cells.some(c => land.block(c.x, c.y, c.z) !== 'air' && !/fence|torch/.test(land.block(c.x, c.y, c.z))));
});

// ------------------------------------------------------------------------------------------------ the bridge's markers

const mod = path.join(process.cwd(), 'client-mod', 'src', 'claudebridge');
const java = (f: string): string => fs.readFileSync(path.join(mod, f), 'utf8');

test('the bridge\'s foreign.marks: registered, every chunk the scans look at counted (a chunk with no marker too), forgotten with the rest on foreign.clear', (t) => {
  const src = java('Foreign.java');
  t.true(src.includes('s.register("foreign.marks"'));
  t.regex(src, /if \(ch == null\) continue;\n\s+dim\.looked\.add\(/);
  t.regex(src, /e\.getValue\(\)\.byChunk\.clear\(\);\n\s+e\.getValue\(\)\.looked\.clear\(\);/);
  const marks = src.slice(src.indexOf('s.register("foreign.marks"'), src.indexOf('s.register("foreign.at"'));
  t.regex(marks, /return obj\("dimension", which, "kinds", k, "ominous", om, "at", at, "chunks", looked, "of", of\);/);
  // the ominous banners (a pillager outpost's) told apart as each chunk is scanned, and said by kind and on each banner listed
  t.regex(src, /marks\.add\(new Mark\(at, st\.getBlock\(\), skyBeside\(level, at, side\), ominousAt\(level, at, st\)\)\);/);
  t.regex(marks, /if \(m\.ominous\(\)\) ominous\.merge\(n, 1, Integer::sum\);/);
  t.regex(marks, /if \(hits\.get\(i\)\.ominous\(\)\) o\.addProperty\("ominous", true\);/);
});

test('every block the judge reads in a village (its bell, beds and job sites; what only a player puts down) is one the bridge\'s scans record as a marker (minecraft-data 26.3)', async (t) => {
  const { default: minecraftData } = await import('minecraft-data');
  const names = Object.keys((minecraftData('26.3') as unknown as { blocksByName: Record<string, unknown> }).blocksByName);
  // Foreign.MARKER as the Java has it: the string literals of its Pattern.compile joined
  const src = java('Foreign.java');
  const lit = src.slice(src.indexOf('static final Pattern MARKER = Pattern.compile('), src.indexOf(');', src.indexOf('static final Pattern MARKER')));
  const marker = new RegExp([...lit.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\\\/g, '\\')).join(''));
  // (read whole: the world's own blocks are none, a player's planks are)
  t.true(marker.test('oak_planks') && marker.test('redstone_wire') && marker.test('bell'));
  t.false(marker.test('stone') || marker.test('grass_block') || marker.test('oak_log'));
  const { PLAYER_ONLY, VILLAGE_MARK, JOB_SITE } = await import('../../src/client/brain/village.js');
  for (const [what, re] of [['player-only', PLAYER_ONLY], ['village', VILLAGE_MARK], ['job site', JOB_SITE]] as const) {
    const hits = names.filter(n => re.test(n));
    t.true(hits.length > 3, what);
    t.deepEqual(hits.filter(n => !marker.test(n)), [], `${what} blocks the scans never record`);
  }
  // and the regex the judge sends with foreign.marks reads in Java as in JS (no flags, no JS-only syntax)
  t.notRegex(VILLAGE_MARK.source, /\(\?<|\\[pPk]/);
  t.is(VILLAGE_MARK.flags, '');
  // the lanterns, anvils, campfires, barrels and bookshelves a village has are no player's
  for (const n of ['lantern', 'anvil', 'campfire', 'barrel', 'bookshelf', 'bell', 'white_bed', 'glass_pane', 'torch', 'oak_door', 'hay_block']) t.false(PLAYER_ONLY.test(n), n);
});

// ------------------------------------------------------------------------------------------------ the review's fixes

/** The rung run as the brain runs it (inside its run, whose calls are all refused once it is stopped), with `abort` as its stop. */
const asBrain = (land: Land, abort: AbortController) => brainRun.run({ signal: abort.signal }, () => rung(land).run(land.ctx({ signal: abort.signal })));
/** What the bot did in the world from the first log line matching `from` on. */
const actedFrom = (land: Land, from: RegExp) => acted(land).slice(acted(land).findIndex(l => from.test(l)));

test('stopped from outside on the way home (survival, the run\'s timeout, the LLM): the drive ends, the bot gets out and the boat is taken up outside the run, the villager left standing; nothing more dug, and the bot not left seated', async (t) => {
  const world = hallWorld();
  const abort = new AbortController();
  const land = new Land(world, { abortAt: { leg: 1, abort } });
  await t.throwsAsync(asBrain(land, abort), { message: /aborted/ });
  t.false(land.riding, 'out of the boat');
  t.is(land.boat, undefined, 'the boat taken up');
  t.is(land.items.find(i => i.name === 'oak_boat')?.count, 1);
  t.is(peekVillages(world).boat, undefined);
  t.deepEqual(actedFrom(land, /cancelled/), ['drive to (-555.5, 2116.5): cancelled', 'out of the boat', 'boat taken up at (-556, 2003)']);
  const v = land.villagers.find(e => e.id === 101)!;
  t.true(v.position.z > 1990 && v.position.z < 2010, 'let out where the boat stopped');
  t.deepEqual(asBuilt(land), BUILT);
  t.is(peekVillages(world).open, undefined);
  t.true(land.said.includes('villagers: stopped with the boat out; the villager let out at (-556, 63, 2002), the boat taken back up'), land.said.join(' | '));
});

test('stopped from outside in the fence\'s opening: out, the boat taken up, the hall\'s wall never dug, and what the fence lost left for close up (no put-back from a run given up)', async (t) => {
  const world = hallWorld();
  const abort = new AbortController();
  const land = new Land(world, { abortAt: { leg: 2, abort } });
  await t.throwsAsync(asBrain(land, abort), { message: /aborted/ });
  t.false(land.riding);
  t.is(land.boat, undefined);
  t.deepEqual(actedFrom(land, /cancelled/), ['drive to (-555.5, 2124): cancelled', 'out of the boat', 'boat taken up at (-555.5, 2120.3)']);
  t.false(land.log.some(l => l.startsWith('dig oak_planks')));
  t.deepEqual((peekVillages(world).open ?? []).map(o => fmt(o.at)).sort(), [...POSTS, TORCH].map(fmt).sort());
  // close up wants once the bot is in the yard, and puts them back
  t.regex(closeUpGoal.wants(snap(KIT()), world) ?? '', /^4 block\(s\) of the hall or the fence left open/);
});

test('stopped from outside the moment the boat is down, before the bot is in: the boat taken back up, the villager left in its village, not sitting in the bot\'s boat', async (t) => {
  const world = hallWorld();
  const abort = new AbortController();
  const land = new Land(world);
  const call = land.call.bind(land);
  land.call = (m, p = {}) => { const r = call(m, p); if (m === 'vehicle.place' && (r as { ok?: boolean }).ok) abort.abort(); return r; };
  await t.throwsAsync(asBrain(land, abort), { message: /aborted/ });
  t.false(land.log.includes('into the boat'));
  t.is(land.boat, undefined);
  t.is(peekVillages(world).boat, undefined);
  t.deepEqual(actedFrom(land, /^boat down/), ['boat down at (-557, 62, 1889), villager 101 in', 'boat taken up at (-556.5, 1889.4)']);
  t.true(land.villagers.find(e => e.id === 101)!.position.z < 1900, 'in its own village');
});

test('seated in its own boat with no run to steer it (a restart, or a let-go that failed): out of it toward home and the boat taken back up, before anything else starts', async (t) => {
  let now = T0;
  let riding = true;
  const calls: string[] = [];
  const look: Goal = { name: 'look', priority: 1, timeoutMs: 10_000, retryMs: 10_000, wants: () => 'a look', run: async () => 'looked' };
  const rt = {
    actions: {},
    call: async (m: string, p: Record<string, unknown> = {}) => {
      if (m === 'inventory') return { items: [] };
      if (m === 'world.region') return { blocks: [] };
      if (m.startsWith('vehicle.')) {
        calls.push(`${m} ${JSON.stringify(p)}`);
        if (m === 'vehicle.dismount') { riding = false; return { ok: true, wasRiding: true }; }
        if (m === 'vehicle.take') return { ok: true, hits: 1, item: 'oak_boat', pickedUp: true };
      }
      return {};
    },
    status: async () => ({
      inWorld: true, username: 'Bot', screen: null, position: { x: -556.5, y: 63, z: 2002.5 }, block: { x: -557, y: 63, z: 2002 }, timeOfDay: 1000, hashedSeed: '9',
      dimension: 'overworld', health: 20, food: 20,
      riding: riding ? { id: 900, uuid: 'b0a7-0001', name: 'oak_boat', position: { x: -556.5, y: 63, z: 2002.5 }, own: false, seat: 0, controlling: true, passengers: [{ id: 900 }, { id: 101 }] } : null
    }),
    home: () => ({ ...HOME, dimension: 'overworld' }), lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => now, goals: [look] });
  brain.setEnabled(true);
  // (the world's memory as a move left it: the boat's uuid kept, the bridge's own list of its boats gone with a restart)
  riding = false;
  await brain.tick();
  await new Promise(r => setTimeout(r, 20));
  brain.worldMemory()!.villages = { sites: [], players: [], boat: { uuid: 'b0a7-0001', at: { x: -557, y: 62, z: 2002 }, since: T0 } };
  riding = true;
  calls.length = 0;
  now += 60_000;
  await brain.tick();
  t.deepEqual(calls, [`vehicle.dismount {"toward":{"x":${HOME.x},"z":${HOME.z}}}`, 'vehicle.take {"id":900,"uuid":"b0a7-0001"}']);
  t.is(brain.worldMemory()!.villages!.boat, undefined);
  t.regex(brain.status(), /villagers: out of the oak_boat at \(-557, 63, 2002\), no run steering it \(a move stopped from outside, or a restart\), its boat taken back up/);
  t.notRegex(brain.status(), /Now: look/, 'nothing started while seated');
  brain.setEnabled(false);
});

test('the courtesy judge: a player\'s house by a village is another build of others (noted since Nov 20, the village free), a bed and a barrel in it or villagers by it notwithstanding; a village whose beds chain out to 70 from its bell keeps its own houses', (t) => {
  const why = (look: VillageLook) => { const v = judgeVillage(look); return v.kind === 'free' ? `free: ${v.notes.join('; ')}` : `${v.kind}: ${v.why}`; };
  // a cobblestone house 12 east of the village's east bed (-541, 1887): no bed, bell or job site of the village by it
  const cobble: Zone = { x1: -529, y1: 59, z1: 1880, x2: -520, y2: 70, z2: 1892, markers: 40, surface: true, sample: 'cobblestone' };
  t.is(why(freeLook({ zones: [...VILLAGE_ZONES(), cobble] })), 'free: another build 0 from it (x -529..-520, z 1880..1892, cobblestone)');
  // a player's house 80 east of the bell with a white bed and a barrel: 65 from the village's nearest bed, not chained in
  const house: Zone = { x1: -481, y1: 59, z1: 1875, x2: -470, y2: 70, z2: 1887, markers: 60, surface: true, sample: 'spruce_planks' };
  const look = freeLook({ zones: [...VILLAGE_ZONES(), house] });
  t.is(why({ ...look, beds: [...look.beds, { x: -476, y: 63, z: 1880 }], jobs: [...look.jobs, { name: 'barrel', at: { x: -474, y: 63, z: 1882 } }] }),
    'free: another build 0 from it (x -481..-470, z 1875..1887, spruce_planks)');
  // a player's house alone 17 off, and the same with two unemployed villagers standing by it
  const by: Zone = { x1: -500, y1: 60, z1: 1870, x2: -490, y2: 70, z2: 1880, markers: 30, surface: true, sample: 'spruce_planks' };
  const two: Villager[] = [{ id: 120, name: 'villager', position: { x: -495.5, y: 63, z: 1885.5 }, profession: 'none', level: 1, baby: false }, { id: 121, name: 'villager', position: { x: -492.5, y: 63, z: 1866.5 }, profession: 'none', level: 1, baby: false }];
  t.is(why(freeLook({ zones: [...VILLAGE_ZONES(), by] })), 'free: another build 17 from it (x -500..-490, z 1870..1880, spruce_planks)');
  t.is(why(freeLook({ zones: [...VILLAGE_ZONES(), by], seen: [...VILLAGERS(), ...two] })), 'free: another build 0 from it (x -500..-490, z 1870..1880, spruce_planks)');
  // a village's own beds chained out east, 30, 60 and 70 from the bell, each in a house: its own, and the village free
  const beds = [{ x: -526, y: 63, z: 1880 }, { x: -496, y: 63, z: 1880 }, { x: -486, y: 63, z: 1882 }];
  const houses: Zone[] = beds.map(b => ({ x1: b.x - 4, y1: 59, z1: b.z - 4, x2: b.x + 4, y2: 70, z2: b.z + 4, markers: 50, surface: true, sample: 'oak_planks' }));
  const far = judgeVillage({ ...freeLook({ zones: [...VILLAGE_ZONES(), ...houses] }), beds: [...freeLook().beds, ...beds] });
  t.is(far.kind, 'free', far.why);
  if (far.kind === 'free') t.is(far.own.length, 5);
  // an unemployed villager wandering 60 out east, no build by it: no village's, and not one to take
  const stray: Villager = { id: 130, name: 'villager', position: { x: -496.5, y: 63, z: 1880.5 }, profession: 'none', level: 1, baby: false };
  t.like(judgeVillage(freeLook({ seen: [...VILLAGERS(), stray] })), { kind: 'free', candidates: [{ id: 101 }, { id: 107 }], why: '7 villagers, 2 unemployed adult(s) to take (2 employed, 1 babies, 1 nitwits, 1 by a job site)' });
});

test('the courtesy judge: two villagers traded with (above level 1) make the village someone\'s, one alone is noted and never taken; no bell seen, or a call that did not answer, waits', (t) => {
  const traded = VILLAGERS();
  traded[1] = { ...traded[1], level: 2 };
  t.like(judgeVillage(freeLook({ seen: traded })), { kind: 'free', notes: ['a villager (-567, 63, 1878) is at level 2 (not taken)'] });
  traded[0] = { ...traded[0], level: 2 };
  t.like(judgeVillage(freeLook({ seen: traded })), { kind: 'theirs', rule: 'villager', why: '2 villagers used by a player: (-557, 63, 1890) is at level 2, (-567, 63, 1878) is at level 2' });
  // (an unemployed one traded with: a player cured it, or it lost its job: not taken)
  const cured = VILLAGERS();
  cured[0] = { ...cured[0], level: 2 };
  t.like(judgeVillage(freeLook({ seen: cured })), { kind: 'free', candidates: [{ id: 107 }] });
  t.like(judgeVillage(freeLook({ bells: [] })), { kind: 'wait', why: 'its bell not seen yet (every village has one at its meeting point)' });
  t.like(judgeVillage(freeLook({ zones: [], unread: ['the builds of others round it'] })), { kind: 'wait', why: 'the builds of others round it not read' });
  t.like(judgeVillage(freeLook({ spawn: undefined, unread: ['the world spawn'] })), { kind: 'wait', why: 'the world spawn not read' });
});

test('the look: foreign.zones not answering is no "no builds round it": the village waits, nothing touched', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  const call = land.call.bind(land);
  land.call = (m, p = {}) => { if (m === 'foreign.zones') throw new Error('timed out'); return call(m, p); };
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -556,1880] the village at (-556, 63, 1880): the builds of others round it not read; back home');
  t.deepEqual(acted(land), []);
});

test('remembered for good: a village judged someone\'s outlives 8 newer sites, a player seen by a village outlives hundreds of sightings elsewhere (noted by the judge), and a player seen by a known village no longer makes it someone\'s (Nov 20)', (t) => {
  const world = hallWorld({ villages: { sites: [{ x: -300, y: 70, z: 2300, seenAt: T0, judged: { at: T0, kind: 'theirs', why: 'a sign by it' } }], players: [] } });
  for (let i = 0; i < 10; i++) noteSeen(world, [{ id: 500 + i, name: 'villager', position: { x: -1000 + 100 * i, y: 63, z: 1700 } }], T0 + i);
  t.true(peekVillages(world).sites.some(s => s.x === -300 && s.judged?.kind === 'theirs'), 'someone\'s kept');
  t.is(peekVillages(world).sites.length, 9);
  // its bell seen again: the same site, someone's still, no move goes to it
  const again = noteVillage(world, { x: -300, y: 70, z: 2300 }, { bells: 1 }, T0 + MINUTE);
  t.is(again.judged?.kind, 'theirs');
  t.false(siteOpen(again, HOME, T0 + MINUTE));
  // a player by a village not known yet, then 100 places elsewhere by the community chest, 20 apart
  const w2 = hallWorld({ villages: { sites: [], players: [] } });
  noteSeen(w2, [{ id: 9, name: 'player', position: { x: -520, y: 63, z: 1880 } }], T0);
  for (let i = 0; i < 100; i++) noteSeen(w2, [{ id: 9, name: 'player', position: { x: -437 + 20 * (i % 10), y: 63, z: 2134 + 20 * Math.floor(i / 10) } }], T0 + (i + 1) * MINUTE);
  t.like(judgeVillage(freeLook({ players: peekVillages(w2).players })), { kind: 'free', notes: ['a player was seen 0 from it, at (-520, 63, 1880) (14:00)'] });
  // far from the yard (1000 out): not kept
  noteSeen(w2, [{ id: 9, name: 'player', position: { x: -549, y: 63, z: 3183 } }], T0);
  t.false(peekVillages(w2).players.some(p => p.z === 3183));
  // past the cap, the place seen longest ago goes first, a place seen again stays
  const w3 = hallWorld({ villages: { sites: [], players: [] } });
  const place = (i: number) => ({ x: -900 + 20 * (i % 40), y: 63, z: 1900 + 20 * Math.floor(i / 40) });
  for (let i = 0; i < 512; i++) noteSeen(w3, [{ id: 9, name: 'player', position: place(i) }], T0 + i * 1000);
  noteSeen(w3, [{ id: 9, name: 'player', position: place(0) }], T0 + 600_000);
  noteSeen(w3, [{ id: 9, name: 'player', position: place(600) }], T0 + 601_000);
  const kept = peekVillages(w3).players;
  t.is(kept.length, 512);
  t.true(kept.some(p => p.x === place(0).x && p.z === place(0).z), 'seen again: kept');
  t.false(kept.some(p => p.x === place(1).x && p.z === place(1).z), 'seen longest ago: gone');
  // a player seen 36 from a known village's middle: remembered, the village's word untouched (since Nov 20)
  const w4 = hallWorld();
  noteSeen(w4, [{ id: 9, name: 'player', position: { x: -520, y: 63, z: 1880 } }], T0);
  t.is(w4.villages!.sites[0].judged, undefined);
  t.true(peekVillages(w4).players.some(p => p.x === -520 && p.z === 1880));
});

test('the side search walks on past a village already judged (someone\'s here): not walked into or looked at again, and the side gets the plain dry mark', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  land.villagers[1].named = true;
  land.villagers[2].named = true;
  await rung(land).run(land.ctx());
  t.like(peekVillages(world).sites[0].judged, { kind: 'theirs' });
  const from = land.log.length;
  const r = await villagersTask.run(land.ctx(), 'north', MOVE_BUDGET, () => land.t);
  t.is(r.text, 'no village north within the village range (640 from home)');
  t.is(r.mark, undefined, 'no "first": the side waits longer each dry run');
  t.false(land.log.slice(from).some(l => /^goto \(-556, 63, 1880\)/.test(l)), 'not walked over to');
  t.false(land.said.some(l => /looking round the village/.test(l)));
});

test('the time home judged before the villager is taken: too little of the run left, none taken; and again once the boat is down, the villager let out in its own village', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  const r = await villagersTask.run(land.ctx(), 'village -556,1880', 3 * MINUTE, () => land.t);
  t.regex(r.text, /^not enough of the run left to bring a villager home from \(-556, 63, 1880\) \(need 20\d s, \d+ s left\)$/);
  t.is(r.mark, 'same');
  t.false(land.log.some(l => l.startsWith('boat down')));
  // the boat down after a long wait for it (6 min): the time left judged again, before the bot gets in
  const w2 = hallWorld();
  const l2 = new Land(w2);
  const call = l2.call.bind(l2);
  l2.call = (m, p = {}) => { const x = call(m, p); if (m === 'vehicle.place') l2.t += 6 * MINUTE; return x; };
  const text = await rung(l2).run(l2.ctx());
  t.regex(text, /^\[village -556,1880\] gave up: not enough of the run left to bring the villager home \(need 20\d s, \d+ s left\); the villager let out at \(-557, 63, 1889\), the boat taken back up; back home$/);
  t.false(l2.log.includes('into the boat'));
  t.true(w2.villagerMoves, 'not under way home yet: the switch as it was');
});

test('to a village on the far side of the yard, the walk out skips the stops inside the fence (the band there read from home), none walked to in the yard', async (t) => {
  const world = hallWorld({ villages: { sites: [{ x: -556, y: 63, z: 2483, villagers: 6, seenAt: T0 - 60 * MINUTE }], players: [] } });
  const land = new Land(world);
  await rung(land).run(land.ctx());
  const inYard = (l: string) => { const m = /^goto \((-?\d+), \d+, (-?\d+)\)/.exec(l); return !!m && Number(m[1]) > YARD.x1 && Number(m[1]) < YARD.x2 && Number(m[2]) > YARD.z1 && Number(m[2]) < YARD.z2; };
  // (only the walks out and back in by the north gate, from its inner cell: no stop of the line home in the yard, careful or not)
  t.deepEqual([...new Set(land.log.filter(inYard))], ['goto (-549, 63, 2121) careful']);
  t.true(land.log.some(l => /^goto \(-55\d, 63, 225\d\)/.test(l)), land.log.filter(l => l.startsWith('goto')).join(' | '));
});

test('the hall counted first on every run: a full hall sends no side search out either', async (t) => {
  const world = hallWorld({ villages: { sites: [], players: [] } });
  const land = new Land(world);
  land.villagers.push(...[1, 2, 3].map(i => ({ id: 200 + i, name: 'villager', position: { x: -558.5 + i, y: 63, z: 2130.5 }, profession: 'none', baby: false })));
  const text = await rung(land).run(land.ctx());
  t.is(text, '[north] the hall has 3 villagers already: none moved');
  t.false(land.log.some(l => l.startsWith('goto')));
});

test('villagers standing on the village\'s paths: passed over (no boat way can start where they stand), the village not given up for a day', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  for (const id of [101, 107]) {
    const v = land.villagers.find(e => e.id === id)!;
    land.blocks.set(`${Math.floor(v.position.x)},62,${Math.floor(v.position.z)}`, 'dirt_path');
    v.position = { ...v.position, y: 62.9375 };
  }
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -556,1880] no villager to take at (-556, 63, 1880) stands where a boat way could start (2 on a path, farmland or the like): looked at again when they have wandered; back home');
  t.is(peekVillages(world).sites[0].noBoat, undefined);
  t.deepEqual(acted(land), []);
});

test('the villager looked at again just before the boat: one that took a job since the judge\'s look is not taken', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  const call = land.call.bind(land);
  land.call = (m, p = {}) => {
    if (m === 'world.entities' && land.log.includes('goto (-557, 63, 1890) careful')) land.villagers.find(e => e.id === 101)!.profession = 'mason';
    return call(m, p);
  };
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -556,1880] gave up: the villager (101) has a job now (mason): no longer one to take; back home');
  t.false(land.log.some(l => l.startsWith('boat down')));
});

test('fed for the ride home: short of ready food (under 40 points carried, none to take), not setting out', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  land.items.find(i => i.name === 'bread')!.count = 6;
  await t.throwsAsync(rung(land).run(land.ctx()), { message: '[village -556,1880] not setting out: short of food (30 food points of ready food carried, 40 wanted for the ride home)' });
  t.false(land.log.some(l => l.startsWith('goto') && !/careful/.test(l)), 'never walked out');
});

// ------------------------------------------------------------------------------------------------ the first live run's fixes (F7)

/**
 * The village west of home as the first live run met it (Nov 15, 16:35Z): its bell 164 out at (-693, 69, 2262) (on
 * the stand-in world's flat ground, at 63), its villagers in three knots, 37, 40 and 60 from it (the walk's looks
 * noted a site at each a minute before the judge wrote the bell's), and by it a stable of hay (another build to the
 * judge: someone's).
 */
const WEST_BELL: Pos = { x: -693, y: 63, z: 2262 };
function westVillage(land: Land): Villager[] {
  const knot = (x: number, y: number, z: number, n: number, id: number): Villager[] =>
    Array.from({ length: n }, (_, i) => ({ id: id + i, name: 'villager', position: { x: x + (i % 3), y, z: z + Math.floor(i / 3) }, profession: i % 2 ? 'farmer' : 'none', level: 1, baby: false }));
  land.villagers = [...knot(-659.5, 63, 2245.5, 2, 400), ...knot(-699.5, 63, 2301.5, 5, 410), ...knot(-751.5, 63, 2259.5, 4, 420)];
  land.marks = [
    { name: 'bell', at: { ...WEST_BELL } }, { name: 'white_bed', at: { x: -690, y: 63, z: 2280 } }, { name: 'white_bed', at: { x: -702, y: 63, z: 2290 } },
    { name: 'white_bed', at: { x: -720, y: 63, z: 2262 } }, { name: 'lectern', at: { x: -695, y: 63, z: 2270 } }, { name: 'composter', at: { x: -725, y: 63, z: 2258 } }
  ];
  land.zones = [{ x1: -703, y1: 64, z1: 2315, x2: -670, y2: 75, z2: 2344, markers: 40, surface: true, sample: 'hay_block' }];
  return land.villagers;
}

test('one village, one verdict: the live run of Nov 15 (its villagers noted at three places on the walk, then the judge at its bell) leaves one site; since Nov 20 free, its stable (not read) noted, the move offered for it once', async (t) => {
  const world = hallWorld({ villages: { sites: [], players: [] } });
  world.zones!['fence:gate']!.push({ x: -565, y: 63, z: 2183 });
  const land = new Land(world, { houses: [] });
  const vs = westVillage(land);
  // (the looks on the walk, a minute before the judge: a site for each knot, none within 64 of another)
  noteSeen(world, vs, T0 - MINUTE);
  t.deepEqual(peekVillages(world).sites.map(s => `${s.x},${s.z} ${s.villagers}`), ['-660,2245 2', '-700,2301 5', '-752,2259 4']);
  const r = await villagersTask.run(land.ctx(), 'west', MOVE_BUDGET, () => land.t);
  t.is(r.text, 'found a village at (-693, 63, 2262): free (5 villagers, 3 unemployed adult(s) to take (2 employed); noted: another build 0 from it (x -703..-670, z 2315..2344, hay_block)): the move next run');
  // one site: the bell's, the other two folded into it (their counts kept: the most seen), its area kept
  const sites = peekVillages(world).sites;
  t.is(sites.length, 1, JSON.stringify(sites));
  t.like(sites[0], { x: -693, y: 63, z: 2262, bells: 1, beds: 3, jobs: 2, villagers: 11, judged: { kind: 'free', v: JUDGE_V }, area: { x1: -776, z1: 2221, x2: -635, z2: 2326 } });
  // one move offered for it, from the bell's site (live, the next run went to a knot's: "village -700,2301")
  t.false(rejudge(sites[0]));
  const vs2 = villagersTask.variants(snap(KIT(), { now: land.t }), world);
  t.deepEqual(vs2.map(v => v.id), ['village -693,2262', ...SEARCHES]);
  t.like(vs2[0], { needMs: moveNeedMs(Math.hypot(-693 - HOME.x, 2262 - HOME.z)) });
  // and the west side walks on past it next time, as past any village judged
  t.truthy(knownVillage(world, { x: -700, z: 2301 }));
  t.truthy(knownVillage(world, { x: -760, z: 2300 }), 'inside its area, 77 from its bell');
});

test('one village, one verdict: the sites the live run left (the bell\'s someone\'s, two not judged 40 and 60 from it) read as one, and are written so by the next run; a villager or a bell seen in a judged village\'s area is that village; someone\'s outranks a newer word', async (t) => {
  const theirs = { at: T0 - 5 * MINUTE, kind: 'theirs' as const, why: 'another build 0 from it (x -703..-670, z 2315..2344, hay_block)' };
  const world = hallWorld({
    villages: {
      sites: [
        { x: -693, y: 69, z: 2262, villagers: 7, bells: 1, beds: 10, jobs: 3, seenAt: T0 - 5 * MINUTE, judged: theirs },
        { x: -700, y: 69, z: 2301, villagers: 5, seenAt: T0 - 6 * MINUTE }, { x: -752, y: 70, z: 2259, villagers: 4, seenAt: T0 - 6 * MINUTE }
      ],
      players: []
    }
  });
  const before = JSON.stringify(world);
  t.deepEqual(peekVillages(world).sites.map(s => `${s.x},${s.z} ${s.judged?.kind}`), ['-693,2262 theirs']);
  // (no move offered for either: its own site is offered for a look, its word of someone's (another build, the judge
  // before Nov 17) to be judged again; the two folded into it are not offered at all)
  t.deepEqual(villagersTask.variants(snap(KIT()), world).map(v => v.id), ['village -693,2262', ...SEARCHES], 'no move offered for either');
  t.is(JSON.stringify(world), before, 'the gates write nothing');
  const judged = world.villages!.sites[0];
  villagesOf(world);
  t.deepEqual(world.villages!.sites, [judged], 'made whole: the judged site itself kept (a run holds it across its awaits)');
  t.like(judged, { x: -693, z: 2262, villagers: 7, beds: 10, seenAt: T0 - 5 * MINUTE, judged: theirs });
  // its verdict from before areas were kept (it has none, and is never judged again): its villagers seen 73-75 from its
  // bell, as the south-west search would pass them, are that village too (no site made for them: a trip out for nothing)
  noteSeen(world, [1, 2, 3].map(i => ({ id: 10 + i, name: 'villager', position: { x: -765.5 - i, y: 69, z: 2262.5 } })), T0 - 4 * MINUTE);
  t.deepEqual(world.villages!.sites, [judged], 'no site of their own');
  t.deepEqual(villagersTask.variants(snap(KIT()), world).map(v => v.id), ['village -693,2262', ...SEARCHES]);
  t.truthy(knownVillage(world, { x: -768, z: 2262 }));
  // seen again in its area (77 from its bell): no new site, the village's own is that
  judged.area = { x1: -776, z1: 2235, x2: -636, z2: 2325 };
  noteSeen(world, [{ id: 1, name: 'villager', position: { x: -760.5, y: 70, z: 2300.5 } }], T0);
  t.is(peekVillages(world).sites.length, 1);
  t.deepEqual(world.villages!.sites, [judged], 'none written for it (not only folded away on a read)');
  t.is(noteVillage(world, { x: -770, y: 70, z: 2300 }, { bells: 1 }, T0), judged, 'a bell in its area: that village');
  t.like(judged, { x: -693, z: 2262 }, 'and its middle stays at its own bell');
  // out of its area and 64 off: a village of its own
  noteSeen(world, [{ id: 2, name: 'villager', position: { x: -800.5, y: 70, z: 2380.5 } }], T0);
  t.is(peekVillages(world).sites.length, 2);
  // a free word 50 from a site judged someone's before: the village is someone's (the courteous side), its moves kept
  const w2 = hallWorld({
    villages: {
      sites: [{ x: -556, y: 63, z: 1830, seenAt: T0 - HOUR, judged: { at: T0 - HOUR, kind: 'theirs', why: 'a player was seen 20 from it, at (-560, 63, 1810) (13:00)' } },
        { x: -556, y: 63, z: 1880, seenAt: T0, moved: 1, judged: { at: T0, kind: 'free', why: '7 villagers' } }],
      players: []
    }
  });
  t.like(peekVillages(w2).sites, [{ z: 1830, moved: 1, judged: { kind: 'theirs' } }]);
  t.is(peekVillages(w2).sites.length, 1);
});

test('one village, one verdict: a move\'s fresh look that finds its village free, its bell 50 from a site of it judged someone\'s before, leaves it alone: nothing touched', async (t) => {
  // (a site of villagers seen 70 north of the bell, offered; one 50 south of the bell judged someone's: a player by it)
  const world = hallWorld({
    villages: {
      sites: [{ x: -556, y: 63, z: 1950, villagers: 6, seenAt: T0 - HOUR }, { x: -556, y: 63, z: 1830, seenAt: T0 - HOUR, judged: { at: T0 - HOUR, kind: 'theirs', why: 'a player was seen 20 from it, at (-560, 63, 1810) (13:00)' } }],
      players: []
    }
  });
  t.deepEqual(villagersTask.variants(snap(KIT()), world).map(v => v.id)[0], 'village -556,1950');
  const land = new Land(world);
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -556,1950] left the village at (-556, 63, 1880) alone: a player was seen 20 from it, at (-560, 63, 1810) (13:00); back home');
  t.deepEqual(acted(land), []);
  // (one site, someone's, at the bell the fresh look saw)
  t.like(peekVillages(world).sites, [{ x: -556, z: 1880, bells: 1, judged: { kind: 'theirs', why: 'a player was seen 20 from it, at (-560, 63, 1810) (13:00)' } }]);
  t.is(peekVillages(world).sites.length, 1);
});


test('one village, one verdict, folded both ways and to the end: a site someone\'s for good (no area) inside the area of a newer word 98 off, and a site the fold reaches only once its judged one has moved to a bell; the gates and the write alike', (t) => {
  // (someone's for good, by two villagers named there: no area, no bell (a word of a knot of villagers); its village's bell
  // 98 south, judged too small 7 hours ago, its area holding the first: open again)
  const theirs = { at: T0 - 8 * HOUR, kind: 'theirs' as const, why: '2 villagers used by a player: (-556, 63, 1780) is named, (-557, 63, 1781) is named', rule: 'villager' as const, v: JUDGE_V };
  const both = () => hallWorld({
    villages: {
      sites: [{ x: -556, y: 63, z: 1800, villagers: 3, seenAt: T0 - 8 * HOUR, judged: { ...theirs } },
        { x: -556, y: 63, z: 1898, bells: 1, villagers: 4, seenAt: T0 - 7 * HOUR, judged: { at: T0 - 7 * HOUR, kind: 'wait', why: '4 villager(s) seen, 5 or more wanted' }, area: { x1: -590, z1: 1780, x2: -520, z2: 1930 } }],
      players: []
    }
  });
  const w1 = both();
  t.deepEqual(peekVillages(w1).sites.map(s => `${s.x},${s.z} ${s.judged?.kind}`), ['-556,1898 theirs'], 'one village: someone\'s, at its bell');
  t.deepEqual(villagersTask.variants(snap(KIT()), w1).map(v => v.id), SEARCHES, 'no move offered for it');
  const t1 = w1.villages!.sites[0], w = w1.villages!.sites[1];
  t.deepEqual(villagesOf(w1).sites, [t1]);
  // (its area: the bell's joined with the ground it covered where it stood, 88 round (-556, 1800) with no area of its own)
  t.like(t1, { x: -556, z: 1898, bells: 1, villagers: 4, judged: theirs, area: { x1: -644, z1: 1712, x2: -468, z2: 1930 } });
  t.is(foldedInto(w), t1, 'the write says which site it went into');
  // (someone's with no bell; a knot of villagers 100 off it, ahead in the list; the bell 50 off it: the knot is that
  // village once the site has moved to the bell, and the gates' copy reads it so as the write does)
  const three = () => hallWorld({
    villages: {
      sites: [{ x: -556, y: 63, z: 1800, seenAt: T0 - HOUR, judged: { ...theirs } }, { x: -556, y: 63, z: 1900, villagers: 4, seenAt: T0 - HOUR },
        { x: -556, y: 63, z: 1850, bells: 1, seenAt: T0 - HOUR }],
      players: []
    }
  });
  const w2 = three();
  const before = JSON.stringify(w2);
  t.deepEqual(peekVillages(w2).sites.map(s => `${s.x},${s.z} ${s.judged?.kind ?? '-'}`), ['-556,1850 theirs']);
  t.deepEqual(villagersTask.variants(snap(KIT()), w2).map(v => v.id), SEARCHES);
  t.is(JSON.stringify(w2), before, 'the gates write nothing');
  const knot = w2.villages!.sites[1];
  t.deepEqual(villagesOf(w2).sites.map(s => `${s.x},${s.z} ${s.judged?.kind ?? '-'} ${s.villagers}`), ['-556,1850 theirs 4']);
  t.is(foldedInto(knot), w2.villages!.sites[0]);
});

test('one village, one verdict, the run\'s word: its site folded after the judge into one judged someone\'s, the run reads that one\'s word (not a site nearer the bell, not judged); a player seen by its own site as the look went round no longer makes it someone\'s (Nov 20)', async (t) => {
  // (the run's knot 12 from the bell; another knot 60 from the bell, outside the village's area; a site judged someone's
  // 80 from the bell, its own bell there: the run's site, moved to the bell, is that village, the other knot not)
  const theirs = { at: T0 - HOUR, kind: 'theirs' as const, why: '2 villagers used by a player: (-556, 63, 1980) is named, (-557, 63, 1981) is named', rule: 'villager' as const, v: JUDGE_V };
  const world = hallWorld({
    villages: {
      sites: [{ x: -556, y: 63, z: 1820, villagers: 3, seenAt: T0 - HOUR }, { x: -556, y: 63, z: 1868, villagers: 6, seenAt: T0 - HOUR },
        { x: -556, y: 63, z: 1960, bells: 1, seenAt: T0 - HOUR, judged: { ...theirs } }],
      players: []
    }
  });
  t.deepEqual(villagersTask.variants(snap(KIT()), world).map(v => v.id).slice(0, 2), ['village -556,1868', 'village -556,1820']);
  const land = new Land(world);
  t.is(await rung(land).run(land.ctx()), `[village -556,1868] left the village at (-556, 63, 1880) alone: ${theirs.why}; back home`);
  t.deepEqual(acted(land), []);
  t.like(peekVillages(world).sites.find(s => s.z === 1960), { bells: 1, judged: theirs, area: { z1: 1842 } });
  // a player seen 80 from the run's own site (148 from the bell) as the look goes round: no longer someone's (Nov 20),
  // remembered only: the village at its bell is free, the player too far off to stop the move
  const w2 = hallWorld({ villages: { sites: [{ x: -556, y: 63, z: 1812, villagers: 3, seenAt: T0 - HOUR }], players: [] } });
  const l2 = new Land(w2);
  l2.players.push({ id: 77, name: 'player', position: { x: -556, y: 63, z: 1732 } });
  t.regex(await rung(l2).run(l2.ctx()), /^\[village -556,1812\] moved an unemployed villager from the village at \(-556, 63, 1880\)/);
  t.like(peekVillages(w2).sites, [{ x: -556, z: 1880, bells: 1, judged: { kind: 'free' } }]);
  t.is(peekVillages(w2).sites.length, 1);
  t.true(peekVillages(w2).players.some(p => p.z === 1732));
});

test('one village, one verdict, at the run\'s start: a variant whose site has been folded into its village\'s judged one since it was offered (the hall not counted, so nothing else wrote the memory) is no village of its own: forgotten, nothing done', async (t) => {
  // (written by hand, as they stood before a write folded them: the bell's site someone's, a knot 40 from it)
  const world = hallWorld({
    villages: {
      sites: [{ x: -556, y: 63, z: 1880, bells: 1, seenAt: T0 - HOUR, judged: { at: T0 - HOUR, kind: 'theirs', why: 'another build 0 from it' } },
        { x: -556, y: 63, z: 1920, villagers: 4, seenAt: T0 - HOUR }],
      players: []
    }
  });
  const land = new Land(world);
  const call = land.call.bind(land);
  land.call = (m, p = {}) => { if (m === 'world.entities') throw new Error('no reply'); return call(m, p); };
  const r = await villagersTask.run(land.ctx(), 'village -556,1920', MOVE_BUDGET, () => land.t);
  t.like(r, { gain: 0, text: 'no village -556,1920 known any more', mark: 'forget' });
  t.deepEqual(land.log, []);
  t.deepEqual(world.villages!.sites.map(s => `${s.x},${s.z} ${s.judged?.kind ?? '-'}`), ['-556,1880 theirs']);
});

test('one village, one verdict, as the look goes round: a player seen by another site of the village no longer makes that one someone\'s (Nov 20): the fold takes the run\'s site to the bell, judged free, the move made; a look that sees nothing there forgets the run\'s site, the player remembered', async (t) => {
  // (the run's site 50 north of the bell, where the bell's own villagers were seen; another 70 on, where 3 were; a player
  // 25 past that one, seen as the look goes round: 111 off the village's area, far from the bot)
  const two = () => hallWorld({ villages: { sites: [{ x: -556, y: 63, z: 1930, villagers: 4, seenAt: T0 - HOUR }, { x: -556, y: 63, z: 2000, villagers: 3, seenAt: T0 - HOUR }], players: [] } });
  const player: Seen = { id: 77, name: 'player', position: { x: -556, y: 63, z: 2025 } };
  const world = two();
  const land = new Land(world);
  land.players.push({ ...player });
  const r = await villagersTask.run(land.ctx(), 'village -556,1930', MOVE_BUDGET, () => land.t);
  t.regex(r.text, /^moved an unemployed villager from the village at \(-556, 63, 1880\) to the hall/);
  t.false(peekVillages(world).sites.some(s => s.judged?.kind === 'theirs'));
  t.true(peekVillages(world).players.some(p => p.z === 2025));
  // nothing seen there at all (no villager, no bell: gone, or the look's calls not answered): the run's site forgotten,
  // the other kept as it was
  const w2 = two();
  const l2 = new Land(w2);
  l2.villagers = [];
  l2.marks = [];
  l2.players.push({ ...player });
  t.like(await villagersTask.run(l2.ctx(), 'village -556,1930', MOVE_BUDGET, () => l2.t), { text: 'no village at (-556, 63, 1930) any more: forgotten', mark: 'forget' });
  t.deepEqual(peekVillages(w2).sites.map(s => `${s.x},${s.z} ${s.judged?.kind ?? '-'}`), ['-556,2000 -']);
});

test('one village, one verdict, its ground kept: a site someone\'s that a fold moves to its village\'s bell still covers the ground round where it stood (a villager seen there is that village: no site of its own, no move offered); so does one with no area that takes a free site\'s bell', (t) => {
  // (the bell's site someone's, its area 40 round it; a villager 70 east of the bell makes a site of its own, judged
  // someone's for good (two villagers named there); the next write folds the two, at the bell)
  const world = hallWorld({
    villages: {
      sites: [{ x: -556, y: 63, z: 1880, bells: 1, seenAt: T0 - HOUR, judged: { at: T0 - HOUR, kind: 'theirs', why: 'another build 0 from it' }, area: { x1: -596, z1: 1840, x2: -516, z2: 1920 } }],
      players: []
    }
  });
  noteSeen(world, [{ id: 1, name: 'villager', position: { x: -485.5, y: 63, z: 1880.5 } }], T0 - 30 * MINUTE);
  world.villages!.sites[1].judged = { at: T0 - 20 * MINUTE, kind: 'theirs', why: '2 villagers used by a player: (-486, 63, 1880) is named, (-485, 63, 1881) is named', rule: 'villager', v: JUDGE_V };
  t.deepEqual(world.villages!.sites.map(s => `${s.x},${s.z} ${s.judged?.kind}`), ['-556,1880 theirs', '-486,1880 theirs']);
  t.deepEqual(villagesOf(world).sites.map(s => `${s.x},${s.z} ${s.judged?.kind}`), ['-556,1880 theirs']);
  // a villager 50 from where the second site someone's stood, 120 from the bell
  noteSeen(world, [{ id: 3, name: 'villager', position: { x: -435.5, y: 63, z: 1880.5 } }], T0 - 10 * MINUTE);
  t.is(world.villages!.sites.length, 1, JSON.stringify(world.villages!.sites));
  t.truthy(knownVillage(world, { x: -436, z: 1880 }));
  t.deepEqual(villagersTask.variants(snap(KIT()), world).map(v => v.id), SEARCHES);
  // someone's for good (no area, no bell), a free site's bell 80 off it: kept at the bell, and a villager 50 the
  // other way from where it stood (130 from the bell) is that village too
  const w2 = hallWorld({
    villages: {
      sites: [{ x: -556, y: 63, z: 1880, villagers: 3, seenAt: T0 - HOUR, judged: { at: T0 - HOUR, kind: 'theirs', why: 'within 256 of the world spawn (200 off)', rule: 'spawn', v: JUDGE_V } },
        { x: -476, y: 63, z: 1880, bells: 1, villagers: 6, seenAt: T0 - 30 * MINUTE, judged: { at: T0 - 30 * MINUTE, kind: 'free', why: '6 villagers' }, area: { x1: -500, z1: 1856, x2: -452, z2: 1904 } }],
      players: []
    }
  });
  t.deepEqual(villagesOf(w2).sites.map(s => `${s.x},${s.z} ${s.judged?.kind}`), ['-476,1880 theirs']);
  noteSeen(w2, [{ id: 4, name: 'villager', position: { x: -605.5, y: 63, z: 1880.5 } }], T0);
  t.is(w2.villages!.sites.length, 1, JSON.stringify(w2.villages!.sites));
  t.deepEqual(villagersTask.variants(snap(KIT()), w2).map(v => v.id), SEARCHES);
});

test('the search\'s bearings: the four sides, then the four between them (the quarters a side\'s line never sees), each out to the range (640) by a gate on its own sides, its dry mark written as a side\'s', async (t) => {
  const world = hallWorld({ villages: { sites: [], players: [] } });
  world.zones!['fence:gate']!.push({ x: -533, y: 63, z: 2183 }, { x: -549, y: 63, z: 2215 }, { x: -565, y: 63, z: 2183 });
  const land = new Land(world, { houses: [] });
  land.villagers = [];
  land.marks = [];
  const texts: string[] = [];
  const logs: string[][] = [];
  for (let i = 0; i < SEARCHES.length; i++) {
    const from = land.log.length;
    texts.push(await rung(land).run(land.ctx()));
    logs.push(land.log.slice(from));
  }
  t.deepEqual(texts.map(x => /^\[([a-z-]+)\]/.exec(x)?.[1]), SEARCHES);
  t.is(texts[4], '[north-east] no village north-east within the village range (640 from home); back home');
  // each dry, its mark as a side's: once each, the turn on to the next
  t.deepEqual(Object.keys(world.work!.dry).sort(), SEARCHES.map(b => `villagers:${b}`).sort());
  for (const b of SEARCHES) t.like(world.work!.dry[`villagers:${b}`], { n: 1 }, b);
  // the north-east's stops: 32 apart across the ground along its line, the last 16 inside the range (624 out), out of
  // the yard by the east gate (of the north and east gates, the shorter way)
  const stops = [...Array.from({ length: 19 }, (_, i) => (i + 1) * 32), 624].map(d => `(${Math.round(HOME.x + d / Math.SQRT2)}, 63, ${Math.round(HOME.z - d / Math.SQRT2)})`);
  t.deepEqual(logs[4].filter(l => stops.some(s => l.startsWith(`goto ${s}`))).map(l => /^goto (\([^)]*\))/.exec(l)![1]), stops);
  t.is(Math.round(Math.hypot(Math.round(HOME.x + 624 / Math.SQRT2) - HOME.x, Math.round(HOME.z - 624 / Math.SQRT2) - HOME.z)), 624);
  t.true(land.said.includes('out of the yard by its east gate (-533, 63, 2183)'), land.said.filter(l => /out of the yard/.test(l)).join(' | '));
  t.true(land.said.includes('villagers: looking north-east for a village, out to 640'));
  // and the south-west's by the south or west gate, its last stop 624 out to the south-west
  t.true(logs[6].some(l => l.startsWith(`goto (${Math.round(HOME.x - 624 / Math.SQRT2)}, 63, ${Math.round(HOME.z + 624 / Math.SQRT2)})`)), logs[6].join(' | '));
});

/** The live yard's builds (brain.json, Nov 15) as zones, what a way across the yard keeps off, and its four gates. */
const CANE: [number, number][] = [[-556, 2229], [-548, 2228], [-544, 2227], [-543, 2228], [-536, 2220], [-535, 2221], [-534, 2217], [-533, 2224], [-533, 2226], [-533, 2228],
  [-533, 2230], [-531, 2216], [-528, 2216], [-527, 2208], [-525, 2211], [-525, 2217], [-524, 2218], [-523, 2210], [-522, 2219], [-521, 2220], [-520, 2204], [-520, 2212], [-519, 2208], [-518, 2206]];
const PORTAL = { x1: -562, z1: 2146, x2: -557, z2: 2148 };
const COW_PEN = { x1: -558, z1: 2165, x2: -552, z2: 2171 };
const WORKSHOP = { x1: -546, z1: 2152, x2: -540, z2: 2158 };
function liveZones(world: WorldMemory): WorldMemory {
  const box = (b: { x1: number; z1: number; x2: number; z2: number }) => ({ x: b.x1, y: 62, z: b.z1, width: b.x2 - b.x1 + 1, length: b.z2 - b.z1 + 1 });
  Object.assign(world.zones!, {
    portal: [box(PORTAL)], 'pen:cow': [box(COW_PEN)], workshop: [box(WORKSHOP)], 'pen:sheep': [{ x: -542, y: 62, z: 2196, width: 7, length: 7 }],
    storage: [{ x: -552, y: 62, z: 2178, width: 7, length: 9 }], plot: [{ x: -545, y: 62, z: 2161, width: 9, length: 9 }], trees: [{ x: -546, y: 62, z: 2133, width: 15, length: 11 }],
    enchanting: [{ x: -547, y: 62, z: 2206, width: 7, length: 7 }], cane: CANE.map(([x, z]) => ({ x, y: 63, z })), 'obsidian:cast': [{ x: -556, y: 62, z: 2180 }],
    'fence:gate': [{ ...NORTH_GATE }, { x: -533, y: 63, z: 2183 }, { x: -549, y: 63, z: 2215 }, { x: -565, y: 63, z: 2183 }]
  });
  return world;
}
/**
 * The boat's own box and a quarter block of the drive's slack, anywhere along a to b, meets the box's cells (the way's
 * footprint, its box and the whole slack judged every half block, covers that much at every point between).
 */
function footMeets(a: { x: number; z: number }, b: { x: number; z: number }, box: { x1: number; z1: number; x2: number; z2: number }): boolean {
  const half = 0.6875 + 0.25;
  const n = Math.max(1, Math.ceil(horiz(a, b) / 0.05));
  for (let i = 0; i <= n; i++) {
    const p = { x: a.x + (b.x - a.x) * i / n, z: a.z + (b.z - a.z) * i / n };
    if (p.x - half < box.x2 + 1 && p.x + half > box.x1 && p.z - half < box.z2 + 1 && p.z + half > box.z1) return true;
  }
  return false;
}

/**
 * The live yard's ground as read on Nov 15 (top solid y), a stand-in: the yard at 62 (its fence round it at 63, the four
 * gates, the hall's walls); north of the fence a cleared strip (z 2117-2118) then the hill (65); west a strip
 * (x -567..-566) then the hill but for z 2151-2163 and 2187-2195 (63); east flat (63) from z 2135, the hill north of it;
 * south flat (62). The yard's own builds stand only as zones (the way keeps off them by those alone).
 */
function liveYard(cells: Record<string, string> = {}): Ground {
  const g = new Ground(58, 16);
  const topOf = (x: number, z: number): number => {
    if (x >= YARD.x1 && x <= YARD.x2 && z >= YARD.z1 && z <= YARD.z2) return 62;
    if (z < YARD.z1) return z >= 2117 ? 62 : 65;
    if (x < YARD.x1) return x >= -567 ? 62 : (z >= 2151 && z <= 2163) || (z >= 2187 && z <= 2195) ? 63 : 65;
    if (x > YARD.x2) return z >= 2135 ? 63 : 65;
    return 62;
  };
  const gates = [NORTH_GATE, { x: -533, z: 2183 }, { x: -549, z: 2215 }, { x: -565, z: 2183 }];
  for (let x = -620; x <= -500; x++) for (let z = 2100; z <= 2240; z++) {
    const top = topOf(x, z);
    const ring = ((x === YARD.x1 || x === YARD.x2) && z >= YARD.z1 && z <= YARD.z2) || ((z === YARD.z1 || z === YARD.z2) && x >= YARD.x1 && x <= YARD.x2);
    const inHall = x >= HALL.x && x < HALL.x + HALL.width && z >= HALL.z && z < HALL.z + HALL.length;
    const edgeX = x === HALL.x || x === HALL.x + HALL.width - 1, edgeZ = z === HALL.z || z === HALL.z + HALL.length - 1;
    for (let y = 58; y < 74; y++) {
      let b = y < top ? 'dirt' : y === top ? 'grass_block[snowy=false]' : 'air';
      if (y === 63 && ring) b = gates.some(q => q.x === x && q.z === z) ? 'birch_fence_gate[facing=north,in_wall=false,open=false,powered=false]' : FENCE;
      if (inHall && y >= 63 && y <= 66) {
        if (y === 66) b = 'oak_planks';
        else if (x === HALL_GATE.x && z === HALL_GATE.z && y <= 64) b = y === 63 ? 'oak_fence_gate[facing=south,open=false]' : 'air';
        else if (edgeX && edgeZ) b = 'oak_log[axis=y]';
        else if (edgeX || edgeZ) b = 'oak_planks';
      }
      g.set(x, y, z, cells[`${x},${y},${z}`] ?? b);
    }
  }
  return g;
}

test('the way into the hall across the yard (Nov 15: straight out from its panel, the hill): in by the west fence where the ground outside lets the boat by, the side toward the village, round the portal to a panel in the hall\'s yard-facing wall beside its gate', (t) => {
  const world = liveZones(hallWorld());
  const g = liveYard({ '-565,64,2152': 'torch' });
  // straight out from the built panel: the hill
  const straight = entryOf(world) as Entry;
  t.like(footprint(g, straight.out.x, straight.out.z, straight.level + 2, false), { ok: false, why: 'a wall', at: { x: -557, y: 65, z: 2115 } });
  // the hall's yard-facing wall is its south one (the gate's), the panel two along from the gate toward the yard's middle
  t.deepEqual(yardPanel(world), { side: 'south', at: { x: -554, y: 63, z: 2134 } });
  const e = yardEntry(g, world, { x: WEST_BELL.x, z: WEST_BELL.z });
  if ('why' in e) return t.fail(e.why);
  t.like(e, { side: 'south', dir: [0, 1], level: 63, gate: HALL_GATE, out: { x: -567.5, z: 2152.5 }, front: { x: -553.5, z: 2137 }, inside: { x: -553.5, z: 2130.5 } });
  t.deepEqual(e.fence, [{ x: -565, y: 63, z: 2151 }, { x: -565, y: 63, z: 2152 }, { x: -565, y: 63, z: 2153 }]);
  t.deepEqual(e.wall, [-555, -554, -553].map(x => ({ x, y: 63, z: 2134 })).concat([-555, -554, -553].map(x => ({ x, y: 64, z: 2134 }))));
  t.like(e.yard, { side: 'west', dir: [-1, 0], through: { x: -561.5, z: 2152.5 }, post: { x: -565, y: 63, z: 2152 } });
  // across the yard: round the portal (straight on, it is in the way), each leg judged whole, the last at the hall's stop;
  // its footprint never on the portal, the cow pen or the workshop
  const own = keepOff(g, world);
  t.like(checkLeg(own, { ...e.yard!.through, level: 63 }, e.front), { ok: false, why: 'the bot\'s own portal' });
  t.deepEqual(e.yard!.legs[e.yard!.legs.length - 1], e.front);
  let at = { ...e.yard!.through, level: 63 };
  for (const leg of e.yard!.legs) {
    const c = checkLeg(own, at, leg);
    t.true(c.ok, `${JSON.stringify(at)} -> ${JSON.stringify(leg)}: ${JSON.stringify(c)}`);
    for (const z of [PORTAL, COW_PEN, WORKSHOP]) t.false(footMeets(at, leg, z), `${JSON.stringify(at)} -> ${JSON.stringify(leg)} meets ${JSON.stringify(z)}`);
    at = { ...leg, level: 63 };
  }
  // a village to the south: in by the south fence, round the builds the length of the yard
  const s = yardEntry(g, world, { x: -549, z: 2600 });
  if ('why' in s) return t.fail(s.why);
  t.like(s.yard, { side: 'south', dir: [0, 1] });
  t.deepEqual(s.fence, [-554, -553, -552].map(x => ({ x, y: 63, z: YARD.z2 })));
  let from = { ...s.yard!.through, level: 63 };
  const zones = Object.entries(world.zones!).filter(([kind]) => !/^(fence|hall)/.test(kind)).flatMap(([, bs]) => bs.filter(b => b.width).map(b => ({ x1: b.x, z1: b.z, x2: b.x + b.width! - 1, z2: b.z + b.length! - 1 })));
  for (const leg of s.yard!.legs) {
    t.true(checkLeg(own, from, leg).ok);
    for (const z of zones) t.false(footMeets(from, leg, z), `${JSON.stringify(from)} -> ${JSON.stringify(leg)} meets ${JSON.stringify(z)}`);
    from = { ...leg, level: 63 };
  }
  // no panel with ground outside it (hills all round): none, and why
  const hills = liveYard();
  for (let z = 2151; z <= 2195; z++) for (let x = -620; x <= -568; x++) for (const y of [63, 64, 65]) hills.set(x, y, z, 'dirt');
  for (let x = -620; x <= -500; x++) for (let z = 2218; z <= 2240; z++) for (const y of [63, 64, 65]) hills.set(x, y, z, 'dirt');
  for (let x = -532; x <= -500; x++) for (let z = 2135; z <= 2240; z++) for (const y of [64, 65]) hills.set(x, y, z, 'dirt');
  t.deepEqual(yardEntry(hills, world, { x: WEST_BELL.x, z: WEST_BELL.z }), { why: 'no panel of the yard\'s fence with ground outside it the boat can come in from' });
});

test('the way in across the yard, the fence\'s panels in turn: one with what stands on a post not read is passed over (it could not be put back), one by a cell of the bot\'s own cane just outside the fence too, and the searches go on to the sixth', (t) => {
  const toward = { x: WEST_BELL.x, z: WEST_BELL.z };
  // (the top of the west panel's middle post not read: on to the first panel clear of that post)
  const g = liveYard();
  g.set(-565, 64, 2152, null as unknown as string);
  const e = yardEntry(g, liveZones(hallWorld()), toward);
  if ('why' in e) return t.fail(e.why);
  t.deepEqual(e.fence, [2153, 2154, 2155].map(z => ({ x: -565, y: 63, z })));
  // (a cell of the cane patch 2 outside the south fence, by the panel a village to the south would take: past it)
  const caned = liveZones(hallWorld());
  caned.zones!.cane!.push({ x: -553, y: 63, z: 2217 });
  const s = yardEntry(liveYard(), caned, { x: -549, z: 2600 });
  if ('why' in s) return t.fail(s.why);
  t.is(s.yard!.side, 'south');
  t.notDeepEqual(s.fence.map(p => p.x), [-554, -553, -552]);
  t.false(footMeets(s.out, s.yard!.through, { x1: -553, z1: 2217, x2: -553, z2: 2217 }), JSON.stringify(s.fence));
  // (a pocket of the yard's builds round the inside of the west fence's gap: the five panels searched first find no way
  // out of it, the sixth, past its end, does)
  const pocket = liveZones(hallWorld());
  pocket.zones!.trees!.push({ x: -559, y: 62, z: 2149, width: 1, length: 10 }, { x: -564, y: 62, z: 2149, width: 5, length: 1 }, { x: -564, y: 62, z: 2158, width: 5, length: 1 });
  const p = yardEntry(liveYard(), pocket, toward);
  if ('why' in p) return t.fail(p.why);
  t.deepEqual(p.fence, [2159, 2160, 2161].map(z => ({ x: -565, y: 63, z })));
  const five = yardEntry(liveYard(), pocket, toward, 5);
  t.true('why' in five && /^no way across the yard \(from the west fence at \(-565, 63, 2152\): /.test(five.why), JSON.stringify(five));
});

test('a boat climbs nothing (26.3: AbstractBoat keeps Entity.maxUpStep\'s 0): across the yard a path two wide or more is a wall (its box would sink the 1/16 onto it and never climb off), one wide is crossed on the grass either side', (t) => {
  const world = { yard: { x1: 0, z1: -20, x2: 40, z2: 20, y: 62 }, zones: {} } as unknown as WorldMemory;
  const path = (xs: number[], zs = [-19, 19]) => {
    const cells: Record<string, string> = {};
    for (const x of xs) for (let z = zs[0]; z <= zs[1]; z++) cells[`${x},62,${z}`] = 'dirt_path';
    return keepOff(flat(cells, { x1: -1, z1: -21, x2: 41, z2: 21 }), world);
  };
  const across = (g: Pick<Ground, 'cell'>) => checkLeg(g, { x: 5.5, z: 0.5, level: 63 }, { x: 35.5, z: 0.5 });
  t.like(across(path([20])), { ok: true, level: 63 });
  const two = across(path([20, 21]));
  t.false(two.ok);
  if (!two.ok) t.regex(two.why, /^a floor under a block high, two wide or more/);
  t.like(across(path([20, 21, 22, 23])), { ok: false });
  // (the boat's own box on it, as the settle has it: the grass beside a path a step up)
  t.like(settle(y => cellOf(y === 62 ? 'grass_block' : 'air'), 62 + 15 / 16), { blocked: 'a step up (a boat climbs nothing)' });
  // a way round the end of a wide one
  const r = planRoute(path([20, 21, 22], [-19, 10]), { x: 5.5, z: 0.5, level: 63 }, { x: 35.5, z: 0.5 }, { bounds: { x1: 1, z1: -19, x2: 39, z2: 19 }, within: 1, corners: false });
  t.true(r.ok, JSON.stringify(r));
  if (r.ok) t.true(r.legs.some(l => l.z > 11), JSON.stringify(r.legs));
});

/** The live village's shape moved west of home, its bell at (-693, 63, 2262) (164 out, as the live one): free, as the north one is. */
const WEST = { dx: -137, dz: 382 };
function westFree(land: Land, by = WEST): void {
  const move = (p: Pos): Pos => ({ x: p.x + by.dx, y: p.y, z: p.z + by.dz });
  land.villagers = VILLAGERS().map(v => ({ ...v, position: move(v.position) }));
  land.marks = MARKS().map(m => ({ name: m.name, at: move(m.at) }));
  land.zones = VILLAGE_ZONES().map(z => ({ ...z, x1: z.x1 + by.dx, x2: z.x2 + by.dx, z1: z.z1 + by.dz, z2: z.z2 + by.dz }));
}
/**
 * The live homestead's ground round the yard in the stand-in world: the hill north of the north fence from z 2116 (3
 * high), the hill along the west fence from x -568 to -590 but for the gap at z 2151-2163 (the ground west of it flat),
 * and the yard's builds on the way across it standing: the portal's frame, the cow pen's fence, the workshop's walls.
 */
function liveLand(land: Land): void {
  const solid = (x: number, z: number, b = 'dirt', ys = [63, 64, 65]) => { for (const y of ys) land.blocks.set(`${x},${y},${z}`, b); };
  for (let x = -600; x <= -500; x++) for (let z = 2095; z <= 2116; z++) solid(x, z);
  for (let x = -590; x <= -568; x++) for (let z = 2095; z <= 2240; z++) if (z < 2151 || z > 2163) solid(x, z);
  for (let x = PORTAL.x1; x <= PORTAL.x2; x++) solid(x, 2147, 'obsidian', [63, 64, 65, 66, 67]);
  for (let x = COW_PEN.x1; x <= COW_PEN.x2; x++) for (let z = COW_PEN.z1; z <= COW_PEN.z2; z++) if (x === COW_PEN.x1 || x === COW_PEN.x2 || z === COW_PEN.z1 || z === COW_PEN.z2) solid(x, z, 'oak_fence', [63]);
  for (let x = WORKSHOP.x1; x <= WORKSHOP.x2; x++) for (let z = WORKSHOP.z1; z <= WORKSHOP.z2; z++) if (x === WORKSHOP.x1 || x === WORKSHOP.x2 || z === WORKSHOP.z1 || z === WORKSHOP.z2) solid(x, z, 'oak_planks');
  // a torch on the post the boat comes in by
  land.blocks.set('-565,64,2152', 'torch');
}
const WEST_POSTS: Pos[] = [2151, 2152, 2153].map(z => ({ x: -565, y: 63, z }));
const WEST_TORCH: Pos = { x: -565, y: 64, z: 2152 };
const SOUTH_PANEL: Pos[] = [-555, -554, -553].flatMap(x => [63, 64].map(y => ({ x, y, z: 2134 })));

test('the move with the way in across the yard (Nov 15: the hall\'s panel faces the hill): home by the west fence\'s gap in the hill, its panel dug from the boat, across the yard round the portal, into the hall by a panel beside its gate; nothing else dug, all put back', async (t) => {
  const world = liveZones(hallWorld({ villages: { sites: [{ x: -693, y: 63, z: 2262, villagers: 6, seenAt: T0 - 60 * MINUTE }], players: [] } }));
  const land = new Land(world, { houses: [{ x1: -712, z1: 2250, x2: -703, z2: 2258 }, { x1: -683, z1: 2264, x2: -675, z2: 2272 }] });
  westFree(land);
  liveLand(land);
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -693,2262] moved an unemployed villager from the village at (-693, 63, 2262) to the hall (1 in it now); back home');
  // the villager in the room, the boat its item again, everything as it stood
  // (of the two the judge allows, the nearer to the bot: 107)
  t.deepEqual(land.villagers.filter(e => inHall({ x: Math.floor(e.position.x), y: 63, z: Math.floor(e.position.z) })).map(e => e.id), [107]);
  t.is(land.boat, undefined);
  t.deepEqual([...WEST_POSTS, WEST_TORCH, ...SOUTH_PANEL].map(p => land.block(p.x, p.y, p.z)), [FENCE, FENCE, FENCE, 'torch', ...SOUTH_PANEL.map(() => 'oak_planks')]);
  t.deepEqual(asBuilt(land), BUILT, 'the built panel and the fence straight out from it never touched');
  t.is(peekVillages(world).open, undefined);
  t.is(peekVillages(world).boat, undefined);
  // dug: the west fence's panel (the torch before its post) and the hall's south panel, nothing else; the gate never opened
  t.deepEqual(land.log.filter(l => l.startsWith('dig ')), [
    'dig birch_fence (-565, 63, 2151) from the boat', 'dig torch (-565, 64, 2152) from the boat', 'dig birch_fence (-565, 63, 2152) from the boat', 'dig birch_fence (-565, 63, 2153) from the boat',
    ...SOUTH_PANEL.filter(p => p.y === 63).concat(SOUTH_PANEL.filter(p => p.y === 64)).map(p => `dig oak_planks ${fmt(p)} from the boat`)
  ]);
  t.is(land.block(HALL_GATE.x, HALL_GATE.y, HALL_GATE.z), 'oak_fence_gate[facing=south,open=false]');
  // the way: told, and driven: home to 2.5 out from the west fence, through it, across the yard, into the room
  const said = land.said.filter(l => l.startsWith('villagers: '));
  t.true(said.includes('villagers: the boat\'s way into the hall: straight out from its panel a wall at (-557, 65, 2115); in by the yard\'s west fence at (-565, 63, 2151)..(-565, 63, 2153) instead, ' +
    `across the yard in ${said.filter(l => /^villagers: across the yard/.test(l)).length} leg(s), into the hall by a panel in its south wall at (-555, 63, 2134)..(-553, 64, 2134)`), said.join(' | '));
  t.true(said.some(l => /^villagers: to the yard's fence at \(-568, 2152\): there in \d+ s$/.test(l)), said.join(' | '));
  t.true(said.some(l => /^villagers: through the fence into the yard at \(-562, 2152\): there in \d+ s$/.test(l)), said.join(' | '));
  t.true(said.some(l => /^villagers: across the yard to the hall at \(-554, 2137\): there in \d+ s$/.test(l)), said.join(' | '));
  t.true(said.includes('villagers: the hall\'s panel open at (-555, 63, 2134) (6 blocks)'));
  const drives = land.log.filter(l => l.startsWith('drive '));
  t.false(drives.some(l => /: /.test(l)), drives.join(' | '));
  // across the yard: never on the portal, the cow pen or the workshop (each leg from where the last ended)
  const pts = drives.map(l => /\((-?[\d.]+), (-?[\d.]+)\)/.exec(l)!).map(m => ({ x: Number(m[1]), z: Number(m[2]) }));
  const inYard = pts.slice(pts.findIndex(p => p.x === -561.5 && p.z === 2152.5));
  t.deepEqual(inYard[inYard.length - 1], { x: -553.5, z: 2130.5 });
  for (let i = 1; i < inYard.length - 1; i++) for (const z of [PORTAL, COW_PEN, WORKSHOP]) t.false(footMeets(inYard[i - 1], inYard[i], z), `${JSON.stringify(inYard[i - 1])} -> ${JSON.stringify(inYard[i])}`);
  // out of the hall by its gate, then the fence's panel back from inside the yard
  const done = land.log.filter(l => /^(place|goto .* careful|go-home)/.test(l));
  const outGate = done.indexOf('goto (-556, 63, 2136) careful');
  t.true(outGate > 0, done.join(' | '));
  t.deepEqual(done.slice(outGate).filter(l => l.startsWith('place')), [...WEST_POSTS.map(p => `place birch_fence ${fmt(p)}`), `place torch ${fmt(WEST_TORCH)}`]);
  t.true(done.slice(0, outGate).filter(l => l.startsWith('place')).every(l => SOUTH_PANEL.some(p => l === `place oak_planks ${fmt(p)}`)));
});

test('the way across the yard as the boat goes: stopped off its line, judged again from there and planned again; blocked by what the read missed, a give-up in the yard puts the fence back, the hall never opened, the moves off', async (t) => {
  const west = () => liveZones(hallWorld({ villages: { sites: [{ x: -693, y: 63, z: 2262, villagers: 6, seenAt: T0 - 60 * MINUTE }], players: [] } }));
  const houses = [{ x1: -712, z1: 2250, x2: -703, z2: 2258 }, { x1: -683, z1: 2264, x2: -675, z2: 2272 }];
  // the first leg across the yard ends 2 west of its stop, by the portal's corner: the leg on from there runs over the
  // portal, so the rest is planned again from where the boat is
  const w1 = west();
  const off = new Land(w1, { houses, offBy: { leg: 4, dx: -2 } });
  westFree(off);
  liveLand(off);
  t.is(await rung(off).run(off.ctx()), '[village -693,2262] moved an unemployed villager from the village at (-693, 63, 2262) to the hall (1 in it now); back home');
  const drives = off.log.filter(l => l.startsWith('drive '));
  t.deepEqual(drives.slice(drives.indexOf('drive to (-561.5, 2152.5)'), drives.indexOf('drive to (-561.5, 2152.5)') + 2), ['drive to (-561.5, 2152.5)', 'drive to (-554.5, 2150.5)']);
  t.true(drives.length > 6 && drives[drives.length - 2] === 'drive to (-553.5, 2137)', drives.join(' | '));
  t.deepEqual([...WEST_POSTS, WEST_TORCH, ...SOUTH_PANEL].map(p => off.block(p.x, p.y, p.z)), [FENCE, FENCE, FENCE, 'torch', ...SOUTH_PANEL.map(() => 'oak_planks')]);
  // a wall across the yard put up after the read (as the fence comes out): the drive meets it, a give-up in the yard
  const w2 = west();
  const land = new Land(w2, { houses });
  westFree(land);
  liveLand(land);
  const call = land.call.bind(land);
  land.call = (m, p = {}) => {
    if (m === 'dig.here' && Number(p.z) === 2153) for (let x = -556; x <= -534; x++) for (const y of [63, 64]) land.blocks.set(`${x},${y},2150`, 'cobblestone');
    return call(m, p);
  };
  const text = await rung(land).run(land.ctx());
  t.regex(text, /^\[village -693,2262\] gave up: the drive across the yard, leg 1 to \(-555, 2150\) stopped: a step up ahead \(a boat climbs nothing\) at \(-55\d, 63, 215\d\); the villager let out at \(-55\d, 63, 215\d\), the boat taken back up; put back 4 block\(s\); back home$/);
  t.deepEqual([...WEST_POSTS, WEST_TORCH].map(p => land.block(p.x, p.y, p.z)), [FENCE, FENCE, FENCE, 'torch']);
  t.deepEqual(SOUTH_PANEL.map(p => land.block(p.x, p.y, p.z)), SOUTH_PANEL.map(() => 'oak_planks'), 'the hall never opened');
  t.false(land.log.some(l => l.startsWith('dig oak_planks')));
  t.is(peekVillages(w2).open, undefined);
  t.is(land.boat, undefined);
  t.false(w2.villagerMoves, 'under way home: the moves wait for the lead');
});

/** The live village's shape west of home, free, and the live homestead's ground round the yard: the move comes in across the yard. */
function westMove(): { world: WorldMemory; land: Land } {
  const world = liveZones(hallWorld({ villages: { sites: [{ x: -693, y: 63, z: 2262, villagers: 6, seenAt: T0 - 60 * MINUTE }], players: [] } }));
  const land = new Land(world, { houses: [{ x1: -712, z1: 2250, x2: -703, z2: 2258 }, { x1: -683, z1: 2264, x2: -675, z2: 2272 }] });
  westFree(land);
  liveLand(land);
  return { world, land };
}

test('across the yard, the run\'s time is not given up on inside the fence (the villager let out there would be loose in the yard, by the bot\'s beds and doors): the hall a few legs on, it goes in', async (t) => {
  const { world, land } = westMove();
  // (the clock past the run's budget as the fence's last post comes out: a slow way home, its replans)
  const call = land.call.bind(land);
  land.call = (m, p = {}) => {
    const r = call(m, p);
    if (m === 'dig.here' && Number(p.x) === -565 && Number(p.y) === 63 && Number(p.z) === 2153) land.t += MOVE_BUDGET;
    return r;
  };
  const r = await villagersTask.run(land.ctx(), 'village -693,2262', MOVE_BUDGET, () => land.t);
  t.is(r.text, 'moved an unemployed villager from the village at (-693, 63, 2262) to the hall (1 in it now)');
  t.deepEqual(land.villagers.filter(e => inHall({ x: Math.floor(e.position.x), y: 63, z: Math.floor(e.position.z) })).map(e => e.id), [107]);
  t.deepEqual([...WEST_POSTS, WEST_TORCH, ...SOUTH_PANEL].map(p => land.block(p.x, p.y, p.z)), [FENCE, FENCE, FENCE, 'torch', ...SOUTH_PANEL.map(() => 'oak_planks')]);
  t.true(world.villagerMoves);
});

test('the time home counts the yard\'s part of a way in across it (through the fence and the legs across the yard): judged before a villager is taken', async (t) => {
  const { land } = westMove();
  // (as the judge says free, the run has 100 s left: the way home to the fence at the boat's pace is about that much)
  let jumped = false;
  const ctx = land.ctx({ progress: (text: string) => { land.said.push(text); if (!jumped && /is free to take from/.test(text)) { jumped = true; land.t = T0 + MOVE_BUDGET - 100_000; } } });
  const r = await villagersTask.run(ctx, 'village -693,2262', MOVE_BUDGET, () => land.t);
  const m = /^not enough of the run left to bring a villager home from \(-693, 63, 2262\) \(need (\d+) s, \d+ s left\)$/.exec(r.text);
  if (!m) return t.fail(r.text);
  // the least it can need, in straight lines from the villager taken (107) to the stop outside the west fence, through
  // it, and on to the stop before the hall's panel
  const least = homeMs({ x: -685.5, z: 2248.5 }, [{ x: -567.5, z: 2152.5 }, { x: -561.5, z: 2152.5 }, { x: -553.5, z: 2137 }]);
  t.true(Number(m[1]) * 1000 >= least - 500, `${m[1]} s, ${least} ms at least`);
  t.false(land.log.some(l => l.startsWith('boat down')));
});

test('the way in across the yard as the boat comes to the fence: stopped off its stop onto a cell of the bot\'s own (the cane patch reaches past the fence), its way through the fence judged with the yard\'s builds kept off, and given up before anything is dug', async (t) => {
  const { world, land } = westMove();
  world.zones!.cane!.push({ x: -571, y: 63, z: 2152 });
  // (the drive to the stop outside the west fence ends 3 short of it, on that cell)
  const call = land.call.bind(land);
  land.call = (m, p = {}) => {
    const to = p.to as { x: number; z: number } | undefined;
    if (m === 'vehicle.drive' && to?.x === -567.5 && to.z === 2152.5) land.opts.offBy = { leg: land.legs + 1, dx: -3 };
    return call(m, p);
  };
  const text = await rung(land).run(land.ctx());
  t.regex(text, /^\[village -693,2262\] gave up: the boat stopped where its way through the fence does not hold, at \(-571, 63, 2152\): the bot's own cane at \(-571, \d+, 2152\); the villager let out at \(-571, 63, 2152\), the boat taken back up; back home$/);
  t.false(land.log.some(l => l.startsWith('dig ')));
  t.deepEqual([...WEST_POSTS, WEST_TORCH].map(p => land.block(p.x, p.y, p.z)), [FENCE, FENCE, FENCE, 'torch']);
  t.is(peekVillages(world).open, undefined);
  t.false(world.villagerMoves, 'under way home: the moves wait for the lead');
});

test('across the yard the boat stops short of each turn as the bridge\'s drive does (there within its reach, then a glide on): every leg driven to within the least reach, the legs round the yard\'s builds hold from where it stops, into the hall', async (t) => {
  for (const coast of [0.15, 0.3]) {
    const { world, land } = westMove();
    land.opts.coast = coast;
    const r = await villagersTask.run(land.ctx(), 'village -693,2262', MOVE_BUDGET, () => land.t);
    t.is(r.text, 'moved an unemployed villager from the village at (-693, 63, 2262) to the hall (1 in it now)', `a glide of ${coast}`);
    t.deepEqual(land.villagers.filter(e => inHall({ x: Math.floor(e.position.x), y: 63, z: Math.floor(e.position.z) })).map(e => e.id), [107]);
    t.deepEqual([...WEST_POSTS, WEST_TORCH, ...SOUTH_PANEL].map(p => land.block(p.x, p.y, p.z)), [FENCE, FENCE, FENCE, 'torch', ...SOUTH_PANEL.map(() => 'oak_planks')]);
    t.true(world.villagerMoves);
  }
});

test('from the fence on, each drive gets the time its way takes, not what is left of the run: a long leg across the yard, the run\'s budget spent by the time the fence is open, is not timed out with the villager loose in the yard', async (t) => {
  // (the live village's shape south-west of home, its bell at (-600, 63, 2440): in by the south fence, the first leg
  // across the yard the length of it, past the 40 blocks a drive's least time (20 s) takes at the boat's pace)
  const SW = { dx: -44, dz: 560 };
  const world = liveZones(hallWorld({ villages: { sites: [{ x: -600, y: 63, z: 2440, villagers: 6, seenAt: T0 - HOUR }], players: [] } }));
  const land = new Land(world, { houses: [{ x1: -575 + SW.dx, z1: 1868 + SW.dz, x2: -566 + SW.dx, z2: 1876 + SW.dz }, { x1: -546 + SW.dx, z1: 1882 + SW.dz, x2: -538 + SW.dx, z2: 1890 + SW.dz }] });
  westFree(land, SW);
  liveLand(land);
  const drives: { to: { x: number; z: number }; ms: number }[] = [];
  const call = land.call.bind(land);
  land.call = (m, p = {}) => {
    // (the clock past the run's budget as the fence's first block comes out: a slow way home, its replans)
    if (m === 'dig.here' && !drives.some(d => d.ms < 0)) { land.t += MOVE_BUDGET; drives.push({ to: { x: 0, z: 0 }, ms: -1 }); }
    if (m === 'vehicle.drive') drives.push({ to: p.to as { x: number; z: number }, ms: Number(p.timeoutMs) });
    return call(m, p);
  };
  const r = await villagersTask.run(land.ctx(), 'village -600,2440', MOVE_BUDGET, () => land.t);
  t.is(r.text, 'moved an unemployed villager from the village at (-600, 63, 2440) to the hall (1 in it now)');
  t.deepEqual(land.villagers.filter(e => inHall({ x: Math.floor(e.position.x), y: 63, z: Math.floor(e.position.z) })).map(e => e.id), [107]);
  t.true(world.villagerMoves);
  // the drives inside the fence: one of them over 40 blocks, each given its way's time
  const inside = drives.slice(drives.findIndex(d => d.ms < 0) + 2);
  let at = drives[drives.findIndex(d => d.ms < 0) + 1].to;
  let longest = 0;
  for (const d of inside) {
    const dist = horiz(at, d.to);
    longest = Math.max(longest, dist);
    t.true(d.ms >= dist / BOAT_PACE * 1000, `${JSON.stringify(d)} from ${JSON.stringify(at)}`);
    at = d.to;
  }
  t.true(longest > 40, String(longest));
});

test('a gate in the fence straight out from the hall\'s panel: the way in across the yard, as for a hill there; the gate never touched', async (t) => {
  const { world, land } = westMove();
  // (the north gate in line with the panel, where the torch's post stood)
  const GATE = 'birch_fence_gate[facing=north,in_wall=false,open=false,powered=false]';
  world.zones!['fence:gate'] = world.zones!['fence:gate']!.map(g => (g.x === NORTH_GATE.x && g.z === NORTH_GATE.z ? { x: -556, y: 63, z: 2119 } : g));
  land.blocks.set('-556,63,2119', GATE);
  land.blocks.set('-556,64,2119', 'air');
  land.blocks.set(`${NORTH_GATE.x},63,${NORTH_GATE.z}`, FENCE);
  const r = await villagersTask.run(land.ctx(), 'village -693,2262', MOVE_BUDGET, () => land.t);
  t.is(r.text, 'moved an unemployed villager from the village at (-693, 63, 2262) to the hall (1 in it now)');
  t.true(land.said.some(l => l.startsWith('villagers: the boat\'s way into the hall: straight out from its panel the fence there holds a gate or a corner; in by the yard\'s west fence at (-565, 63, 2151)..(-565, 63, 2153) instead')),
    land.said.filter(l => /way into the hall/.test(l)).join(' | '));
  t.is(land.block(-556, 63, 2119), GATE);
  t.deepEqual(land.villagers.filter(e => inHall({ x: Math.floor(e.position.x), y: 63, z: Math.floor(e.position.z) })).map(e => e.id), [107]);
});

// ------------------------------------------------------------------------------------------------ the user's decisions of Nov 17 (D1)

/** The west village's hay stable as the bridge's zone, read whole (live, nearby-builds: hay x24, planks x23, wall torches x8, fences x6). */
const STABLE = (over: Partial<LookZone> = {}): LookZone => ({
  x1: -703, y1: 64, z1: 2315, x2: -670, y2: 75, z2: 2344, markers: 61, surface: true, sample: 'hay_block',
  all: { hay_block: 24, oak_planks: 23, wall_torch: 8, oak_fence: 6 }, ...over
});

/** The west village as a look round it sees it (Nov 15): its bell, beds, job sites, its villagers in three knots, its stable. */
function westLook(over: Partial<VillageLook> = {}): VillageLook {
  const land = new Land(hallWorld(), { houses: [] });
  const vs = westVillage(land);
  return {
    bells: land.marks.filter(m => m.name === 'bell').map(m => m.at), beds: land.marks.filter(m => /_bed$/.test(m.name)).map(m => m.at),
    jobs: land.marks.filter(m => /lectern|composter/.test(m.name)).map(m => ({ name: m.name, at: m.at })),
    seen: vs, penned: new Set(), kinds: { oak_planks: 200, white_bed: 3, bell: 1, lectern: 1, composter: 1, hay_block: 24, wall_torch: 8, oak_fence: 6 },
    looked: { chunks: 30, of: 30 }, zones: [STABLE()], players: [], spawn: { x: SPAWN.x, z: SPAWN.z }, ...over
  };
}

test('D1 the village\'s own outbuildings: the live hay stable (in its area, by its beds, of hay, planks, wall torches and fences) is the village\'s own, not another build; read short, it is another build (noted since Nov 20, the village free)', (t) => {
  const v = judgeVillage(westLook());
  t.is(v.kind, 'free', v.why);
  if (v.kind !== 'free') return;
  t.is(v.why, '5 villagers, 3 unemployed adult(s) to take (2 employed)');
  t.is(v.own.length, 1, 'the stable is its own: the way home is not kept 16 off it');
  t.like(v.own[0], { x1: -703, z1: 2315, sample: 'hay_block' });
  // (not read whole: no read, a read short of its markers (chunks unloaded since), nothing read: another build, noted;
  // the way home keeps 16 off it)
  const live = 'another build 0 from it (x -703..-670, z 2315..2344, hay_block)';
  for (const z of [STABLE({ all: undefined }), STABLE({ all: { hay_block: 24, oak_planks: 23 } }), STABLE({ all: {} })]) t.like(judgeVillage(westLook({ zones: [z] })), { kind: 'free', notes: [live], own: [] });
  // every block of it one a natural village is built of
  for (const n of ['hay_block', 'oak_planks', 'wall_torch', 'oak_fence', 'lantern', 'farmland', 'wheat', 'carrots', 'white_wool', 'glass_pane', 'white_bed', 'composter']) t.true(VILLAGE_MADE.has(n), n);
  for (const n of ['chest', 'spruce_wall_sign', 'white_wall_banner', 'brown_wall_banner', 'birch_planks', 'dark_oak_planks', 'hopper', 'rail', 'white_concrete']) t.false(VILLAGE_MADE.has(n), n);
});

test('D1 a player\'s build by a village stays another build (noted since Nov 20): a hay barn beside it (off its area, or 40 from its marks), the stable with a chest, a sign, a banner or a player\'s block in it; and every other rule as it is now', (t) => {
  const word = (look: VillageLook) => { const v = judgeVillage(look); return v.kind === 'theirs' ? `theirs ${v.rule}: ${v.why}` : v.kind === 'free' ? `free: ${v.notes.join('; ')}` : `${v.kind}: ${v.why}`; };
  // a player's hay barn just beside the village: 34 off its area (z 2326), of the same hay and planks
  t.is(word(westLook({ zones: [STABLE({ z1: 2360, z2: 2380 })] })), 'free: another build 34 from it (x -703..-670, z 2360..2380, hay_block)');
  // meeting its area but 40 and more from every mark of its own (a barn at its edge, east of the knot of farmers)
  t.is(word(westLook({ zones: [STABLE({ x1: -652, x2: -640, z1: 2240, z2: 2250 })] })), 'free: another build 0 from it (x -652..-640, z 2240..2250, hay_block)');
  // the stable itself with something only a player (or a looted village house) has in it
  for (const [n, c] of [['chest', 1], ['spruce_wall_sign', 1], ['white_wall_banner', 1], ['birch_planks', 4], ['hopper', 1]] as const) {
    t.is(word(westLook({ zones: [STABLE({ markers: 61 + c, all: { ...STABLE().all, [n]: c } })] })), 'free: another build 0 from it (x -703..-670, z 2315..2344, hay_block)', n);
  }
  // a mineshaft under it is the world's, a player's house beside the live village another build, noted
  const house: Zone = { x1: -529, y1: 59, z1: 1880, x2: -520, y2: 70, z2: 1892, markers: 40, surface: true, sample: 'cobblestone' };
  t.is(word(freeLook({ zones: [...VILLAGE_ZONES(), house] })), 'free: another build 0 from it (x -529..-520, z 1880..1892, cobblestone)');
  const named = VILLAGERS();
  named[3] = { ...named[3], named: true, customName: 'Bob' };
  t.is(word(freeLook({ seen: named })), 'free: a villager (-546, 63, 1872) is named (Bob) (not taken)');
  named[5] = { ...named[5], leashed: true };
  t.is(word(freeLook({ seen: named })), 'theirs villager: 2 villagers used by a player: (-546, 63, 1872) is named (Bob), (-562, 63, 1884) is on a lead');
  t.is(word(freeLook({ kinds: { ...freeLook().kinds, oak_sign: 1 } })), 'free: a player\'s marks within 16: oak_sign x1');
  t.is(word(freeLook({ players: [{ x: -560, z: 1900, at: T0 }] })), 'free: a player was seen 0 from it, at (-560, 1900) (14:00)');
  t.is(word(freeLook({ spawn: { x: -556, z: 2100 } })), 'theirs spawn: within 256 of the world spawn (186 off)');
});

test('the user\'s word of Nov 17 (again, told one by a village is likely a raid trophy: "Ignore it"): an ominous banner in a village or within 16 of it is no player\'s mark, not even noted; a plain banner of any colour, or a player\'s beside an ominous one, is noted (since Nov 20 no mark makes a village someone\'s)', (t) => {
  const banner = { ...freeLook().kinds, white_wall_banner: 1 };
  const notes = (look: VillageLook) => { const v = judgeVillage(look); return v.kind === 'free' ? v.notes : [`${v.kind}: ${v.why}`]; };
  // ominous: no mark, the village free as without it
  const v = judgeVillage(freeLook({ kinds: banner, ominous: { white_wall_banner: 1 } }));
  t.is(v.kind, 'free', v.why);
  t.is(v.why, judgeVillage(freeLook()).why);
  t.is(judgeVillage(freeLook({ kinds: { ...freeLook().kinds, white_banner: 2 }, ominous: { white_banner: 2 } })).kind, 'free', 'standing ones too');
  // ... and judged on its other rules all the same: two named villagers, a sign by it, a player seen
  const named = VILLAGERS().map((e, i) => (i > 1 ? e : { ...e, named: true }));
  t.like(judgeVillage(freeLook({ kinds: banner, ominous: { white_wall_banner: 1 }, seen: named })), { kind: 'theirs', rule: 'villager' });
  t.deepEqual(notes(freeLook({ kinds: { ...banner, oak_sign: 1 }, ominous: { white_wall_banner: 1 } })), ['a player\'s marks within 16: oak_sign x1']);
  t.deepEqual(notes(freeLook({ kinds: banner, ominous: { white_wall_banner: 1 }, players: [{ x: -560, z: 1900, at: T0 }] })), ['a player was seen 0 from it, at (-560, 1900) (14:00)']);
  // a plain white banner (the bridge said: none ominous), or one of another colour: noted
  t.deepEqual(notes(freeLook({ kinds: banner, ominous: {} })), ['a player\'s marks within 16: white_wall_banner x1']);
  t.deepEqual(notes(freeLook({ kinds: { ...freeLook().kinds, red_banner: 1 }, ominous: {} })), ['a player\'s marks within 16: red_banner x1']);
  // a player's banner beside an ominous one: the player's is a mark (the ominous one not counted)
  t.deepEqual(notes(freeLook({ kinds: { ...banner, white_wall_banner: 2 }, ominous: { white_wall_banner: 1 } })), ['a player\'s marks within 16: white_wall_banner x1']);
  t.deepEqual(notes(freeLook({ kinds: { ...banner, brown_banner: 1 }, ominous: { white_wall_banner: 1 } })), ['a player\'s marks within 16: brown_banner x1']);
  // an older jar's look (no word of ominous ones): every banner a mark, as before
  t.deepEqual(notes(freeLook({ kinds: banner })), ['a player\'s marks within 16: white_wall_banner x1']);
  t.deepEqual(notes(freeLook({ kinds: { ...banner, oak_sign: 1 } })), ['a player\'s marks within 16: white_wall_banner x1, oak_sign x1']);
  // (the pillager outposts' rules as they were: one by the village is another build, noted; one 60 off danger kept 48 off)
  t.deepEqual(notes(freeLook({ kinds: banner, ominous: { white_wall_banner: 1 }, zones: [...VILLAGE_ZONES(), OUTPOST()] })), ['another build 17 from it (x -500..-490, z 1860..1870, dark_oak_planks)']);
  const far = judgeVillage(freeLook({ kinds: banner, ominous: { white_wall_banner: 1 }, zones: [...VILLAGE_ZONES(), OUTPOST({ x1: -457, x2: -447 })] }));
  t.like(far, { kind: 'free', outposts: [{ x1: -457 }] });
});

/** A pillager outpost as the bridge's zone, read whole: its watchtower's dark oak, cobblestone walls, its loot chest, four ominous banners. */
const OUTPOST = (over: Partial<LookZone> = {}): LookZone => ({
  x1: -500, y1: 60, z1: 1860, x2: -490, y2: 90, z2: 1870, markers: 70, surface: true, sample: 'dark_oak_planks',
  all: { dark_oak_planks: 40, cobblestone_wall: 12, dark_oak_fence: 8, white_wall_banner: 4, chest: 1, torch: 3, birch_planks: 2 }, ominous: 4, ...over
});

test('D1 a pillager outpost by a village is danger, not someone\'s: its distance said, the way home kept 48 off it; one within 48 of it is another build (a trophy banner: the game keeps outposts 10 chunks off a village), noted; so is a raid farm on one; illagers by the village make it wait', (t) => {
  // 60 off the live village's area (x2 -517): no other build within 48, the village free, the outpost listed for the way home
  const FAR = { x1: -457, x2: -447 };
  const v = judgeVillage(freeLook({ zones: [...VILLAGE_ZONES(), OUTPOST(FAR)] }));
  t.is(v.kind, 'free', v.why);
  if (v.kind !== 'free') return;
  t.is(v.outposts.length, 1);
  t.false(v.own.some(z => z.sample === 'dark_oak_planks'), 'not the village\'s own: the way home keeps off it');
  t.is(v.why, '7 villagers, 2 unemployed adult(s) to take (2 employed, 1 babies, 1 nitwits, 1 by a job site); a pillager outpost 60 from it (x -457..-447, z 1860..1870): kept 48 off');
  t.true(60 >= ZONES_NEAR && 60 < ZONES_NEAR + OUTPOST_CLEAR, 'within what the look reads whole');
  // 17 off it (no outpost the game would put there: a player's with a raid captain's banner): another build, noted
  const built = (look: VillageLook) => { const w = judgeVillage(look); return w.kind === 'free' && w.notes.some(n => /^another build 17 from it/.test(n)); };
  // (danger all the same: no villager within 48 of it taken)
  const near17 = judgeVillage(freeLook({ zones: [...VILLAGE_ZONES(), OUTPOST()] }));
  t.like(near17, { kind: 'free', notes: ['another build 17 from it (x -500..-490, z 1860..1870, dark_oak_planks)'] });
  if (near17.kind === 'free') t.is(near17.outposts.length, 1);
  // a dark oak shed with two chests, a crafting table, torches and a trophy ominous banner, 17 off: another build, as any there
  const shed = OUTPOST({ markers: 9, sample: 'torch', all: { chest: 2, crafting_table: 1, torch: 4, dark_oak_planks: 1, white_wall_banner: 1 }, ominous: 1 });
  t.true(outpostMade(shed), 'of outpost blocks alone, with an ominous banner');
  t.true(built(freeLook({ zones: [...VILLAGE_ZONES(), shed] })));
  // a raid farm built on one (a hopper, rails), or a player's banner beside the ominous ones: another build
  t.true(built(freeLook({ zones: [...VILLAGE_ZONES(), OUTPOST({ markers: 74, all: { ...OUTPOST().all, hopper: 2, rail: 2 } })] })));
  t.true(built(freeLook({ zones: [...VILLAGE_ZONES(), OUTPOST({ markers: 71, all: { ...OUTPOST().all, white_wall_banner: 5 } })] })));
  // no ominous banner read in it: another build
  t.true(built(freeLook({ zones: [...VILLAGE_ZONES(), OUTPOST({ ominous: undefined })] })));
  // a pillager by the village: it waits (danger now); one 100 off it is no matter
  const pillager: Seen = { id: 300, name: 'pillager', position: { x: -505.5, y: 63, z: 1880.5 } };
  t.like(judgeVillage(freeLook({ seen: [...VILLAGERS(), pillager] })), { kind: 'wait', why: '1 illager(s) about (a pillager at (-506, 63, 1880)): no move by pillagers' });
  t.is(judgeVillage(freeLook({ seen: [...VILLAGERS(), { ...pillager, position: { x: -417.5, y: 63, z: 1880.5 } }] })).kind, 'free');
  // the rules of someone's come first: two named villagers with a pillager by is someone's
  const named = VILLAGERS().map((e, i) => (i > 1 ? e : { ...e, named: true }));
  t.is(judgeVillage(freeLook({ seen: [...named, pillager] })).kind, 'theirs');
});

test('judged again (Nov 20): every word of someone\'s an older judge gave for another build, a player\'s marker or banner, a player seen or a villager penned in is looked at again, once; one for the spawn or a villager named, riding, on a lead or traded with stays for good, as does every word of today\'s judge', (t) => {
  const theirs = (why: string, more: Partial<NonNullable<VillageSite['judged']>> = {}): Pick<VillageSite, 'judged'> => ({ judged: { at: T0, kind: 'theirs', why, ...more } });
  t.is(JUDGE_V, 4);
  t.true(rejudge(theirs('another build 0 from it (x -703..-670, z 2315..2344, hay_block)')), 'the west village (Nov 15)');
  t.true(rejudge(theirs('another build 0 from it (x -703..-670, z 2315..2344, hay_block)', { rule: 'build', v: 3 })));
  t.true(rejudge(theirs('what only a player puts down in it or within 16: white_wall_banner x1')), 'the north-west one (Nov 15)');
  t.true(rejudge(theirs('what only a player puts down in it or within 16: white_wall_banner x1', { rule: 'banner', v: 3 })), 'live: the north-west one (-748, 1874)');
  t.true(rejudge(theirs('what only a player puts down in it or within 16: white_wall_banner x1, brown_banner x2')));
  t.true(rejudge(theirs('what only a player puts down in it or within 16: oak_sign x1', { rule: 'marker', v: 3 })));
  t.true(rejudge(theirs('whatever it said', { rule: 'banner' })));
  t.true(rejudge(theirs('whatever it said', { rule: 'build' })));
  t.true(rejudge(theirs('a player was seen 20 from it, at (-560, 63, 1810) (13:00)')));
  t.true(rejudge(theirs('a player came by at (-560, 63, 1810) as the bot was about to take a villager', { rule: 'player', v: 3 })));
  t.true(rejudge(theirs('a villager (-699, 77, 2245) is penned in (it can walk to fewer than 24 cells)', { rule: 'villager', v: 3 })), 'live: the west village (-693, 2262), Nov 20');
  t.true(rejudge(theirs('a villager (-699, 77, 2245) is penned in (it can walk to fewer than 24 cells)')));
  t.false(rejudge(theirs('within 256 of the world spawn (100 off)')));
  t.false(rejudge(theirs('within 256 of the world spawn (100 off)', { rule: 'spawn', v: 3 })));
  t.false(rejudge(theirs('a villager (-546, 63, 1872) is named (Bob)')));
  t.false(rejudge(theirs('a villager (-546, 63, 1872) is named (Bob)', { rule: 'villager', v: 3 })));
  t.false(rejudge(theirs('a villager (-567, 63, 1878) is at level 2: a player trades here', { rule: 'villager', v: 3 })));
  t.false(rejudge(theirs('2 villagers used by a player: (-557, 63, 1890) is named, (-546, 63, 1872) is named', { rule: 'villager', v: JUDGE_V })));
  t.false(rejudge(theirs('another build 0 from it (x -703..-670, z 2315..2344, hay_block)', { rule: 'build', v: JUDGE_V })), 'judged by today\'s judge (none such now): for good');
  t.false(rejudge({ judged: { at: T0, kind: 'wait', why: 'another build' } }));
  t.false(rejudge({}));
  t.true(rejudge({ judged: { at: T0, kind: 'theirs', rule: 'banner' } as unknown as VillageSite['judged'] }), 'a banner word with no why (a damaged brain.json): no throw');
  t.false(rejudge({ judged: { at: T0, kind: 'theirs', rule: 'villager' } as unknown as VillageSite['judged'] }), 'a villager word with no why: no throw, kept');
  // the gate lets it through for a look, a word for good does not
  const site: VillageSite = { x: -693, y: 63, z: 2262, seenAt: T0, ...theirs('another build 0 from it (x -703..-670, z 2315..2344, hay_block)') };
  t.true(siteOpen(site, HOME, T0));
  t.true(siteOpen({ ...site, ...theirs('a player was seen 20 from it') }, HOME, T0));
  t.false(siteOpen({ ...site, ...theirs('within 256 of the world spawn (100 off)', { rule: 'spawn', v: JUDGE_V }) }, HOME, T0));
  // a player seen by it no longer makes it someone's: the word to be judged again stays so
  const world = hallWorld({ villages: { sites: [{ ...site }], players: [] } });
  noteSeen(world, [{ id: 9, name: 'player', position: { x: -690, y: 63, z: 2300 } }], T0 + MINUTE);
  t.like(peekVillages(world).sites[0].judged, { kind: 'theirs', why: 'another build 0 from it (x -703..-670, z 2315..2344, hay_block)' });
  t.true(rejudge(peekVillages(world).sites[0]));
  // two sites of one village, the newer word to be judged again, the older a spawn's: one site, the spawn's word kept
  const w2 = hallWorld({
    villages: {
      sites: [{ x: -693, y: 63, z: 2262, seenAt: T0, ...theirs('another build 0 from it (x -703..-670, z 2315..2344, hay_block)') },
        { x: -700, y: 63, z: 2301, seenAt: T0 - HOUR, judged: { at: T0 - HOUR, kind: 'theirs', why: 'within 256 of the world spawn (200 off)', rule: 'spawn', v: JUDGE_V } }],
      players: []
    }
  });
  t.deepEqual(peekVillages(w2).sites.map(s => s.judged?.why), ['within 256 of the world spawn (200 off)']);
  t.deepEqual(villagersTask.variants(snap(KIT()), w2).map(v => v.id), SEARCHES);
});

/** The live west village in the stand-in world, its stable standing as the scans' markers (61 of them) in the zone's box. */
function westStable(land: Land, extra: { name: string; n: number }[] = []): void {
  westVillage(land);
  const z = STABLE();
  let i = 0;
  for (const [name, n] of [...Object.entries(z.all!), ...extra.map(e => [e.name, e.n] as const)]) {
    for (let k = 0; k < n; k++, i++) land.marks.push({ name, at: { x: z.x1 + 4 + (i % 26), y: 66, z: z.z1 + 4 + Math.floor(i / 26) } });
  }
  // (the bridge's zone: its box and its count; what it is built of is read by the look)
  land.zones = [{ x1: z.x1, y1: z.y1, z1: z.z1, x2: z.x2, y2: z.y2, z2: z.z2, surface: true, sample: z.sample, markers: 61 + extra.reduce((a, e) => a + e.n, 0) }];
}

test('D1 judged again live: the west village (someone\'s on Nov 15 by its hay stable) is looked at and judged free, nothing touched, the move offered next; with a chest in the stable it is another build, noted (Nov 20), free all the same', async (t) => {
  const world = hallWorld({ villages: { sites: [], players: [] } });
  world.zones!['fence:gate']!.push({ x: -565, y: 63, z: 2183 });
  world.villages!.sites.push({ x: -693, y: 63, z: 2262, villagers: 11, bells: 1, beds: 3, jobs: 2, seenAt: T0 - HOUR,
    judged: { at: T0 - HOUR, kind: 'theirs', why: 'another build 0 from it (x -703..-670, z 2315..2344, hay_block)' }, area: { x1: -776, z1: 2221, x2: -635, z2: 2326 } });
  const land = new Land(world, { houses: [] });
  westStable(land);
  // offered first, as a look (no boat, no move): the day it needs a walk's there and back and the look
  const vs = villagersTask.variants(snap(KIT(), { now: land.t }), world);
  const dist = Math.hypot(-693 - HOME.x, 2262 - HOME.z);
  t.like(vs[0], { id: 'village -693,2262', first: true, needMs: lookNeedMs(dist) });
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -693,2262] judged the village at (-693, 63, 2262) again (was someone\'s: another build 0 from it (x -703..-670, z 2315..2344, hay_block)): '
    + 'free (5 villagers, 3 unemployed adult(s) to take (2 employed)): the move next run; back home');
  t.deepEqual(acted(land), [], 'no villager taken, nothing dug');
  t.false(land.items.some(i => i.name === 'oak_boat' && i.count !== 1), 'the boat not used');
  const site = peekVillages(world).sites.find(s => s.x === -693)!;
  t.like(site.judged, { kind: 'free', v: JUDGE_V });
  t.false(rejudge(site));
  // the move offered next (after the look's mark), its day the move's
  const later = snap(KIT(), { now: land.t + 2 * HOUR });
  t.like(villagersTask.variants(later, world)[0], { id: 'village -693,2262', first: true, needMs: moveNeedMs(dist) });

  // the same with a chest in the stable: another build, noted, the village free (Nov 20), the move offered next
  const w2 = hallWorld({ villages: { sites: [], players: [] } });
  w2.zones!['fence:gate']!.push({ x: -565, y: 63, z: 2183 });
  w2.villages!.sites.push({ x: -693, y: 63, z: 2262, seenAt: T0 - HOUR, judged: { at: T0 - HOUR, kind: 'theirs', why: 'another build 0 from it (x -703..-670, z 2315..2344, hay_block)' } });
  const l2 = new Land(w2, { houses: [] });
  westStable(l2, [{ name: 'chest', n: 1 }]);
  const t2 = await rung(l2).run(l2.ctx());
  t.regex(t2, /^\[village -693,2262\] judged the village at \(-693, 63, 2262\) again \(was someone's: another build .*\): free \(5 villagers, 3 unemployed adult\(s\) to take \(2 employed\); noted: another build 0 from it \(x -703\.\.-670, z 2315\.\.2344, hay_block\)\): the move next run; back home$/);
  t.deepEqual(acted(l2), []);
  t.like(peekVillages(w2).sites[0].judged, { kind: 'free', v: JUDGE_V });
  t.is(villagersTask.variants(snap(KIT(), { now: l2.t + 2 * HOUR }), w2)[0].id, 'village -693,2262');
});

test('the user\'s word of Nov 17, live: the north-west village (someone\'s on Nov 15 for its one white wall banner, every banner a mark then) is offered for a look only and judged again: its banner ominous, free, nothing touched, the move the next run\'s; a plain one, noted and free all the same (Nov 20)', async (t) => {
  const NW = { at: T0 - HOUR, kind: 'theirs' as const, why: 'what only a player puts down in it or within 16: white_wall_banner x1' };
  const banner = { name: 'white_wall_banner', at: { x: -690, y: 66, z: 2300 } };
  const world = hallWorld({ villages: { sites: [], players: [] } });
  world.zones!['fence:gate']!.push({ x: -565, y: 63, z: 2183 });
  world.villages!.sites.push({ x: -693, y: 63, z: 2262, villagers: 11, bells: 1, beds: 3, jobs: 2, seenAt: T0 - HOUR, judged: { ...NW }, area: { x1: -776, z1: 2221, x2: -635, z2: 2326 } });
  const land = new Land(world, { houses: [] });
  westStable(land);
  land.marks.push({ ...banner, ominous: true });
  // offered first, as a look (no boat, no move): the day it needs a walk's there and back and the look
  const dist = Math.hypot(-693 - HOME.x, 2262 - HOME.z);
  t.like(villagersTask.variants(snap(KIT(), { now: land.t }), world)[0], { id: 'village -693,2262', first: true, needMs: lookNeedMs(dist) });
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -693,2262] judged the village at (-693, 63, 2262) again (was someone\'s: what only a player puts down in it or within 16: white_wall_banner x1): '
    + 'free (5 villagers, 3 unemployed adult(s) to take (2 employed)): the move next run; back home');
  t.deepEqual(acted(land), [], 'no villager taken, nothing dug');
  t.false(land.items.some(i => i.name === 'oak_boat' && i.count !== 1), 'the boat not used');
  const site = peekVillages(world).sites.find(s => s.x === -693)!;
  t.like(site.judged, { kind: 'free', v: JUDGE_V });
  t.false(rejudge(site));
  t.like(villagersTask.variants(snap(KIT(), { now: land.t + 2 * HOUR }), world)[0], { id: 'village -693,2262', first: true, needMs: moveNeedMs(dist) });

  // a plain white banner there (the bridge read it: not ominous): noted, the village free (Nov 20), the move offered next
  const w2 = hallWorld({ villages: { sites: [], players: [] } });
  w2.zones!['fence:gate']!.push({ x: -565, y: 63, z: 2183 });
  w2.villages!.sites.push({ x: -693, y: 63, z: 2262, seenAt: T0 - HOUR, judged: { ...NW } });
  const l2 = new Land(w2, { houses: [] });
  westStable(l2);
  l2.marks.push({ ...banner });
  const t2 = await rung(l2).run(l2.ctx());
  t.regex(t2, /^\[village -693,2262\] judged the village at \(-693, 63, 2262\) again \(was someone's: .*\): free \(.*; noted: a player's marks within 16: white_wall_banner x1\): the move next run; back home$/);
  t.deepEqual(acted(l2), []);
  t.like(peekVillages(w2).sites[0].judged, { kind: 'free', v: JUDGE_V });
  t.false(rejudge(peekVillages(w2).sites[0]));
  t.is(villagersTask.variants(snap(KIT(), { now: l2.t + 2 * HOUR }), w2)[0].id, 'village -693,2262');
});

test('D1 the range is 640: a village known 500 out is offered for a look, but no move sets out from farther than a day holds (the walk out, the look, the boat home by dusk: about 447 by land)', (t) => {
  t.is(VILLAGE_RANGE, 640);
  // the day's sums: a work day of 575 s less 15 s; a move from 303 out 418 s, from 400 out 513 s, from 500 out 612 s:
  // no move from past about 447 by land
  t.is(DAY_MS, 560_000);
  t.is(moveNeedMs(303), Math.round(303 / 3 * 1000) + 60_000 + homeMs({ x: 0, z: 0 }, [{ x: 303, z: 0 }]));
  t.true(moveNeedMs(440) <= DAY_MS && moveNeedMs(455) > DAY_MS, `${moveNeedMs(440)} ${moveNeedMs(455)}`);
  t.true(lookNeedMs(VILLAGE_RANGE) <= DAY_MS, 'a look at any village in the range fits a day');
  t.is(searchNeedMs(0), Math.round(2 * 128 / 3 * 1000) + 60_000);
  t.is(searchNeedMs(600), Math.round(2 * 640 / 3 * 1000) + 60_000, 'no further than the range');
  const w = hallWorld({ villages: { sites: [
    { x: -549, y: 63, z: 2183 - 400, villagers: 6, seenAt: T0 }, { x: -549, y: 63, z: 2183 + 500, villagers: 6, seenAt: T0 },
    { x: -549 - 500, y: 63, z: 2183, villagers: 6, seenAt: T0, judged: { at: T0 - HOUR, kind: 'theirs', why: 'another build 0 from it (x 1..2, z 1..2, hay_block)' } }
  ], players: [] } });
  const vs = villagersTask.variants(snap(KIT()), w);
  t.deepEqual(vs.filter(v => v.first).map(v => `${v.id} ${v.dist}`), ['village -549,1783 400', 'village -1049,2183 500'], 'the free one 500 out not offered: too far for the boat by land in a day');
  // from tod 0 the move from 400 out sets out (517 s of the 575)
  t.like(pick(villagersTask, snap(KIT(), { timeOfDay: 0 }), w), { variant: 'village -549,1783' });
  // a free one past that is said so, not "the move next run" (the find, the look again) nor a plain "free" in brain-status
  t.is(tooFarWord(400), undefined);
  t.is(tooFarWord(447), undefined);
  t.is(tooFarWord(500), 'but too far for a day\'s move (500 from home: it needs 612 s, the day has 560 s)');
  const judged = { at: T0, kind: 'free' as const, why: '6 villagers', v: JUDGE_V };
  const w2 = hallWorld({ villages: { sites: [{ x: -549, y: 63, z: 2183 - 400, seenAt: T0, judged }, { x: -549, y: 63, z: 2183 + 500, seenAt: T0, judged }], players: [] } });
  t.regex(villagersLine(w2, T0, tooFarFrom(HOME)), /; 2 village\(s\) known \(1 free, 1 free but too far for a day's move\)/);
  t.regex(villagersLine(w2, T0), /; 2 village\(s\) known \(2 free\)/, 'no home known: as before');
});

test('D1 a search out to 640 goes on the next run from where the day stopped it: the stops it looked from not looked again, the bearing ahead of the turn till done, then dropped', async (t) => {
  const world = hallWorld({ villages: { sites: [], players: [] } });
  const land = new Land(world, { houses: [] });
  land.villagers = [];
  land.marks = [];
  // (a run with 2 min of its budget: the walk home from the next stop must still fit)
  const r1 = await villagersTask.run(land.ctx(), 'north', 120_000, () => land.t);
  t.true(r1.mark === 'same', r1.text);
  t.regex(r1.text, /^no village seen north as far as \d+ blocks out: the run's time ran out$/);
  const out = peekVillages(world).searched?.north?.out ?? 0;
  t.true(out > 64 && out < VILLAGE_RANGE, String(out));
  t.regex(villagersLine(world, land.t), new RegExp(`searched part way \\(out of 640\\): north to ${out}`));
  // the next run's turn: north first, its day a walk out past it and 128 on
  const vs = villagersTask.variants(snap(KIT(), { now: land.t }), world);
  t.like(vs[0], { id: 'north', first: true, needMs: searchNeedMs(out) });
  t.deepEqual(vs.slice(1).map(v => v.id), SEARCHES.filter(b => b !== 'north'));
  // run two, its whole budget: out past what it looked along, then on to the range
  const from = land.said.length;
  const r2 = await villagersTask.run(land.ctx(), 'north', MOVE_BUDGET, () => land.t);
  t.is(r2.text, 'no village north within the village range (640 from home)');
  const said = land.said.slice(from);
  t.true(said.includes(`villagers: looking north for a village, out to 640 (looked along to ${out} before: on from there)`), said.join(' | '));
  t.true(said.some(l => /^out north past what was looked along before, \d+ blocks out$/.test(l)));
  const looked = said.filter(l => /^looking north for village, \d+ blocks out$/.test(l)).map(l => Number(/(\d+) blocks/.exec(l)![1]));
  t.true(looked.length > 0 && looked.every(d => d >= out), looked.join(','));
  t.is(peekVillages(world).searched, undefined, 'done: dropped');
});

test('D1 pillagers: a search turns back from a pillager outpost ahead, a move\'s walk out from a pillager in sight; nothing taken, nothing touched', async (t) => {
  const world = hallWorld({ villages: { sites: [], players: [] } });
  const land = new Land(world, { houses: [] });
  land.villagers = [];
  // an outpost's ominous banner 200 north of the north gate, a player's plain one 100 north
  land.marks = [{ name: 'white_wall_banner', at: { x: -549, y: 70, z: 1919 }, ominous: true }, { name: 'white_wall_banner', at: { x: -549, y: 66, z: 2019 } }];
  const r = await villagersTask.run(land.ctx(), 'north', MOVE_BUDGET, () => land.t);
  t.regex(r.text, /^turned back north at \(-549, 63, (19[89]\d|20\d\d)\), \d+ from home: a pillager outpost \(its ominous banner at \(-549, 70, 1919\), \d+ off\)$/);
  t.is(r.mark, undefined, 'the bearing dry: waits as a side with nothing');
  t.false(land.log.some(l => /^goto \(-549, 63, 19[0-4]\d\)/.test(l)), 'never walked within 48 of it');
  t.is(peekVillages(world).searched, undefined);
  // the move to the live village 300 north: a pillager in sight on the way out turns it back before the village
  const w2 = hallWorld();
  const l2 = new Land(w2);
  l2.players.push({ id: 77, name: 'pillager', position: { x: -560.5, y: 63, z: 2010.5 } });
  const r2 = await villagersTask.run(l2.ctx(), 'village -556,1880', MOVE_BUDGET, () => l2.t);
  t.regex(r2.text, /^turned back at \(-55\d, 63, 20\d\d\) on the way out to the village at \(-556, 63, 1880\): a pillager at \(-561, 63, 2010\), \d+ off$/);
  t.is(r2.mark, undefined, 'turned back by danger: the dry mark\'s wait grows, not the same 20 minutes');
  t.deepEqual(acted(l2), []);
});

// ------------------------------------------------------------------------------------------------ D1's review fixes

const gotoZ = (land: Land) => land.log.map(l => /^goto \(-?\d+, -?\d+, (-?\d+)\)/.exec(l)).filter((m): m is RegExpExecArray => !!m).map(m => Number(m[1]));

test('D1 fix: an ominous banner the scans have not seen yet (they reach 48 round the bot) is read where it hangs, 96 round it: the search turns back from it 64 to 111 ahead, never walking within 48 of it; an older jar reads the scans as before', async (t) => {
  const world = hallWorld({ villages: { sites: [], players: [] } });
  const land = new Land(world, { houses: [], scans: 48 });
  land.villagers = [];
  // 49 past the stop (z 1967) where the scans first could see it: from there the old reads walked the next leg to 17 off
  land.marks = [{ name: 'white_wall_banner', at: { x: -549, y: 70, z: 1918 }, ominous: true }];
  const r = await villagersTask.run(land.ctx(), 'north', MOVE_BUDGET, () => land.t);
  t.regex(r.text, /^turned back north at \(-549, 63, \d+\), \d+ from home: a pillager outpost \(its ominous banner at \(-549, 70, 1918\), \d+ off\)$/);
  t.true(Number(/, (\d+) off\)$/.exec(r.text)![1]) >= OUTPOST_CLEAR, r.text);
  t.false(gotoZ(land).some(z => z < 1918 + OUTPOST_CLEAR), gotoZ(land).join(','));
  // (an older jar: no foreign.banners, the scans' markers: turned back all the same, but nearer)
  const old = new Land(hallWorld({ villages: { sites: [], players: [] } }), { houses: [], scans: 48, oldJar: true });
  old.villagers = [];
  old.marks = land.marks.map(m => ({ ...m, at: { ...m.at } }));
  t.regex((await villagersTask.run(old.ctx(), 'north', MOVE_BUDGET, () => old.t)).text, /^turned back north at .*: a pillager outpost/);
});

test('D1 fix: a search going on from an earlier run looks for danger at the stops it walks through (a pillager by one turns it back), and its day\'s end counts the walk home from where it is, not from home', async (t) => {
  const world = hallWorld({ villages: { sites: [], players: [], searched: { north: { out: 400, at: T0 - HOUR } } } });
  const land = new Land(world, { houses: [] });
  land.villagers = [];
  land.marks = [];
  land.players.push({ id: 77, name: 'pillager', position: { x: -549.5, y: 63, z: 2000.5 } });
  const r = await villagersTask.run(land.ctx(), 'north', MOVE_BUDGET, () => land.t);
  t.regex(r.text, /^turned back north at \(-549, 63, 20\d\d\), \d+ from home: a pillager at \(-550, 63, 2000\), \d+ off$/);
  t.true(land.said.some(l => /^out north past what was looked along before, \d+ blocks out$/.test(l)));
  t.false(land.said.some(l => /^looking north for village, \d+ blocks out$/.test(l)), 'never got to a stop to look from');
  // a slow walk through (gates, ground: a block a second): it turns back while the walk home still fits the run
  const w2 = hallWorld({ villages: { sites: [], players: [], searched: { north: { out: 600, at: T0 - HOUR } } } });
  const l2 = new Land(w2, { houses: [] });
  l2.villagers = [];
  l2.marks = [];
  const walk = (l2 as unknown as { walk: (to: { x: number; z: number }, y?: number) => void }).walk.bind(l2);
  (l2 as unknown as { walk: (to: { x: number; z: number }, y?: number) => void }).walk = (to, y) => { const t0 = l2.t; walk(to, y); l2.t = t0 + (l2.t - t0) * 4; };
  const budget = 240_000;
  const began = l2.t;
  const r2 = await villagersTask.run(l2.ctx(), 'north', budget, () => l2.t);
  t.is(r2.text, 'no village seen north as far as 600 blocks out: the run\'s time ran out');
  t.is(r2.mark, 'same');
  const left = budget - (l2.t - began), back = horiz(l2.me, HOME) / 3 * 1000;
  t.true(back <= left + 15_000, `${Math.round(horiz(l2.me, HOME))} out with ${Math.round(left / 1000)} s left`);
  t.is(peekVillages(w2).searched?.north?.out, 600, 'on from there next run');
});

/** The rung's run for a site, its clock the stand-in world's (the snapshot at that time too, for the wrapper's marks). */
const rungAt = (land: Land) => rung(land).run(land.ctx({ s: snap(land.items, { now: land.t }) }));

test('D1 fix: an ominous banner by a village is the judge\'s, not an outpost to turn back from (the game keeps its outposts 10 chunks off a village): the re-look gets to the village, the search finds it (no player\'s mark: free); an outpost on the way still turns the walk back, its wait growing each time', async (t) => {
  // the west village to judge again, a player's trophy (ominous) banner in it, by the stable
  const world = hallWorld({ villages: { sites: [], players: [] } });
  world.zones!['fence:gate']!.push({ x: -565, y: 63, z: 2183 });
  const old = { at: T0 - HOUR, kind: 'theirs' as const, why: 'another build 0 from it (x -703..-670, z 2315..2344, hay_block)' };
  world.villages!.sites.push({ x: -693, y: 63, z: 2262, villagers: 11, bells: 1, beds: 3, jobs: 2, seenAt: T0 - HOUR, judged: { ...old }, area: { x1: -776, z1: 2221, x2: -635, z2: 2326 } });
  const land = new Land(world, { houses: [] });
  westStable(land);
  const trophy = { name: 'white_wall_banner', at: { x: -690, y: 66, z: 2300 }, ominous: true as const };
  land.marks.push(trophy);
  const r = await villagersTask.run(land.ctx(), 'village -693,2262', MOVE_BUDGET, () => land.t);
  // (the walk got there, not turned back by it; the judge then takes the ominous banner for no player's mark: the user's word)
  t.regex(r.text, /^judged the village at \(-693, 63, 2262\) again .*: free \(5 villagers, 3 unemployed adult\(s\) to take \(2 employed\)\): the move next run$/);
  // the search west finds it with the banner in it (a village not known yet)
  const w2 = hallWorld({ villages: { sites: [], players: [] } });
  w2.zones!['fence:gate']!.push({ x: -565, y: 63, z: 2183 });
  const l2 = new Land(w2, { houses: [] });
  westStable(l2);
  l2.marks.push({ ...trophy });
  const r2 = await villagersTask.run(l2.ctx(), 'west', MOVE_BUDGET, () => l2.t);
  t.regex(r2.text, /^found a village at \(-693, 63, 2262\): free \(5 villagers, 3 unemployed adult\(s\) to take \(2 employed\)\): the move next run$/);
  // an outpost on the way out (79 off the village's area): turned back with no mark, so the wrapper's dry mark grows
  const w3 = hallWorld({ villages: { sites: [], players: [] } });
  w3.zones!['fence:gate']!.push({ x: -565, y: 63, z: 2183 });
  w3.villages!.sites.push({ x: -693, y: 63, z: 2262, villagers: 11, seenAt: T0 - HOUR, judged: { ...old }, area: { x1: -776, z1: 2221, x2: -635, z2: 2326 } });
  const l3 = new Land(w3, { houses: [] });
  westStable(l3);
  l3.marks.push({ name: 'white_wall_banner', at: { x: -600, y: 70, z: 2142 }, ominous: true });
  const r3 = await villagersTask.run(l3.ctx(), 'village -693,2262', MOVE_BUDGET, () => l3.t);
  t.regex(r3.text, /^turned back at .* on the way out to the village at \(-693, 63, 2262\): a pillager outpost \(its ominous banner at \(-600, 70, 2142\), \d+ off\)$/);
  t.is(r3.mark, undefined);
  t.regex(await rungAt(l3), /turned back .*: a pillager outpost/);
  t.like(w3.work!.dry['villagers:village -693,2262'], { n: 1 });
  l3.t += 21 * MINUTE;
  t.regex(await rungAt(l3), /turned back .*: a pillager outpost/);
  t.like(w3.work!.dry['villagers:village -693,2262'], { n: 2 }, 'the wait 40 minutes now, not 20 again');
});

test('D1 fix: a re-look keeps the walk home: no viewpoint walked to that the day would not bring it home from; a village found too late in the day is looked at on the next run, from that stop', async (t) => {
  const world = hallWorld({ villages: { sites: [], players: [] } });
  world.zones!['fence:gate']!.push({ x: -565, y: 63, z: 2183 });
  world.villages!.sites.push({ x: -693, y: 63, z: 2262, villagers: 11, seenAt: T0 - HOUR,
    judged: { at: T0 - HOUR, kind: 'theirs', why: 'another build 0 from it (x -703..-670, z 2315..2344, hay_block)' }, area: { x1: -776, z1: 2221, x2: -635, z2: 2326 } });
  // (not all of it seen from its middle: the look would walk round it)
  const land = new Land(world, { houses: [], looked: 1 });
  westStable(land);
  const budget = 110_000;
  const began = land.t;
  const r = await villagersTask.run(land.ctx(), 'village -693,2262', budget, () => land.t);
  t.regex(r.text, /^judged the village at \(-693, 63, 2262\) again .*: not all of it seen yet/);
  t.false(land.said.some(l => /^villagers: looking round the village from/.test(l)), land.said.join(' | '));
  t.true(horiz(land.me, HOME) / 3 * 1000 <= budget - (land.t - began), 'home by the run\'s end');
  // with the whole day: it walks round it as before
  const w2 = hallWorld({ villages: { sites: [], players: [] } });
  w2.zones!['fence:gate']!.push({ x: -565, y: 63, z: 2183 });
  w2.villages!.sites.push({ ...world.villages!.sites[0], judged: { at: T0 - HOUR, kind: 'theirs', why: 'another build 0 from it (x -703..-670, z 2315..2344, hay_block)' } });
  const l2 = new Land(w2, { houses: [], looked: 1 });
  westStable(l2);
  await villagersTask.run(l2.ctx(), 'village -693,2262', MOVE_BUDGET, () => l2.t);
  t.true(l2.said.some(l => /^villagers: looking round the village from/.test(l)));
  // the search: a village in sight with too little of the day left to walk over, look and come home
  const w3 = hallWorld({ villages: { sites: [], players: [] } });
  w3.zones!['fence:gate']!.push({ x: -565, y: 63, z: 2183 });
  const l3 = new Land(w3, { houses: [] });
  westStable(l3);
  const r3 = await villagersTask.run(l3.ctx(), 'west', 100_000, () => l3.t);
  t.regex(r3.text, /^a village in sight at \(-693, 63, 2262\), but the day is too short to walk over and look at it: the next run, from (\d+) out$/);
  t.is(r3.mark, 'same');
  const out = peekVillages(w3).searched?.west?.out;
  t.true(!!out && r3.text.endsWith(`from ${out} out`), String(out));
  t.false(peekVillages(w3).sites.some(s => s.judged), 'not judged: looked at next run');
});

test('no word rests on what the look could not read whole (Nov 20): the stable\'s read failed on the re-look is another build, noted, the village free; an older jar\'s plain banner, noted, free too', async (t) => {
  t.like(judgeVillage(westLook({ zones: [STABLE({ all: undefined })] })), { kind: 'free', notes: ['another build 0 from it (x -703..-670, z 2315..2344, hay_block)'] });
  // live: the stable's read fails on the re-look
  const world = hallWorld({ villages: { sites: [], players: [] } });
  world.zones!['fence:gate']!.push({ x: -565, y: 63, z: 2183 });
  world.villages!.sites.push({ x: -693, y: 63, z: 2262, villagers: 11, seenAt: T0 - HOUR,
    judged: { at: T0 - HOUR, kind: 'theirs', why: 'another build 0 from it (x -703..-670, z 2315..2344, hay_block)' }, area: { x1: -776, z1: 2221, x2: -635, z2: 2326 } });
  const land = new Land(world, { houses: [] });
  westStable(land);
  const call = land.call.bind(land);
  land.call = (m, p = {}) => { if (m === 'foreign.marks' && p.x1 === -703 && p.z1 === 2315) throw new Error('timed out'); return call(m, p); };
  const r = await villagersTask.run(land.ctx(), 'village -693,2262', MOVE_BUDGET, () => land.t);
  t.is(r.text, 'judged the village at (-693, 63, 2262) again (was someone\'s: another build 0 from it (x -703..-670, z 2315..2344, hay_block)): '
    + 'free (5 villagers, 3 unemployed adult(s) to take (2 employed); noted: another build 0 from it (x -703..-670, z 2315..2344, hay_block)): the move next run');
  t.is(r.mark, 'first');
  t.like(peekVillages(world).sites[0].judged, { kind: 'free', v: JUDGE_V });
  t.false(rejudge(peekVillages(world).sites[0]));
  // an older jar: no ominous field on foreign.marks, a plain white banner by the village: noted, free
  const w3 = hallWorld({ villages: { sites: [], players: [] } });
  w3.zones!['fence:gate']!.push({ x: -565, y: 63, z: 2183 });
  w3.villages!.sites.push({ x: -693, y: 63, z: 2262, villagers: 11, seenAt: T0 - HOUR,
    judged: { at: T0 - HOUR, kind: 'theirs', why: 'another build 0 from it (x -703..-670, z 2315..2344, hay_block)' }, area: { x1: -776, z1: 2221, x2: -635, z2: 2326 } });
  const l3 = new Land(w3, { houses: [], oldJar: true });
  westStable(l3);
  l3.marks.push({ name: 'white_wall_banner', at: { x: -690, y: 66, z: 2300 } });
  const call3 = l3.call.bind(l3);
  l3.call = (m, p = {}) => { const out = call3(m, p) as Record<string, unknown>; if (m === 'foreign.marks') delete out.ominous; return out; };
  await villagersTask.run(l3.ctx(), 'village -693,2262', MOVE_BUDGET, () => l3.t);
  t.like(peekVillages(w3).sites[0].judged, { kind: 'free', v: JUDGE_V });
  t.regex(peekVillages(w3).sites[0].judged!.why, /noted: a player's marks within 16: white_wall_banner x1/);
});
