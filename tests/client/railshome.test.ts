import test from 'ava';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { Zone } from '../../src/client/brain/courtesy.js';
import type { CartPlaced, InventoryItem, RailLay, RailPlaced, RailTaken } from '../../src/client/tools.js';
import { Ground, cellOf, entryOf, type Entry } from '../../src/client/brain/boatroute.js';
import { BOOST_GAP, EARTH_MAX, earthCuttable, earthFor, planRails, shapeOf, type RailCell, type RailShape } from '../../src/client/brain/railroute.js';
import { recipeFor } from '../../src/client/brain/progress.js';
import { activityAt } from '../../src/client/brain/schedule.js';
import { pick, workTick } from '../../src/client/brain/work.js';
import { closeUpGoal } from '../../src/client/brain/villagemove.js';
import { JUDGE_V, peekVillages, type Seen } from '../../src/client/brain/village.js';
import {
  EXTENSIONS, FRESH_FREE, MAX_AGE, MISSES, MOVE_TRIES, STOPS, UP_TRIES, extensionFor, setPickupWait, straysOf, goalOf, layArgs, outwardSteps, peekLine, railMoveNeedMs, railsHomeLine, railsTask, railsTick, railsYardOpen, refillOf, shapeWith, startLine, stepAt, yardSteps, type RailLine
} from '../../src/client/brain/railshome.js';

/**
 * The rails home (P5e, railshome.ts) over a stand-in world that answers as the bridge and the runtime's rails tools do
 * (Rails.java and tools.ts, the 26.3 rules read in the jar): a rail goes on natural ground into air, and its shape comes
 * from the rails beside it (each joins the rails next to it, a block up or down among them: straight, a curve, up toward
 * the higher), never from the hand; lay-rail looks first, and refuses a rail that would not come out as asked or would
 * leave the rail before otherwise; a torch beside a powered rail lights it; only the bot's own blocks are taken up; a
 * cart put on the launch goes once its trigger torch is down, and takes in the villager standing on the pickup (one
 * that wandered off it is missed: the cart comes to rest 2 past it), and rolls home to the brake's end; a cart or a boat
 * broken lets its rider out where it sat. Shaped like the live homestead (the yard x -565..-533, z 2119..2215, its birch
 * fence with a torch on the post (-556, 64, 2119), the north gate, the hall (-561, 62, 2126) 11 x 9 with its panel in
 * the north wall and its gate south), a village west of a line due north: the plan a straight run of 130 rails from the
 * launch at z 1995 to the brake two short of the hall's wall, the pickup at (-556, 63, 2000).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 18, 14, 0, 0);
// (the wait on a villager wandering onto the pickup is off but in its own test: it watches for up to a minute)
setPickupWait(0);
const HOME: Pos = { x: -549, y: 63, z: 2183 };
const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
const HALL = { x: -561, y: 62, z: 2126, width: 11, length: 9 };
const PANEL: Pos[] = [{ x: -556, y: 63, z: 2126 }, { x: -556, y: 64, z: 2126 }];
const HALL_GATE: Pos = { x: -556, y: 63, z: 2134 };
const NORTH_GATE: Pos = { x: -549, y: 63, z: 2119 };
const BELL: Pos = { x: -572, y: 63, z: 2000 };
const SPAWN = { x: 0, y: 63, z: 0 };
const FENCE = 'birch_fence[east=true,north=false,south=false,waterlogged=false,west=true]';
const k = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const idOf = (s: string) => s.replace(/\[.*$/, '');

function hallWorld(over: Partial<WorldMemory> = {}): WorldMemory {
  return {
    landmarks: { chests: [], farmland: [] }, leash: 96, yard: { ...YARD }, chestItems: {}, lastDone: {},
    zones: {
      hall: [{ ...HALL }], 'hall:panel': PANEL.map(p => ({ ...p })), 'hall:gate': [{ ...HALL_GATE }], 'hall:inside': [{ x: -556, y: 63, z: 2130 }],
      'fence:gate': [{ ...NORTH_GATE }], fence: [{ x: YARD.x1, y: YARD.y, z: YARD.z1, width: YARD.x2 - YARD.x1 + 1, length: YARD.z2 - YARD.z1 + 1 }]
    },
    progress: { done: ['hall'], journal: [] },
    villagerMoves: true, railsHome: true,
    villages: {
      sites: [{
        x: BELL.x, y: BELL.y, z: BELL.z, villagers: 7, seenAt: T0 - HOUR, judged: { at: T0 - HOUR, kind: 'free', why: '7 villagers, 3 unemployed adult(s) to take', v: JUDGE_V },
        area: { x1: -605, z1: 1966, x2: -529, z2: 2035 }, noBoat: { at: T0 - HOUR, why: 'a wall' }
      }],
      players: []
    },
    ...over
  } as WorldMemory;
}

interface Villager { id: number; name: string; position: Pos; profession: string; level: number; baby: boolean; health?: number; category?: string; named?: boolean }
/** The village: unemployed adults 101 (by the pickup), 106 and 107; a farmer, a baby, a nitwit, a librarian. */
const VILLAGERS = (): Villager[] => [
  { id: 101, name: 'villager', position: { x: -553.5, y: 63, z: 2002.5 }, profession: 'none', level: 1, baby: false },
  { id: 102, name: 'villager', position: { x: -574.5, y: 63, z: 1996.5 }, profession: 'farmer', level: 1, baby: false },
  { id: 103, name: 'villager', position: { x: -566.5, y: 63, z: 2006.5 }, profession: 'none', level: 1, baby: true },
  { id: 104, name: 'villager', position: { x: -576.5, y: 63, z: 2008.5 }, profession: 'nitwit', level: 1, baby: false },
  { id: 105, name: 'villager', position: { x: -580.5, y: 63, z: 1994.5 }, profession: 'librarian', level: 1, baby: false },
  { id: 106, name: 'villager', position: { x: -566.5, y: 63, z: 1990.5 }, profession: 'none', level: 1, baby: false },
  { id: 107, name: 'villager', position: { x: -570.5, y: 63, z: 2012.5 }, profession: 'none', level: 1, baby: false }
];
const MARKS = (): { name: string; at: Pos }[] => [
  { name: 'bell', at: { ...BELL } },
  { name: 'white_bed', at: { x: -582, y: 63, z: 1990 } }, { name: 'white_bed', at: { x: -582, y: 63, z: 2010 } }, { name: 'red_bed', at: { x: -578, y: 63, z: 2014 } },
  { name: 'lectern', at: { x: -581, y: 63, z: 1993 } }, { name: 'composter', at: { x: -576, y: 63, z: 1997 } }
];
/** What a move carries, and a day's laying (the bill made). */
const KIT = (): InventoryItem[] => [
  { slot: 0, name: 'diamond_axe', count: 1 }, { slot: 1, name: 'bread', count: 32 }, { slot: 2, name: 'oak_boat', count: 1 },
  { slot: 3, name: 'rail', count: 64 }, { slot: 4, name: 'rail', count: 64 }, { slot: 5, name: 'powered_rail', count: 16 },
  { slot: 6, name: 'redstone_torch', count: 8 }, { slot: 7, name: 'cobblestone', count: 8 }, { slot: 8, name: 'minecart', count: 1 },
  { slot: 9, name: 'birch_fence', count: 2 }, { slot: 10, name: 'torch', count: 4 }, { slot: 11, name: 'oak_planks', count: 8 }
];

/** The plan over the flat land (railroute.ts planRails, as the move's dry run makes it): 130 rails due south to the hall. */
function plan(world: WorldMemory) {
  const g = new Ground(55, 29);
  const land = new Field(world);
  for (let x = -600; x <= -510; x++) for (let z = 1960; z <= 2130; z++) for (let y = 55; y < 84; y++) g.set(x, y, z, land.block(x, y, z));
  const r = planRails(g, { candidates: [{ id: 101, position: { x: -555.5, y: 63, z: 2000.5 } }], entry: entryOf(world) as Entry, panel: PANEL[0], yard: YARD, zones: [], bounds: { x1: -600, z1: 1960, x2: -510, z2: 2130 }, stores: {} });
  if (!r.ok) throw new Error(r.why);
  return r;
}
/** A world with the line kept (the move's dry run with the rails switch on), at `stage`. */
function lineWorld(stage: RailLine['stage'] = 'laying', over: Partial<WorldMemory> = {}): { world: WorldMemory; line: RailLine } {
  const world = hallWorld(over);
  const line = startLine(world, plan(world), world.villages!.sites[0], entryOf(world) as Entry, T0)!;
  line.stage = stage;
  return { world, line };
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

interface Vehicle { id: number; uuid: string; pos: Pos; rider?: number }

/**
 * The world as the bridge and the rails tools answer for it. A block walked takes a quarter of a second, one laid or
 * taken up a second. `opts.wander`: the launches at which the villager has wandered a block and a half off the pickup
 * as the cart comes (from 1); `abortAtLay`: the brain stops the run as that lay (from 1) is asked, the block not down.
 */
class Field {
  t = T0;
  me: Pos = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  items: InventoryItem[] = KIT();
  blocks = new Map<string, string>();
  rails = new Map<string, { item: 'rail' | 'powered_rail'; shape: RailShape; powered: boolean }>();
  own = new Set<string>();
  villagers: Villager[] = VILLAGERS();
  /** the village's bells, beds and job sites (foreign.marks) */
  marks = MARKS();
  /** where the bot has stood (each walk's end): the scans see scanSight round each */
  stood: { x: number; z: number }[] = [];
  players: { id: number; name: string; position: Pos }[] = [];
  zones: Zone[] = [];
  boat?: Vehicle;
  cart?: Vehicle;
  riding = false;
  log: string[] = [];
  said: string[] = [];
  lays = 0;
  launches = 0;
  /** the cart has taken the villager home to the brake */
  cartHome = false;
  /** the cart still rolling (cart.status says it moves) */
  cartMoving = false;
  line?: RailLine;
  /** brain.json as ctx.save wrote it, the last first (what a restart reads back) */
  saves: string[] = [];
  constructor(public world: WorldMemory, public opts: {
    wander?: number[]; abortAtLay?: { n: number; abort: AbortController }; newMovement?: boolean; stuckAt?: number;
    /** the lay (from 1) whose block goes down but whose reply is lost (the call throws) */
    lostAt?: number;
    /** the lay (from 1) as which the rails switch is turned off (the villager-moves tool, mid-run) */
    offAtLay?: number;
    /** blocks the take-up never reaches (out of reach), by place */
    unreach?: string[];
    /** how far cart.status sees a cart (the client's view): no limit unless said */
    sight?: number;
    /** cart.place's reply lost: the cart is down, the call throws */
    cartLost?: boolean;
    /** take-ups whose dig's reply is lost (the block left standing, still the bot's), by place: how many times */
    digLost?: Record<string, number>;
    /** the run stopped as cart.place is under way: the cart goes down, and the reply comes (`lost`: never, a kill) */
    cartAbort?: { abort: AbortController; lost?: boolean };
    /** the client restarted: its own set of carts is gone (cart.status with no id or uuid lists none) */
    forgotOwn?: boolean;
    /** vehicle.take of the cart breaks it, but its reply is lost (the call throws) */
    cartTakeLost?: boolean;
    /** once the cart has taken the villager home, a world.region over the hall's panel times out */
    wallUnreadAtBrake?: boolean;
    /** a mob that steps onto the line's head as the cart goes down (after the first look) */
    mobAtCart?: Villager;
    /** the launched cart takes this villager (one come onto the head after the looks), not the one on the pickup */
    takesOther?: number;
    /** the server's simulation distance in chunks, as cart.status says it (10 unless said) */
    simulation?: number;
    /** a cart frozen past the simulation distance rolls on home once the bot comes within it (to the end of the rails down) */
    wakes?: boolean;
    /** the boat broken at the pickup leaves its drop on the ground (vehicle.take answers pickedUp: false) */
    boatDropLeft?: boolean;
    /** world.region reads that fail right after the lost lay (lostAt): the client dropped */
    unreadAfterLost?: number;
    /** the next this many boat drives stop half way (a step the ground's model missed) */
    stallDrives?: number;
    /** the scans see the chunks within this of a place the bot has stood, a square as Foreign.java's (all of every box unless said) */
    scanSight?: number;
  } = {}) {}
  regionFails = 0;
  /** a frozen cart woken (the bot within the simulation distance): on along the rails down to their end, at rest there */
  private wake() {
    const c = this.cart;
    const sim = (this.opts.simulation ?? 10) * 16 - 16;
    if (!this.opts.wakes || !c || this.cartMoving || horiz(c.pos, this.me) >= sim || !this.line) return;
    const cells = this.line.cells;
    let i = cells.findIndex(q => q.x === Math.floor(c.pos.x) && q.z === Math.floor(c.pos.z));
    if (i < 0) return;
    while (i + 1 < cells.length && this.rails.has(k(cells[i + 1]))) i++;
    c.pos = { x: cells[i].x + 0.5, y: cells[i].y + 0.0625, z: cells[i].z + 0.5 };
    const v = this.villagers.find(q => q.id === c.rider);
    if (v) v.position = { ...c.pos };
    this.log.push(`cart woke, at rest ${k(cells[i])}`);
  }

  base(x: number, y: number, z: number): string {
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
  block(x: number, y: number, z: number): string {
    const r = this.rails.get(`${x},${y},${z}`);
    if (r) return r.item === 'rail' ? `rail[shape=${r.shape},waterlogged=false]` : `powered_rail[powered=${r.powered},shape=${r.shape},waterlogged=false]`;
    return this.blocks.get(`${x},${y},${z}`) ?? this.base(x, y, z);
  }
  private eye() { return this.riding && this.boat ? { ...this.boat.pos, y: this.boat.pos.y + 1.21 } : { ...this.me, y: this.me.y + 1.62 }; }
  private reach(p: Pos, by = 4.5) { const e = this.eye(); return Math.hypot(e.x - p.x - 0.5, e.y - p.y - 0.5, e.z - p.z - 0.5) <= by; }
  private walk(to: { x: number; z: number }, y = 63) {
    this.t += Math.round(horiz(this.me, to) * 250);
    this.me = { x: to.x, y, z: to.z };
    this.stood.push({ x: to.x, z: to.z });
  }
  /** into reach of a cell, as the tools' careful walk does */
  private near(p: Pos) { if (!this.reach(p)) this.walk({ x: p.x + 0.5 + 1.5, z: p.z + 0.5 }); }
  take(name: string, n = 1) {
    const it = this.items.find(i => i.name === name && i.count >= n);
    if (!it) return false;
    it.count -= n;
    if (!it.count) this.items = this.items.filter(i => i !== it);
    return true;
  }
  give(name: string, n = 1) {
    const it = this.items.find(i => i.name === name && i.count < 64);
    if (it) { it.count += n; return; }
    let slot = 0;
    while (this.items.some(i => i.slot === slot)) slot++;
    this.items.push({ slot, name, count: n });
  }
  count(name: string) { return this.items.filter(i => i.name === name).reduce((a, i) => a + i.count, 0); }

  // ---- the game's rail shapes: each rail joins the rails next to it (a block up or down among them)
  private by(p: Pos): Pos[] {
    const out: Pos[] = [];
    for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) for (const dy of [0, 1, -1]) {
      const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
      if (this.rails.has(k(q))) { out.push(q); break; }
    }
    return out;
  }
  private shapeAt(p: Pos): RailShape {
    const n = this.by(p);
    return n.length === 0 ? 'north_south' : n.length === 1 ? shapeOf(n[0], p) : shapeOf(n[0], p, n[1]);
  }
  private settle(p: Pos) {
    const r = this.rails.get(k(p))!;
    r.shape = this.shapeAt(p);
    for (const q of this.by(p)) this.rails.get(k(q))!.shape = this.shapeAt(q);
  }

  // ---- the runtime's rails tools (tools.ts layRail, takeUpRail, placeCart)
  lay = async (a: RailLay): Promise<RailPlaced> => {
    this.lays++;
    if (this.opts.abortAtLay?.n === this.lays) { this.opts.abortAtLay.abort.abort(); throw new Error('aborted: the brain gave this job up'); }
    if (this.opts.offAtLay === this.lays) this.world.railsHome = false;
    const r = await this.layNow(a);
    if (this.opts.lostAt === this.lays && r.placed) { this.regionFails = this.opts.unreadAfterLost ?? 0; throw new Error('bridge call rail.place timed out'); }
    return r;
  };
  private layNow = async (a: RailLay): Promise<RailPlaced> => {
    const p = a.at;
    this.near(p);
    this.t += 1000;
    const here = this.block(p.x, p.y, p.z);
    if (!/^(air|short_grass)$/.test(idOf(here))) return { ok: false, placed: false, reason: `occupied by ${idOf(here)}` };
    if (cellOf(this.block(p.x, p.y - 1, p.z)).kind !== 'solid') return { ok: false, placed: false, reason: 'nothing a rail stands on under it' };
    this.log.push(`lay ${a.item} ${k(p)}`);
    if (a.item === 'cobblestone') {
      if (!this.take('cobblestone')) return { ok: false, placed: false, reason: 'no cobblestone carried' };
      this.blocks.set(k(p), 'cobblestone');
      this.own.add(k(p));
      return { ok: true, placed: true, block: 'cobblestone' };
    }
    if (a.item === 'redstone_torch') {
      if (!this.take('redstone_torch')) return { ok: false, placed: false, reason: 'no redstone_torch carried' };
      this.blocks.set(k(p), 'redstone_torch[lit=true]');
      this.own.add(k(p));
      const lit = a.lights ? this.rails.get(k(a.lights)) : undefined;
      if (lit?.item === 'powered_rail') lit.powered = true;
      return { ok: !!lit?.powered, placed: true, block: 'redstone_torch', lit: true, ...(a.lights ? { lights: { ...a.lights, block: lit?.item ?? 'air', powered: !!lit?.powered } } : {}), ...(lit?.powered ? {} : { reason: 'the rail is not lit' }) };
    }
    if (!this.count(a.item)) return { ok: false, placed: false, reason: `no ${a.item} carried` };
    // looked at first, as rail.place's port does: the rail before as asked, this one as asked once the next is down
    const before = new Map([...this.rails].map(([q, r]) => [q, { ...r }]));
    const undo = () => { this.rails = before; };
    this.rails.set(k(p), { item: a.item as 'rail' | 'powered_rail', shape: 'north_south', powered: false });
    this.settle(p);
    if (a.prev && this.rails.get(k(a.prev))?.shape !== a.prev.shape) { const was = this.rails.get(k(a.prev))?.shape; undo(); return { ok: false, placed: false, reason: `the rail before would be ${was}, not ${a.prev.shape}` }; }
    let once = this.rails.get(k(p))!.shape;
    if (a.next && !this.rails.has(k(a.next))) {
      this.rails.set(k(a.next), { item: 'rail', shape: 'north_south', powered: false });
      once = this.shapeAt(p);
      this.rails.delete(k(a.next));
      this.settle(p);
    }
    if (a.shape && once !== a.shape) { undo(); return { ok: false, placed: false, reason: `it would come out ${once} once the next rail is down, not ${a.shape}` }; }
    this.take(a.item);
    this.own.add(k(p));
    return { ok: true, placed: true, block: a.item, shape: this.rails.get(k(p))!.shape, ...(this.opts.newMovement ? { newMovement: true } : {}) };
  };
  takeUp = async (at: Pos, item?: string): Promise<RailTaken> => {
    this.near(at);
    this.t += 1000;
    if (this.opts.unreach?.includes(k(at))) return { ok: false, dug: false, reason: 'out of reach or out of sight' };
    if (this.opts.digLost?.[k(at)]) { this.opts.digLost[k(at)]--; return { ok: false, dug: false, block: idOf(this.block(at.x, at.y, at.z)), reason: 'bridge call dig.here timed out after 25000 ms' }; }
    const st = this.block(at.x, at.y, at.z);
    const name = idOf(st);
    if (name === 'air') return { ok: true, dug: false, block: name, reason: 'nothing there' };
    if (!/^(rail|powered_rail|redstone_torch|cobblestone)$/.test(name)) return { ok: false, dug: false, block: name, reason: `not a block of the line: ${name}` };
    if (!this.own.has(k(at))) return { ok: false, dug: false, block: name, reason: `the bot did not put that ${name} there` };
    if (item && item !== name) { this.own.delete(k(at)); return { ok: false, dug: false, block: name, reason: `the bot did not put that ${name} there (its ${item} is gone)` }; }
    this.rails.delete(k(at));
    this.blocks.set(k(at), 'air');
    this.own.delete(k(at));
    this.give(name);
    this.log.push(`take up ${name} ${k(at)}`);
    return { ok: true, dug: true, block: name, pickedUp: true };
  };
  /** the earthworks as the runtime's rails tools make them (tools.ts cutGround, restoreGround): never from over the bot */
  underBot: string[] = [];
  cut = async (at: Pos, was: string): Promise<RailTaken> => {
    this.near(at);
    this.t += 1000;
    const name = idOf(this.block(at.x, at.y, at.z));
    if (name === 'air') return { ok: true, dug: false, block: name, reason: 'nothing there' };
    if (name !== idOf(was) || !/^(grass_block|dirt|coarse_dirt|stone|andesite|diorite|granite|gravel|sand)$/.test(name)) return { ok: false, dug: false, block: name, reason: `not the ground the plan cuts: ${name}` };
    if (this.own.has(k(at))) return { ok: false, dug: false, block: name, reason: `the bot's own ${name}` };
    if (Math.floor(this.me.x) === at.x && Math.floor(this.me.z) === at.z && this.me.y > at.y) this.underBot.push(k(at));
    this.blocks.set(k(at), 'air');
    this.give(name === 'grass_block' ? 'dirt' : name === 'stone' ? 'cobblestone' : name);
    this.log.push(`cut ${name} ${k(at)}`);
    return { ok: true, dug: true, block: name };
  };
  restore = async (at: Pos, item: string): Promise<RailPlaced> => {
    this.near(at);
    this.t += 1000;
    const here = idOf(this.block(at.x, at.y, at.z));
    if (!/^(air|short_grass)$/.test(here)) return { ok: false, placed: false, block: here, reason: `${here} there now` };
    if (!this.take(item)) return { ok: false, placed: false, reason: `no ${item} carried` };
    this.blocks.set(k(at), item);
    this.log.push(`restore ${item} ${k(at)}`);
    return { ok: true, placed: true, block: item };
  };
  placeCart = async (at: Pos): Promise<CartPlaced> => {
    this.near(at);
    if (!this.rails.has(k(at))) return { ok: false, reason: 'no rail there' };
    if (this.cart) return { ok: false, reason: 'a minecart on that rail already' };
    if (!this.take('minecart')) return { ok: false, reason: 'no minecart carried' };
    this.cart = { id: 700, uuid: 'ca27-0001', pos: { x: at.x + 0.5, y: at.y + 0.0625, z: at.z + 0.5 } };
    this.log.push(`cart on ${k(at)}`);
    if (this.opts.mobAtCart) { this.villagers.push(this.opts.mobAtCart); this.opts.mobAtCart = undefined; }
    if (this.opts.cartAbort) {
      this.opts.cartAbort.abort.abort();
      if (this.opts.cartAbort.lost) throw new Error('aborted: the brain gave this job up');
    }
    if (this.opts.cartLost) throw new Error('bridge call cart.place timed out');
    return { ok: true, id: 700, uuid: 'ca27-0001', position: { ...this.cart.pos }, passengers: [] };
  };

  inventory() { return { items: this.items.map(i => ({ ...i })) }; }
  status() {
    return {
      inWorld: true, username: 'claudebot', screen: null, position: { ...this.me }, block: { x: Math.floor(this.me.x), y: Math.floor(this.me.y), z: Math.floor(this.me.z) },
      dimension: 'overworld', timeOfDay: 1000, health: 20, food: 20, spawn: { ...SPAWN }, raining: false,
      riding: this.riding && this.boat ? { id: this.boat.id, uuid: this.boat.uuid, position: { ...this.boat.pos }, seat: 0, controlling: true, passengers: this.boat.rider ? [{ id: this.boat.rider }] : [] } : null
    };
  }
  private cartJson() {
    const c = this.cart!;
    const b = { x: Math.floor(c.pos.x), y: Math.floor(c.pos.y), z: Math.floor(c.pos.z) };
    const v = this.villagers.find(q => q.id === c.rider);
    return {
      id: c.id, uuid: c.uuid, position: { ...c.pos }, block: b, speed: this.cartMoving ? 0.4 : 0, moving: this.cartMoving, own: true, distance: horiz(c.pos, this.me),
      ...(this.rails.has(k(b)) ? { rail: { ...b, block: this.rails.get(k(b))!.item } } : {}),
      passengers: v ? [{ id: v.id, name: v.name, ...(v.name === 'villager' ? { profession: v.profession } : {}) }] : []
    };
  }

  call(method: string, p: Record<string, unknown> = {}): unknown {
    const n = (key: string) => Number(p[key]);
    switch (method) {
      case 'inventory': return this.inventory();
      case 'status': return this.status();
      case 'world.region': {
        const box = (q: Pos) => q.x >= n('x') && q.x < n('x') + n('width') && q.y >= n('y') && q.y < n('y') + n('height') && q.z >= n('z') && q.z < n('z') + n('length');
        if (this.opts.wallUnreadAtBrake && this.cartHome && box(PANEL[0])) throw new Error('bridge call world.region timed out');
        if (this.regionFails > 0) { this.regionFails--; throw new Error('not in a world'); }
        const out: (string | null)[] = [];
        for (let y = 0; y < n('height'); y++) for (let z = 0; z < n('length'); z++) for (let x = 0; x < n('width'); x++) out.push(this.block(n('x') + x, n('y') + y, n('z') + z));
        return { blocks: out };
      }
      case 'world.entities': {
        const max = Number(p.maxDistance ?? 32);
        const all = [
          ...this.villagers.map(v => ({ ...v, position: { ...v.position }, ...(this.boat?.rider === v.id ? { vehicle: 'oak_boat' } : this.cart?.rider === v.id ? { vehicle: 'minecart' } : {}) })),
          ...this.players.map(q => ({ ...q, position: { ...q.position } })),
          ...(this.cart ? [{ id: this.cart.id, name: 'minecart', position: { ...this.cart.pos } }] : []),
          ...(this.boat ? [{ id: this.boat.id, name: 'oak_boat', position: { ...this.boat.pos } }] : [])
        ];
        return { entities: all.filter(e => (!p.type || e.name === p.type) && Math.hypot(e.position.x - this.me.x, e.position.y - this.me.y, e.position.z - this.me.z) <= max) };
      }
      case 'foreign.zones': return { dimension: 'overworld', zones: this.zones.map(z => ({ ...z })) };
      case 'foreign.banners': return { dimension: 'overworld', at: [], chunks: 1 };
      case 'foreign.marks': {
        const inBox = (q: Pos) => q.x >= n('x1') && q.x <= n('x2') && q.z >= n('z1') && q.z <= n('z2');
        const re = p.match ? new RegExp(String(p.match)) : undefined;
        const kinds: Record<string, number> = {};
        for (const m of this.marks.filter(q => inBox(q.at))) kinds[m.name] = (kinds[m.name] ?? 0) + 1;
        const cx1 = Math.floor(n('x1') / 16), cx2 = Math.floor(n('x2') / 16), cz1 = Math.floor(n('z1') / 16), cz2 = Math.floor(n('z2') / 16);
        const of = (cx2 - cx1 + 1) * (cz2 - cz1 + 1);
        let chunks = of;
        const sight = this.opts.scanSight;
        if (sight !== undefined) {
          chunks = 0;
          for (let cx = cx1; cx <= cx2; cx++) for (let cz = cz1; cz <= cz2; cz++) if ([...this.stood, this.me].some(q => cx >= Math.floor((q.x - sight) / 16) && cx <= Math.floor((q.x + sight) / 16) && cz >= Math.floor((q.z - sight) / 16) && cz <= Math.floor((q.z + sight) / 16))) chunks++;
        }
        return { kinds, ominous: {}, at: re ? this.marks.filter(q => inBox(q.at) && re.test(q.name)).map(q => ({ ...q.at, name: q.name })) : [], chunks, of };
      }
      case 'goto': {
        const to = { x: n('x') + 0.5, z: n('z') + 0.5 };
        let at = to;
        if (p.away) at = { x: this.me.x + 2, z: this.me.z };
        else if (Number(p.range ?? 0) > 0 && horiz(this.me, to) > Number(p.range)) {
          const d = horiz(this.me, to), r = Number(p.range) / d;
          at = { x: to.x + (this.me.x - to.x) * r, z: to.z + (this.me.z - to.z) * r };
        }
        this.walk(at);
        return { arrived: true };
      }
      case 'dig.here': {
        const at = { x: n('x'), y: n('y'), z: n('z') };
        const was = this.block(at.x, at.y, at.z);
        if (was === 'air') return { dug: false, reason: 'air' };
        if (!this.reach(at)) return { dug: false, reason: 'out of reach or out of sight' };
        this.blocks.set(k(at), 'air');
        this.log.push(`dig ${idOf(was)} ${k(at)}`);
        return { dug: true, block: was };
      }
      case 'vehicle.place': {
        const mob = this.villagers.find(v => v.id === Number(p.for));
        if (!mob) return { ok: false, reason: 'no such creature' };
        if (this.cart?.rider === mob.id || this.boat?.rider === mob.id) return { ok: false, reason: 'the villager rides a minecart' };
        if (!this.take(String(p.item))) return { ok: false, reason: 'no boat carried' };
        this.boat = { id: 900, uuid: 'b0a7-0001', pos: { x: mob.position.x + 1.1, y: Math.floor(mob.position.y), z: mob.position.z }, rider: mob.id };
        this.log.push(`boat down, villager ${mob.id} in`);
        return { ok: true, id: 900, uuid: 'b0a7-0001', position: { ...this.boat.pos }, tookIt: true };
      }
      case 'vehicle.mount': {
        if (!this.boat) return { ok: false, reason: 'no such boat' };
        this.riding = true;
        this.me = { ...this.boat.pos };
        return { ok: true, controlling: true };
      }
      case 'vehicle.drive': {
        if (!this.riding || !this.boat) return { ok: false, reason: 'not in a boat' };
        const to = p.to as { x: number; z: number };
        const from = { ...this.boat.pos };
        const d = horiz(from, to);
        let end = { x: to.x, z: to.z }, reason = 'arrived';
        // (on the ground's top: a step up stops it, it comes down a drop)
        let ly = Math.floor(from.y + 0.01);
        if (this.opts.stallDrives) { this.opts.stallDrives--; end = { x: from.x + (to.x - from.x) / 2, z: from.z + (to.z - from.z) / 2 }; reason = 'a step up ahead'; }
        else for (let s = 0.25; s <= d; s += 0.25) {
          const q = { x: from.x + (to.x - from.x) * s / d, z: from.z + (to.z - from.z) * s / d };
          if (cellOf(this.block(Math.floor(q.x), ly, Math.floor(q.z))).kind !== 'open') { reason = 'a step up ahead'; end = { x: from.x + (to.x - from.x) * (s - 0.5) / d, z: from.z + (to.z - from.z) * (s - 0.5) / d }; break; }
          while (ly > 55 && cellOf(this.block(Math.floor(q.x), ly - 1, Math.floor(q.z))).kind === 'open') ly--;
        }
        this.boat.pos = { x: end.x, y: ly, z: end.z };
        this.me = { ...this.boat.pos };
        const v = this.villagers.find(q => q.id === this.boat!.rider);
        if (v) v.position = { ...this.boat.pos };
        this.t += Math.round(horiz(from, end) * 500);
        this.log.push(`drive to (${Math.round(to.x * 10) / 10}, ${Math.round(to.z * 10) / 10})${reason === 'arrived' ? '' : `: ${reason}`}`);
        return { ok: reason === 'arrived', reason, at: { ...this.boat.pos } };
      }
      case 'vehicle.dismount': {
        if (!this.riding || !this.boat) return { ok: true, wasRiding: false };
        const t = (p.toward as { x: number; z: number } | undefined) ?? { x: this.boat.pos.x + 1, z: this.boat.pos.z };
        const d = horiz(this.boat.pos, t) || 1;
        this.riding = false;
        this.me = { x: this.boat.pos.x + (t.x - this.boat.pos.x) / d * 1.27, y: Math.floor(this.boat.pos.y), z: this.boat.pos.z + (t.z - this.boat.pos.z) / d * 1.27 };
        return { ok: true, wasRiding: true };
      }
      case 'vehicle.take': {
        const v = this.boat && n('id') === this.boat.id ? this.boat : this.cart && n('id') === this.cart.id ? this.cart : undefined;
        if (!v) return { ok: false, reason: 'no such vehicle' };
        if (this.riding && v === this.boat) return { ok: false, reason: 'riding it' };
        if (horiz(this.me, v.pos) > 4) return { ok: false, reason: 'too far' };
        const rider = this.villagers.find(q => q.id === v.rider);
        if (rider) rider.position = { x: v.pos.x, y: Math.floor(v.pos.y), z: v.pos.z };
        const isCart = v === this.cart;
        if (v === this.boat) {
          this.boat = undefined;
          if (this.opts.boatDropLeft) { this.log.push('boat broken, its drop left'); return { ok: true, pickedUp: false }; }
          this.give('oak_boat');
          this.log.push('boat taken up');
        } else { this.cart = undefined; this.give('minecart'); this.log.push('cart taken up'); }
        if (isCart && this.opts.cartTakeLost) { this.opts.cartTakeLost = false; throw new Error('bridge call vehicle.take timed out'); }
        return { ok: true };
      }
      case 'cart.status': this.wake(); return { carts: this.cart && !(this.opts.forgotOwn && p.id === undefined && p.uuid === undefined) && horiz(this.cart.pos, this.me) <= (this.opts.sight ?? Infinity) ? [this.cartJson()] : [], newMovement: false, simulationDistance: this.opts.simulation ?? 10, takeSpeed: 0.1 };
      case 'cart.watch': {
        const c = this.cart;
        const line = this.line!;
        if (!c || n('id') !== c.id) return { ok: false, reason: `no minecart with id ${n('id')} in sight` };
        if (p.until === 'rest') {
          // (one rolling home: on to the brake's end, at rest there)
          if (this.cartMoving) {
            const end = line.cells[line.cells.length - 1];
            c.pos = { x: end.x + 0.5, y: end.y + 0.0625, z: end.z + 0.5 };
            const v = this.villagers.find(q => q.id === c.rider);
            if (v) v.position = { ...c.pos };
            this.cartMoving = false;
            this.t += 5000;
          }
          return { ok: true, reason: 'at rest', at: { ...c.pos }, passengers: this.cartJson().passengers };
        }
        const launch = this.rails.get(k(line.cells[0]));
        if (!launch?.powered) { this.t += 20_000; return { ok: false, reason: 'timed out', at: { ...c.pos } }; }
        this.launches++;
        const pk = line.pickup;
        if (this.opts.wander?.includes(this.launches)) for (const v of this.villagers) if (Math.floor(v.position.x) === pk.x && Math.floor(v.position.z) === pk.z) v.position = { x: v.position.x + 1.5, y: v.position.y, z: v.position.z + 1 };
        const v = this.opts.takesOther !== undefined ? this.villagers.find(q => q.id === this.opts.takesOther)
          : this.villagers.find(q => Math.floor(q.position.x) === pk.x && Math.floor(q.position.z) === pk.z && this.boat?.rider !== q.id);
        if (!v) {
          const rest = line.cells[line.cells.findIndex(q => q.x === pk.x && q.z === pk.z) + 2];
          c.pos = { x: rest.x + 0.5, y: rest.y + 0.0625, z: rest.z + 0.5 };
          this.t += 5000;
          this.log.push(`cart at rest ${k(rest)}, empty`);
          return { ok: true, reason: 'at rest', at: { ...c.pos }, passengers: [] };
        }
        const end = line.cells[this.opts.stuckAt ?? line.cells.length - 1];
        c.rider = v.id;
        this.cartHome = true;
        c.pos = { x: end.x + 0.5, y: end.y + 0.0625, z: end.z + 0.5 };
        v.position = { ...c.pos };
        this.t += 3000;
        this.log.push(`cart took villager ${v.id}, home to the brake ${k(end)}`);
        return { ok: true, reason: 'took', took: [v.id], at: { ...c.pos }, passengers: [{ id: v.id, name: 'villager', baby: v.baby }] };
      }
      default: return {};
    }
  }

  act(tool: string, p: Record<string, unknown> = {}): { ok: boolean; text: string } {
    if (tool === 'go-home') { this.walk({ x: HOME.x + 0.5, z: HOME.z + 0.5 }); return { ok: true, text: 'Arrived home' }; }
    if (tool === 'place-block') {
      const at = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
      const item = String(p.item);
      const was = this.block(at.x, at.y, at.z);
      if (was !== 'air') return { ok: true, text: `There's already a block (${was}) at (${at.x}, ${at.y}, ${at.z})` };
      if (!this.reach(at)) return { ok: true, text: 'Failed to place block: too far' };
      if (!this.take(item)) return { ok: true, text: `No ${item} in inventory to place` };
      this.blocks.set(k(at), item === 'birch_fence' ? FENCE : item);
      this.log.push(`place ${item} ${k(at)}`);
      return { ok: true, text: `Placed ${item} at (${at.x}, ${at.y}, ${at.z})` };
    }
    if (tool === 'craft-item') {
      const out = String(p.outputItem), times = Number(p.amount ?? 1);
      const r = recipeFor(out);
      if (!r) return { ok: false, text: `no recipe for ${out}` };
      for (const [inp, c] of Object.entries(r.from)) if (this.count(inp) < c * times) return { ok: false, text: `not enough ${inp}` };
      for (const [inp, c] of Object.entries(r.from)) for (let i = 0; i < c * times; i++) this.take(inp);
      for (let i = 0; i < r.makes * times; i++) this.give(out);
      this.log.push(`craft ${out} x${r.makes * times}`);
      return { ok: true, text: `Crafted ${r.makes * times} ${out}` };
    }
    return { ok: false, text: `no tool ${tool}` };
  }

  ctx(over: Partial<GoalContext> = {}): GoalContext {
    return {
      s: snap(this.items, { now: this.t }), world: this.world, signal: new AbortController().signal,
      act: async (tool, args = {}) => this.act(tool, args),
      call: (async (m: string, p?: Record<string, unknown>) => this.call(m, p)) as GoalContext['call'],
      status: (async () => this.status()) as GoalContext['status'],
      progress: (text: string) => { this.said.push(text); },
      gain: () => undefined,
      rails: { lay: this.lay, takeUp: this.takeUp, placeCart: this.placeCart, cut: this.cut, restore: this.restore },
      save: () => { this.saves.unshift(JSON.stringify(this.world)); },
      ...over
    };
  }

  /** What of the line stands in the world: its rails, torches and the stop, by place. */
  standing(line: RailLine): string[] {
    const ps = [...line.cells, ...line.torches.map(t => t.at), line.stop.at];
    return ps.filter(q => /^(rail|powered_rail|redstone_torch|cobblestone)$/.test(idOf(this.block(q.x, q.y, q.z)))).map(k);
  }
}

/** One run of a variant, on the world's clock. */
const run = (land: Field, variant: string, budgetMs: number, over: Partial<GoalContext> = {}) => railsTask.run(land.ctx(over), variant, budgetMs, () => land.t);
/** The line laid whole in the world (as the days would have left it). */
async function laidWhole(land: Field, line: RailLine) {
  land.line = line;
  const r = await run(land, 'lay', 30 * MINUTE);
  if (line.stage !== 'whole') throw new Error(`not whole: ${r.text}`);
  return r;
}

// ------------------------------------------------------------------------------------------------ the shapes

test('a rail\'s shape with only the rails down so far, and the lay-rail calls of a curve and a climb laid from the yard\'s end out, then the yard\'s stretch: each as the game turns it, the line ending as planned', async (t) => {
  // a line by hand: north from the stop, a curve east, up a block, a curve back north, on to its end (the "yard" its last 3)
  const pts: Pos[] = [];
  for (let z = 10; z >= 5; z--) pts.push({ x: 0, y: 63, z });
  for (let x = 1; x <= 6; x++) pts.push({ x, y: x >= 4 ? 64 : 63, z: 5 });
  for (let z = 4; z >= 1; z--) pts.push({ x: 6, y: 64, z });
  const stop = { x: 0, y: 63, z: 11 };
  const cells: RailCell[] = pts.map((p, i) => ({ ...p, kind: i === 0 ? 'powered' : 'rail', shape: shapeOf(i === 0 ? stop : pts[i - 1], p, pts[i + 1]) }));
  t.deepEqual(cells.slice(4, 8).map(c => c.shape), ['north_south', 'south_east', 'east_west', 'east_west']);
  t.is(cells[8].shape, 'ascending_east', 'the rail under the step is the slope');
  t.is(cells[11].shape, 'north_west');
  const line = { cells, torches: [], yard: 3, stop: { at: stop, placed: false } } as unknown as RailLine;
  // what each rail is with one rail beside it: straight toward it, up to it when it is higher
  t.is(shapeWith(line, 5, j => j === 6), 'east_west', 'the curve\'s rail runs straight on to the next until the one before is down');
  t.is(shapeWith(line, 8, j => j === 9), 'ascending_east');
  t.is(shapeWith(line, 9, j => j === 10), 'east_west', 'the higher rail stays level');
  t.is(shapeWith(line, 5, j => j === 4 || j === 6), 'south_east');
  t.is(shapeWith(line, 5, () => false), undefined);
  // laid in the days' order on the game's rules, then the yard's stretch: every call as asked, the line as planned
  const world = hallWorld();
  const land = new Field(world);
  for (const p of pts.filter(q => q.y === 64)) land.blocks.set(k({ ...p, y: 63 }), 'dirt');
  land.items.push({ slot: 30, name: 'rail', count: 64 }, { slot: 31, name: 'powered_rail', count: 4 });
  t.deepEqual(outwardSteps(line).map(s => (s.kind === 'cell' ? s.i : s.kind)), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  t.deepEqual(yardSteps(line).map(s => (s.kind === 'cell' ? s.i : s.kind)), [13, 14, 15]);
  const laid = new Set<number>();
  for (const s of outwardSteps(line)) {
    if (s.kind !== 'cell') continue;
    const a = layArgs(line, s.i, laid, s.i > 0 ? s.i - 1 : undefined);
    const r = await land.lay(a);
    t.true(r.ok, `${s.i}: ${r.reason}`);
    laid.add(s.i);
  }
  t.is(land.rails.get(k(pts[12]))!.shape, 'north_south', 'the yard\'s end rail runs on toward the rail after it, not laid yet');
  for (const s of yardSteps(line)) {
    if (s.kind !== 'cell') continue;
    const r = await land.lay(layArgs(line, s.i, laid, s.i + 1 < cells.length ? s.i + 1 : undefined));
    t.true(r.ok, `${s.i}: ${r.reason}`);
    laid.add(s.i);
  }
  t.deepEqual(pts.map(p => land.rails.get(k(p))!.shape), cells.map(c => c.shape));
  // a gap mended: the rail between two down named with both
  const gap = layArgs(line, 9, new Set([...laid].filter(i => i !== 9)));
  t.like(gap, { at: pts[9], prev: { ...pts[10], shape: cells[10].shape }, next: { ...pts[8] }, shape: cells[9].shape });
  // the stop of the wrong kind of laying: a rail asked a shape it cannot have is refused, nothing down
  const fresh = new Field(world);
  fresh.items.push({ slot: 30, name: 'rail', count: 4 });
  const no = await fresh.lay({ at: { x: 20, y: 63, z: 20 }, item: 'rail', shape: 'east_west', next: { x: 20, y: 63, z: 21 } });
  t.false(no.placed);
  t.regex(no.reason!, /once the next rail is down, not east_west/);
});

// ------------------------------------------------------------------------------------------------ the plan kept

test('the line kept: the plan whole in brain.json (every rail, torch, the stop, the fence it opens, the boat\'s way in), at the bill, nothing down; one job at a time', (t) => {
  const { world, line } = lineWorld('bill');
  t.is(line.cells.length, 130);
  t.is(line.yard, 6);
  t.is(goalOf(line), 123);
  t.deepEqual(line.cells[goalOf(line) + 1], { x: -556, y: 63, z: 2119, kind: 'rail', shape: 'north_south' }, 'the post\'s cell is the yard stretch\'s first');
  t.deepEqual(line.opens.map(o => o.block), [FENCE, 'torch']);
  t.is(line.torches.filter(x => x.trigger).length, 1);
  t.deepEqual(line.laid, []);
  t.like(line, { stage: 'bill', villager: 101, pickup: { x: -556, y: 63, z: 2000 }, stop: { placed: true } });
  // a damaged one is no line (the gates read it), and a second is not kept beside the first
  t.truthy(peekLine(JSON.parse(JSON.stringify(world)) as WorldMemory), 'it comes back from brain.json whole');
  t.is(startLine(world, plan(world), world.villages!.sites[0], entryOf(world) as Entry, T0 + MINUTE), undefined);
  const bad = hallWorld({ rails: { line: { ...line, cells: 'x' } as unknown as RailLine } });
  t.is(peekLine(bad), undefined);
  t.deepEqual(railsTask.variants(snap(KIT()), bad), []);
  t.regex(railsHomeLine(world, T0), /^Rails home: on; the line to the village at \(-572, 63, 2000\), planned 0 min ago: planned: 130 rails, the bill to make\.$/);
});

// ------------------------------------------------------------------------------------------------ the bill

test('the bill made at home: rails, powered rails, the torches, the stop and the cart crafted from the iron, gold, redstone and sticks carried; then the laying', async (t) => {
  const { world, line } = lineWorld('bill');
  const land = new Field(world);
  land.items = [{ slot: 0, name: 'iron_ingot', count: 64 }, { slot: 1, name: 'gold_ingot', count: 16 }, { slot: 2, name: 'redstone', count: 16 }, { slot: 3, name: 'stick', count: 32 }, { slot: 4, name: 'cobblestone', count: 2 }];
  t.deepEqual(railsTask.variants(snap(land.items), world).map(v => v.id), ['bill']);
  const r = await run(land, 'bill', 5 * MINUTE);
  t.regex(r.text, /^the bill made \(123 rail, 7 powered_rail, 5 redstone_torch, 1 cobblestone, 1 minecart\); the laying next, from the yard's fence out$/);
  t.true(land.count('rail') >= 123);
  t.true(land.count('powered_rail') >= 7);
  t.is(land.count('redstone_torch'), 5);
  t.is(land.count('minecart'), 1);
  t.is(line.stage, 'laying');
  t.deepEqual(railsTask.variants(snap(land.items), world).map(v => v.id), ['lay']);
  // short of gold: said, the rest next run, nothing laid
  const { world: w2, line: l2 } = lineWorld('bill');
  const poor = new Field(w2);
  poor.items = [{ slot: 0, name: 'iron_ingot', count: 64 }, { slot: 2, name: 'redstone', count: 16 }, { slot: 3, name: 'stick', count: 32 }, { slot: 4, name: 'cobblestone', count: 2 }];
  const p = await run(poor, 'bill', 5 * MINUTE);
  t.regex(p.text, /^the bill \(.*\): short of powered_rail \(12 gold_ingot\); the rest next run$/);
  t.is(l2.stage, 'bill');
});

// ------------------------------------------------------------------------------------------------ the laying

test('laying over two runs with the record: from the fence out, every block written as it goes down, the day\'s end in time for the walk home; the next run on along what is down to where it stopped, then whole', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  land.line = line;
  const r1 = await run(land, 'lay', 100_000);
  t.regex(r1.text, /^laid \d+ today \(\d+ of 130 rails down\); the day's end: on from \(-556, 63, \d+\) next morning$/);
  const day1 = line.laid.length;
  t.true(day1 > 10 && day1 < 120, `${day1}`);
  t.is(line.stage, 'laying');
  t.is(line.runs, 1);
  // the record is what stands: every block of it down, the bot's own, and nothing else of the line
  t.deepEqual(land.standing(line).sort(), line.laid.map(b => k(b.at)).sort());
  t.true(line.laid.every(b => land.own.has(k(b.at))));
  // from the fence out: the first rail laid is the one outside the post, the yard's stretch untouched (the move's day)
  t.is(land.log.find(l => l.startsWith('lay '))!, 'lay rail -556,63,2118');
  t.false(land.standing(line).some(p => Number(p.split(',')[2]) >= 2119));
  t.is(land.block(-556, 63, 2119), FENCE, 'the fence stands');
  // the torch with its powered rail, as it goes
  t.true(land.log.indexOf('lay powered_rail -556,63,2104') < land.log.indexOf('lay redstone_torch -555,63,2104'));
  t.regex(railsHomeLine(world, land.t), new RegExp(`: ${laidRails(line)} of 130 laid \\(1 run\\(s\\)\\)\\.$`));
  // the next morning: along what is down (read, nothing laid again), on from where it stopped, whole
  const before = land.log.length;
  const r2 = await run(land, 'lay', 30 * MINUTE);
  t.regex(r2.text, /^the line is whole: 130 rails, 5 torches, the stop \(laid \d+ today, in 2 run\(s\)\); the move next$/);
  t.false(land.log.slice(before).some(l => l.startsWith('lay ') && line.laid.slice(0, day1).some(b => l.endsWith(k(b.at)) && l.includes('rail'))), 'nothing laid twice');
  t.is(line.stage, 'whole');
  // the outer part all down, the trigger and the yard's stretch not: the plan's shapes, the boosts lit, the launch not
  const outer = line.cells.slice(0, goalOf(line) + 1);
  t.true(outer.every(c => land.rails.get(k(c))?.shape === 'north_south'));
  t.true(line.cells.filter(c => c.role === 'boost').every(c => land.rails.get(k(c))!.powered));
  t.false(land.rails.get(k(line.cells[0]))!.powered, 'the launch waits for its trigger');
  t.is(land.block(-555, 63, 1995), 'air');
  t.is(land.block(-556, 63, 1994), 'cobblestone', 'the stop');
  t.regex(railsHomeLine(world, land.t), /: whole \(130 rails\): the move next\.$/);
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), ['move']);
});
const laidRails = (line: RailLine) => line.laid.filter(b => /rail/.test(b.item)).length;

test('a restart mid-laying: the block being laid when the run was cut is in the record; brain.json brings the line back, the next run goes on with nothing laid twice; given up (the switch off), the take-up takes every block back, the cut one too', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  land.line = line;
  const abort = new AbortController();
  land.opts.abortAtLay = { n: 25, abort };
  await t.throwsAsync(run(land, 'lay', 30 * MINUTE, { signal: abort.signal }));
  // (the 25th written before it went down: in the record, not in the world)
  t.is(line.laid.length, 25);
  t.is(land.standing(line).length, 24);
  // the restart: brain.json read back, the bridge's own record of the bot's blocks kept (the protection store)
  const saved = JSON.parse(JSON.stringify(world)) as WorldMemory;
  land.world = saved;
  land.opts.abortAtLay = undefined;
  const again = peekLine(saved)!;
  land.line = again;
  t.is(again.laid.length, 25);
  const before = land.lays;
  await run(land, 'lay', 60_000);
  t.true(land.lays > before);
  t.deepEqual(land.standing(again).sort(), again.laid.map(b => k(b.at)).sort(), 'the record and the world agree again');
  // the switch off: given up, everything taken back up
  saved.railsHome = false;
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), saved).map(v => v.id), ['take up']);
  const up = await run(land, 'take up', 30 * MINUTE);
  t.regex(up.text, /everything of the line taken back up \(the rails switch is off\)$/);
  t.deepEqual(land.standing(again), []);
  t.is(peekLine(saved), undefined);
  t.regex(railsHomeLine(saved, land.t), /^Rails home: off; no line; last \d\d:\d\d: everything of the line taken back up \(the rails switch is off\)\.$/);
  t.is(land.count('rail'), 128, 'the rails back in the pockets');
});

test('laying stops at anything unexpected: a block of someone\'s on a cell ahead (said, the day\'s laying ends there); stopped twice in a row the line is given up; a player near stops it too; a build of someone\'s by the line gives it up at once', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  land.line = line;
  land.blocks.set(k(line.cells[90]), 'oak_planks');
  const r = await run(land, 'lay', 30 * MINUTE);
  t.regex(r.text, /^laid \d+, then stopped: rail \(-556, 63, 2085\): oak_planks there now \(not as read when planned\)$/);
  t.false(land.standing(line).some(p => p === k(line.cells[90])));
  t.true(land.standing(line).includes(k(line.cells[91])));
  t.like(line, { stops: 1, stage: 'laying' });
  const again = await run(land, 'lay', 30 * MINUTE);
  t.regex(again.text, /stopped: .*oak_planks there now .*\(the line is given up next\)$/);
  t.is(line.stops, STOPS);
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), ['take up']);
  await run(land, 'take up', 30 * MINUTE);
  t.deepEqual(land.standing(line), []);
  t.is(land.block(-556, 63, 2085), 'oak_planks', 'someone\'s block left as it is');
  // a player by the line: the laying stops for the day
  const b = lineWorld('laying');
  const two = new Field(b.world);
  two.line = b.line;
  two.players = [{ id: 9, name: 'player', position: { x: -540.5, y: 63, z: 2110.5 } }];
  const p = await run(two, 'lay', 30 * MINUTE);
  t.regex(p.text, /stopped: a player near at \(-541, 63, 2110\)$/);
  t.deepEqual(two.standing(b.line), []);
  // a build of someone's within 16 of the line: given up before a block goes down
  const c = lineWorld('laying');
  const three = new Field(c.world);
  three.zones = [{ x1: -540, y1: 60, z1: 2050, x2: -530, y2: 70, z2: 2060, markers: 30, surface: true, sample: 'stone_bricks' }];
  const z = await run(three, 'lay', 30 * MINUTE);
  t.regex(z.text, /^the line given up: a build of someone's within 16 of the line at \(-556, 63, 20\d\d\) \(x -540\.\.-530, z 2050\.\.2060, stone_bricks\)$/);
  t.is(c.line.stage, 'taking up');
  t.is(three.lays, 0);
});

test('a server under the minecart_improvements experiment gives the line up at its first rail: the line was planned on the old rules', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { newMovement: true });
  land.line = line;
  const r = await run(land, 'lay', 30 * MINUTE);
  t.regex(r.text, /^the line given up: the server runs the minecart_improvements experiment/);
  t.is(line.stage, 'taking up');
  await run(land, 'take up', 30 * MINUTE);
  t.deepEqual(land.standing(line), []);
});

// ------------------------------------------------------------------------------------------------ the move

test('the move end to end: the yard\'s stretch laid and the post opened, out along the line, the village judged again, the villager onto the pickup by boat, the cart and its trigger, home behind it on foot, the fence shut, the cart broken, the boat into the hall; then everything taken back up and the fence and the hall as they were', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { wander: [1] });
  await laidWhole(land, line);
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), ['move']);
  const log0 = land.log.length;
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^moved an unemployed villager from the village at \(-572, 63, 2000\) to the hall by the rails home \(1 in it now\); everything of the line taken back up \(done: the villager is in the hall\)$/);
  const did = land.log.slice(log0);
  // the yard's stretch on the move's day: what stood on the post first, then the post, then the rails from it in
  t.deepEqual(did.slice(0, 2), ['dig torch -556,64,2119', 'dig birch_fence -556,63,2119']);
  t.deepEqual(did.slice(2, 8), [2119, 2120, 2121, 2122, 2123, 2124].map(z => `lay ${z >= 2123 ? 'powered_rail' : 'rail'} -556,63,${z}`));
  // the first launch missed (the villager had wandered off the pickup): the cart and the trigger back up, again
  t.true(did.includes('cart at rest -556,63,2002, empty'));
  t.is(did.filter(l => l === 'cart on -556,63,1995').length, 2);
  t.true(did.some(l => /^cart took villager 101, home to the brake -556,63,2124$/.test(l)));
  // the fence shut before the cart was broken, the boat in at the hall's panel
  const shut = did.indexOf('place birch_fence -556,63,2119');
  t.true(shut > 0 && shut < did.lastIndexOf('cart taken up'));
  t.true(did.some(l => l === 'dig oak_planks -556,63,2126'));
  // the villager in the hall, everything as it was
  const v = land.villagers.find(q => q.id === 101)!;
  t.true(v.position.x >= HALL.x && v.position.x < HALL.x + HALL.width && v.position.z > HALL.z && v.position.z < HALL.z + HALL.length - 1, JSON.stringify(v.position));
  t.deepEqual(land.standing(line), []);
  t.is(land.block(-556, 63, 2119), FENCE);
  t.is(land.block(-556, 64, 2119), 'torch');
  for (const x of [-557, -556, -555]) for (const y of [63, 64]) t.is(land.block(x, y, 2126), 'oak_planks', `${x},${y}`);
  t.is(land.cart, undefined);
  t.is(land.boat, undefined);
  t.is(land.count('minecart'), 1);
  t.is(land.count('oak_boat'), 1);
  t.is(peekLine(world), undefined);
  t.deepEqual(peekVillages(world).open ?? [], []);
  t.like(peekVillages(world).last, { moved: true });
  t.is(peekVillages(world).sites[0].moved, 1);
  t.true(world.villagerMoves, 'the moves stay on');
  t.true(land.said.some(l => l === 'rails: the cart missed the villager (101): the cart came to rest at (-556, 63, 2002) without it; again'), land.said.join(' | '));
});

test('the villager lost: missed every try, the line is given up (the moves stay on: it never left its village) and taken back up', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { wander: [1, 2, 3] });
  await laidWhole(land, line);
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, new RegExp(`^the line given up: the villager lost: the cart missed it ${MOVE_TRIES} times`));
  t.is(line.stage, 'taking up');
  t.is(land.cart, undefined, 'the cart back up');
  t.true(world.villagerMoves);
  const up = await run(land, 'take up', 30 * MINUTE);
  t.regex(up.text, /everything of the line taken back up \(the villager lost/);
  t.deepEqual(land.standing(line), []);
  t.is(land.block(-556, 63, 2119), FENCE, 'the post back');
  t.is(land.block(-556, 64, 2119), 'torch');
});

test('the cart come to rest out on the line with the villager in it: the move given up, the moves off (the villager is out of its village), the cart broken where it stands by the take-up, everything back up', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { stuckAt: 60 });
  await laidWhole(land, line);
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^the move given up: the cart came to rest short of the brake at \(-556, 63, 2055\)$/);
  t.false(world.villagerMoves, 'the moves wait for the lead');
  t.true(land.said.includes('rails: villager moves off (by the rails move: the cart came to rest short of the brake at (-556, 63, 2055))'), land.said.join(' | '));
  t.is(line.stage, 'taking up');
  // the yard's stretch went down this morning: close up's at any hour, the take-up's by day
  const up = await run(land, 'take up', 30 * MINUTE);
  t.regex(up.text, /the villager \(101\) let out of the cart where it was.*everything of the line taken back up/);
  t.is(land.cart, undefined);
  t.deepEqual(land.standing(line), []);
  t.is(land.block(-556, 63, 2119), FENCE);
  t.like(land.villagers.find(v => v.id === 101)!.position, { x: -555.5, z: 2055.5 });
});

test('a move not made today (a player in the village, within 32: Nov 20) leaves the line whole, the village free; someone\'s (two villagers named), the line is given up; close up takes a yard stretch left down back, any hour, and puts the post back', async (t) => {
  {
    const { world, line } = lineWorld('laying');
    const land = new Field(world);
    await laidWhole(land, line);
    land.players = [{ id: 9, name: 'player', position: { x: -590.5, y: 63, z: 2000.5 } }];
    const r = await run(land, 'move', 20 * MINUTE);
    t.regex(r.text, /^the move not made today: a player at \(-591, 63, 2000\), \d+ from the (bot|village): no villager taken this run/);
    t.is(line.stage, 'whole');
    t.like(peekVillages(world).sites[0].judged, { kind: 'free' });
  }
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  land.villagers[1].named = true;
  land.villagers[2].named = true;
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^the line given up: the village at \(-572, 63, 2000\) is someone's: 2 villagers used by a player/);
  t.is(line.stage, 'taking up');
  // the yard's stretch was down and the post open: close up (any hour, in the yard) has it, before the take-up's run
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const s = snap(land.items, { now: land.t, timeOfDay: 14000, activity: activityAt(14000) });
  t.is(closeUpGoal.wants(s, world), 'the rails home\'s yard stretch left down by a line given up');
  const text = await closeUpGoal.run(land.ctx());
  t.regex(text, /^the rails' yard stretch: 6 rail\(s\) taken up, the fence back; put back 0 block/);
  t.is(land.block(-556, 63, 2119), FENCE);
  t.is(land.block(-556, 64, 2119), 'torch');
  t.is(closeUpGoal.wants(s, world), null);
  await run(land, 'take up', 30 * MINUTE);
  t.deepEqual(land.standing(line), []);
  t.is(peekLine(world), undefined);
});

test('a move cut short with the villager in the cart on the brake (a restart): the next run goes on into the hall, whatever the switches', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  // as the move left it: the yard's stretch down, the post open, the cart at rest on the brake with 101 in it
  const yard = yardSteps(line).map(s => stepAt(line, s));
  land.me = { x: -555.5, y: 63, z: 2121.5 };
  for (const o of [...line.opens].reverse()) { land.blocks.set(k(o.at), 'air'); (world.villages!.open ??= []).push({ at: { ...o.at }, block: o.block }); }
  for (let i = goalOf(line) + 1; i < line.cells.length; i++) {
    const laid = new Set(line.cells.map((_, j) => j).filter(j => j < i));
    line.laid.push({ at: { ...yard[i - goalOf(line) - 1] }, item: line.cells[i].kind === 'rail' ? 'rail' : 'powered_rail' });
    t.true((await land.lay(layArgs(line, i, laid, i + 1 < line.cells.length ? i + 1 : undefined))).ok);
  }
  const end = line.cells[line.cells.length - 1];
  land.cart = { id: 701, uuid: 'ca27-0002', pos: { x: end.x + 0.5, y: 63.06, z: end.z + 0.5 }, rider: 101 };
  land.villagers.find(v => v.id === 101)!.position = { ...land.cart.pos };
  line.stage = 'moving';
  line.yardOpen = true;
  line.cart = { uuid: 'ca27-0002' };
  line.villagerOut = 101;
  world.villagerMoves = false;
  world.railsHome = false;
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), ['move']);
  // (cut short before the cart went down, the yard's stretch is close up's: the fence never left open overnight)
  const cart = line.cart;
  delete line.cart;
  t.is(closeUpGoal.wants(snap(land.items, { now: land.t }), world), 'the rails home\'s yard stretch left down by a move that did not go');
  line.cart = cart;
  // with the cart out, close up (any hour) shuts the fence behind it once it rests on the brake: only the post's rail up,
  // the brake and the cart with the villager left for the next run (cut at dusk, the yard is not left open all night)
  const night = snap(land.items, { now: land.t, timeOfDay: 14000, activity: activityAt(14000) });
  t.is(closeUpGoal.wants(night, world), 'the rails home\'s post left open by a move cut short with its cart out');
  const text = await closeUpGoal.run(land.ctx());
  t.regex(text, /^the rails' post: the fence shut behind the cart on the brake \(the move goes on into the hall next run\); put back 0 block/);
  t.is(land.block(-556, 63, 2119), FENCE);
  t.is(land.block(-556, 64, 2119), 'torch');
  t.like(land.cart, { rider: 101 }, 'the villager still in the cart on the brake');
  t.true(land.standing(line).includes(k(line.cells[goalOf(line) + 2])), 'the brake\'s rails left under it');
  t.is(closeUpGoal.wants(night, world), null);
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^moved an unemployed villager .* to the hall by the rails home \(1 in it now\)/);
  t.true(land.said.some(l => /^rails: the last move was cut short with the villager \(101\) in the cart on the brake: on into the hall$/.test(l)));
  t.is(land.block(-556, 63, 2119), FENCE);
  t.deepEqual(land.standing(line), []);
});

test('a move cut short with the cart still rolling home (not at rest on the brake): close up leaves the post open for it (taken up, the cart would stop at the fence outside)', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  land.me = { x: -555.5, y: 63, z: 2121.5 };
  for (const o of [...line.opens].reverse()) { land.blocks.set(k(o.at), 'air'); (world.villages!.open ??= []).push({ at: { ...o.at }, block: o.block }); }
  for (let i = goalOf(line) + 1; i < line.cells.length; i++) {
    const laid = new Set(line.cells.map((_, j) => j).filter(j => j < i));
    line.laid.push({ at: { x: line.cells[i].x, y: line.cells[i].y, z: line.cells[i].z }, item: line.cells[i].kind === 'rail' ? 'rail' : 'powered_rail' });
    t.true((await land.lay(layArgs(line, i, laid, i + 1 < line.cells.length ? i + 1 : undefined))).ok);
  }
  const mid = line.cells[100];
  land.cart = { id: 701, uuid: 'ca27-0002', pos: { x: mid.x + 0.5, y: 63.06, z: mid.z + 0.5 }, rider: 101 };
  land.cartMoving = true;
  line.stage = 'moving';
  line.yardOpen = true;
  line.cart = { uuid: 'ca27-0002' };
  line.villagerOut = 101;
  const night = snap(land.items, { now: land.t, timeOfDay: 14000, activity: activityAt(14000) });
  t.truthy(closeUpGoal.wants(night, world));
  // (no failure, and not looked at again for a while: close up does not churn on it all evening)
  t.regex(await closeUpGoal.run(land.ctx()), /not at rest on the brake .*: the post left open for it/);
  t.is(land.block(-556, 63, 2119).split('[')[0], 'rail', 'the post\'s rail left for the cart coming in');
  t.is(closeUpGoal.wants(night, world), null);
  t.truthy(closeUpGoal.wants({ ...night, now: night.now + 11 * MINUTE }, world));
  // given up with the cart and its villager out and not found (followOn's lostOut): the take-up's to shut, not close up's
  line.stage = 'taking up';
  delete line.postLook;
  land.cart = undefined;
  t.is(closeUpGoal.wants(night, world), null);
});

// ------------------------------------------------------------------------------------------------ the give-ups and the switch

test('the give-ups, read by the gates: the job\'s budget (a day), the hall full, the village someone\'s or forgotten; a death on a rails run (workTick); each takes it all back up', (t) => {
  const s = (over: Partial<Snapshot> = {}) => snap(KIT(), over);
  const ids = (w: WorldMemory, over: Partial<Snapshot> = {}) => railsTask.variants(s(over), w).map(v => v.id);
  const a = lineWorld('laying');
  t.deepEqual(ids(a.world), ['lay']);
  t.deepEqual(ids(a.world, { now: T0 + MAX_AGE + MINUTE }), ['take up']);
  const b = lineWorld('whole');
  b.world.villages!.hall = { count: 3, at: T0 - MINUTE };
  t.deepEqual(ids(b.world), ['take up']);
  const c = lineWorld('laying');
  c.world.villages!.sites[0].judged = { at: T0, kind: 'theirs', why: 'a player was seen 20 from it', rule: 'player', v: JUDGE_V };
  t.deepEqual(ids(c.world), ['take up']);
  const d = lineWorld('laying');
  d.world.villages!.sites = [];
  t.deepEqual(ids(d.world), ['take up']);
  // a death during a rails run: the line given up on the next tick
  const e = lineWorld('laying');
  e.line.run = { at: T0, end: T0 + 60_000 };
  const lines = workTick(s({ now: T0 + 70_000 }), e.world, () => ({ time: T0 + 30_000, at: { x: -556, y: 63, z: 2050 } }), [railsTask]);
  t.true(lines.some(l => /^rails: giving up the line: a death on a rails run \(14:00\)/.test(l)), lines.join(' | '));
  t.is(e.line.stage, 'taking up');
  // one long after the run, at home: no matter to the line
  const f = lineWorld('laying');
  f.line.run = { at: T0, end: T0 + 60_000 };
  workTick(s({ now: T0 + HOUR }), f.world, () => ({ time: T0 + 30 * MINUTE }), [railsTask]);
  t.is(f.line.stage, 'laying');
});

test('the switch: off as it ships (no line is ever kept then); with a line, nothing laid or moved with the villager moves off (it waits), its take-up whatever the switches; never in the rain for the move; the gates write nothing', (t) => {
  t.is(hallWorld({ railsHome: undefined }).railsHome, undefined);
  t.regex(railsHomeLine(hallWorld({ railsHome: undefined }), T0), /^Rails home: off; no line\.$/);
  const { world, line } = lineWorld('laying');
  const s = snap(KIT());
  world.villagerMoves = false;
  t.deepEqual(railsTask.variants(s, world), []);
  t.deepEqual(railsTask.none!(s, world), { cause: 'unneeded', text: 'rails: villager moves are off: the line waits' });
  t.regex(railsHomeLine(world, T0), /\(villager moves off: it waits\)\.$/);
  line.stage = 'taking up';
  line.why = 'given up by hand';
  t.deepEqual(railsTask.variants(s, world).map(v => v.id), ['take up']);
  world.villagerMoves = true;
  line.stage = 'whole';
  t.like(railsTask.ready(snap(KIT(), { raining: true }), world, 'move'), { cause: 'late', text: 'raining: no villager is moved in the rain' });
  t.is(railsTask.ready(snap(KIT(), { raining: true }), world, 'lay'), null);
  // the rung as the queue sees it: chosen in the morning from the yard, a far task
  t.like(pick(railsTask, s, world), { variant: 'move' });
  t.deepEqual(railsTask.variants(s, hallWorld()), [], 'no line, no rung');
  // the gates read and never write (A16): every one of them asked, the world as it was
  for (const stage of ['bill', 'laying', 'whole', 'moving', 'taking up'] as const) {
    const w = lineWorld(stage);
    const was = JSON.stringify(w.world);
    for (const over of [{}, { raining: true }, { now: T0 + MAX_AGE + 1 }]) {
      const at = snap(KIT(), over);
      for (const v of railsTask.variants(at, w.world)) railsTask.ready(at, w.world, v.id);
      railsTask.none!(at, w.world);
      pick(railsTask, at, w.world);
      railsHomeLine(w.world, at.now);
    }
    t.is(JSON.stringify(w.world), was, stage);
  }
});

// ------------------------------------------------------------------------------------------------ the fixer's cases

/** The yard's stretch as a move cut short left it: its rails down from `from` in, the post open or shut as asked. */
function yardAsLeft(land: Field, line: RailLine, world: WorldMemory, opts: { postOpen: boolean }) {
  const g = goalOf(line);
  if (opts.postOpen) for (const o of [...line.opens].reverse()) { land.blocks.set(k(o.at), 'air'); (world.villages!.open ??= []).push({ at: { ...o.at }, block: o.block }); }
  for (let i = opts.postOpen ? g + 1 : g + 2; i < line.cells.length; i++) {
    const c = line.cells[i];
    land.rails.set(k(c), { item: c.kind === 'rail' ? 'rail' : 'powered_rail', shape: 'north_south', powered: false });
    land.own.add(k(c));
    line.laid.push({ at: { x: c.x, y: c.y, z: c.z }, item: c.kind === 'rail' ? 'rail' : 'powered_rail' });
  }
}

test('a restart mid-run reads brain.json as last written (the brain saves at a run\'s end only, and a kill never gets there): every block is written to it before it goes down, so the next run has the whole cut run in its record; on the move\'s day the stage, the open fence and the cart too', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  land.line = line;
  const abort = new AbortController();
  land.opts.abortAtLay = { n: 40, abort };
  await t.throwsAsync(run(land, 'lay', 30 * MINUTE, { signal: abort.signal }));
  // the process killed: no run's end, no save of the run; brain.json as ctx.save last wrote it
  const disk = JSON.parse(land.saves[0]) as WorldMemory;
  const again = peekLine(disk)!;
  t.is(again.laid.length, 40, 'the 40th written before it went down');
  t.is(land.standing(again).length, 39);
  land.world = disk;
  land.line = again;
  land.opts.abortAtLay = undefined;
  const r = await run(land, 'lay', 30 * MINUTE);
  t.regex(r.text, /^the line is whole/);
  t.deepEqual(land.standing(again).sort(), again.laid.map(b => k(b.at)).sort(), 'the record and the world agree');
  // the move's day, killed as the trigger torch is asked for (the yard's six rails, then the trigger)
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const ab2 = new AbortController();
  land.opts.abortAtLay = { n: land.lays + line.yard + 1, abort: ab2 };
  await t.throwsAsync(run(land, 'move', 20 * MINUTE, { signal: ab2.signal }));
  const disk2 = JSON.parse(land.saves[0]) as WorldMemory;
  const l2 = peekLine(disk2)!;
  t.like(l2, { stage: 'moving', yardOpen: true, cart: { uuid: 'ca27-0001' } });
  t.true(l2.laid.some(b => k(b.at) === k(line.cells[goalOf(line) + 1])), 'the post\'s rail in the record');
  t.deepEqual(peekVillages(disk2).open?.map(o => k(o.at)).sort(), line.opens.map(o => k(o.at)).sort(), 'the fence\'s opening kept for close up');
});

test('a move cut short after the cart was broken at the brake (the boat\'s part not done): the next run takes the villager standing in the yard into the hall, never back to a whole line and a second villager; not seen there, the move is given up and the moves off', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  yardAsLeft(land, line, world, { postOpen: false });
  land.me = { x: -555.5, y: 63, z: 2122.5 };
  land.villagers.find(v => v.id === 101)!.position = { x: -555.5, y: 63, z: 2123.5 };
  line.stage = 'moving';
  line.yardOpen = true;
  line.villagerOut = 101;
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^moved an unemployed villager .* to the hall by the rails home \(1 in it now\)/);
  t.true(land.said.some(l => /^rails: the last move was cut short after the cart was broken at the brake: the villager \(101\) in the yard, on into the hall$/.test(l)), land.said.join(' | '));
  t.deepEqual(land.standing(line), []);
  t.is(land.block(-556, 63, 2119), FENCE);
  // not in sight: given up, the moves off (the villager is out of its village), never 'whole'
  const b = lineWorld('laying');
  const two = new Field(b.world);
  await laidWhole(two, b.line);
  yardAsLeft(two, b.line, b.world, { postOpen: false });
  two.villagers = two.villagers.filter(v => v.id !== 101);
  b.line.stage = 'moving';
  b.line.yardOpen = true;
  b.line.villagerOut = 101;
  const lost = await run(two, 'move', 20 * MINUTE);
  t.regex(lost.text, /^the move given up: the last move was cut short after the cart was broken at the brake: the villager \(101\) not seen$/);
  t.is(b.line.stage as string, 'taking up');
  t.false(b.world.villagerMoves);
});

test('a mob on the line\'s head (a chicken by the launch): no cart is put down for it to take home, the day\'s move a miss; and a cart in the yard with a chicken in it is broken by the take-up (only a villager is never let out there)', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  const c2 = line.cells[2];
  land.villagers.push({ id: 300, name: 'chicken', position: { x: c2.x + 0.5, y: 63, z: c2.z + 0.5 }, profession: 'none', level: 0, baby: false, health: 4 });
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^the move not made: a chicken on the line's head at \(-556, 63, 1997\): the cart not put down$/);
  t.false(land.log.some(l => l.startsWith('cart on')));
  t.is(land.cart, undefined);
  t.like(line, { stage: 'whole', misses: 1 });
  t.falsy(line.stops);
  // a cart on the brake with a chicken in it, the line given up: broken, the chicken let out
  const b = lineWorld('laying');
  const two = new Field(b.world);
  await laidWhole(two, b.line);
  const end = b.line.cells[b.line.cells.length - 1];
  two.villagers.push({ id: 300, name: 'chicken', position: { x: end.x + 0.5, y: 63, z: end.z + 0.5 }, profession: 'none', level: 0, baby: false, health: 4 });
  two.cart = { id: 701, uuid: 'ca27-0002', pos: { x: end.x + 0.5, y: 63.06, z: end.z + 0.5 }, rider: 300 };
  b.line.cart = { uuid: 'ca27-0002' };
  b.line.stage = 'taking up';
  b.line.why = 'given up by hand';
  const up = await run(two, 'take up', 30 * MINUTE);
  t.regex(up.text, /the chicken \(300\) let out of the cart where it was/);
  t.falsy(two.cart);
});

test('two stops are given up only in a row: a clean day between (its end in time for the walk home) clears the count', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  land.line = line;
  land.players = [{ id: 9, name: 'player', position: { x: -540.5, y: 63, z: 2110.5 } }];
  await run(land, 'lay', 30 * MINUTE);
  t.is(line.stops, 1);
  land.players = [];
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const day2 = await run(land, 'lay', 100_000);
  t.regex(day2.text, /the day's end/);
  t.is(line.stops, 0);
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  land.blocks.set(k(line.cells[20]), 'oak_planks');
  const day3 = await run(land, 'lay', 30 * MINUTE);
  t.regex(day3.text, /stopped: rail .*oak_planks there now \(not as read when planned\)$/);
  t.is(line.stops, 1);
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), ['lay']);
});

test('a villager 30 off the fixed pickup (villagers keep round their village): brought to it by boat over the ground read, the boat taken up, then the cart and the hall as ever', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  for (const v of land.villagers) if (v.id === 106 || v.id === 107) v.profession = 'mason';
  land.villagers.find(v => v.id === 101)!.position = { x: -585.5, y: 63, z: 2000.5 };
  const log0 = land.log.length;
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^moved an unemployed villager from the village at \(-572, 63, 2000\) to the hall by the rails home \(1 in it now\)/);
  const did = land.log.slice(log0);
  t.true(did.includes('boat down, villager 101 in'), did.join(' | '));
  t.true(did.includes('drive to (-555.5, 2000.5)'), did.join(' | '));
  t.true(did.some(l => /^cart took villager 101, home to the brake/.test(l)), did.join(' | '));
  t.true(land.said.includes('rails: in the boat with the villager (101) at (-585, 63, 2000): to the pickup (-556, 63, 2000), 29 blocks in 1 leg(s)'), land.said.join(' | '));
  t.true(land.said.includes('rails: the villager (101) on the pickup (-556, 63, 2000)'), land.said.join(' | '));
  t.is(land.boat, undefined);
  t.is(peekVillages(world).boat, undefined);
  t.true(world.villagerMoves);
});

test('no villager the judge allows anywhere in the village on a move day is a miss, not a stop; after MISSES such runs the line is given up (and brain-status says so before the take-up runs)', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  for (const v of land.villagers) if (v.id === 101 || v.id === 106 || v.id === 107) v.profession = 'mason';
  const r = await run(land, 'move', 20 * MINUTE);
  t.is(r.text, 'the move not made: no unemployed villager the judge allows in the village at (-572, 63, 2000) to bring to the pickup at (-556, 63, 2000)');
  t.like(line, { stage: 'whole', misses: 1 });
  t.falsy(line.stops);
  t.false(land.log.some(l => /^boat down/.test(l)));
  line.misses = MISSES;
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), ['take up']);
  t.regex(railsHomeLine(world, land.t), new RegExp(`: to be taken up \\(the move not made on ${MISSES} runs: no unemployed villager .*\\): \\d+ block\\(s\\) down`));
});

/** A village that reaches 80 west of its bell (beds out there): the scans from the line's end see only part of it. */
/** A run set out near dusk: at the line's end it has the time for the move, not for a walk round the village. */
const BUDGET_TIGHT = 6.5 * MINUTE;
const wideVillage = (land: Field) => {
  land.marks.push({ name: 'white_bed', at: { x: -650, y: 63, z: 2040 } }, { name: 'white_bed', at: { x: -650, y: 63, z: 1960 } });
};
/** The village's free word (seen whole) given `ago` before the field's clock now. */
const judgedAgo = (world: WorldMemory, land: Field, ago: number) => {
  const s = world.villages!.sites[0];
  s.judged = { ...s.judged!, kind: 'free', v: JUDGE_V, at: land.t - ago };
  return s.judged.at;
};

test('the move day looks round the village as relook does (Nov 21: 45 of 132 chunks seen from the line\'s end, a miss): on to its viewpoints, carefully, judged free, back to the pickup, and the move goes on', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { scanSight: 48 });
  wideVillage(land);
  await laidWhole(land, line);
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  // (no free word seen whole within FRESH_FREE: the viewpoints are walked; with one, Nov 23, they are not)
  judgedAgo(world, land, FRESH_FREE + HOUR);
  const said0 = land.said.length;
  const r = await run(land, 'move', 20 * MINUTE);
  const said = land.said.slice(said0);
  t.true(said.some(l => /looking round the village from \(-?\d+, \d+\): \d+ of \d+ chunks seen/.test(l)), said.join('\n'));
  t.regex(r.text, /^moved an unemployed villager from the village at \(-572, 63, 2000\) to the hall by the rails home/);
  t.falsy(line.misses);
  t.falsy(line.stops);
});

test('a move day whose look waits (not all of the village seen, even from its viewpoints) is not made today: neither a miss nor a stop, nothing put down; a village seen whole with no villager to take is still a miss', async (t) => {
  {
    const { world, line } = lineWorld('laying');
    const land = new Field(world, { scanSight: 8 });
    wideVillage(land);
    await laidWhole(land, line);
    judgedAgo(world, land, FRESH_FREE + HOUR);
    line.misses = 3;
    const r = await run(land, 'move', 20 * MINUTE);
    t.regex(r.text, /^the move not made today: the village not judged free today: not all of it seen yet \(\d+ of \d+ chunks\)/);
    t.like(line, { stage: 'whole', misses: 3 });
    t.falsy(line.stops);
    t.is(r.mark, 'same');
    t.false(land.log.some(l => /^boat down|^cart on/.test(l)));
    // (the free word older than FRESH_FREE: the next day of it is a look-only day)
    t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), ['look']);
  }
  {
    // (the live case, Nov 21: set out near dusk, the run's time left at the line's end held the move but no viewpoint)
    const { world, line } = lineWorld('laying');
    const land = new Field(world, { scanSight: 48 });
    wideVillage(land);
    await laidWhole(land, line);
    land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
    judgedAgo(world, land, FRESH_FREE + HOUR);
    line.misses = 3;
    const said0 = land.said.length;
    const r = await run(land, 'move', BUDGET_TIGHT);
    t.false(land.said.slice(said0).some(l => /looking round the village from/.test(l)), land.said.slice(said0).join('\n'));
    t.regex(r.text, /^the move not made today: the village not judged free today: not all of it seen yet/);
    t.like(line, { stage: 'whole', misses: 3 });
    t.falsy(line.stops);
  }
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { scanSight: 48 });
  wideVillage(land);
  await laidWhole(land, line);
  for (const v of land.villagers) if (v.id === 101 || v.id === 106 || v.id === 107) v.profession = 'mason';
  judgedAgo(world, land, FRESH_FREE + HOUR);
  const said0 = land.said.length;
  const r = await run(land, 'move', 20 * MINUTE);
  t.true(land.said.slice(said0).some(l => /looking round the village from/.test(l)));
  t.regex(r.text, /^the move not made: no unemployed villager the judge allows in the village/);
  t.like(line, { stage: 'whole', misses: 1 });
  t.falsy(line.stops);
});

/** The live case of Nov 21 09:05Z: a move day out near dusk, the look from the line's end sees only part of the village. */
async function partialDay(ago: number, setup: (land: Field) => void = () => undefined) {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { scanSight: 48 });
  wideVillage(land);
  await laidWhole(land, line);
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const at = judgedAgo(world, land, ago);
  line.misses = 2;
  setup(land);
  const said0 = land.said.length;
  const log0 = land.log.length;
  const r = await run(land, 'move', BUDGET_TIGHT);
  return { world, line, land, at, r, said: land.said.slice(said0), did: land.log.slice(log0) };
}

test('a move day whose look sees only part of the village goes on with its free word seen whole less than FRESH_FREE ago (Nov 21: 42 of 121 chunks, then 101 of 132): the villagers this look saw, the hop and the cart; the word kept as it was', async (t) => {
  const { world, line, at, r, said, did } = await partialDay(2 * HOUR);
  const hhmm = new Date(at).toISOString().slice(11, 16);
  t.true(said.some(l => new RegExp(`^rails: the village as judged free at ${hhmm}Z \\(seen whole\\); today's look saw \\d+ of \\d+ chunks$`).test(l)), said.join('\n'));
  t.true(said.some(l => /^rails: the village at \(-572, 63, 2000\) is free to take from: \d+ villagers, \d+ unemployed adult\(s\) to take/.test(l)), said.join('\n'));
  t.true(did.some(l => /^cart took villager \d+, home to the brake/.test(l)), did.join(' | '));
  t.regex(r.text, /^moved an unemployed villager from the village at \(-572, 63, 2000\) to the hall by the rails home/);
  t.falsy(line.stops);
  // (the partial look's wait never written over the word seen whole: it ages past FRESH_FREE as ever)
  t.like(peekVillages(world).sites[0].judged, { kind: 'free', at, v: JUDGE_V });
});

test('a move day whose look sees only part of the village, its free word older than FRESH_FREE: not made today, neither a miss nor a stop', async (t) => {
  const { line, r, said, did } = await partialDay(FRESH_FREE + 10 * MINUTE);
  t.false(said.some(l => /as judged free at/.test(l)), said.join('\n'));
  t.regex(r.text, /^the move not made today: the village not judged free today: not all of it seen yet \(\d+ of \d+ chunks\)/);
  t.is(r.mark, 'same');
  t.like(line, { stage: 'whole', misses: 2 });
  t.falsy(line.stops);
  t.false(did.some(l => /^boat down|^cart on/.test(l)));
});

test('a move day\'s look that sees only part of the village never writes its wait over a free word kept, fresh or not', async (t) => {
  const { world, at, r } = await partialDay(FRESH_FREE + 10 * MINUTE);
  t.regex(r.text, /^the move not made today: the village not judged free today: not all of it seen yet/);
  t.like(peekVillages(world).sites[0].judged, { kind: 'free', at, v: JUDGE_V });
});

/** The village's word a wait (the live one of Nov 21 09:06Z, written over the free word by a move day before the fix). */
const waitKept = (world: WorldMemory, land: Field) => {
  const s = world.villages!.sites[0];
  s.judged = { at: land.t - HOUR, kind: 'wait', why: 'not all of it seen yet (101 of 132 chunks)', v: JUDGE_V };
};

test('no free word seen whole within FRESH_FREE (a wait kept): the rung takes a look-only day (early: it needs the whole look round), which walks the viewpoints, nothing of the move laid; free kept, the next run is the move and moves', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { scanSight: 48 });
  wideVillage(land);
  await laidWhole(land, line);
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  waitKept(world, land);
  line.misses = 2;
  const vs = railsTask.variants(snap(KIT(), { now: land.t }), world);
  t.deepEqual(vs.map(v => v.id), ['look']);
  const laid0 = line.laid.length;
  const said0 = land.said.length;
  const log0 = land.log.length;
  const r = await run(land, 'look', 12 * MINUTE);
  const said = land.said.slice(said0);
  t.true(said.some(l => /looking round the village from/.test(l)), said.join('\n'));
  t.true(said.some(l => /^rails: a look-only day at the village at \(-572, 63, 2000\) \((\d+) of \1 chunks seen\): free: /.test(l)), said.join('\n'));
  t.regex(r.text, /^the village at \(-572, 63, 2000\) looked at whole and judged free/);
  t.is(r.mark, 'same');
  t.like(line, { stage: 'whole', misses: 2 });
  t.falsy(line.yardOpen);
  t.is(line.laid.length, laid0);
  t.false(land.log.slice(log0).some(l => /^boat down|^cart on/.test(l)));
  const judged = peekVillages(world).sites[0].judged!;
  t.like(judged, { kind: 'free', v: JUDGE_V });
  t.true(land.t - judged.at < FRESH_FREE);
  // the next run: the move, on the free word kept (fresh)
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), ['move']);
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const m = await run(land, 'move', BUDGET_TIGHT);
  t.regex(m.text, /^moved an unemployed villager from the village at \(-572, 63, 2000\) to the hall by the rails home/);
});

test('a look-only day that still cannot see the village whole: not made today, neither a miss nor a stop; the wait kept, the next day a look-only day again', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { scanSight: 8 });
  wideVillage(land);
  await laidWhole(land, line);
  waitKept(world, land);
  line.misses = 2;
  const r = await run(land, 'look', 12 * MINUTE);
  t.true(land.said.some(l => /^rails: a look-only day at the village at \(-572, 63, 2000\) \(\d+ of \d+ chunks seen\): wait: not all of it seen yet/.test(l)));
  t.regex(r.text, /^the move not made today: the village not judged free today: not all of it seen yet/);
  t.is(r.mark, 'same');
  t.like(line, { stage: 'whole', misses: 2 });
  t.falsy(line.stops);
  t.falsy(line.yardOpen);
  t.is(peekVillages(world).sites[0].judged?.kind, 'wait');
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), ['look']);
});

test('a move day whose partial look sees two villagers named: someone\'s, the line given up, whatever its fresh free word', async (t) => {
  const { line, r, did } = await partialDay(2 * HOUR, land => { for (const v of land.villagers) if (v.id === 101 || v.id === 106) v.named = true; });
  t.regex(r.text, /^the line given up: the village at \(-572, 63, 2000\) is someone's: 2 villagers used by a player/);
  t.is(line.stage, 'taking up');
  t.false(did.some(l => /^boat down|^cart on/.test(l)));
});

test('a move day whose partial look goes on with the fresh free word, a player within 32 of the village: not made today, neither a miss nor a stop', async (t) => {
  const { line, r, said, did } = await partialDay(2 * HOUR, land => { land.players = [{ id: 9, name: 'player', position: { x: -590.5, y: 63, z: 2000.5 } }]; });
  t.true(said.some(l => /as judged free at/.test(l)), said.join('\n'));
  t.regex(r.text, /^the move not made today: a player at \(-591, 63, 2000\), \d+ from the (bot|village): no villager taken this run/);
  t.like(line, { stage: 'whole', misses: 2 });
  t.falsy(line.stops);
  t.false(did.some(l => /^boat down|^cart on/.test(l)));
});

// ------------------------------------------------------------------------------------------------ the extension

/**
 * The village's hillside (Nov 21, the west village: villagers up at y 75, the pickup at 69, "a step up (a boat climbs
 * nothing)"): a basin west of the line, its floor two up (the ground's top at 65), a rim a block higher all round it; on
 * its east side the ground steps down a block a block to the flat land (65 at x -588, 64 at -587). `wall`: the rim two
 * high instead, and no steps (nothing climbs out of it, rails or boats).
 */
function hillside(land: Field, opts: { wall?: boolean; wallHigh?: number } = {}) {
  const X1 = -612, X2 = -589, Z1 = 1980, Z2 = 2020;
  const top = (x: number, z: number, h: number) => { for (let y = 63; y < 63 + h; y++) land.blocks.set(k({ x, y, z }), y === 62 + h ? 'grass_block[snowy=false]' : 'dirt'); };
  for (let x = X1; x <= X2; x++) for (let z = Z1; z <= Z2; z++) {
    const rim = x === X1 || x === X2 || z === Z1 || z === Z2;
    top(x, z, rim ? (opts.wall ? 2 + (opts.wallHigh ?? 2) : 3) : 2);
  }
  if (!opts.wall) for (let z = Z1; z <= Z2; z++) { top(-588, z, 2); top(-587, z, 1); }
}
/** The villager uphill: 101 in the basin (the others to take employed), standing on a cell's middle. */
const uphill = (land: Field, at: Pos = { x: -598.5, y: 65, z: 2000.5 }) => {
  for (const v of land.villagers) if (v.id === 106 || v.id === 107) v.profession = 'mason';
  land.villagers.find(v => v.id === 101)!.position = { ...at };
};
/** What the extension takes besides what the move carries. */
const extKit = (land: Field) => land.items.push({ slot: 20, name: 'rail', count: 64 }, { slot: 21, name: 'powered_rail', count: 8 }, { slot: 22, name: 'redstone_torch', count: 8 });

test('a villager uphill of the pickup (no boat way climbs to it): the line extended into the village on the move day, every block in the record before it goes down, laid that run, the launch and the stop at its end; the move then made into the hall, and all of it taken back up', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  hillside(land);
  uphill(land);
  extKit(land);
  const oldLaunch = { ...line.cells[0] }, oldStop = { ...line.stop.at };
  const old = line.cells.map(c => ({ ...c }));
  const cells0 = line.cells.length;
  // every lay asked with its block in the record already, and in brain.json as last written
  const unrecorded: string[] = [];
  const lay = async (a: RailLay) => {
    const inRecord = (w: WorldMemory | undefined) => !!w?.rails?.line?.laid.some(b => b.at.x === a.at.x && b.at.y === a.at.y && b.at.z === a.at.z);
    if (!inRecord(world) || !inRecord(JSON.parse(land.saves[0] ?? '{}') as WorldMemory)) unrecorded.push(k(a.at));
    return land.lay(a);
  };
  const log0 = land.log.length, said0 = land.said.length;
  const r = await run(land, 'move', 20 * MINUTE, { rails: { lay, takeUp: land.takeUp, placeCart: land.placeCart } });
  const said = land.said.slice(said0), did = land.log.slice(log0);
  t.regex(r.text, /^moved an unemployed villager from the village at \(-572, 63, 2000\) to the hall by the rails home \(1 in it now\); everything of the line taken back up/, said.join('\n'));
  const ext = line.extended!;
  t.truthy(ext);
  t.true(said.some(l => /^rails: no boat way to the pickup at \(-556, 63, 2000\) for a villager to take \(1 tried\): from the villager \(101\) at \(-599, 65, 2000\)/.test(l)), said.join('\n'));
  // (joined where the fewest new rails reach the line: here 7 in from the old launch, a straight run east)
  const skip = old.findIndex(c => c.x === ext.from.x && c.y === ext.from.y && c.z === ext.from.z);
  t.true(skip >= 0 && skip < 40, JSON.stringify(ext.from));
  t.true(said.includes(`rails: the line extended into the village: ${ext.rails} rails (${ext.powered} powered) from (${ext.from.x}, ${ext.from.y}, ${ext.from.z}) to the new pickup (${ext.to.x}, ${ext.to.y}, ${ext.to.z})`), said.join('\n'));
  t.true(said.some(l => l.startsWith(`rails: the extension into the village is down: ${ext.rails} rails`)), said.join('\n'));
  // the extension: from a new head by the villager up in the basin, over the rim (a climb, lit), down the steps, to the old launch's cell
  t.is(line.cells.length, cells0 - skip + ext.rails - 1);
  t.is(ext.to.y, 65);
  t.true(horiz(ext.to, { x: -598.5, z: 2000.5 }) <= 6);
  const extCells = line.cells.slice(0, ext.rails);
  t.deepEqual(extCells[ext.rails - 1] && { x: extCells[ext.rails - 1].x, y: extCells[ext.rails - 1].y, z: extCells[ext.rails - 1].z }, { x: old[skip].x, y: old[skip].y, z: old[skip].z });
  t.true(extCells.some(c => c.role === 'climb' && c.kind === 'powered'), 'the rim is climbed on a lit powered rail');
  t.deepEqual(line.cells.filter(c => c.role === 'launch').map(c => k(c)), [k(line.cells[0])], 'one launch: the new head\'s');
  t.not(extCells[ext.rails - 1].role, 'launch');
  t.is(line.torches.filter(x => x.trigger).length, 1);
  t.true(line.torches.find(x => x.trigger)!.lights.x === line.cells[0].x && line.torches.find(x => x.trigger)!.lights.z === line.cells[0].z);
  // the cart rolls home along the whole of it: a lit rail at least every BOOST_GAP from the pickup to the brake
  const lit = line.cells.map((c, i) => (c.kind === 'powered' && c.role !== 'launch' ? i : -1)).filter(i => i >= 0);
  for (let j = 1; j < lit.length; j++) t.true(lit[j] - lit[j - 1] <= BOOST_GAP, `${lit[j - 1]} .. ${lit[j]}`);
  t.true(lit[0] - 5 >= 8, 'no lit rail within 7 of the new pickup');
  // the old launch's powered rail and the old stop taken up before the rails went down there
  const upLaunch = did.indexOf(`take up powered_rail ${k(oldLaunch)}`), upStop = did.indexOf(`take up cobblestone ${k(oldStop)}`);
  t.true(upLaunch >= 0 && upStop >= 0, did.join(' | '));
  t.true(skip > 0 || upLaunch < did.indexOf(`lay rail ${k(oldLaunch)}`) || extCells[ext.rails - 1].kind === 'powered');
  t.deepEqual(unrecorded, [], 'every block in the record before it went down');
  t.true(did.some(l => l === `cart on ${k(line.cells[0])}`), did.join(' | '));
  t.true(did.some(l => /^cart took villager 101, home to the brake/.test(l)), did.join(' | '));
  t.falsy(line.misses);
  t.falsy(line.stops);
  // everything taken back up: the extension, the old line, the old stop
  t.deepEqual(land.standing(line), []);
  for (const c of extCells) t.is(land.block(c.x, c.y, c.z), 'air', k(c));
  t.is(land.block(oldStop.x, oldStop.y, oldStop.z), 'air');
  t.is(peekLine(world), undefined);
  t.is(land.block(-556, 63, 2119), FENCE);
});

test('the extension cut short as it is laid (a restart): its blocks in the record, the next run lays on; the line given up takes all of it up, the old line and the extension', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  hillside(land);
  uphill(land);
  extKit(land);
  const oldStop = { ...line.stop.at };
  const abort = new AbortController();
  // (the yard's stretch is 6 lays, then the extension's)
  land.opts.abortAtLay = { n: land.lays + 6 + 12, abort };
  await t.throwsAsync(run(land, 'move', 20 * MINUTE, { signal: abort.signal }));
  t.is(line.stage, 'laying');
  t.truthy(line.extended);
  // the cut one written before it went down: in the record, not in the world; the rest stand as the record has them
  const standing = new Set(land.standing(line));
  // (the strays away from the line as planned now are left for the next laying, Nov 23: still in the record)
  const strays = new Set(straysOf(line).map(b => k(b.at)));
  const notDown = line.laid.filter(b => !standing.has(k(b.at)) && !strays.has(k(b.at)));
  t.is(notDown.length, 1, JSON.stringify(notDown));
  t.true(land.block(oldStop.x, oldStop.y, oldStop.z) !== 'cobblestone' || strays.has(k(oldStop)), 'the old stop up, or a stray of the record');
  // brain.json read back: the next run (the yard's stretch close up's) lays on to the new head
  const saved = JSON.parse(JSON.stringify(world)) as WorldMemory;
  land.world = saved;
  land.opts.abortAtLay = undefined;
  const again = peekLine(saved)!;
  land.line = again;
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), saved).map(v => v.id), ['lay']);
  const said0 = land.said.length;
  const r = await run(land, 'lay', 30 * MINUTE);
  t.regex(r.text, /^the line is whole: \d+ rails/, land.said.slice(said0).join('\n'));
  t.true(land.said.slice(said0).some(l => l.startsWith(`rails: the extension into the village is down: ${again.extended!.rails} rails`)), land.said.slice(said0).join('\n'));
  t.deepEqual(straysOf(again), [], 'the strays left by the move day taken up by the laying');
  t.not(land.block(oldStop.x, oldStop.y, oldStop.z), 'cobblestone', 'the old stop up');
  t.deepEqual(land.standing(again).filter(p => !yardSteps(again).some(st => k(stepAt(again, st)) === p)).sort(), again.laid.map(b => k(b.at)).filter(p => !yardSteps(again).some(st => k(stepAt(again, st)) === p)).sort());
  // given up (the switch off): every block of it taken back up, the extension's too
  saved.railsHome = false;
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), saved).map(v => v.id), ['take up']);
  const up = await run(land, 'take up', 30 * MINUTE);
  t.regex(up.text, /everything of the line taken back up \(the rails switch is off\)/);
  t.deepEqual(land.standing(again), []);
  for (const c of again.cells) t.false(/rail/.test(land.block(c.x, c.y, c.z)), k(c));
  t.is(peekLine(saved), undefined);
});

/**
 * The hillside's basin with a bumpy floor (Nov 21, the west village up its hill: no straight, level run of 7 by any
 * villager): every other cell of it a block up, a checkerboard, so that no two cells side by side are level; a path of
 * the village across it (z 2003) and a bed by it, both never to be dug.
 */
function bumpy(land: Field) {
  hillside(land);
  for (let x = -611; x <= -590; x++) for (let z = 1981; z <= 2019; z++) {
    if (z === 2003) { land.blocks.set(k({ x, y: 64, z }), 'dirt_path'); continue; }
    if (((x + z) & 1) === 0) continue;
    land.blocks.set(k({ x, y: 64, z }), 'dirt');
    land.blocks.set(k({ x, y: 65, z }), 'grass_block[snowy=false]');
  }
  land.marks.push({ name: 'white_bed', at: { x: -594, y: 65, z: 1996 } });
}
/** What the extension's earthworks cut and fill, by the world's log: each cut's block, each fill's place. */
const cutsOf = (land: Field, from = 0) => land.log.slice(from).filter(l => /^cut /.test(l)).map(l => ({ block: l.split(' ')[1], at: l.split(' ')[2] }));

test('a hillside village with no level run by any villager (Nov 21): the head levelled right beside the villager, its cuts and fills in the record before each is made, laid, the move made; the take-up puts the cut ground back and takes the fills up, nothing of the village dug', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  bumpy(land);
  uphill(land, { x: -597.5, y: 65, z: 2000.5 });
  extKit(land);
  const before = new Map<string, string>();
  const early: string[] = [];
  const inRecord = (p: Pos, op: 'cut' | 'fill') => [world, JSON.parse(land.saves[0] ?? '{}') as WorldMemory].every(w => !!w?.rails?.line?.earth?.some(e => e.op === op && e.x === p.x && e.y === p.y && e.z === p.z && !e.done));
  const cut = async (p: Pos, was: string) => { if (!before.has(k(p))) before.set(k(p), land.block(p.x, p.y, p.z)); if (!inRecord(p, 'cut')) early.push(`cut ${k(p)}`); return land.cut(p, was); };
  const lay = async (a: RailLay) => {
    if (a.item === 'cobblestone' && world.rails?.line?.earth?.some(e => e.op === 'fill' && e.x === a.at.x && e.y === a.at.y && e.z === a.at.z)) {
      if (!before.has(k(a.at))) before.set(k(a.at), land.block(a.at.x, a.at.y, a.at.z));
      if (!inRecord(a.at, 'fill')) early.push(`fill ${k(a.at)}`);
    }
    return land.lay(a);
  };
  const log0 = land.log.length, said0 = land.said.length;
  const r = await run(land, 'move', 20 * MINUTE, { rails: { lay, takeUp: land.takeUp, placeCart: land.placeCart, cut, restore: land.restore } });
  const said = land.said.slice(said0), did = land.log.slice(log0);
  t.regex(r.text, /^moved an unemployed villager from the village at \(-572, 63, 2000\) to the hall by the rails home \(1 in it now\); everything of the line taken back up/, said.join('\n'));
  const ext = line.extended!;
  t.truthy(ext);
  // no head stood as the ground is: levelled by the villager, at the level it stands at, within EARTH_NEAR of it
  t.true(said.some(l => /^rails: the ground levelled for it: \d+ cut\(s\) \((grass_block|dirt)(, (grass_block|dirt))?\), \d+ fill\(s\) of cobblestone/.test(l)), said.join('\n'));
  t.is(ext.to.y, 65);
  t.true(Math.max(Math.abs(ext.to.x + 0.5 - -597.5), Math.abs(ext.to.z + 0.5 - 2000.5)) <= 3.5, JSON.stringify(ext.to));
  const head = line.cells.slice(0, 6);
  t.true(head.every(c => c.y === 65), 'the head level');
  t.true(did.some(l => /^cart took villager 101, home to the brake/.test(l)), did.join(' | '));
  // every cut and fill in the record before it was made; the cuts natural ground only, within the limits
  t.deepEqual(early, []);
  const cuts = cutsOf(land, log0);
  t.true(cuts.length > 0);
  t.true(before.size <= 40, `${before.size} cuts and fills`);
  t.true(cuts.every(c => /^(grass_block|dirt)$/.test(c.block)), JSON.stringify(cuts));
  const cols = new Map<string, number>();
  for (const p of before.keys()) { const [x, , z] = p.split(','); cols.set(`${x},${z}`, (cols.get(`${x},${z}`) ?? 0) + 1); }
  t.true([...cols.values()].every(n => n <= 2), 'at most two a column');
  // nothing of the village: the path, under the villager, by the bed or the bell
  for (const c of cuts) {
    const [x, y, z] = c.at.split(',').map(Number);
    t.not(z, 2003, `the path: ${c.at}`);
    t.false(Math.abs(x + 0.5 - -597.5) < 0.9 && Math.abs(z + 0.5 - 2000.5) < 0.9, `under the villager: ${c.at}`);
    t.false(land.marks.some(m => Math.abs(m.at.x - x) <= 1 && Math.abs(m.at.z - z) <= 1 && Math.abs(m.at.y - y) <= 2), `by a bed or a bell: ${c.at}`);
  }
  t.false(did.some(l => /^cut dirt_path|^dig dirt_path/.test(l)));
  for (let x = -611; x <= -590; x++) t.is(land.block(x, 64, 2003), 'dirt_path');
  t.deepEqual(land.underBot, []);
  // the take-up: the fills up, the cut ground back as it was (a grass block as dirt)
  for (const [p, was] of before) {
    const now = land.block(...(p.split(',').map(Number) as [number, number, number]));
    t.is(idOf(now), idOf(was) === 'grass_block' ? 'dirt' : idOf(was), `${p}: ${was} -> ${now}`);
  }
  t.deepEqual(land.standing(line), []);
  t.is(peekLine(world), undefined);
});

test('earthworks cut short (a restart after some cuts, before their rails): the record holds every cut, made or not; given up, the take-up fills the made ones back and finds the rest as they were, nothing left', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  bumpy(land);
  uphill(land, { x: -597.5, y: 65, z: 2000.5 });
  extKit(land);
  const abort = new AbortController();
  // (the yard's stretch is 6 lays; the extension's first rails go down after their columns' cuts)
  land.opts.abortAtLay = { n: land.lays + 6 + 47, abort };
  const log0 = land.log.length;
  await t.throwsAsync(run(land, 'move', 20 * MINUTE, { signal: abort.signal }));
  const saved = JSON.parse(land.saves[0]) as WorldMemory;
  const again = peekLine(saved)!;
  t.truthy(again.earth?.length);
  const made = cutsOf(land, log0).map(c => c.at);
  t.true(made.length > 0);
  t.true(made.every(p => again.earth!.some(w => w.op === 'cut' && k(w) === p)), 'every cut made is in the record');
  t.true(again.earth!.some(w => !w.done), 'and the ones not made yet');
  // given up: all of it taken up, the cut ground back
  land.world = saved;
  land.opts.abortAtLay = undefined;
  land.line = again;
  saved.railsHome = false;
  const up = await run(land, 'take up', 30 * MINUTE);
  t.regex(up.text, /everything of the line taken back up \(the rails switch is off\)/, up.text);
  for (const p of made) t.is(land.block(...(p.split(',').map(Number) as [number, number, number])), 'dirt', p);
  t.deepEqual(land.standing(again), []);
  t.is(peekLine(saved), undefined);
});

/** A fence of someone's planks round the line's end (Nov 21: the way to the old end blocked 10 short of it): three high, from z 1990 to 2004. */
function walledEnd(land: Field) {
  for (let y = 63; y <= 65; y++) {
    for (let z = 1990; z <= 2004; z++) { land.blocks.set(k({ x: -558, y, z }), 'oak_planks'); land.blocks.set(k({ x: -554, y, z }), 'oak_planks'); }
    for (let x = -558; x <= -554; x++) land.blocks.set(k({ x, y, z: 1990 }), 'oak_planks');
  }
}

test('a head whose way to the line\'s end is blocked joins the line further on (JOIN_TAIL): the rails before the join, the old stop and trigger in the record as strays and taken up before the extension goes down; the cart\'s way home lit within BOOST_GAP; the move made, all of it taken up', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  hillside(land);
  uphill(land);
  extKit(land);
  walledEnd(land);
  const old = line.cells.map(c => ({ ...c }));
  const oldStop = { ...line.stop.at };
  // (the bypassed rails as strays in the record when they come up: written there, not forgotten)
  const upAt: string[] = [];
  const takeUp = async (at: Pos, item?: string) => {
    const l = world.rails?.line;
    if (l?.extended && l.laid.some(b => k(b.at) === k(at)) && !l.cells.some(c => k(c) === k(at))) upAt.push(k(at));
    return land.takeUp(at, item);
  };
  const log0 = land.log.length, said0 = land.said.length;
  const r = await run(land, 'move', 20 * MINUTE, { rails: { lay: land.lay, takeUp, placeCart: land.placeCart, cut: land.cut, restore: land.restore } });
  const said = land.said.slice(said0), did = land.log.slice(log0);
  t.regex(r.text, /^moved an unemployed villager from the village at \(-572, 63, 2000\) to the hall by the rails home \(1 in it now\); everything of the line taken back up/, said.join('\n'));
  const m = said.map(l => /^rails: it joins the line (\d+) rails in from its old launch/.exec(l)).find(Boolean);
  t.truthy(m, said.join('\n'));
  const skip = Number(m![1]);
  t.true(skip >= 10, `joined ${skip} in (the wall reaches z 2004)`);
  // the extension ends on the old line's cell at the join, which goes on into the line kept
  const ext = line.extended!;
  t.deepEqual({ x: line.cells[ext.rails - 1].x, z: line.cells[ext.rails - 1].z }, { x: old[skip].x, z: old[skip].z });
  t.deepEqual(line.cells.slice(ext.rails).map(c => k(c)), old.slice(skip + 1).map(c => k(c)));
  // the bypassed rails and the old stop taken up (as strays) before the first rail of the extension went down
  const firstLay = did.findIndex(l => /^lay /.test(l) && !/,2119$|,212[0-9]$/.test(l) && line.cells.slice(0, ext.rails - 1).some(c => l.endsWith(k(c))));
  // (those within 2 of the line as planned now first, Nov 23; the rest by the take-up after the move)
  const byLine = (p: Pos) => line.cells.some(c => Math.abs(c.x - p.x) <= 2 && Math.abs(c.z - p.z) <= 2 && Math.abs(c.y - p.y) <= 2);
  for (const c of old.slice(0, skip)) {
    const i = did.indexOf(`take up ${c.kind === 'rail' ? 'rail' : 'powered_rail'} ${k(c)}`);
    t.true(i >= 0 && (!byLine(c) || i < firstLay), `${k(c)} up${byLine(c) ? ' first' : ''}`);
    t.true(upAt.includes(k(c)), `${k(c)} a stray of the record`);
  }
  const stopUp = did.indexOf(`take up cobblestone ${k(oldStop)}`);
  t.true(stopUp >= 0 && (!byLine(oldStop) || stopUp < firstLay));
  // the cart's way home lit: a lit rail at least every BOOST_GAP from the new pickup to the brake
  const lit = line.cells.map((c, i) => (c.kind === 'powered' && c.role !== 'launch' ? i : -1)).filter(i => i >= 0);
  for (let j = 1; j < lit.length; j++) t.true(lit[j] - lit[j - 1] <= BOOST_GAP, `${lit[j - 1]} .. ${lit[j]}`);
  t.true(lit[0] - 5 >= 8, 'no lit rail within 7 of the new pickup');
  t.deepEqual(line.cells.slice(-2).map(c => c.kind), ['brake', 'brake'], 'the brake as it was');
  t.true(did.some(l => /^cart took villager 101, home to the brake/.test(l)), did.join(' | '));
  t.deepEqual(land.standing(line), []);
  for (const c of old) t.false(/rail/.test(land.block(c.x, c.y, c.z)), k(c));
  t.is(peekLine(world), undefined);
});

test('a levelled head joining the line further on: its cuts and fills, the join\'s way among them, counted together in EARTH_MAX', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  bumpy(land);
  walledEnd(land);
  uphill(land, { x: -597.5, y: 65, z: 2000.5 });
  const g = new Ground(55, 29);
  for (let x = -625; x <= -540; x++) for (let z = 1960; z <= 2060; z++) for (let y = 55; y < 84; y++) g.set(x, y, z, land.block(x, y, z));
  const v101 = { id: 101, name: 'villager', position: { x: -597.5, y: 65, z: 2000.5 }, profession: 'none' } as Seen;
  const look = { jobs: [], beds: land.marks.filter(m => /_bed$/.test(m.name)).map(m => m.at), bells: [{ ...BELL }], zones: [], seen: [v101] };
  const args = { noWay: [v101], order: [v101], look, v: { own: [], outposts: [] }, area: world.villages!.sites[0].area, yard: YARD, earth: true };
  const r = extensionFor(line, g, args);
  t.true(r.ok, r.ok ? '' : r.why);
  if (!r.ok) return;
  t.true(r.skip >= 10, `joined ${r.skip} in`);
  t.true(r.earth.length > 0 && r.earth.length <= EARTH_MAX);
  // one fewer allowed than this way takes: the whole extension's count is what is held to it (another way may be found,
  // never one over the cap)
  const less = extensionFor(line, g, { ...args, earthMax: r.earth.length - 1 });
  if (less.ok) t.true(less.earth.length <= r.earth.length - 1);
  const none = extensionFor(line, g, { ...args, earthMax: 2 });
  t.false(none.ok);
});

test('the earthworks\' limits: no more than EARTH_MAX cuts and fills (a tighter cap finds none), no more than two a column, nothing but natural ground; too many is no extension, the move not made today and no miss', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  bumpy(land);
  uphill(land, { x: -597.5, y: 65, z: 2000.5 });
  const g = new Ground(55, 29);
  for (let x = -625; x <= -540; x++) for (let z = 1960; z <= 2040; z++) for (let y = 55; y < 84; y++) g.set(x, y, z, land.block(x, y, z));
  const v101 = { id: 101, name: 'villager', position: { x: -597.5, y: 65, z: 2000.5 }, profession: 'none' } as Seen;
  const look = { jobs: [], beds: land.marks.filter(m => /_bed$/.test(m.name)).map(m => m.at), bells: [{ ...BELL }], zones: [], seen: [v101] };
  const args = { noWay: [v101], order: [v101], look, v: { own: [], outposts: [] }, area: world.villages!.sites[0].area, yard: YARD, earth: true };
  const ok = extensionFor(line, g, args);
  t.true(ok.ok, ok.ok ? '' : ok.why);
  if (ok.ok) {
    t.true(ok.earth.length > 0 && ok.earth.length <= EARTH_MAX);
    t.true(ok.earth.filter(w => w.op === 'cut').every(w => earthCuttable(w.was)));
    const per = new Map<string, number>();
    for (const w of ok.earth) per.set(`${w.x},${w.z}`, (per.get(`${w.x},${w.z}`) ?? 0) + 1);
    t.true([...per.values()].every(n => n <= 2));
    const tight = extensionFor(line, g, { ...args, earthMax: 3 });
    t.false(tight.ok);
    t.regex(tight.ok ? '' : tight.why, /levelled by a villager: no (pickup by a villager to take: no head of 7 rails .* 3 in all|rails way to the line's end .*3 in all\))/);
  }
  // with no earthworks in the runtime, none: as before
  t.false(extensionFor(line, g, { ...args, earth: false }).ok);
  // a cut beside water, a cut under gravel, a fill on a path: none
  const at = (m: Record<string, string>) => (x: number, y: number, z: number) => m[`${x},${y},${z}`] ?? (y < 64 ? 'dirt' : 'air');
  t.deepEqual(earthFor(at({}), 0, 64, 0, 'rail', () => true), []);
  t.is(earthFor(at({ '0,64,0': 'dirt', '1,64,0': 'water[level=0]' }), 0, 64, 0, 'rail', () => true), undefined);
  t.is(earthFor(at({ '0,64,0': 'dirt', '0,65,0': 'gravel', '0,66,0': 'gravel' }), 0, 64, 0, 'rail', () => true), undefined);
  t.is(earthFor(at({ '0,63,0': 'air', '0,62,0': 'dirt_path' }), 0, 64, 0, 'rail', () => true), undefined);
  t.is(earthFor(at({ '0,64,0': 'oak_planks' }), 0, 64, 0, 'rail', () => true), undefined);
  t.is(earthFor(at({ '0,64,0': 'iron_ore' }), 0, 64, 0, 'rail', () => true), undefined);
  t.is(earthFor(at({ '0,64,0': 'dirt' }), 0, 64, 0, 'rail', () => false), undefined, 'a cell kept off (a villager, a bed, a house)');
  t.deepEqual(earthFor(at({ '0,63,0': 'air', '0,62,0': 'air' }), 0, 64, 0, 'rail', () => true)?.map(w => `${w.op} ${w.y}`), ['fill 63', 'fill 62']);
  t.is(earthFor(at({ '0,63,0': 'air', '0,62,0': 'air', '0,61,0': 'air' }), 0, 64, 0, 'rail', () => true), undefined, 'a fill three high');
  t.deepEqual(earthFor(at({ '0,64,0': 'grass_block', '0,65,0': 'dirt' }), 0, 64, 0, 'rail', () => true)?.map(w => `${w.op} ${w.y}`), ['cut 64', 'cut 65']);
  t.is(earthFor(at({ '0,64,0': 'dirt', '0,65,0': 'dirt', '0,66,0': 'dirt' }), 0, 64, 0, 'rail', () => true), undefined, 'a cut under ground left hanging');
  t.is(refillOf('grass_block[snowy=false]', i => (i === 'dirt' ? 3 : 0)), 'dirt');
  t.is(refillOf('stone', i => (i === 'cobblestone' ? 3 : 0)), 'cobblestone');
  t.is(refillOf('andesite', i => (i === 'andesite' ? 1 : 0)), 'andesite');
  t.is(refillOf('sand', () => 0), undefined);
});

test('a failed real hop (the dry check found a way, the boat stopped on it): the extension planned and laid in the same run, by the villager where it was let out, and the move made from its new pickup; no miss', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { stallDrives: 1 });
  await laidWhole(land, line);
  extKit(land);
  for (const v of land.villagers) if (v.id === 106 || v.id === 107) v.profession = 'mason';
  land.villagers.find(v => v.id === 101)!.position = { x: -585.5, y: 63, z: 2000.5 };
  const log0 = land.log.length, said0 = land.said.length;
  const r = await run(land, 'move', 20 * MINUTE);
  const said = land.said.slice(said0), did = land.log.slice(log0);
  t.regex(r.text, /^moved an unemployed villager from the village at \(-572, 63, 2000\) to the hall by the rails home/, said.join('\n'));
  t.true(said.includes('rails: the hop to the pickup stopped: a step up ahead at (-570, 63, 2000)'), said.join('\n'));
  t.true(said.some(l => /^rails: the boat's hop did not bring a villager to the pickup at \(-556, 63, 2000\): the hop to the pickup stopped/.test(l)), said.join('\n'));
  t.truthy(line.extended);
  t.true(horiz(line.extended!.to, { x: -585.5, z: 2000.5 }) <= 16, JSON.stringify(line.extended));
  t.true(did.some(l => /^cart took villager 101, home to the brake/.test(l)), did.join(' | '));
  t.falsy(line.misses);
  t.is(peekLine(world), undefined);
});

test('a failed real hop with no extension left to try (EXTENSIONS made): the day a miss, as before; the boat back, the villager let out in its village', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { stallDrives: 1 });
  await laidWhole(land, line);
  for (const v of land.villagers) if (v.id === 106 || v.id === 107) v.profession = 'mason';
  land.villagers.find(v => v.id === 101)!.position = { x: -585.5, y: 63, z: 2000.5 };
  line.extended = { at: T0, from: { ...line.cells[0] }, to: { ...line.pickup }, rails: 1, powered: 0, times: EXTENSIONS };
  const r = await run(land, 'move', 20 * MINUTE);
  t.is(r.text, 'the move not made: the hop to the pickup stopped (a step up ahead at (-570, 63, 2000)): the villager let out at (-585, 63, 2000), the boat taken back up');
  t.like(line, { stage: 'whole', misses: 1 });
  t.is(land.count('oak_boat'), 1);
  t.true(world.villagerMoves);
});

test('the villagers in a hollow walled two high (no boat climbs out, no rail over it as the ground is): the way levelled through the wall, a cut two deep, and a fill under the drop outside; every cut and fill in the record before it is made, the move made, and the ground put back as it was by the take-up', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  hillside(land, { wall: true });
  uphill(land);
  extKit(land);
  const before = new Map<string, string>();
  const at0 = (p: Pos) => { if (!before.has(k(p))) before.set(k(p), land.block(p.x, p.y, p.z)); };
  const early: string[] = [];
  const inRecord = (p: Pos, op: 'cut' | 'fill') => [world, JSON.parse(land.saves[0] ?? '{}') as WorldMemory].every(w => !!w?.rails?.line?.earth?.some(e => e.op === op && e.x === p.x && e.y === p.y && e.z === p.z && !e.done));
  const cut = async (p: Pos, was: string) => { at0(p); if (!inRecord(p, 'cut')) early.push(`cut ${k(p)}`); return land.cut(p, was); };
  const lay = async (a: RailLay) => {
    const fill = a.item === 'cobblestone' && !!world.rails?.line?.earth?.some(e => e.op === 'fill' && e.x === a.at.x && e.y === a.at.y && e.z === a.at.z);
    if (fill) { at0(a.at); if (!inRecord(a.at, 'fill')) early.push(`fill ${k(a.at)}`); }
    return land.lay(a);
  };
  const said0 = land.said.length;
  const r = await run(land, 'move', 20 * MINUTE, { rails: { lay, takeUp: land.takeUp, placeCart: land.placeCart, cut, restore: land.restore } });
  const said = land.said.slice(said0);
  t.regex(r.text, /^moved an unemployed villager from the village at \(-572, 63, 2000\) to the hall by the rails home \(1 in it now\); everything of the line taken back up/, said.join('\n'));
  t.true(said.some(l => /^rails: the ground levelled for it: \d+ cut\(s\) \((grass_block|dirt)(, (grass_block|dirt))?\), \d+ fill\(s\) of cobblestone; every one in the record, put back by the take-up$/.test(l)), said.join('\n'));
  t.deepEqual(early, [], 'every cut and fill in the record before it was made');
  t.true(before.size > 0);
  // (through the rim: its two cells over the rail's cut, the top one first; the drop outside filled under the rail, and
  // in the take-up the cuts filled back from the bottom up)
  const dug = land.log.filter(l => /^(cut|restore) /.test(l));
  const rim = dug.filter(l => /^cut /.test(l)).map(l => l.split(' ')[2]);
  t.is(rim.length, 2, dug.join(' | '));
  t.is(Number(rim[0].split(',')[1]), Number(rim[1].split(',')[1]) + 1, 'the top one first');
  const back = dug.filter(l => /^restore /.test(l)).map(l => l.split(' ')[2]);
  t.deepEqual(back, [rim[1], rim[0]], 'filled back from the bottom up');
  const fills = [...before].filter(([, was]) => idOf(was) === 'air').map(([p]) => p);
  t.true(fills.length >= 1);
  t.true(fills.every(p => line.cells.some(c => k({ x: c.x, y: c.y - 1, z: c.z }) === p)), 'each fill under a rail');
  // the take-up: the fills gone, the cuts filled back with the kind they were (a grass block as dirt: no silk touch)
  for (const [p, was] of before) {
    const now = land.block(...(p.split(',').map(Number) as [number, number, number]));
    t.is(idOf(now), idOf(was) === 'grass_block' ? 'dirt' : idOf(was), `${p}: ${was} -> ${now}`);
  }
  t.deepEqual(land.underBot, []);
  t.is(peekLine(world), undefined);
  t.falsy(world.rails?.line);
});

test('an extension that cannot be planned (the villagers in a hollow walled four high: no boat or rail climbs out, and the earthworks may cut and fill no more than two a column): the move not made today, not a miss, nothing laid, dug or taken up', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  hillside(land, { wall: true, wallHigh: 4 });
  uphill(land);
  extKit(land);
  const cells0 = line.cells.length, laid0 = line.laid.length;
  const log0 = land.log.length;
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^the move not made today: no boat way to the pickup at \(-556, 63, 2000\) for a villager to take \(1 tried\): .*; and no extension of the line into the village: /);
  t.like(line, { stage: 'whole' });
  t.falsy(line.misses);
  t.falsy(line.stops);
  t.is(line.extended, undefined);
  t.is(line.cells.length, cells0);
  // (nothing laid or taken up out there: the yard's stretch only, close up's)
  t.deepEqual(land.log.slice(log0).filter(l => /^(lay|take up|cut|restore) /.test(l) && Number(l.split(',')[2]) < 2119), []);
  t.is(line.earth, undefined);
  t.regex(r.text, /levelled by a villager: no rails way to the line's end at \(-556, 63, 1995\) \(or any of the \d+ cells on from it\) \(at most 2 cut or filled a column, 40 in all\)/);
  t.is(land.block(-556, 63, 1994), 'cobblestone', 'the stop as it was');
  t.is(line.laid.filter(b => b.at.z < 2119).length, laid0, 'the line out there as it was');
});

test('a rails run left open by a restart (its end never written) claims no death hours later; one within its time still gives the line up', (t) => {
  const a = lineWorld('laying');
  a.line.run = { at: T0 };
  const s = (now: number) => snap(KIT(), { now });
  const lines = workTick(s(T0 + 3 * HOUR), a.world, () => ({ time: T0 + 3 * HOUR, at: { x: 100, y: 12, z: 100 } }), [railsTask]);
  t.false(lines.some(l => /^rails:/.test(l)), lines.join(' | '));
  t.is(a.line.stage, 'laying');
  t.is(a.line.run.end, T0 + railsTask.budgetMs + 2 * MINUTE, 'the run closed at its timeout');
  const b = lineWorld('laying');
  b.line.run = { at: T0 };
  const in5 = workTick(s(T0 + 6 * MINUTE), b.world, () => ({ time: T0 + 5 * MINUTE, at: { x: -556, y: 63, z: 2050 } }), [railsTask]);
  t.true(in5.some(l => /^rails: giving up the line: a death on a rails run/.test(l)), in5.join(' | '));
});

test('a rail that went down but whose reply was lost (the call timed out) is read, kept in the record and laid on from; all of it taken back up after', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { lostAt: 5 });
  land.line = line;
  const r = await run(land, 'lay', 30 * MINUTE);
  t.regex(r.text, /^the line is whole/);
  const fifth = k(line.cells[goalOf(line) - 4]);
  t.true(line.laid.some(b => k(b.at) === fifth));
  t.deepEqual(land.standing(line).sort(), line.laid.map(b => k(b.at)).sort());
  world.railsHome = false;
  await run(land, 'take up', 30 * MINUTE);
  t.deepEqual(land.standing(line), []);
  t.is(peekLine(world), undefined);
});

test('a block put over the line since it was laid stops the move on its way out (the villager\'s head would pass in it)', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  land.blocks.set(k({ ...line.cells[60], y: 64 }), 'oak_planks');
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /stopped: the move not made: oak_planks over it at \(-556, 63, 2055\): over the line now$/);
  t.false(land.log.some(l => l.startsWith('cart on')));
});

test('a block the take-up never reaches does not hold the rest: everything else comes up, and after UP_TRIES runs it is left, said', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  land.line = line;
  await run(land, 'lay', 100_000);
  const far = line.laid[3].at;
  land.opts.unreach = [k(far)];
  world.railsHome = false;
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const first = await run(land, 'take up', 30 * MINUTE);
  t.regex(first.text, /not reached: out of reach or out of sight; again next run/);
  t.deepEqual(land.standing(line), [k(far)]);
  for (let i = 1; i < UP_TRIES; i++) await run(land, 'take up', 30 * MINUTE);
  t.is(peekLine(world), undefined);
  t.regex(world.rails!.last!.text, /left: rail \(-556, 63, 2115\): not reached on 3 runs/);
});

test('the take-up finds a cart stopped out on the line, out of sight from home, as its walk passes it: broken there, the villager let out where it is', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { stuckAt: 20, sight: 96 });
  await laidWhole(land, line);
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^the move given up: the cart came to rest short of the brake/);
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const up = await run(land, 'take up', 30 * MINUTE);
  t.regex(up.text, /the villager \(101\) let out of the cart where it was/);
  t.notRegex(up.text, /the cart left: not found/);
  t.is(land.cart, undefined);
  t.deepEqual(land.standing(line), []);
});

test('switched off mid-run (the villager-moves tool pauses no run): nothing more is laid, no stop counted, the take-up next', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { offAtLay: 10 });
  land.line = line;
  const r = await run(land, 'lay', 30 * MINUTE);
  t.regex(r.text, /^laid 10 today; the rails switch \(or the villager moves\) went off: nothing more laid$/);
  t.is(land.lays, 10);
  t.falsy(line.stops);
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), ['take up']);
});

test('a cart put down whose reply was lost is found by cart.status and named, so the take-up breaks it', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { cartLost: true });
  await laidWhole(land, line);
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^the line given up: no minecart on the launch at \(-556, 63, 1995\): bridge call cart.place timed out$/);
  t.like(line.cart, { uuid: 'ca27-0001' });
  await run(land, 'take up', 30 * MINUTE);
  t.is(land.cart, undefined);
  t.deepEqual(land.standing(line), []);
});

test('a take-up whose dig lost its reply (a timeout, the bridge dropped) leaves nothing for good: the block, still standing and the bot\'s, is tried again next run and comes up', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  land.line = line;
  await run(land, 'lay', 100_000);
  const p = line.laid[3].at;
  land.opts.digLost = { [k(p)]: 1 };
  world.railsHome = false;
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const first = await run(land, 'take up', 30 * MINUTE);
  t.regex(first.text, /rail \(-556, 63, 2115\) not reached: bridge call dig.here timed out after 25000 ms; again next run/);
  t.deepEqual(land.standing(line), [k(p)]);
  t.true(line.laid.some(b => k(b.at) === k(p)), 'still in the record');
  t.falsy(line.left);
  await run(land, 'take up', 30 * MINUTE);
  t.deepEqual(land.standing(line), []);
  t.is(peekLine(world), undefined);
  t.notRegex(world.rails!.last!.text, /left:/);
});

test('a run stopped as the cart goes down on the launch leaves it named: by its answer when it came, by its place (written first) when a kill took the answer; after a restart the take-up finds it there and takes it up', async (t) => {
  // the answer came as the run was stopped: named before the stop is heeded
  const a = lineWorld('laying');
  const one = new Field(a.world);
  await laidWhole(one, a.line);
  const ab = new AbortController();
  one.opts.cartAbort = { abort: ab };
  await t.throwsAsync(run(one, 'move', 20 * MINUTE, { signal: ab.signal }));
  t.like(peekLine(JSON.parse(one.saves[0]) as WorldMemory), { stage: 'moving', cart: { uuid: 'ca27-0001' } });
  // the answer never came (killed): the launch written before the call, the cart found there by its place
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  const ab2 = new AbortController();
  land.opts.cartAbort = { abort: ab2, lost: true };
  await t.throwsAsync(run(land, 'move', 20 * MINUTE, { signal: ab2.signal }));
  t.truthy(land.cart, 'the cart on the launch');
  const disk = JSON.parse(land.saves[0]) as WorldMemory;
  const l2 = peekLine(disk)!;
  t.is(l2.cart, undefined);
  t.deepEqual(l2.cartAt, { x: line.cells[0].x, y: line.cells[0].y, z: line.cells[0].z });
  // the restart: the client's own set gone, the bot at home (the launch out of sight: the move not made, the cart kept in mind)
  land.world = disk;
  land.line = l2;
  land.opts.cartAbort = undefined;
  land.opts.forgotOwn = true;
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /cut short before the cart went down/);
  t.truthy(l2.cartAt);
  // given up: the take-up's walk comes to the launch, finds the cart there and breaks it before the launch's rail goes
  disk.railsHome = false;
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const up = await run(land, 'take up', 30 * MINUTE);
  t.regex(up.text, /everything of the line taken back up/);
  t.is(land.cart, undefined);
  t.is(land.count('minecart'), 1);
  t.deepEqual(land.standing(l2), []);
  t.is(peekLine(disk), undefined);
});

test('the cart broken at the brake with its reply lost, or a restart before that was written: the villager standing in the shut yard is still taken into the hall, never left loose there', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { cartTakeLost: true });
  await laidWhole(land, line);
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^moved an unemployed villager .* to the hall by the rails home \(1 in it now\)/);
  t.true(world.villagerMoves);
  t.is(land.cart, undefined);
  t.deepEqual(land.standing(line), []);
  // a restart after the cart was broken, its record never cleared: the cart not in sight, the villager in the yard
  const b = lineWorld('laying');
  const two = new Field(b.world);
  await laidWhole(two, b.line);
  yardAsLeft(two, b.line, b.world, { postOpen: false });
  two.me = { x: -555.5, y: 63, z: 2122.5 };
  two.villagers.find(v => v.id === 101)!.position = { x: -555.5, y: 63, z: 2123.5 };
  b.line.stage = 'moving';
  b.line.yardOpen = true;
  b.line.villagerOut = 101;
  b.line.cart = { uuid: 'ca27-0001', id: 700 };
  const again = await run(two, 'move', 20 * MINUTE);
  t.regex(again.text, /^moved an unemployed villager .* to the hall by the rails home \(1 in it now\)/);
  t.notRegex(again.text, /the cart left/);
  t.true(b.world.villagerMoves);
});

test('the hall\'s way read before the cart is broken at the brake: a read that fails leaves the villager seated in the cart in the shut yard, never loose', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { wallUnreadAtBrake: true });
  await laidWhole(land, line);
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^the move given up: the hall's wall not read at \(-557, 63, 2126\) \(the villager left in the cart at the brake, the yard shut\)$/);
  t.is(land.cart?.rider, 101, 'still seated in the cart');
  t.is(land.block(-556, 63, 2119), FENCE, 'the yard shut');
  t.false(world.villagerMoves);
});

test('a mob onto the line\'s head as the cart goes down: looked at again before the trigger, the cart taken back up, the day a miss; a cart that took another villager all the same gives the move up with the moves off, and the take-up leaves it seated in the cart in the yard', async (t) => {
  const { world, line } = lineWorld('laying');
  const c2 = line.cells[2];
  const land = new Field(world, { mobAtCart: { id: 300, name: 'chicken', position: { x: c2.x + 0.5, y: 63, z: c2.z + 0.5 }, profession: 'none', level: 0, baby: false, health: 4 } });
  await laidWhole(land, line);
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^the move not made: a chicken on the line's head at \(-556, 63, 1997\): the cart taken back up before the trigger$/);
  t.is(land.cart, undefined);
  t.is(land.count('minecart'), 1);
  const trig = line.torches.find(q => q.trigger)!;
  t.false(land.log.includes(`lay redstone_torch ${k(trig.at)}`), 'no trigger torch put down');
  t.like(line, { stage: 'whole', misses: 1 });
  t.true(world.villagerMoves);
  // the cart took the baby (103) come onto the head after the looks: home with it through the open post
  const b = lineWorld('laying');
  const two = new Field(b.world, { takesOther: 103 });
  await laidWhole(two, b.line);
  const go = await run(two, 'move', 20 * MINUTE);
  t.regex(go.text, /^the move given up: the cart took another \(villager \(a baby\) 103\), not the villager \(101\): it rolls home with it$/);
  t.false(b.world.villagerMoves, 'the moves wait for the lead');
  t.is(b.line.stage, 'taking up');
  const up = await run(two, 'take up', 30 * MINUTE);
  t.regex(up.text, /the cart at \(-556, 63, 2124\) left with a villager \(103\) in it \(never let out loose in the yard\)/);
  t.is(two.cart?.rider, 103);
  // a zombie it took home: kept in the cart in the yard too (a chicken is let out)
  const c = lineWorld('laying');
  const three = new Field(c.world);
  await laidWhole(three, c.line);
  const end = c.line.cells[c.line.cells.length - 1];
  three.villagers.push({ id: 301, name: 'zombie', category: 'monster', position: { x: end.x + 0.5, y: 63, z: end.z + 0.5 }, profession: 'none', level: 0, baby: false, health: 20 });
  three.cart = { id: 702, uuid: 'ca27-0003', pos: { x: end.x + 0.5, y: 63.06, z: end.z + 0.5 }, rider: 301 };
  c.line.cart = { uuid: 'ca27-0003' };
  c.line.stage = 'taking up';
  c.line.why = 'given up by hand';
  const zup = await run(three, 'take up', 30 * MINUTE);
  t.regex(zup.text, /left with a zombie \(301\) in it \(never let out loose in the yard\)/);
  t.is(three.cart?.rider, 301);
});

// ------------------------------------------------------------------------------------------------ the third review's

/** As a move left it: the yard's stretch down, the post open, the cart `uuid` (id 701) at `at` with `rider` in it, stage moving. */
function cartOutAsLeft(land: Field, line: RailLine, world: WorldMemory, at: Pos, rider: number, over: Partial<RailLine> = {}) {
  yardAsLeft(land, line, world, { postOpen: true });
  land.cart = { id: 701, uuid: 'ca27-0002', pos: { x: at.x + 0.5, y: at.y + 0.0625, z: at.z + 0.5 }, rider };
  land.villagers.find(v => v.id === rider)!.position = { ...land.cart.pos };
  land.line = line;
  line.stage = 'moving';
  line.yardOpen = true;
  line.cart = { uuid: 'ca27-0002' };
  Object.assign(line, over);
}

test('the post\'s rail off the record is saved before the fence goes back on it; and a restart that finds the fence back over a post still in the record goes on into the hall, never gives the move up', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  const post = line.cells[goalOf(line) + 1];
  cartOutAsLeft(land, line, world, line.cells[line.cells.length - 1], 101, { villagerOut: 101 });
  land.me = { x: -555.5, y: 63, z: 2121.5 };
  const n0 = land.saves.length;
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^moved an unemployed villager/);
  // the first save with the post's rail off the record: the fence's opening still listed (the fence not back yet)
  const saves = land.saves.slice(0, land.saves.length - n0).reverse().map(x => JSON.parse(x) as WorldMemory);
  const first = saves.find(w => w.rails?.line && !w.rails.line.laid.some(b => k(b.at) === k(post)));
  t.truthy(first);
  t.true((first!.villages?.open ?? []).some(o => k(o.at) === k(post)), 'saved before the fence went back');
  // a restart in that gap before the fix's save: the fence back on the post, the record still has its rail
  const b = lineWorld('laying');
  const two = new Field(b.world);
  await laidWhole(two, b.line);
  cartOutAsLeft(two, b.line, b.world, b.line.cells[b.line.cells.length - 1], 101, { villagerOut: 101 });
  two.rails.delete(k(post));
  two.own.delete(k(post));
  for (const o of b.line.opens) two.blocks.set(k(o.at), o.block);
  two.me = { x: -555.5, y: 63, z: 2121.5 };
  const go = await run(two, 'move', 20 * MINUTE);
  t.regex(go.text, /^moved an unemployed villager/);
  t.true(b.world.villagerMoves);
  t.is(two.block(-556, 63, 2119), FENCE);
  t.deepEqual(two.standing(b.line), []);
});

test('the take-up never digs a block of someone\'s standing where the bot\'s rail was (their cobblestone over the line): left, said, the rest up', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  const c = line.cells[50];
  land.rails.delete(k(c));
  land.blocks.set(k(c), 'cobblestone');
  line.stage = 'taking up';
  line.why = 'stopped 2 runs in a row: cobblestone where the line\'s rail was';
  const up = await run(land, 'take up', 30 * MINUTE);
  t.regex(up.text, /everything of the line taken back up/);
  t.is(land.block(c.x, c.y, c.z), 'cobblestone', 'theirs, left standing');
  t.false(land.log.includes(`take up cobblestone ${k(c)}`));
  t.true(up.text.includes(`left: rail (${c.x}, ${c.y}, ${c.z}): the bot did not put that cobblestone there (its rail is gone)`), up.text);
  t.deepEqual(land.standing(line), [k(c)]);
});

test('a lay whose reply was lost and whose read after failed too (the client dropped) is kept in the record, unsure: the next day reads it and lays on, and the take-up gets it', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { lostAt: 5, unreadAfterLost: 1 });
  land.line = line;
  const r = await run(land, 'lay', 30 * MINUTE);
  const fifth = line.cells[goalOf(line) - 4];
  t.regex(r.text, /stopped: rail .* not laid: bridge call rail.place timed out; not read after \(kept in the record\)/);
  t.like(line.laid.find(b => k(b.at) === k(fifth)), { item: 'rail', unsure: true });
  t.true(land.standing(line).includes(k(fifth)), 'down all the same');
  const again = await run(land, 'lay', 30 * MINUTE);
  t.regex(again.text, /^the line is whole/);
  t.false(line.laid.some(b => b.unsure));
  t.deepEqual(land.standing(line).sort(), line.laid.map(b => k(b.at)).sort());
  // (unsure and not down: the take-up's read finds air and forgets it)
  world.railsHome = false;
  await run(land, 'take up', 30 * MINUTE);
  t.deepEqual(land.standing(line), []);
  t.is(peekLine(world), undefined);
});

test('no boat carried at the brake (the stash put it away): one is made from the chests\' planks first; with none to be had the villager stays seated in the cart in the shut yard, the move under way, never let out loose', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  cartOutAsLeft(land, line, world, line.cells[line.cells.length - 1], 101, { villagerOut: 101 });
  land.items = land.items.filter(i => i.name !== 'oak_boat');
  land.me = { x: -555.5, y: 63, z: 2121.5 };
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^moved an unemployed villager/);
  t.true(land.log.includes('craft oak_boat x1'));
  // none: no boat and no planks
  const b = lineWorld('laying');
  const two = new Field(b.world);
  await laidWhole(two, b.line);
  cartOutAsLeft(two, b.line, b.world, b.line.cells[b.line.cells.length - 1], 101, { villagerOut: 101 });
  two.items = two.items.filter(i => i.name !== 'oak_boat' && i.name !== 'oak_planks');
  two.me = { x: -555.5, y: 63, z: 2121.5 };
  const no = await run(two, 'move', 20 * MINUTE);
  t.regex(no.text, /^the villager \(101\) kept seated in the cart on the brake: short of oak_boat .*; again next run$/);
  t.like(two.cart, { rider: 101 });
  t.is(b.line.stage, 'moving');
  t.true(b.world.villagerMoves);
  t.is(two.block(-556, 63, 2119), FENCE, 'the yard shut');
  // a boat broken at the pickup whose drop was not picked up: no cart goes down for the villager
  const c = lineWorld('laying');
  const three = new Field(c.world, { boatDropLeft: true });
  await laidWhole(three, c.line);
  const go = await run(three, 'move', 20 * MINUTE);
  t.regex(go.text, /^the move not made: the boat broken at the pickup did not come back into the pockets/);
  t.false(three.log.some(l => /^cart on /.test(l)));
  t.is(c.line.stage, 'whole');
});

test('a move cut short with the cart still rolling home, or frozen out on the line past the simulation distance: the next run follows it home and on into the hall, never gives it up', async (t) => {
  // rolling, in sight
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  cartOutAsLeft(land, line, world, line.cells[100], 101, { villagerOut: 101 });
  land.cartMoving = true;
  land.me = { x: line.cells[90].x + 0.5, y: 63, z: line.cells[90].z + 0.5 };
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^moved an unemployed villager/);
  t.true(world.villagerMoves);
  // frozen at rest out on the line, the bot in the yard: it walks out, the cart wakes and rolls home
  const b = lineWorld('laying');
  const two = new Field(b.world, { simulation: 3, wakes: true });
  await laidWhole(two, b.line);
  cartOutAsLeft(two, b.line, b.world, b.line.cells[20], 101, { aimed: 101 });
  two.me = { x: -555.5, y: 63, z: 2121.5 };
  const go = await run(two, 'move', 20 * MINUTE);
  t.regex(go.text, /^moved an unemployed villager/);
  t.true(two.log.some(l => l.startsWith('cart woke')));
  t.true(b.world.villagerMoves);
  // not in sight from home at all: looked for out along the line
  const c = lineWorld('laying');
  const three = new Field(c.world, { simulation: 3, wakes: true, sight: 40 });
  await laidWhole(three, c.line);
  cartOutAsLeft(three, c.line, c.world, c.line.cells[20], 101, { villagerOut: 101 });
  three.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const far = await run(three, 'move', 20 * MINUTE);
  t.regex(far.text, /^moved an unemployed villager/);
  t.deepEqual(three.standing(c.line), []);
});

test('a take-up with the cart and its villager out and not found keeps the cart\'s way home (the brake, the post) until the line is up: never shut out at the fence, let out loose there', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { simulation: 3, wakes: true, sight: 40 });
  await laidWhole(land, line);
  cartOutAsLeft(land, line, world, line.cells[20], 101, { villagerOut: 101, stage: 'taking up', why: 'given up by hand' });
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  // close up leaves the post open for it
  const night = snap(land.items, { now: land.t, timeOfDay: 14000, activity: activityAt(14000) });
  if (closeUpGoal.wants(night, world)) await closeUpGoal.run(land.ctx()).catch(() => undefined);
  t.is(idOf(land.block(-556, 63, 2119)), 'rail');
  await run(land, 'take up', 30 * MINUTE);
  const v = land.villagers.find(q => q.id === 101)!;
  t.is(land.cart?.rider, 101, 'kept seated in the cart');
  t.true(v.position.z > YARD.z1, `in the yard, not outside the fence: ${JSON.stringify(v.position)}`);
  t.is(land.block(-556, 63, 2119), FENCE);
});

test('a move cut short as the cart rolled (its took never heard): the next run takes into the hall only the villager it went for; a baby it took instead is left seated, the moves off', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  cartOutAsLeft(land, line, world, line.cells[line.cells.length - 1], 103, { aimed: 101 });
  land.me = { x: -555.5, y: 63, z: 2121.5 };
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^the move given up: the last move was cut short: the cart at .* holds another \(villager 103\), not the villager \(101\)$/);
  t.false(world.villagerMoves);
  t.like(land.cart, { rider: 103 });
  t.is(peekVillages(world).sites[0].moved, undefined);
  // the one it went for: on into the hall
  const b = lineWorld('laying');
  const two = new Field(b.world);
  await laidWhole(two, b.line);
  cartOutAsLeft(two, b.line, b.world, b.line.cells[b.line.cells.length - 1], 101, { aimed: 101 });
  two.me = { x: -555.5, y: 63, z: 2121.5 };
  t.regex((await run(two, 'move', 20 * MINUTE)).text, /^moved an unemployed villager/);
});

// ------------------------------------------------------------------------------------------------ the fourth review's

/** ctx.call with cart.watch's `either` reply lost (the client stalled past the call's timeout), the watch run all the same. */
const watchLost = (land: Field, also?: (m: string) => void): GoalContext['call'] => (async (m: string, p?: Record<string, unknown>) => {
  also?.(m);
  const r = land.call(m, p);
  if (m === 'cart.watch' && p?.until === 'either') throw new Error('bridge call cart.watch timed out after 35000 ms');
  return r;
}) as GoalContext['call'];

test('the cart\'s watch lost after the trigger: the cart read by its uuid first; the villager in it home on the brake goes on into the hall, never the line given up as if the cart were empty', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  const r = await run(land, 'move', 20 * MINUTE, { call: watchLost(land) });
  t.regex(r.text, /^moved an unemployed villager/);
  t.true(world.villagerMoves);
  t.deepEqual(land.standing(line), []);
  t.is(land.cart, undefined);
});

test('the cart\'s watch lost after the trigger with the cart at rest out on the line, the villager in it: the move given up with the moves off, the yard held for the cart', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { stuckAt: 60 });
  await laidWhole(land, line);
  const r = await run(land, 'move', 20 * MINUTE, { call: watchLost(land) });
  t.regex(r.text, /^the move given up: .*came to rest short of the brake/);
  t.is(line.stage, 'taking up');
  t.false(world.villagerMoves);
  t.is(line.villagerOut, 101);
});

test('the cart not read after a lost watch: the move stays under way, the next run finds the cart by the villager it went for and goes on into the hall', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  let watched = false, blind = 0;
  const call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'cart.watch' && p?.until === 'either') { land.call(m, p); watched = true; blind = 1; throw new Error('bridge call cart.watch timed out after 35000 ms'); }
    if (watched && blind > 0 && m === 'cart.status') { blind--; throw new Error('not in a world'); }
    return land.call(m, p);
  }) as GoalContext['call'];
  const r = await run(land, 'move', 20 * MINUTE, { call });
  t.regex(r.text, /^the move left under way: the cart's watch ended: bridge call cart.watch timed out after 35000 ms; the cart not in sight; the next run looks for the cart$/);
  t.is(line.stage, 'moving');
  t.true(world.villagerMoves);
  const again = await run(land, 'move', 20 * MINUTE);
  t.regex(again.text, /^moved an unemployed villager/);
});

test('a death after the trigger, before the watch said who got in: the moves off (the villager may be in the cart) and the yard held for the cart until it is found', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  cartOutAsLeft(land, line, world, line.cells[20], 101, { aimed: 101 });
  line.run = { at: T0, end: T0 + 60_000 };
  line.at = T0 - MINUTE;
  const lines = railsTick(world, { time: T0 + 30_000 });
  t.true(lines.some(l => /villager moves off/.test(l)), lines.join(' | '));
  t.false(world.villagerMoves);
  t.is(line.stage, 'taking up');
  // the take-up keeps the brake and the post down for it (the cart, frozen out on the line, may still roll home)
  t.true(railsYardOpen(world));
  const night = snap(land.items, { now: land.t, timeOfDay: 14000, activity: activityAt(14000) });
  t.is(closeUpGoal.wants(night, world), null);
});

test('a boat a hop to the pickup left there (a restart between the dismount and its take): the next move day breaks it back first, the villager out in its own village; the take-up does too', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  const mid = { x: line.pickup.x + 0.5, y: 63, z: line.pickup.z + 0.5 };
  land.boat = { id: 950, uuid: 'b0a7-0009', pos: { ...mid }, rider: 101 };
  land.villagers.find(v => v.id === 101)!.position = { ...mid };
  world.villages!.boat = { uuid: 'b0a7-0009', at: { x: line.pickup.x, y: 62, z: line.pickup.z }, since: T0 - HOUR };
  const r = await run(land, 'move', 20 * MINUTE);
  t.true(land.said.some(l => /^rails: the boat a hop cut short left at .* taken back up/.test(l)), land.said.join(' | '));
  t.is(peekVillages(world).boat, undefined);
  t.regex(r.text, /^moved an unemployed villager/);
  // given up with the boat out: the take-up's walk breaks it as it comes by the pickup
  const b = lineWorld('laying');
  const two = new Field(b.world);
  await laidWhole(two, b.line);
  two.boat = { id: 950, uuid: 'b0a7-0009', pos: { ...mid }, rider: 101 };
  two.villagers.find(v => v.id === 101)!.position = { ...mid };
  b.world.villages!.boat = { uuid: 'b0a7-0009', at: { x: b.line.pickup.x, y: 62, z: b.line.pickup.z }, since: T0 - HOUR };
  b.line.stage = 'taking up';
  b.line.why = 'a death on a rails run';
  await run(two, 'take up', 30 * MINUTE);
  t.is(two.boat as Vehicle | undefined, undefined);
  t.is(peekVillages(b.world).boat, undefined);
  t.is(peekLine(b.world), undefined);
});

test('the fence\'s post read again on the move\'s day before it is dug: restyled since the plan, something put on it or hung by it, the move stops for the day and nothing is dug', async (t) => {
  const cases: [string, (land: Field, post: Pos) => void, RegExp][] = [
    ['restyled', (land, post) => land.blocks.set(k(post), 'spruce_fence[east=true,north=false,south=false,waterlogged=false,west=true]'), /spruce_fence at \(-556, 63, 2119\) now, not the birch_fence the line was planned with/],
    ['on top', (land, post) => land.blocks.set(k({ ...post, y: post.y + 2 }), 'lantern[hanging=false,waterlogged=false]'), /lantern on top of the fence's post at \(-556, 65, 2119\) now/],
    ['hung by', (land, post) => land.blocks.set(k({ ...post, x: post.x + 1 }), 'oak_wall_sign[facing=east,waterlogged=false]'), /oak_wall_sign hung by the fence's post at \(-555, 63, 2119\)/]
  ];
  for (const [what, change, why] of cases) {
    const { world, line } = lineWorld('laying');
    const land = new Field(world);
    await laidWhole(land, line);
    const post = line.cells[goalOf(line) + 1];
    change(land, post);
    const was = land.block(post.x, post.y, post.z);
    const r = await run(land, 'move', 20 * MINUTE);
    t.regex(r.text, why, what);
    t.is(line.stage, 'whole', what);
    t.false(land.log.some(l => l.startsWith('dig ')), what);
    t.is(land.block(post.x, post.y, post.z), was, what);
    t.is(line.yardOpen, undefined, what);
    t.is(peekVillages(world).open, undefined, what);
  }
});

test('a cart put down whose reply timed out and that shows only after the first look (the use waited on the client\'s ticks): looked at again, named, and the take-up breaks it', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  let shows = Infinity;
  const placeCart = async (at: Pos): Promise<CartPlaced> => {
    await land.placeCart(at);
    shows = Date.now() + 1000;
    throw new Error('bridge call cart.place timed out after 15000 ms');
  };
  const call = (async (m: string, p?: Record<string, unknown>) => {
    if ((m === 'cart.status' || m === 'world.entities') && Date.now() < shows && land.cart) {
      const c = land.cart;
      land.cart = undefined;
      try { return land.call(m, p); } finally { land.cart = c; }
    }
    return land.call(m, p);
  }) as GoalContext['call'];
  const r = await run(land, 'move', 20 * MINUTE, { call, rails: { lay: land.lay, takeUp: land.takeUp, placeCart } });
  t.regex(r.text, /^the line given up: no minecart on the launch at \(-556, 63, 1995\): bridge call cart.place timed out after 15000 ms$/);
  t.like(line.cart, { uuid: 'ca27-0001' });
  await run(land, 'take up', 30 * MINUTE);
  t.is(land.cart, undefined);
  t.is(peekLine(world), undefined);
});

test('the move day, an extension left to make, carries an extension\'s rails (EXT_CARRY, made from the iron and gold carried): the extension it plans is laid and the move made in that one run (Nov 22: laid a run later, the villager had wandered off)', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  hillside(land);
  uphill(land);
  land.items.push({ slot: 20, name: 'iron_ingot', count: 64 }, { slot: 21, name: 'gold_ingot', count: 64 }, { slot: 22, name: 'redstone', count: 64 }, { slot: 23, name: 'stick', count: 64 });
  const r = await run(land, 'move', 20 * MINUTE);
  t.true(land.log.some(l => /^craft rail x/.test(l)), land.log.join('\n'));
  t.regex(r.text, /^moved an unemployed villager .* to the hall by the rails home/, land.said.join('\n'));
  t.truthy(line.extended);
});

test('the move\'s day need (railMoveNeedMs) covers what the run asks to have left at the village (Nov 22: a 351-rail line set out on the old estimate and turned back after a 113 s walk and look, "too little of the run left": 355 s wanted)', t => {
  const cells = Array.from({ length: 351 }, (_, i) => ({ x: -743 + Math.round(i * 0.55), y: 70, z: 2265 - Math.round(i * 0.25), kind: 'rail' }));
  const need = railMoveNeedMs({ cells, yard: 5 } as unknown as RailLine, HOME);
  t.true(need >= 113_000 + 355_000, String(need));
});

test('the rails rung brings itself home (backPace): its day budget is not cut by a walk back besides (Nov 22: the 351-rail move turned back at the village twice, 72 s short)', t => {
  t.is(railsTask.backPace, 3);
});

test('the move day carries no extension\'s rails into the last free slots (Nov 22: the carry filled all 36, the stash cut the move short three times)', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  land.items.push({ slot: 20, name: 'iron_ingot', count: 64 }, { slot: 21, name: 'gold_ingot', count: 64 }, { slot: 22, name: 'redstone', count: 64 }, { slot: 23, name: 'stick', count: 64 });
  const used = new Set(land.items.map(i => i.slot));
  for (let slot = 0; slot < 36 && land.items.filter(i => i.slot < 36).length < 31; slot++) if (!used.has(slot)) land.items.push({ slot, name: 'diorite', count: 1 });
  await run(land, 'move', 20 * MINUTE);
  t.false(land.log.some(l => /^craft rail x/.test(l)), land.log.join('\n'));
});

test('the move\'s day need of a 375-rail line still fits one game day\'s daylight (600 s), with 90 s for the hop (Nov 22: a 62 s hop, 58 s left)', t => {
  const cells = Array.from({ length: 375 }, (_, i) => ({ x: -743 + Math.round(i * 0.55), y: 70, z: 2253 - Math.round(i * 0.2), kind: 'rail' }));
  const need = railMoveNeedMs({ cells, yard: 5 } as unknown as RailLine, HOME);
  t.true(need < 560_000, String(need));
});

test('a village scanned as one box round all of it (Nov 22: 87 by 68, every villager inside): the extension keeps clear of its built blocks, not of the whole box, and lies by the villager; a built block put by that head moves it off', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  bumpy(land);
  walledEnd(land);
  uphill(land, { x: -597.5, y: 65, z: 2000.5 });
  const g = new Ground(55, 29);
  for (let x = -625; x <= -540; x++) for (let z = 1960; z <= 2060; z++) for (let y = 55; y < 84; y++) g.set(x, y, z, land.block(x, y, z));
  const v101 = { id: 101, name: 'villager', position: { x: -597.5, y: 65, z: 2000.5 }, profession: 'none' } as Seen;
  const village: Zone = { x1: -620, y1: 60, z1: 1970, x2: -575, y2: 80, z2: 2040, markers: 400, surface: true, sample: 'oak_planks', kinds: ['oak_planks x200'] } as Zone;
  const look = { jobs: [], beds: land.marks.filter(m => /_bed$/.test(m.name)).map(m => m.at), bells: [{ ...BELL }], zones: [village], seen: [v101] };
  const args = { noWay: [v101], order: [v101], look, v: { own: [village], outposts: [] }, area: world.villages!.sites[0].area, yard: YARD, earth: true };
  const r = extensionFor(line, g, args);
  t.true(r.ok, r.ok ? '' : r.why);
  if (!r.ok) return;
  t.true(horiz(r.pickup, { x: -597.5, z: 2000.5 }) <= 6, JSON.stringify(r.pickup));
  // planks along the head's side: no rail goes in a plank's column, no cut or fill within one of a plank
  const planks: Pos[] = r.cells.slice(0, 4).map(cell => ({ x: cell.x, y: cell.y, z: cell.z + 1 }));
  for (const p of planks) g.set(p.x, p.y, p.z, 'minecraft:oak_planks');
  const moved = extensionFor(line, g, args);
  if (moved.ok) {
    for (const cell of moved.cells) t.false(planks.some(p => p.x === cell.x && p.z === cell.z && Math.abs(p.y - cell.y) <= 2), k(cell));
    for (const w of moved.earth) t.false(planks.some(p => Math.abs(p.x - w.x) <= 1 && Math.abs(p.z - w.z) <= 1 && Math.abs(p.y - w.y) <= 2), `${w.op} ${k(w)}`);
  }
});

test('the move may run its yard part into the evening (duskMs, up to night): picked with up to 75 s less daylight than its need, not with more short (Nov 23: 8.5 min needed of the workday\'s 9.6)', t => {
  const { world, line } = lineWorld('laying');
  line.stage = 'whole';
  for (let i = 0; i < line.cells.length; i++) line.laid.push({ at: { x: line.cells[i].x, y: line.cells[i].y, z: line.cells[i].z }, item: 'rail' });
  const v = railsTask.variants(snap(KIT()), world).find(x => x.id === 'move');
  t.truthy(v);
  if (!v?.needMs) return;
  t.is(v.duskMs, 150_000);
  const at = (shortMs: number) => snap(KIT(), { timeOfDay: 11_000 - Math.ceil((v.needMs! - shortMs) / 50) });
  t.like(pick(railsTask, at(60_000), world), { variant: 'move' });
  t.like(pick(railsTask, at(90_000), world), { decline: { cause: 'late' } });
});

test('a move day with a free word seen whole within FRESH_FREE walks no viewpoints: the partial look from the line\'s end, then the hop and the cart (Nov 23: two viewpoints took 45 s of the extension\'s time)', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world, { scanSight: 48 });
  wideVillage(land);
  await laidWhole(land, line);
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  judgedAgo(world, land, 2 * HOUR);
  const said0 = land.said.length;
  const r = await run(land, 'move', 20 * MINUTE);
  const said = land.said.slice(said0);
  t.false(said.some(l => /looking round the village from/.test(l)), said.join('\n'));
  t.regex(r.text, /^moved an unemployed villager from the village at \(-572, 63, 2000\) to the hall by the rails home/, said.join('\n'));
});

test('no boat way to the pickup, a villager penned in by walls 5 from it: the bot waits by the head, and the villager that wanders onto the pickup is taken by the cart as it stands (Nov 23: on the pickup at the look, 4 off it a moment later, a wall beside it)', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  for (const v of land.villagers) if (v.id === 106 || v.id === 107) v.profession = 'mason';
  const v101 = land.villagers.find(v => v.id === 101)!;
  v101.position = { x: -553.5, y: 63, z: 2005.5 };
  for (let x = -554; x <= -552; x++) for (let z = 2004; z <= 2006; z++) if (x !== -553 || z !== 2005) for (const y of [63, 64]) land.blocks.set(k({ x, y, z }), 'stone');
  line.extended = { at: T0, from: { ...line.cells[0] }, to: { ...line.pickup }, rails: 1, powered: 0, times: EXTENSIONS };
  let waiting = false, looks = 0;
  const call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'world.entities' && waiting && ++looks === 3) v101.position = { x: line.pickup.x + 0.5, y: 63, z: line.pickup.z + 0.5 };
    return land.call(m, p);
  }) as GoalContext['call'];
  const progress = (text: string) => { if (/waiting by it for a villager/.test(text)) waiting = true; land.said.push(text); };
  setPickupWait(5000, 1);
  try {
    const said0 = land.said.length;
    const r = await run(land, 'move', 20 * MINUTE, { call, progress });
    const said = land.said.slice(said0);
    t.true(said.some(l => /waiting by it for a villager to wander onto it/.test(l)), said.join('\n'));
    t.true(said.some(l => /the villager \(101\) wandered onto the pickup/.test(l)), said.join('\n'));
    t.regex(r.text, /^moved an unemployed villager/, said.join('\n'));
  } finally {
    setPickupWait(0);
  }
});
