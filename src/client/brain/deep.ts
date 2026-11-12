import { fromGate, no, type Decline, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { WorldMemory } from './memory.js';
import { DEEP_TRIP, MINE_FROM_BUILDS, deepTripKit, deepTripReady, pickMineStart, tripBudgetMs, type TripCheck } from './mine.js';
// (pockets.ts and chores.ts reach this file through community.ts: their exports are used inside functions only)
import { TRIP_STASH_RANGE, inYardOrNear, makeRoom, noRoom, room } from './pockets.js';
import { readyFoodPoints } from './food.js';
import { tier } from './kit.js';
import { chestTotals, freeChestTotals } from './chests.js';
import { ownItems } from './community.js';
import { nearestZone, type Zone } from './courtesy.js';

/**
 * Deep trips for diamonds: by day, kitted out (deepTripKit: health, food, iron armour, torches, blocks) and with ten
 * slots free (the pockets rule: the stash makes them on the way out), from a departure point outside the home zone,
 * Baritone's miner after diamond ore for as long as the day allows, then home.
 * The kit turns the diamonds into gear (its upgrade pass), pickaxe first; the enchanting table wants two more.
 */

const MINUTE = 60_000;
/** Diamonds for the whole diamond kit: pickaxe, sword, the four armour pieces, and the enchanting table. */
const COST: Record<string, number> = { pickaxe: 3, sword: 2, helmet: 5, chestplate: 8, leggings: 7, boots: 4 };
const TABLE = 2;
const ORE = 'diamond_ore,deepslate_diamond_ore';

/** How many diamonds the bot still wants: the kit pieces not yet diamond (or better), the table, less what it has. */
export function diamondsWanted(s: Pick<Snapshot, 'items'>, world: WorldMemory): number {
  const wear = s.items; // carried (0-35) and worn (36-40)
  let want = TABLE;
  for (const [kind, n] of Object.entries(COST)) {
    const best = Math.max(0, ...wear.filter(i => new RegExp(`_${kind}$`).test(i.name)).map(i => tier(i.name)),
      ...Object.keys(chestTotals(world)).filter(i => new RegExp(`_${kind}$`).test(i)).map(i => tier(i)));
    if (best < tier(`diamond_${kind}`)) want += n;
  }
  // its own diamonds only: what a community mission gathered isn't the bot's
  const have = ownItems(s.items, world).filter(i => i.name === 'diamond').reduce((a, i) => a + i.count, 0) + (freeChestTotals(world).diamond ?? 0);
  return Math.max(0, want - have);
}

/** The deep-trip checklist from a snapshot. */
export function tripCheck(s: Snapshot) {
  // the bridge's raw slots: 36-39 are the worn armour (feet, legs, chest, head)
  const armour = [36, 37, 38, 39].map(slot => s.items.find(i => i.slot === slot)?.name);
  const blocks = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone'].reduce((a, n) => a + (s.counts.get(n) ?? 0), 0);
  return {
    health: s.health, food: s.food, readyFoodPoints: readyFoodPoints(s.counts),
    armorTier: Math.min(...armour.map(n => (n ? tier(n) : 0))),
    torches: s.counts.get('torch') ?? 0, blocks, timeOfDay: s.timeOfDay, slotsFree: 36 - s.slotsUsed
  };
}

/** Hurt or hungry: no trip underground. */
const unfit = (s: Snapshot, c: TripCheck, who: string): Decline | null =>
  (c.health < DEEP_TRIP.health || c.food < DEEP_TRIP.food ? no.health(s, who, DEEP_TRIP.health, DEEP_TRIP.food) : null);

/** What the kit lacks, health and food aside. */
function kitLacks(c: TripCheck, who: string): Decline | null {
  const kit = [
    c.readyFoodPoints < DEEP_TRIP.readyFoodPoints && `${c.readyFoodPoints}/${DEEP_TRIP.readyFoodPoints} ready food points`,
    c.armorTier < DEEP_TRIP.armorTier && 'armour below iron',
    c.torches < DEEP_TRIP.torches && `${c.torches}/${DEEP_TRIP.torches} torches`,
    c.blocks < DEEP_TRIP.blocks && `${c.blocks}/${DEEP_TRIP.blocks} blocks`
  ].filter(Boolean);
  return kit.length ? { cause: 'kit', text: `${kit.join(', ')} (${who} needs the deep kit)` } : null;
}

/** Past the hour a trip sets out by. */
function pastStart(c: TripCheck, who: string): Decline | null {
  const t = ((c.timeOfDay % 24000) + 24000) % 24000;
  return t > DEEP_TRIP.latestStart ? { cause: 'late', text: `time of day ${t} (${who} sets out by ${DEEP_TRIP.latestStart})` } : null;
}

/**
 * Why a trip underground cannot set out now, or null when it can: deepTripReady, said as the idle log's causes. Hurt or
 * hungry first, then no room, then what the kit lacks; the hour last, as the reason only for a trip otherwise ready.
 * Ten slots free as they are now: the trips that ask this (the community's, the obsidian's) make no room of their own.
 */
export function tripDecline(s: Snapshot, who: string): Decline | null {
  const c = tripCheck(s);
  const ready = deepTripReady(c);
  if (ready.ok) return null;
  return unfit(s, c, who)
    ?? (c.slotsFree < DEEP_TRIP.slotsFree ? no.pockets(s, who, 37 - DEEP_TRIP.slotsFree) : null)
    ?? kitLacks(c, who) ?? pastStart(c, who)
    // a check deepTripReady has and this does not name yet: its own words
    ?? { cause: 'kit', text: `${who}: ${ready.why ?? 'not ready'}` };
}

/**
 * Why the bot itself is not fit or kitted for a trip underground, or null when it is: deepTripKit, said as the idle
 * log's causes (hurt or hungry as `health`, the rest as `kit`). Neither the hour nor the pockets: the deep trip's
 * gate has the pockets rule for the one and its own clock for the other.
 */
export function kitDecline(s: Snapshot, who: string): Decline | null {
  const c = tripCheck(s);
  const kit = deepTripKit(c);
  if (kit.ok) return null;
  return unfit(s, c, who) ?? kitLacks(c, who) ?? { cause: 'kit', text: `${who}: ${kit.why ?? 'not ready'}` };
}

let tripRunning = false;

/** The walk home from the mine, and the least time at the ore that is worth the walk out. */
const WALK_BACK = 2 * MINUTE;
const WORTH = 3 * MINUTE;

/**
 * Too little of the day left for a trip: the time at the ore before the walk home has to start is under WORTH. The run
 * used to find this out itself, after writing the day down as done: the trip was then "not due" for the rest of a day
 * it never went out in. Now the gate says it, as the hour, and the run asks the same question again.
 */
function tooLate(timeOfDay: number): Decline | null {
  const left = tripBudgetMs(timeOfDay, WALK_BACK);
  // (rounded down: a tick too late is "2.9 left", not "3.0")
  return left < WORTH ? { cause: 'late', text: `deep trip needs ${WORTH / MINUTE} min, ${(Math.floor(left / (MINUTE / 10)) / 10).toFixed(1)} left` } : null;
}

/**
 * Run now? The "no" is said in this order: no home to set out from; nothing to go for (it went today, or no diamonds
 * are wanted); then what keeps a wanted trip at home (not in the yard, hurt, full, not kitted out); the hour last.
 *
 * It sets out from anywhere in the yard, or within 40 of home: within 16 of home it was, and the bot spent its days
 * at the far end of a yard that reaches 64 out, the trip "away" each morning till the hour was past. Full pockets
 * hold it only when the stash could not make ten free slots: the run makes them on its way out.
 */
const gate = (s: Snapshot, world: WorldMemory): Gate => {
  if (s.dimension !== 'overworld' || !s.home) return no.away(s, 'deep trip', TRIP_STASH_RANGE);
  // once a day
  if (s.now - (world.lastDone?.deep ?? 0) < 20 * MINUTE) return no.notDue('deep trip', s.now, world.lastDone?.deep ?? 0, 20 * MINUTE);
  const want = diamondsWanted(s, world);
  if (!want) return { cause: 'stocked', text: 'no diamonds wanted' };
  if (!inYardOrNear(s, world)) return no.away(s, 'deep trip', TRIP_STASH_RANGE);
  // not ready (food, torches, armour, ...): the food goal and the kit see to that first
  const kit = kitDecline(s, 'deep trip');
  if (kit?.cause === 'health') return kit;
  if (room('deep', s, world) === 'no') return noRoom('deep', 'deep trip', s, world);
  if (kit) return kit;
  return no.late(s, 'deep trip') ?? pastStart(tripCheck(s), 'deep trip') ?? tooLate(s.timeOfDay) ?? { want: `${want} diamond(s) wanted: a deep trip` };
};

export const deepTrip: Goal = {
  name: 'deep trip',
  priority: 37,
  // once under way, only what matters more than the trip itself (staying alive, the gear, a full inventory) stops it:
  // the yard's projects stopped one 170 blocks out, mid-mine, and the walk was wasted
  urgency: () => (tripRunning ? 58 : 37),
  timeoutMs: 14 * MINUTE,
  retryMs: 30 * MINUTE,
  gate,
  ...fromGate(gate),
  run: async ctx => {
    tripRunning = true;
    try { return await trip(ctx); } finally { tripRunning = false; }
  }
};

async function trip(ctx: GoalContext): Promise<string> {
  {
    // the day can run out between the gate's yes and here: no trip then, and nothing written down or failed either
    // (the day is not "done" and the goal is not kept back for half an hour): the gate says the hour from now on
    const late = tooLate(ctx.s.timeOfDay);
    if (late) return `no trip today: ${late.text}`;
    // ten slots free before it leaves: home to the chests and the stash's own body where the pockets are fuller (the
    // gate said the stash can make them). The bot as it is after that is `s`: other pockets, and a later hour
    const s = await makeRoom(ctx, 'deep');
    if (s !== ctx.s) {
      // the same questions again, of the bot as it stands now: the stash may have taken the dirt that was the kit's
      // blocks, and the walk home and back to the chests the last of the morning
      const now = kitDecline(s, 'deep trip') ?? tooLate(s.timeOfDay);
      if (now) return `no trip today: ${now.text}`;
    }
    // the brain stops the trip after 14 minutes whatever it is doing: what making room took comes off the time at the ore
    const spent = Math.max(0, s.timeOfDay - ctx.s.timeOfDay) * 50;
    const budget = Math.min(Math.max(WORTH, 10 * MINUTE - spent), tripBudgetMs(s.timeOfDay, WALK_BACK));
    const home = s.home!;
    // the departure point: remembered; at first well outside the home zone on the side away from the lake (south),
    // and never by someone else's build (a friend's base): another side of the yard then
    const zones = async () => (await ctx.call<{ zones: Zone[] }>('foreign.zones').catch(() => ({ zones: [] as Zone[] }))).zones;
    const seen = await zones();
    const start = pickMineStart(home, ctx.world.yard, ctx.world.zones?.mine?.[0], p => nearestZone(p, seen, true).distance);
    if (!start) {
      // nowhere to set out from: that was today's try as well, or the gate would go on wanting a trip that cannot be
      // made, and each hold let go (after a minute of standing about, or by the idle watchdog) would try it again
      (ctx.world.lastDone ??= {}).deep = ctx.s.now;
      throw new Error("every side of the yard has someone else's build by it: no deep trip from here");
    }
    (ctx.world.zones ??= {}).mine = [start];
    // today's trip from here on, where it sets out: whatever comes of the walk, it is not tried again today
    (ctx.world.lastDone ??= {}).deep = ctx.s.now;
    ctx.progress(`out to the mine at (${start.x}, ${start.z})`);
    await ctx.call('goto', { ...start, xz: true, range: 4, timeoutMs: 180_000 }, 195_000);
    // there, the bot sees round it (the mod looks every 5 s): a build it couldn't see from home means another side next time
    await new Promise(r => setTimeout(r, 6000));
    const here = (await ctx.call<{ position?: { x: number; y: number; z: number } }>('status').catch(() => undefined))?.position ?? start;
    const near = nearestZone({ x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) }, await zones(), true);
    if (near.distance < MINE_FROM_BUILDS) {
      delete ctx.world.zones.mine;
      const back = await ctx.act('go-home', { name: 'home', timeoutMs: 300_000 });
      return `someone else's build ${Math.round(near.distance)} blocks from the mine site: the next trip sets out from another side${back.ok ? '; back home' : ''}`;
    }
    const want = diamondsWanted(s, ctx.world);
    ctx.progress(`mining for ${want} diamond(s), ${Math.round(budget / MINUTE)} min`);
    const r = await ctx.act('mine-blocks', { block: ORE, count: Math.min(want, 8), timeoutMs: budget });
    ctx.progress(r.text.split('\n')[0].slice(0, 140));
    const back = await ctx.act('go-home', { name: 'home', timeoutMs: 300_000 });
    if (!back.ok) throw new Error(`mined, but could not get home: ${back.text.slice(0, 120)}`);
    return `${r.text.split('\n')[0].slice(0, 120)}; back home`;
  }
}
