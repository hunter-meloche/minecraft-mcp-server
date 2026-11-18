import { brainRun, type InventoryItem, type ItemEnchantment } from '../tools.js';
import { fromGate, no, onHomeLevel, outsideBy, type Decline, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { peekVillages, type Seen } from './village.js';
import { rawShort } from './progress.js';
import { prepare } from './project.js';
import { freeChestTotals, storedStacks } from './chests.js';
import { addZone } from './milestones.js';
import { bedPlan } from './villagers.js';
import { mendingLacking } from './anvil.js';
import { storedNetherHelmets } from './netherset.js';
import { ROOM } from './pockets.js';
import { holdHarmless } from './fluidpick.js';
import { goHome } from './homeward.js';
import { inFence } from './yardgates.js';

/**
 * The villager chores in the bot's own hall (P5d of the progression plan): the villagers bred up to four adults with
 * bread, the librarian rerolled with the bot's own lectern until it offers Mending, Mending bought with the emeralds
 * the fletcher pays for sticks, and the anvil (anvil.ts) puts it on the gear. Everything waits on villagers in the hall:
 * with it empty (live Nov 18: the move from the west village found no boat way, and the rails home are switched off)
 * the goal never wants, and nothing is made, placed or thrown.
 *
 * The rules relied on, read in the 26.3 jar (versions/26.3/26.3.jar):
 * - Breeding (ai/behavior/VillagerMakeLove): two adults both `canBreed` (Villager: foodLevel plus the food points in
 *   its inventory 12 or more, BREEDING_FOOD_THRESHOLD; awake; age 0) walk to each other, both eat 12 points, and the
 *   baby comes only if a free bed (a vacant HOME poi within 48, reachable) is there: it is the baby's from birth
 *   (giveBedToChild); with none both show angry particles, the food spent all the same. The parents wait 6000 ticks
 *   (5 min) to breed again, the baby grows up in 24000 (20 min). Food points are the items' `villager_food`
 *   component (Items: bread 4; carrot, potato, beetroot 1 each): 3 bread or 12 carrots each.
 * - Every villager sleeps in its own bed (a HOME poi), a baby too. So 3 beds hold 3 villagers in all: two adults and
 *   the one baby they can have, three adults once it grows up, and no breeding from there. Four adults need four beds
 *   (the fourth the baby's at birth); the hall gets two more, five in all, so a bed stays free for a baby while four
 *   stand (one lost, its bed free again, the others breed it back at once). The chores never feed past four.
 * - Villagers pick up what they can eat (Villager.wantsToPickUp: villager_food items, the villager_picks_up tag) with
 *   room in their 8 slots, and only while the gamerule mobGriefing is on (Mob.aiStep): the friend's server has it on
 *   (a creeper blew the cottage door in, Nov 15). One with 24 points or more throws half to one with under 12
 *   (TradeWithVillager), so 6 bread thrown at two adults feed both whoever picks them up.
 * - A villager takes a free job site within reach (AcquirePoi, then AssignProfessionFromJobSite): a fletching table
 *   makes a fletcher, a lectern a librarian. One loses its job when its site is gone while it has never traded:
 *   ResetProfession (profession not none nor nitwit, villager xp 0, level 1 or less, no JOB_SITE memory) sets it
 *   back to none, and Villager.setVillagerData clears its offers when the profession changes. The next site makes new
 *   offers, drawn from the world's random sequence for the trade set (TradeSet.randomSequence: a sequence that goes
 *   on, so every reroll is a new draw). Once traded with (xp over 0) it keeps the job and its offers for good.
 * - Librarian, level 1 (trade_set/librarian/level_1: 2 of 3, no duplicates): 24 paper for an emerald, 9 emeralds for a
 *   bookshelf, or an enchanted book for emeralds and a book. The book's enchantment is any of #tradeable (the 36
 *   #non_treasure, binding and vanishing curses, frost walker, mending: 40), its level random; its price 2 +
 *   random(5 + 10 x level) + 3 x level emeralds (EnchantRandomlyFunction's additional trade cost), doubled for
 *   #treasure (#double_trade_price), at most 64 (TradeCost: the emerald's stack). Mending: 10 to 38 emeralds and a book.
 *   So a roll shows Mending 2 times in 3 x 1 in 40, one in 60: thirty rolls a day find it about two days in five.
 * - Fletcher, level 1 (trade_set/fletcher/level_1: 2 of 3): 32 sticks for an emerald (16 uses, 2 xp), emeralds for
 *   arrows, gravel and an emerald for flint. The hall's fletching table stood from the build: the first unemployed
 *   villager in the hall becomes the fletcher by itself. A fletcher without the stick trade is rerolled as the
 *   librarian is, while it has never traded.
 * - Recipes (data/minecraft/recipe): lectern = 4 wooden slabs and a bookshelf; fletching table = 2 flint, 4 planks.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Breeding stops here: four adults, babies counted with them (a baby grows into one). */
export const HALL_ADULTS = 4;
/** The beds the hall keeps for them: one each for four, and one free for a baby (see above). The build put three. */
export const HALL_BEDS_WANTED = HALL_ADULTS + 1;
/** Bread a villager needs to be willing: 3 x 4 food points = Villager.BREEDING_FOOD_THRESHOLD (12). */
export const BREAD_EACH = 3;
/** Bread for one baby: both parents willing. */
export const BREAD_PER_BABY = 2 * BREAD_EACH;
/** After a feed, how long a baby is waited for before the bread counts as spent for nothing (a game day and a bit). */
export const BREED_WAIT = 25 * MINUTE;
/** Feeds in a row with no baby after which the breeding waits BREED_BACKOFF (something keeps them apart: say so). */
export const BREED_FAILS = 2;
/** A baby villager grows up in 24000 ticks: an adult more no sooner after a feed is no baby grown up unseen. */
export const BABY_GROWS = 20 * MINUTE;
export const BREED_BACKOFF = 6 * HOUR;
/** The librarian rerolled at most this often a game day (the plan's 30). */
export const ROLLS_A_DAY = 30;
/** Rerolls in one run, at most: a roll is a break, a wait for the job to go, a place, a wait for it to come back. */
export const ROLLS_A_RUN = 4;
/** Mending books kept spare once every piece has it (the plan: "then a spare book or two"). */
export const MENDING_SPARE = 2;
/**
 * Emeralds the fletcher's trades fill up to: what the donations keep (community.ts KEEP.emerald, a test holds them
 * equal), the Mending money. A number here, not KEEP's: this module is in an import cycle with community.ts (through
 * the move's count), and a top-level read of KEEP found it not yet made.
 */
export const EMERALD_TARGET = 64;
/** Stick trades in one run, at most (128 sticks a stack of emeralds' worth is 2 slots; 8 trades are 4 slots of sticks). */
export const STICK_TRADES_A_RUN = 8;
/** A villager restocks at its job site up to twice a game day: a sold-out trade, or a book just bought, waits this long. */
export const RESTOCK_WAIT = 10 * MINUTE;
/** The fletcher rerolled for its stick trade at most this often a game day. */
export const FLETCHER_ROLLS_A_DAY = 10;
/** A lectern put down and no villager taking it: looked at again after this. */
export const LECTERN_WAIT = 5 * MINUTE;
/** A chore that failed is passed over this long (the others go on meanwhile). */
export const CHORE_FAIL_WAIT = 2 * HOUR;
/** Free slots a run wants (the sticks, the emeralds, a book, the bread). */
export const CHORE_SLOTS = 5;
/** Daylight left for a run (ticks): a few rolls' worth, and the villagers go to bed at dusk. */
const DAY_LEFT = 2400;
/**
 * The waits on the villagers: a look every pollMs; a job given up after loseLooks looks without it going, a new one
 * after jobLooks without one coming (the AI looks for a site every few seconds and walks to it). A test sets pollMs 0.
 */
export const HALL_WAITS = { pollMs: 3000, loseLooks: 10, jobLooks: 30, dropMs: 400, dropLooks: 4 };
/** Runs in a row that put the lectern down and saw no villager take it: then the chore is passed over (CHORE_FAIL_WAIT). */
export const LECTERN_WAITS = 3;

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const keyOf = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
const pause = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const AIR = /^(air|cave_air|void_air)$/;
const idOf = (b: string | null | undefined) => (b ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
const block = (p: { x: number; y: number; z: number }) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

// ------------------------------------------------------------------------------------------------ memory

/** A villager in the hall as the last look saw it. */
export interface HallVillager { id: number; baby: boolean; profession: string; level: number; at: Pos }

/** Kept in brain.json per world (world.hallChores). */
export interface HallChoresMemory {
  /** the villagers inside the hall's box at the last look, and when (noteHall: every look at them, whoever made it) */
  census?: { at: number; villagers: HallVillager[] };
  /**
   * the breeding: bread thrown in all, the last feed (when, how many villagers then and how many babies: the fewest
   * seen since, a baby grown up or lost lowering it), feeds in a row with no baby, babies seen born
   */
  breed?: { thrown: number; at?: number; total?: number; babies?: number; fails: number; born: number };
  /**
   * the librarian: `rolling` (rerolled until Mending), `mending` (offered: bought one a restock), `locked` (traded with
   * before Mending showed: kept as it is); `id` the one last read (an entity id: a session's only), `read` its offers
   * read and no reroll since; rolls in all, this game day's (`day`: the idle tally's day), the last books offered, the
   * Mending price, what was bought and when, a lectern put down and not taken yet (`waits`: runs in a row it was not)
   */
  librarian?: {
    state: 'rolling' | 'mending' | 'locked'; id?: number; read?: boolean; rolls: number; day: number; today: number;
    books?: string; price?: number; bought: number; boughtAt?: number; outAt?: number; placedAt?: number; waits?: number; level?: number; xp?: number;
  };
  /**
   * the fletcher: its stick trade seen or not and its price then (sticks a trade: 32, more with demand after it sold out),
   * level and xp at the last read, sticks sold, a sold-out trade, its rerolls
   */
  fletcher?: { id?: number; sticks?: boolean; price?: number; level?: number; xp?: number; sold: number; outAt?: number; rolls: number; day: number; today: number };
  /** when each chore last failed (ms): passed over for CHORE_FAIL_WAIT, so one that keeps failing holds up none of the rest */
  failed?: Partial<Record<Chore, number>>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The chores' memory, made whole (a malformed brain.json part dropped, never thrown on). */
export function hallChoresOf(world: WorldMemory): HallChoresMemory {
  const raw = world.hallChores as unknown;
  if (!isObj(raw)) return (world.hallChores = {});
  const m = raw as HallChoresMemory;
  if (m.census && (!fin(m.census.at) || !Array.isArray(m.census.villagers))) delete m.census;
  if (m.breed && !(fin(m.breed.thrown) && fin(m.breed.fails))) delete m.breed;
  if (m.librarian && !(fin(m.librarian.rolls) && fin(m.librarian.day) && fin(m.librarian.today))) delete m.librarian;
  if (m.fletcher && !(fin(m.fletcher.sold) && fin(m.fletcher.rolls))) delete m.fletcher;
  if (m.failed !== undefined && !isObj(m.failed)) delete m.failed;
  return m;
}
/** The same for a gate: reads only (an absent or broken memory is an empty one, nothing written). */
const peek = (world: WorldMemory): HallChoresMemory => (isObj(world.hallChores) ? world.hallChores : {});

/** The idle tally's game day (idlelog.ts: the day count goes up each morning), as the work queue's farDay keys it. */
export const gameDay = (world: WorldMemory): number => { const d: unknown = world.idle?.today?.day; return fin(d) ? d : 0; };

// ------------------------------------------------------------------------------------------------ the hall and who is in it

type Box = { x: number; y: number; z: number; width: number; length: number };
const hallBox = (world: WorldMemory): Box | undefined => {
  const h = world.zones?.hall?.[0];
  return h && fin(h.width) && fin(h.length) ? { x: h.x, y: h.y, z: h.z, width: h.width, length: h.length } : undefined;
};

/**
 * Whether a look from `p` sees the whole hall (the brain's look round home, brain.ts discover): within 64 of it across
 * the ground and on home's level. world.entities counts 128 in three dimensions, and from down the mine under the yard
 * (discover runs within 48 of home across the ground, at any depth) the villagers more than about 42 across were left
 * out: the census came out short or empty, and the move's hall count with it.
 */
export function hallInSight(world: WorldMemory, p: { x: number; y: number; z: number }, home?: { y: number }): boolean {
  const h = hallBox(world);
  return !!h && !!home && onHomeLevel(p, home) && Math.hypot(p.x - (h.x + h.width / 2), p.z - (h.z + h.length / 2)) <= 64;
}

/** Inside the hall's box, at its floor's level (as villagemove.ts countHall counts them). */
export function inHallBox(world: WorldMemory, p: { x: number; y: number; z: number }): boolean {
  const h = hallBox(world);
  return !!h && p.x >= h.x && p.x < h.x + h.width && p.z >= h.z && p.z < h.z + h.length && Math.abs(p.y - (h.y + 1)) <= 3;
}

/** The villagers a world.entities reply shows inside the hall (pure). */
export function hallVillagers(world: WorldMemory, seen: readonly Seen[]): HallVillager[] {
  return seen.filter(e => e && e.name === 'villager' && e.position && inHallBox(world, e.position))
    .map(e => ({ id: e.id, baby: !!e.baby, profession: e.profession ?? 'none', level: fin(e.level) ? e.level : 1, at: { ...e.position! } }));
}

/**
 * A look at the villagers (a world.entities reply from anywhere the hall is in sight) noted as the hall's census, with
 * the time; a baby more than at the last feed ends that feed's wait (its bread did its work). Returns how many are in
 * the hall, undefined with no hall. Called by the chores, the move's count (villagemove.ts countHall) and the brain's
 * look round home (brain.ts discover), so a villager brought in or born is seen without the chores running.
 */
export function noteHall(world: WorldMemory, seen: readonly Seen[], now: number): number | undefined {
  if (!hallBox(world)) return undefined;
  const villagers = hallVillagers(world, seen).slice(0, 16);
  const m = hallChoresOf(world);
  m.census = { at: now, villagers };
  // a birth is a baby more than at the feed: by the babies, not the head count (an adult moved in is no baby, and a
  // baby after one was lost leaves the count where it was); or, with no villager move since the feed, a head more than
  // the count last seen once a baby could have grown up (BABY_GROWS: born and grown unseen while the bot was away, no
  // failed feed)
  const b = m.breed;
  const babies = villagers.filter(v => v.baby).length;
  if (b && fin(b.total)) {
    const was = fin(b.babies) ? b.babies : 0;
    const move = peekVillages(world).last;
    const grown = fin(b.at) && now - b.at >= BABY_GROWS && !(move && move.at >= b.at) ? villagers.length - b.total : 0;
    const more = Math.max(babies - was, grown);
    if (more > 0) {
      b.born += more;
      b.fails = 0;
      delete b.at;
    }
    b.babies = babies;
    b.total = villagers.length;
  }
  return villagers.length;
}

/** The census in numbers. */
export function headcount(vs: readonly HallVillager[]) {
  const adults = vs.filter(v => !v.baby);
  return {
    total: vs.length, adults: adults.length, babies: vs.length - adults.length,
    unemployed: adults.filter(v => v.profession === 'none'),
    librarian: adults.find(v => v.profession === 'librarian'),
    fletcher: adults.find(v => v.profession === 'fletcher')
  };
}

// ------------------------------------------------------------------------------------------------ the beds

export interface BedCells { head: Pos; foot: Pos }

/** The hall's beds as its zones hold them: each head with the foot cell beside it. */
export function hallBeds(world: WorldMemory): BedCells[] {
  const heads = world.zones?.['hall:bed'] ?? [], feet = world.zones?.['hall:bed-foot'] ?? [];
  return heads.flatMap(h => {
    const f = feet.find(q => q.y === h.y && Math.abs(q.x - h.x) + Math.abs(q.z - h.z) === 1);
    return f ? [{ head: { x: h.x, y: h.y, z: h.z }, foot: { x: f.x, y: f.y, z: f.z } }] : [];
  });
}

/**
 * Where `n` more beds go in the hall, pure: each with its head against a wall and its foot into the room, as the
 * build put its three, nearest the beds there are (one at a time, each next to the last). Never in or on: the
 * lectern's and the fletching table's cells and the cell in front of each (the job sites are walked up to), the
 * torches, the middle of the room (`hall:inside`, where the move lets a villager out), the row past each bed's foot (a
 * villager walks up to its bed), the inner row along the gate's wall (the way in, and the boat's from the panel beside
 * the gate, F7), and the panel's inside cell with one either side of it (the boat's way in from straight out). Fewer
 * than asked when the room has no more such cells; nothing with no hall.
 */
export function moreBedCells(world: WorldMemory, n: number): BedCells[] {
  const h = hallBox(world);
  if (!h || n <= 0) return [];
  const y = h.y + 1;
  const x1 = h.x + 1, x2 = h.x + h.width - 2, z1 = h.z + 1, z2 = h.z + h.length - 2;
  const inner = (p: { x: number; z: number }) => p.x >= x1 && p.x <= x2 && p.z >= z1 && p.z <= z2;
  const at = (x: number, z: number): Pos => ({ x, y, z });
  const taken = new Set<string>(), clear = new Set<string>();
  const beds = hallBeds(world);
  const zone = (k: string) => (world.zones?.[`hall:${k}`] ?? []).filter(p => fin(p.x) && fin(p.z));
  // inward from a wall-side cell: away from the wall it touches
  const inward = (p: { x: number; z: number }): [number, number][] =>
    [p.z === z1 ? [0, 1] : null, p.z === z2 ? [0, -1] : null, p.x === x1 ? [1, 0] : null, p.x === x2 ? [-1, 0] : null].filter((d): d is [number, number] => !!d);
  for (const b of beds) {
    taken.add(keyOf(b.head)).add(keyOf(b.foot));
    clear.add(keyOf(at(2 * b.foot.x - b.head.x, 2 * b.foot.z - b.head.z)));
  }
  for (const k of ['lectern', 'fletching']) for (const p of zone(k)) {
    taken.add(keyOf(at(p.x, p.z)));
    for (const [dx, dz] of inward(p)) clear.add(keyOf(at(p.x + dx, p.z + dz)));
  }
  for (const p of zone('torch')) taken.add(keyOf(at(p.x, p.z)));
  for (const p of zone('inside')) clear.add(keyOf(at(p.x, p.z)));
  // the wall cells of the gate and the panel: the inner cell in from each (on its side of the box)
  const inFrom = (p: { x: number; z: number }): { x: number; z: number } | undefined =>
    p.z === h.z ? { x: p.x, z: z1 } : p.z === h.z + h.length - 1 ? { x: p.x, z: z2 } : p.x === h.x ? { x: x1, z: p.z } : p.x === h.x + h.width - 1 ? { x: x2, z: p.z } : undefined;
  for (const g of zone('gate')) {
    const c = inFrom(g);
    if (!c) continue;
    // the whole inner row along the gate's wall: a row of z for a gate in the north or south wall, of x for one in the
    // west or east wall
    const northSouth = g.z === h.z || g.z === h.z + h.length - 1;
    for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) if (northSouth ? z === c.z : x === c.x) clear.add(keyOf(at(x, z)));
  }
  for (const p of zone('panel')) {
    const c = inFrom(p);
    if (!c) continue;
    const along: [number, number] = c.z === z1 || c.z === z2 ? [1, 0] : [0, 1];
    for (const k of [-1, 0, 1]) clear.add(keyOf(at(c.x + k * along[0], c.z + k * along[1])));
  }
  const free = (p: { x: number; z: number }) => inner(p) && !taken.has(keyOf(at(p.x, p.z))) && !clear.has(keyOf(at(p.x, p.z)));
  const out: BedCells[] = [];
  const placed = beds.map(b => b.head).concat(beds.map(b => b.foot));
  while (out.length < n) {
    let best: { cells: BedCells; d: number } | undefined;
    for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
      const head = { x, z };
      if (!free(head)) continue;
      for (const [dx, dz] of inward(head)) {
        const foot = { x: x + dx, z: z + dz }, past = { x: x + 2 * dx, z: z + 2 * dz };
        if (!free(foot) || !inner(past) || taken.has(keyOf(at(past.x, past.z)))) continue;
        const d = placed.length ? Math.min(...placed.map(q => Math.abs(q.x - x) + Math.abs(q.z - z))) : 0;
        if (!best || d < best.d) best = { cells: { head: at(x, z), foot: at(foot.x, foot.z) }, d };
      }
    }
    if (!best) break;
    out.push(best.cells);
    const { head, foot } = best.cells;
    taken.add(keyOf(head)).add(keyOf(foot));
    clear.add(keyOf(at(2 * foot.x - head.x, 2 * foot.z - head.z)));
    placed.push(head, foot);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ what is wanted

/** Carried (main pockets) and in the chests, but what a job holds there: what the chores can use, by name. */
export function haveOf(items: readonly InventoryItem[], world: WorldMemory): Record<string, number> {
  const out = { ...freeChestTotals(world) };
  for (const i of items) if (i.slot >= 0 && i.slot < 36) out[i.name] = (out[i.name] ?? 0) + i.count;
  return out;
}

const hasMending = (list?: ItemEnchantment[]) => !!list?.some(e => e.name === 'mending');

/** Mending books carried and in the chests (by their stacks). */
export function mendingBooks(items: readonly InventoryItem[], world: WorldMemory): number {
  const carried = items.filter(i => i.slot < 36 && i.name === 'enchanted_book' && hasMending(i.enchantments)).reduce((a, i) => a + i.count, 0);
  return carried + storedStacks(world, st => st.name === 'enchanted_book' && hasMending(st.enchantments)).reduce((a, f) => a + f.stack.count, 0);
}

/**
 * Mending books still to buy (pure): one for each piece the anvil sees to that lacks it (anvil.ts mendingLacking: the
 * main set in use, the golden Nether helmet: D1 wants it mended too), and MENDING_SPARE more, less the books there are.
 */
export function mendingWanted(items: InventoryItem[], world: WorldMemory): number {
  return Math.max(0, mendingLacking(items, storedNetherHelmets(world)) + MENDING_SPARE - mendingBooks(items, world));
}

/** Sticks there are and could be made, by the chests' and the pockets' counts (a log is 4 planks, 2 planks 4 sticks). */
export function sticksThere(have: Record<string, number>): number {
  let planks = 0, logs = 0;
  for (const [n, k] of Object.entries(have)) {
    if (/_planks$/.test(n)) planks += k;
    else if (/_log$/.test(n) && !/^stripped_/.test(n)) logs += k;
  }
  return (have.stick ?? 0) + 2 * planks + 8 * logs;
}

export type Chore = 'beds' | 'breed' | 'lectern' | 'roll' | 'buy' | 'sticks' | 'fletcher';
export type ChorePlan = { chore: Chore; want: string } | { none: Decline };

/** Whether a game day's count is today's. */
const todayOf = (c: { day: number; today: number } | undefined, day: number) => (c && c.day === day ? c.today : 0);

/**
 * The next chore, pure, from the census (hallChores.census) and what there is: the first of
 * 1. beds: fewer than HALL_BEDS_WANTED beds in the hall and room for more (moreBedCells), the beds' makings there;
 * 2. breed: two adults or more, under HALL_ADULTS with the babies, a bed free for the baby, BREAD_PER_BABY bread there,
 *    and no feed waiting on its baby (BREED_WAIT; after BREED_FAILS feeds in a row with none, BREED_BACKOFF);
 * 3. lectern: no librarian, an unemployed adult, the lectern's cell (`hall:lectern`), a lectern there or its makings,
 *    none put down in the last LECTERN_WAIT;
 * 4. roll: a librarian not known to offer Mending nor traded with, under ROLLS_A_DAY rerolls today;
 * 5. buy: the librarian offers Mending (as last read), books are wanted (mendingWanted), the price in emeralds and a
 *    book there, a restock since the last buy (RESTOCK_WAIT);
 * 6. sticks: a fletcher not known to lack the stick trade, emeralds under EMERALD_TARGET, sticks for a trade there,
 *    not sold out lately;
 * 7. fletcher: a fletcher that lacks the stick trade and has never traded, under FLETCHER_ROLLS_A_DAY rerolls today.
 * A chore that failed within CHORE_FAIL_WAIT is passed over for the next. With none, why each did not (the hall's
 * state).
 */
export function chorePlan(s: Pick<Snapshot, 'now' | 'items'>, world: WorldMemory): ChorePlan {
  const m = peek(world);
  const vs = m.census?.villagers ?? [];
  const n = headcount(vs);
  const not: string[] = [];
  const have = haveOf(s.items, world);
  const day = gameDay(world);
  const beds = hallBeds(world).length;
  // a chore that failed lately is passed over, and the next looked at
  const offer = (chore: Chore, want: string): ChorePlan | undefined => {
    const at = m.failed?.[chore];
    if (fin(at) && s.now - at < CHORE_FAIL_WAIT) { not.push(`${want}: failed ${Math.round((s.now - at) / MINUTE)} min ago, tried again later`); return undefined; }
    return { chore, want };
  };
  let p: ChorePlan | undefined;
  // 1. beds
  if (beds < HALL_BEDS_WANTED) {
    const cells = moreBedCells(world, HALL_BEDS_WANTED - beds);
    const plan = cells.length ? bedPlan(have, false, cells.length) : undefined;
    if (!cells.length) not.push(`no room in the hall for more than ${beds} beds`);
    else if (plan && 'short' in plan) not.push(`more beds: ${plan.text}: short of ${Object.entries(plan.short).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    else if ((p = offer('beds', `${cells.length} more bed${cells.length === 1 ? '' : 's'} in the villager hall (${beds} there, ${HALL_BEDS_WANTED} wanted)`))) return p;
  }
  // 2. breed
  const b = m.breed;
  const freeBeds = beds - n.total;
  if (n.adults < 2) not.push(`${n.adults} adult${n.adults === 1 ? '' : 's'} in the hall: none to breed`);
  else if (n.total >= HALL_ADULTS) not.push(`${n.adults} adults${n.babies ? ` and ${n.babies} baby` : ''} in the hall (${HALL_ADULTS} wanted)`);
  else if (freeBeds < 1) not.push(`no free bed for a baby (${beds} beds, ${n.total} villagers)`);
  else if ((have.bread ?? 0) < BREAD_PER_BABY) not.push(`${have.bread ?? 0} bread (a baby takes ${BREAD_PER_BABY})`);
  else if (b && fin(b.at) && s.now - b.at < BREED_WAIT) not.push(`bread given ${Math.round((s.now - b.at) / MINUTE)} min ago: waiting for the baby`);
  else if (b && fin(b.at) && b.fails + 1 >= BREED_FAILS && s.now - b.at < BREED_BACKOFF) not.push(`${b.fails + 1} feeds brought no baby: the next in ${Math.ceil((b.at + BREED_BACKOFF - s.now) / MINUTE)} min`);
  else if ((p = offer('breed', `breed the hall's villagers: ${n.adults} adults, ${n.babies} babies, ${freeBeds} bed${freeBeds === 1 ? '' : 's'} free`))) return p;
  const lib = m.librarian;
  const cell = world.zones?.['hall:lectern']?.[0];
  // 3. lectern
  if (!n.librarian) {
    if (!n.unemployed.length) not.push('no librarian, and no unemployed adult to take a lectern');
    else if (!cell) not.push('the hall keeps no lectern cell');
    else if (lib && fin(lib.placedAt) && s.now - lib.placedAt < LECTERN_WAIT) not.push('the lectern is down: waiting for a villager to take it');
    // (one put down and not taken needs no makings: the chore only waits by it again; the decline read "short of" with
    // the lectern standing in its cell)
    else if (!fin(lib?.placedAt) && (have.lectern ?? 0) < 1 && Object.keys(rawShort({ lectern: 1 }, have)).length) not.push(`a lectern: short of ${Object.entries(rawShort({ lectern: 1 }, have)).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    else if ((p = offer('lectern', fin(lib?.placedAt) ? 'the lectern is down: no villager has taken it, waited by again' : `a lectern for the hall's unemployed villager (${n.unemployed.length} unemployed)`))) return p;
  } else if (!lib || lib.state === 'rolling' || (lib.state === 'locked' && lib.id !== n.librarian.id)) {
    // 4. roll (a librarian locked as traded with is read again when another stands at the lectern: the locked one lost,
    // a grown baby or an unemployed adult took the lectern by itself, never traded with; or new ids after a reconnect)
    const today = todayOf(lib, day);
    // (the cap whatever the id: at it, a reconnect's new id walked in to read the same offers and logged one more roll)
    if (lib?.read && today >= ROLLS_A_DAY) not.push(`the librarian rerolled ${today} times today: the rest tomorrow`);
    else if ((p = offer('roll', `the librarian's offers${lib?.read && lib.id === n.librarian.id ? `: no Mending (${lib.books ?? 'no book'}): reroll ${today + 1} today` : ''}`))) return p;
  } else if (lib.state === 'mending') {
    // 5. buy
    const want = mendingWanted(s.items, world);
    const price = lib.price ?? 0;
    if (!want) not.push(`Mending offered; every piece has it and ${MENDING_SPARE} spare`);
    else if ((have.emerald ?? 0) < price) not.push(`Mending offered for ${price} emeralds: ${have.emerald ?? 0} there`);
    else if ((have.book ?? 0) < 1 && Object.keys(rawShort({ book: 1 }, have)).length) not.push('Mending offered: no book to pay with');
    else if (fin(lib.boughtAt) && s.now - lib.boughtAt < RESTOCK_WAIT) not.push('a Mending book bought lately: the next after a restock');
    else if (fin(lib.outAt) && s.now - lib.outAt < RESTOCK_WAIT) not.push('Mending sold out: waiting for a restock');
    else if ((p = offer('buy', `buy Mending (${price} emeralds and a book): ${want} more wanted`))) return p;
  } else not.push('the librarian was traded with before Mending showed: kept as it is');
  // 6. sticks
  const f = m.fletcher;
  const emeralds = have.emerald ?? 0;
  if (!n.fletcher) not.push('no fletcher');
  else if (f?.sticks === false) {
    // 7. fletcher
    const today = todayOf(f, day);
    if ((f.xp ?? 0) > 0 || (f.level ?? 1) > 1) not.push('the fletcher has no stick trade and has traded: kept as it is');
    else if (today >= FLETCHER_ROLLS_A_DAY) not.push(`the fletcher rerolled ${today} times today`);
    else if (!world.zones?.['hall:fletching']?.length) not.push('the hall keeps no fletching table cell');
    else if ((p = offer('fletcher', 'the fletcher has no stick trade: reroll it'))) return p;
  } else if (emeralds >= EMERALD_TARGET) not.push(`${emeralds} emeralds (${EMERALD_TARGET} kept)`);
  // (the trade's price as last read: 32 sticks, up to 64 with demand once it sold out; asked for 32 there, a run at 57
  // carried 32, sold nothing and was wanted again at the next tick)
  else if (sticksThere(have) < (f?.price ?? 32)) not.push(sticksThere(have) ? `${sticksThere(have)} sticks: the trade takes ${f?.price ?? 32}` : 'no sticks to sell');
  else if (f && fin(f.outAt) && s.now - f.outAt < RESTOCK_WAIT) not.push('the stick trade sold out: waiting for a restock');
  else if ((p = offer('sticks', `sell sticks to the fletcher (${emeralds} emeralds, ${EMERALD_TARGET} wanted)`))) return p;
  return { none: { cause: 'unneeded', text: `hall chores: ${not.join('; ')}` } };
}

// ------------------------------------------------------------------------------------------------ the gate

const inYard = (s: Snapshot, world: WorldMemory) =>
  !!world.yard && !!s.home && s.dimension === 'overworld' && outsideBy(world.yard, s.position) === 0 && onHomeLevel(s.position, s.home);

/**
 * The goal's one answer (pure): no hall, or none in it as last seen (inert: nothing is made, placed or thrown for an
 * empty hall), then the next chore (chorePlan), from the yard, by day, with room in the pockets.
 */
const gate = (s: Snapshot, world: WorldMemory): Gate => {
  if (!hallBox(world)) return { cause: 'unneeded', text: 'no villager hall yet' };
  const c = peek(world).census;
  if (!c?.villagers.length) return { cause: 'unneeded', text: c ? 'the villager hall is empty' : 'the villager hall not looked into yet' };
  const plan = chorePlan(s, world);
  if ('none' in plan) return plan.none;
  if (!inYard(s, world)) {
    return { cause: 'away', text: !s.home ? 'no home set' : s.dimension !== 'overworld' ? `in ${s.dimension}` : `${Math.round(s.distHome)} blocks from home, not in the yard on home's level (the hall's chores work from the yard)` };
  }
  if (36 - s.slotsUsed - ROOM.yard < CHORE_SLOTS) return no.pockets(s, 'hall chores', 36 - ROOM.yard - CHORE_SLOTS + 1);
  return no.late(s, 'hall chores', DAY_LEFT) ?? { want: plan.want };
};

// ------------------------------------------------------------------------------------------------ the trades

/** A stack on the trade screen. */
export interface TradeItem { name: string; count: number; enchantments?: ItemEnchantment[]; baseCount?: number }
/** One offer as trade.status lists it. */
export interface TradeOffer {
  index: number; costA: TradeItem | null; costB?: TradeItem | null; result: TradeItem | null;
  uses: number; maxUses: number; outOfStock: boolean; xp?: number; afford?: number;
}
/** What trade.open and trade.status answer (Merchant.java). */
export interface TradeStatus { open: boolean; level?: number; xp?: number; offers?: TradeOffer[]; id?: number; entity?: string; profession?: string }
/** What trade.do answers. */
interface TradeDone { ok: boolean; traded: number; count: number; spent?: Record<string, number>; stopped?: string; level?: number; xp?: number; offer?: TradeOffer }

/** The books a librarian offers, in words: `mending 1 (24 emeralds and a book)`. */
export function booksOffered(offers: readonly TradeOffer[]): string {
  const books = offers.filter(o => o.result?.name === 'enchanted_book');
  if (!books.length) return `no book (${offers.map(o => o.result?.name ?? '?').join(', ') || 'no offers'})`;
  return books.map(o => `${(o.result!.enchantments ?? []).map(e => `${e.name} ${e.level}`).join(', ') || 'a plain book'} ` +
    `(${o.costA?.count ?? '?'} ${o.costA?.name === 'emerald' ? 'emeralds' : o.costA?.name ?? '?'}${o.costB ? ` and ${o.costB.count === 1 ? 'a' : o.costB.count} ${o.costB.name}` : ''})`).join(', ');
}

/** The Mending offer among them, if any. */
export const mendingOffer = (offers: readonly TradeOffer[]): TradeOffer | undefined =>
  offers.find(o => o.result?.name === 'enchanted_book' && hasMending(o.result.enchantments));

/** The stick trade (sticks for emeralds), if any. */
export const stickOffer = (offers: readonly TradeOffer[]): TradeOffer | undefined =>
  offers.find(o => o.costA?.name === 'stick' && !o.costB && o.result?.name === 'emerald');

const say = (ctx: GoalContext, text: string) => ctx.progress(text);
/** When each run began (real ms), for clock() below. */
const began = new WeakMap<GoalContext, number>();
/**
 * The time now in the snapshot's clock: ctx.s.now is the run's start, and a lectern stamped with it after a run of
 * rerolls (up to 10 min) had its 5-min wait over before the run even ended.
 */
const clock = (ctx: GoalContext) => ctx.s.now + Math.max(0, Date.now() - (began.get(ctx) ?? Date.now()));
const inventory = async (ctx: GoalContext): Promise<InventoryItem[]> => (await ctx.call<{ items: InventoryItem[] }>('inventory')).items;
const carried = (items: InventoryItem[], name: string) => items.filter(i => i.slot >= 0 && i.slot < 36 && i.name === name).reduce((a, i) => a + i.count, 0);

/** The villagers in the hall now (world.entities), the census noted; undefined when the look failed. */
async function look(ctx: GoalContext): Promise<HallVillager[] | undefined> {
  const r = await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 128, type: 'villager' }).catch(() => undefined);
  if (!Array.isArray(r?.entities)) return undefined;
  noteHall(ctx.world, r.entities, ctx.s.now);
  return hallVillagers(ctx.world, r.entities);
}

/** One villager by its id, as the hall sees it now (undefined when it is not in the hall). */
async function find(ctx: GoalContext, id: number): Promise<HallVillager | undefined> {
  return (await look(ctx))?.find(v => v.id === id);
}

/**
 * Open a villager's trades, read them and shut the screen (in a finally, outside the brain's run as the anvil's close
 * is: one the brain gave up would leave the screen open, the Guardian keeping no gear up under it). A walk up to it
 * first (on foot, A11). A look only: never a trade.
 */
async function readTrades(ctx: GoalContext, v: HallVillager): Promise<TradeStatus> {
  await walkTo(ctx, v.at, 2);
  try {
    const st = await ctx.call<TradeStatus>('trade.open', { id: v.id }, 15_000);
    if (!st.open) throw new Error(`the villager (${v.id}) opened no trades`);
    return st;
  } finally {
    await brainRun.exit(() => ctx.call('trade.close', {})).catch(() => undefined);
  }
}

// ------------------------------------------------------------------------------------------------ walks

async function walkTo(ctx: GoalContext, p: Pos, range: number): Promise<void> {
  const g = await ctx.call<{ arrived?: boolean }>('goto', { ...block(p), range, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => ({ arrived: false }));
  if (g?.arrived === false) throw new Error(`no way on foot to ${fmt(block(p))} in the hall`);
}

/** Into the hall on foot, through its gate (A11: a careful walk, nothing broken or placed); from inside the fence. */
async function enterHall(ctx: GoalContext): Promise<void> {
  await holdHarmless(ctx);
  const here = (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
  if (!inFence(ctx.world, here)) await goHome(ctx, 180_000).catch(() => undefined);
  if (ctx.signal.aborted) throw new Error('aborted');
  const inside = ctx.world.zones?.['hall:inside']?.[0];
  const h = hallBox(ctx.world)!;
  const mid = inside ?? { x: h.x + Math.floor(h.width / 2), y: h.y + 1, z: h.z + Math.floor(h.length / 2) };
  const g = await ctx.call<{ arrived?: boolean }>('goto', { ...block(mid), range: 1, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
  if (g?.arrived === false) throw new Error(`no way on foot into the villager hall at ${fmt(block(mid))}`);
}

/**
 * Out of the hall by its gate, and the gate shut: the bridge's Gates shuts what the bot opens as it walks off, and a
 * gate still open (the walk cut short beside it) is clicked shut here. Villagers open no gate, but walk out of an open
 * one: a hall left open loses them to the yard.
 */
async function leaveHall(ctx: GoalContext): Promise<string> {
  const g = ctx.world.zones?.['hall:gate']?.[0];
  const h = hallBox(ctx.world);
  // (a run stopped by something more urgent leaves the walk to it: the gate the bot opened Gates shuts as it goes)
  if (!g || !h || ctx.signal.aborted) return '';
  const here = (await ctx.status().catch(() => undefined))?.position;
  if (!here || !inHallBox(ctx.world, here)) return '';
  const out = g.z === h.z ? [0, -2] : g.z === h.z + h.length - 1 ? [0, 2] : g.x === h.x ? [-2, 0] : [2, 0];
  await ctx.call('goto', { x: g.x + out[0], y: g.y, z: g.z + out[1], range: 1, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);
  const r = await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...g, width: 1, height: 1, length: 1 }).catch(() => undefined);
  if (!/open=true/.test(r?.blocks?.[0] ?? '')) return '';
  const shut = await ctx.act('use-item-on-block', { ...g, face: 'up', toggle: true }).catch(() => ({ ok: false, text: '' }));
  return shut.ok ? '; shut the hall\'s gate' : '; the hall\'s gate may be open';
}

const blockAt = async (ctx: GoalContext, p: Pos) =>
  idOf((await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...p, width: 1, height: 1, length: 1 })).blocks[0]);

// ------------------------------------------------------------------------------------------------ the chores

/** The beds: made (bedPlan: wool, else string, the leads' share kept) and put down one at a time, as the cabin's bed goes. */
async function bedsChore(ctx: GoalContext): Promise<string> {
  const want = HALL_BEDS_WANTED - hallBeds(ctx.world).length;
  const cells = moreBedCells(ctx.world, want);
  if (!cells.length) return 'no room in the hall for more beds';
  const plan = bedPlan(haveOf(await inventory(ctx), ctx.world), false, cells.length);
  if (!('bed' in plan)) throw new Error(`the hall's beds: ${'text' in plan ? plan.text : plan.wait}`);
  const short = await prepare(ctx, plan.bed, cells.length);
  if (Object.keys(short).length) throw new Error(`${cells.length} ${plan.bed} for the hall: short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  await enterHall(ctx);
  let put = 0;
  for (const { head, foot } of cells) {
    if (ctx.signal.aborted) break;
    if (!AIR.test(await blockAt(ctx, head)) || !AIR.test(await blockAt(ctx, foot))) { say(ctx, `hall: the bed's cells at ${fmt(head)} are not clear: left`); continue; }
    // (facing is from the foot to the head, as home.ts bedGoal puts the cabin's)
    const facing = head.z < foot.z ? 'north' : head.z > foot.z ? 'south' : head.x < foot.x ? 'west' : 'east';
    const o = { x: Math.min(head.x, foot.x), y: head.y, z: Math.min(head.z, foot.z) };
    const rows: string[] = [];
    for (let z = o.z; z <= Math.max(head.z, foot.z); z++) {
      let row = '';
      for (let x = o.x; x <= Math.max(head.x, foot.x); x++) row += x === head.x && z === head.z ? 'H' : 'F';
      rows.push(row);
    }
    const spec = { palette: { H: `${plan.bed}[facing=${facing},part=head]`, F: `${plan.bed}[facing=${facing},part=foot]` }, layers: [rows] };
    const r = await ctx.act('build-structure', { ...o, spec, name: 'hall_bed', timeoutMs: 120_000 });
    if (!r.ok) { say(ctx, `hall: the bed at ${fmt(head)} did not go down: ${r.text.split('\n')[0].slice(0, 120)}`); continue; }
    addZone(ctx.world, 'hall:bed', head);
    addZone(ctx.world, 'hall:bed-foot', foot);
    put++;
    say(ctx, `hall: a ${plan.bed} at ${fmt(head)} for the villagers (${hallBeds(ctx.world).length} beds now)`);
  }
  ctx.world.landmarks.foundAt = 0;
  if (!put) throw new Error('no bed went down in the hall');
  ctx.gain(put);
  return `put ${put} ${plan.bed} in the villager hall (${hallBeds(ctx.world).length} beds)`;
}

/**
 * The breeding: BREAD_EACH bread thrown to each of two adults (the pair nearest each other), from 2 away (item.toss:
 * the throw that rests at its feet; villagers pick up bread), counted. A feed that brought no baby since is counted
 * as such before the next.
 */
async function breedChore(ctx: GoalContext, vs: HallVillager[]): Promise<string> {
  const m = hallChoresOf(ctx.world);
  const adults = vs.filter(v => !v.baby);
  let pair: [HallVillager, HallVillager] | undefined;
  for (const a of adults) for (const b of adults) {
    if (a.id >= b.id) continue;
    const d = Math.hypot(a.at.x - b.at.x, a.at.z - b.at.z);
    if (!pair || d < Math.hypot(pair[0].at.x - pair[1].at.x, pair[0].at.z - pair[1].at.z)) pair = [a, b];
  }
  if (!pair) return 'no two adults to breed';
  const short = await prepare(ctx, 'bread', BREAD_PER_BABY);
  if (Object.keys(short).length) throw new Error(`bread for the villagers: short of ${short.bread ?? BREAD_PER_BABY}`);
  await enterHall(ctx);
  const b = (m.breed ??= { thrown: 0, fails: 0, born: 0 });
  // the last feed's wait ran out with no baby (a baby seen since cleared it: noteHall): one more in a row that did nothing
  if (fin(b.at)) b.fails += 1;
  let thrown = 0;
  for (const v0 of pair) {
    if (ctx.signal.aborted) break;
    const v = (await find(ctx, v0.id)) ?? v0;
    // (a throw rests 1 to 4 out: Toss.java; from right beside it none comes down at its feet)
    await walkTo(ctx, v.at, 3);
    const now = (await find(ctx, v.id)) ?? v;
    const r = await ctx.call<{ tossed?: number }>('item.toss', { name: 'bread', count: BREAD_EACH, toward: { ...now.at } }, 15_000)
      .catch((e: Error) => { say(ctx, `hall: the bread to the villager (${v.id}) not thrown: ${e.message}`); return { tossed: 0 }; });
    const n = r.tossed ?? 0;
    thrown += n;
    b.thrown += n;
    if (n) say(ctx, `hall: threw ${n} bread to the villager (${v.id}) for breeding (${b.thrown} thrown in all)`);
  }
  if (!thrown) throw new Error('no bread thrown to the villagers');
  b.at = ctx.s.now;
  b.total = vs.length;
  b.babies = vs.filter(v => v.baby).length;
  ctx.gain(thrown);
  const n = headcount(vs);
  return `threw ${thrown} bread to two villagers to breed (${n.adults} adults, ${n.babies} babies, ${hallBeds(ctx.world).length - n.total} beds free)`;
}

/** Wait for a villager to lose its job (by its id): true once it is unemployed (or gone from the hall). */
async function jobGone(ctx: GoalContext, id: number): Promise<boolean> {
  for (let i = 0; i < HALL_WAITS.loseLooks; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    await pause(HALL_WAITS.pollMs);
    const v = await find(ctx, id);
    if (!v || v.profession === 'none') return true;
  }
  return false;
}

/** Wait for an adult in the hall to take `profession`: that villager, or undefined after jobLooks looks. */
async function jobTaken(ctx: GoalContext, profession: string): Promise<HallVillager | undefined> {
  for (let i = 0; i < HALL_WAITS.jobLooks; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    await pause(HALL_WAITS.pollMs);
    const v = (await look(ctx))?.find(q => !q.baby && q.profession === profession);
    if (v) return v;
  }
  return undefined;
}

/** The cell in front of a job site against the hall's wall: the inner cell away from the wall it stands by. */
function frontOf(world: WorldMemory, p: Pos): Pos {
  const h = hallBox(world)!;
  const d = p.z === h.z + 1 ? [0, 1] : p.z === h.z + h.length - 2 ? [0, -1] : p.x === h.x + 1 ? [1, 0] : p.x === h.x + h.width - 2 ? [-1, 0] : [0, 1];
  return { x: p.x + d[0], y: p.y, z: p.z + d[1] };
}

/** Onto the cell in front of a job site itself (range 0): never in the site's cell, nor 1 off it. */
const toFront = (ctx: GoalContext, cell: Pos) =>
  ctx.call('goto', { ...frontOf(ctx.world, cell), range: 0, careful: true, timeoutMs: 15_000 }, 25_000).catch(() => undefined);

/**
 * Put a job site down in its cell (place-block from the cell in front, stood on: a walk to within 1 of the front ended
 * where it was with the bot in the site's own cell after picking the drop up, and the bridge refused the place four
 * times over, "the bot is standing there"), the block made first where none is carried.
 */
async function placeSite(ctx: GoalContext, cell: Pos, item: string): Promise<void> {
  if (carried(await inventory(ctx), item) < 1) {
    const short = await prepare(ctx, item, 1);
    if (Object.keys(short).length) throw new Error(`a ${item} for the hall: short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    await enterHall(ctx);
  }
  await walkTo(ctx, frontOf(ctx.world, cell), 0);
  // a villager standing in the cell: waited out a few times
  for (let i = 0; i < 4; i++) {
    const r = await ctx.act('place-block', { ...cell, item, faceDirection: 'down' });
    if (r.ok && /^Placed/.test(r.text)) return;
    if (await blockAt(ctx, cell) === item) return;
    // (the bot in the cell or under it after all: out onto the front first)
    if (/where you're standing/.test(r.text)) await toFront(ctx, cell);
    await pause(HALL_WAITS.pollMs);
  }
  throw new Error(`the ${item} did not go down at ${fmt(cell)}`);
}

/**
 * Break a job site and pick it up: dug by hand from the cell in front (dig.here: a block, never anything else; a villager
 * is no block and is never hit), only when it is that site (another block in its cell is someone's: an improvement
 * run's, left alone); the drop waited for a moment (dig.here answers on the client's own break, before the server's
 * drop is there and while it waits out its pickup delay), else walked onto and stepped back off at once; a site whose
 * drop is lost is made again (placeSite).
 */
async function breakSite(ctx: GoalContext, cell: Pos, item: string): Promise<void> {
  await walkTo(ctx, frontOf(ctx.world, cell), 1);
  const there = await blockAt(ctx, cell);
  // (gone already: placeSite puts it back)
  if (AIR.test(there)) return;
  if (there !== item) throw new Error(`${there} stands in the ${item}'s cell at ${fmt(cell)}: not dug`);
  const had = carried(await inventory(ctx), item);
  const r = await ctx.call<{ dug?: boolean; reason?: string }>('dig.here', { ...cell, timeoutMs: 15_000 }, 25_000).catch(e => ({ dug: false, reason: (e as Error).message }));
  if (!r.dug && r.reason !== 'air') throw new Error(`the ${item} at ${fmt(cell)} did not come out: ${r.reason ?? 'not dug'}`);
  for (let i = 0; i < HALL_WAITS.dropLooks; i++) {
    if (carried(await inventory(ctx), item) > had) return;
    await pause(HALL_WAITS.dropMs);
  }
  // the drop: into its cell (empty now) to pick it up, and straight back out onto the front (left standing in it, the
  // site could not be put back: the bridge places no block where the bot stands)
  await ctx.call('goto', { ...cell, range: 0, careful: true, timeoutMs: 15_000 }, 25_000).catch(() => undefined);
  await pause(HALL_WAITS.dropMs);
  const got = carried(await inventory(ctx), item) > had;
  await toFront(ctx, cell);
  if (!got) say(ctx, `hall: the ${item}'s drop not picked up: another is made`);
}

/** The day's count of a reroll, moved on to today first. */
function countRoll(c: { day: number; today: number }, day: number): void {
  if (c.day !== day) { c.day = day; c.today = 0; }
  c.today += 1;
}

/**
 * The librarian: its offers read (a look, never a trade), each read logged as a roll (`librarian: roll N: <books>`).
 * Mending offered: kept (state `mending`), the rolls stop. Traded with already (xp over 0, or above level 1): kept as
 * it is (`locked`), nothing rerolled. Else, under ROLLS_A_DAY today: the lectern broken and picked up, the job waited to
 * go, the lectern put back, the job waited to come back (the same villager or another unemployed one), and read again;
 * up to ROLLS_A_RUN rerolls a run. `fresh`: a librarian just made (the lectern just put down).
 */
async function rollChore(ctx: GoalContext, first: HallVillager): Promise<string> {
  const m = hallChoresOf(ctx.world);
  const cell = ctx.world.zones?.['hall:lectern']?.[0];
  if (!cell) return 'the hall keeps no lectern cell';
  const day = gameDay(ctx.world);
  const lib = (m.librarian ??= { state: 'rolling', rolls: 0, day, today: 0, bought: 0 });
  await enterHall(ctx);
  let v: HallVillager | undefined = first;
  let rerolled = 0;
  for (;;) {
    if (ctx.signal.aborted) return `stopped after ${rerolled} reroll(s)`;
    if (!(lib.read && lib.id === v.id)) {
      const st = await readTrades(ctx, v);
      const offers = st.offers ?? [];
      // (a roll is a read of new offers: a new librarian's, or a reroll's; offers read already, under a new entity id
      // after a reconnect, are no roll, and a maintenance count of the roll lines went past the day's 30)
      const fresh = !lib.read;
      lib.id = v.id;
      lib.read = true;
      if (fresh) lib.rolls += 1;
      lib.level = st.level ?? v.level;
      lib.xp = st.xp ?? 0;
      lib.books = booksOffered(offers).slice(0, 120);
      const mend = mendingOffer(offers);
      say(ctx, fresh ? `librarian: roll ${lib.rolls}: ${lib.books}` : `librarian: re-read (id changed): ${lib.books}`);
      ctx.save?.();
      if (mend) {
        lib.state = 'mending';
        lib.price = mend.costA?.count ?? lib.price;
        delete lib.placedAt;
        ctx.gain(1);
        return `the librarian offers Mending for ${lib.price} emeralds and a book (roll ${lib.rolls}): the rolls stop`;
      }
      if ((st.xp ?? 0) > 0 || (st.level ?? 1) > 1) {
        lib.state = 'locked';
        return `the librarian has traded already (level ${st.level ?? '?'}, ${st.xp ?? '?'} xp) and offers no Mending: kept as it is, no reroll`;
      }
      // (never traded and no Mending: rolled, whatever it was before: one read under a stale `locked` stays rollable)
      lib.state = 'rolling';
    }
    if (todayOf(lib, day) >= ROLLS_A_DAY) return `the librarian rerolled ${todayOf(lib, day)} times today: the rest tomorrow (${lib.rolls} rolls in all)`;
    if (rerolled >= ROLLS_A_RUN) return `rerolled the librarian ${rerolled} times (${lib.rolls} rolls in all, ${todayOf(lib, day)} today), no Mending yet`;
    // the reroll: the lectern out, the job gone, the lectern back, a librarian again
    await breakSite(ctx, cell, 'lectern');
    countRoll(lib, day);
    rerolled++;
    lib.read = false;
    ctx.save?.();
    const gone = await jobGone(ctx, v.id);
    if (!gone) say(ctx, `librarian: the villager (${v.id}) kept its job with the lectern gone`);
    await placeSite(ctx, cell, 'lectern');
    lib.placedAt = clock(ctx);
    // (out of the job site's way: the villager walks up to it to take the job)
    const inside = ctx.world.zones?.['hall:inside']?.[0];
    if (inside) await ctx.call('goto', { ...block(inside), range: 1, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
    v = await jobTaken(ctx, 'librarian');
    if (!v) return `the lectern is back at ${fmt(cell)}, and no villager has taken it yet (${rerolled} reroll(s) this run)`;
    delete lib.placedAt;
    delete lib.waits;
  }
}

/** The lectern down at its cell for the hall's unemployed adult, the job waited for, and the new librarian read (rollChore). */
async function lecternChore(ctx: GoalContext): Promise<string> {
  const m = hallChoresOf(ctx.world);
  const cell = ctx.world.zones?.['hall:lectern']?.[0];
  if (!cell) return 'the hall keeps no lectern cell';
  const there = await blockAt(ctx, cell);
  const day = gameDay(ctx.world);
  const lib = (m.librarian ??= { state: 'rolling', rolls: 0, day, today: 0, bought: 0 });
  // (a new librarian, whoever it is: a lost one's Mending is no more)
  lib.state = 'rolling';
  lib.read = false;
  delete lib.price;
  if (there !== 'lectern') {
    // (a failure, so the chore is passed over: as a plain end it was wanted again at the next tick, a look each time)
    if (!AIR.test(there)) throw new Error(`${there || 'something'} stands in the lectern's cell at ${fmt(cell)}: left alone`);
    if (carried(await inventory(ctx), 'lectern') < 1) {
      const short = await prepare(ctx, 'lectern', 1);
      if (Object.keys(short).length) throw new Error(`a lectern for the hall: short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    }
    await enterHall(ctx);
    await placeSite(ctx, cell, 'lectern');
    say(ctx, `hall: a lectern at ${fmt(cell)} for the unemployed villager`);
  } else await enterHall(ctx);
  lib.placedAt = clock(ctx);
  ctx.save?.();
  const inside = ctx.world.zones?.['hall:inside']?.[0];
  if (inside) await ctx.call('goto', { ...block(inside), range: 1, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
  const v = await jobTaken(ctx, 'librarian');
  if (!v) {
    lib.placedAt = clock(ctx);
    // (runs in a row with no taker: passed over as a failure after LECTERN_WAITS, not a 90-s wait every 5 min all day)
    lib.waits = (lib.waits ?? 0) + 1;
    const text = `a lectern at ${fmt(cell)}; no villager has taken it yet`;
    if (lib.waits >= LECTERN_WAITS) { lib.waits = 0; throw new Error(`${text} (${LECTERN_WAITS} waits in a row)`); }
    return text;
  }
  delete lib.placedAt;
  delete lib.waits;
  return rollChore(ctx, v);
}

/**
 * Mending bought: the emeralds and a book carried first (from the chests; a book made of paper and leather), the
 * librarian's offers read again, and the Mending offer alone traded, once (trade.do names the result and the
 * enchantment: the bridge trades nothing else). The anvil (anvil.ts) puts the book on the next piece without mending.
 */
async function buyChore(ctx: GoalContext, v: HallVillager): Promise<string> {
  const lib = hallChoresOf(ctx.world).librarian!;
  const price = lib.price ?? 0;
  const items = await inventory(ctx);
  if (carried(items, 'emerald') < price) {
    const short = await prepare(ctx, 'emerald', price);
    if (Object.keys(short).length) throw new Error(`Mending: ${price} emeralds wanted, short of ${short.emerald ?? price}`);
  }
  if (carried(await inventory(ctx), 'book') < 1) {
    const short = await prepare(ctx, 'book', 1);
    if (Object.keys(short).length) throw new Error(`Mending: a book to pay with: short of ${Object.entries(short).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  }
  await enterHall(ctx);
  await walkTo(ctx, v.at, 2);
  let done: TradeDone | undefined;
  try {
    const st = await ctx.call<TradeStatus>('trade.open', { id: v.id }, 15_000);
    const mend = mendingOffer(st.offers ?? []);
    if (!mend) {
      // (not the one: another librarian, or a restart's new ids) read from scratch
      lib.state = 'rolling';
      lib.read = false;
      delete lib.price;
      return `the librarian (${v.id}) offers no Mending (${booksOffered(st.offers ?? [])}): its offers read again next`;
    }
    lib.price = mend.costA?.count ?? price;
    if (mend.outOfStock || mend.uses >= mend.maxUses) {
      lib.outAt = ctx.s.now;
      return `Mending sold out (${mend.uses}/${mend.maxUses}): waiting for a restock`;
    }
    done = await ctx.call<TradeDone>('trade.do', { index: mend.index, times: 1, result: 'enchanted_book', enchantment: 'mending' }, 30_000);
  } finally {
    await brainRun.exit(() => ctx.call('trade.close', {})).catch(() => undefined);
  }
  if (!done?.ok || !done.traded) throw new Error(`the Mending trade did not go: ${done?.stopped ?? 'no answer'}`);
  lib.bought += done.traded;
  lib.boughtAt = ctx.s.now;
  lib.xp = done.xp;
  const spent = done.spent?.emerald ?? lib.price;
  ctx.gain(done.traded);
  const left = mendingWanted(await inventory(ctx).catch(() => ctx.s.items), ctx.world);
  const text = `librarian: bought mending for ${spent} emeralds and a book (${lib.bought} bought, ${left} more wanted)`;
  say(ctx, text);
  return text;
}

/**
 * Sticks sold to the fletcher: up to STICK_TRADES_A_RUN trades and the emeralds short of EMERALD_TARGET, the sticks made
 * from the logs first; its offers read, the stick trade alone traded (trade.do names the emerald). No stick trade:
 * remembered (the fletcher chore rerolls one that has never traded).
 */
async function sticksChore(ctx: GoalContext, v: HallVillager): Promise<string> {
  const m = hallChoresOf(ctx.world);
  const day = gameDay(ctx.world);
  const f = (m.fletcher ??= { sold: 0, rolls: 0, day, today: 0 });
  const have = haveOf(await inventory(ctx), ctx.world);
  const trades = Math.max(1, Math.min(STICK_TRADES_A_RUN, EMERALD_TARGET - (have.emerald ?? 0)));
  // the price as last read (32, and up to a stack with demand once the trade sold out)
  const per = Math.min(64, Math.max(1, f.price ?? 32));
  if (carried(await inventory(ctx), 'stick') < per * trades) {
    await prepare(ctx, 'stick', per * trades);
    if (carried(await inventory(ctx), 'stick') < per) throw new Error('no sticks for the fletcher');
  }
  await enterHall(ctx);
  await walkTo(ctx, v.at, 2);
  let done: TradeDone | undefined;
  let offer: TradeOffer | undefined;
  let left = 0;
  try {
    const st = await ctx.call<TradeStatus>('trade.open', { id: v.id }, 15_000);
    f.id = v.id;
    f.level = st.level ?? v.level;
    f.xp = st.xp ?? 0;
    offer = stickOffer(st.offers ?? []);
    f.sticks = !!offer;
    const price = offer?.costA?.count;
    if (fin(price)) f.price = price;
    if (!offer) {
      const text = `fletcher: no stick trade (${(st.offers ?? []).map(o => `${o.costA?.name ?? '?'} -> ${o.result?.name ?? '?'}`).join(', ') || 'no offers'})`;
      say(ctx, text);
      return text;
    }
    left = offer.maxUses - offer.uses;
    const sticks = carried(await inventory(ctx), 'stick');
    const times = Math.min(trades, left, Math.floor(sticks / Math.max(1, offer.costA?.count ?? per)));
    if (offer.outOfStock || left <= 0) {
      f.outAt = ctx.s.now;
      return `fletcher: the stick trade is sold out (${offer.uses}/${offer.maxUses}): waiting for a restock`;
    }
    // (a failure: as a plain end the chore was wanted again at the next tick, a walk in and a look each time)
    if (times <= 0) throw new Error(`fletcher: ${sticks} sticks, the trade takes ${offer.costA?.count ?? per}`);
    done = await ctx.call<TradeDone>('trade.do', { index: offer.index, times, result: 'emerald' }, 60_000);
  } finally {
    await brainRun.exit(() => ctx.call('trade.close', {})).catch(() => undefined);
  }
  if (!done?.ok || !done.traded) throw new Error(`the stick trade did not go: ${done?.stopped ?? 'no answer'}`);
  f.sold += done.traded;
  f.xp = done.xp ?? f.xp;
  f.level = done.level ?? f.level;
  // sold out: the run asked past the uses left, or its trades used the last of them (Run.step then says "done": the
  // offer after it, or the count, tells), so the next tick does not walk in to find it so
  if (/out of stock/.test(done.stopped ?? '') || done.offer?.outOfStock || done.traded >= left) f.outAt = ctx.s.now;
  ctx.gain(done.count);
  const emeralds = haveOf(await inventory(ctx).catch(() => ctx.s.items), ctx.world).emerald ?? 0;
  const text = `fletcher: sold ${done.spent?.stick ?? done.traded * (offer?.costA?.count ?? per)} sticks for ${done.count} emeralds (${emeralds} now)`;
  say(ctx, text);
  return text;
}

/**
 * The fletcher without the stick trade, never traded with: its fletching table broken and put back as the librarian's
 * lectern is, its new offers read (a look only), until the stick trade shows (FLETCHER_ROLLS_A_DAY a day).
 */
async function fletcherChore(ctx: GoalContext, v: HallVillager): Promise<string> {
  const m = hallChoresOf(ctx.world);
  const cell = ctx.world.zones?.['hall:fletching']?.[0];
  if (!cell) return 'the hall keeps no fletching table cell';
  const day = gameDay(ctx.world);
  const f = (m.fletcher ??= { sold: 0, rolls: 0, day, today: 0 });
  await enterHall(ctx);
  // (another fletcher than the one read, or new ids after a restart: its own offers first, a look only)
  if (f.id !== v.id) {
    const st = await readTrades(ctx, v);
    f.id = v.id;
    f.level = st.level ?? v.level;
    f.xp = st.xp ?? 0;
    f.sticks = !!stickOffer(st.offers ?? []);
    if (f.sticks) return 'fletcher: the stick trade is there after all';
    if (f.xp > 0 || f.level > 1) return 'fletcher: no stick trade, and it has traded: kept as it is';
  }
  await breakSite(ctx, cell, 'fletching_table');
  countRoll(f, day);
  f.rolls += 1;
  ctx.save?.();
  if (!await jobGone(ctx, v.id)) say(ctx, `fletcher: the villager (${v.id}) kept its job with the table gone`);
  await placeSite(ctx, cell, 'fletching_table');
  const inside = ctx.world.zones?.['hall:inside']?.[0];
  if (inside) await ctx.call('goto', { ...block(inside), range: 1, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
  const w = await jobTaken(ctx, 'fletcher');
  if (!w) { delete f.sticks; return `the fletching table is back at ${fmt(cell)}; no villager has taken it yet`; }
  const st = await readTrades(ctx, w);
  f.id = w.id;
  f.level = st.level ?? w.level;
  f.xp = st.xp ?? 0;
  f.sticks = !!stickOffer(st.offers ?? []);
  const text = `fletcher: roll ${f.rolls}: ${(st.offers ?? []).map(o => `${o.costA?.name ?? '?'} -> ${o.result?.name ?? '?'}`).join(', ') || 'no offers'}${f.sticks ? ': the stick trade' : ''}`;
  say(ctx, text);
  return text;
}

/**
 * The villager chores, by day from the yard, while the hall has villagers in it: the hall looked into first (the
 * census), the next chore planned again from what it shows (chorePlan), done, and out by the gate (shut behind). A
 * villager is never hit: no attack, no weapon swung near one (the bridge's trade.open refuses a weapon in hand, the
 * throws and digs are no hits); the Guardian's own rules hold for the mobs.
 */
export const hallChoresGoal: Goal = {
  name: 'hall chores',
  priority: 30,
  timeoutMs: 10 * MINUTE,
  retryMs: 20 * MINUTE,
  gate,
  ...fromGate(gate),
  // a chore at home that can always wait: it takes over at the hand-over, never stops what runs
  cuts: () => false,
  gains: true,
  run: async ctx => {
    began.set(ctx, Date.now());
    const vs = await look(ctx);
    if (!vs) throw new Error('could not look at the villager hall');
    if (!vs.length) return 'the villager hall is empty';
    const plan = chorePlan(ctx.s, ctx.world);
    if ('none' in plan) return `nothing to do: ${plan.none.text}`;
    const n = headcount(vs);
    const m = hallChoresOf(ctx.world);
    let text = '';
    try {
      switch (plan.chore) {
        case 'beds': text = await bedsChore(ctx); break;
        case 'breed': text = await breedChore(ctx, vs); break;
        case 'lectern': text = await lecternChore(ctx); break;
        case 'roll': text = n.librarian ? await rollChore(ctx, n.librarian) : 'no librarian in the hall'; break;
        case 'buy': text = n.librarian ? await buyChore(ctx, n.librarian) : 'no librarian in the hall'; break;
        case 'sticks': text = n.fletcher ? await sticksChore(ctx, n.fletcher) : 'no fletcher in the hall'; break;
        case 'fletcher': text = n.fletcher ? await fletcherChore(ctx, n.fletcher) : 'no fletcher in the hall'; break;
      }
      if (m.failed) delete m.failed[plan.chore];
    } catch (e) {
      // (a run stopped from outside is no failure of the chore)
      if (!ctx.signal.aborted) (m.failed ??= {})[plan.chore] = ctx.s.now;
      throw e;
    } finally {
      text += await leaveHall(ctx);
    }
    return text;
  }
};

// ------------------------------------------------------------------------------------------------ the status

/**
 * brain-status's Villagers line, the chores' part: the hall's adults and babies and beds as last seen, the librarian's
 * state (rolls today, Mending offered or not, bought), the fletcher's, the emeralds (in the chests, plus `carried`).
 * Empty until the hall has been looked into.
 */
export function hallChoresText(world: WorldMemory, now: number, carried = 0): string {
  const m = peek(world);
  if (!m.census || !hallBox(world)) return '';
  const n = headcount(m.census.villagers);
  const ago = Math.round((now - m.census.at) / MINUTE);
  const day = gameDay(world);
  const lib = m.librarian;
  const libText = !n.librarian && !lib ? 'none yet'
    : !lib ? 'not read yet'
      : lib.state === 'mending' ? `Mending offered (${lib.price ?? '?'} emeralds and a book), ${lib.bought} bought`
        : lib.state === 'locked' ? 'traded with before Mending showed: kept as it is'
          : `${!n.librarian ? 'none now (the lectern waits for an unemployed adult); ' : ''}${todayOf(lib, day)} rerolls today (${lib.rolls} offers read in all), no Mending yet${lib.books ? ` (last: ${lib.books})` : ''}`;
  const f = m.fletcher;
  const fText = !n.fletcher ? 'none' : f?.sticks === false ? 'no stick trade' : f?.sticks ? `sticks for emeralds (${f.sold} sold)` : 'not read yet';
  const emeralds = (freeChestTotals(world).emerald ?? 0) + carried;
  const b = m.breed;
  return `; in the hall ${n.adults} adult${n.adults === 1 ? '' : 's'}, ${n.babies} bab${n.babies === 1 ? 'y' : 'ies'}, ${hallBeds(world).length} beds ` +
    `(seen ${ago < 1 ? 'just now' : `${ago} min ago`})${b ? `; ${b.thrown} bread thrown, ${b.born} born` : ''}; librarian: ${libText}; fletcher: ${fText}; emeralds ${emeralds}`;
}
