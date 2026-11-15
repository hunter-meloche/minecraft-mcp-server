import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { brainRun, type ClientRuntime, type InventoryItem } from '../../src/client/tools.js';
import type { Goal, GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { Zone } from '../../src/client/brain/courtesy.js';
import { Brain, decide } from '../../src/client/brain/brain.js';
import { Ground, cellOf, checkLeg, entryOf, footprint, planRoute, settle, type Entry } from '../../src/client/brain/boatroute.js';
import {
  HALL_WANTS, VILLAGE_RANGE, judgeVillage, noteSeen, noteVillage, peekVillages, pennedIn, siteOpen, villagersLine, type Seen, type VillageLook
} from '../../src/client/brain/village.js';
import { BOAT_PACE, MOVE_BUDGET, closeUpGoal, lastRailPlan, villagersTask } from '../../src/client/brain/villagemove.js';
import { railsText } from '../../src/client/brain/railroute.js';
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
  marks: { name: string; at: Pos }[];
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
    /** the brain stops the run as this drive (from 1) gets under way: its signal aborted, the bridge's cancel ends the drive halfway */
    abortAt?: { leg: number; abort: AbortController };
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
      case 'foreign.marks': {
        const inBox = (q: Pos) => q.x >= n('x1') && q.x <= n('x2') && q.z >= n('z1') && q.z <= n('z2') && (p.y1 === undefined || q.y >= n('y1')) && (p.y2 === undefined || q.y <= n('y2'));
        const re = p.match ? new RegExp(String(p.match)) : undefined;
        const kinds: Record<string, number> = {};
        for (const m of this.marks.filter(q => inBox(q.at))) kinds[m.name] = (kinds[m.name] ?? 0) + 1;
        const chunks = Math.floor(n('x2') / 16) - Math.floor(n('x1') / 16) + 1, rows = Math.floor(n('z2') / 16) - Math.floor(n('z1') / 16) + 1;
        const of = chunks * rows;
        return { kinds, at: re ? this.marks.filter(q => inBox(q.at) && re.test(q.name)).map(q => ({ ...q.at, name: q.name })) : [], chunks: this.opts.looked ?? of, of };
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

test('the courtesy judge: someone\'s, and left alone, for each of the plan\'s rules', (t) => {
  const theirs = (look: VillageLook) => { const v = judgeVillage(look); return v.kind === 'theirs' ? v.why : `not theirs: ${v.kind} ${v.why}`; };
  const named = VILLAGERS();
  named[3] = { ...named[3], named: true, customName: 'Bob' };
  t.is(theirs(freeLook({ seen: named })), 'a villager (-546, 63, 1872) is named (Bob)');
  const riding = VILLAGERS();
  riding[1] = { ...riding[1], vehicle: 'minecart', vehicleId: 7 };
  t.is(theirs(freeLook({ seen: riding })), 'a villager (-567, 63, 1878) rides a minecart');
  t.is(theirs(freeLook({ penned: new Set([105]) })), 'a villager (-541, 63, 1882) is penned in (it can walk to fewer than 24 cells)');
  // what only a player puts down, in it or within 16: a sign, a rail, redstone, a portal
  for (const [kind, n] of [['oak_sign', 1], ['rail', 6], ['redstone_wire', 3], ['repeater', 1], ['nether_portal', 6], ['spruce_wall_hanging_sign', 1], ['white_concrete', 40]] as const) {
    t.is(theirs(freeLook({ kinds: { ...freeLook().kinds, [kind]: n } })), `what only a player puts down in it or within 16: ${kind} x${n}`);
  }
  // a player seen within 64 of its area, ever (the time said); at 70 it is no one's for that
  const area = judgeVillage(freeLook());
  if (area.kind !== 'free') return t.fail();
  t.is(theirs(freeLook({ players: [{ x: area.area.x2 + 63, z: 1880, at: T0 - 3 * 24 * 60 * MINUTE }] })), 'a player was seen 63 from it, at (-454, 1880) (14:00)');
  t.is(judgeVillage(freeLook({ players: [{ x: area.area.x2 + 70, z: 1880, at: T0 }] })).kind, 'free');
  // near the world spawn: within 256 of it
  t.is(theirs(freeLook({ spawn: { x: -556, z: 1914 + 200 } })), 'within 256 of the world spawn (200 off)');
  // another build of others near it (not one of its own houses, which meet its area)
  const other: Zone = { x1: -500, y1: 60, z1: 1870, x2: -490, y2: 70, z2: 1880, markers: 30, surface: true, sample: 'stone_bricks' };
  t.is(theirs(freeLook({ zones: [...VILLAGE_ZONES(), other] })), 'another build 17 from it (x -500..-490, z 1870..1880, stone_bricks)');
  t.is(judgeVillage(freeLook({ zones: [...VILLAGE_ZONES(), { ...other, x1: -460, x2: -450 }] })).kind, 'free', '57 off: far enough');
  // (a mineshaft under it is the world's, not another build)
  t.is(judgeVillage(freeLook({ zones: [...VILLAGE_ZONES(), { ...other, surface: false }] })).kind, 'free');
});

test('the courtesy judge: a village of fewer than 5, or not all seen yet, waits; nothing there is no village', (t) => {
  const four = VILLAGERS().slice(0, 4);
  t.like(judgeVillage(freeLook({ seen: four })), { kind: 'wait', why: '4 villager(s) seen, 5 or more wanted' });
  t.like(judgeVillage(freeLook({ looked: { chunks: 20, of: 30 } })), { kind: 'wait', why: 'not all of it seen yet (20 of 30 chunks)' });
  t.like(judgeVillage({ ...freeLook(), bells: [], beds: [], jobs: [], seen: [] }), { kind: 'none' });
  // the rules that make it someone's come before the wait: a named villager in a village of four is someone's still
  const named = four.map((e, i) => (i ? e : { ...e, named: true }));
  t.is(judgeVillage(freeLook({ seen: named })).kind, 'theirs');
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
  // no hall, no panel, a gate in the fence where the posts would come out: no way in, and why
  t.deepEqual(entryOf(hallWorld({ zones: {} })), { why: 'no villager hall built' });
  const w = hallWorld();
  w.zones!['fence:gate'] = [{ x: -556, y: 63, z: 2119 }];
  t.deepEqual(entryOf(w), { why: 'the fence straight out from the panel holds a corner or a gate' });
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

test('the rung\'s gates: no hall, the hall full (as counted under half an hour ago), rain, a move\'s openings not put back; else the villages known first, then the four sides to 384', (t) => {
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
    ['village -556,1880 303 first', 'north 384', 'east 384', 'south 384', 'west 384']);
  // someone's: never again; its boat way failed today: not until tomorrow; too small: in 6 hours; beyond the range: not at all
  const w = hallWorld();
  const site = w.villages!.sites[0];
  site.judged = { at: T0 - MINUTE, kind: 'theirs', why: 'a player was seen 20 from it' };
  t.deepEqual(villagersTask.variants(s, w).map(v => v.id), ['north', 'east', 'south', 'west']);
  site.judged = undefined;
  site.noBoat = { at: T0 - 60 * MINUTE, why: 'a hill' };
  t.deepEqual(villagersTask.variants(s, w).map(v => v.id)[0], 'north');
  site.noBoat.at = T0 - 25 * 60 * MINUTE;
  t.deepEqual(villagersTask.variants(s, w).map(v => v.id)[0], 'village -556,1880');
  w.villages!.sites.push({ x: -549, y: 63, z: 2183 - VILLAGE_RANGE - 10, seenAt: T0 });
  t.false(villagersTask.variants(s, w).some(v => v.id === `village -549,${2183 - VILLAGE_RANGE - 10}`));
  // the day it needs: there at 3 a second, back at the boat's 2 on land, and a minute's work
  t.like(pick(villagersTask, snap(KIT(), { timeOfDay: 6000 }), hallWorld()), { decline: { cause: 'late' } });
  t.like(pick(villagersTask, snap(KIT(), { timeOfDay: 4000 }), hallWorld()), { variant: 'village -556,1880' });
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

test('a player comes by as the bot is about to take a villager: nothing taken, the village someone\'s for good', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  const call = land.call.bind(land);
  land.call = (m, p = {}) => {
    // (once the bot has walked over to the villager, after the judge's look)
    if (m === 'world.entities' && land.log.includes('goto (-557, 63, 1890) careful')) land.players = [{ id: 77, name: 'player', position: { x: -530, y: 63, z: 1900 } }];
    return call(m, p);
  };
  const text = await rung(land).run(land.ctx());
  t.is(text, '[village -556,1880] gave up: a player came by at (-530, 63, 1900): the village is someone\'s, left alone; back home');
  t.false(land.log.some(l => l.startsWith('boat down')));
  t.like(peekVillages(world).sites[0].judged, { kind: 'theirs', why: 'a player came by at (-530, 63, 1900) as the bot was about to take a villager' });
  t.like(peekVillages(world).players, [{ x: -530, y: 63, z: 1900 }]);
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

test('a village judged someone\'s at the look (a sign by it, a player seen near it): left alone, nothing touched, and never gone to again', async (t) => {
  for (const [what, setup, why] of [
    ['a sign', (l: Land) => { l.marks.push({ name: 'oak_sign', at: { x: -560, y: 64, z: 1900 } }); }, 'what only a player puts down in it or within 16: oak_sign x1'],
    ['a player', (l: Land) => { l.players.push({ id: 77, name: 'player', position: { x: -520, y: 63, z: 1880 } }); }, 'a player was seen 0 from it, at (-520, 63, 1880) (14:04)']
  ] as const) {
    const world = hallWorld();
    const land = new Land(world);
    setup(land);
    const text = await rung(land).run(land.ctx());
    t.regex(text, new RegExp(`^\\[village -556,1880\\] left the village at \\(-556, 63, 1880\\) alone: ${why.replace(/[()]/g, '\\$&').replace(/14:04/, '\\d\\d:\\d\\d')}; back home$`), what);
    t.false(land.log.some(l => l.startsWith('boat down')), what);
    t.like(peekVillages(world).sites[0].judged, { kind: 'theirs' }, what);
    t.deepEqual(villagersTask.variants(snap(KIT()), world).map(v => v.id), ['north', 'east', 'south', 'west'], what);
  }
});

test('the search: no village known, the north side walked out by the north gate, a bell in sight, walked over and judged; the move is the next run\'s', async (t) => {
  const world = hallWorld({ villages: { sites: [], players: [] } });
  const land = new Land(world);
  t.deepEqual(villagersTask.variants(snap(KIT()), world).map(v => v.id), ['north', 'east', 'south', 'west']);
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

test('with the switch on, the bells the bridge\'s scans saw on any walk (within 384 of home, not by the yard) become village sites, asked every 10 minutes; off, nothing is asked', async (t) => {
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
  t.like(asked[0], { x1: HOME.x - 384, x2: HOME.x + 384, z1: HOME.z - 384, z2: HOME.z + 384, match: '^bell$' });
  // the village 303 out; not the bell by the yard's north fence, nor the one 500 out
  t.deepEqual(world.villages!.sites.map(q => `${q.x},${q.y},${q.z} ${q.bells}`), ['-556,63,1880 1']);
  t.regex(brain.status(), /villagers: 1 village\(s\) seen on the walks \(their bells\), within 384 of home/);
  now += 5 * MINUTE;
  await brain.tick();
  t.is(asked.length, 1, 'not again within 10 minutes');
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
    'someone\'s: (-300, 2300): a player was seen 20 from it; 1 block(s) of the hall or the fence still open; last move 13:30: moved an unemployed villager from the village at (-556, 63, 1880) to the hall (1 in it now)');
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
  t.deepEqual(villagersTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), ['north', 'east', 'south', 'west']);
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

// ------------------------------------------------------------------------------------------------ the bridge's markers

const mod = path.join(process.cwd(), 'client-mod', 'src', 'claudebridge');
const java = (f: string): string => fs.readFileSync(path.join(mod, f), 'utf8');

test('the bridge\'s foreign.marks: registered, every chunk the scans look at counted (a chunk with no marker too), forgotten with the rest on foreign.clear', (t) => {
  const src = java('Foreign.java');
  t.true(src.includes('s.register("foreign.marks"'));
  t.regex(src, /if \(ch == null\) continue;\n\s+dim\.looked\.add\(/);
  t.regex(src, /e\.getValue\(\)\.byChunk\.clear\(\);\n\s+e\.getValue\(\)\.looked\.clear\(\);/);
  const marks = src.slice(src.indexOf('s.register("foreign.marks"'), src.indexOf('s.register("foreign.at"'));
  t.regex(marks, /return obj\("dimension", which, "kinds", k, "at", at, "chunks", looked, "of", of\);/);
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

test('the courtesy judge: a player\'s house by a village is another build of others, a bed and a barrel in it or villagers by it notwithstanding; a village whose beds chain out to 70 from its bell keeps its own houses', (t) => {
  const why = (look: VillageLook) => { const v = judgeVillage(look); return `${v.kind}: ${v.why}`; };
  // a cobblestone house 12 east of the village's east bed (-541, 1887): no bed, bell or job site of the village by it
  const cobble: Zone = { x1: -529, y1: 59, z1: 1880, x2: -520, y2: 70, z2: 1892, markers: 40, surface: true, sample: 'cobblestone' };
  t.is(why(freeLook({ zones: [...VILLAGE_ZONES(), cobble] })), 'theirs: another build 0 from it (x -529..-520, z 1880..1892, cobblestone)');
  // a player's house 80 east of the bell with a white bed and a barrel: 65 from the village's nearest bed, not chained in
  const house: Zone = { x1: -481, y1: 59, z1: 1875, x2: -470, y2: 70, z2: 1887, markers: 60, surface: true, sample: 'spruce_planks' };
  const look = freeLook({ zones: [...VILLAGE_ZONES(), house] });
  t.is(why({ ...look, beds: [...look.beds, { x: -476, y: 63, z: 1880 }], jobs: [...look.jobs, { name: 'barrel', at: { x: -474, y: 63, z: 1882 } }] }),
    'theirs: another build 0 from it (x -481..-470, z 1875..1887, spruce_planks)');
  // a player's house alone 17 off, and the same with two unemployed villagers standing by it
  const by: Zone = { x1: -500, y1: 60, z1: 1870, x2: -490, y2: 70, z2: 1880, markers: 30, surface: true, sample: 'spruce_planks' };
  const two: Villager[] = [{ id: 120, name: 'villager', position: { x: -495.5, y: 63, z: 1885.5 }, profession: 'none', level: 1, baby: false }, { id: 121, name: 'villager', position: { x: -492.5, y: 63, z: 1866.5 }, profession: 'none', level: 1, baby: false }];
  t.is(why(freeLook({ zones: [...VILLAGE_ZONES(), by] })), 'theirs: another build 17 from it (x -500..-490, z 1870..1880, spruce_planks)');
  t.is(why(freeLook({ zones: [...VILLAGE_ZONES(), by], seen: [...VILLAGERS(), ...two] })), 'theirs: another build 0 from it (x -500..-490, z 1870..1880, spruce_planks)');
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

test('the courtesy judge: a villager traded with (above level 1) makes the village someone\'s; no bell seen, or a call that did not answer, waits', (t) => {
  const traded = VILLAGERS();
  traded[1] = { ...traded[1], level: 2 };
  t.like(judgeVillage(freeLook({ seen: traded })), { kind: 'theirs', why: 'a villager (-567, 63, 1878) is at level 2: a player trades here' });
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

test('remembered for good: a village judged someone\'s outlives 8 newer sites, a player seen by a village outlives hundreds of sightings elsewhere, and a player seen by a known village makes it someone\'s at once', (t) => {
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
  t.is(judgeVillage(freeLook({ players: peekVillages(w2).players })).kind, 'theirs');
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
  // a player seen 36 from a known village's middle: someone's, for good; 100 off: not
  const w4 = hallWorld();
  noteSeen(w4, [{ id: 9, name: 'player', position: { x: -456, y: 63, z: 1880 } }], T0);
  t.is(w4.villages!.sites[0].judged, undefined);
  noteSeen(w4, [{ id: 9, name: 'player', position: { x: -520, y: 63, z: 1880 } }], T0);
  t.like(w4.villages!.sites[0].judged, { kind: 'theirs', why: 'a player was seen 36 from it, at (-520, 63, 1880) (14:00)' });
});

test('the side search walks on past a village already judged (someone\'s here): not walked into or looked at again, and the side gets the plain dry mark', async (t) => {
  const world = hallWorld();
  const land = new Land(world);
  land.marks.push({ name: 'oak_sign', at: { x: -560, y: 64, z: 1900 } });
  await rung(land).run(land.ctx());
  t.like(peekVillages(world).sites[0].judged, { kind: 'theirs' });
  const from = land.log.length;
  const r = await villagersTask.run(land.ctx(), 'north', MOVE_BUDGET, () => land.t);
  t.is(r.text, 'no village north within the village range (384 from home)');
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
