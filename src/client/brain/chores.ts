import { AVOID_UNLESS_ASKED } from '../../food.js';
import { foodsFor26, type InventoryItem } from '../tools.js';
import { fromGate, nearHome, no, outsideBy, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
// lives with the goal that walks the bot back to the yard now (goals.ts cannot import from here); still found here
export { outsideBy } from './goals.js';
import { COOKS_TO } from './food.js';
import { owedItems, ownItems } from './community.js';
// (deep.ts comes in through community.ts already; its goal is asked inside a function only)
import { deepTrip } from './deep.js';
import { chestTotals, freeChestTotals, key, peekChest, rememberReply, storeInChests, takeFromChests } from './chests.js';
import { assignChests, CATEGORIES, depositPlan, misplaced, type ChestAssign, type Deposit } from './storage.js';
import { KIT, kitNeeds, stashPlan, type KitNeed, type PlanStep, type StashEntry, type StashOptions } from './kit.js';
// the pockets rule's numbers (pockets.ts takes the stash's plan from here: each uses the other's inside functions only)
import { FOOD_CARRY, GLUT, NEAR_HOME, ROOM, TRIP_STASH_RANGE, makeRoom, noRoom, out as afield, room, type RoomKind } from './pockets.js';
import { planTorches, spawnableCells, yardBox } from './lighting.js';
import { HeatMap, pathTorchSpots } from './paths.js';
import { fuelFor } from './project.js';
import { daylightLeft } from './schedule.js';
import { reservedSites, stepOf } from './progress.js';
import { farmCentre, type Pos, type WorldMemory } from './memory.js';
import type { Box } from '../survey.js';
// (work.ts reaches this file through pockets.ts: its roundDue is asked inside the rounds' gates only)
import { roundDue, roundFrom, toRound } from './work.js';
import { goHome, walkHome } from './homeward.js';
import { EXPLORE_MIN, exploreReach, leaveYard } from './yardgates.js';

/**
 * The chores that keep the bot equipped and its home in order: emptying its pockets into the chests, smelting ore,
 * replacing worn tools and armour, fetching materials, and keeping the yard lit so nothing spawns in it.
 */

const MINUTE = 60_000;

/** (on home's level: 55 under the yard's edge, 16 from home across the ground, the stash found every chest too far to open) */
const awakeAtHome = (s: Snapshot) => !s.sleeping && s.dimension === 'overworld' && !!s.home && nearHome(s, NEAR_HOME);
/**
 * Where the lights and the sort round start from: anywhere in the yard on home's level (walking home first from beyond
 * NEAR_HOME), not only within 10 of home, where after the morning's trips nothing brought the bot for an hour
 */
const awakeForRound = (s: Snapshot, world: WorldMemory) => !s.sleeping && s.dimension === 'overworld' && !!s.home && roundFrom(s, world, NEAR_HOME);
/**
 * Junk is thrown 8 blocks out from the fence, which in a grown yard is past IN_YARD from home: by day only. In the
 * evening the shelter called the bot back from the dump walk each time, and stash and shelter took turns (a LOOP) till
 * dark; the junk waits for the morning, what goes in the chests doesn't.
 */
const dumpsJunk = (s: Snapshot) => s.activity === 'work';
const since = (world: WorldMemory, chore: string, now: number) => now - (world.lastDone?.[chore] ?? 0);
const done = (world: WorldMemory, chore: string, now: number) => { world.lastDone ??= {}; world.lastDone[chore] = now; };

let foodNames: Set<string> | undefined;
/** Everything edible worth carrying, raw food that cooks included. */
function foods(): Set<string> {
  foodNames ??= new Set(Object.keys(foodsFor26()).filter(n => !AVOID_UNLESS_ASKED.has(n)).concat(Object.keys(COOKS_TO)));
  return foodNames;
}

/** What the project in hand and the build jobs are gathering and building with: stays carried (the stash put a trip's logs away). */
/**
 * The casting still has obsidian to make: it's on, and the enchanting room (the only thing cast for) is neither past
 * its obsidian step nor built. With the table made and the room waiting on leather, its 5 empty buckets stayed carried
 * a day, five slots that held the pockets at 33/36 with nothing else to put away: every farm round's wheat set the
 * stash off, and the stash cut the farm, the pens and the fetch of a cow for the pen short each time (live 2026-11-09).
 */
export function castingAhead(world: WorldMemory): boolean {
  if (!world.lavaCasting || world.zones?.enchanting?.length) return false;
  // the room's step also while it is set aside (the band outside the fence redone ahead of it)
  return !(stepOf(world.progress, 'enchanting') > 0);
}

function projectCarry(world: WorldMemory): Set<string> {
  // the obsidian casting's buckets stay carried (the stash put four lava buckets in the gear chest mid-test)
  const casting = castingAhead(world) ? ['lava_bucket', 'water_bucket', 'bucket'] : [];
  return new Set([...(world.progress?.carry ?? []), ...activeJobs(world).flatMap(j => j.carry ?? []), ...casting]);
}

/**
 * Empty buckets the casting keeps carried at most: 4 for the enchanting room's lava, 1 for the water. The rest go in
 * the chests (the cast takes them back out, stacked). A water or lava bucket emptied turns into an empty bucket in its
 * own slot and never stacks: with them all kept, 9 empties took 9 slots, the pockets sat at 36/36 for hours, and the
 * kit couldn't take the coal for a torch (a LOOP every half hour) nor the cow barn start.
 */
const CAST_EMPTY_BUCKETS = 5;
/**
 * What the stash leaves on the bot: food (a stack of each kind: all of it stayed before, 541 bread in nine slots), the
 * project's and the jobs' materials, capped where they would hog the slots.
 *
 * Making room for a trip (`kind` trip or deep) it does not leave the project's and the jobs' materials, nor the
 * casting's buckets: they were what held the pockets full (208 logs and 128 planks at 31 slots, five empty buckets at
 * 33), and a trip has no use for them. Nothing brings them back afterwards and nothing needs to: the bills count the
 * chests with the pockets, and the project and the jobs take what they build with from the chests when they next run.
 * Not while a build job is building: its load is in the pockets to be placed, and stays there whoever asks.
 */
export function stashKeep(world: WorldMemory, kind?: RoomKind): StashOptions {
  const away = (kind === 'trip' || kind === 'deep') && !activeJobs(world).some(j => j.phase === 'building');
  const keep = away ? new Set<string>() : projectCarry(world);
  // food a bill carries is material, not provisions: it keeps the bill's own cap, or none
  const cap: Record<string, number> = {};
  for (const f of foods()) if (!keep.has(f)) cap[f] = FOOD_CARRY;
  // a build job's carry is its own: only the project's capped (what its bill could still use, billCarryCap)
  if (!away) Object.assign(cap, projectCap(world), castingAhead(world) ? { bucket: CAST_EMPTY_BUCKETS } : {});
  return { foods: foods(), keep, cap };
}

/** The project's carry caps, less anything a build job carries too (its own load, never capped here). */
function projectCap(world: WorldMemory): Record<string, number> {
  const jobs = new Set(activeJobs(world).flatMap(j => j.carry ?? []));
  return Object.fromEntries(Object.entries(world.progress?.carryCap ?? {}).filter(([k]) => !jobs.has(k)));
}

/** The LLM's build jobs still going. */
export const activeJobs = (world: WorldMemory) => (world.buildJobs ?? []).filter(j => !['done', 'failed', 'cancelled'].includes(j.status));

/** Raw materials the project in hand and the build jobs are short of, together. */
export function allNeeds(world: WorldMemory): Record<string, number> {
  const out: Record<string, number> = { ...(world.progress?.need ?? {}) };
  for (const j of activeJobs(world)) for (const [k, v] of Object.entries(j.need ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Look in every home chest not looked in for a while (plans use what they hold). */
async function refreshChests(ctx: GoalContext, maxAgeMs = 10 * MINUTE): Promise<void> {
  if (since(ctx.world, 'chests', ctx.s.now) < maxAgeMs && ctx.world.landmarks.chests.every(c => ctx.world.chestItems?.[key(c)])) return;
  for (const c of ctx.world.landmarks.chests) await peekChest(ctx, c).catch(e => ctx.progress(`chest at ${key(c)}: ${(e as Error).message}`));
  done(ctx.world, 'chests', ctx.s.now);
}

// ------------------------------------------------------------------------------------------------ stash

/** Empty the pockets into the home chests: when nearly full, and once in a while when home anyway. */

/**
 * A trip that would set out now and has to make room first (its gate wants, and the pockets rule says the stash can
 * make the slots): for materials (3 free carry 192 of a block) or down the mine (10). The stash goes first then, with
 * all it has to put away; what it leaves carried for the project the trip's own run puts away after (makeRoom).
 */
function tripWaiting(s: Snapshot, world: WorldMemory): string | null {
  // room first: with room to spare it does no sums, and a gate is asked only when its trip is the one held up
  if (room('trip', s, world) === 'stash' && stock.wants(s, world) !== null) return 'a materials trip';
  if (room('deep', s, world) === 'stash' && deepTrip.wants(s, world) !== null) return 'the deep trip';
  return null;
}

/** A chest to put down: one carried, or 8 planks to make one. */
function canFirstChest(s: Snapshot): boolean {
  const planks = [...s.counts].filter(([n]) => /_planks$/.test(n)).reduce((a, [, k]) => a + k, 0);
  return (s.counts.get('chest') ?? 0) > 0 || planks >= 8;
}

export { firstChest } from './firsts.js';
import { firstChest } from './firsts.js';

export const stash: Goal = {
  name: 'stash',
  priority: 60,
  timeoutMs: 6 * MINUTE,
  retryMs: 10 * MINUTE,
  wants: (s, world) => {
    if (s.sleeping || s.dimension !== 'overworld' || !s.home) return null;
    // no chest at home yet (a new bot, before its storage house): one put down beside home will do, if it has one
    if (!world.landmarks.chests.length && !canFirstChest(s)) return null;
    // a trip waiting for room is worth the walk home: the build job keeps the bot at its site, 24 blocks out, where
    // it waited all day at 31 slots
    // (not while a build job carries its load: those pockets are full on purpose)
    const building = buildingLoad(world);
    const tripWaits = building ? null : tripWaiting(s, world);
    // really full in the yard is worth the walk too: the bed is 16 from the home point there, the bot woke and sat
    // by it at 34/36 slots all day (live 2026-11-09), nothing stashed, and the cane round won't go out at 34
    const fullAt = world.progress?.carry || activeJobs(world).some(j => j.carry?.length) ? 33 : 27;
    // once in 10 min: what it carries for the project fills 31 slots, and a farm round's seeds took it back to 33 at
    // once (the stash ran 6 times in 5 min, stopping the farm, the lights and the trees each time)
    const fullOut = s.slotsUsed >= fullAt && !s.sleeping && nearHome(s, TRIP_STASH_RANGE) && !building &&
      since(world, 'stash', s.now) > 10 * MINUTE;
    if (!awakeAtHome(s) && !tripWaits && !fullOut) return null;
    const plan = stashList(s, world);
    if (!plan.deposit.length && !plan.drop.length) return null;
    if (building) {
      // a build job carrying its load fills the pockets on purpose and runs with them full: it is left alone until
      // there is not a slot free, and then stopped once in 10 min (a dug block each station would have the stash stop
      // it at every one). From 33 slots, as the rule was, the stash stopped the lookout's build at 35/36 to put away
      // a handful of things, with a slot still free for what the next station dug
      if (s.slotsUsed >= 36 && since(world, 'stash', s.now) > 10 * MINUTE) return `${s.slotsUsed}/36 slots used`;
    } else if (s.slotsUsed >= fullAt) {
      // a project carrying its materials fills the pockets on purpose: only stop it when really full
      return `${s.slotsUsed}/36 slots used`;
    }
    // a trip waiting for room: make the room. Under the stash's own limit the bot sat idle all day at 31 slots, its
    // build job waiting on 77 logs and the pockets full of seeds.
    // Once in 10 min, as from out in the yard above: what this stash leaves carried for the project only the trip's
    // own run puts away, so the trip still waits after it, and each new kind picked up would send the bot home again
    // (the deep trip outranked all morning by the larder and the farm: a walk home after every one of their rounds)
    if (tripWaits && since(world, 'stash', s.now) > 10 * MINUTE) return `${s.slotsUsed}/36 slots used, and ${tripWaits} waits for room`;
    if (!awakeAtHome(s)) return null;
    if (since(world, 'stash', s.now) > 30 * MINUTE && plan.deposit.length >= 3) return `${plan.deposit.length} kinds of things to put away`;
    return null;
  },
  // Worth stopping a running goal for only when that goal would start losing what it picks up: fewer free slots than
  // a round in the yard needs (a build job carrying its load: none at all, as its own rule above says). With more
  // room the stash waits for the run to end and takes over at the hand-over, 2 s later: at home with the kept kit at
  // 28 slots it cut every job short for a handful of things, and the signs round never got through its chests.
  // A run of the work queue is cut short only with no slot left at all, like the build job: it made its own room as
  // it set out and makes more between its units, and a walk home at 35/36 would cost it the trip (a trip more than
  // 10 blocks out is not cut short by the stash at any count: the brain's rule for trips, brain.ts)
  cuts: (s, world) => (buildingLoad(world) || afield.work ? s.slotsUsed >= 36 : 36 - s.slotsUsed < ROOM.yard),
  run: async ctx => {
    if (!ctx.world.landmarks.chests.length) {
      const at = await firstChest(ctx);
      if (!at) throw new Error('no chest at home, and none could be put down beside it');
      ctx.world.landmarks.chests.push(at);
      ctx.progress(`no chest at home yet: put one down at (${at.x}, ${at.y}, ${at.z})`);
    }
    const { stored, dropped } = await putAway(ctx, ctx.s, stashKeep(ctx.world));
    if (!stored && !dropped) throw new Error('nothing could be put away');
    return `put ${stored} item(s) in the chests${dropped ? `, threw away ${dropped} junk` : ''}`;
  }
};

/** A build job is building with its load in the pockets: they are full on purpose. */
const buildingLoad = (world: WorldMemory) => activeJobs(world).some(j => j.phase === 'building' && j.carry?.length);

/**
 * How long a levelling's fill stays marked after the growth's last try. Live tries of one growth came up to 2 h 10
 * apart; a growth dropped, cancelled or bypassed (the yard had room after all) never clears its mark.
 */
const FILL_HOLD = 4 * 60 * MINUTE;

/** The kinds a yard growth still under way took out of the chests as fill (progress.fill, while its mark is fresh). */
function fillKinds(s: Snapshot, world: WorldMemory): string[] {
  const p = world.progress;
  const age = s.now - (p?.fillAt ?? 0);
  return p?.fill && age >= 0 && age < FILL_HOLD ? p.fill : [];
}

/**
 * Kinds a bill carries, is being secured for or is short of (the project's, the build jobs', the community's), and
 * what a levelling's fill took out of the chests for the yard (progress.fill): never glut.
 */
function billKinds(s: Snapshot, world: WorldMemory): Set<string> {
  const out = new Set<string>([...projectCarry(world), ...fillKinds(s, world), ...Object.keys(allNeeds(world)),
    ...Object.keys(world.progress?.blocked?.need ?? {}), ...Object.keys(owedItems(world))]);
  for (const j of activeJobs(world)) for (const k of [...Object.keys(j.bill ?? {}), ...Object.keys(j.missing ?? {})]) out.add(k);
  for (const held of Object.values(world.reserved ?? {})) for (const [k, n] of Object.entries(held)) if (n > 0) out.add(k);
  return out;
}

/** The kinds the chests hold enough of (GLUT, by the stored totals as last seen), less what a bill has a use for. */
function glutKinds(s: Snapshot, world: WorldMemory): Set<string> {
  const stored = chestTotals(world);
  const over = Object.keys(GLUT).filter(n => (stored[n] ?? 0) >= GLUT[n]);
  if (!over.length) return new Set();
  const billed = billKinds(s, world);
  return new Set(over.filter(n => !billed.has(n)));
}

/**
 * What the stash would put away now and what it would throw away: the one list its trigger, its run and the room rule
 * (pockets.ts) all read, so the rule never promises room the run then does not make.
 */
export function stashList(s: Snapshot, world: WorldMemory, keep: StashOptions = stashKeep(world)): { deposit: StashEntry[]; drop: StashEntry[] } {
  const plan = stashPlan(s.items, keep);
  // what the project or a job carries, and a levelling's fill, is never junk, kept or not: making room for a trip
  // keeps none of it (stashKeep), and the junk rule spares only what is kept, so the trip sent for a job's logs threw
  // 136 of the job's 200 dirt and its seeds and saplings on the dump. Into the chests, where the bills count them
  const mine = new Set([...projectCarry(world), ...fillKinds(s, world)]);
  plan.deposit.push(...plan.drop.filter(e => mine.has(e.name)));
  plan.drop = plan.drop.filter(e => !mine.has(e.name));
  if (!dumpsJunk(s)) plan.drop = [];
  // only what can really go: a worse duplicate of a kept tool shares its name, and store-in-chest can't tell them
  // apart, so it stays carried; and a project's materials stay (a full pocket of planks for the storage house had the
  // stash stop the build over and over, storing nothing)
  const dupes = (n: string) => s.items.filter(i => i.name === n && i.slot < 36).length > 1;
  plan.deposit = plan.deposit.filter(e => e.slot === undefined || !dupes(e.name));
  // enough of it in the chests already: thrown away with the junk, not stored (the storage house filled up with
  // cobblestone, and then nothing had room). Like the junk it waits for the morning: by evening it stays carried
  const glut = glutKinds(s, world);
  if (glut.size) {
    const over = plan.deposit.filter(e => e.slot === undefined && glut.has(e.name));
    plan.deposit = plan.deposit.filter(e => !over.includes(e));
    if (dumpsJunk(s)) plan.drop.push(...over);
  }
  return plan;
}

/** Baritone's throwaway stone (the bridge's list, ClaudeBridge.java): a stack of it together is what a trip down keeps. */
const THROWAWAY = new Set(['cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff']);

/**
 * What a trip down the mine throws away where it stands, between its rounds (deep.ts oreTrip): the stone digging
 * brings up by the stack beyond what it keeps of it (KIT.carryMax: one stack of throwaway stone together, cobblestone
 * first, the bridge scaffolds the climb with it; a stack of any other kind in GLUT), and the stash's own junk beyond
 * what the stash keeps of each. Nothing else: no ore, tool, food or torch is either. Never a kind a bill carries or is
 * short of, whatever the count: the stash spares those too (billKinds). It looks and never writes.
 */
export function mineDrops(items: InventoryItem[], s: Snapshot, world: WorldMemory): StashEntry[] {
  const billed = billKinds(s, world);
  const main = items.filter(i => i.slot >= 0 && i.slot < 36);
  // the junk, as the stash's own plan has it (what a bill carries is on its keep list, so spared)
  const drop = stashPlan(main, { keep: billed }).drop;
  const listed = new Set(drop.map(e => e.name));
  const total = (n: string) => main.filter(i => i.name === n).reduce((a, i) => a + i.count, 0);
  let stone = KIT.carryMax.cobblestone;
  for (const name of Object.keys(GLUT)) {
    const n = total(name);
    if (!n || listed.has(name) || billed.has(name)) continue;
    const keep = Math.min(n, THROWAWAY.has(name) ? stone : KIT.carryMax.cobblestone);
    if (THROWAWAY.has(name)) stone -= keep;
    if (n > keep) drop.push({ name, count: n - keep });
  }
  return drop;
}

/** The stash's list with where each thing goes. */
export interface StashWork {
  /** each kind of thing to its own chest (three chests or more) */
  moves: Deposit[];
  /** to the first chest with room: everything with fewer chests, else what its own chests have no room for */
  rest: StashEntry[];
  /** thrown away at the dump spot: junk, and what the chests hold enough of */
  drop: StashEntry[];
  /** kinds of things with no room left in their chests (sorted storage only) */
  full?: string[];
}

/** The stash's work for these pockets. It looks and never writes: `assign` is the chests' kinds when the caller has them. */
export function stashWork(s: Snapshot, world: WorldMemory, keep: StashOptions = stashKeep(world), assign?: ChestAssign): StashWork {
  const { deposit, drop } = stashList(s, world, keep);
  if (world.landmarks.chests.length < 3) return { moves: [], rest: deposit, drop };
  // sorted: each kind of thing to its own chest
  assign ??= assignChests(world.landmarks.chests, CATEGORIES, world.chestItems ?? {}, world.chestAssign ?? {});
  const want = new Map(deposit.map(e => [e.name, e.count] as const));
  const total = (n: string) => s.items.filter(i => i.name === n && i.slot < 36).reduce((a, i) => a + i.count, 0);
  const sorted = depositPlan(s.items, item => (want.has(item.name) ? total(item.name) - want.get(item.name)! : item.count), assign, world.chestItems ?? {});
  return { moves: sorted.moves, rest: sorted.unplaced, drop, full: sorted.full };
}

/**
 * The stash's body: put away and throw away what the plan says for the pockets `s`, leaving `keep` carried. One body
 * for the stash goal and for a goal making room before it sets out (pockets.ts makeRoom, which keeps less). `note`
 * says what it could not do without that being a failure of its own (no dump spot it could get to).
 */
export async function putAway(ctx: GoalContext, s: Snapshot, keep: StashOptions): Promise<{ stored: number; dropped: number; note?: string }> {
  const world = ctx.world;
  const sorts = world.landmarks.chests.length >= 3;
  const work = stashWork(s, world, keep, sorts ? chestAssignment(world) : undefined);
  let stored = 0;
  for (const m of work.moves) {
    const [x, y, z] = m.chest.split(',').map(Number);
    const r = await ctx.act('store-in-chest', { x, y, z, item: m.name, count: m.count });
    rememberReply(world, { x, y, z }, r.text);
    stored += Number(/^Stored (\d+)/.exec(r.text)?.[1] ?? 0);
  }
  if (sorts) world.storageFull = work.full ?? [];
  for (const e of work.rest) stored += await storeInChests(ctx, e.name, e.count);
  done(world, 'stash', s.now);
  let dropped = 0;
  // what kept it from doing all of its list, for a caller that needed the room (said, not thrown: what went in the
  // chests still counts)
  let note: string | undefined;
  if (work.drop.length) {
    // thrown where the bot stands it picks them straight back up, and anything it walks over it picks up too (the
    // farm round, then a fishing walk, brought back hundreds of dirt and leaf litter thrown minutes before): throw
    // them 8 blocks out from the fence on the side it walks least (the heat map), where they despawn in 5 minutes
    const yard = world.yard;
    const dumps = yard ? dumpSpots(yard, world.heat ? HeatMap.fromJSON(world.heat) : undefined) : [(() => {
      const home = s.home!;
      const f = farmCentre(world);
      const dx = f ? home.x - f.x : -1, dz = f ? home.z - f.z : -1;
      const len = Math.hypot(dx, dz) || 1;
      return { x: Math.round(home.x + dx / len * 14), y: home.y, z: Math.round(home.z + dz / len * 14) };
    })()];
    // the least walked side first, the next if it can't get there (the east spot was in a stone hill, and the stash
    // failed there every time, storing nothing and dropping nothing, all day)
    let there = false;
    for (const dump of dumps) {
      if (ctx.signal.aborted) break;
      // (the spot is outside the fence: out by the gate on the way to it, not over the fence: yardgates.ts)
      await leaveYard(ctx, dump);
      try {
        await ctx.act('move-to-position', { ...dump, range: 2, timeoutMs: 60_000 });
        there = true;
      } catch {
        // near enough will do, as long as it's well outside the fence
        const me = (await ctx.status()).position;
        there = !!me && (!yard || outsideBy(yard, me) >= 4);
      }
      if (there) break;
    }
    if (there) {
      for (const e of work.drop) {
        const r = await ctx.act('drop-item', { item: e.name, count: e.count });
        const m = /^Dropped (\d+)/.exec(r.text);
        if (m) dropped += Number(m[1]);
      }
    } else {
      note = 'no dump spot outside the fence it could get to';
      ctx.progress(`${note}: the junk stays carried`);
    }
    await goHome(ctx, 120_000).catch(() => undefined);
  }
  ctx.progress(`stored ${stored}, dropped ${dropped}`);
  return note ? { stored, dropped, note } : { stored, dropped };
}

/** Which home chest holds which kind of thing: kept, extended to new chests. */
export function chestAssignment(world: WorldMemory): ChestAssign {
  world.chestAssign = assignChests(world.landmarks.chests, CATEGORIES, world.chestItems ?? {}, world.chestAssign ?? {});
  return world.chestAssign;
}

/** Now and then, by day at home: move things sitting in the wrong chest to their own. */
export const sortStorage: Goal = {
  name: 'sort',
  priority: 20,
  timeoutMs: 6 * MINUTE,
  retryMs: 20 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || !awakeForRound(s, world) || world.landmarks.chests.length < 3 || s.slotsUsed > 28) return null;
    // after 30 min, and then in the evening, or when no trip could go instead (or it has waited an hour)
    if (!roundDue(s, world, 'sort', 30 * MINUTE)) return null;
    const moves = misplaced(chestAssignment(world), world.chestItems ?? {});
    return moves.length ? `${moves.length} kind(s) of things in the wrong chest` : null;
  },
  // within 10 of home it cuts in as ever; from out in the yard it waits for what runs to end
  cuts: s => nearHome(s, NEAR_HOME),
  run: async run => {
    // from out in the yard, home first (on foot); the chests' own walks take it from there, as they always did
    const ctx: GoalContext = { ...run, s: await toRound(run, NEAR_HOME) };
    done(ctx.world, 'sort', ctx.s.now);
    await refreshChests(ctx, 0);
    let moved = 0;
    for (const m of misplaced(chestAssignment(ctx.world), ctx.world.chestItems ?? {})) {
      const [fx, fy, fz] = m.from.split(',').map(Number);
      const [tx, ty, tz] = m.to.split(',').map(Number);
      const t = await ctx.act('take-from-chest', { x: fx, y: fy, z: fz, item: m.name, count: m.count });
      rememberReply(ctx.world, { x: fx, y: fy, z: fz }, t.text);
      if (!/^Took/.test(t.text)) continue;
      const r = await ctx.act('store-in-chest', { x: tx, y: ty, z: tz, item: m.name, count: m.count });
      rememberReply(ctx.world, { x: tx, y: ty, z: tz }, r.text);
      if (/^Stored/.test(r.text)) moved++;
    }
    return `moved ${moved} kind(s) of things to their own chest`;
  }
};

// ------------------------------------------------------------------------------------------------ smelt

const ORES: Record<string, string> = { raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot' };
const FUELS = ['coal', 'charcoal', 'oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log', 'cherry_log', 'mangrove_log', 'oak_planks', 'birch_planks', 'spruce_planks'];

/** Take whatever the home furnace has finished; how much (as "16 iron_ingot"), or '' when nothing. */
export async function collectFurnace(ctx: GoalContext): Promise<string> {
  const at = ctx.world.landmarks.furnace;
  if (!at) return '';
  type Slot = { name: string; count: number } | null;
  const open = () => ctx.call<{ open: boolean; output: Slot; input: Slot; lit: boolean }>('furnace.open', { ...at });
  let f = await open().catch(() => undefined);
  if (!f) { await ctx.act('move-to-position', { ...at, range: 2, timeoutMs: 60_000 }); f = await open().catch(() => undefined); }
  if (!f) return '';
  try {
    const took: string[] = [];
    if (f.output) {
      const r = await ctx.call<{ took: Slot }>('furnace.take');
      if (r.took) took.push(`${r.took.count} ${r.took.name}`);
    }
    // what sits in the input unlit (no fuel left) blocks every other smelt ("input slot occupied"): take it back
    if (f.input && !f.lit) {
      const r = await ctx.call<{ took: Slot }>('furnace.take', { slot: 'input' });
      if (r.took) took.push(`${r.took.count} ${r.took.name} (not cooked)`);
    }
    return took.join(', ');
  } finally {
    await ctx.call('container.close').catch(() => undefined);
  }
}

/** Ingots wanted at home: a full iron kit's worth. */
const INGOTS_KEPT = 24;
/** Raw iron in the chests to smelt now: while the home has fewer than INGOTS_KEPT ingots. */
function storedIronToSmelt(s: Snapshot, world: WorldMemory): number {
  const chest = chestTotals(world);
  const ingots = (s.counts.get('iron_ingot') ?? 0) + (chest.iron_ingot ?? 0);
  return Math.min(chest.raw_iron ?? 0, Math.max(0, INGOTS_KEPT - ingots), 16);
}

/** Logs to burn into charcoal: when coal (carried and stored) is under 8 and it carries 10 or more of one kind. */
function charcoalLogs(s: Snapshot, world: WorldMemory): { name: string; count: number } | undefined {
  const chest = chestTotals(world);
  const coal = (s.counts.get('coal') ?? 0) + (s.counts.get('charcoal') ?? 0) + (chest.coal ?? 0) + (chest.charcoal ?? 0);
  if (coal >= 8) return undefined;
  const best = [...s.counts].filter(([n]) => /^(?!stripped_)[a-z_]+_log$/.test(n)).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 10 ? { name: best[0], count: best[1] } : undefined;
}

/** Raw ore carried home: smelt it at the home furnace; charcoal when coal runs low. */
export const smelt: Goal = {
  name: 'smelt',
  priority: 66,
  timeoutMs: 10 * MINUTE,
  retryMs: 10 * MINUTE,
  wants: (s, world) => {
    if (!awakeAtHome(s) || !world.landmarks.furnace) return null;
    const ore = Object.keys(ORES).find(o => (s.counts.get(o) ?? 0) > 0);
    if (ore && FUELS.some(f => (s.counts.get(f) ?? 0) > 0)) return `${s.counts.get(ore)} ${ore} to smelt`;
    if (storedIronToSmelt(s, world) > 0) return `${storedIronToSmelt(s, world)} raw iron in the chests to smelt for the gear`;
    if (since(world, 'furnace', s.now) > 30 * MINUTE) return 'check the furnace for finished smelting';
    return charcoalLogs(s, world) ? 'low on coal: charcoal from logs' : null;
  },
  run: async ctx => {
    const did: string[] = [];
    // a smelt stopped midway (something more urgent) leaves its output in the furnace: take it out
    done(ctx.world, 'furnace', ctx.s.now);
    const took = await collectFurnace(ctx);
    if (took) { did.push(`took ${took} out of the furnace`); ctx.progress(did.at(-1)!); }
    // raw iron the stash put away, while the home is short of ingots (the gear wants them)
    const fromChest = storedIronToSmelt(ctx.s, ctx.world);
    if (fromChest > 0) {
      const got = await takeFromChests(ctx, 'raw_iron', fromChest);
      if (got) {
        const fuel = await fuelFor(ctx);
        if (fuel) {
          const r = await ctx.act('smelt-item', { ...ctx.world.landmarks.furnace!, inputItem: 'raw_iron', inputCount: got, fuelItem: fuel, takeOutput: true, timeoutMs: got * 10_500 + 15_000 });
          did.push(r.ok ? `smelted ${got} raw_iron from the chests` : `could not smelt raw_iron: ${r.text}`);
          ctx.progress(did.at(-1)!);
        }
      }
    }
    // charcoal when coal runs low (torches, cooking and smelting all burn it): logs in, planks or a log to burn
    const logs = charcoalLogs(ctx.s, ctx.world);
    if (logs) {
      const fuel = [...ctx.s.counts].find(([n, k]) => /_planks$/.test(n) && k > 0)?.[0] ?? logs.name;
      const n = Math.min(8, logs.count - (fuel === logs.name ? 2 : 0));
      if (n > 0) {
        const r = await ctx.act('smelt-item', { ...ctx.world.landmarks.furnace!, inputItem: logs.name, inputCount: n, fuelItem: fuel, takeOutput: true, timeoutMs: n * 10_500 + 15_000 });
        did.push(r.ok ? `made ${n} charcoal` : `could not make charcoal: ${r.text}`);
        ctx.progress(did.at(-1)!);
      }
    }
    for (const ore of Object.keys(ORES)) {
      const n = ctx.s.counts.get(ore) ?? 0;
      const fuel = FUELS.find(f => (ctx.s.counts.get(f) ?? 0) > 0);
      if (!n || !fuel) continue;
      const r = await ctx.act('smelt-item', { ...ctx.world.landmarks.furnace!, inputItem: ore, inputCount: n, fuelItem: fuel, takeOutput: true, timeoutMs: n * 10_500 + 15_000 });
      // smelted means the ore went: a reply like "input slot is occupied" is no error, and counted as done it had
      // the bot "smelt" the same 7 raw copper every 5 seconds
      const left = (await ctx.call<{ items: { name: string; count: number }[] }>('inventory')).items.filter(i => i.name === ore).reduce((a, i) => a + i.count, 0);
      if (left >= n) throw new Error(`could not smelt ${ore}: ${r.text.slice(0, 120)}`);
      did.push(r.ok ? `smelted ${n - left} ${ore}` : `could not smelt ${ore}: ${r.text}`);
      ctx.progress(did.at(-1)!);
    }
    return did.join('; ') || 'nothing to smelt';
  }
};

// ------------------------------------------------------------------------------------------------ kit

const doable = (n: KitNeed) => n.plan.some(st => 'take' in st || 'craft' in st);
const label = (n: KitNeed) => `${'spare' in n && n.spare ? 'spare ' : ''}${n.kind} (${n.why})`;

/** Tools and armour worn out or missing, torches or throwaway blocks short: take from the chests or craft. */
export const kit: Goal = {
  name: 'kit',
  priority: 70,
  timeoutMs: 8 * MINUTE,
  retryMs: 10 * MINUTE,
  wants: (s, world) => {
    if (!awakeAtHome(s)) return null;
    if (world.landmarks.chests.some(c => !world.chestItems?.[key(c)])) return 'look in the home chests';
    const needs = kitNeeds(ownItems(s.items, world), freeChestTotals(world)).filter(doable);
    return needs.length ? `needs ${needs.map(label).join(', ')}` : null;
  },
  // not worth stopping a run of the work queue about the yard for: it ends within minutes, and the kit takes over at
  // the hand-over. The work queue's `trip kit` is such a run, and does the kit's own steps from out in the yard: as
  // it came to the chests, the kit wanted the same and stopped it every time ("stopping work: trip kit: kit is more
  // urgent"), a run booked empty for the walk. A trip out is the brain's to rule on (brain.ts)
  cuts: () => !(afield.work && !afield.trip),
  run: async ctx => {
    await refreshChests(ctx, 0);
    const inv = await ctx.call<{ items: Snapshot['items'] }>('inventory');
    // what it carries for a community mission is not its own to craft with
    const needs = kitNeeds(ownItems(inv.items, ctx.world), freeChestTotals(ctx.world));
    const did: string[] = [];
    for (const need of needs.filter(doable)) {
      for (const step of need.plan) {
        const r = await runStep(ctx, step);
        if (r) { did.push(r); ctx.progress(`${label(need)}: ${r}`); }
      }
    }
    return did.join('; ') || 'nothing could be done (materials ran short)';
  }
};

async function runStep(ctx: GoalContext, step: PlanStep): Promise<string | undefined> {
  if ('gather' in step) return undefined; // the stock goal fetches materials
  if ('take' in step) {
    const got = await takeFromChests(ctx, step.take, step.count);
    return got ? `took ${got} ${step.take}` : `no ${step.take} in the chests after all`;
  }
  for (const [item, n] of Object.entries(step.fromChest ?? {})) await takeFromChests(ctx, item, n);
  for (const pre of step.first ?? []) {
    const r = await ctx.act('craft-item', { outputItem: pre.craft, amount: pre.times });
    if (!r.ok) return `could not craft ${pre.craft}: ${r.text}`;
  }
  const r = await ctx.act('craft-item', { outputItem: step.craft, amount: step.times });
  return r.ok ? `crafted ${step.craft}${step.times > 1 ? ` x${step.times}` : ''}` : `could not craft ${step.craft}: ${r.text}`;
}

/**
 * The kit's own steps for some of its kinds only, planned and done as the kit goal does them (the work queue's `trip
 * kit`, worktasks.ts, which does from out in the yard what the kit goal does at home). What it did, a line a step.
 */
export async function kitSteps(ctx: GoalContext, kinds: readonly string[]): Promise<string[]> {
  const inv = await ctx.call<{ items: Snapshot['items'] }>('inventory');
  const needs = kitNeeds(ownItems(inv.items, ctx.world), freeChestTotals(ctx.world)).filter(n => kinds.includes(n.kind) && doable(n));
  const did: string[] = [];
  for (const need of needs) {
    for (const step of need.plan) {
      if (ctx.signal.aborted) return did;
      const r = await runStep(ctx, step);
      if (r) { did.push(r); ctx.progress(`${label(need)}: ${r}`); }
    }
  }
  return did;
}

// ------------------------------------------------------------------------------------------------ stock

/** Keep at least this much of each at home (carried and in the chests together). */
export const STOCK: { name: string; want: number; mine: string; counts: RegExp }[] = [
  { name: 'log', want: 32, mine: 'oak_log,birch_log,spruce_log,dark_oak_log,acacia_log,jungle_log,cherry_log', counts: /_log$/ },
  { name: 'cobblestone', want: 64, mine: 'stone,cobblestone', counts: /^(cobblestone|cobbled_deepslate)$/ },
  { name: 'coal', want: 16, mine: 'coal_ore,deepslate_coal_ore', counts: /^(coal|charcoal)$/ },
  { name: 'iron_ingot', want: 16, mine: 'iron_ore,deepslate_iron_ore', counts: /^(iron_ingot|raw_iron)$/ },
  // building materials: none kept in stock, fetched when a build job (or a project) asks for them
  { name: 'sand', want: 0, mine: 'sand', counts: /^sand$/ },
  { name: 'clay_ball', want: 0, mine: 'clay', counts: /^clay_ball$/ },
  { name: 'gravel', want: 0, mine: 'gravel', counts: /^gravel$/ },
  // (no sugar cane: the work queue's `cane patch` grows it and its `cane` rung walks for wild cane, within the leash,
  // one side a run, with marks that wait longer each time a side has none. The stock trips went for it 30 times from
  // Nov 10 to 12, a side chosen by the clock, and found none within 96 blocks of home every time)
  // fill for levelling (the yard growing, a site): grass dug gives dirt
  { name: 'dirt', want: 0, mine: 'dirt,grass_block', counts: /^dirt$/ },
  { name: 'andesite', want: 0, mine: 'andesite', counts: /^andesite$/ },
  { name: 'diorite', want: 0, mine: 'diorite', counts: /^diorite$/ },
  { name: 'granite', want: 0, mine: 'granite', counts: /^granite$/ }
];

/** After a trip that found none of something, leave it this long (try the next thing; what's near may be out of reach). */
const FRUITLESS_WAIT = 30 * MINUTE;

/** The kit is waiting on a stock trip (iron for iron gear, coal for torches, ...), and raw ore at home won't do. */
const gearShort = (s: Snapshot, world: WorldMemory) => stockShort(s, world).some(t => t.gear);

/** What the home is short of whether or not a trip found none lately, as stockShort() lists it, and how it ranks. */
function stockRows(s: Snapshot, world: WorldMemory): { rows: { name: string; short: number; mine: string; counts: RegExp; gear: boolean }[]; rank: (t: { name: string }) => number } {
  // what a build job holds in the chests is its own, not the home's stock
  const chest = freeChestTotals(world);
  const have = (re: RegExp) => [...s.counts].filter(([n]) => re.test(n)).reduce((a, [, k]) => a + k, 0) +
    Object.entries(chest).filter(([n]) => re.test(n)).reduce((a, [, k]) => a + k, 0);
  const extra: Record<string, number> = {};
  for (const n of kitNeeds(s.items, chest)) {
    for (const st of n.plan) if ('gather' in st) for (const [k, v] of Object.entries(st.gather)) extra[k] = (extra[k] ?? 0) + v;
  }
  // raw iron at home is iron the smelter turns into ingots: not a reason to mine more
  if (extra.iron_ingot) {
    const raw = (s.counts.get('raw_iron') ?? 0) + (chest.raw_iron ?? 0);
    extra.iron_ingot = Math.max(0, extra.iron_ingot - raw);
    if (!extra.iron_ingot) delete extra.iron_ingot;
  }
  // what the project in hand and the LLM's build jobs are short of (their bills broken down to raw materials)
  const project = allNeeds(world);
  // a project short of a particular wood's logs mines that wood
  const woods = Object.keys(project).filter(k => /_log$/.test(k)).map(k => ({ name: k, want: 0, mine: k, counts: new RegExp(`^${k}$`) }));
  const rows = [...STOCK, ...woods].map(t => ({ ...t, gear: (extra[t.name] ?? 0) > 0, short: Math.max(extra[t.name] ?? 0, t.want - have(t.counts), project[t.name] ?? 0) }))
    .filter(t => t.short > 0);
  // what the kit is waiting for first, then what a project or a build job is short of, then the home's own stock: the
  // home's "32 logs of any kind" came first, and with 30 carried every trip to the woods (160 blocks out) brought back
  // the 2 that topped it up, while the storage house waited for its oak
  const rank = (t: { name: string }) => (extra[t.name] ? 2 : (project[t.name] ?? 0) > 0 ? 1 : 0);
  return { rows, rank };
}

/** How short the home is of each stock item (kit gathering needs on top), most urgent first. */
export function stockShort(s: Snapshot, world: WorldMemory): { name: string; short: number; mine: string; counts: RegExp; gear: boolean }[] {
  const { rows, rank } = stockRows(s, world);
  return rows.filter(t => since(world, `fruitless:${t.name}`, s.now) > FRUITLESS_WAIT).sort((a, b) => rank(b) - rank(a));
}

/** What it is short of and leaves alone for now, a trip having found none lately; `until`: when it is tried again. */
function stockDry(s: Snapshot, world: WorldMemory): { name: string; short: number; until: number }[] {
  return stockRows(s, world).rows.filter(t => !(since(world, `fruitless:${t.name}`, s.now) > FRUITLESS_WAIT))
    .map(t => ({ name: t.name, short: t.short, until: (world.lastDone?.[`fruitless:${t.name}`] ?? 0) + FRUITLESS_WAIT }));
}

/** How far round the bot a tree counts as in sight for a wood trip (Baritone's miner finds what's loaded near it). */
const WOOD_SIGHT = 64;
export const WOODS_DIRS = ['north', 'east', 'south', 'west'] as const;

/**
 * Where a wood trip can mine: here if a tree of one of `kinds` is in sight; else the woods it found before; else it
 * looks for trees round home (each side in turn, within its leash) and remembers where it found them. A home out on
 * the plains had no tree within 96 blocks once its first few were felled: every trip found nothing and the storage
 * house waited for its logs all day. `text` says what it did; ok false when there are no woods within reach.
 */
export async function toTheWoods(ctx: Pick<GoalContext, 'call' | 'act' | 'world' | 'progress' | 'status' | 'signal' | 's'>, kinds: string[], ownOnly = false,
  opts: { zone?: string; what?: string; dirs?: readonly (typeof WOODS_DIRS)[number][] } = {}): Promise<{ ok: boolean; text: string }> {
  // the same search for other wild things (sugar cane), remembered under their own zone, a side or two per call
  const { zone = 'woods', what = 'woods', dirs = WOODS_DIRS } = opts;
  const thing = zone === 'woods' ? 'tree' : kinds[0].replace(/_/g, ' ');
  // a tree, not a log of its own: none in the yard or on a site the yard's projects keep (the storage house is logs)
  const y = ctx.world.yard;
  const sites = [...Object.values(ctx.world.zones ?? {}).flat().filter(b => b.width && b.length), ...reservedSites(ctx.world.progress)];
  const ours = (p: Pos) => (y && p.x >= y.x1 - 1 && p.x <= y.x2 + 1 && p.z >= y.z1 - 1 && p.z <= y.z2 + 1) ||
    sites.some(b => p.x >= b.x - 1 && p.x <= b.x + b.width! && p.z >= b.z - 1 && p.z <= b.z + b.length!);
  const inSight = async () => {
    for (const block of kinds) {
      const r = await ctx.call<{ positions: Pos[] }>('world.findBlocks', { block, maxDistance: WOOD_SIGHT, count: 24 }).catch(() => ({ positions: [] as Pos[] }));
      if (r.positions.some(p => !ours(p))) return true;
    }
    return false;
  };
  // ownOnly: the logs in sight are the bot's own builds (the storage house's posts), not trees
  if (!ownOnly && await inSight()) return { ok: true, text: '' };
  const zones = (ctx.world.zones ??= {});
  const known = zones[zone]?.[0];
  if (known) {
    ctx.progress?.(`no ${thing} in sight: to the ${what} at (${known.x}, ${known.z})`);
    // (out of the yard by the gate on the way, and home in by one between the sides: yardgates.ts)
    await leaveYard(ctx, known);
    await ctx.act('move-to-position', { ...known, range: 6, timeoutMs: 150_000 });
    if (await inSight()) return { ok: true, text: `off to the ${what} at (${known.x}, ${known.z})` };
    delete zones[zone]; // felled, or not there after all: look again
  }
  const reach = Math.min(Math.max(ctx.world.leash ?? 96, 48), 160);
  for (const direction of dirs) {
    ctx.progress?.(`no ${thing} in sight: looking ${direction} for ${kinds[0]}`);
    // out by that side's gate, and from there no further than the reach is from home (explore counts from the gate)
    const left = await exploreReach(ctx, await leaveYard(ctx, direction), reach);
    const r = left >= EXPLORE_MIN ? await ctx.act('explore', { target: kinds[0], direction, maxDistance: left, step: 32, timeoutMs: 90_000 }) : { ok: false, text: '' };
    const m = /^Found [a-z_]+ at \((-?\d+), (-?\d+), (-?\d+)\)/.exec(r.text);
    if (m) {
      const at = { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
      zones[zone] = [at];
      // explore says so as soon as it sees one, maybe 60 blocks off: Baritone's miner found no path from there
      await ctx.act('move-to-position', { ...at, range: 6, timeoutMs: 150_000 });
      return { ok: true, text: `found ${what} ${direction} at (${at.x}, ${at.z})` };
    }
    await goHome(ctx, 300_000).catch(() => undefined);
  }
  return { ok: false, text: `no ${kinds[0]} within ${reach} blocks of home ${dirs.length === WOODS_DIRS.length ? 'on any side' : dirs.join(', ')}` };
}

/**
 * Run now? The "no" is said in this order: no home to bring it to; the chests not looked in (what is short cannot be
 * told); nothing short, or only what the trips found none of lately; then what keeps a trip from what is short (out
 * of the leash, hurt or hungry, no room); the hour last.
 */
const stockGate = (s: Snapshot, world: WorldMemory): Gate => {
  if (s.dimension !== 'overworld' || !s.home) return no.away(s, 'stock', world.leash);
  // the kit goal looks in them first
  const unseen = world.landmarks.chests.filter(c => !world.chestItems?.[key(c)]).length;
  if (unseen) return { cause: 'kit', text: `${unseen} home chest(s) not looked in yet` };
  const short = stockShort(s, world);
  if (!short.length) {
    const dry = stockDry(s, world);
    return dry.length ? { cause: 'dry', text: `no ${dry.map(t => `${t.name} (${t.short} short)`).join(', ')} found lately`, until: Math.min(...dry.map(t => t.until)) }
      : { cause: 'stocked', text: 'nothing short' };
  }
  if (s.distHome > world.leash) return no.away(s, 'stock', world.leash);
  if (s.health < 14 || s.food < 10) return no.health(s, 'stock', 14, 10);
  // three slots free, or the stash able to make them (the run does that on its way out)
  if (room('trip', s, world) === 'no') return noRoom('trip', 'stock', s, world);
  // under 2.5 minutes of daylight: not worth setting out
  return no.late(s, 'stock', 3000) ?? { want: `short of ${short.map(t => `${t.short} ${t.name}`).join(', ')}` };
};

/**
 * A materials trip by day: mine what the home is shortest of near home, timeboxed to be back before the evening, and
 * home again afterwards. Never low on food or hurt, and with three slots free: it puts things away first if it must.
 */
export const stock: Goal = {
  name: 'stock',
  priority: 33,
  // materials for the gear go with the gear (second only to staying alive); the rest is home upkeep
  // build jobs' materials just under the job itself (3.5)
  urgency: (s, world) => (gearShort(s, world) ? 64 : activeJobs(world).some(j => j.need) ? 43 : 33),
  timeoutMs: 12 * MINUTE,
  retryMs: 8 * MINUTE,
  gate: stockGate,
  ...fromGate(stockGate),
  run: async run => {
    // room for what it goes for, before it leaves: home to the chests where the pockets are too full. The trip is
    // then planned from the bot as it is after that: what it still carries of the thing (the count to mine up to
    // starts there, and the stash may just have put the logs away), and the hour
    const ctx: GoalContext = { ...run, s: await makeRoom(run, 'trip') };
    const [t] = stockShort(ctx.s, ctx.world);
    if (!t) return 'nothing short';
    const carried = [...ctx.s.counts].filter(([n]) => t.counts.test(n)).reduce((a, [, k]) => a + k, 0);
    // back home by the evening: daylight left less a 90 s walk home
    const budget = Math.min(6 * MINUTE, daylightLeft(ctx.s.timeOfDay) * 50 - 90_000);
    if (budget < 60_000) return 'too late in the day';
    // wood with no tree in sight (a home out on the plains): off to the woods first, remembered or looked for
    if (/_log(,|$)/.test(t.mine)) {
      const woods = await toTheWoods(ctx, t.mine.split(','));
      if (!woods.ok) {
        done(ctx.world, `fruitless:${t.name}`, ctx.s.now);
        await goHome(ctx, 300_000).catch(() => undefined);
        return woods.text;
      }
      if (woods.text) ctx.progress(woods.text);
    }
    ctx.progress(`mining ${t.mine.split(',')[0]} for ${Math.round(budget / 1000)}s`);
    // Baritone's miner mines nothing in the home area: out of the yard by the nearest gate first, not over the fence
    // to whatever it finds nearest (yardgates.ts)
    await leaveYard(ctx);
    // as much as the trip's time allows (a build job's whole bill, not a stack at a time)
    let r = await ctx.act('mine-blocks', { block: t.mine, count: carried + Math.min(t.short, 256), timeoutMs: budget });
    ctx.progress(r.text.slice(0, 160));
    // the only logs in sight were its own (the storage house's posts are oak): off to the woods, and mine there
    // (the trip saw "trees" at home, mined nothing, and the storage house stayed 3 logs short all afternoon)
    if (/_log(,|$)/.test(t.mine) && /isn't part of a build|Unable to find any path/.test(r.text) && /Mined 0 |nothing gained/.test(r.text)) {
      const woods = await toTheWoods(ctx, t.mine.split(','), true);
      if (woods.ok) {
        ctx.progress(woods.text);
        r = await ctx.act('mine-blocks', { block: t.mine, count: carried + Math.min(t.short, 256), timeoutMs: budget });
        ctx.progress(r.text.slice(0, 160));
      }
    }
    if (/nothing gained|in sight outside the home area/.test(r.text)) done(ctx.world, `fruitless:${t.name}`, ctx.s.now);
    // a project's shortfall is served once per trip: the project works out what's still short when it next runs
    // (left standing, it had the bot fetch 22 more birch logs trip after trip)
    const need = ctx.world.progress?.need;
    if (need && t.name in need) { delete need[t.name]; if (!Object.keys(need).length) ctx.world.progress!.need = undefined; }
    for (const j of activeJobs(ctx.world)) if (j.need && t.name in j.need) { delete j.need[t.name]; if (!Object.keys(j.need).length) j.need = undefined; }
    // Baritone's mine follows the ore down into the caves: from down there it climbs out first (homeward.ts)
    const back = await walkHome(ctx, { timeoutMs: 300_000 });
    if (!back.ok) throw new Error(`mined, but could not get home: ${back.text}`);
    if (!r.ok) throw new Error(r.text);
    return `${r.text.slice(0, 120)}; back home`;
  }
};

// ------------------------------------------------------------------------------------------------ lights

/** How far around home the yard is kept lit. */
export const YARD_RADIUS = 16;

type Io = Pick<GoalContext, 'call' | 'act'> & { progress?: (t: string) => void };
export interface LightReport { box: Box; dark: Pos[]; placed: Pos[]; undone: Pos[]; left: Pos[] }
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * The dark spots (block light 0, where monsters spawn since 1.18) a mob could stand on around a point, and with
 * `place`, torches for them as the plan puts them, each one checked against the real light: the plan's light model
 * goes through walls, and the daily round kept putting two torches by an enclosed air pocket that they never lit,
 * every day. A torch that lights no dark spot is taken back up. `ignore` holds spots to leave out ("x,y,z"); `before`
 * goes before each torch (the band's: out of the yard by a gate first, as place-block's own walk to it went over the
 * fence).
 */
export async function lightArea(io: Io, centre: Pos, radius: number, opts: { place: boolean; max: number; ignore: Set<string>; only?: (p: Pos) => boolean; before?: (t: Pos) => Promise<unknown> }): Promise<LightReport> {
  const box = yardBox(centre, radius);
  const mask = (p: Pos) => !opts.ignore.has(key(p)) && (opts.only?.(p) ?? true);
  // in slabs of whole layers: one region call holds at most 65536 blocks, and the square round an 82 x 26 yard is
  // 85 x 85 x 13 (the round failed every day, the yard stayed dark, and creepers took bits of the watchtower)
  const slabs = async <T>(rpc: string, field: string): Promise<T[]> => {
    const layers = Math.max(1, Math.floor(65_536 / (box.width * box.length)));
    const out: T[] = [];
    for (let y = 0; y < box.height; y += layers) {
      const part = await io.call<Record<string, T[]>>(rpc, { ...box, y: box.y + y, height: Math.min(layers, box.height - y) }, 60_000);
      out.push(...part[field]);
    }
    return out;
  };
  const read = async () => {
    const blocks = await slabs<string | null>('world.region', 'blocks');
    const block = await slabs<number>('world.light', 'block');
    return { blocks, block, dark: spawnableCells(box, blocks, block, { mask }) };
  };
  let now = await read();
  const report: LightReport = { box, dark: now.dark, placed: [], undone: [], left: now.dark };
  if (!opts.place || !now.dark.length) return report;
  const plan = planTorches(box, now.blocks, now.block, { prefer: centre, max: opts.max, mask });
  for (const t of plan.torches) {
    if (!now.dark.length) break;
    await opts.before?.(t);
    const r = await io.act('place-block', { ...t, faceDirection: 'down', item: 'torch' });
    if (!/^Placed/.test(r.text)) { io.progress?.(`torch at ${key(t)}: ${r.text}`); continue; }
    await pause(500); // the client relights a moment after the block update
    const after = await read();
    if (after.dark.length >= now.dark.length) {
      await io.act('dig-block', { ...t, collect: true });
      report.undone.push(t);
      io.progress?.(`torch at ${key(t)} lit nothing dark: took it back`);
      now = await read();
    } else {
      report.placed.push(t);
      now = after;
    }
  }
  report.left = now.dark;
  return report;
}

/** Torches kept back for the mine and the trips (the kit's own count). */
const TORCH_RESERVE = 16;
/** A day's torches for the band outside the fence, and for the routes. */
const BAND_PER_DAY = 8;
const PATH_PER_DAY = 6;
/** The band outside the fence: 2 to 12 blocks out. */
const BAND = { from: 2, to: 12 };

/** Where to throw junk: 8 out from the middle of the yard's least walked side (heat summed within 6 of each spot). */
export function dumpSpot(yard: { x1: number; z1: number; x2: number; z2: number; y: number }, heat?: HeatMap): { x: number; y: number; z: number } {
  return dumpSpots(yard, heat)[0];
}

/** The four dump spots, the least walked first: one may be in a hill or a lake (the east one was in stone). */
export function dumpSpots(yard: { x1: number; z1: number; x2: number; z2: number; y: number }, heat?: HeatMap): { x: number; y: number; z: number }[] {
  const mx = Math.round((yard.x1 + yard.x2) / 2), mz = Math.round((yard.z1 + yard.z2) / 2), out = 8;
  const spots = [{ x: mx, z: yard.z1 - out }, { x: mx, z: yard.z2 + out }, { x: yard.x1 - out, z: mz }, { x: yard.x2 + out, z: mz }];
  const warmth = (p: { x: number; z: number }) => {
    let h = 0;
    for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) h += heat?.get(p.x + dx, p.z + dz) ?? 0;
    return h;
  };
  return spots.map(p => ({ p, h: warmth(p) })).sort((a, b) => a.h - b.h).map(({ p }) => ({ ...p, y: yard.y + 1 }));
}

/**
 * Once a day, in order, while torches last: the yard (none dark, spots no torch reached are left out from then on);
 * a band 2 to 12 blocks outside the fence, nearest first, a few a day, so mobs don't spawn right at the fence; and
 * the dark stretches of the routes the bot walks most (the heat map the brain keeps), a torch every 10 blocks.
 */
export const lights: Goal = {
  name: 'lights',
  priority: 36,
  timeoutMs: 12 * MINUTE,
  retryMs: 15 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || !awakeForRound(s, world) || (s.counts.get('torch') ?? 0) === 0) return null;
    // after 20 min, and then in the evening, or when no trip could go instead (or it has waited 40): the morning is the trips'
    return roundDue(s, world, 'lights', 20 * MINUTE) ? 'daily round: dark spots in the yard' : null;
  },
  // within 10 of home it cuts in as ever; from out in the yard it waits for what runs to end
  cuts: s => nearHome(s, NEAR_HOME),
  // a round that finds the yard lit placed nothing: busy time to no gain
  gains: true,
  run: async run => {
    // from out in the yard, home first (on foot): the round as it always started, from within 10 of home
    const ctx: GoalContext = { ...run, s: await toRound(run, NEAR_HOME) };
    done(ctx.world, 'lights', ctx.s.now);
    const ignore = new Set(ctx.world.darkIgnore ?? []);
    const yard = ctx.world.yard;
    const centre = yard ? { x: Math.round((yard.x1 + yard.x2) / 2), y: yard.y + 1, z: Math.round((yard.z1 + yard.z2) / 2) } : ctx.s.home!;
    const radius = yard ? Math.ceil(Math.max(yard.x2 - yard.x1, yard.z2 - yard.z1) / 2) + 1 : YARD_RADIUS;
    let torches = ctx.s.counts.get('torch') ?? 0;
    const out: string[] = [];

    const r = await lightArea(ctx, centre, radius, { place: true, max: torches, ignore, only: yard ? p => outsideBy(yard, p) === 0 : undefined });
    torches -= r.placed.length;
    ctx.gain(r.placed.length);
    // what no torch reached is out of reach for this plan (enclosed, or out of the bot's reach): leave it be
    ctx.world.darkIgnore = [...new Set([...(ctx.world.darkIgnore ?? []), ...r.left.map(key)])].slice(-500);
    out.push(!r.dark.length ? 'the yard is lit' : `yard: placed ${r.placed.length} torch(es)${r.undone.length ? `, took back ${r.undone.length} that lit nothing` : ''}; ` +
      `${r.left.length} of ${r.dark.length} dark spot(s) left${r.left.length ? ' (left out from now on)' : ''}`);
    if (!yard || ctx.signal.aborted) return out.join('; ');

    // the band outside the fence (not remembered as left out: there's always more of it than a day's torches)
    if (torches > TORCH_RESERVE) {
      ctx.progress('lighting the band outside the fence');
      // (place-block walks into reach by Baritone's own way: from the yard, out by the gate on the way first)
      const b = await lightArea(ctx, centre, Math.min(radius + BAND.to, 34), {
        place: true, max: Math.min(BAND_PER_DAY, torches - TORCH_RESERVE), ignore,
        only: p => { const d = outsideBy(yard, p); return d >= BAND.from && d <= BAND.to; },
        before: t => leaveYard(ctx, t)
      });
      torches -= b.placed.length;
      ctx.gain(b.placed.length);
      out.push(`outside the fence: ${b.placed.length} torch(es), ${b.left.length} dark spot(s) to go`);
    }

    // the routes beyond the band
    if (torches > TORCH_RESERVE && ctx.world.heat && !ctx.signal.aborted) {
      const spots = pathTorchSpots(HeatMap.fromJSON(ctx.world.heat), () => true, 10, (x, z) => outsideBy(yard, { x, z }) <= BAND.to, 3);
      let lit = 0, tried = 0;
      for (const spot of spots) {
        if (lit >= PATH_PER_DAY || torches <= TORCH_RESERVE || tried >= 3 * PATH_PER_DAY || ctx.signal.aborted) break;
        tried++;
        const y = Math.floor(ctx.s.position.y);
        const p = await lightArea(ctx, { x: spot.x, y: Math.min(y, yard.y + 1), z: spot.z }, 3, { place: true, max: 1, ignore, before: t => leaveYard(ctx, t) });
        if (p.placed.length) { lit++; torches--; ctx.gain(1); ctx.progress(`a torch on the route at (${spot.x}, ${spot.z})`); }
      }
      if (tried) out.push(`routes: ${lit} torch(es) (${tried} of ${spots.length} spot(s) looked at)`);
    }
    return out.join('; ');
  }
};


// ------------------------------------------------------------------------------------------------ farm

/**
 * Harvest and replant every plot (the farm tool works around where the bot stands): each crop plot from its middle,
 * and the farmland outside the plots from its own middle.
 */
export async function farmAll(ctx: GoalContext): Promise<{ ok: boolean; text: string }> {
  const plots = ctx.world.zones?.plot ?? [];
  const inPlot = (f: Pos) => plots.some(p => f.x >= p.x && f.x < p.x + (p.width ?? 9) && f.z >= p.z && f.z < p.z + (p.length ?? 9));
  const loose = ctx.world.landmarks.farmland.filter(f => !inPlot(f));
  // each plot from just outside its north edge (Baritone won't path onto farmland), far enough to reach its far side
  const spots: { at: Pos; range: number }[] = plots.map(p => ({ at: { x: p.x + Math.floor((p.width ?? 9) / 2), y: p.y + 1, z: p.z - 1 }, range: (p.length ?? 9) + 2 }));
  if (loose.length) spots.push({ at: farmCentre({ ...ctx.world, landmarks: { ...ctx.world.landmarks, farmland: loose } })!, range: 12 });
  const out: string[] = [];
  let ok = true;
  for (const sp of spots) {
    if (ctx.signal.aborted) break;
    // short of the spot but near it will do: the farm works around wherever the bot ends up
    await ctx.act('move-to-position', { ...sp.at, range: 3, timeoutMs: 90_000 }).catch(() => undefined);
    const r = await ctx.act('farm', { range: sp.range, timeoutMs: 180_000 });
    ctx.progress(r.text.slice(0, 160));
    out.push(r.text.slice(0, 100));
    ok &&= r.ok;
  }
  return { ok, text: out.join(' | ') || 'no farmland' };
}

/** Each morning: harvest what's ripe and replant (crops left ripe just sit there), and bake the wheat. */
export const farm: Goal = {
  name: 'farm',
  priority: 47,
  timeoutMs: 6 * MINUTE,
  retryMs: 15 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || !awakeAtHome(s) || !world.landmarks.farmland.length) return null;
    return since(world, 'farm', s.now) > 20 * MINUTE ? 'daily round: the farm' : null;
  },
  run: async ctx => {
    done(ctx.world, 'farm', ctx.s.now);
    const r = await farmAll(ctx);
    const inv = await ctx.call<{ items: { name: string; count: number }[] }>('inventory');
    const wheat = inv.items.filter(i => i.name === 'wheat').reduce((a, i) => a + i.count, 0);
    let baked = '';
    if (wheat >= 3) {
      const b = await ctx.act('craft-item', { outputItem: 'bread', amount: Math.floor(wheat / 3) });
      if (b.ok) baked = `; baked ${Math.floor(wheat / 3)} bread`;
    }
    if (!r.ok) throw new Error(r.text);
    return `${r.text.slice(0, 120)}${baked}`;
  }
};
