import type { Pos, WorldMemory } from './memory.js';
import { zoneDistance, type Zone } from './courtesy.js';
import { clock } from './idlelog.js';
import { cellOf } from './boatroute.js';

/**
 * Villages for the villager move (P5c of the progression plan): where they are (remembered from any walk: a bell, a
 * village's beds and job sites, villagers seen), the players seen anywhere (the courtesy judge reads them), the hall's
 * count, and the courtesy judge itself. On a shared server a village belongs to whoever uses it, and is left alone, if
 * any of these hold (the plan's rules, absolute): a villager is named, riding something or penned in; something only a
 * player puts down (a sign, a rail, redstone, a portal...) stands in it or within 16 of it; a player was ever seen within
 * 64 of it; it lies within 256 of the world spawn, or near another build of others. Only from a village of 5 villagers
 * or more, only an unemployed adult (never a nitwit, a baby, or one by a job site it may be taking), one a move. The
 * move itself (the boat, the hall) is villagemove.ts's; the switch that lets it run is `villagerMoves` (off as it ships:
 * the lead turns it on and watches the first move).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How far from home villages are looked for and moved from (the user's word, Nov 13). */
export const VILLAGE_RANGE = 384;
/** The fewest villagers a village has for one to be taken from it. */
export const VILLAGE_MIN = 5;
/** Within this of the world spawn every village is someone's (the server's spawn town and its neighbours). */
export const SPAWN_CLEAR = 256;
/** A player seen this near a village, ever: it is someone's. */
export const PLAYER_CLEAR = 64;
/** Player-only markers this near the village's area make it someone's. */
export const MARKERS_NEAR = 16;
/** Another build of others this near the village's area (not its own houses) makes it someone's. */
export const ZONES_NEAR = 48;
/** The village's area: the box round its bell, beds, job sites and villagers, grown by this (its outer houses and fields). */
export const AREA_GROW = 24;
/**
 * The village's own marks: its bell, and the beds and job sites chained to it, each within CHAIN of the bell or of
 * another chained one, and within VILLAGE_REACH of the bell (about how far a village reaches from its meeting point).
 * A player's house by a village has a bed and a barrel too: one farther than CHAIN from all of the village's own is not
 * chained in, and its zone is another build.
 */
export const CHAIN = 32;
export const VILLAGE_REACH = 80;
/** A build (a zone) this near one of the village's own marks is one of its houses; any other near it is someone's. */
export const OWN_NEAR = 8;
/** The hall wants this many villagers (P5c moves them in until it has them; P5d breeds from there). */
export const HALL_WANTS = 3;
/** The hall's count is good this long; older, a move looks at the hall again before it goes. */
export const HALL_FRESH = 30 * MINUTE;
/** A villager that can walk to fewer cells than this round where it stands is penned in (a trading hall's cell, a pen). */
export const PENNED_ROOM = 24;
/** An unemployed villager this near a job site block may be taking the job: it is left be. */
export const JOB_NEAR = 2;
/** A village the boat found no way home from is tried again after this (the rails fallback, planned and off, is for it). */
export const NO_BOAT_WAIT = 24 * HOUR;
/** A village too small, or not all seen, is looked at again after this. */
export const WAIT_AGAIN = 6 * HOUR;
/** Villages kept that are not someone's (the newest); those judged someone's are kept apart, up to THEIRS_KEPT. */
const SITES = 8;
/**
 * Villages judged someone's, kept for good beside the others (the oldest go only past this many): one forgotten would be
 * judged again from scratch, the player who made it someone's perhaps forgotten too.
 */
const THEIRS_KEPT = 32;
/**
 * Player sightings kept: those that can bear on a village the rung may visit (within PLAYERS_FROM of the yard), the most
 * recently seen first past this many (a place seen again stays). Live, every look of every run in the overworld adds
 * one: 64 were a few hours of a friend walking about by the community chest, and the one by an unjudged village rolled off.
 */
const PLAYERS = 512;
const PLAYERS_FROM = VILLAGE_RANGE + AREA_GROW + PLAYER_CLEAR;
/** Sightings within this of a known village are that village. */
export const SAME_VILLAGE = 64;
/** Player sightings within this of each other are one place (the newest time kept). */
const SAME_PLAYER = 16;
/** A villager seen this far outside the yard is out in the world (the hall's own, strayed out of it, are not a village). */
const OUT_OF_YARD = 48;

/** A villager's job site blocks (26.3): an unemployed villager by one may be about to take it. */
export const JOB_SITE = /^(lectern|composter|barrel|blast_furnace|smoker|cartography_table|brewing_stand|cauldron|water_cauldron|lava_cauldron|powder_snow_cauldron|fletching_table|grindstone|loom|smithing_table|stonecutter)$/;
/** What tells a village from the scans' markers: its bell, its beds, its job sites. */
export const VILLAGE_MARK = /^(bell|.*_bed|lectern|composter|barrel|blast_furnace|smoker|cartography_table|brewing_stand|cauldron|water_cauldron|fletching_table|grindstone|loom|smithing_table|stonecutter)$/;
/**
 * What only a player puts down: no village (no structure the world makes round one) has it. Signs, rails, redstone and
 * its parts, a portal, the blocks of a player's base (concrete, shulker boxes, beacons, ender chests, enchanting
 * tables), buttons, banners, candles, coloured glass, iron doors, the soul and copper lights. Lanterns, anvils, campfires,
 * barrels, bookshelves and the rest of a village's own furnishing are not here.
 */
export const PLAYER_ONLY = new RegExp('^(.*_sign|.*_wall_sign|.*_hanging_sign|.*_wall_hanging_sign|rail|powered_rail|detector_rail|activator_rail'
  + '|redstone_wire|redstone_torch|redstone_wall_torch|repeater|comparator|redstone_lamp|observer|piston|sticky_piston|hopper|dropper|dispenser'
  + '|lever|target|daylight_detector|tripwire_hook|note_block|crafter|nether_portal|tnt|slime_block|honey_block|beacon|ender_chest|respawn_anchor'
  + '|lodestone|.*shulker_box|.*_concrete|.*_concrete_powder|enchanting_table|jukebox|end_rod|[a-z_]*copper_bulb|.*_button|.*_banner|.*_wall_banner'
  + '|.*_candle|candle|tinted_glass|.*_stained_glass|.*_stained_glass_pane|iron_door|iron_trapdoor|soul_torch|soul_wall_torch|soul_lantern)$');

/** A creature as world.entities reports it, with what the judge reads. */
export interface Seen {
  id: number;
  name: string;
  position?: Pos;
  distance?: number;
  baby?: boolean;
  named?: boolean;
  customName?: string;
  tamed?: boolean;
  leashed?: boolean;
  vehicle?: string;
  vehicleId?: number;
  /** a villager's job ('none' unemployed, 'nitwit'), level and biome type */
  profession?: string;
  level?: number;
  type?: string;
  /** a boat or minecart: the bot's own (vehicle.place's), its uuid, its riders' ids (front seat first) */
  own?: boolean;
  uuid?: string;
  passengers?: number[];
}

/** One village as remembered. */
export interface VillageSite {
  /** its middle: the bell, else where its villagers or beds were seen */
  x: number; y: number; z: number;
  /** what was seen there at the last look */
  bells?: number; beds?: number; jobs?: number; villagers?: number;
  seenAt: number;
  /**
   * the courtesy judge's last word: `free` (villagers may be taken), `theirs` (someone's: left alone, for good), `wait`
   * (too small, or not all of it seen: looked at again after WAIT_AGAIN)
   */
  judged?: { at: number; kind: 'free' | 'theirs' | 'wait'; why: string };
  /** no boat way home found from it (the rails fallback's): why, and when (tried again after NO_BOAT_WAIT) */
  noBoat?: { at: number; why: string };
  /** the rails fallback's dry run then (railroute.ts: planned only, never laid): its plan in short, or why none */
  rails?: { at: number; ok: boolean; text: string };
  /** villagers brought home from it */
  moved?: number;
  /**
   * its area as the judge last saw it (the box round its bell, beds, job sites and villagers, grown by AREA_GROW): a
   * sighting or a bell in it is this village, whatever its distance from the middle
   */
  area?: { x1: number; z1: number; x2: number; z2: number };
}

/** Kept in brain.json per world (world.villages). */
export interface VillagesMemory {
  sites: VillageSite[];
  /** players seen in the overworld: where and when (the newest of each place), the latest PLAYERS */
  players: { x: number; y: number; z: number; at: number }[];
  /** the hall as last counted: villagers inside its box, and when */
  hall?: { count: number; at: number };
  /** the last move's word */
  last?: { at: number; text: string; moved: boolean };
  /**
   * What a move dug out and has not put back yet (the hall's wall, the yard's fence, what stood on its posts): the block
   * each held, in the order to put them back. Written before each dig, so a run cut short leaves it for `close up`
   */
  open?: { at: Pos; block: string }[];
  /** the bot's own boat out in the world (vehicle.place's uuid, and where): a move cut short left it there */
  boat?: { uuid: string; at: Pos; since: number };
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPos = (p: unknown): p is Pos => !!p && fin((p as Pos).x) && fin((p as Pos).y) && fin((p as Pos).z);
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

const areaOk = (a: VillageSite['area']): a is NonNullable<VillageSite['area']> => !!a && fin(a.x1) && fin(a.z1) && fin(a.x2) && fin(a.z2);
const inArea = (a: VillageSite['area'], p: { x: number; z: number }) => areaOk(a) && p.x >= a.x1 && p.x <= a.x2 && p.z >= a.z1 && p.z <= a.z2;
/**
 * A place that is this village: within SAME_VILLAGE of its middle, or inside the area its judge saw. A site judged with
 * no area (by the code before areas were kept, or someone's by a player seen: noteSeen) reaches SAME_VILLAGE +
 * AREA_GROW, about the area a judge draws: live, the village judged someone's on Nov 15 has none and is never judged
 * again, and its villagers stand 70 and more from its bell (a site made for them was a trip out for nothing).
 */
const covers = (s: VillageSite, p: { x: number; z: number }) => horiz(s, p) <= SAME_VILLAGE || inArea(s.area, p)
  || (!!s.judged && !areaOk(s.area) && horiz(s, p) <= SAME_VILLAGE + AREA_GROW);

/**
 * The site a place belongs to (pure): the first within SAME_VILLAGE of it, else a judged one that covers it (a village
 * is wider than SAME_VILLAGE: live on Nov 15 its villagers stood 40 and 60 from its bell).
 */
export function siteFor(sites: readonly VillageSite[], p: { x: number; z: number }): VillageSite | undefined {
  return sites.find(q => horiz(q, p) <= SAME_VILLAGE) ?? sites.find(q => q.judged && covers(q, p));
}

type Box = NonNullable<VillageSite['area']>;
/** Two boxes joined (pure): `a` (none: just `b`) grown to hold `b`. */
export const joinAreas = (a: VillageSite['area'], b: Box): Box =>
  (areaOk(a) ? { x1: Math.min(a.x1, b.x1), z1: Math.min(a.z1, b.z1), x2: Math.max(a.x2, b.x2), z2: Math.max(a.z2, b.z2) } : { x1: b.x1, z1: b.z1, x2: b.x2, z2: b.z2 });
/**
 * All the ground a site covers, as a box (pure): its area, and round its middle SAME_VILLAGE, or SAME_VILLAGE +
 * AREA_GROW judged with no area. A site someone's that moves (to a bell) or takes an area keeps this as its area: the
 * ground round where it stood stays someone's.
 */
export function reachOf(s: VillageSite): Box {
  const r = s.judged && !areaOk(s.area) ? SAME_VILLAGE + AREA_GROW : SAME_VILLAGE;
  return joinAreas(s.area, { x1: s.x - r, z1: s.z - r, x2: s.x + r, z2: s.z + r });
}

/**
 * Which site each one a write folded went into (foldSites in place): the run that holds a site folded away reads its
 * village's word from the one it went into, not from whichever site is nearest (one not judged, ahead of it in the list,
 * would say nothing of someone's).
 */
const foldedTo = new WeakMap<VillageSite, VillageSite>();
/** The site a write folded `s` into, or undefined (never folded). */
export const foldedInto = (s: VillageSite): VillageSite | undefined => foldedTo.get(s);
/**
 * Where a site a run holds is now (pure but for the folds' record): itself while among `sites`, else the one a write
 * folded it into (and on, where that one was folded in turn); undefined when it is gone (forgotten, trimmed).
 */
export function siteNow(sites: readonly VillageSite[], s: VillageSite): VillageSite | undefined {
  const seen = new Set<VillageSite>();
  for (let q: VillageSite | undefined = s; q && !seen.has(q); q = foldedTo.get(q)) {
    if (sites.includes(q)) return q;
    seen.add(q);
  }
  return undefined;
}

/**
 * One village, one site (pure but for `inPlace`, the writes' own): a site within SAME_VILLAGE of a judged one, or inside
 * its area, or with the judged one inside its own, is that village, and is folded into it: its counts kept (the most
 * seen of each), its moves added, the newer of their boat and rails words kept, the areas joined, the position the
 * bell's; a site someone's never covers less for it (reachOf: what it and a site someone's folded into it reached is
 * its area). Someone's comes first (a village one site of which is someone's is someone's: the courteous side), then the
 * newest verdict. Live on Nov 15 the look round a village noted two sites from its villagers (40 and 60 from its bell) a
 * minute before the judge wrote the bell's site someone's, and the next run set out for one of them, 192 out. Each site
 * is judged against the judged one as folded so far, both ways (a site someone's by a player seen has no area, and may
 * lie in a newer free one's), and the fold goes round again until nothing more folds (one moved to a bell, or grown by
 * an area, reaches a site it passed over): the gates' copy and the write fold alike. `inPlace`: the site kept is
 * written itself (a run holds it across its awaits); else a copy is (the gates write nothing). Returns the sites kept,
 * in their order, and which kept site each folded one went into.
 */
function foldSites(sites: VillageSite[], inPlace: boolean): { sites: VillageSite[]; into: Map<VillageSite, VillageSite> } {
  const into = new Map<VillageSite, VillageSite>();
  const judged = sites.filter(s => s.judged).sort((a, b) => Number(b.judged!.kind === 'theirs') - Number(a.judged!.kind === 'theirs') || b.judged!.at - a.judged!.at);
  if (!judged.length) return { sites, into };
  const rank = new Map(judged.map((s, i) => [s, i] as const));
  const kept = new Map<VillageSite, VillageSite>();
  // (a site as folded so far: the gates' copy, or the site itself)
  const cur = (s: VillageSite) => kept.get(s) ?? s;
  for (let grew = true; grew;) {
    grew = false;
    for (const t of judged) {
      if (into.has(t)) continue;
      for (const s of sites) {
        // (never into one that comes after it: someone's first, then the newest word)
        if (s === t || into.has(s) || (rank.get(s) ?? judged.length) < rank.get(t)!) continue;
        const c = cur(s);
        if (!covers(cur(t), c) && !covers(c, cur(t))) continue;
        let m = kept.get(t);
        if (!m) { m = inPlace ? t : { ...t }; kept.set(t, m); }
        // (the bell's place: a site from villagers seen takes the bell of one folded into it)
        const moves = !m.bells && !!c.bells;
        // (someone's keeps all the ground it covered: moved to the bell, or its reach with no area given up for one, the
        // box round where it stood is its area first; a site someone's folded into it brings its own reach along. Else
        // the ground round a site someone's by a player seen opened up to a new site the rung went to)
        if (m.judged?.kind === 'theirs' && (moves || !areaOk(m.area))) m.area = reachOf(m);
        if (moves) { m.x = c.x; m.y = c.y; m.z = c.z; }
        for (const k of ['bells', 'beds', 'jobs', 'villagers'] as const) if (fin(c[k])) m[k] = Math.max(m[k] ?? 0, c[k]!);
        m.seenAt = Math.max(m.seenAt, c.seenAt);
        if (fin(c.moved) && c.moved > 0) m.moved = (m.moved ?? 0) + c.moved;
        if (c.noBoat && fin(c.noBoat.at) && (!m.noBoat || c.noBoat.at > m.noBoat.at)) m.noBoat = c.noBoat;
        if (c.rails && fin(c.rails.at) && (!m.rails || c.rails.at > m.rails.at)) m.rails = c.rails;
        const add = c.judged?.kind === 'theirs' ? reachOf(c) : areaOk(c.area) ? c.area : undefined;
        if (add) m.area = joinAreas(m.area, add);
        into.set(s, t);
        grew = true;
      }
    }
  }
  if (!into.size) return { sites, into };
  // (a judged site folded into another after it took some in: those go on into that one)
  const root = (s: VillageSite): VillageSite => { let t = into.get(s)!; while (into.has(t)) t = into.get(t)!; return t; };
  const went = new Map([...into.keys()].map(s => [s, cur(root(s))] as const));
  if (inPlace) for (const [s, t] of went) foldedTo.set(s, t);
  return { sites: sites.filter(s => !went.has(s)).map(cur), into: went };
}

/** The sites kept (pure): every one judged someone's (the newest THEIRS_KEPT), and the newest SITES of the rest, in their order. */
function trimSites(sites: VillageSite[]): VillageSite[] {
  const theirs = sites.filter(s => s.judged?.kind === 'theirs');
  if (theirs.length <= THEIRS_KEPT && sites.length - theirs.length <= SITES) return sites;
  const keep = new Set([...theirs.slice(-THEIRS_KEPT), ...sites.filter(s => s.judged?.kind !== 'theirs').slice(-SITES)]);
  return sites.filter(s => keep.has(s));
}

/** The sightings kept (pure): those within PLAYERS_FROM of the yard (all, with no yard), the PLAYERS seen most lately, in their order. */
function trimPlayers<T extends { x: number; z: number; at: number }>(players: T[], yard?: WorldMemory['yard']): T[] {
  const near = yard ? players.filter(p => Math.max(yard.x1 - p.x, 0, p.x - yard.x2, yard.z1 - p.z, p.z - yard.z2) <= PLAYERS_FROM) : players;
  if (near.length <= PLAYERS) return near;
  const keep = new Set([...near].sort((a, b) => b.at - a.at).slice(0, PLAYERS));
  return near.filter(p => keep.has(p));
}

function clean(raw: unknown, yard?: WorldMemory['yard'], inPlace = false): VillagesMemory {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<VillagesMemory>;
  const sites = Array.isArray(r.sites) ? trimSites(foldSites(r.sites.filter(s => isPos(s) && fin(s.seenAt)), inPlace).sites) : [];
  const players = Array.isArray(r.players) ? trimPlayers(r.players.filter(p => isPos(p) && fin(p.at)), yard) : [];
  const out: VillagesMemory = { sites, players };
  if (r.hall && fin(r.hall.count) && fin(r.hall.at)) out.hall = { count: r.hall.count, at: r.hall.at };
  if (r.last && fin(r.last.at) && typeof r.last.text === 'string') out.last = { at: r.last.at, text: r.last.text, moved: !!r.last.moved };
  if (Array.isArray(r.open)) {
    const open = r.open.filter(o => o && isPos(o.at) && typeof o.block === 'string');
    if (open.length) out.open = open;
  }
  if (r.boat && typeof r.boat.uuid === 'string' && isPos(r.boat.at) && fin(r.boat.since)) out.boat = r.boat;
  return out;
}

/**
 * The villages' memory, made whole in the world (a write: runs only, never a gate). The same object every time, made
 * whole in place: a run holds it across its awaits, and a look round (noteSeen) may come in between. A village's sites
 * are folded into its judged one here (foldSites), that site itself written.
 */
export function villagesOf(world: WorldMemory): VillagesMemory {
  const c = clean(world.villages, world.yard, true);
  const v = world.villages && typeof world.villages === 'object' ? world.villages : (world.villages = c);
  if (v === c) return v;
  v.sites = c.sites;
  v.players = c.players;
  for (const key of ['hall', 'last', 'open', 'boat'] as const) {
    if (c[key] === undefined) delete v[key];
    else (v as unknown as Record<string, unknown>)[key] = c[key];
  }
  return v;
}

/** The same to read only (the gates): a world without it reads empty, and nothing is written. */
export function peekVillages(world: WorldMemory): VillagesMemory {
  return clean(world.villages, world.yard);
}

/** The villager-moves switch: the move runs only while it is true (off, undefined, as it ships). */
export const movesOn = (world: WorldMemory): boolean => world.villagerMoves === true;

// ------------------------------------------------------------------------------------------------ sightings

/**
 * What a look round (world.entities) saw, remembered: every player (where and when: a village within 64 of one is
 * someone's, whenever it was seen), and villagers out in the world (outside the yard, its hall's aside), as a village
 * site where none is known within SAME_VILLAGE, nor a judged one whose area holds them (siteFor: its count kept to the
 * most seen). A village already known within PLAYER_CLEAR + AREA_GROW of a player seen is judged someone's there and
 * then, for good: the sighting itself may roll off the list one day, the verdict stays. Overworld only. Returns whether
 * anything was written.
 */
export function noteSeen(world: WorldMemory, seen: readonly Seen[], now: number, dimension = 'overworld'): boolean {
  if (dimension !== 'overworld') return false;
  const players = seen.filter(e => e.name === 'player' && isPos(e.position));
  const yard = world.yard;
  const out = (p: Pos) => !yard || Math.max(yard.x1 - p.x, 0, p.x - yard.x2, yard.z1 - p.z, p.z - yard.z2) > OUT_OF_YARD;
  const villagers = seen.filter(e => e.name === 'villager' && isPos(e.position) && out(e.position!));
  if (!players.length && !villagers.length) return false;
  const v = villagesOf(world);
  const spots = players.map(p => ({ x: Math.round(p.position!.x), y: Math.round(p.position!.y), z: Math.round(p.position!.z) }));
  for (const at of spots) {
    const near = v.players.find(q => horiz(q, at) <= SAME_PLAYER);
    if (near) { near.at = Math.max(near.at, now); continue; }
    v.players.push({ ...at, at: now });
  }
  v.players = trimPlayers(v.players, yard);
  for (const e of villagers) {
    const p = e.position!;
    const site = siteFor(v.sites, p);
    const here = villagers.filter(o => horiz(o.position!, p) <= SAME_VILLAGE).length;
    if (site) {
      site.villagers = Math.max(site.villagers ?? 0, here);
      site.seenAt = now;
      continue;
    }
    v.sites.push({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), villagers: here, seenAt: now });
  }
  // (after the villagers: a village first seen in this same look with a player by it is someone's from the start)
  for (const at of spots) {
    for (const site of v.sites) {
      const d = horiz(site, at);
      if (site.judged?.kind === 'theirs' || d > PLAYER_CLEAR + AREA_GROW) continue;
      site.judged = { at: now, kind: 'theirs', why: `a player was seen ${Math.round(d)} from it, at (${at.x}, ${at.y}, ${at.z}) (${clock(now)})` };
    }
  }
  v.sites = trimSites(v.sites);
  return true;
}

/**
 * A village's bell seen (and what is round it): its site, kept with the bell as its middle (a site from villagers seen
 * moves to its bell); one inside a judged village's area is that village, which stays where it is. Returns the site.
 */
export function noteVillage(world: WorldMemory, at: Pos, counts: { bells?: number; beds?: number; jobs?: number; villagers?: number }, now: number): VillageSite {
  const v = villagesOf(world);
  let site = v.sites.find(q => horiz(q, at) <= SAME_VILLAGE);
  if (site && counts.bells) { site.x = at.x; site.y = at.y; site.z = at.z; }
  site ??= siteFor(v.sites, at);
  if (!site) {
    site = { x: at.x, y: at.y, z: at.z, seenAt: now };
    v.sites.push(site);
    v.sites = trimSites(v.sites);
  }
  Object.assign(site, Object.fromEntries(Object.entries(counts).filter(([, n]) => fin(n))));
  site.seenAt = now;
  return site;
}

/**
 * The bells the bridge's scans have seen (foreign.marks: on any walk this client session, the cows' fetches out past
 * the leash among them), each a village site: within VILLAGE_RANGE of home, not in or by the yard. Returns how many
 * sites are new.
 */
export function noteBells(world: WorldMemory, bells: readonly { x: number; y: number; z: number }[], now: number, home: { x: number; z: number }): number {
  const yard = world.yard;
  const out = (p: Pos) => !yard || Math.max(yard.x1 - p.x, 0, p.x - yard.x2, yard.z1 - p.z, p.z - yard.z2) > OUT_OF_YARD;
  let fresh = 0;
  for (const b of bells) {
    const p = { x: Math.floor(b.x), y: Math.floor(b.y), z: Math.floor(b.z) };
    if (!isPos(p) || horiz(p, home) > VILLAGE_RANGE || !out(p)) continue;
    const known = !!siteFor(peekVillages(world).sites, p);
    noteVillage(world, p, { bells: 1 }, now);
    if (!known) fresh++;
  }
  return fresh;
}

/**
 * A village already judged (any word) or found with no boat way home, within SAME_VILLAGE of `p` or with `p` inside its
 * area: the side search walks on past it, as it would past nothing (its own variant goes to it while it is open: a
 * known village is never found afresh). Read as the gates read the sites (folded: siteOpen's), so the two agree. Pure.
 */
export function knownVillage(world: WorldMemory, p: { x: number; z: number }): VillageSite | undefined {
  return peekVillages(world).sites.find(s => (s.judged || s.noBoat) && covers(s, p));
}

/** The site of a variant (`village x,z`), or undefined. */
export function siteOf(world: WorldMemory, variant: string): VillageSite | undefined {
  const m = /^village (-?\d+),(-?\d+)$/.exec(variant);
  if (!m) return undefined;
  return (world.villages?.sites ?? []).find(s => s.x === Number(m[1]) && s.z === Number(m[2]));
}
export const variantOf = (s: { x: number; z: number }) => `village ${s.x},${s.z}`;

/** A site the move may go to now: within range, not someone's, no recent failure of the boat's way, not waiting. Pure. */
export function siteOpen(site: VillageSite, home: { x: number; z: number }, now: number): boolean {
  if (horiz(site, home) > VILLAGE_RANGE) return false;
  if (site.judged?.kind === 'theirs') return false;
  if (site.judged?.kind === 'wait' && now - site.judged.at < WAIT_AGAIN) return false;
  return !(site.noBoat && now - site.noBoat.at < NO_BOAT_WAIT);
}

// ------------------------------------------------------------------------------------------------ the judge

/** A box on the ground (inclusive). */
export interface Area { x1: number; z1: number; x2: number; z2: number; y1: number; y2: number }

/** What a look round a village found, for the judge. */
export interface VillageLook {
  /** the bells, beds and job sites the scans saw round it (foreign.marks) */
  bells: Pos[];
  beds: Pos[];
  jobs: { name: string; at: Pos }[];
  /** the creatures seen round it (villagers, wandering traders, players...) */
  seen: Seen[];
  /** the villagers' ids found penned in (pennedIn) */
  penned: ReadonlySet<number>;
  /** the markers' kinds in the village's area and MARKERS_NEAR round it, and how much of it the scans have seen */
  kinds: Record<string, number>;
  looked: { chunks: number; of: number };
  /** others' builds as the bridge knows them (foreign.zones) */
  zones: readonly Zone[];
  /** the players remembered (and those in this look) */
  players: readonly { x: number; z: number; at: number }[];
  /** the world spawn (status.spawn) */
  spawn?: { x: number; z: number };
  /**
   * what the look could not read (the bridge's builds of others, the world spawn): the judge waits rather than take a
   * call that did not answer for "none there"
   */
  unread?: string[];
}

/** The judge's word on a village. */
export type Verdict =
  | { kind: 'free'; why: string; area: Area; own: Zone[]; candidates: Seen[]; villagers: number }
  | { kind: 'theirs'; why: string; area?: Area }
  | { kind: 'wait'; why: string; area?: Area }
  | { kind: 'none'; why: string };

/** The village's area (pure): the box round its bell, beds, job sites and villagers, grown by AREA_GROW. */
export function villageArea(look: Pick<VillageLook, 'bells' | 'beds' | 'jobs' | 'seen'>): Area | undefined {
  return boxRound([...look.bells, ...look.beds, ...look.jobs.map(j => j.at), ...look.seen.filter(e => e.name === 'villager' && isPos(e.position)).map(e => e.position!)]);
}

/** The box round some points, grown by AREA_GROW (pure), or undefined for none. */
function boxRound(ps: readonly Pos[]): Area | undefined {
  if (!ps.length) return undefined;
  const xs = ps.map(p => Math.floor(p.x)), zs = ps.map(p => Math.floor(p.z)), ys = ps.map(p => Math.floor(p.y));
  return {
    x1: Math.min(...xs) - AREA_GROW, z1: Math.min(...zs) - AREA_GROW, x2: Math.max(...xs) + AREA_GROW, z2: Math.max(...zs) + AREA_GROW,
    y1: Math.min(...ys) - AREA_GROW, y2: Math.max(...ys) + AREA_GROW
  };
}

const dist3 = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * The village's own marks (pure): its bells, and the beds and job sites chained to them, each within CHAIN of a bell or
 * of a mark already chained, and within VILLAGE_REACH of a bell. A village's houses stand a few blocks apart and its
 * outer ones still chain in; a player's house beside it, its bed and barrel farther than CHAIN from every one of the
 * village's own, does not (else its bed made it one of the village's houses, and the village free).
 */
export function coreMarks(look: Pick<VillageLook, 'bells' | 'beds' | 'jobs'>): Pos[] {
  const core: Pos[] = [...look.bells];
  let left = [...look.beds, ...look.jobs.map(j => j.at)].filter(m => look.bells.some(b => dist3(b, m) <= VILLAGE_REACH));
  for (let grew = true; grew;) {
    grew = false;
    const next: Pos[] = [];
    for (const m of left) {
      if (core.some(c => dist3(c, m) <= CHAIN)) { core.push(m); grew = true; } else next.push(m);
    }
    left = next;
  }
  return core;
}

/** How far a point is from an area, across the ground (0 inside). */
export const offArea = (a: Area, p: { x: number; z: number }) => Math.hypot(Math.max(0, a.x1 - p.x, p.x - a.x2), Math.max(0, a.z1 - p.z, p.z - a.z2));
/** How far a zone is from an area, across the ground (0 where they meet). */
const zoneOff = (a: Area, z: Zone) => Math.hypot(Math.max(0, a.x1 - z.x2, z.x1 - a.x2), Math.max(0, a.z1 - z.z2, z.z1 - a.z2));
const at = (p: { x: number; y?: number; z: number }) => `(${Math.floor(p.x)}, ${p.y === undefined ? '' : `${Math.floor(p.y)}, `}${Math.floor(p.z)})`;
const list = (k: Record<string, number>) => Object.entries(k).map(([n, c]) => `${n} x${c}`).join(', ');

/**
 * The courtesy judge (pure): someone's (`theirs`, left alone for good) for any of the plan's rules, in this order: near
 * the world spawn; a player seen within 64 of its area, ever; a player-only marker in it or within 16; a villager named,
 * riding something, on a lead, penned in, or above the first level (only a player's trades, or a player's cure, give
 * a villager the xp: a village makes every one at level 1, so one traded with is a village someone uses); another build
 * of others within ZONES_NEAR of it. Its own houses are the surface zones within OWN_NEAR of its bell or a bed or job
 * site chained to the bell (coreMarks): a build anyone else put up by it, a bed in it or not, is another build, and so
 * is an outbuilding of its own with none of those (a lone pen, a field): the courteous side. Then `wait` (looked at
 * again later): its bell not seen, a call that did not answer, not all of it seen by the scans yet, or fewer than
 * VILLAGE_MIN villagers in it (the box round its own marks, grown by AREA_GROW: one by a player's house beside it is
 * not the village's). `none`: no bell, bed, job site or villager seen there at all. Else `free`, with the villagers that
 * may be taken (unemployed adults in it, no nitwit, none by a job site block), and its own zones (the way home leaves
 * those out of its FROM_ZONES rule).
 */
export function judgeVillage(look: VillageLook): Verdict {
  const villagers = look.seen.filter(e => e.name === 'villager' && isPos(e.position));
  const area = villageArea(look);
  if (!area || (!look.bells.length && !look.beds.length && !look.jobs.length && !villagers.length)) return { kind: 'none', why: 'no bell, bed, job site or villager there' };
  const theirs = (why: string): Verdict => ({ kind: 'theirs', why, area });
  const wait = (why: string): Verdict => ({ kind: 'wait', why, area });
  if (look.spawn) {
    const d = offArea(area, look.spawn);
    if (d < SPAWN_CLEAR) return theirs(`within ${SPAWN_CLEAR} of the world spawn (${Math.round(d)} off)`);
  }
  const player = look.players.map(p => ({ p, d: offArea(area, p) })).filter(x => x.d < PLAYER_CLEAR).sort((a, b) => a.d - b.d)[0];
  if (player) return theirs(`a player was seen ${Math.round(player.d)} from it, at ${at(player.p)} (${clock(player.p.at)})`);
  const marks = Object.fromEntries(Object.entries(look.kinds).filter(([n, c]) => c > 0 && PLAYER_ONLY.test(n)));
  if (Object.keys(marks).length) return theirs(`what only a player puts down in it or within ${MARKERS_NEAR}: ${list(marks)}`);
  for (const e of villagers) {
    const who = `a villager ${at(e.position!)}`;
    if (e.named) return theirs(`${who} is named${e.customName ? ` (${e.customName})` : ''}`);
    if (e.vehicle) return theirs(`${who} rides a ${e.vehicle}`);
    if (e.leashed) return theirs(`${who} is on a lead`);
    if (look.penned.has(e.id)) return theirs(`${who} is penned in (it can walk to fewer than ${PENNED_ROOM} cells)`);
    if (fin(e.level) && e.level > 1) return theirs(`${who} is at level ${e.level}: a player trades here`);
  }
  // its own builds: those by its bell and the marks chained to it (without its bell seen, nothing tells them apart)
  const core = coreMarks(look);
  if (!look.bells.length) return wait('its bell not seen yet (every village has one at its meeting point)');
  const surface = look.zones.filter(z => z.surface ?? true);
  const own = surface.filter(z => core.some(m => zoneDistance(m, z) <= OWN_NEAR));
  const other = surface.filter(z => !own.includes(z)).map(z => ({ z, d: zoneOff(area, z) })).filter(x => x.d < ZONES_NEAR).sort((a, b) => a.d - b.d)[0];
  if (other) return theirs(`another build ${Math.round(other.d)} from it (x ${other.z.x1}..${other.z.x2}, z ${other.z.z1}..${other.z.z2}${other.z.sample ? `, ${other.z.sample}` : ''})`);
  if (look.unread?.length) return wait(`${look.unread.join(' and ')} not read`);
  if (look.looked.chunks < look.looked.of) return wait(`not all of it seen yet (${look.looked.chunks} of ${look.looked.of} chunks)`);
  const inner = boxRound(core)!;
  const ours = villagers.filter(e => offArea(inner, e.position!) === 0);
  if (ours.length < VILLAGE_MIN) return wait(`${ours.length} villager(s) seen${ours.length < villagers.length ? ` in it (${villagers.length - ours.length} more round it)` : ''}, ${VILLAGE_MIN} or more wanted`);
  const counts = { employed: 0, babies: 0, nitwits: 0, byJob: 0 };
  const candidates = ours.filter(e => {
    if (e.baby) { counts.babies++; return false; }
    if (e.profession === 'nitwit') { counts.nitwits++; return false; }
    if (e.profession !== 'none') { counts.employed++; return false; }
    if (byJobSite(e, look.jobs)) { counts.byJob++; return false; }
    return true;
  });
  const said = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k === 'byJob' ? 'by a job site' : k}`).join(', ');
  return {
    kind: 'free', area, own, candidates, villagers: ours.length,
    why: `${ours.length} villagers, ${candidates.length} unemployed adult(s) to take${said ? ` (${said})` : ''}`
  };
}

/** An unemployed villager this near a job site block may be taking the job (pure). */
export function byJobSite(e: Pick<Seen, 'position'>, jobs: readonly { at: Pos }[]): boolean {
  const p = e.position;
  return !!p && jobs.some(j => Math.abs(j.at.x + 0.5 - p.x) <= JOB_NEAR + 0.5 && Math.abs(j.at.z + 0.5 - p.z) <= JOB_NEAR + 0.5 && Math.abs(j.at.y - p.y) <= 2);
}

/**
 * Penned in (pure): from where a villager stands, the cells it could walk to (a step up or down at most; through doors,
 * which villagers open, but not a fence gate, which they cannot), within the box read round it: fewer than PENNED_ROOM is
 * a pen, a trading hall's cell, a cage. `block(x, y, z)`: the state there (null: not read, taken as a wall).
 */
export function pennedIn(block: (x: number, y: number, z: number) => string | null | undefined, feet: Pos, reach = 6, room = PENNED_ROOM): boolean {
  const id = (s: string | null | undefined) => (s ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
  const pass = (x: number, y: number, z: number) => {
    const s = block(x, y, z);
    if (s === null || s === undefined) return false;
    if (/_door$/.test(id(s))) return true;
    return cellOf(s).kind === 'open';
  };
  // something to stand on: not air (nor a fence or a wall: 1.5 high, no mob stands on top of one)
  const floor = (x: number, y: number, z: number) => {
    const s = block(x, y, z);
    if (s === null || s === undefined) return false;
    const c = cellOf(s);
    return c.kind === 'water' || (c.kind === 'solid' && c.top <= 1);
  };
  const stand = (x: number, y: number, z: number) => pass(x, y, z) && pass(x, y + 1, z) && floor(x, y - 1, z);
  const start = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) };
  const seen = new Set<string>([`${start.x},${start.y},${start.z}`]);
  const queue = [start];
  while (queue.length && seen.size < room) {
    const c = queue.shift()!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = c.x + dx, z = c.z + dz;
      if (Math.abs(x - start.x) > reach || Math.abs(z - start.z) > reach) continue;
      for (const dy of [0, 1, -1]) {
        const y = c.y + dy;
        // (a step up needs the room over its head where it stands too)
        if (dy === 1 && !pass(c.x, c.y + 2, c.z)) continue;
        if (!stand(x, y, z)) continue;
        const k = `${x},${y},${z}`;
        if (!seen.has(k)) { seen.add(k); queue.push({ x, y, z }); }
        break;
      }
    }
  }
  return seen.size < room;
}

// ------------------------------------------------------------------------------------------------ the status

/**
 * brain-status, `Villagers:`: the switch; the hall and the villagers in it (as last counted); the villages known, and
 * how each was judged; the last move.
 */
export function villagersLine(world: WorldMemory, now: number): string {
  const v = peekVillages(world);
  const hall = world.zones?.hall?.[0];
  const ago = (t: number) => { const m = Math.round((now - t) / MINUTE); return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const hallText = !hall ? 'no villager hall yet'
    : `the hall at (${hall.x}, ${hall.y}, ${hall.z}): ${v.hall ? `${v.hall.count} of ${HALL_WANTS} villagers (counted ${ago(v.hall.at)})` : `not counted yet (${HALL_WANTS} wanted)`}`;
  const kinds = v.sites.map(s => (s.noBoat && now - s.noBoat.at < NO_BOAT_WAIT ? 'no boat way' : s.judged?.kind ?? 'not judged'));
  const tally = [...new Set(kinds)].map(k => `${kinds.filter(x => x === k).length} ${k}`).join(', ');
  const theirs = v.sites.filter(s => s.judged?.kind === 'theirs').map(s => `(${s.x}, ${s.z}): ${s.judged!.why}`).slice(0, 2);
  const villages = v.sites.length ? `${v.sites.length} village(s) known (${tally})${theirs.length ? `; someone's: ${theirs.join('; ')}` : ''}` : 'no village known';
  // (the rails fallback's last dry run, from a village the boat found no way home from)
  const dry = v.sites.find(s => s.rails && typeof s.rails.text === 'string' && fin(s.rails.at) && now - s.rails.at < NO_BOAT_WAIT);
  const rails = dry ? `; rails from (${dry.x}, ${dry.z}) ${dry.rails!.ok ? `planned (a dry run, nothing laid): ${dry.rails!.text}` : `not planned: ${dry.rails!.text}`}` : '';
  const open = v.open?.length ? `; ${v.open.length} block(s) of the hall or the fence still open` : '';
  const boat = v.boat ? `; its boat left at ${at(v.boat.at)}` : '';
  const last = v.last ? `; last move ${clock(v.last.at)}: ${v.last.text}` : '';
  return `Villagers: moves ${movesOn(world) ? 'on' : 'off'}; ${hallText}; ${villages}${rails}${open}${boat}${last}`;
}
