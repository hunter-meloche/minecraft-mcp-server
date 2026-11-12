import { fromGate, no, type Decline, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { WorldMemory } from './memory.js';
import { DEEP_TRIP, MINE_FROM_BUILDS, MINE_FROM_YARD, MINE_ROOM, deepTripKit, deepTripReady, pickMineStart, tripBudgetMs, type TripCheck } from './mine.js';
// (pockets.ts and chores.ts reach this file through community.ts: their exports are used inside functions only)
import { TRIP_STASH_RANGE, inYardOrNear, makeRoom, noRoom, room } from './pockets.js';
import { readyFoodPoints } from './food.js';
import { tier } from './kit.js';
import { chestTotals, freeChestTotals } from './chests.js';
import { ownItems } from './community.js';
import { nearestZone, type Zone } from './courtesy.js';
// (work.ts takes tripCheck from here, chores.ts the deep trip's gate: all three use the others' exports inside functions only)
import { mineDrops } from './chores.js';
import { deathNow, deepEnd, deepHold, deepStart, markDry, type WorkResult } from './work.js';
import type { InventoryItem } from '../tools.js';

/**
 * Deep trips for diamonds: by day, kitted out (deepTripKit: health, food, iron armour, torches, blocks) and with ten
 * slots free (the pockets rule: the stash makes them on the way out), from a departure point outside the home zone,
 * Baritone's miner after diamond ore for as long as the day allows, then home.
 * The kit turns the diamonds into gear (its upgrade pass), pickaxe first; the enchanting table wants two more.
 * The mining itself is oreTrip's, which the work queue's deep rung sends down for every ore it keeps (worktasks.ts).
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
  // trips that went wrong (two deaths in a day), or the first few trips of all, which count with the deep rung's
  const held = deepHold(s, world);
  if (held) return held;
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
  const want = diamondsWanted(s, ctx.world);
  // a trip down like the deep rung's, and counted with them: the first few are limited, a death on one is booked
  const startedAt = ctx.s.now;
  // (the end on the clock the trip was started by: the look's, and the time the trip took)
  const t0 = Date.now();
  let out = false;
  let ranItsCourse = false;
  let home = false;
  try {
    const r = await oreTrip({ ...ctx, s }, {
      wants: [{ family: 'diamond', ores: ORE, items: ['diamond'], want }], budgetMs: budget,
      // today's trip from here on, where it sets out (whatever comes of the walk, it is not tried again today), and
      // where it finds nowhere to set out from: that was today's try as well, or the gate would go on wanting a trip
      // that cannot be made, and each hold let go (after a minute of standing about, or by the idle watchdog) would
      // try it again
      tried: start => {
        (ctx.world.lastDone ??= {}).deep = ctx.s.now;
        if (start) { deepStart(ctx.world, startedAt); out = true; }
      }
    });
    // (a trip that never went down, by someone's build or short of the mine start, is no trip that ended well)
    ranItsCourse = !r.untried;
    const back = await ctx.act('go-home', { name: 'home', timeoutMs: 300_000 });
    if (!back.ok) throw new Error(`${r.text.slice(0, 120)}, but could not get home: ${back.text.slice(0, 120)}`);
    home = true;
    return `${r.text.slice(0, 120)}; back home`;
  } finally {
    // cut short out there (retreat, shelter), the trip stays open until the bot is seen home: a death on the way is its own
    if (out) deepEnd(ctx.world, startedAt, deathNow(), ranItsCourse, home ? undefined : startedAt + Math.max(0, Date.now() - t0));
  }
}

// ------------------------------------------------------------------------------------------------ one trip, several ores

/** One kind of ore a trip down goes for: its blocks, what they give (the first is the ore's own drop), and how many more of those are wanted. */
export interface OreWant { family: string; ores: string; items: readonly string[]; want: number }

/** The most one round of mining takes before the trip looks at itself again (health, food, pockets, the hour). */
const SLICE = 3 * MINUTE;
/** Less time than this left at the ore: not worth another round, the trip comes up. */
const LAST_SLICE = 20_000;
/** How long the bot looks round at the mine start (the mod sees round it every 5 s) before it trusts what it sees. */
let LOOK_MS = 6000;
/** For tests: a shorter look round at the mine start. */
export function setMineLookMs(ms: number): void { LOOK_MS = ms; }

/** This far below the level of the mine start, the bot is down the mine (a shaft, a cave): no longer up on the surface. */
const BELOW_START = 8;

const SLOTS = 36;
const countsOf = (items: InventoryItem[]) => {
  const m = new Map<string, number>();
  for (const i of items) if (i.slot < SLOTS) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
  return m;
};

/**
 * One trip down the mine for several ores, the one the morning's window allows (A18): out to the mine start once, a
 * look round there (someone's build too near it: another side next time, and no digging here), then down the list,
 * each ore mined in rounds of at most 3 min until its want is met or a round brings none of it (`deep:<family>` is
 * marked dry: the vein here is gone, and the next trip goes for another first), and on to the next only while 3 min
 * or more of the budget is left. Between rounds it stops when the brain stops it, when under 20 s of the budget is
 * left or the day's clock says it is time to go up, when it is hurt (health under 10), has no ready food left or no
 * pickaxe, and when its pockets are full after throwing away the stone the mine fills them with (mineDrops: never
 * ore, tools, food, torches, nor anything a bill carries; down there only, once it has been seen 8 below the start).
 * A round the mine tool could not do (no pickaxe here that harvests the ore) says nothing of the vein: no mark, and on
 * to the next ore. Gain: the wanted ores' items brought in, read from the inventory before and after each round, told
 * as it goes. A trip that brought nothing and never mined (the walk out stopped short, a build by the mine start, hurt
 * or hungry from the start, every ore refused) or never got below the start (Baritone found no way to any of it) is
 * `untried`. It does not walk home: the caller does.
 *
 * The mine tool counts what the inventory holds of the ore's own drop (Baritone's mine process counts the stacks its
 * block filter takes for the block's loot table drops, here diamond, raw_iron, raw_gold, redstone, lapis_lazuli,
 * coal; the bridge also stops at that many of the ore block's own item, which only silk touch would give): so a round
 * asks for what it carries of the drop plus what is still wanted, and stops when the want is met.
 *
 * `now` is the clock the caller books by (the work queue's: its marks and this trip's must agree); `tried` is told
 * where the trip sets out from as it does, or undefined when there is nowhere to set out from (it then throws).
 */
export async function oreTrip(ctx: GoalContext, opts: {
  wants: OreWant[]; budgetMs: number; now?: () => number; tried?: (start: { x: number; y: number; z: number } | undefined) => void;
}): Promise<WorkResult> {
  const clock = opts.now ?? Date.now;
  const began = clock();
  const home = ctx.s.home!;
  // the departure point: remembered; at first well outside the home zone on the side away from the lake (south),
  // and never by someone else's build (a friend's base): another side of the yard then
  const zones = async () => (await ctx.call<{ zones?: Zone[] }>('foreign.zones').catch(() => undefined))?.zones ?? [];
  const seen = await zones();
  const start = pickMineStart(home, ctx.world.yard, ctx.world.zones?.mine?.[0], p => nearestZone(p, seen, true).distance, ctx.world.leash);
  opts.tried?.(start);
  if (!start) {
    // (a side with room beyond the yard but past the leash is no build's fault: the maintenance runs read this line)
    throw new Error(pickMineStart(home, ctx.world.yard, ctx.world.zones?.mine?.[0], p => nearestZone(p, seen, true).distance)
      ? `no side of the yard has room for a mine start ${MINE_FROM_YARD} beyond it and ${MINE_ROOM} inside the leash (${ctx.world.leash})`
      : "every side of the yard has someone else's build by it: no deep trip from here");
  }
  (ctx.world.zones ??= {}).mine = [start];
  ctx.progress(`out to the mine at (${start.x}, ${start.z})`);
  const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...start, xz: true, range: 4, timeoutMs: 180_000 }, 195_000);
  // a walk that stopped short (the storage house door has held the bot) leaves it where it is, maybe in the yard:
  // nothing is thrown away or dug there, and the mine start is as good as it was
  if (walk?.arrived === false) return { gain: 0, text: `could not reach the mine start (${start.x}, ${start.z})`, untried: true };
  // there, the bot sees round it: a build it couldn't see from home means another side next time
  await new Promise(r => setTimeout(r, LOOK_MS));
  const seenAt = (await ctx.call<{ position?: { x: number; y: number; z: number } }>('status').catch(() => undefined))?.position;
  const here = seenAt ?? start;
  const near = nearestZone({ x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) }, await zones(), true);
  if (near.distance < MINE_FROM_BUILDS) {
    delete ctx.world.zones.mine;
    return { gain: 0, text: `someone else's build ${Math.round(near.distance)} blocks from the mine site: the next trip sets out from another side`, untried: true };
  }

  // (undefined when the look failed: what was last seen stands, and a round is not judged by a look that never came)
  const look = async () => (await ctx.call<{ items?: InventoryItem[] }>('inventory').catch(() => undefined))?.items;
  let inv = (await look()) ?? ctx.s.items;
  const first = countsOf(inv);
  const wanted = [...new Set(opts.wants.flatMap(w => w.items))];
  // the time at the ore still left: the budget, and the day's clock (the walk up must start by then whatever the budget said)
  const left = (timeOfDay: number | undefined) =>
    Math.min(opts.budgetMs - (clock() - began), timeOfDay === undefined ? Infinity : tripBudgetMs(timeOfDay, WALK_BACK));
  const dry: string[] = [];
  const dropped = new Map<string, number>();
  let why: string | undefined;
  let said = '';
  // whether the mine tool has done a round (one it could not do at all is none)
  let mined = false;
  // whether the bot has been seen below the mine start: Baritone that finds no way to any of the ore answers "nothing
  // gained" and leaves the bot standing where it was, up on the surface. The throwing away is for down there, and a
  // trip that never got down is no trip that ended well. The level as seen at the start (not seen: as if down there)
  const top = seenAt?.y;
  let below = top === undefined;
  const seeLevel = (p: { y: number } | undefined) => { if (!below && p && top !== undefined && p.y <= top - BELOW_START) below = true; };
  /** inventory looks that failed in a row */
  let blind = 0;
  /** the ores the tool would not mine (no pickaxe here that harvests them), and what it said of the first */
  const refused: string[] = [];
  let refusal = '';
  mining: for (const [i, w] of opts.wants.entries()) {
    let got = 0;
    while (got < w.want) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const st = await ctx.status().catch(() => undefined);
      seeLevel(st?.position);
      // the leash holds down here too: a round of Baritone's mine follows the ore wherever it leads, and the start is
      // only MINE_ROOM inside the leash
      if (st?.position && Math.hypot(st.position.x - home.x, st.position.z - home.z) > ctx.world.leash) { why = 'past the leash'; break mining; }
      const time = left(st?.timeOfDay);
      if (time < LAST_SLICE) break mining;
      // another ore only with time for a whole round of it
      if (i > 0 && got === 0 && time < SLICE) break mining;
      if (st?.health !== undefined && st.health < 10) { why = `health ${Math.round(st.health)}`; break mining; }
      if (readyFoodPoints(countsOf(inv)) <= 0) { why = 'no ready food left'; break mining; }
      // no pickaxe left (worn out, or lost in lava): every round would come back empty and mark a vein dry that is
      // not. Up, and the kit sees to one at home (it cuts no trip out here: brain.ts)
      if (!inv.some(x => x.slot < SLOTS && x.name.endsWith('_pickaxe'))) { why = 'no pickaxe left'; break mining; }
      // the stone the mine fills the pockets with: thrown away down here, beyond a stack of it for the climb
      const drops = mined && below ? mineDrops(inv, ctx.s, ctx.world) : [];
      for (const e of drops) {
        const r = await ctx.act('drop-item', { item: e.name, count: e.count });
        const n = Number(/^Dropped (\d+)/.exec(r.text)?.[1] ?? 0);
        if (n) dropped.set(e.name, (dropped.get(e.name) ?? 0) + n);
      }
      if (drops.length) inv = (await look()) ?? inv;
      if (inv.filter(x => x.slot < SLOTS).length >= SLOTS) { why = 'pockets full'; break mining; }
      const before = countsOf(inv);
      const slice = Math.min(SLICE, time);
      ctx.progress(`mining ${w.family} for ${w.want - got} more (${Math.round(slice / 1000)} s)`);
      const r = await ctx.act('mine-blocks', { block: w.ores, count: (before.get(w.items[0]) ?? 0) + w.want - got, timeoutMs: slice });
      said = r.text.split('\n')[0].slice(0, 140);
      ctx.progress(said);
      const looked = await look();
      if (looked) inv = looked;
      const after = looked ? countsOf(looked) : undefined;
      const more = (items: readonly string[]) => (after ? items.reduce((n, item) => n + Math.max(0, (after.get(item) ?? 0) - (before.get(item) ?? 0)), 0) : 0);
      const brought = more(wanted);
      if (brought) ctx.gain(brought);
      // the tool could not do the round at all (no pickaxe here that harvests this ore: the bridge says so before
      // Baritone moves): that says nothing of the vein, and the next ore may be one this pickaxe can mine
      if (!r.ok) { refused.push(w.family); refusal ||= said; said = ''; break; }
      mined = true;
      // no look: what the round brought is not known yet. The next round's look tells it (read against this round's
      // before, which stays), and no vein is judged dry by a look that never came. Twice in a row: up
      if (!after) {
        if (++blind >= 2) { why = 'the inventory could not be read'; break mining; }
        continue;
      }
      blind = 0;
      const mine = more(w.items);
      if (mine <= 0) {
        // none of it in a whole round: the vein here is gone (or out of reach); another ore, and the next trip too
        markDry(ctx.world, `deep:${w.family}`, clock());
        dry.push(w.family);
        break;
      }
      got += mine;
    }
  }
  const last = countsOf(inv);
  const gains = wanted.map(item => [item, (last.get(item) ?? 0) - (first.get(item) ?? 0)] as const).filter(([, n]) => n > 0);
  const gain = gains.reduce((n, [, k]) => n + k, 0);
  // (a last round that went down and found nothing: the next round's look never came)
  if (!below) seeLevel((await ctx.status().catch(() => undefined))?.position);
  const parts = [gain ? gains.map(([item, n]) => `+${n} ${item}`).join(', ') : `nothing gained${said ? ` (${said.slice(0, 100)})` : ''}`];
  if (dry.length) parts.push(`dry: ${dry.join(', ')}`);
  if (refused.length) parts.push(`the mine tool could not mine ${refused.join(', ')} (${refusal.slice(0, 100)})`);
  if (mined && !below && !gain) parts.push('never got below the mine start');
  if (dropped.size) parts.push(`dropped ${[...dropped].map(([n, k]) => `${k} ${n}`).join(', ')} down there`);
  if (why) parts.push(`${why}: up early`);
  // never mined (or never got down from the start), or came up blind with nothing seen: the trip says nothing of the
  // place, and is no trip that ended well
  const untried = !gain && (!mined || !below || blind >= 2);
  return { gain, text: parts.join('; '), ...(untried ? { untried: true as const } : {}) };
}
