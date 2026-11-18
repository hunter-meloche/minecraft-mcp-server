/**
 * The natural bastion remnant (P6 of the progression plan, part 3: stage 3 of the Nether trips, with the user's
 * decision of Nov 13: the bot raids a bastion itself for the netherite upgrade template). Its chests hold what the
 * netherite needs and no other way gives: the upgrade template (a bastion's treasure chest always has one, its other
 * chests now and then; netherite.ts copies the rest from it), and netherite, debris and gold blocks besides.
 *
 * Which bastion (bastionWay): only a natural one a scouting leg found (a `bastion` site with its leg: the bridge's
 * Foreign marks a zone `natural` by its palette alone, nothing only a player puts there within 8 of it), by the way that
 * leg walked, and none refused before: as the fortress (netherfortress.ts, the pattern), the trip refuses one for good
 * where the bridge says something only a player puts there stands within 16 of it (its zone's `strays`) or a player is
 * seen within 64 of it, or where it has joined someone's build. Courtesy in it: nothing taken within 16 of a block only
 * a player puts down there (cobblestone), and a chest only where the bastion itself put it (bastionChest: a single one
 * among the bastion's own blocks); every walk 16 from every other zone. Nothing of the bastion is ever dug: its gold
 * blocks and gilded blackstone anger every piglin within 16, so the gold blocks come out of its chests only.
 *
 * The strict rules (the fortress's, P3c, with the bastion's own): it sets out only at full health and food (20 and 20,
 * after the kit's meals and the healing), the fire gear worn (D1: netherset.ts fireGear, 20 EPF against fire), a
 * shield, and FIRE_POTIONS potions of fire resistance and a potion of strength carried (P4's brewing: by their
 * contents). At the bastion's edge it drinks both before it goes in (fire resistance: a bastion is built over lava;
 * strength: the piglins' fight), and goes in only with both on it: not with two piglin brutes together (within 16 of
 * each other) or a hoglin seen by the ground it would go into (bastionGuard: the rules below would send it home from in
 * there), nor with too little time
 * left for it, and then nothing is drunk. Down there it leaves at once, from wherever it is
 * (bastionStop, looked at between every leg, every chest and every bout of a fight, and walking back the way it came):
 * under BASTION_LEAVE health (the plan's 14), the wither on it, any hold (the switch off, a death hold, the bastion trips
 * off), at its time, a second piglin brute (two near, or one more after the one it killed), a brute on it within
 * FIGHT_RANGE before the potions are drunk, a hoglin near (they charge in herds: avoided by leaving), more than BASTION_CROWD foes on it (the
 * piglins turned and the brute), a zombified piglin turned (its whole pack comes), the ghast rule b (a ghast within 16
 * that sees it, one that fired at it), a hit with no foe about (a hit while a turned piglin or the brute is, is the
 * fight's: the health rule bounds it), on fire with no fire resistance on it, and once the potions run short: the fire
 * resistance no longer outlasting the way back, or the strength gone.
 *
 * The brute (the user's choice of Nov 18, "fight one brute": 26.3's bastion pieces put a brute by their chests about 6
 * times in 7, and it never despawns, so "a brute: leave" meant no template ever): one brute a trip is fought from the
 * shield, the potions on it, as the turned piglins are (in bouts, careful: the chase breaks nothing and goes off no ledge
 * and over no lava). A brute is hostile at sight, golden helmet or not: the bot does not walk at it. One in sight within
 * BRUTE_NEAR is coming, and the bot stands and lets it come (a walk stops for it; BRUTE_WAITS looks at most), so it is
 * met where the bot stands, not among the piglins of its room; it is fought before any chest is opened.
 *
 * Piglins turn on a player who opens a chest by them or breaks gold, golden helmet or not (26.3 PiglinAi
 * angerNearbyPiglins): a chest is opened only with BASTION_CROWD adult piglins within 16 of the bot at most (they may all
 * turn), and those that turn are fought from the shield in bouts (the bridge's fight: the shield up between swings, the
 * axe where a neutral mob is by: no sweep that would turn the rest), a look between the bouts. At most
 * BASTION_CHESTS_TRIP chests a trip; the treasure room's (gold blocks by it) first.
 *
 * A death on a bastion trip turns the bastion trips off for good until the lead switches them back (nether.ts
 * netherTick, the nether-trips tool's `bastion`), on top of the death ladder that holds every trip.
 *
 * What it is for (bastionWant): the netherite's template while the home has none (netherite.ts netheriteNeed); with one
 * at home the copies make the rest, and the bastion is not gone to again. Says `nether: bastion at nether (x, y, z): 1
 * netherite_upgrade_smithing_template, 2 gold_block (3 foes killed)`.
 *
 * Coordinates are `nether (x, y, z)` and `overworld (x, y, z)` in the lines, as nether.ts says them. Nothing here is
 * used at the module's top level (worktasks.ts reaches it, and this module reaches most of the brain).
 */
import { NETHERITE_INGOT, NETHERITE_TEMPLATE, brainRun, type InventoryItem, type Status } from '../tools.js';
import { no, type Decline, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { WorkResult } from './work.js';
import { homePortal, tripsOn } from './portal.js';
import { key, storedStacks, takeSlot } from './chests.js';
import {
  FIRE_POTIONS, FORTRESS_KEPT, NETHER, OWN_HEALTH_FLOOR, barterHold, deathHold, firePotions, isFirePotion, netherOf, ownHealth, peekNether, stageNeeds,
  type Bearing, type FortressMemory
} from './nether.js';
import {
  BACK_MS, FAR_STEP_MS, FAR_TURN_MS, GHAST_WATCH, KNOCK_GAP, NEAR, backThroughOwn, firedAt, ghastAbout, ghastSees, ghastWatched, lavaBy, lootWords, overDrop, toOwnPortal,
  type Seen
} from './netherbarter.js';
import { fireOf, potionSeconds, potionToDrink } from './netherdebris.js';
import { FIGHT_BOUT, FIRE_SPARE_MS, FIRE_WORK_MS } from './netherfortress.js';
import { dressedFireGear, fireGear } from './netherset.js';
import { netheriteNeed } from './netherite.js';
import {
  EYE, FROM_BUILDS, GONE, SETUP_HEALTH, SETUP_WAITS, blockAt, boxGap, boxOf, cellOf, clearTo, fetchSetupKit, footing, inNether, pathOf, placedIn, readGround,
  setupShort, walkAlong, walkFrom, zoneBox, type Box, type Grid, type NetherZone
} from './nethersetup.js';

const MINUTE = 60_000;

const fmt = (p: { x: number; y: number; z: number }) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
const pause = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const cellKey = (p: Pos) => `${p.x},${p.y},${p.z}`;
const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;
const add = (p: Pos, dx: number, dy: number, dz: number): Pos => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
const floorOf = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });
const dist3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const nearestIn = (b: Box, p: Pos): Pos => ({ x: Math.max(b.x1, Math.min(b.x2, p.x)), y: Math.max(b.y1, Math.min(b.y2, p.y)), z: Math.max(b.z1, Math.min(b.z2, p.z)) });
/** A zone as the bridge's foreign.zones has it: a natural one's `strays` (none from a jar before P3c). */
type BastionZone = NetherZone & { strays?: string[] };

// ------------------------------------------------------------------------------------------------ the rules

/** It sets out at this health and food, and no lower (the strict rules: full). */
export const BASTION_HEALTH = 20;
export const BASTION_FOOD = 20;
/** Under this health it leaves at once (the plan's "leave at health below 14"). */
export const BASTION_LEAVE = 14;
/** Potions of strength it carries and drinks at the bastion's edge (P4 keeps long strength 3 in stock). */
export const STRENGTH_POTIONS = 1;
/** Natural chests opened a trip at most (the plan's "at most a few chests a trip"). */
export const BASTION_CHESTS_TRIP = 3;
/**
 * Piglins it takes on at once: more than this turned on it within ANGRY_NEAR and it leaves (the plan's "retreat when
 * more than N come"), and a chest is opened only with no more than this many adult piglins within ANGRY_NEAR of it:
 * every one of them that sees the opening turns.
 */
export const BASTION_CROWD = 3;
/** How near a turned piglin counts against BASTION_CROWD, and how near an adult piglin counts before a chest is opened (the game's anger reaches 16). */
export const ANGRY_NEAR = 16;
/**
 * A piglin brute this near (26.3's brute: 50 health, an axe that knocks the shield down, never calmed by gold): two of
 * them and it leaves; one is the fight (before the potions, one on it within FIGHT_RANGE sends it home). And this near
 * the ground it would go into, at the bastion's edge, two this near each other (they could be on it together) and it
 * does not go in.
 */
export const BRUTE_NEAR = 16;
/** Brutes it fights a trip (the user's choice: one). Another seen after it, and it leaves. */
export const BRUTES_TRIP = 1;
/** Looks it stands for a brute in sight that comes (within BRUTE_NEAR, past FIGHT_RANGE), at most, each after `bruteMs`: then it goes on, and meets it where it comes within FIGHT_RANGE. */
export const BRUTE_WAITS = 4;
export const BASTION_WAITS = { bruteMs: 1_000 };
/** A hoglin (or zoglin) this near: it leaves (they charge, in herds, and knock the bot about by the lava). */
export const HOGLIN_NEAR = 16;
/** A piglin turned on it this near and in sight is fought (one with a crossbow shoots from about 8). */
export const FIGHT_RANGE = 12;
/** Fights at one foe that killed nothing, at most: then it is let be (the shield and the Guardian still have it). */
const FOE_TRIES = 2;
/** The bastion trip's whole time, from the kit at home to back through its own portal, and what it still needs after the kit (the nether rung's run stops at 12 min). */
export const BASTION_MAX_MS = 9 * MINUTE;
export const BASTION_LEAST_MS = 4 * MINUTE;
/** The bastion's own ground it reads and goes into, round the point of it nearest the way's last waypoint, across and up and down. */
export const BASTION_REACH = 24;
const READ_DY = 12;
/** The way's last waypoint is this near the bastion at most (the bridge's scan reaches 48 round the bot: the leg passed it within that). */
export const BASTION_APPROACH = 48;
/** A player seen within this of the bastion: it is someone's to share, and refused for good (the fortress's 64). */
export const PLAYER_NEAR = 64;
/** Nothing taken within this of a block only a player puts down there (the read's cobblestone). */
export const PLACED_CLEAR = 16;
/** Steps a walk leg (a look between every two), and the walks planned again on a known way at most. */
const STEP = 4;
const WAY_REPLANS = 4;
/** The ground read a stretch of a known way at a time: this many waypoints ahead, and round them. */
const WAY_AHEAD = 4;
const STRETCH = { across: 8, down: 12, up: 12 } as const;
/** A piglin's eyes over its feet (26.3's EntityType.PIGLIN: 0.6 x 1.95, eyes at 1.79). */
const PIGLIN_EYE = 1.79;
/** The free pocket slots the chests' loot stops at: the rest of a chest waits for another trip. */
const LOOT_ROOM = 1;

/**
 * What it takes out of a bastion chest, in this order: what the netherite needs (the template, its ingots, scrap and
 * debris, the gold for the ingots), and the diamonds and gold blocks. The rest (arrows, string, chains, blackstone,
 * the gold gear) is left: the pockets carry the Nether kit.
 */
export const BASTION_LOOT: readonly string[] = [NETHERITE_TEMPLATE, NETHERITE_INGOT, 'netherite_scrap', 'ancient_debris', 'gold_block', 'gold_ingot', 'diamond'];

/**
 * The bastion's own blocks (26.3's bastion templates and their processors: the blackstone family, basalt, the gold
 * blocks of the treasure room, magma and lava, the chains and lanterns that hang in it, the treasure room's quartz) and
 * the Nether's own ground it stands in.
 */
const BASTION_BLOCKS = new RegExp('^(blackstone|gilded_blackstone|polished_blackstone|polished_blackstone_bricks|cracked_polished_blackstone_bricks|' +
  'chiseled_polished_blackstone|polished_blackstone_(stairs|slab|wall)|polished_blackstone_brick_(stairs|slab|wall)|blackstone_(stairs|slab|wall)|' +
  'basalt|polished_basalt|smooth_basalt|magma_block|gold_block|nether_gold_ore|crying_obsidian|iron_chain|chain|lantern|soul_lantern|quartz_block|' +
  'smooth_quartz|smooth_quartz_slab|netherrack|soul_sand|soul_soil|crimson_nylium|warped_nylium|nether_wart_block|warped_wart_block|gravel)$');
const OPEN_OR_HOT = /^(air|cave_air|lava|fire|soul_fire)$/;

const SIDES: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** The other half of a double chest, pure: the one chest beside it on its level, a side away; undefined with none, null with more than one (a row of three is no bastion's). */
export function chestHalf(g: Grid, p: Pos): Pos | undefined | null {
  const by = SIDES.map(([dx, dz]) => add(p, dx, 0, dz)).filter(q => blockAt(g, q) === 'chest');
  return by.length > 1 ? null : by[0];
}

/**
 * A chest the bastion itself put there, pure: a single chest, or the two halves of a double one side by side (26.3's
 * bastion templates hold 10 such halves of their 37 chests, in their ramparts and walls, with chests/bastion_other in
 * them: the template now and then), each standing on one of the bastion's own blocks, with nothing but the bastion's
 * own blocks, air and lava round them (besides each other), a block every way. A chest with a torch, a sign or a
 * crafting table by it, a third chest by a pair, or one a corner away, is someone's.
 */
export function bastionChest(g: Grid, p: Pos): boolean {
  if (blockAt(g, p) !== 'chest') return false;
  const half = chestHalf(g, p);
  if (half === null) return false;
  const halves = half ? [p, half] : [p];
  for (const h of halves) {
    if (!BASTION_BLOCKS.test(blockAt(g, add(h, 0, -1, 0)) ?? '')) return false;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const q = add(h, dx, dy, dz);
      if (halves.some(o => same(o, q))) continue;
      const b = blockAt(g, q);
      if (b === null || !(OPEN_OR_HOT.test(b) || BASTION_BLOCKS.test(b))) return false;
    }
  }
  return true;
}

/** The treasure room's chest, pure: a gold block within 3 of it (the room's walls and its pile are gold). */
export function treasureChest(g: Grid, p: Pos): boolean {
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) if (blockAt(g, add(p, dx, dy, dz)) === 'gold_block') return true;
  return false;
}

/** A drinkable potion of strength, by its contents (never by its name: every potion is `potion`). */
export const isStrengthPotion = (i: { name: string; potion?: string }) => i.name === 'potion' && /(^|_)strength$/.test(i.potion ?? '');
/** What a potion of strength gives, s (by its contents: a long one 8:00, the plain 3:00, a strong one 1:30). */
export const STRENGTH_S: Readonly<Record<string, number>> = { strength: 180, long_strength: 480, strong_strength: 90 };
const strengthSeconds = (i: { potion?: string }) => STRENGTH_S[i.potion ?? ''] ?? STRENGTH_S.strength;
/** The carried potion of strength it drinks, pure: the longest (by its contents), then the lowest slot. Undefined with none. */
export function strengthToDrink(items: InventoryItem[]): InventoryItem | undefined {
  return items.filter(i => i.slot >= 0 && i.slot < 36 && isStrengthPotion(i)).sort((a, b) => strengthSeconds(b) - strengthSeconds(a) || a.slot - b.slot)[0];
}
/** Potions of strength at home: carried (the pockets and the off hand) and in the chests by their stacks as last seen. */
export function strengthPotions(items: InventoryItem[], world: WorldMemory): number {
  return items.filter(i => i.slot >= 0 && (i.slot < 36 || i.slot === 40) && isStrengthPotion(i)).reduce((a, i) => a + i.count, 0) +
    storedStacks(world, isStrengthPotion).reduce((a, f) => a + f.stack.count, 0);
}

const effectOf = (effects: Status['effects'] | undefined, name: string) => (effects ?? []).find(e => e.name.replace(/^minecraft:/, '') === name);
const HOGLINS = /^(hoglin|zoglin)$/;

/**
 * Why the bot must leave the bastion now, or null, pure (the strict rules, see the top of the file): under
 * BASTION_LEAVE health; the wither on it; a hold (the switch off, a death hold, the bastion trips off); more brutes than
 * BRUTES_TRIP (those near, and `brutesKilled` this trip); a brute on it within FIGHT_RANGE before the potions are
 * drunk; a hoglin near; a
 * zombified piglin turned; more than BASTION_CROWD foes on it (the piglins turned and the brute); the ghast rule b (a
 * fireball coming at it, a ghast within 16 that sees it); a hit with no foe about (a turned piglin or the brute: the
 * fight's); on fire with no fire resistance on it and no foe about. Once the potions are drunk (`drunk`: the fire
 * resistance the way back needs, s): the fire resistance short of that, or the strength gone.
 */
export function bastionStop(look: { health: number; was: number; effects?: Status['effects']; onFire?: boolean; ents: Seen[]; eyes?: { g: Grid; me: Pos }; drunk?: { fireNeedS: number };
  brutesKilled?: number; }, world: WorldMemory, now: number): { why: string } | null {
  if (look.health < BASTION_LEAVE) return { why: `health ${Math.round(look.health)}, under ${BASTION_LEAVE}` };
  if (effectOf(look.effects, 'wither')) return { why: 'the wither on it' };
  if (!tripsOn(world)) return { why: 'nether trips are off' };
  const held = deathHold({ now }, world);
  if (held) return { why: held.text };
  const off = peekNether(world).bastion?.off;
  if (off) return { why: `bastion trips off: ${off.why}` };
  const near = (re: RegExp, d: number, also: (e: Seen) => boolean = () => true) =>
    look.ents.filter(e => re.test(e.name) && e.distance <= d && also(e)).sort((a, b) => a.distance - b.distance);
  // (one brute a trip, the user's choice: two together hit through any shield, and the one killed leaves the potions
  // and the health short for another)
  const brutes = near(/^piglin_brute$/, BRUTE_NEAR);
  const killed = look.brutesKilled ?? 0;
  if (brutes.length && brutes.length + killed > BRUTES_TRIP) {
    const d = Math.round(brutes[0].distance);
    return { why: brutes.length > 1 ? `${brutes.length} piglin brutes near (the nearest ${d} off): it fights one` : `a second piglin brute near (${d} off), one killed: it fights one a trip` };
  }
  // (before the potions: no strength for its 50 health, and one on it while a potion goes down hits a bot that cannot
  // shield. Only one on it and that near: a calm one, or one further off, is the fight once they are drunk. Any brute
  // within 16 here, through the walls, turned every trip back at the way's end, the back-off doubling, so never a raid)
  const on = brutes.find(e => e.aggressive && e.distance <= FIGHT_RANGE);
  if (on && !look.drunk) return { why: `a piglin brute on it (${Math.round(on.distance)} off), the potions not drunk` };
  const hoglin = near(HOGLINS, HOGLIN_NEAR)[0];
  if (hoglin) return { why: `a ${hoglin.name} near (${Math.round(hoglin.distance)} off)` };
  const pack = near(/^zombified_piglin$/, ANGRY_NEAR, e => !!e.aggressive)[0];
  if (pack) return { why: `a zombified_piglin turned aggressive at nether ${fmt(pack.position)} (its pack comes)` };
  const mad = near(/^piglin$/, ANGRY_NEAR, e => !!e.aggressive);
  // (the brute is one of the crowd: it fights all of them from the one shield)
  const foes = mad.length + brutes.length;
  if (foes > BASTION_CROWD) {
    return { why: brutes.length ? `${mad.length} piglins turned on it and a piglin brute (${foes}, more than ${BASTION_CROWD})` : `${mad.length} piglins turned on it (more than ${BASTION_CROWD})` };
  }
  const fired = near(/^fireball$/, GHAST_WATCH, e => !look.eyes || firedAt(e, look.eyes.me))[0];
  if (fired) return { why: `a ghast's fireball coming at it (${Math.round(fired.distance)} off)` };
  const ghast = near(/^ghast$/, NEAR.ghast, e => !look.eyes || ghastSees(look.eyes.g, e.position, look.eyes.me))[0];
  if (ghast) return { why: `a ghast in sight (${Math.round(ghast.distance)} off)` };
  const fight = foes > 0;
  if (look.health < look.was - 0.5 && !fight) return { why: `a hit taken (health ${Math.round(look.was)} -> ${Math.round(look.health)})` };
  const fire = effectOf(look.effects, 'fire_resistance');
  if (look.onFire && !fire && !fight) return { why: 'on fire, with no fire resistance on it' };
  if (look.drunk) {
    const left = !fire ? 0 : fire.seconds < 0 ? Infinity : fire.seconds;
    if (left <= look.drunk.fireNeedS) return { why: 'the fire resistance drunk now lasts only the way back' };
    if (!effectOf(look.effects, 'strength')) return { why: 'the strength drunk has worn off' };
  }
  return null;
}

/**
 * More piglin brutes than BRUTES_TRIP together (each within BRUTE_NEAR of another), or a hoglin (a zoglin), within its
 * stop's reach (BRUTE_NEAR, HOGLIN_NEAR) of the ground the bot would go into, pure: what it says, or null. Asked at the
 * bastion's edge before a potion is drunk: bastionStop would end the trip at them in there. One brute is the fight
 * (brutes never despawn, and 26.3's pieces put one by their chests 6 times in 7: leaving at one meant no template), and
 * so are two in rooms apart, one a trip: the read box is 48 across, so two anywhere in it kept most trips out.
 */
export function bastionGuard(ents: Seen[], into: Box): string | null {
  const by = (re: RegExp, d: number) => ents.filter(x => re.test(x.name) && boxGap(into, cellBox(floorOf(x.position))) <= d).sort((a, b) => a.distance - b.distance);
  const near = by(/^piglin_brute$/, BRUTE_NEAR);
  const brutes = near.filter((a, i) => near.some((b, j) => j !== i && dist3(a.position, b.position) <= BRUTE_NEAR));
  if (brutes.length > BRUTES_TRIP) return `${brutes.length} piglin brutes together by the bastion, the nearest at nether ${fmt(brutes[0].position)} (it fights one)`;
  const e = by(HOGLINS, HOGLIN_NEAR)[0];
  if (e) return `a ${e.name} by the bastion at nether ${fmt(e.position)}`;
  return null;
}

// ------------------------------------------------------------------------------------------------ which bastion

/** A bastion by a scouting leg's way: the leg's bearing and way, the waypoint it walks out to (its index), the site, the way's blocks to it. */
export interface BastionWay { bearing: Bearing; way: Pos[]; to: number; site: Pos; blocks: number }

/** A bastion refused for good, by its extent (the box of its zone as the trip saw it, else its site) and REFUSED_NEAR round that (the fortress's rule: a later leg logs the same bastion by another middle). */
const REFUSED_NEAR = 16;
type Refused = NonNullable<FortressMemory['refused']>[number];
const refusedBox = (r: Refused): Box => r.box ?? cellBox(r);
const refusedBy = (list: readonly Refused[], b: Box) => list.find(r => boxGap(refusedBox(r), b) <= REFUSED_NEAR);

/**
 * The bastion a trip goes to by a known way, pure, or undefined: of the `bastion` sites a scouting leg found (natural:
 * the scouting notes only a zone Foreign marks so), none refused, the ones whose leg's way as kept now has a waypoint
 * within BASTION_APPROACH of the site; each by that waypoint nearest it; the one of the shortest way there.
 */
export function bastionWay(world: WorldMemory): BastionWay | undefined {
  const n = peekNether(world);
  let best: BastionWay | undefined;
  for (const s of n.sites) {
    if (s.kind !== 'bastion' || !s.leg) continue;
    const site = { x: s.x, y: s.y, z: s.z };
    if (refusedBy(n.bastion?.refused ?? [], cellBox(site))) continue;
    const leg = (n.legs ?? []).find(l => l.bearing === s.leg);
    if (!leg || leg.way.length < 2) continue;
    let to = -1, gap = Infinity;
    for (let i = 1; i < leg.way.length; i++) {
      const d = dist3(leg.way[i], site);
      if (d < gap) { gap = d; to = i; }
    }
    if (to < 0 || gap > BASTION_APPROACH) continue;
    let blocks = 0;
    for (let i = 1; i <= to; i++) blocks += dist3(leg.way[i - 1], leg.way[i]);
    blocks = Math.round(blocks);
    if (!best || blocks < best.blocks) best = { bearing: leg.bearing, way: leg.way.map(p => ({ ...p })), to, site, blocks };
  }
  return best;
}

/** A bastion refused for good, with why and the box of its zone where the trip saw it: never chosen again, by any site within REFUSED_NEAR of it. */
export function refuseBastion(world: WorldMemory, site: Pos, why: string, now: number, box?: Box): void {
  const b = (netherOf(world).bastion ??= {});
  const bx = box && { x1: box.x1, y1: box.y1, z1: box.z1, x2: box.x2, y2: box.y2, z2: box.z2 };
  b.refused = [...(b.refused ?? []).filter(r => dist3(r, site) > 8), { ...site, why: why.slice(0, 160), at: now, ...(bx ? { box: bx } : {}) }].slice(-FORTRESS_KEPT);
}

// ------------------------------------------------------------------------------------------------ the gate

/** What the bastion is wanted for now, pure: the netherite's template while the home has none and a piece is still to smith (netherite.ts netheriteNeed); else why not. */
export function bastionWant(s: Pick<Snapshot, 'items'>, world: WorldMemory): string | null {
  const need = netheriteNeed(s.items, world);
  if (!need.pieces.length) return 'bastion: every armour piece is netherite';
  if (!need.templates) return `bastion: a ${NETHERITE_TEMPLATE} at home (the copies make the rest)`;
  return null;
}

/** The bastion is open from its stage (3: nether.ts NETHER_STAGES, FIRE_POTIONS in stock: its ready asks), its own portal standing and the two sides linked. */
export function bastionOpen(world: WorldMemory): boolean {
  const n = peekNether(world);
  return n.linked === true && !!n.portal && n.stage >= (stageNeeds('bastion')?.stage ?? Infinity);
}

/**
 * Whether the bastion trip can set out now, pure: not switched off after a death on one (the lead switches them back);
 * not held (a piglin turned on the bot by its portal today: the barter's hold, the way out starts by the same hut); the
 * template wanted (bastionWant); a natural bastion known by a scouted way (bastionWay); the fire gear as it will be
 * dressed for the Nether (netherset.ts dressedFireGear); the potions in stock (carried or in the chests, by their
 * contents): the stage's FIRE_POTIONS of fire resistance and STRENGTH_POTIONS of strength; not hurt past what the run
 * heals at home; nothing of the Nether kit short that the chests lack (the setup's own list: the shield among it).
 */
export function bastionReady(s: Snapshot, world: WorldMemory): Decline | null {
  const off = peekNether(world).bastion?.off;
  if (off) return { cause: 'hold', text: `bastion trips off: ${off.why} (until the lead switches them back)` };
  const held = barterHold(world, s.now);
  if (held) return { cause: 'hold', text: `bastion held for the day: ${held.why}` };
  const want = bastionWant(s, world);
  if (want) return { cause: 'unneeded', text: want };
  if (!bastionWay(world)) return { cause: 'unneeded', text: 'bastion: no natural bastion known by a scouted way' };
  const gear = dressedFireGear(s.items, world);
  if (!gear.ok) return { cause: 'kit', text: `bastion: the fire gear is short: ${gear.missing.join('; ')} (the bastion goes only in it)` };
  const fire = firePotions(s.items, world), needFire = stageNeeds('bastion')?.potions ?? FIRE_POTIONS;
  if (fire < needFire) return { cause: 'kit', text: `bastion: ${fire} of the ${needFire} potions of fire resistance it takes in stock (carried or in the chests)` };
  const strength = strengthPotions(s.items, world);
  if (strength < STRENGTH_POTIONS) return { cause: 'kit', text: `bastion: no potion of strength in stock (carried or in the chests): it drinks one before the piglins' fight` };
  if (s.health < SETUP_HEALTH) return no.health(s, 'the bastion', SETUP_HEALTH, 10);
  const short = setupShort(s, world);
  if (short.length) return { cause: 'kit', text: `bastion: short of ${short.join(', ')} (carried or in the chests)` };
  return null;
}

// ------------------------------------------------------------------------------------------------ the trip

type Inv = { items: InventoryItem[] };
const inventory = async (ctx: GoalContext): Promise<InventoryItem[]> => (await ctx.call<Inv>('inventory').catch((): Inv => ({ items: [] }))).items ?? [];
const freeSlots = (items: InventoryItem[]) => 36 - new Set(items.filter(i => i.slot >= 0 && i.slot < 36).map(i => i.slot)).size;
const carriedOf = (items: InventoryItem[], is: (i: InventoryItem) => boolean) => items.filter(i => i.slot >= 0 && i.slot < 36 && is(i)).reduce((a, i) => a + i.count, 0);
/** What is carried, by kind (the pockets and the off hand: what a trip brought is told by it). */
const tally = (items: InventoryItem[]) => {
  const m = new Map<string, number>();
  for (const i of items) if (i.slot >= 0 && (i.slot < 36 || i.slot === 40)) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
  return m;
};

/**
 * The bastion's own kit, after the Nether kit (fetchSetupKit made its room and brings one potion of fire resistance
 * where the home has one): the potions of fire resistance up to FIRE_POTIONS carried and of strength up to
 * STRENGTH_POTIONS, each by its slot in the chest (takeSlot: by its contents, never by its name), the long ones first.
 * Undefined when it carries both, else what it is short of.
 */
export async function fetchBastionKit(ctx: GoalContext): Promise<string | undefined> {
  for (const [is, want, secs] of [[isFirePotion, FIRE_POTIONS, potionSeconds], [isStrengthPotion, STRENGTH_POTIONS, strengthSeconds]] as const) {
    let have = carriedOf(await inventory(ctx), is);
    // (the chests' memory looked at afresh before each take: a take opens its chest and remembers it anew)
    const tried = new Set<string>();
    for (let i = 0; i < 2 * want && have < want && !ctx.signal.aborted; i++) {
      const f = storedStacks(ctx.world, is).filter(x => !tried.has(`${key(x.chest)} ${x.stack.slot}`)).sort((a, b) => secs(b.stack) - secs(a.stack))[0];
      if (!f) break;
      tried.add(`${key(f.chest)} ${f.stack.slot}`);
      have += await takeSlot(ctx, f.chest, f.stack.slot, Math.min(f.stack.count, want - have)).catch(() => 0);
    }
  }
  if (ctx.signal.aborted) throw new Error('aborted');
  const items = await inventory(ctx);
  const fire = carriedOf(items, isFirePotion), strength = carriedOf(items, isStrengthPotion);
  if (fire < FIRE_POTIONS) return `${fire} of the ${FIRE_POTIONS} potions of fire resistance came out of the chests`;
  if (strength < STRENGTH_POTIONS) return 'no potion of strength came out of the chests';
  return undefined;
}

/** A box to read round the point of the bastion's zone nearest the way's last waypoint, and the waypoint. */
const readBoxFor = (zone: Box, wp: Pos): Box => {
  const c = nearestIn(zone, wp);
  const b = { x1: c.x - BASTION_REACH, y1: c.y - READ_DY, z1: c.z - BASTION_REACH, x2: c.x + BASTION_REACH, y2: c.y + READ_DY, z2: c.z + BASTION_REACH };
  return {
    x1: Math.min(b.x1, wp.x - 4), y1: Math.max(1, Math.min(b.y1, wp.y - READ_DY)), z1: Math.min(b.z1, wp.z - 4),
    x2: Math.max(b.x2, wp.x + 4), y2: Math.min(126, Math.max(b.y2, wp.y + READ_DY)), z2: Math.max(b.z2, wp.z + 4)
  };
};
/** The ground to read for a stretch of a known way. */
const stretchBox = (cells: Pos[]): Box => {
  const b = boxOf(cells);
  return {
    x1: b.x1 - STRETCH.across, y1: Math.max(1, b.y1 - STRETCH.down - 3), z1: b.z1 - STRETCH.across,
    x2: b.x2 + STRETCH.across, y2: Math.min(126, b.y2 + STRETCH.up), z2: b.z2 + STRETCH.across
  };
};
/** What stops sight: a block with a collision box. */
const seesThrough = (g: Grid) => (p: Pos) => { const c = cellOf(blockAt(g, p)); return c === 'open' || c === 'plant' || c === 'hot' || c === 'portal' || c === 'unknown'; };

/**
 * The bastion trip (see the top of the file). From home with the Nether kit, the fire gear on and the potions carried,
 * at full health and food (or it does not set out: untried), through the home portal into its own hut, out along the
 * scouting leg's way to its waypoint by the bastion; the potions drunk there; into the bastion's ground, its chests
 * looted by its rules and the piglins that turn fought; back along the way it walked and through its own portal. Gain:
 * the things it brought back. Out of the Nether halfway (a death), it stops at once (netherTick books the death on the
 * trip: world.nether.bastion.trip).
 */
export async function bastionRun(ctx: GoalContext, budgetMs: number, now: () => number): Promise<WorkResult> {
  const began = now();
  const left = () => Math.min(budgetMs, BASTION_MAX_MS) - (now() - began);
  const world = ctx.world;
  const home = homePortal(world);
  const own = peekNether(world).portal;
  if (!home) return { gain: 0, text: 'no home portal lit', untried: true };
  if (!own) return { gain: 0, text: 'no portal of its own down there to go out from', untried: true };
  const bw = bastionWay(world);
  if (!bw) return { gain: 0, text: 'no natural bastion known by a scouted way', untried: true };
  const lacking = await fetchSetupKit(ctx);
  if (lacking) return { gain: 0, text: `not setting out: ${lacking}`, untried: true };
  const potions = await fetchBastionKit(ctx);
  if (potions) return { gain: 0, text: `not setting out for the bastion: ${potions}`, untried: true };
  // the strict rules at home: full health and food, the fire gear worn, a shield, the potions carried (the kit's meals and healing came first)
  const st0 = await ctx.status().catch(() => undefined);
  const kit = await inventory(ctx);
  const why = [
    ...((st0?.health ?? 0) < BASTION_HEALTH ? [`health ${Math.round(st0?.health ?? 0)} < ${BASTION_HEALTH}`] : []),
    ...((st0?.food ?? 0) < BASTION_FOOD ? [`food ${st0?.food ?? 0} < ${BASTION_FOOD}`] : []),
    ...fireGear(kit).missing,
    ...(kit.some(i => i.name === 'shield') ? [] : ['no shield'])
  ];
  if (why.length) return { gain: 0, text: `not setting out for the bastion: ${why.join('; ')}`, untried: true };
  if (left() < BASTION_LEAST_MS) {
    return { gain: 0, text: `not setting out: the kit took ${Math.round((now() - began) / 1000)} s, too little of the bastion trip's ${BASTION_MAX_MS / MINUTE} min is left`, untried: true };
  }
  // the trip under way, for netherTick: a death from here to its end is a death there
  const b = (netherOf(world).bastion ??= {});
  b.trip = { from: now() };
  // (its own health rule bounds the run, as the fortress's: leave nether's 12 waits down to the Guardian's 6, so a bout
  // that takes it from 15 to 11 is not cut short mid-fight and the run walks back the way it came)
  ownHealth.floor = OWN_HEALTH_FLOOR;
  try {
    return await tripThere(ctx, bw, home, own, left, now, tally(kit));
  } finally {
    ownHealth.floor = undefined;
    // (its end only where it stands out of the Nether, as the fortress's: cut short down there, the walk home after is
    // the trip's still, and netherTick ends it at the first look home; the look outside the brain's run (brainRun.exit))
    const t = netherOf(world).bastion?.trip;
    if (t && t.to === undefined) {
      const st = await brainRun.exit(() => ctx.status()).catch(() => undefined);
      if (st && st.dimension !== NETHER) t.to = now();
    }
  }
}

async function tripThere(ctx: GoalContext, bw: BastionWay, home: Pos, own: Pos, left: () => number, now: () => number, before: Map<string, number>): Promise<WorkResult> {
  const world = ctx.world;
  const site = bw.site;
  const to = await toOwnPortal(ctx, home, own, now, 'bastion');
  if ('result' in to) return to.result;
  const { arrived, homeShape } = to;
  await pause(SETUP_WAITS.loadMs);
  if (ctx.signal.aborted) throw new Error('aborted');
  const wp = bw.way[bw.to];

  // ---- the zones down there (asked at every look: the bridge's scan follows the bot, 48 round it), as the fortress's:
  // the bastion's own is the natural one by the site in the latest answer; the walks keep 16 from every other zone seen
  const seenZones = new Map<string, BastionZone>();
  let others: Box[] = [];
  let bastion: BastionZone | undefined;
  /** a zone not natural by the site where the latest answer has no natural bastion: the bastion joined someone's build */
  let builtBy: BastionZone | undefined;
  /** the bastion was natural in an answer of this trip's (its loss is then a player's build, not a scan that has not reached it) */
  let wasNatural = false;
  const gapToSite = (z: BastionZone) => boxGap(zoneBox(z), cellBox(site));
  const volume = (z: BastionZone) => (z.x2 - z.x1 + 1) * (z.y2 - z.y1 + 1) * (z.z2 - z.z1 + 1);
  const askZones = async (): Promise<boolean> => {
    const r = await ctx.call<{ zones?: BastionZone[] }>('foreign.zones', { dimension: NETHER }).catch(() => undefined);
    if (!r) return false;
    const latest = r.zones ?? [];
    for (const z of latest) seenZones.set(`${z.x1},${z.y1},${z.z1},${z.x2},${z.y2},${z.z2}`, z);
    const natural = latest.filter(z => z.natural === 'bastion' && gapToSite(z) <= 16).sort((a, b) => gapToSite(a) - gapToSite(b) || volume(b) - volume(a))[0];
    builtBy = undefined;
    if (natural) bastion = natural;
    else {
      builtBy = latest.find(z => !z.natural && gapToSite(z) <= 16);
      if (builtBy || !bastion || latest.some(z => boxGap(zoneBox(z), zoneBox(bastion!)) === 0)) bastion = undefined;
    }
    if (bastion) wasNatural = true;
    const bb = bastion && zoneBox(bastion);
    others = [...seenZones.values()].filter(z => !(bb && z.natural === 'bastion' && boxGap(zoneBox(z), bb) === 0)).map(zoneBox);
    return true;
  };
  /** the bastions refused before this trip set out */
  const refusedBefore = [...(peekNether(world).bastion?.refused ?? [])];
  /** at the bastion (the scan has it as the scouting leg did) */
  let there = false;
  /** Why nothing may be taken from the bastion, by the bridge's latest answer, or undefined; `refuse`: the why it is refused for good with. */
  const courtesy = (): { why: string; refuse?: string } | undefined => {
    if (bastion) {
      if (!Array.isArray(bastion.strays)) return { why: `the bridge does not say what of a player's stands within 16 of the bastion at nether ${fmt(site)} (an older jar): nothing taken` };
      if (bastion.strays.length) {
        return { why: `the bastion at nether ${fmt(site)} has ${bastion.strays.slice(0, 4).join(', ')} within 16 of it (a player's): refused for good, nothing taken`, refuse: `${bastion.strays.join(', ')} within 16 of it` };
      }
      const was = refusedBy(refusedBefore, zoneBox(bastion));
      if (was) return { why: `the bastion at nether ${fmt(site)} was refused before by nether ${fmt(was)} (${was.why}): nothing taken`, refuse: `refused before by nether ${fmt(was)}: ${was.why}` };
    } else if (builtBy && (wasNatural || there)) {
      return { why: `someone's build by the bastion at nether ${fmt(site)} (the bridge's zone by it is no natural one): refused for good, nothing taken`, refuse: "someone's build by it" };
    }
    return undefined;
  };
  if (!(await askZones())) {
    const back = await backThroughOwn(ctx, arrived, homeShape, now);
    return { gain: 0, text: `no bastion trip: the bridge did not say where the builds down there are; ${back.text}`, mark: 'same', ...(back.cameBack ? { cameBack: true as const } : {}) };
  }

  // ---- the looks: the strict rules (bastionStop) between every leg of every walk, every chest and every bout
  let g = await readGround(ctx, stretchBox([floorOf(to.me), ...bw.way.slice(0, WAY_AHEAD)]));
  let me: Pos = to.me;
  let health = 20;
  let ents: Seen[] = [];
  let stop: string | undefined;
  let unlearnt = false;
  let gone = false;
  let watched = false;
  /** the fire resistance on the bot as the last look saw it, s */
  let fire = 0;
  /** the potions drunk at the bastion's edge: from then on they must last (bastionStop's `drunk`) */
  let drunk = false;
  /** a bout of the fight since the last look: the health it cost is the fight's, not a hit with no fight on */
  let fought = false;
  /** the brutes killed this trip (BRUTES_TRIP: another seen after them, and it leaves) */
  let brutesKilled = 0;
  const walked: Pos[] = [];
  /** the way back to its hut, ms: the cells walked out, and through its portal */
  const backMs = () => walked.length * FAR_STEP_MS + BACK_MS;
  /** the walk from where it stands to the nearest cell of the way out, ms (the bastion's ground it walked in over) */
  const toWayMs = () => walked.reduce((n, c) => Math.min(n, dist3(c, me)), Infinity) * FAR_STEP_MS;
  /** the fire resistance the way back needs from here, ms */
  const fireNeed = () => backMs() + toWayMs() + FIRE_SPARE_MS;
  const watch = async (): Promise<boolean> => {
    if (ctx.signal.aborted) throw new Error('aborted');
    const st = await ctx.status().catch(() => undefined);
    if ((st?.dimension ?? NETHER) !== NETHER) { gone = true; return false; }
    me = st?.position ?? me;
    if (st) fire = fireOf(st);
    await askZones();
    // (no dying ones: the bridge's fight ends the tick the brute's health is 0, but the game keeps its body about 1 s
    // until the server removes it, and the look right after the kill counted it as a second brute: home, no chest)
    ents = ((await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 64 }).catch(() => ({ entities: [] as Seen[] }))).entities ?? [])
      .filter(e => e.health === undefined || e.health > 0);
    // (after a bout the hit rule judges from the health the bout left: the bout that killed the last piglin turned
    // leaves none about, and what it cost read as a hit with no fight on, home after one chest. The health rule
    // still looks at this look whole)
    const was = fought ? (st?.health ?? health) : health;
    fought = false;
    health = st?.health ?? health;
    watched = ghastWatched(ents);
    // a player by the bastion: someone's to share; refused for good, and back
    const bb = bastion ? zoneBox(bastion) : cellBox(site);
    const player = ents.find(e => e.name === 'player' && boxGap(bb, cellBox(floorOf(e.position))) <= PLAYER_NEAR);
    if (player) {
      refuseBastion(world, site, `a player seen by it at nether ${fmt(player.position)}`, now(), bastion && zoneBox(bastion));
      stop = `a player seen by the bastion (nether ${fmt(player.position)}): refused for good`;
      return false;
    }
    const c = courtesy();
    if (c) {
      stop = c.why;
      if (c.refuse) refuseBastion(world, site, c.refuse, now(), bastion ? zoneBox(bastion) : builtBy && zoneBox(builtBy));
      else unlearnt = true;
      return false;
    }
    const d = bastionStop({ health, was, effects: st?.effects, onFire: st?.onFire, ents, eyes: { g, me }, brutesKilled, ...(drunk ? { drunk: { fireNeedS: fireNeed() / 1000 } } : {}) }, world, now());
    // (two brutes or a hoglin are the bastion's for good: brutes never despawn, hoglins live in the crimson forest round
    // it. The mark doubles, not the flat 20 min a ghast gone by gets: its stop at two brutes repeated every 20 min of
    // daylight. One brute on it before the potions is the flat mark: once drunk, a lone one is the fight)
    if (d) { stop = d.why; unlearnt = !/^(health|the wither|a second piglin brute|\d+ piglin brutes|a hoglin|a zoglin)/.test(d.why); return false; }
    return true;
  };
  /** the fire resistance drunk outlasts the way back (and FIRE_SPARE_MS): the ground by lava may be walked */
  const hotOk = () => drunk && fire * 1000 > fireNeed();
  /** cells by lava walked under the potion: the way back over them needs the effect too */
  let hotWalked = false;
  const wayMay = (p: Pos) => !others.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS) && !lavaBy(g, p) && !overDrop(g, p);
  const knockSafe = (p: Pos) => !watched || !overDrop(g, p, KNOCK_GAP);

  // ---- out along the known way (the scouting walked it by the barter's rules: no lava within 2), the ground read a
  // few waypoints ahead at a time; the cells walked are the way back
  const start = footing(g, me) ?? floorOf(me);
  walked.push(start);
  const walkOut = async (path: Pos[]): Promise<'ok' | 'stuck' | 'gone' | 'back'> => {
    for (let i = 0; i < path.length - 1;) {
      const j = Math.min(i + STEP, path.length - 1);
      if (i > 0 && !(await watch())) return 'back';
      if (i > 0 && left() < (walked.length + 2) * FAR_STEP_MS + BACK_MS) { stop = `the bastion trip's time is up on the ${bw.bearing} way`; unlearnt = true; return 'back'; }
      const r = await walkAlong(ctx, path.slice(i, j + 1), STEP);
      if (r !== 'ok') return r;
      for (const c of path.slice(i + 1, j + 1)) walked.push(c);
      i = j;
    }
    return 'ok';
  };
  ctx.progress(`bastion: out along the ${bw.bearing} way (${bw.blocks} blocks) to nether ${fmt(wp)} for the bastion at nether ${fmt(site)}`);
  let end: string | undefined;
  const rest = (j: number) => {
    let n = dist3(me, bw.way[Math.min(j, bw.to)]);
    for (let i = j + 1; i <= bw.to; i++) n += dist3(bw.way[i - 1], bw.way[i]);
    return n;
  };
  for (let j = 1, tries = 0; j <= bw.to && !end && !stop && !gone;) {
    if (!(await watch())) break;
    if (left() < (walked.length + 2 * rest(j)) * FAR_STEP_MS + FAR_TURN_MS + BACK_MS) { stop = `the bastion trip's time is up on the ${bw.bearing} way`; unlearnt = true; break; }
    const ahead = bw.way.slice(j, Math.min(bw.to, j + WAY_AHEAD - 1) + 1);
    g = await readGround(ctx, stretchBox([floorOf(me), ...ahead]));
    if (ctx.signal.aborted) throw new Error('aborted');
    const here = footing(g, me);
    if (!here) { end = `no ground under it on the ${bw.bearing} way at nether ${fmt(me)}`; break; }
    const reach = walkFrom(g, [here], p => wayMay(p) && knockSafe(p));
    let k = -1;
    for (let i = ahead.length - 1; i >= 0 && k < 0; i--) if (reach.has(cellKey(ahead[i]))) k = i;
    if (k < 0) {
      if (watched && walkFrom(g, [here], wayMay).has(cellKey(ahead[0]))) { stop = `${ghastAbout(ents)}: the ${bw.bearing} way on only by a drop's edge`; unlearnt = true; break; }
      end = `the ${bw.bearing} way closed by nether ${fmt(ahead[0])}`;
      break;
    }
    const w = await walkOut(pathOf(reach, ahead[k]));
    if (w === 'gone') { gone = true; break; }
    if (w === 'back' && (stop || gone)) break;
    if (w !== 'ok') { if (++tries > WAY_REPLANS) end = `stuck on the ${bw.bearing} way by nether ${fmt(ahead[0])}`; continue; }
    j += k + 1;
  }

  // ---- at the bastion: courtesy first (the look's), then the potions drunk, then its ground read
  const got = new Map<string, number>();
  /**
   * What of BASTION_LOOT is carried past what it set out with and what was booked, booked as gain. Only the loot: each
   * potion drunk leaves its glass bottle (26.3's potion: usingConvertsTo glass_bottle), two a trip, and counted they made
   * a trip that turned back at the bastion's edge a worked one with 2 glass_bottle of gain, its dry mark let go.
   */
  const bookLoot = (now2: Map<string, number>) => {
    for (const n of BASTION_LOOT) {
      const more = (now2.get(n) ?? 0) - (before.get(n) ?? 0) - (got.get(n) ?? 0);
      if (more > 0) { got.set(n, (got.get(n) ?? 0) + more); ctx.gain(more); }
    }
  };
  let foes = 0, chests = 0;
  let atEnd: string | undefined;
  if (!end && !stop && !gone) there = true;
  if (there && (await watch())) {
    atEnd = bastion ? await atBastion() : `no natural bastion by nether ${fmt(site)} in the bridge's scan from the ${bw.bearing} way`;
  }

  /**
   * Both potions drunk at the bastion's edge (fire resistance first, the longest of each carried): undefined once both
   * are on it, else why not. One already on it that lasts is not drunk again. A fire resistance that would not outlast
   * the way back and some work is no use: the bastion is not gone into.
   */
  async function drinkBoth(): Promise<string | undefined> {
    for (const what of ['fire_resistance', 'strength'] as const) {
      const st = await ctx.status().catch(() => undefined);
      const on = effectOf(st?.effects, what);
      if (what === 'fire_resistance' ? fireOf(st) * 1000 > fireNeed() + FIRE_WORK_MS : !!on) continue;
      const items = await inventory(ctx);
      const potion = what === 'fire_resistance' ? potionToDrink(items) : strengthToDrink(items);
      if (!potion) return `no potion of ${what === 'fire_resistance' ? 'fire resistance' : 'strength'} carried`;
      if (what === 'fire_resistance' && potionSeconds(potion) * 1000 <= fireNeed() + FIRE_WORK_MS) return `the potion of ${potion.potion} carried would not last the way back and the bastion's work`;
      const held = await ctx.call('item.select', { name: potion.name, slot: potion.slot }).then(() => true, () => false);
      if (ctx.signal.aborted) throw new Error('aborted');
      const r = held ? await ctx.call<{ finished?: boolean }>('use', {}, 15_000).catch(() => ({ finished: false })) : undefined;
      if (ctx.signal.aborted) throw new Error('aborted');
      const after = await ctx.status().catch(() => undefined);
      const took = effectOf(after?.effects, what);
      if (!took) return `the potion of ${potion.potion} did not take${!held ? ' (not taken in hand)' : r?.finished === false ? ' (not drunk)' : ''}`;
      if (what === 'fire_resistance') fire = fireOf(after);
      ctx.progress(`bastion: drank a potion of ${potion.potion}: ${took.seconds < 0 ? 'for ever' : `${Math.round(took.seconds)} s`} of ${what === 'fire_resistance' ? 'fire resistance' : 'strength'}`);
    }
    return undefined;
  }

  async function atBastion(): Promise<string | undefined> {
    // (before a potion is drunk: the waypoint's look sees 64 round it. Two brutes together or a hoglin within their
    // reach of the ground it would go into stop it in there, the potions drunk for nothing: the trip drank a long fire
    // resistance and a long strength for a brute on every try. One brute is the fight now, a trip: 26.3's pieces put
    // one by their chests 6 times in 7)
    const guard = bastionGuard(ents, readBoxFor(zoneBox(bastion!), wp));
    if (guard) { stop = `${guard}: not going in`; return undefined; }
    if (left() < backMs() + toWayMs() + FIRE_WORK_MS) { stop = 'too little of the bastion trip\'s time left to go in'; unlearnt = true; return undefined; }
    const potionWhy = await drinkBoth();
    if (potionWhy) { stop = `${potionWhy}: not going into the bastion`; unlearnt = true; return undefined; }
    drunk = true;
    if (!(await watch())) return undefined;
    const zb = zoneBox(bastion!);
    g = await readGround(ctx, readBoxFor(zb, wp));
    if (ctx.signal.aborted) throw new Error('aborted');
    const placed = placedIn(g);
    const clearOfPlaced = (p: Pos) => !placed.some(c => dist3(c, p) <= PLACED_CLEAR);
    const inRead = (p: Pos) => p.x >= g.x && p.y >= g.y && p.z >= g.z && p.x < g.x + g.width && p.y < g.y + g.height && p.z < g.z + g.length;
    // (by lava too while the fire resistance drunk outlasts the way back: a bastion is built over it. Judged once a
    // search: the way back's time is a sum over the cells walked)
    const walkable = (hot: boolean) => (p: Pos) => inRead(p) && !others.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS) && !overDrop(g, p) && (hot || !lavaBy(g, p)) && knockSafe(p);
    const looted = new Set((peekNether(world).bastion?.looted ?? []).map(cellKey));
    const tried = new Set<string>();
    const inZone = (p: Pos) => boxGap(zb, cellBox(p)) === 0;
    /** What of the bastion's loot came into the pockets since the start, booked. */
    const book = async () => bookLoot(tally(await inventory(ctx)));
    const reachFrom = () => {
      const here = footing(g, me);
      return here ? walkFrom(g, [here], walkable(hotOk())) : new Map<string, { from: string | null; n: number }>();
    };
    /**
     * A walk over the bastion's ground, a look between its legs; one over cells by lava is noted (the way back needs the
     * effect too). It stops ('back' with no stop) where a brute comes (in sight within BRUTE_NEAR): the bot stands and
     * meets it there, not walking on into its room and the piglins by it.
     */
    const walkIn = (path: Pos[]) => {
      if (path.some(c => lavaBy(g, c))) hotWalked = true;
      return walkAlong(ctx, path, STEP, async () => {
        if (!(await watch())) return false;
        const f = foe();
        return !(f && isBrute(f)) && !coming();
      });
    };
    /** fights that killed nothing, by the foe's id: twice, and it is let be */
    const missed = new Map<number, number>();
    const inSight = (e: Seen) => clearTo(seesThrough(g), { x: e.position.x, y: e.position.y + PIGLIN_EYE, z: e.position.z }, { x: me.x, y: me.y + EYE, z: me.z }, floorOf({ x: me.x, y: me.y + EYE, z: me.z }));
    const isBrute = (e: Seen) => e.name === 'piglin_brute';
    /** A piglin turned on it, or the brute (hostile at sight, never calmed), within FIGHT_RANGE and in sight, the nearest; not one fought twice for nothing. */
    const foe = () => ents.filter(e => (isBrute(e) || (e.name === 'piglin' && e.aggressive && !e.baby)) && e.distance <= FIGHT_RANGE && (missed.get(e.id) ?? 0) < FOE_TRIES && inSight(e))
      .sort((a, b) => a.distance - b.distance)[0];
    /** looks stood for each brute that comes */
    const waited = new Map<number, number>();
    /** A brute in sight within BRUTE_NEAR, past FIGHT_RANGE, not stood for BRUTE_WAITS looks yet: it comes, and is let come. */
    const coming = () => ents.filter(e => isBrute(e) && e.distance > FIGHT_RANGE && e.distance <= BRUTE_NEAR && (missed.get(e.id) ?? 0) < FOE_TRIES &&
      (waited.get(e.id) ?? 0) < BRUTE_WAITS && inSight(e)).sort((a, b) => a.distance - b.distance)[0];
    /** The fight from the shield in bouts of the bridge's fight, a look between them (the strict rules: the crowd, a second brute come, the health). */
    const fight = async (e: Seen): Promise<boolean> => {
      type Fought = { outcome?: string; kills?: string[]; health?: number };
      let r: Fought = {};
      for (let bout = 0; bout < FIGHT_BOUT.bouts; bout++) {
        if (bout > 0 && !(await watch())) return false;
        if (bout > 0 && !ents.some(x => x.id === e.id)) break;
        r = await ctx.call<Fought>('fight',
          // (that one by its id: the nearest piglin may be a calm one the swing would turn. crowdStop false: the bridge's
          // stop 4 over minHealth with two Enemy within 12 counts every piglin, calm ones and the victim itself, and the
          // fight ended at once at 18; the turned ones are BASTION_CROWD's. careful: the chase breaks nothing, a gold
          // block or gilded blackstone broken turns every piglin within 16)
          { target: `#${e.id}`, maxDistance: FIGHT_RANGE, timeoutMs: FIGHT_BOUT.ms, minHealth: BASTION_LEAVE, retreat: false, crowdStop: false, careful: true }, FIGHT_BOUT.ms + 10_000)
          .catch((x: Error) => ({ outcome: `failed: ${x.message}` } as Fought));
        fought = true;
        if (ctx.signal.aborted) throw new Error('aborted');
        if ((r.kills ?? []).length || r.outcome !== 'timeout') break;
      }
      const kills = (r.kills ?? []).length;
      foes += kills;
      brutesKilled += (r.kills ?? []).filter(x => x === 'piglin_brute').length;
      if (kills) ctx.progress(`bastion: killed ${(r.kills ?? []).join(', ')}`);
      // (the fight's stop at BASTION_LEAVE: the health rule's, no miss of that foe's; at 14 itself the next bout would
      // end at once again, so it leaves)
      if (r.outcome === 'low_health') { stop = `health ${Math.round(r.health ?? BASTION_LEAVE)}, at ${BASTION_LEAVE} in the fight`; return false; }
      if (!kills) {
        missed.set(e.id, (missed.get(e.id) ?? 0) + 1);
        if (missed.get(e.id)! >= FOE_TRIES) ctx.progress(`bastion: the ${e.name} #${e.id} fought ${FOE_TRIES} times for nothing (${r.outcome ?? 'no answer'}): let be`);
      }
      return watch();
    };
    /** Where to stand to open a chest: a cell a walk reaches whose eye sees the chest's top within 4.3, the fewest steps. */
    const chestStance = (reach: Map<string, { from: string | null; n: number }>, c: Pos): Pos | undefined => {
      let best: { p: Pos; n: number } | undefined;
      const top = { x: c.x + 0.5, y: c.y + 1, z: c.z + 0.5 };
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -2; dy <= 1; dy++) {
        const q = add(c, dx, dy, dz);
        const r = reach.get(cellKey(q));
        if (!r || (best && r.n >= best.n)) continue;
        const eye = { x: q.x + 0.5, y: q.y + EYE, z: q.z + 0.5 };
        if (dist3(eye, top) > 4.3 || !clearTo(seesThrough(g), eye, { x: top.x, y: top.y - 0.01, z: top.z }, c)) continue;
        best = { p: q, n: r.n };
      }
      return best?.p;
    };
    type Target = { at: Pos; stand: Pos; n: number; treasure: boolean };
    /** The bastion's chests it may open next from where it stands: the treasure room's first, then the fewest steps. */
    const targets = (reach: Map<string, { from: string | null; n: number }>): Target[] => {
      const out: Target[] = [];
      if (chests >= BASTION_CHESTS_TRIP) return out;
      for (let iy = 0; iy < g.height; iy++) for (let iz = 0; iz < g.length; iz++) for (let ix = 0; ix < g.width; ix++) {
        const p = { x: g.x + ix, y: g.y + iy, z: g.z + iz };
        const k = cellKey(p);
        if (tried.has(k) || looted.has(k) || !inZone(p) || !clearOfPlaced(p) || blockAt(g, p) !== 'chest' || !bastionChest(g, p)) continue;
        const st = chestStance(reach, p);
        if (st) out.push({ at: p, stand: st, n: reach.get(cellKey(st))!.n, treasure: treasureChest(g, p) });
      }
      return out.sort((a, b) => Number(b.treasure) - Number(a.treasure) || a.n - b.n);
    };
    /** Adult piglins within ANGRY_NEAR of the bot (every one may turn as a chest opens), and the brute (on it already). */
    const crowd = () => ents.filter(e => (e.name === 'piglin' || isBrute(e)) && !e.baby && e.distance <= ANGRY_NEAR).length;

    const here0 = footing(g, me);
    if (!here0) return `no ground under it by the bastion at nether ${fmt(me)}`;
    let crowded = false;
    while (!stop && !gone) {
      if (left() < backMs() + toWayMs() + 10_000) { stop = 'the bastion trip\'s time is up'; break; }
      if (!(await watch())) break;
      const e = foe();
      if (e) {
        if (isBrute(e)) ctx.progress(`bastion: the piglin brute #${e.id} at nether ${fmt(e.position)}, ${Math.round(e.distance)} off: fought from the shield (one a trip)`);
        if (!(await fight(e))) break;
        continue;
      }
      // (a brute that comes: stood for, so it is met here and alone, not in its room among the piglins)
      const c = coming();
      if (c) {
        const n = (waited.get(c.id) ?? 0) + 1;
        waited.set(c.id, n);
        if (n === 1) ctx.progress(`bastion: the piglin brute #${c.id} at nether ${fmt(c.position)}, ${Math.round(c.distance)} off, comes: it waits for it`);
        await pause(BASTION_WAITS.bruteMs);
        continue;
      }
      const items = await inventory(ctx);
      if (freeSlots(items) <= LOOT_ROOM) { stop = `pockets full (${36 - freeSlots(items)}/36 slots)`; break; }
      const reach = reachFrom();
      const t = targets(reach)[0];
      if (!t) {
        if (crowded) return `more than ${BASTION_CROWD} piglins by every chest it may open: let be`;
        return chests ? 'nothing more it may take by the way in' : `no chest of the bastion's it may open within ${BASTION_REACH} of where the ${bw.bearing} way meets it`;
      }
      // (a double chest's two halves are one: its other half is not opened again)
      const half = chestHalf(g, t.at) ?? undefined;
      const halves = half ? [t.at, half] : [t.at];
      for (const h of halves) tried.add(cellKey(h));
      const w = await walkIn(pathOf(reach, t.stand));
      if (w === 'gone') { gone = true; break; }
      // (stopped for a brute: the chest is still to open once it is fought)
      if (w === 'back') { if (stop || gone) break; for (const h of halves) tried.delete(cellKey(h)); continue; }
      if (w === 'stuck') continue;
      if (!(await watch())) break;
      // (every piglin that sees the chest open turns on the bot, golden helmet or not: no more than it takes on at once)
      const n = crowd();
      if (n > BASTION_CROWD) {
        crowded = true;
        ctx.progress(`bastion: ${n} piglins within ${ANGRY_NEAR} of the chest at nether ${fmt(t.at)}: not opened (they would all turn)`);
        continue;
      }
      const open = await ctx.call<{ items?: Record<string, number> }>('chest.open', { ...t.at }).catch(() => undefined);
      if (ctx.signal.aborted) throw new Error('aborted');
      if (!open) continue;
      chests += 1;
      let all = true;
      const has = open.items ?? {};
      for (const name of BASTION_LOOT) {
        const n2 = has[name] ?? 0;
        if (n2 <= 0) continue;
        if (freeSlots(await inventory(ctx)) <= LOOT_ROOM) { all = false; break; }
        const r = await ctx.call<{ items?: Record<string, number> }>('chest.withdraw', { name, count: n2 }).catch(() => undefined);
        if ((r?.items?.[name] ?? 0) > 0) all = false;
      }
      await ctx.call('container.close', {}).catch(() => undefined);
      // (what it wants of it taken: never opened again; the rest of it is the bastion's junk)
      if (all) {
        const bm = (netherOf(world).bastion ??= {});
        bm.looted = [...(bm.looted ?? []), ...halves.map(h => ({ ...h }))].slice(-FORTRESS_KEPT);
      }
      const had = got.get(NETHERITE_TEMPLATE) ?? 0;
      await book();
      if ((got.get(NETHERITE_TEMPLATE) ?? 0) > had) ctx.progress(`bastion: the ${NETHERITE_TEMPLATE} from the chest at nether ${fmt(t.at)}`);
    }
    return undefined;
  }

  // ---- done: said, back along the cells it walked out (from the one nearest where it stands), and through its own portal
  if (!gone) bookLoot(tally(await inventory(ctx)));
  const gain = [...got.values()].reduce((a, c) => a + c, 0);
  const did = gain || foes ? `bastion at nether ${fmt(site)}: ${lootWords(got) || 'nothing brought'}${foes ? ` (${foes} foe${foes === 1 ? '' : 's'} killed)` : ''}` : `nothing from the bastion at nether ${fmt(site)}`;
  if (gain || foes) ctx.progress(`nether: ${did}`);
  const work = gain || foes || chests ? { worked: true as const } : {};
  if (gone || !(await inNether(ctx))) return { gain, text: gain ? `${did}; ${GONE.text}` : GONE.text, ...work };
  const said = stop ?? end ?? atEnd ?? 'done';
  const mark = { ...(unlearnt && !gain ? { mark: 'same' as const } : {}), ...work };
  const back = [...walked].reverse();
  let w: 'ok' | 'stuck' | 'gone' | 'back' = 'stuck';
  for (let i = 0; i < 2 && w === 'stuck'; i++) {
    const st = await ctx.status().catch(() => undefined);
    if (st) fire = fireOf(st);
    const p = floorOf(st?.position ?? me);
    const from = back.reduce((best, c, n) => (dist3(c, p) < dist3(back[best], p) ? n : best), 0);
    // (from where it stands to the nearest cell of the way first: the bastion's ground it walked in over, by lava too
    // where it came in over lava under the potion, or while the effect lasts that short walk)
    const here = footing(g, p);
    const hotBack = hotWalked || fire * 1000 > FIRE_SPARE_MS;
    if (here && !same(here, back[from])) {
      const reach = walkFrom(g, [here], c => same(c, back[from]) || (!others.some(z => boxGap(z, cellBox(c)) < FROM_BUILDS) && (hotBack || !lavaBy(g, c)) && !overDrop(g, c)));
      if (reach.has(cellKey(back[from]))) await walkAlong(ctx, pathOf(reach, back[from]), STEP);
    }
    w = await walkAlong(ctx, back.slice(from), STEP);
  }
  if (w === 'gone') return { gain, text: `${did}; ${GONE.text}`, ...work };
  if (w !== 'ok') return { gain, text: `${did}; ${said}; stuck on the way back to its hut`, ...mark };
  const b = await backThroughOwn(ctx, arrived, homeShape, now);
  return { gain, text: `${did}; ${said}; ${b.text}`, ...mark, ...(b.cameBack ? { cameBack: true as const } : {}) };
}
