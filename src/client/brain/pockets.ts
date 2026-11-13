import type { InventoryItem } from '../tools.js';
import { nearHome, no, onHomeLevel, outsideBy, type Decline, type GoalContext, type Snapshot } from './goals.js';
import { key } from './chests.js';
import { roomFor } from './storage.js';
import type { WorldMemory } from './memory.js';
import { activityAt } from './schedule.js';
// chores.ts takes its constants from here and this file its plan from there: both only use the other's exports inside
// functions, so whichever of the two is loaded first, nothing is read before it is set
import { putAway, stashKeep, stashWork } from './chores.js';

/**
 * The pockets: the 36 slots the bot carries (never the chests). One rule says how much room a goal needs to set out
 * and whether the stash could make it, in place of a slot limit of its own in every goal (34 here, 33 there, 35 for
 * the project: the bot stood idle between them, each goal waiting for a stash that was waiting for a fuller pocket).
 */

/**
 * Free slots a goal needs to set out: a project step that only builds picks up next to nothing, a round in the yard
 * (cane, the pens, the farm) a kind or two, a trip for materials three stacks of what it went for, a trip down the
 * mine ten (ore, stone and what else a long way underground turns up).
 */
export const ROOM = { project: 1, yard: 2, trip: 3, deep: 10 } as const;
export type RoomKind = keyof typeof ROOM;

/** Near enough home for chores at the chests and furnace. */
export const NEAR_HOME = 10;
/** How far out (the yard, a build job's site) the stash still goes home to make room for a waiting trip. */
export const TRIP_STASH_RANGE = 40;
/**
 * A run of the work queue is under way (`work`), and it is a trip out or down (`trip`): work.ts raises and lowers
 * them round each run, the stash and the brain read them to leave such a run alone. `ledBy`: the run (its signal)
 * walking an animal home, on a lead or after its food (pens.ts), which the brain lets only survival cut short. Here, in the one module
 * both sides import. In this process only: after a restart nothing is under way.
 */
export const out: { trip: boolean; work: boolean; ledBy?: AbortSignal } = { trip: false, work: false };
/**
 * Most of one kind of food carried, a stack: the rest goes in the chests. All of it stayed carried before (live: 541
 * bread in nine slots, 265 in five the day before), slots a trip had no use for.
 */
export const FOOD_CARRY = 64;
/**
 * Enough of these in the chests (the stored total at or over the number) and the stash throws what it would store
 * away instead: with the storage house full of cobblestone (1205 stored) the pockets had nowhere to go. Only what
 * digging turns up by the hundred: never ore, tools, food, or a kind a bill carries or is short of.
 */
export const GLUT: Record<string, number> = {
  cobblestone: 640, cobbled_deepslate: 320, dirt: 320, gravel: 128, granite: 128, diorite: 128, andesite: 128, tuff: 128
};

const SLOTS = 36;
/** Slots the plans count a home chest as holding (storage.ts: a double chest's second half is room to spare). */
const CHEST_SLOTS = 27;
/**
 * How long a put-away that did not make a kind's room counts against asking for it again (the stash's own retry
 * time): the plan said the room could be made and the game said otherwise (no dump spot it could get to, a chest that
 * would not open), and the plan would say the same on the next tick.
 */
const TRIED_FOR = 10 * 60_000;
/** Who needs the room, for makeRoom's own words (it is called by kind, not by goal). */
const WHO: Record<RoomKind, string> = { project: 'a build', yard: 'a round in the yard', trip: 'a trip', deep: 'the mine' };

export interface Pockets {
  /** main slots in use (of 36) */
  used: number;
  free: number;
  /** slots the stash would empty now */
  loose: number;
}

/**
 * Slots the stash's body would empty with these pockets: its own plan (the same list, the same chests), then the
 * chests' room as last seen (27 slots each, one not looked in yet counted empty, as the plan itself counts), then the
 * game's own order of taking things out of the pockets. `chest.deposit` and `item.drop` go through the slots from the
 * first, a whole stack while the count still covers it, then part of the next: 6 cobblestone to put away out of
 * stacks of 64 and 6 empty the second slot only if it comes first, and topping a kept stack down frees nothing.
 */
function looseSlots(s: Snapshot, world: WorldMemory, kind?: RoomKind): number {
  const work = stashWork(s, world, stashKeep(world, kind));
  const chests = world.landmarks.chests.map(key);
  const held: Record<string, Record<string, number>> = {};
  for (const k of chests) held[k] = { ...(world.chestItems?.[k] ?? {}) };
  const goes = new Map<string, number>();
  const add = (name: string, n: number) => { if (n > 0) goes.set(name, (goes.get(name) ?? 0) + n); };
  for (const m of work.moves) {
    held[m.chest] ??= {};
    held[m.chest][m.name] = (held[m.chest][m.name] ?? 0) + m.count;
    add(m.name, m.count);
  }
  // the rest goes to the first chest with room, chest by chest (storeInChests)
  for (const e of work.rest) {
    let left = e.count;
    for (const k of chests) {
      if (left <= 0) break;
      const n = Math.min(left, roomFor(held[k], e.name, CHEST_SLOTS));
      if (n <= 0) continue;
      held[k][e.name] = (held[k][e.name] ?? 0) + n;
      left -= n;
    }
    add(e.name, e.count - left);
  }
  for (const e of work.drop) add(e.name, e.count);
  const main = s.items.filter(i => i.slot >= 0 && i.slot < SLOTS).sort((a, b) => a.slot - b.slot);
  let emptied = 0;
  for (const [name, count] of goes) {
    let left = count;
    for (const i of main) {
      if (i.name !== name) continue;
      if (left < i.count) break;
      left -= i.count;
      emptied++;
    }
  }
  return emptied;
}

/** The pockets now: used, free, and what the stash could empty (keeping what a goal of `kind` leaves carried). */
export function pockets(s: Snapshot, world: WorldMemory, kind?: RoomKind): Pockets {
  return { used: s.slotsUsed, free: Math.max(0, SLOTS - s.slotsUsed), loose: looseSlots(s, world, kind) };
}

/**
 * In the yard or near enough home: where the stash can be sent from, and where a trip down the mine sets out from.
 * Anywhere in the yard, however far it has grown (its far end is 64 from home now), as long as home stands in it.
 * On home's level: under the yard is not in it (Baritone may break nothing there, and the walk to the chests fails).
 */
export function inYardOrNear(s: Snapshot, world: WorldMemory): boolean {
  if (!s.home || !Number.isFinite(s.distHome) || !onHomeLevel(s.position, s.home)) return false;
  const yard = world.yard;
  return s.distHome <= TRIP_STASH_RANGE || (!!yard && outsideBy(yard, s.home) === 0 && outsideBy(yard, s.position) === 0);
}

/** Where the stash can be sent from: awake in the overworld with a home and chests, in the yard or near enough home. */
function chestsInReach(s: Snapshot, world: WorldMemory): boolean {
  if (s.sleeping || s.dimension !== 'overworld' || !world.landmarks.chests.length) return false;
  return inYardOrNear(s, world);
}

/**
 * How long ago (ms) makeRoom last put away for this kind and still fell short, while that counts (TRIED_FOR);
 * undefined otherwise. The mark is one more time in `lastDone`, by kind: a trip's put-away keeps less than a yard
 * round's, so one failing says nothing of the other.
 */
function triedAgo(kind: RoomKind, s: Snapshot, world: WorldMemory): number | undefined {
  const at = world.lastDone?.[`no room: ${kind}`];
  if (at === undefined) return undefined;
  const ago = s.now - at;
  return ago >= 0 && ago < TRIED_FOR ? ago : undefined;
}

/**
 * Room for a goal of this kind: `ok` with the free slots it needs; `stash` when the stash would make them and the bot
 * is where it can go and do so (the goal still wants, and its run starts with makeRoom); `no` otherwise, and for 10
 * min after a put-away for this kind that did not make them (with junk it could not get out to the dump, or a chest
 * that would not open, the plan said `stash` again at once: three failed runs in a row, and the goal was left until
 * morning). Read in the gates on every tick: it looks and never writes, and with room to spare it does no sums at all.
 */
export function room(kind: RoomKind, s: Snapshot, world: WorldMemory): 'ok' | 'stash' | 'no' {
  const free = Math.max(0, SLOTS - s.slotsUsed);
  if (free >= ROOM[kind]) return 'ok';
  if (!chestsInReach(s, world)) return 'no';
  if (triedAgo(kind, s, world) !== undefined) return 'no';
  return free + looseSlots(s, world, kind) >= ROOM[kind] ? 'stash' : 'no';
}

/**
 * What a goal says when its room is `no`, so the line never sends anyone looking for the wrong thing. A put-away that
 * just fell short is named first, where it alone is what says no (the plan would still make the room). Full chests
 * are named only when the storage house can take no more chests and nothing is loose (till then the storage goal is
 * adding one, or the stash has things to throw away); chests out of reach are told from pockets with too little to
 * put away, and those with some loose slots from those with none (the stash still runs for the first).
 */
export function noRoom(kind: RoomKind, who: string, s: Snapshot, world: WorldMemory): Decline {
  const p = pockets(s, world, kind);
  const enough = p.free + p.loose >= ROOM[kind];
  const reach = chestsInReach(s, world);
  const tried = triedAgo(kind, s, world);
  if (enough && reach && tried !== undefined) return no.pockets(s, who, { free: ROOM[kind], failedMsAgo: tried });
  if (world.storageMaxedAt && !p.loose) return no.pockets(s, who, { free: ROOM[kind], chestsFull: true });
  return no.pockets(s, who, { free: ROOM[kind], outOfReach: enough && !reach, loose: p.loose });
}

/**
 * The bot as it is now (a run's snapshot is from when the run began): its pockets, where it stands, the hour. A home
 * round that walked home first goes on from this (work.ts toRound).
 */
export async function look(ctx: GoalContext): Promise<Snapshot> {
  const st = await ctx.status().catch(() => undefined);
  const inv = await ctx.call<{ items?: InventoryItem[] }>('inventory').catch(() => undefined);
  const items = Array.isArray(inv?.items) ? inv.items : ctx.s.items;
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.name, (counts.get(it.name) ?? 0) + it.count);
  const position = st?.position ?? ctx.s.position;
  const dimension = st?.dimension ?? ctx.s.dimension;
  const home = ctx.s.home;
  const timeOfDay = st?.timeOfDay ?? ctx.s.timeOfDay;
  return {
    ...ctx.s, items, counts, slotsUsed: items.filter(i => i.slot < SLOTS).length, position, dimension,
    timeOfDay, activity: activityAt(timeOfDay, st?.thundering ?? ctx.s.thundering),
    sleeping: st?.sleeping ?? ctx.s.sleeping,
    distHome: home && home.dimension === dimension ? Math.hypot(home.x - position.x, home.z - position.z) : Infinity
  };
}

/**
 * Make the room a goal of this kind needs before it sets out: nothing with room enough; else home to the chests and
 * the stash's own body, keeping what a goal of this kind leaves carried. It throws when the room is not made, and
 * says which way: `pockets: ...` with the rule's own reason when nothing was tried (nothing or too little to put
 * away, the chests full, too far out to go), `pockets still N/36 after putting away` with what stood in the way when
 * the body ran and fell short (it then leaves the mark `room` reads, so the goal does not ask again for 10 min); and
 * `aborted` when the brain stops the run. The body can walk to the dump spot and back: a goal that calls this gives
 * it a few minutes of its time.
 *
 * It answers with the bot as it is afterwards (pockets, place, hour): the run's own snapshot is from before the walk
 * home and the stash, and a run that went on counting from it would take the wheat just put away for carried. With
 * room on the run's own snapshot (the tick that started the run took it a moment ago) nothing is asked of the game
 * and that snapshot is the answer.
 */
export async function makeRoom(ctx: GoalContext, kind: RoomKind): Promise<Snapshot> {
  if (room(kind, ctx.s, ctx.world) === 'ok') return ctx.s;
  const stopped = () => { if (ctx.signal.aborted) throw new Error('aborted'); };
  let s = await look(ctx);
  const first = room(kind, s, ctx.world);
  if (first === 'ok') return s;
  // nothing was tried: the reason in the words a gate would give it
  if (first === 'no') throw new Error(`pockets: ${noRoom(kind, WHO[kind], s, ctx.world).text}`);
  stopped();
  if (s.home && !nearHome(s, NEAR_HOME)) {
    // the body needs the chests. On foot only, as the chest tools' own first walk is: nothing placed or dug on the way
    // (scaffold a walk left in the storage house blocked the home cell for a whole evening). To within 3 of the home
    // cell, which the chests stand round; where this walk stops short, the chest tools walk the rest as they do today
    ctx.progress(`${s.slotsUsed}/${SLOTS} slots: home to the chests to make room`);
    await ctx.call('goto', { x: s.home.x, y: s.home.y, z: s.home.z, range: 3, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => undefined);
    stopped();
    s = await look(ctx);
  }
  // what stood in the way, where something did: a chest that would not open (thrown), no dump spot it could get to
  // (the body's note). What counts is the room there is now
  let why: string | undefined;
  try {
    why = (await putAway(ctx, s, stashKeep(ctx.world, kind))).note;
  } catch (e) {
    stopped();
    why = (e as Error).message;
    ctx.progress(`making room: ${why}`);
  }
  stopped();
  s = await look(ctx);
  if (SLOTS - s.slotsUsed < ROOM[kind]) {
    // the body ran and fell short: the plan would promise the same room again on the next tick, so leave the mark
    // that makes `room` say no for a while (not where nothing was tried, and not when the brain stopped the run)
    (ctx.world.lastDone ??= {})[`no room: ${kind}`] = s.now;
    throw new Error(`pockets still ${s.slotsUsed}/${SLOTS} after putting away${why ? `: ${why}` : ''}`);
  }
  return s;
}
