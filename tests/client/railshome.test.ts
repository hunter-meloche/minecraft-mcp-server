import test from 'ava';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { Zone } from '../../src/client/brain/courtesy.js';
import type { CartPlaced, InventoryItem, RailLay, RailPlaced, RailTaken } from '../../src/client/tools.js';
import { Ground, cellOf, entryOf, type Entry } from '../../src/client/brain/boatroute.js';
import { planRails, shapeOf, type RailCell, type RailShape } from '../../src/client/brain/railroute.js';
import { recipeFor } from '../../src/client/brain/progress.js';
import { activityAt } from '../../src/client/brain/schedule.js';
import { pick, workTick } from '../../src/client/brain/work.js';
import { closeUpGoal } from '../../src/client/brain/villagemove.js';
import { JUDGE_V, peekVillages } from '../../src/client/brain/village.js';
import {
  MAX_AGE, MISSES, MOVE_TRIES, STOPS, UP_TRIES, goalOf, layArgs, outwardSteps, peekLine, railsHomeLine, railsTask, shapeWith, startLine, stepAt, yardSteps, type RailLine
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

interface Villager { id: number; name: string; position: Pos; profession: string; level: number; baby: boolean; health?: number; category?: string }
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
          ...(this.cart ? [{ id: this.cart.id, name: 'minecart', position: { ...this.cart.pos } }] : [])
        ];
        return { entities: all.filter(e => (!p.type || e.name === p.type) && Math.hypot(e.position.x - this.me.x, e.position.y - this.me.y, e.position.z - this.me.z) <= max) };
      }
      case 'foreign.zones': return { dimension: 'overworld', zones: this.zones.map(z => ({ ...z })) };
      case 'foreign.banners': return { dimension: 'overworld', at: [], chunks: 1 };
      case 'foreign.marks': {
        const inBox = (q: Pos) => q.x >= n('x1') && q.x <= n('x2') && q.z >= n('z1') && q.z <= n('z2');
        const re = p.match ? new RegExp(String(p.match)) : undefined;
        const kinds: Record<string, number> = {};
        for (const m of MARKS().filter(q => inBox(q.at))) kinds[m.name] = (kinds[m.name] ?? 0) + 1;
        const of = (Math.floor(n('x2') / 16) - Math.floor(n('x1') / 16) + 1) * (Math.floor(n('z2') / 16) - Math.floor(n('z1') / 16) + 1);
        return { kinds, ominous: {}, at: re ? MARKS().filter(q => inBox(q.at) && re.test(q.name)).map(q => ({ ...q.at, name: q.name })) : [], chunks: of, of };
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
        this.boat = { id: 900, uuid: 'b0a7-0001', pos: { x: mob.position.x + 1.1, y: 63, z: mob.position.z }, rider: mob.id };
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
        for (let s = 0.25; s <= d; s += 0.25) {
          const q = { x: from.x + (to.x - from.x) * s / d, z: from.z + (to.z - from.z) * s / d };
          if (cellOf(this.block(Math.floor(q.x), 63, Math.floor(q.z))).kind !== 'open') { reason = 'a step up ahead'; end = { x: from.x + (to.x - from.x) * (s - 0.5) / d, z: from.z + (to.z - from.z) * (s - 0.5) / d }; break; }
        }
        this.boat.pos = { x: end.x, y: 63, z: end.z };
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
        this.me = { x: this.boat.pos.x + (t.x - this.boat.pos.x) / d * 1.27, y: 63, z: this.boat.pos.z + (t.z - this.boat.pos.z) / d * 1.27 };
        return { ok: true, wasRiding: true };
      }
      case 'vehicle.take': {
        const v = this.boat && n('id') === this.boat.id ? this.boat : this.cart && n('id') === this.cart.id ? this.cart : undefined;
        if (!v) return { ok: false, reason: 'no such vehicle' };
        if (this.riding && v === this.boat) return { ok: false, reason: 'riding it' };
        if (horiz(this.me, v.pos) > 4) return { ok: false, reason: 'too far' };
        const rider = this.villagers.find(q => q.id === v.rider);
        if (rider) rider.position = { x: v.pos.x, y: 63, z: v.pos.z };
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
        if (this.opts.wander?.includes(this.launches)) for (const v of this.villagers) if (Math.floor(v.position.x) === pk.x && Math.floor(v.position.z) === pk.z) v.position = { x: v.position.x + 1.5, y: 63, z: v.position.z + 1 };
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
      rails: { lay: this.lay, takeUp: this.takeUp, placeCart: this.placeCart },
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

test('a move not made today (the village not judged free: a player came by) leaves the line whole only when nothing is lost; someone\'s, the line is given up; close up takes a yard stretch left down back, any hour, and puts the post back', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  land.players = [{ id: 9, name: 'player', position: { x: -590.5, y: 63, z: 2000.5 } }];
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^the line given up: the village at \(-572, 63, 2000\) is someone's/);
  t.is(line.stage, 'taking up');
  // the yard's stretch was down and the post open: close up (any hour, in the yard) has it, before the take-up's run
  land.me = { x: HOME.x + 0.5, y: 63, z: HOME.z + 0.5 };
  const s = snap(land.items, { now: land.t, timeOfDay: 14000, activity: activityAt(14000) });
  t.is(closeUpGoal.wants(s, world), 'the rails home\'s yard stretch left down by a move that did not go');
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
  await t.throwsAsync(closeUpGoal.run(land.ctx()), { message: /not at rest on the brake .*: the post left open for it/ });
  t.is(land.block(-556, 63, 2119).split('[')[0], 'rail', 'the post\'s rail left for the cart coming in');
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

test('no villager near the fixed pickup on a move day is a miss, not a stop; after MISSES such runs the line is given up (and brain-status says so before the take-up runs)', async (t) => {
  const { world, line } = lineWorld('laying');
  const land = new Field(world);
  await laidWhole(land, line);
  land.villagers.find(v => v.id === 101)!.position = { x: -585.5, y: 63, z: 2000.5 };
  const r = await run(land, 'move', 20 * MINUTE);
  t.regex(r.text, /^the move not made: no unemployed villager the judge allows within 8 of the pickup at \(-556, 63, 2000\)$/);
  t.like(line, { stage: 'whole', misses: 1 });
  t.falsy(line.stops);
  line.misses = MISSES;
  t.deepEqual(railsTask.variants(snap(KIT(), { now: land.t }), world).map(v => v.id), ['take up']);
  t.regex(railsHomeLine(world, land.t), new RegExp(`: to be taken up \\(the move not made on ${MISSES} runs: no unemployed villager .*\\): \\d+ block\\(s\\) down`));
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
