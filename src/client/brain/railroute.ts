import type { Pos } from './memory.js';
import type { Zone } from './courtesy.js';
import { cellOf, checkLeg, offSegment, zoneNear, FROM_ZONES, type Entry } from './boatroute.js';
import { WORK_AT, daylightLeft } from './schedule.js';

/**
 * The rails home for the villager move (P5c of the progression plan; the user's fallback, Nov 13: "rails home" when the
 * boat finds no way), PLANNED ONLY: a dry run of a temporary minecart line from the village to the yard, said and kept,
 * never laid. Nothing in P5c lays a rail, whatever the villager-moves switch: the lead builds the laying (and the bridge's
 * minecart calls it needs) and turns it on if the boat move fails live. What the plan rests on was run on the 26.3 jar's
 * own rail, minecart and villager code (the scratch RailsCheck, P5c):
 * - a rail stands only on a rigid top (dirt_path, farmland, bottom slabs, leaves, fences are none), goes only into air or
 *   what a placed block replaces (short grass, ferns, tall grass, dry grass, leaf litter, one snow layer: not a flower),
 *   and a slope rail also needs the block it rises onto; rails climb one block a block, on a straight run;
 * - a villager's eye in a cart is 1.68 over a level rail's block (one block of air over the line) and up to 2.64 over a
 *   slope rail's (two);
 * - a cart off a stationary start needs a block behind a lit powered rail to be pushed off (the launch); an empty cart
 *   takes in a villager standing on the line only when a tick ends within 0.2 of it at over 0.1 a tick: faster than 0.2 a
 *   tick it runs into the villager's box and stops dead against it as often as not. So the line's head is [a stop][the
 *   launch: one powered rail, lit last][4 plain][the pickup][7 plain]: the empty cart comes at the villager at 0.12-0.2;
 *   missed, it stops short of the first boost, 8 on (0.96 a tick while empty), and taken, it rolls on to it (0.997);
 * - with a villager a cart at full speed (0.4 a tick) is under half of it after 50 blocks of plain rail (a boost every 32
 *   keeps it fast), climbs only on lit powered rails (every slope rail going up is one), and two unlit powered rails stop
 *   it from full speed within the first (the brake);
 * - one redstone torch beside a powered rail, on the ground at the rail's level, lights it and 8 more each way along the
 *   run; a plain rail between two runs carries no power (so the brake stays unlit), and a torch on the diagonal or a block
 *   up lights nothing.
 * The line keeps FROM_ZONES off every build of others but the village's own, as the boat's way does, puts nothing on what
 * anyone built (natural ground only), breaks nothing out in the world (what a rail replaces is grass), and opens only
 * the bot's own fence: it ends on its brake in the yard, by the hall's panel, so the hall stays shut through the long
 * job and the boat move's own last part (the boat against the villager, the panel dug from it) takes the villager in.
 * Where the boat's way in is across the yard (boatroute.ts yardEntry), the line comes in by that panel of the fence, its
 * brake just inside it, and the boat's way across the yard is the last part's.
 *
 * Pure: the ground comes in read (boatroute.ts Ground), the stores counted.
 */

/** A rail's shape as the game names it (RailShape): the way it runs, which way a slope rises, or the two ends of a curve. */
export type RailShape = 'north_south' | 'east_west' | 'ascending_north' | 'ascending_south' | 'ascending_east' | 'ascending_west'
  | 'north_east' | 'north_west' | 'south_east' | 'south_west';

/** One rail of the line: a plain rail, a powered one lit by a torch (`role` says why), or one of the brake's unlit ones. */
export interface RailCell { x: number; y: number; z: number; kind: 'rail' | 'powered' | 'brake'; shape: RailShape; role?: 'launch' | 'boost' | 'climb' }

/** A redstone torch of the line: where it stands, the rail it lights; `trigger`: the launch's, put down last (the cart goes). */
export interface RailTorch { at: Pos; lights: Pos; trigger?: true }

/** What the line takes: the items, and what they are made of. */
export interface RailBill {
  rail: number; powered_rail: number; redstone_torch: number; minecart: number; cobblestone: number;
  /** made of (26.3's recipes: 16 rails of 6 iron and a stick, 6 powered rails of 6 gold, a stick and a redstone, a torch of a redstone and a stick, a cart of 5 iron) */
  iron_ingot: number; gold_ingot: number; redstone: number; stick: number;
  /** what the stores hold toward it (ingots, and the raw ore that smelts to them), and what is short even so */
  have: Record<string, number>;
  short: string[];
}

/** The rails' plan: every block it would put down and take back up, and what it would open. */
export interface RailPlan {
  ok: true;
  /** the villager it was planned from (a candidate the judge allowed), where it stood, and the boat's hop to the pickup */
  villager: number;
  from: Pos;
  pickup: Pos;
  hop: number;
  /** the launch's stop: a cobblestone put down (`placed`) or a block of the ground standing there */
  stop: { at: Pos; placed: boolean };
  /** the line from the launch (0) to the brake's last rail, in the yard */
  cells: RailCell[];
  /** how many of them are the yard's stretch (from the fence's post in, the brake its last) */
  yard: number;
  torches: RailTorch[];
  /** dug for the line and put back after: the fence's post (and what stands on it); the hall's wall is the boat's to open */
  opens: { at: Pos; block: string }[];
  /** the hall's wall the boat move's last part opens from the boat (3 wide), and puts back */
  wall: Pos[];
  bill: RailBill;
  length: number; climb: number; drop: number;
  /** the legs in words: "south 120 (up 4, down 2), east 12, ..." */
  route: string;
  /** the work in seconds: laid walking home, the walk back out, the pickup, taken up walking home, the yard */
  seconds: { lay: number; back: number; pickup: number; takeUp: number; yard: number; total: number };
  /** the work fits in one day's light from the morning (WORK_AT to RETURN_AT) */
  fitsDay: boolean;
}

export type RailResult = RailPlan | { ok: false; why: string; at?: Pos };

/**
 * What a rail stands on, out in the world: natural ground only (each a rigid top, the scratch check ran them on the jar).
 * Nothing anyone built (planks, cobblestone, bricks: a rail on them would be put on someone's floor), no path or farmland
 * (no rigid top), no leaves.
 */
const RAIL_BASE = new RegExp('^(grass_block|dirt|coarse_dirt|podzol|mycelium|rooted_dirt|moss_block|stone|granite|diorite|andesite|deepslate|tuff'
  + '|calcite|sand|red_sand|gravel|sandstone|red_sandstone|clay|mud|terracotta'
  + '|(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_terracotta'
  + '|snow_block|ice|packed_ice|(deepslate_)?(coal|iron|copper|gold|redstone|lapis|diamond|emerald)_ore)$');
/** What a rail (or a torch) may be put into: air, or what a placed block replaces (BlockState.canBeReplaced, checked). */
const RAIL_ROOM = /^(air|cave_air|short_grass|fern|tall_grass|large_fern|dead_bush|bush|short_dry_grass|tall_dry_grass|leaf_litter|vine|glow_lichen)$/;

const idOf = (state: string) => state.replace(/^minecraft:/, '').replace(/\[.*$/, '');

/** A rail can stand on this block (and so can a redstone torch). Pure. */
export function railBase(state: string | null | undefined): boolean {
  return !!state && RAIL_BASE.test(idOf(state));
}
/** A rail can be put into this cell: air, or a plant a placed block replaces; one snow layer, not two. Pure. */
export function railRoom(state: string | null | undefined): boolean {
  if (!state) return false;
  const id = idOf(state);
  if (id === 'snow') return !/layers=([2-8])/.test(state);
  return RAIL_ROOM.test(id);
}
/** Air enough over the line for the villager's eye: nothing with a box (a flower, a torch are fine), no water. Pure. */
const airy = (state: string | null | undefined): boolean => !!state && cellOf(state).kind === 'open';

/** The stop's block: a natural block of the ground standing at the line's level (the launch pushes off it). */
const solidGround = (state: string | null | undefined): boolean => railBase(state) && cellOf(state!).kind === 'solid';

// ------------------------------------------------------------------------------------------------ the earthworks

/**
 * The earthworks an extension may make (the user's of Nov 21, "do whatever is needed to acquire the villager; consider
 * levelling the terrain": the west village on a hillside, no straight level run of 7 by any villager): natural ground
 * cut out of the way, cobblestone filled in under a rail, so that a head can lie level right beside a villager and the
 * way out climbs no more than a block a block. What a cut may take out: these natural blocks only (no village block,
 * no path, farmland, crop, log, plank or anything of a build, no ore).
 */
const EARTH_CUT = /^(grass_block|dirt|coarse_dirt|stone|andesite|diorite|granite|gravel|sand)$/;
/** The fluids a cut must not open (beside it, over it or under it). */
const FLUID = /^(water|lava|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;
/** At most this many cuts and fills an extension makes (its head, the boat's hop and its way together). */
export const EARTH_MAX = 40;
/** Cut no deeper and fill no higher than this in one column. */
export const EARTH_DEPTH = 2;
/** A levelled head's pickup this near a villager (the boat's hop then a block or two over ground it levelled itself). */
export const EARTH_NEAR = 3;
/** Cuts the boat's hop from the villager to a levelled head's pickup may make (one-block steps only). */
export const HOP_CUTS = 12;
/** What a cut or a fill costs the search (a rail is 1): a way round natural ground is taken before ground is changed. */
const EARTH_COST = 3;

/** One cut or fill: the cell, and the block that stood there before (a cut's is what the take-up puts back). */
export interface EarthEdit { x: number; y: number; z: number; op: 'cut' | 'fill'; was: string; hop?: true }

/** A block a cut may take out (natural ground of the user's list). Pure. */
export const earthCuttable = (state: string | null | undefined): boolean => !!state && EARTH_CUT.test(idOf(state));
const fluid = (state: string | null | undefined): boolean => !!state && (FLUID.test(idOf(state)) || /waterlogged=true/.test(state));

/** What the earthworks are kept off: `may(x, y, z)` false for a cell never cut or filled (a villager's column, a bed's, a house's...). */
export interface EarthOpts { may: (x: number, y: number, z: number) => boolean; max?: number }

/**
 * The cuts and fills (pure) that make (x, y, z) a place for a rail (room, natural ground or a fill under it, air over
 * it), a redstone torch (room and ground) or the launch's stop (natural ground standing there, else room and ground for
 * a cobblestone): [] when it is one already, undefined when it cannot be made one within the rules: a cut takes out only
 * EARTH_CUT blocks, at most EARTH_DEPTH of them from the cell up, never with a block over the top one that would fall or
 * be left hanging (only air or a plant a placed block replaces over it), never beside a fluid; a fill goes only into air
 * or such a plant, at most EARTH_DEPTH under the cell, on natural ground; never both in one column; every cell `may`'s.
 */
export function earthFor(at: (x: number, y: number, z: number) => string | null | undefined, x: number, y: number, z: number, need: 'rail' | 'torch' | 'stop', may: EarthOpts['may']): EarthEdit[] | undefined {
  const st = (yy: number) => at(x, yy, z);
  const here = st(y), below = st(y - 1), over = st(y + 1);
  if (here === undefined || here === null || below === undefined || below === null) return undefined;
  if (need === 'stop' && solidGround(here)) return [];
  const edits: EarthEdit[] = [];
  const cut = (yy: number, was: string) => edits.push({ x, y: yy, z, op: 'cut', was });
  if (!railRoom(here)) {
    if (!earthCuttable(here)) return undefined;
    cut(y, here);
  }
  if (need === 'rail') {
    if (over === undefined || over === null) return undefined;
    if (!airy(over)) {
      if (!earthCuttable(over)) return undefined;
      cut(y + 1, over);
    }
  }
  if (edits.length) {
    // (a block over the top cut that a cut may take, a torch's or the stop's: taken too, rather than left hanging)
    let top = Math.max(...edits.map(e => e.y));
    const above = st(top + 1);
    if (earthCuttable(above) && edits.length < EARTH_DEPTH && top + 1 === y + edits.length) { cut(top + 1, above!); top++; }
    if (edits.length > EARTH_DEPTH) return undefined;
    // nothing over the top cut to fall or be left hanging; no fluid beside, over or under a cut
    if (!railRoom(st(top + 1))) return undefined;
    for (const e of edits) {
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
        const n = at(x + dx, e.y + dy, z + dz);
        if (n === undefined || n === null || fluid(n)) return undefined;
      }
    }
  }
  if (!railBase(below)) {
    // (a fill: never in a column that is cut too, never into anything but air or a plant, on natural ground)
    if (edits.length || !railRoom(below)) return undefined;
    edits.push({ x, y: y - 1, z, op: 'fill', was: below });
    const b2 = st(y - 2);
    if (!railBase(b2)) {
      if (!railRoom(b2)) return undefined;
      edits.push({ x, y: y - 2, z, op: 'fill', was: b2! });
      if (!railBase(st(y - 3))) return undefined;
    }
  }
  return edits.every(e => may(e.x, e.y, e.z)) ? edits : undefined;
}

/** The ground as it will be once `edits` are made (pure): a cut is air, a fill is ground (natural ground to the planner's rules: the bot's own cobblestone). */
export function earthed(at: (x: number, y: number, z: number) => string | null | undefined, edits: readonly EarthEdit[]): (x: number, y: number, z: number) => string | null | undefined {
  if (!edits.length) return at;
  const m = new Map(edits.map(e => [`${e.x},${e.y},${e.z}`, e.op === 'cut' ? 'air' : 'stone']));
  return (x, y, z) => m.get(`${x},${y},${z}`) ?? at(x, y, z);
}

/** Where the line's parts sit, counted from the stop (0): the launch, the four plain rails, the pickup. */
export const HEAD = { launch: 1, pickup: 6 } as const;
/** The first lit powered rail after the pickup (an empty cart that missed its villager stops short of it). */
export const FIRST_BOOST = 8;
/** A lit powered rail this far after the last one on level track (a full cart is still at 0.3 a tick), or the first rail after with room. */
export const BOOST_EVERY = 32;
/** No lit rail for longer than this and the plan is refused (a full cart is down to about 0.17 a tick by then, at rest by 100). */
export const BOOST_GAP = 64;
/** One torch lights its rail and 8 more each way (PoweredRailBlock.findPoweredRailSignal). */
export const TORCH_REACH = 8;
/** The brake: unlit powered rails at the line's end (a full cart at full speed stops within the first). */
export const BRAKE = 2;
/** Plain rails at least between the last lit powered rail and the brake (else it lights the brake). */
const BRAKE_CLEAR = 2;
/** How far from a villager the pickup may be: the boat's hop on land with it (2 a second), straight. */
export const HOP = 6;
/**
 * How far from a villager an extension's new pickup may be (live, Nov 21: the hillside village had no level run of
 * 7 within HOP of any villager). The boat hop covers the rest: an extension is taken only when a villager can be
 * boated to its pickup or stands on it (railshome.ts extensionFor).
 */
export const EXT_REACH = 16;
/**
 * Of the line's cells from its launch, how many an extension may join at (live, Nov 21: a head by a villager found, its
 * way to the line's end blocked 10 short of it): the cells before the join are bypassed and taken up.
 */
export const JOIN_TAIL = 40;
/** Search costs: a rail is 1; a curve, a rail up (a powered rail and a share of a torch), a rail down, a block of the boat's hop (more than a rail: the pickup stays by the villager). */
const COST = { turn: 0.4, up: 1, down: 0.2, hop: 1.5 } as const;
/** The work's pace, for the time: a block laid (walked to and put down), one taken back up, a walk, the cart. */
export const PACE = { laySec: 1, takeSec: 0.8, walk: 3, pickupSec: 60, yardSec: 120 } as const;
const MS_PER_TICK = 50;

type Dir = 0 | 1 | 2 | 3;
/** north, east, south, west: [dx, dz] and the game's names */
const DIRS: { dx: number; dz: number; name: 'north' | 'east' | 'south' | 'west' }[] = [
  { dx: 0, dz: -1, name: 'north' }, { dx: 1, dz: 0, name: 'east' }, { dx: 0, dz: 1, name: 'south' }, { dx: -1, dz: 0, name: 'west' }
];
const dirOf = (dx: number, dz: number): Dir => (dz < 0 ? 0 : dx > 0 ? 1 : dz > 0 ? 2 : 3);
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
const fmt = (p: { x: number; y?: number; z: number }) => `(${Math.floor(p.x)}, ${p.y === undefined ? '' : `${Math.floor(p.y)}, `}${Math.floor(p.z)})`;

/** The ground as the planner reads it: block states (undefined where not read). */
export interface RailGround { state(x: number, y: number, z: number): string | null | undefined }

export interface RailOpts {
  /** the villagers that may be taken (the judge's candidates), nearest first */
  candidates: readonly { id: number; position?: Pos }[];
  /**
   * the boat move's way into the hall (boatroute.ts entryOf: the fence straight out from the panel, the hall's wall, the
   * stops; or yardEntry: in by a panel of the fence elsewhere and across the yard, its `yard`)
   */
  entry: Entry;
  /** the hall's panel (its bottom cell), or the middle post of a way in across the yard: the line comes in along its column */
  panel: Pos;
  /** the yard's box: the search keeps out of it (the line comes in by the panel's column only) */
  yard: { x1: number; z1: number; x2: number; z2: number };
  /** others' builds, the village's own left out (the caller's): the line keeps FROM_ZONES off each */
  zones?: readonly Zone[];
  /** the box the search keeps within */
  bounds?: { x1: number; z1: number; x2: number; z2: number };
  /** what the stores hold (the chests as last seen, and the pockets) */
  stores?: Record<string, number>;
  /** the fence's blocks as they stood before the ground was set to what the boat's openings would leave (the move's read) */
  fence?: readonly { at: Pos; block: string }[];
  maxNodes?: number;
  /** cells kept clear besides the zones (an extension's: the village's houses, beds, job sites and bells), rails, torches and the stop alike */
  avoid?: (x: number, y: number, z: number) => boolean;
}

/** What the search, the power and the torches go on: the yard's line and an extension's alike. */
type CoreOpts = Pick<RailOpts, 'candidates' | 'yard' | 'zones' | 'bounds' | 'maxNodes' | 'avoid'> & { reach?: number; earth?: EarthOpts };
/** Where the search ends: the goal cell and the way the line goes on from it; the rails after it (the yard's stretch, this plan's own), or the line it joins (an extension's: `tail`). */
interface CoreEnd {
  goal: Pos; goalDir: Dir; after: Pos[]; tail?: readonly RailCell[];
  /**
   * an extension's joins: the goal and its cells of the line's tail it may join instead (`skip`: how many of `tail`
   * are bypassed, taken up, when it joins there; entered by a curve only, the bypassed cells being the old line's), and
   * the old line's torches (no launch beside one: it would go lit)
   */
  joins?: readonly { at: Pos; dir: Dir; skip: number }[];
  torches?: readonly Pos[];
}
type Start = { villager: number; from: Pos; pickup: Pos; d: Dir; hop: number; stop: { at: Pos; placed: boolean }; earth: EarthEdit[] };
type CoreResult = { ok: true; start: Start; line: Pos[]; cells: RailCell[]; torches: RailTorch[]; earth: EarthEdit[]; skip: number } | { ok: false; why: string; at?: Pos };

/**
 * The rails' plan (pure): the yard's last stretch (the panel's column, from the fence's post to the brake two short of
 * the hall's wall) checked first; then a search from every pickup near a candidate villager (its head laid straight back
 * from it: the stop, the launch, four plain) to the cell outside the fence, over columns where a rail can stand: level,
 * or a block up or down a block on, a slope and the rails either side of it straight, no curve on a slope, no dip of
 * one rail (down then straight up again), no climb within 7 of the pickup, FROM_ZONES off every zone, never into the yard
 * but by its last stretch. Then the power (the launch, a rail up and a boost every 32 lit, the brake not), a torch for
 * each run within 8 of every rail of it, the shapes, the bill and the time. A line that would touch itself (rails beside
 * rails join up) is refused, with why.
 */
export function planRails(g: RailGround, opts: RailOpts): RailResult {
  const { entry, panel } = opts;
  // (in by the fence the boat's way comes in by: straight out from the hall's panel, or by a panel elsewhere)
  const fenceSide = entry.yard?.side ?? entry.side, fenceDir = entry.yard?.dir ?? entry.dir;
  const inward = { dx: -fenceDir[0], dz: -fenceDir[1] };
  const along = fenceSide === 'north' || fenceSide === 'south';
  const post = entry.fence.find(f => (along ? f.x === panel.x : f.z === panel.z));
  if (!post) return { ok: false, why: 'no fence post straight out from the hall\'s panel' };
  // dug for the line: the post and what stands on it (gone: air for the line's way)
  const dug = new Set([key(post.x, post.y, post.z), key(post.x, post.y + 1, post.z)]);
  const at = (x: number, y: number, z: number): string | null | undefined => (dug.has(key(x, y, z)) ? 'air' : g.state(x, y, z));
  const level = entry.level;

  // the yard's stretch: the post's cell inward to two short of the hall's wall (the boat's `front` stop), level throughout;
  // in by a panel of the fence elsewhere, the brake's own stretch in from the post (the boat's way across the yard takes
  // the villager on from there)
  const wallLine = along ? entry.wall[0].z : entry.wall[0].x;
  const fromPost = entry.yard ? BRAKE + BRAKE_CLEAR + 2 : along ? Math.abs(wallLine - post.z) : Math.abs(wallLine - post.x);
  const yardCells: Pos[] = [];
  for (let i = 0; i <= fromPost - 2; i++) yardCells.push({ x: post.x + inward.dx * i, y: level, z: post.z + inward.dz * i });
  if (yardCells.length < BRAKE + BRAKE_CLEAR + 1) return { ok: false, why: `the yard between the fence and the hall is too short for the brake (${yardCells.length} rails)` };
  for (const c of yardCells) {
    if (!railRoom(at(c.x, c.y, c.z)) || !railBase(at(c.x, c.y - 1, c.z)) || !airy(at(c.x, c.y + 1, c.z))) {
      const what = !railRoom(at(c.x, c.y, c.z)) ? at(c.x, c.y, c.z) : !railBase(at(c.x, c.y - 1, c.z)) ? at(c.x, c.y - 1, c.z) : at(c.x, c.y + 1, c.z);
      return { ok: false, why: `the rails' way in the yard is blocked at ${fmt(c)}: ${what ? idOf(what) : 'not read'}`, at: c };
    }
  }
  const goal = { x: post.x - inward.dx, y: level, z: post.z - inward.dz };
  const goalDir = dirOf(inward.dx, inward.dz);
  const core = lineCore(at, opts, { goal, goalDir, after: yardCells });
  if (!core.ok) return core;
  const { start, line, cells, torches } = core;

  // what it takes, what it opens, how long
  const n = (kind: RailCell['kind']) => cells.filter(c => c.kind === kind).length;
  const counts = { rail: n('rail'), powered_rail: n('powered') + n('brake'), redstone_torch: torches.length, minecart: 1, cobblestone: start.stop.placed ? 1 : 0 };
  const bill = billOf(counts, opts.stores ?? {});
  const stood = (p: Pos) => opts.fence?.find(o => o.at.x === p.x && o.at.y === p.y && o.at.z === p.z)?.block ?? g.state(p.x, p.y, p.z) ?? '';
  const opens = [post, { x: post.x, y: post.y + 1, z: post.z }].map(p => ({ at: { ...p }, block: stood(p) })).filter(o => o.block && !/^(minecraft:)?(air|cave_air)(\[|$)/.test(o.block));
  let climb = 0, drop = 0;
  for (let i = 1; i < line.length; i++) { const d = line[i].y - line[i - 1].y; if (d > 0) climb += d; else drop -= d; }
  const placed = cells.length + torches.length + counts.cobblestone;
  const seconds = {
    lay: Math.round(placed * PACE.laySec), back: Math.round(line.length / PACE.walk), pickup: PACE.pickupSec,
    takeUp: Math.round(placed * PACE.takeSec), yard: PACE.yardSec, total: 0
  };
  seconds.total = seconds.lay + seconds.back + seconds.pickup + seconds.takeUp + seconds.yard;
  return {
    ok: true, villager: start.villager, from: start.from, pickup: start.pickup, hop: Math.round(start.hop * 10) / 10, stop: start.stop,
    cells, yard: yardCells.length, torches, opens, wall: entry.wall.map(p => ({ ...p })), bill, length: line.length, climb, drop, route: routeText(start.stop.at, line), seconds,
    fitsDay: seconds.total * 1000 <= daylightLeft(WORK_AT) * MS_PER_TICK
  };
}

/** What an extension is planned on: the candidates and the keep-offs as planRails's, the line as it stands. */
export interface ExtendOpts extends CoreOpts {
  /** the line as it stands: its rails from the launch (0) to the brake, the launch's stop, and its torches */
  line: { cells: readonly RailCell[]; stop: { at: Pos; placed: boolean }; torches?: readonly RailTorch[] };
  /** of its cells from the launch, how many it may join at (JOIN_TAIL; 1: the launch's cell only) */
  joinTail?: number;
  /** the bot's own fills under the line (an extension's before): ground to the planner */
  ground?: readonly Pos[];
}

/** An extension of the line into the village: the new head and the way to the line's far end. */
export interface RailExtension {
  ok: true;
  villager: number;
  from: Pos;
  pickup: Pos;
  hop: number;
  stop: { at: Pos; placed: boolean };
  /** the new rails from the new launch (0) to the cell of the line it joins, its last (a plain rail now, or a boost) */
  cells: RailCell[];
  /** the line's cells before the join, from its launch (0: it joins at the launch's cell): bypassed, taken up */
  skip: number;
  /** the new torches, the new trigger among them */
  torches: RailTorch[];
  /** the cuts and fills it makes (none unless `earth` was asked): each made before the block of the line over it goes down */
  earth: EarthEdit[];
  length: number; climb: number; drop: number; powered: number;
  route: string;
}

/**
 * An extension of a line into the village (pure; the user's of Nov 21, the villagers uphill of a pickup no boat climbs
 * to): a new head beside a candidate, and the way from it to the line's far end, by planRails's rules (natural ground
 * only, nothing dug, a climb a powered rail, FROM_ZONES off the zones, never into the yard, `avoid` kept clear; with
 * `earth`, the ground levelled where it does not serve as it is: the head within EARTH_NEAR of a villager at its level,
 * the boat's hop, the way and its torches, by earthFor's rules, EARTH_MAX cuts and fills at most, all in `earth`), joined
 * to the old launch's cell, which goes on into the line: straight through the old stop's cell (the cobblestone stop
 * taken up first) or by a curve beside it. The old launch's cell is in the extension (a plain rail now, or a boost:
 * powered rails make no curve), the old trigger is no torch of it any more; the boosts are on BOOST_EVERY into the
 * line's first lit rail past the join. A way that would run beside the line (rails beside rails join up) is none.
 */
export function planExtension(g: RailGround, opts: ExtendOpts): RailExtension | { ok: false; why: string; at?: Pos } {
  const old = opts.line.cells;
  if (old.length < 2) return { ok: false, why: 'no line to extend' };
  const join = old[0], next = old[1];
  // the joins (the user's of Nov 21: live, the way to the line's end was blocked 10 short of it): its launch's cell, or
  // any of the JOIN_TAIL cells after it that runs level on into the line, outside the yard, not the brake, with plain
  // rails before it and at it (no lit run of the line cut through: its torch may light the rails past the join)
  const yd = opts.yard;
  const n = Math.min(opts.joinTail ?? JOIN_TAIL, old.length - 2);
  const joins: { at: Pos; dir: Dir; skip: number }[] = [];
  for (let j = 0; j < n; j++) {
    const c = old[j], nx = old[j + 1];
    if (nx.y !== c.y || c.kind === 'brake' || nx.kind === 'brake' || (c.x >= yd.x1 && c.x <= yd.x2 && c.z >= yd.z1 && c.z <= yd.z2)) continue;
    if (j > 0 && (c.kind !== 'rail' || old[j - 1].kind !== 'rail')) continue;
    joins.push({ at: { x: c.x, y: c.y, z: c.z }, dir: dirOf(Math.sign(nx.x - c.x), Math.sign(nx.z - c.z)), skip: j });
  }
  if (!joins.length) return { ok: false, why: `the line's end at ${fmt(join)} is not level, nor any of its next ${n - 1} cells` };
  // the line's cells it may bypass and the old stop (if it is the bot's cobblestone) read as they will be: taken up;
  // the bot's own fills under the line as ground
  const clear = new Set([...old.slice(0, n).map(c => key(c.x, c.y, c.z)), ...(opts.line.stop.placed ? [key(opts.line.stop.at.x, opts.line.stop.at.y, opts.line.stop.at.z)] : [])]);
  const fills = new Set((opts.ground ?? []).map(p => key(p.x, p.y, p.z)));
  const at = (x: number, y: number, z: number): string | null | undefined => (clear.has(key(x, y, z)) ? 'air' : fills.has(key(x, y, z)) ? 'stone' : g.state(x, y, z));
  const goalDir = dirOf(Math.sign(next.x - join.x), Math.sign(next.z - join.z));
  const core = lineCore(at, { ...opts, reach: opts.earth ? EARTH_NEAR : EXT_REACH }, {
    goal: { x: join.x, y: join.y, z: join.z }, goalDir, after: [], tail: old.slice(1), joins, torches: (opts.line.torches ?? []).filter(t => !t.trigger).map(t => t.at)
  });
  if (!core.ok) return core;
  const { start, line, cells, torches, earth, skip } = core;
  let climb = 0, drop = 0;
  for (let i = 1; i < line.length; i++) { const d = line[i].y - line[i - 1].y; if (d > 0) climb += d; else drop -= d; }
  return {
    ok: true, villager: start.villager, from: start.from, pickup: start.pickup, hop: Math.round(start.hop * 10) / 10, stop: start.stop,
    cells, skip, torches, earth, length: line.length, climb, drop, powered: cells.filter(c => c.kind !== 'rail').length, route: routeText(start.stop.at, line)
  };
}

/**
 * The search, the power and the torches of a line (pure, planRails's and planExtension's): from every pickup near a
 * candidate to `goal`, entered so that it goes on `goalDir`; then the rails after it (`after`), or the line it joins
 * (`tail`: kept off but at the goal, its first lit rail the boosts' next). `at` reads the ground as the line would find it.
 */
function lineCore(at: (x: number, y: number, z: number) => string | null | undefined, opts: CoreOpts, to: CoreEnd): CoreResult {
  const reach = opts.reach ?? HOP;
  // where a rail can go, by cell (cached: the search asks again and again)
  const okCache = new Map<string, boolean>();
  const railAt = (x: number, y: number, z: number): boolean => {
    const k = key(x, y, z);
    let v = okCache.get(k);
    if (v === undefined) {
      v = railRoom(at(x, y, z)) && railBase(at(x, y - 1, z)) && airy(at(x, y + 1, z));
      okCache.set(k, v);
    }
    return v;
  };
  const { after } = to;
  const yard = opts.yard;
  const zones = opts.zones ?? [];
  const tailAll = to.tail ?? [];
  // (the goals: the line's end, and an extension's joins on the tail)
  const goals = to.joins?.length ? [...to.joins] : [{ at: to.goal, dir: to.goalDir, skip: 0 }];
  const goalAt = new Map(goals.map(gl => [key(gl.at.x, gl.at.y, gl.at.z), gl]));
  const inYard = (x: number, z: number) => x >= yard.x1 && x <= yard.x2 && z >= yard.z1 && z <= yard.z2;
  const b = opts.bounds;
  const inBounds = (x: number, z: number) => !b || (x >= b.x1 && x <= b.x2 && z >= b.z1 && z <= b.z2);
  const offZones = (x: number, y: number, z: number) => !zoneNear(zones, { x: x + 0.5, y, z: z + 0.5 }, FROM_ZONES) && !opts.avoid?.(x, y, z);
  // (an extension keeps off the line it joins, but at the goal: rails beside rails join up)
  const tailAt = new Map<string, number[]>();
  const isGoal = (x: number, y: number, z: number) => goalAt.has(key(x, y, z));
  // (the join cells aside: the way comes in beside its own; one that would run beside the line kept is refused as it
  // reaches the join, touching)
  for (const c of tailAll) if (!isGoal(c.x, c.y, c.z)) tailAt.set(`${c.x},${c.z}`, [...(tailAt.get(`${c.x},${c.z}`) ?? []), c.y]);
  const byTail = (x: number, y: number, z: number): boolean => {
    if (!tailAll.length || isGoal(x, y, z)) return false;
    for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) for (const ty of tailAt.get(`${x + ox},${z + oz}`) ?? []) if (Math.abs(ty - y) <= (ox || oz ? 1 : 2)) return true;
    return false;
  };
  // (a launch beside the old line's torch, or over one, would be lit before its trigger)
  const oldTorches = new Set((to.torches ?? []).map(t => key(t.x, t.y, t.z)));
  const byOldTorch = (l: Pos) => [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]].some(([ox, oy, oz]) => oldTorches.has(key(l.x + ox, l.y + oy, l.z + oz)));
  const torchSpot = (x: number, y: number, z: number) => railRoom(at(x, y, z)) && railBase(at(x, y - 1, z)) && offZones(x, y, z) && !inYard(x, z);

  // the starts: a pickup within HOP of a candidate (the boat's hop to it straight and level-or-down), its head behind it
  const starts: Start[] = [];
  for (const e of opts.candidates.slice(0, 4)) {
    if (!e.position) continue;
    const vx = Math.floor(e.position.x), vz = Math.floor(e.position.z);
    for (let px = vx - reach; px <= vx + reach; px++) for (let pz = vz - reach; pz <= vz + reach; pz++) {
      const hop = Math.hypot(px + 0.5 - e.position.x, pz + 0.5 - e.position.z);
      if (hop > reach || inYard(px, pz) || !inBounds(px, pz)) continue;
      // the boat's hop on the ground as it is, from where the villager stands to the pickup's middle: where it comes to
      // rest is the rail's cell (the boat's bottom on the ground's top; a little under it on mud)
      let level = e.position.y;
      if (hop > 0.5) {
        const leg = checkLeg({ cell: (x, y, z) => cellOf(at(x, y, z)) }, { x: e.position.x, z: e.position.z, level: e.position.y }, { x: px + 0.5, z: pz + 0.5 });
        if (!leg.ok) continue;
        level = leg.level;
      }
      const py = Math.round(level);
      if (Math.abs(level - py) > 0.25 || !railAt(px, py, pz) || !offZones(px, py, pz) || (tailAll.length && (isGoal(px, py, pz) || byTail(px, py, pz)))) continue;
      for (const d of [0, 1, 2, 3] as Dir[]) {
        const { dx, dz } = DIRS[d];
        const back = (n: number) => ({ x: px - dx * n, y: py, z: pz - dz * n });
        let fine = true;
        for (let n = 1; n < HEAD.pickup && fine; n++) {
          const c = back(n);
          fine = railAt(c.x, c.y, c.z) && !inYard(c.x, c.z) && inBounds(c.x, c.z) && offZones(c.x, c.y, c.z) && !(tailAll.length && (isGoal(c.x, c.y, c.z) || byTail(c.x, c.y, c.z)));
        }
        if (!fine) continue;
        const s = back(HEAD.pickup);
        const there = at(s.x, s.y, s.z);
        const stop = solidGround(there) ? { at: s, placed: false } : railRoom(there) && railBase(at(s.x, s.y - 1, s.z)) && !inYard(s.x, s.z) && offZones(s.x, s.y, s.z) ? { at: s, placed: true } : undefined;
        if (!stop || (tailAll.length && (isGoal(s.x, s.y, s.z) || byTail(s.x, s.y, s.z)))) continue;
        // (the boat's hop must not run over the stop's block)
        if (stop.placed && offSegment({ x: e.position.x, z: e.position.z }, { x: px + 0.5, z: pz + 0.5 }, { x: s.x + 0.5, z: s.z + 0.5 }) < 1.5) continue;
        // the launch's torch beside it, at its level (the trigger)
        const l = back(HEAD.pickup - HEAD.launch);
        if (!sides(l, d).some(t => torchSpot(t.x, t.y, t.z)) || byOldTorch(l)) continue;
        starts.push({ villager: e.id, from: { x: e.position.x, y: e.position.y, z: e.position.z }, pickup: { x: px, y: py, z: pz }, d, hop, stop, earth: [] });
      }
    }
  }
  // (the earthworks: the head levelled right beside a villager, EARTH_NEAR, at the level it stands at; every cut and fill
  // costed, EARTH_MAX of them at most)
  const earth = opts.earth;
  const earthMax = earth?.max ?? EARTH_MAX;
  const earthCache = new Map<string, EarthEdit[] | null>();
  const earthAt = (x: number, y: number, z: number, need: 'rail' | 'torch' | 'stop'): EarthEdit[] | undefined => {
    if (!earth) return undefined;
    const k = `${need}:${x},${y},${z}`;
    let v = earthCache.get(k);
    if (v === undefined) { v = earthFor(at, x, y, z, need, earth.may) ?? null; earthCache.set(k, v); }
    return v ?? undefined;
  };
  if (earth) {
    starts.length = 0;
    for (const e of opts.candidates.slice(0, 4)) {
      if (!e.position) continue;
      const vx = Math.floor(e.position.x), vz = Math.floor(e.position.z), py = Math.round(e.position.y);
      if (Math.abs(e.position.y - py) > 0.25) continue;
      for (let px = vx - reach; px <= vx + reach; px++) for (let pz = vz - reach; pz <= vz + reach; pz++) {
        const hop = Math.hypot(px + 0.5 - e.position.x, pz + 0.5 - e.position.z);
        if (hop > reach || inYard(px, pz) || !inBounds(px, pz)) continue;
        for (const d of [0, 1, 2, 3] as Dir[]) {
          const { dx, dz } = DIRS[d];
          const back = (n: number) => ({ x: px - dx * n, y: py, z: pz - dz * n });
          const edits: EarthEdit[] = [];
          let fine = true;
          for (let n = 0; n <= HEAD.pickup && fine; n++) {
            const c = back(n);
            fine = !inYard(c.x, c.z) && inBounds(c.x, c.z) && offZones(c.x, c.y, c.z) && !(tailAll.length && (isGoal(c.x, c.y, c.z) || byTail(c.x, c.y, c.z)));
            const w = fine ? earthAt(c.x, c.y, c.z, n === HEAD.pickup ? 'stop' : 'rail') : undefined;
            if (!w) fine = false; else edits.push(...w);
          }
          if (!fine) continue;
          const s = back(HEAD.pickup);
          const stopPlaced = !solidGround(at(s.x, s.y, s.z)) || edits.some(w => w.x === s.x && w.z === s.z);
          if (stopPlaced && offSegment({ x: e.position.x, z: e.position.z }, { x: px + 0.5, z: pz + 0.5 }, { x: s.x + 0.5, z: s.z + 0.5 }) < 1.5) continue;
          // the launch's torch beside it: the side that needs the fewest cuts and fills
          const l = back(HEAD.pickup - HEAD.launch);
          if (byOldTorch(l)) continue;
          const torch = sides(l, d).filter(q => offZones(q.x, q.y, q.z) && !inYard(q.x, q.z)).map(q => earthAt(q.x, q.y, q.z, 'torch')).filter((w): w is EarthEdit[] => !!w).sort((a, b) => a.length - b.length)[0];
          if (!torch) continue;
          edits.push(...torch);
          if (edits.length > earthMax) continue;
          // the boat's hop on the ground as levelled, from where the villager stands to the pickup's middle: a one-block
          // step in its way (the box and the slack either side) cut too, HOP_CUTS at most
          let level = e.position.y;
          if (hop > 0.5) {
            let leg: ReturnType<typeof checkLeg> | undefined;
            for (let tries = 0; tries <= HOP_CUTS; tries++) {
              const g2 = earthed(at, edits);
              leg = checkLeg({ cell: (x, y, z) => cellOf(g2(x, y, z)) }, { x: e.position.x, z: e.position.z, level: e.position.y }, { x: px + 0.5, z: pz + 0.5 });
              if (leg.ok || tries === HOP_CUTS || !/^a step up/.test(leg.why) || leg.at.y !== py) break;
              const c = leg.at;
              const st = g2(c.x, c.y, c.z);
              // (no cut under the villager, in the head's own cells, or with more than air over it)
              const cutOk = earthCuttable(st) && earth.may(c.x, c.y, c.z) && offZones(c.x, c.y, c.z) && !inYard(c.x, c.z) && railRoom(g2(c.x, c.y + 1, c.z))
                && airy(g2(c.x, c.y + 2, c.z)) && [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]].every(([ox, oy, oz]) => { const n = at(c.x + ox, c.y + oy, c.z + oz); return n !== undefined && n !== null && !fluid(n); });
              if (!cutOk || edits.length >= earthMax) break;
              edits.push({ x: c.x, y: c.y, z: c.z, op: 'cut', was: st!, hop: true });
            }
            if (!leg?.ok) continue;
            level = leg.level;
          }
          if (Math.abs(level - py) > 0.25 || edits.length > earthMax) continue;
          starts.push({ villager: e.id, from: { x: e.position.x, y: e.position.y, z: e.position.z }, pickup: { x: px, y: py, z: pz }, d, hop, stop: { at: s, placed: stopPlaced }, earth: edits });
        }
      }
    }
  }
  if (!starts.length) {
    return { ok: false, why: earth ? `no pickup by a villager to take: no head of 7 rails (and a stop and a torch) to be levelled within ${reach} of one, at most ${EARTH_DEPTH} cut or filled a column and ${earthMax} in all`
      : `no pickup by a villager to take: no straight, level run of 7 rails on open ground (and a stop and a torch) within ${reach} of one` };
  }

  // the search: states (cell, way in, step in, the turn the rail before made, rails since the pickup up to FIRST_BOOST)
  type Node = { x: number; y: number; z: number; d: Dir; dy: number; rot: number; k: number; g: number; prev?: Node; start: Start; earth?: EarthEdit[]; e: number };
  const sk = (n: Pick<Node, 'x' | 'y' | 'z' | 'd' | 'dy' | 'rot' | 'k'>) => `${n.x},${n.y},${n.z},${n.d},${n.dy},${n.rot},${n.k}`;
  const h = (x: number, z: number) => { let m = Infinity; for (const gl of goals) m = Math.min(m, Math.abs(x - gl.at.x) + Math.abs(z - gl.at.z)); return m; };
  // (the levelled search goes greedier: its states are many more, every height a cut or a fill may make)
  const hw = earth ? 1.4 : 1;
  const heap: { f: number; n: Node }[] = [];
  const push = (n: Node) => {
    heap.push({ f: n.g + hw * h(n.x, n.z), n });
    for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p].f <= heap[i].f) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = (): Node | undefined => {
    if (!heap.length) return undefined;
    const top = heap[0].n;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const best = new Map<string, number>();
  for (const s of starts) {
    const n: Node = { ...s.pickup, d: s.d, dy: 0, rot: 0, k: 0, g: s.hop * COST.hop + s.earth.length * EARTH_COST, start: s, e: s.earth.length };
    const kk = sk(n);
    if ((best.get(kk) ?? Infinity) <= n.g) continue;
    best.set(kk, n.g);
    push(n);
  }
  // (beside its own head, or over or under it: rails there would join up with it; the rest of the line is looked at once
  // found, touching)
  const byHead = (st: Start, x: number, y: number, z: number) => {
    for (let n = 1; n <= HEAD.pickup; n++) {
      const hx = st.pickup.x - DIRS[st.d].dx * n, hz = st.pickup.z - DIRS[st.d].dz * n;
      if (Math.abs(x - hx) + Math.abs(z - hz) <= 1 && Math.abs(y - st.pickup.y) <= 2) return true;
    }
    return false;
  };
  // (a way to a join that would run beside the line kept from there, or over it: rails side by side join up)
  const joinTouches = (n: Node, skip: number): boolean => {
    const p: Pos[] = [];
    for (let q: Node | undefined = n; q; q = q.prev) p.unshift({ x: q.x, y: q.y, z: q.z });
    const st = n.start;
    const hd: Pos[] = [];
    for (let i = HEAD.pickup - HEAD.launch; i >= 1; i--) hd.push({ x: st.pickup.x - DIRS[st.d].dx * i, y: st.pickup.y, z: st.pickup.z - DIRS[st.d].dz * i });
    return !!touching([st.stop.at, ...hd, ...p, ...tailAll.slice(skip).map(c => ({ x: c.x, y: c.y, z: c.z }))]);
  };
  const maxNodes = opts.maxNodes ?? 250_000;
  const closed = new Set<string>();
  let looked = 0, end: Node | undefined, nearest: Node | undefined;
  while (looked < maxNodes) {
    const n = pop();
    if (!n) break;
    const nk = sk(n);
    if (closed.has(nk)) continue;
    closed.add(nk);
    looked++;
    if (!nearest || h(n.x, n.z) < h(nearest.x, nearest.z)) nearest = n;
    // at the cell outside the fence: on into the yard's stretch, straight, or by a curve there (level, and not a second
    // curve the same way round)
    // (a join on the tail: by a curve only, the old line's rails before it bypassed; nothing goes on from a goal's cell)
    const gl = goalAt.get(key(n.x, n.y, n.z));
    if (gl) {
      if (n.d !== ((gl.dir + 2) % 4) && ((n.d === gl.dir && gl.skip === 0) || (n.d !== gl.dir && n.dy === 0 && (gl.dir === (n.d + 1) % 4 ? 1 : -1) !== n.rot))
        && !(goals.length > 1 && joinTouches(n, gl.skip))) { end = n; break; }
      continue;
    }
    for (const d2 of [0, 1, 2, 3] as Dir[]) {
      if (d2 === (n.d + 2) % 4) continue;
      const turn = d2 !== n.d;
      // (the pickup's own rail runs straight on; a curve only between two level rails)
      if (turn && (n.k === 0 || n.dy !== 0)) continue;
      // two curves one after the other the same way round turn the line back beside itself (a U one rail wide: rails
      // side by side join up); the other way round they make a diagonal, which carts ride
      const rot = !turn ? 0 : d2 === (n.d + 1) % 4 ? 1 : -1;
      if (rot !== 0 && rot === n.rot) continue;
      const { dx, dz } = DIRS[d2];
      const x = n.x + dx, z = n.z + dz;
      if (!inBounds(x, z)) continue;
      // (into the yard only at the goal's cell, by the fence's post: the goal is the cell outside it)
      if (inYard(x, z)) continue;
      for (const dy of [0, 1, -1]) {
        if (dy !== 0 && turn) continue;
        // a rail up then straight down again is a hump (fine); down then up is a dip of one rail, which no rail shape makes
        if (n.dy === -1 && dy === 1) continue;
        // no lit rail within 7 of the pickup: a climb there is one
        if (dy === 1 && n.k < FIRST_BOOST) continue;
        const y = n.y + dy;
        if (!offZones(x, y, z) || byHead(n.start, x, y, z) || byTail(x, y, z)) continue;
        // (the ground as it is, else levelled for it: the cuts and fills costed, EARTH_MAX in all)
        const w = railAt(x, y, z) ? undefined : earthAt(x, y, z, 'rail');
        if (!railAt(x, y, z) && (!w || n.e + w.length > earthMax)) continue;
        // a slope rail has two blocks of air over it: the one going up (here), or the one coming down (there)
        if (dy === 1 && !airy(at(n.x, n.y + 2, n.z))) continue;
        if (dy === -1 && !airy(at(x, y + 2, z))) continue;
        const m: Node = {
          x, y, z, d: d2, dy, rot, k: Math.min(FIRST_BOOST, n.k + 1), g: n.g + 1 + (turn ? COST.turn : 0) + (dy > 0 ? COST.up : dy < 0 ? COST.down : 0) + (w ? w.length * EARTH_COST : 0),
          prev: n, start: n.start, e: n.e + (w?.length ?? 0), ...(w?.length ? { earth: w } : {})
        };
        const mk = sk(m);
        if (closed.has(mk) || (best.get(mk) ?? Infinity) <= m.g) continue;
        best.set(mk, m.g);
        push(m);
      }
    }
  }
  if (!end) {
    const near = nearest ? `; it got no nearer than ${h(nearest.x, nearest.z)} (at ${fmt(nearest)})` : '';
    const lim = earth ? ` (at most ${EARTH_DEPTH} cut or filled a column, ${earthMax} in all)` : '';
    const joins = goals.length > 1 ? ` (or any of the ${goals.length - 1} cells on from it)` : '';
    return { ok: false, why: `no rails way to ${tailAll.length ? 'the line\'s end' : 'the yard\'s fence'} at ${fmt(to.goal)}${joins}${looked >= maxNodes ? ` within ${maxNodes} steps` : ''}${lim}${near}`, ...(nearest ? { at: { x: nearest.x, y: nearest.y, z: nearest.z } } : {}) };
  }
  const path: Pos[] = [];
  const edits: EarthEdit[] = [];
  for (let n: Node | undefined = end; n; n = n.prev) { path.unshift({ x: n.x, y: n.y, z: n.z }); if (n.earth) edits.unshift(...n.earth); }
  const start = end.start;
  edits.unshift(...start.earth);
  // (the line it joins, from the join on: the cells before it bypassed)
  const joined = goalAt.get(key(end.x, end.y, end.z))!;
  const tail = tailAll.slice(joined.skip);
  const head: Pos[] = [];
  for (let n = HEAD.pickup - HEAD.launch; n >= 1; n--) head.push({ x: start.pickup.x - DIRS[start.d].dx * n, y: start.pickup.y, z: start.pickup.z - DIRS[start.d].dz * n });
  // the whole line: the launch and the four plain, the pickup and the way, the yard's stretch (an extension: the way to
  // the line it joins, and that line on from there, `whole`)
  const line: Pos[] = [...head, ...path, ...after];
  const whole: Pos[] = [...line, ...tail.map(c => ({ x: c.x, y: c.y, z: c.z }))];
  const touch = touching([start.stop.at, ...whole]);
  if (touch) return { ok: false, why: `the line would run beside itself at ${fmt(touch[0])} and ${fmt(touch[1])} (rails side by side join up)`, at: touch[0] };
  // (the cuts and fills: one of a cell each, none of them a cell of the line but a rail's own cut, the torches placed on
  // the ground as levelled)
  const editAt = new Set<string>();
  const cellsAt = new Set(whole.map(p => key(p.x, p.y, p.z)));
  for (const w of edits) {
    const kk = key(w.x, w.y, w.z);
    if (editAt.has(kk) || (cellsAt.has(kk) && w.op !== 'cut')) return { ok: false, why: `the earthworks would meet themselves at ${fmt(w)}`, at: { x: w.x, y: w.y, z: w.z } };
    editAt.add(kk);
  }
  if (edits.length > earthMax) return { ok: false, why: `the way needs ${edits.length} cuts and fills (${earthMax} at most)` };
  // (the ground as levelled so far: the torches' own cuts and fills join it as they are placed)
  const editMap = new Map<string, string>();
  const addEdits = (ws: readonly EarthEdit[]) => { for (const w of ws) { edits.push(w); editMap.set(key(w.x, w.y, w.z), w.op === 'cut' ? 'air' : 'stone'); } };
  for (const w of edits) editMap.set(key(w.x, w.y, w.z), w.op === 'cut' ? 'air' : 'stone');
  const lv = (x: number, y: number, z: number) => editMap.get(key(x, y, z)) ?? at(x, y, z);
  const torchSpotE = (x: number, y: number, z: number) => railRoom(lv(x, y, z)) && railBase(lv(x, y - 1, z)) && offZones(x, y, z) && !inYard(x, z);

  // the power
  const pickupAt = HEAD.pickup - HEAD.launch;
  // (an extension has no brake of its own: the line it joins ends on its brake; its lit rails run to the join)
  const brakeAt = tail.length ? line.length : line.length - BRAKE;
  const litEnd = tail.length ? line.length : brakeAt - BRAKE_CLEAR;
  const kinds: RailCell['kind'][] = line.map(() => 'rail');
  const roles: (RailCell['role'] | undefined)[] = line.map(() => undefined);
  kinds[0] = 'powered'; roles[0] = 'launch';
  for (let i = brakeAt; i < line.length; i++) kinds[i] = 'brake';
  // every rail going up is lit (it sits under the next, higher one)
  for (let i = pickupAt; i < litEnd; i++) if (whole[i + 1].y > whole[i].y) { kinds[i] = 'powered'; roles[i] = 'climb'; }
  const straightLevel = (i: number) => i > 0 && i < whole.length - 1 && whole[i - 1].y === whole[i].y && whole[i + 1].y === whole[i].y
    && whole[i + 1].x - whole[i].x === whole[i].x - whole[i - 1].x && whole[i + 1].z - whole[i].z === whole[i].z - whole[i - 1].z;
  // the torches: one for the launch (the trigger), then the runs of lit rails, each rail within TORCH_REACH of one
  const lineSet = new Set(whole.map(p => key(p.x, p.y, p.z)));
  const brakeSet = new Set([...line.slice(brakeAt), ...tail.filter(c => c.kind === 'brake')].map(p => key(p.x, p.y, p.z)));
  const launchKey = key(line[0].x, line[0].y, line[0].z);
  const torchOk = (t: Pos, trigger: boolean, spot = true) => {
    if ((spot && !torchSpotE(t.x, t.y, t.z)) || lineSet.has(key(t.x, t.y, t.z)) || lineSet.has(key(t.x, t.y - 1, t.z)) || lineSet.has(key(t.x, t.y - 2, t.z))) return false;
    if (t.x === start.stop.at.x && t.y === start.stop.at.y && t.z === start.stop.at.z) return false;
    // what it lights: the cells beside it, and the one over it
    for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const k = key(t.x + ox, t.y + oy, t.z + oz);
      if (brakeSet.has(k) || (!trigger && k === launchKey)) return false;
    }
    return true;
  };
  const wayOf = (i: number): Dir => (i === 0 ? start.d : dirOf(Math.sign(whole[i].x - whole[i - 1].x), Math.sign(whole[i].z - whole[i - 1].z)));
  const torches: RailTorch[] = [];
  const taken = new Set<string>();
  // (with the earthworks, a torch's place levelled when none stands as the ground is: within EARTH_MAX, never in the
  // line's cells, under one or in a cell levelled already)
  const torchEarth = (t: Pos, trigger: boolean): EarthEdit[] | undefined => {
    if (!earth || !offZones(t.x, t.y, t.z) || inYard(t.x, t.z) || !torchOk(t, trigger, false)) return undefined;
    const w = earthFor(lv, t.x, t.y, t.z, 'torch', earth.may);
    if (!w?.length || edits.length + w.length > earthMax) return undefined;
    return w.every(e => !lineSet.has(key(e.x, e.y, e.z)) && !lineSet.has(key(e.x, e.y + 1, e.z)) && !editMap.has(key(e.x, e.y, e.z))) ? w : undefined;
  };
  const torchCan = (t: Pos, trigger: boolean) => torchOk(t, trigger) || !!torchEarth(t, trigger);
  const placeTorch = (i: number, trigger: boolean): boolean => {
    for (const levelled of [false, true]) {
      for (const t of sides(line[i], wayOf(i))) {
        if (taken.has(key(t.x, t.y, t.z))) continue;
        const w = levelled ? torchEarth(t, trigger) : undefined;
        if (levelled ? !w : !torchOk(t, trigger)) continue;
        if (w) addEdits(w);
        taken.add(key(t.x, t.y, t.z));
        torches.push({ at: t, lights: { ...line[i] }, ...(trigger ? { trigger: true as const } : {}) });
        return true;
      }
    }
    return false;
  };
  if (!placeTorch(0, true)) return { ok: false, why: `no room for the launch's torch beside ${fmt(line[0])}`, at: line[0] };
  // the boosts on level track: the first FIRST_BOOST after the pickup, then BOOST_EVERY after the last lit rail (a climb's
  // are lit too), each on the first straight level rail from there with room for a torch beside it
  let lastLit = pickupAt + FIRST_BOOST - BOOST_EVERY;
  for (let i = pickupAt + FIRST_BOOST; i < litEnd; i++) {
    if (kinds[i] === 'powered') { lastLit = i; continue; }
    const since = i - lastLit;
    if (since < BOOST_EVERY) continue;
    if (straightLevel(i) && sides(line[i], wayOf(i)).some(t => torchCan(t, false))) { kinds[i] = 'powered'; roles[i] = 'boost'; lastLit = i; continue; }
    if (since >= BOOST_GAP) return { ok: false, why: `no straight, level rail with room for a torch beside it within ${BOOST_GAP} of the last lit one, at ${fmt(line[i])}`, at: line[i] };
  }
  if (tail.length) {
    // (an extension: on into the line it joins, whose first lit rail is the next; when that is more than BOOST_EVERY
    // on, one more boost: the first with room within BOOST_EVERY of it, else the nearest to it there is room for)
    const first = tail.findIndex(c => c.kind === 'powered');
    const next = line.length + (first < 0 ? tail.length : first);
    if (next - lastLit > BOOST_EVERY) {
      const room = (i: number) => kinds[i] !== 'powered' && straightLevel(i) && sides(line[i], wayOf(i)).some(t => torchCan(t, false));
      const from = Math.max(lastLit + 1, pickupAt + FIRST_BOOST);
      let put = -1;
      for (let i = Math.max(from, next - BOOST_EVERY); i < litEnd && put < 0; i++) if (room(i)) put = i;
      for (let i = litEnd - 1; i >= from && put < 0; i--) if (room(i)) put = i;
      if (put >= 0) { kinds[put] = 'powered'; roles[put] = 'boost'; lastLit = put; }
    }
    if (next - lastLit > BOOST_GAP) return { ok: false, why: `no lit rail for the ${next - lastLit} from ${fmt(line[Math.max(0, lastLit)])} on into the line`, at: line[Math.max(0, lastLit)] };
  } else if (brakeAt - BRAKE_CLEAR - lastLit > BOOST_GAP) return { ok: false, why: `no lit rail for the last ${brakeAt - lastLit} before the brake`, at: line[brakeAt] };
  // the runs of lit rails (the launch aside: its torch is the trigger): a torch within TORCH_REACH of every rail
  for (let i = pickupAt; i < brakeAt;) {
    if (kinds[i] !== 'powered') { i++; continue; }
    let j = i;
    while (j + 1 < brakeAt && kinds[j + 1] === 'powered') j++;
    for (let u = i; u <= j;) {
      let put = -1;
      for (let t = Math.min(j, u + TORCH_REACH); t >= Math.max(i, u - TORCH_REACH) && put < 0; t--) if (placeTorch(t, false)) put = t;
      if (put < 0) return { ok: false, why: `no room for a redstone torch by the powered rails at ${fmt(line[u])}`, at: line[u] };
      u = put + TORCH_REACH + 1;
    }
    i = j + 1;
  }
  const cells: RailCell[] = line.map((p, i) => ({ ...p, kind: kinds[i], shape: shapeOf(i === 0 ? start.stop.at : whole[i - 1], p, whole[i + 1]), ...(roles[i] ? { role: roles[i] } : {}) }));
  // (the launch's torch side levelled for it but not taken, the other one fit as it stands: left as it is)
  const used = new Set([...line, start.stop.at, ...torches.map(t => t.at)].map(p => `${p.x},${p.z}`));
  const spare = new Set(sides(line[0], start.d).map(p => `${p.x},${p.z}`).filter(c => !used.has(c)));
  return { ok: true, start, line, cells, torches, earth: edits.filter(w => w.hop || !spare.has(`${w.x},${w.z}`)), skip: joined.skip };
}


/** The cells either side of a rail, across its way, at its level (where a torch beside it stands). */
function sides(p: Pos, d: Dir): Pos[] {
  const { dx, dz } = DIRS[d];
  return [{ x: p.x + dz, y: p.y, z: p.z - dx }, { x: p.x - dz, y: p.y, z: p.z + dx }];
}

/** Two rails of the line beside each other (or one over another) that are not one after the other: the first such, or none. */
function touching(line: Pos[]): [Pos, Pos] | undefined {
  const index = new Map<string, number[]>();
  line.forEach((p, i) => { const k = `${p.x},${p.z}`; index.set(k, [...(index.get(k) ?? []), i]); });
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const j of index.get(`${p.x + ox},${p.z + oz}`) ?? []) {
        if (Math.abs(j - i) <= 1) continue;
        // (beside it a block up or down joins up too; over it, within two, the cart's rider would hit it)
        if (Math.abs(line[j].y - p.y) <= (ox || oz ? 1 : 2)) return [p, line[j]];
      }
    }
  }
  return undefined;
}

/** A rail's shape from the rails before and after it (pure): up toward the higher one, else straight, else a curve. */
export function shapeOf(prev: Pos, cur: Pos, next?: Pos): RailShape {
  const to = (o: Pos) => DIRS[dirOf(Math.sign(o.x - cur.x), Math.sign(o.z - cur.z))].name;
  if (next && next.y > cur.y) return `ascending_${to(next)}` as RailShape;
  if (prev.y > cur.y) return `ascending_${to(prev)}` as RailShape;
  const a = to(prev), b = next ? to(next) : (({ north: 'south', south: 'north', east: 'west', west: 'east' }) as const)[a];
  const set = new Set([a, b]);
  if (set.has('north') && set.has('south')) return 'north_south';
  if (set.has('east') && set.has('west')) return 'east_west';
  return `${set.has('north') ? 'north' : 'south'}_${set.has('east') ? 'east' : 'west'}` as RailShape;
}

/** The line in words: each straight run, which way and how long, with its climbs and drops. */
function routeText(stop: Pos, line: Pos[]): string {
  const runs: { way: string; n: number; up: number; down: number }[] = [];
  let prev = stop;
  for (const p of line) {
    const way = DIRS[dirOf(Math.sign(p.x - prev.x), Math.sign(p.z - prev.z))].name;
    const last = runs[runs.length - 1];
    const r = last && last.way === way ? last : (runs.push({ way, n: 0, up: 0, down: 0 }), runs[runs.length - 1]);
    r.n++;
    if (p.y > prev.y) r.up += p.y - prev.y;
    if (p.y < prev.y) r.down += prev.y - p.y;
    prev = p;
  }
  return runs.map(r => `${r.way} ${r.n}${r.up || r.down ? ` (${[r.up ? `up ${r.up}` : '', r.down ? `down ${r.down}` : ''].filter(Boolean).join(', ')})` : ''}`).join(', ');
}

/** The 26.3 recipes the line's parts are made by (data/minecraft/recipe/*.json): what one craft makes and takes. */
export const RAIL_RECIPES = {
  rail: { makes: 16, from: { iron_ingot: 6, stick: 1 } },
  powered_rail: { makes: 6, from: { gold_ingot: 6, stick: 1, redstone: 1 } },
  redstone_torch: { makes: 1, from: { redstone: 1, stick: 1 } },
  minecart: { makes: 1, from: { iron_ingot: 5 } }
} as const;

/** The bill (pure): the items, what they are made of, against the stores (ingots, and the raw ore smelted to them). */
export function billOf(counts: { rail: number; powered_rail: number; redstone_torch: number; minecart: number; cobblestone: number }, stores: Record<string, number>): RailBill {
  const made = { iron_ingot: 0, gold_ingot: 0, redstone: 0, stick: 0 };
  for (const item of ['rail', 'powered_rail', 'redstone_torch', 'minecart'] as const) {
    const r = RAIL_RECIPES[item];
    const crafts = Math.ceil(counts[item] / r.makes);
    for (const [k, v] of Object.entries(r.from)) made[k as keyof typeof made] += crafts * v;
  }
  const have: Record<string, number> = {
    iron_ingot: stores.iron_ingot ?? 0, raw_iron: stores.raw_iron ?? 0, gold_ingot: stores.gold_ingot ?? 0, raw_gold: stores.raw_gold ?? 0,
    redstone: stores.redstone ?? 0, stick: stores.stick ?? 0, cobblestone: stores.cobblestone ?? 0
  };
  const short: string[] = [];
  if (have.iron_ingot + have.raw_iron < made.iron_ingot) short.push(`iron (${made.iron_ingot - have.iron_ingot - have.raw_iron} more)`);
  if (have.gold_ingot + have.raw_gold < made.gold_ingot) short.push(`gold (${made.gold_ingot - have.gold_ingot - have.raw_gold} more)`);
  if (have.redstone < made.redstone) short.push(`redstone (${made.redstone - have.redstone} more)`);
  if (have.cobblestone < counts.cobblestone) short.push('cobblestone (1)');
  return { ...counts, ...made, have, short };
}

/** The plan in one line (the log's, and brain-status's). */
export function railsLine(p: RailPlan): string {
  const lit = p.cells.filter(c => c.kind === 'powered').length;
  const climbs = p.cells.filter(c => c.role === 'climb').length;
  const b = p.bill;
  const smelt = (ingot: number, raw: number, want: number) => { const n = Math.min(Math.max(0, want - ingot), raw); return n > 0 ? ` (${n} to smelt)` : ''; };
  return `${p.length} rails from the pickup by the villager (${p.villager}) at ${fmt(p.pickup)} to the brake in the yard: ${b.rail} rails, ${b.powered_rail} powered (${climbs} up slopes, ` +
    `${lit - climbs - 1} boosts, the launch, ${BRAKE} the brake), ${b.redstone_torch} redstone torches, ${p.stop.placed ? 'a cobblestone stop' : 'the ground for a stop'}, a minecart; ` +
    `up ${p.climb}, down ${p.drop}; the bill ${b.iron_ingot} iron${smelt(b.have.iron_ingot, b.have.raw_iron, b.iron_ingot)}, ${b.gold_ingot} gold${smelt(b.have.gold_ingot, b.have.raw_gold, b.gold_ingot)}, ` +
    `${b.redstone} redstone, ${b.stick} sticks${b.short.length ? `: short of ${b.short.join(', ')}` : ''}; ` +
    `about ${Math.round(p.seconds.total / 60)} min of work${p.fitsDay ? '' : ', more than a day\'s light'}`;
}

/**
 * The plan in full (the villager-moves tool's): the route, the head, every block it would put down in the order it
 * would lay them (walking home from the village), what it opens, the pickup, and the order it would take them all
 * back up.
 */
export function railsText(p: RailPlan): string {
  const runs: string[] = [];
  // the rails by runs of one kind and shape, so 300 rails read as a few dozen lines
  let i = 0;
  while (i < p.cells.length) {
    const c = p.cells[i];
    let j = i;
    while (j + 1 < p.cells.length && p.cells[j + 1].kind === c.kind && (p.cells[j + 1].role ?? '') === (c.role ?? '') && p.cells[j + 1].shape === c.shape) j++;
    const name = c.kind === 'rail' ? 'rail' : c.kind === 'brake' ? 'powered rail, unlit (the brake)' : `powered rail (${c.role})`;
    runs.push(`  ${j > i ? `${j - i + 1} x ` : ''}${name} [${c.shape}] ${fmt(c)}${j > i ? ` .. ${fmt(p.cells[j])}` : ''}`);
    i = j + 1;
  }
  const torch = (t: RailTorch) => `  redstone torch ${fmt(t.at)} (lights ${fmt(t.lights)})${t.trigger ? ': the trigger, put down last' : ''}`;
  return [
    `Rails home (a dry run: P5c plans them, nothing is laid): ${railsLine(p)}.`,
    `The route: ${p.route}.`,
    `The pickup: the villager (${p.villager}) at ${fmt(p.from)}, by boat ${p.hop} to ${fmt(p.pickup)} (a straight hop on land); the cart put on the launch ${fmt(p.cells[0])}, the boat taken up (the villager on the line), the trigger torch: the cart off the stop takes it in at 0.12-0.2 a tick and rolls home onto the brake by the hall.`,
    `What it would put down, walking home from the village (each torch as its rail is laid):`,
    `  ${p.stop.placed ? 'cobblestone (the stop)' : 'the stop: the ground standing'} ${fmt(p.stop.at)}`,
    ...runs,
    ...p.torches.filter(t => !t.trigger).map(torch),
    `Opened for it at the yard (and put back): ${p.opens.map(o => `${idOf(o.block)} ${fmt(o.at)}`).join(', ') || 'nothing'}; the hall's wall (${p.wall.length} blocks from ${fmt(p.wall[0])}) by the boat's last part, as the boat move does.`,
    ...p.torches.filter(t => t.trigger).map(torch),
    `Taken back up walking home after the cart: the trigger torch, ${p.stop.placed ? 'the stop, ' : ''}every rail from the launch to the yard's fence and each torch as it is passed (${p.cells.length - p.yard} rails, ${p.torches.length - 1} torches), then in the yard: the cart broken (the villager out by the hall), the boat against it and into the hall as the boat move does, the yard's ${p.yard} rails (the brake among them), the fence's post${p.opens.length > 1 ? ' and what stood on it' : ''} put back.`,
    `The bill: ${p.bill.rail} rail, ${p.bill.powered_rail} powered_rail, ${p.bill.redstone_torch} redstone_torch, 1 minecart${p.bill.cobblestone ? ', 1 cobblestone' : ''}: ${p.bill.iron_ingot} iron_ingot, ${p.bill.gold_ingot} gold_ingot, ${p.bill.redstone} redstone, ${p.bill.stick} stick; the stores: ${Object.entries(p.bill.have).map(([k, v]) => `${k} ${v}`).join(', ')}${p.bill.short.length ? `; short of ${p.bill.short.join(', ')}` : ''}.`,
    `The time: laying ${p.seconds.lay} s, back out ${p.seconds.back} s, the pickup ${p.seconds.pickup} s, taking up ${p.seconds.takeUp} s, the yard ${p.seconds.yard} s: ${Math.round(p.seconds.total / 60)} min${p.fitsDay ? ' (within a day\'s light)' : ` (a day's light is ${Math.round(daylightLeft(WORK_AT) * MS_PER_TICK / 60_000)} min)`}.`
  ].join('\n');
}
