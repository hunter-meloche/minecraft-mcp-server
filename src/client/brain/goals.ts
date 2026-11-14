import type { InventoryItem, Status } from '../tools.js';
import { tier } from './kit.js';
import { daylightLeft, type Activity } from './schedule.js';
import type { Pos, WorldMemory } from './memory.js';
import type { IdleCause } from './idlelog.js';
// (underyard.ts takes BELOW_HOME from here: each uses the other's exports inside functions only)
import { underNow } from './underyard.js';
// (homeward.ts takes BELOW_HOME from here too, and the walk home is used inside the runs only)
import { walkHome } from './homeward.js';

/** What the brain knows at one moment: read fresh each tick. */
export interface Snapshot {
  /** real time, ms */
  now: number;
  timeOfDay: number;
  activity: Activity;
  health: number;
  food: number;
  position: Pos;
  dimension: string;
  sleeping: boolean;
  raining: boolean;
  thundering: boolean;
  /** the Baritone process running, if any */
  process: string | null;
  items: InventoryItem[];
  counts: Map<string, number>;
  /** main inventory slots in use (of 36) */
  slotsUsed: number;
  home?: Pos & { dimension: string };
  /** other players' builds the mod has seen (zones), and the nearest one's distance */
  /** others' builds the mod has seen: how many, how many on the surface, the nearest on the surface (straight line) */
  foreign?: { zones: number; surface?: number; nearest: number | null };
  /** horizontal distance to home; Infinity with no home or in another dimension */
  distHome: number;
  /** boxed in where it stands (see Status.boxedIn): the wall cells to dig out, if it built them */
  boxedIn?: Pos[];
  /** experience level (enchanting costs up to 30) */
  xpLevel?: number;
}

export interface GoalContext {
  s: Snapshot;
  world: WorldMemory;
  signal: AbortSignal;
  /** run a client tool (the same code the LLM calls) */
  act: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  call: <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  status: () => Promise<Status>;
  /** log a step as it happens (a job stopped midway still shows what it got done) */
  progress: (text: string) => void;
  /**
   * what the run has brought in so far (items, blocks placed, animals: whatever the goal counts); the brain adds it
   * up as it goes, so a run stopped midway keeps what it got. A `gains` goal that ends with none was busy to no gain
   */
  gain: (n: number) => void;
}

/**
 * Why a goal does not ask to run now: the cause the idle time is booked under, a short text for the log and
 * brain-status, and when it lifts (real ms) where that is known.
 */
export interface Decline { cause: IdleCause; text: string; until?: number }

/** A goal's one answer to "run now?": the reason to, or why not. */
export type Gate = { want: string } | Decline;

/**
 * One behaviour, like a mob AI goal: it says when it wants to run (and why), and how. The brain runs the most
 * urgent one that wants to; a more urgent one can stop it midway.
 */
export interface Goal {
  name: string;
  /** higher runs first and may interrupt lower */
  priority: number;
  /** a priority that changes with the state (a project waiting too long moves up); default: priority */
  urgency?: (s: Snapshot, world: WorldMemory) => number;
  /** why it should run now, or null */
  wants: (s: Snapshot, world: WorldMemory) => string | null;
  /** does the work; returns what it did, throws when it failed */
  run: (ctx: GoalContext) => Promise<string>;
  /** stopped after this long */
  timeoutMs: number;
  /** wait after a failure before trying again */
  retryMs: number;
  /**
   * how long three failures in a row hold it back (absent: until the next morning). A goal that gets the bot out of
   * where it is stuck cannot be left for the night: break out's morning hold, after waiting on a zombie that never
   * despawns, left the bot walled in 55 under the yard
   */
  failHoldMs?: number;
  /** can a more urgent goal stop it midway (default yes) */
  interruptible?: boolean;
  /** may run while the bot is in bed (everything else waits for morning) */
  whileAsleep?: boolean;
  /** the one place it is decided: wants() and declines() both come from it (fromGate), so they cannot disagree */
  gate?: (s: Snapshot, world: WorldMemory) => Gate;
  /**
   * why it does not want to run now, for the idle log and brain-status; null when it does. No calls, and nothing
   * written, ever: it is asked where the brain decides nothing (another goal running, this one kept back, the LLM
   * driving, the autopilot off). A gate that writes down what it finds (the project's: a milestone already in place)
   * gives the same "no" here as a look only, not through fromGate
   */
  declines?: (s: Snapshot, world: WorldMemory) => Decline | null;
  /** it reports what it brings in through ctx.gain: a run that ends with none is booked as busy to no gain */
  gains?: true;
  /**
   * Is its want worth stopping a running goal for (absent: it is, as every goal's was)? A goal that answers no still
   * wants: it waits for the running goal to end and takes over at the hand-over, and with nothing running it starts
   * as ever. Asked on every tick a less urgent goal runs: a look only. The survival goals are never asked.
   */
  cuts?: (s: Snapshot, world: WorldMemory) => boolean;
}

/**
 * wants() and declines() from one gate: a goal that said "no" in one and nothing in the other is how idle time went
 * unexplained. Use as `{ name, ..., gate, ...fromGate(gate) }`.
 */
export const fromGate = (g: (s: Snapshot, w: WorldMemory) => Gate): Pick<Goal, 'wants' | 'declines'> => ({
  wants: (s, w) => { const r = g(s, w); return 'want' in r ? r.want : null; },
  declines: (s, w) => { const r = g(s, w); return 'want' in r ? null : r; }
});

/** game ticks as minutes of real time, to one place (a tick is 50 ms) */
const tickMin = (ticks: number) => (ticks * 50 / 60_000).toFixed(1);

/**
 * Home is a place on its level, not a column of the world: more than BELOW_HOME under the level of home (or more than
 * ABOVE_HOME over it) the bot is not at home, however near it stands across the ground. Live on Nov 12 a deep trip's
 * mining took the bot under the yard's edge, 16 from home across the ground and 55 below it, and every home chore took
 * that for home: the stash ("chest too far to open"), the tree and cane rounds, and smelt cut three deep trips short
 * inside the trip rule. The leash and every "how far out" (trip budgets, sides, sites, the mine start) stay across the
 * ground: distHome.
 */
export const BELOW_HOME = 8;
export const ABOVE_HOME = 16;

/** On the level of home: not more than BELOW_HOME under it, nor ABOVE_HOME over it (with no home or no place known, nothing to say). */
export const onHomeLevel = (p: { y: number } | undefined, home?: { y: number }): boolean =>
  !home || !p || !Number.isFinite(p.y) || (p.y >= home.y - BELOW_HOME && p.y <= home.y + ABOVE_HOME);

/**
 * Within `range` of home across the ground and on its level: where its chests, furnace, bed and rounds are in reach.
 * Every "near home" a chore judges by asks this, not distHome alone.
 */
export const nearHome = (s: Pick<Snapshot, 'home' | 'position' | 'distHome'>, range: number): boolean =>
  s.distHome <= range && onHomeLevel(s.position, s.home);

/** The same for a place seen during a run (the run's snapshot is from before it set out). */
export const nearHomeAt = (p: Pos, home: Pos, range: number): boolean =>
  Math.hypot(p.x - home.x, p.z - home.z) <= range && onHomeLevel(p, home);

/** Off home's level, in words (`55 below it`), for the lines that say why a chore is not run from here. */
const offLevel = (s: Pick<Snapshot, 'home' | 'position'>): string | undefined => {
  if (!s.home || onHomeLevel(s.position, s.home)) return undefined;
  const by = Math.round(s.home.y - s.position.y);
  return by > 0 ? `${by} below it` : `${-by} above it`;
};

/**
 * Why the stash cannot make the `free` slots a goal needs (pockets.ts noRoom): the chests have no room left, are too
 * far off to put anything in, the stash would empty only `loose` slots, or a put-away tried `failedMsAgo` and did not
 * make the room.
 */
export interface PocketsLack { free: number; chestsFull?: boolean; outOfReach?: boolean; loose?: number; failedMsAgo?: number }

/** the lack in words: the failed put-away first (it is what holds the goal back now), then where the chests are */
function lacking(from: PocketsLack): string {
  if (from.failedMsAgo !== undefined) {
    const min = Math.floor(from.failedMsAgo / 60_000);
    return `the stash made no room ${min < 1 ? 'just now' : `${min} min ago`}`;
  }
  if (from.outOfReach) return 'the chests out of reach';
  return from.loose ? `only ${from.loose} more to put away` : 'nothing to put away';
}

/**
 * The declines the gates share: the same words wherever they are said, each with its numbers and with who says it
 * (`35/36 slots (cane runs under 34)`), so a line in the idle log can be acted on without reading the goal.
 */
export const no = {
  /** no home, another dimension, or further out than the goal works from */
  away: (s: Snapshot, who: string, within: number): Decline => ({
    cause: 'away',
    text: !s.home ? 'no home set' : s.dimension !== 'overworld' ? `in ${s.dimension}` : !Number.isFinite(s.distHome) ? 'no distance to home'
      // (under the yard, 16 across the ground, is not "within 24": the line says where the bot is)
      : offLevel(s) ? `${Math.round(s.distHome)} blocks from home and ${offLevel(s)} (${who} works within ${within}, on home's level)`
        : `${Math.round(s.distHome)} blocks from home (${who} works within ${within})`
  }),
  /** under the health (and, where the goal asks for it, the food) it sets out with */
  health: (s: Snapshot, who: string, health: number, food?: number): Decline => ({
    cause: 'health',
    text: food === undefined ? `health ${Math.round(s.health)} (${who} needs ${health})`
      : `health ${Math.round(s.health)}, food ${Math.round(s.food)} (${who} needs ${health} and ${food})`
  }),
  /**
   * Too full to carry what it would bring in. With a number: the goal's own limit (it runs with fewer than `from`
   * slots used). With the room rule's answer (pockets.ts noRoom, which knows the chests): the free slots the goal
   * needs and why the stash cannot make them, so the line says which thing to go and look at: pockets with nothing in
   * them to put away, or with `loose` slots the stash would empty and that still too few; chests too far off to put it
   * in; chests with no room left; or a put-away `failedMsAgo` that did not make the room it was sent for.
   */
  pockets: (s: Snapshot, who: string, from: number | PocketsLack): Decline => ({
    cause: 'pockets',
    text: typeof from === 'number' ? `${s.slotsUsed}/36 slots (${who} runs under ${from})`
      : from.chestsFull ? `chests full (${s.slotsUsed}/36 slots)`
        : `${s.slotsUsed}/36 slots, ${lacking(from)} (${who} needs ${from.free} free)`
  }),
  /**
   * Not work time, or under `ticks` of daylight left; null by day with time enough. A gate says this last: the hour is
   * the reason only when nothing else stands in the goal's way (a goal with nothing to do is not idle for being late).
   */
  late: (s: Snapshot, who: string, ticks = 0): Decline | null => {
    if (s.sleeping) return { cause: 'late', text: 'asleep' };
    if (s.activity !== 'work') return { cause: 'late', text: `not work time (${s.activity})` };
    const left = daylightLeft(s.timeOfDay);
    return left < ticks ? { cause: 'late', text: `${tickMin(left)} min of daylight left (${who} needs ${tickMin(ticks)})` } : null;
  },
  /** a round that ran less than `every` ms ago (or put itself off beyond that): nothing to do there before `until` */
  notDue: (who: string, now: number, last: number, every: number): Decline => ({
    cause: 'unneeded', text: `${who} is not due for ${Math.max(1, Math.ceil((last + every - now) / 60_000))} min (every ${Math.round(every / 60_000)})`, until: last + every
  })
};

/** Close enough to home to count as there. */
export const AT_HOME = 3;
/** Within this of home the bot is in its yard. */
export const IN_YARD = 16;

/** Out of bed in the morning (beds wake everyone at dawn, but not if the bot lay down after the others got up). */
export const wake: Goal = {
  name: 'wake',
  priority: 95,
  timeoutMs: 10_000,
  retryMs: 30_000,
  whileAsleep: true,
  wants: s => (s.sleeping && s.activity === 'work' ? 'morning' : null),
  run: async ctx => {
    await ctx.call('bed.wake');
    return 'got up';
  }
};

/** A mob the wall-in waits on: break out opens the wall to it only when the bot is this well and armoured. */
const FIGHT_HEALTH = 14;
const FIGHT_ARMOUR = 'iron';
/**
 * The mobs break out lets the Guardian's auto-defend fight through an opened wall: those that come to the bot and fight
 * hand to hand. Never a creeper (it would blow the wall and the bot up), nor what shoots or throws from afar (a
 * skeleton through the gap, a witch, a drowned with a trident), nor more than two at once.
 */
const MELEE = new Set(['zombie', 'husk', 'zombie_villager', 'spider', 'cave_spider']);
const FIGHT_AT_MOST = 2;
/** Waits on the same mob, running, before a bot strong enough opens its wall to it. */
const WAITS = 3;
/** How long a run that opened the wall stays for the fight before it lets the next run look again. */
const FIGHT_MS = 30_000;

/** The mob break out last waited on (its id, as world.entities gives it) and how many runs running it has. */
let waitedOn: { id?: number; name: string; n: number } | undefined;
/** For tests: no mob waited on yet. */
export function resetBreakOut(): void { waitedOn = undefined; }

/** The worst worn armour piece's material (`iron`, `diamond`), and whether every piece is iron or better; none worn: `no`. */
function armourOf(items: InventoryItem[]): { words: string; ok: boolean } {
  const worn = [36, 37, 38, 39].map(slot => items.find(i => i.slot === slot)?.name);
  const tiers = worn.map(n => (n ? tier(n) : 0));
  const worst = Math.min(...tiers);
  const name = worn[tiers.indexOf(worst)];
  return { words: name ? name.replace(/_(helmet|chestplate|leggings|boots)$/, '') : 'no', ok: worst >= tier(`${FIGHT_ARMOUR}_chestplate`) };
}

/**
 * Out of an emergency wall-in by day. The Guardian walls the bot in when a fight goes badly, and the shelter does at
 * night away from home; in the home zone the dirt it used can't be broken by Baritone (ground there is protected), so
 * every walk failed at once and it sat in its box at 7 health with nothing to eat. Digs the wall it built (all of it,
 * so no stray blocks are left on the lawn); a box it didn't build, it opens on the side toward home.
 *
 * It waits while a monster is within 10, but not for good: a zombie near a player never despawns, and live on Nov 12
 * it waited an hour on one standing in the cave outside the wall (`waiting: zombie 2 blocks away` every 20 s, then
 * the morning hold, and again). The third run running that finds the same mob, with the bot at health 14 or more and
 * iron armour or better, opens its own wall 2 high on the side nearest the mob and stays half a minute for the
 * Guardian's auto-defend to fight it (one or two mobs that fight hand to hand: never a creeper, nothing that shoots),
 * then digs out the rest of its wall. Weaker, it goes on waiting, and three failures in a row hold it 10 min, not the
 * night.
 */
export const breakOut: Goal = {
  name: 'break out',
  priority: 92,
  timeoutMs: 3 * 60_000,
  retryMs: 20_000,
  failHoldMs: 10 * 60_000,
  wants: s => (s.boxedIn && s.activity === 'work' && !s.sleeping ? 'walled in, and it is day' : null),
  run: async ctx => {
    type Seen = { id?: number; name: string; category: string; distance: number; position?: Pos };
    const { entities } = await ctx.call<{ entities: Seen[] }>('world.entities', { maxDistance: 10 });
    const monsters = entities.filter(e => e.category === 'monster');
    const threat = monsters[0];
    const feet = { x: Math.floor(ctx.s.position.x), y: Math.floor(ctx.s.position.y), z: Math.floor(ctx.s.position.z) };
    let opened: string | undefined;
    if (threat) {
      const n = waitedOn && waitedOn.name === threat.name && waitedOn.id === threat.id ? waitedOn.n + 1 : 1;
      waitedOn = { id: threat.id, name: threat.name, n };
      const armour = armourOf(ctx.s.items);
      const fit = ctx.s.health >= FIGHT_HEALTH && armour.ok && monsters.length <= FIGHT_AT_MOST && monsters.every(m => MELEE.has(m.name));
      const waiting = `waiting: ${threat.name} ${threat.distance.toFixed(0)} blocks away`;
      if (n < WAITS || !fit || !threat.position) throw new Error(waiting);
      // the side nearest the mob, 2 high: the gap it comes through, and the only one. Of the wall it built only, at
      // both heights: beside it on the lawn may stand a chest of the storage house or a house wall, which is no wall
      // to open, and where the wall-in filled only the head cell over one, a gap there is 1 high (no zombie comes
      // through it, and with one side open the box is no box: break out never wants again). With no such side (a box
      // it did not build has nothing of its own to open) it waits, as ever
      const mob = threat.position;
      const own = ctx.s.boxedIn ?? [];
      const mine = (c: Pos) => own.some(d => d.x === c.x && d.y === c.y && d.z === c.z);
      const sides = own.filter(c => c.y === feet.y && Math.abs(c.x - feet.x) + Math.abs(c.z - feet.z) === 1 && mine({ ...c, y: feet.y + 1 }));
      const off = (c: Pos) => Math.hypot(c.x + 0.5 - mob.x, c.z + 0.5 - mob.z);
      const toward = [...sides].sort((a, b) => off(a) - off(b))[0];
      if (!toward) throw new Error(waiting);
      // opened only when the bridge says so: `No block` is open too (the gap the last run made); a dig refused or
      // timed out leaves the wall whole, and the run waits as ever (said as opened, it ran again every half minute)
      let open = true;
      for (const c of [toward, { ...toward, y: feet.y + 1 }]) {
        if (ctx.signal.aborted) throw new Error('aborted');
        const r = await ctx.act('dig-block', { ...c }).catch((e: Error) => ({ ok: false, text: e.message }));
        if (!r.ok || !/^(Dug|No block)/.test(r.text)) open = false;
      }
      if (ctx.signal.aborted) throw new Error('aborted');
      if (!open) throw new Error(waiting);
      opened = `opened the wall toward the ${threat.name} (health ${Math.round(ctx.s.health)}, ${armour.words} armour)`;
      ctx.progress(opened);
      // the fight is the Guardian's (it hits what comes within reach): the run stays for it a while, then digs the
      // rest of its wall as ever. Still about after that (or the bot hurt) all the same: the box is open, so no run
      // comes after this one, and what it left standing would stay on the lawn for good (scaffold in the storage
      // house's aisle, by a built block where the tidy round leaves it)
      const until = Date.now() + FIGHT_MS;
      let gone = false;
      while (!ctx.signal.aborted) {
        const seen = await ctx.call<{ entities: Seen[] }>('world.entities', { maxDistance: 10 }).catch(() => undefined);
        gone = !!seen && !seen.entities.some(e => e.category === 'monster');
        const health = (await ctx.status().catch(() => undefined))?.health ?? ctx.s.health;
        if (gone || health < FIGHT_HEALTH || Date.now() >= until) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      if (ctx.signal.aborted) throw new Error('aborted');
      if (!gone) opened = `${opened}; still about`;
    }
    waitedOn = undefined;
    let cells = [...(ctx.s.boxedIn ?? [])];
    if (!cells.length) {
      const home = ctx.s.home ?? feet;
      const dx = home.x - feet.x, dz = home.z - feet.z;
      const step = Math.abs(dx) >= Math.abs(dz) ? { x: Math.sign(dx) || 1, z: 0 } : { x: 0, z: Math.sign(dz) };
      cells = [1, 0].map(dy => ({ x: feet.x + step.x, y: feet.y + dy, z: feet.z + step.z }));
    }
    // the sides at its height first (the way out), the roof and supports after
    cells.sort((a, b) => Number(a.y < feet.y || a.y > feet.y + 1) - Number(b.y < feet.y || b.y > feet.y + 1));
    let dug = 0;
    for (const c of cells) {
      if (ctx.signal.aborted) break;
      const r = await ctx.act('dig-block', { ...c });
      if (r.ok && /^Dug/.test(r.text)) { dug++; ctx.progress(`dug (${c.x}, ${c.y}, ${c.z})`); }
    }
    if (opened) return `${opened}; then dug out of the wall-in (${dug} more of ${cells.length} block(s))`;
    if (!dug) throw new Error(`could not dig out of the wall at (${feet.x}, ${feet.y}, ${feet.z})`);
    return `dug out of the wall-in (${dug} of ${cells.length} block(s))`;
  }
};

/**
 * Home before dark, and into bed once it lets the bot sleep (skips phantoms and sets the respawn point). Stuck away
 * from home at night, or home with no bed yet (a new bot's first nights: it stood in the open all night): wall in
 * where it stands and wait for morning (the break-out goal digs it out by day).
 */
export function shelterGoal(): Goal {
  let holedUp = false;
  // where it walled in, as seen just after: moved on from there since, it is holed up no more. Out from under digs a
  // night's wall-in under the yard open by night as well, and the bot stood up on the surface past the fence all night
  let holedAt: Pos | undefined;
  const stillHoled = (p: Pos | undefined) => holedUp && (!holedAt || !p || Math.hypot(p.x - holedAt.x, p.y - holedAt.y, p.z - holedAt.z) <= 2);
  const wallIn = async (ctx: GoalContext) => {
    const w = await ctx.act('wall-in');
    holedUp = true;
    holedAt = undefined;
    try { holedAt = (await ctx.status()).position; } catch { /* no look: holed up until the morning, as ever */ }
    return w;
  };
  return {
    name: 'shelter',
    priority: 80,
    timeoutMs: 12 * 60_000,
    retryMs: 20_000,
    interruptible: false,
    wants: (s, world) => {
      if (s.activity === 'work') { holedUp = false; holedAt = undefined; return null; }
      if (stillHoled(s.position) || s.sleeping || s.dimension !== 'overworld' || !s.home) return null;
      // in the evening the fenced, lit yard is home enough (the chests and the furnace are in it: pulled back to the
      // doorstep, the kit and the food goal never got to them); at night, the house. On its level: a cave under the
      // yard is neither. Under the yard the walk home stops in a second, and three of those held the shelter until
      // the morning, past the moment out from under brought the bot up: that is out from under's (the night's wall-in
      // down there still is the shelter's)
      if (s.activity === 'return') return !nearHome(s, IN_YARD) && !underNow(s, world) ? 'evening: head home before dark' : null;
      if (!nearHome(s, AT_HOME)) return 'night: get home';
      if (s.activity === 'rest' && world.landmarks.bed) return 'night: go to bed';
      if (s.activity === 'rest' && !s.boxedIn) return 'night: no bed yet: wall in';
      return null;
    },
    run: async ctx => {
      const did: string[] = [];
      if (!nearHome(ctx.s, AT_HOME)) {
        // up out of a mine first, by day and in the evening; deep down at night it does not climb (walkHome), nor in
        // the evening when the climb would come up after dark (`night`), and the night is spent walled in down there
        // (thrown in the evening, three tries 20 s apart would hold the shelter until the morning, and no wall-in)
        const r = await walkHome(ctx, { timeoutMs: 600_000 });
        if (!r.ok) {
          if (ctx.s.activity !== 'rest' && !r.night) throw new Error(r.text);
          const w = await wallIn(ctx);
          return `could not get home ${ctx.s.activity === 'rest' ? 'at night' : 'before dark'} (${r.text}); ${w.text}`;
        }
        did.push('walked home');
      }
      // onto the home cell itself: go-home stops within 2 blocks, which can be the doorway, with the door left open
      // (Baritone opens doors by hand and walks on; crossing the inside pressure plate is what shuts them again)
      // A nicety, never what the night hangs on: with scaffold left on the home cell this walk threw "Could not reach
      // ... no path found" from 1.41 blocks away, three times an evening, before the doors and before the bed, and
      // for 4.5 hours of evenings and nights the bot never got to bed
      const home = ctx.s.home!;
      const onto = await ctx.act('move-to-position', { x: home.x, y: home.y, z: home.z, range: 0, timeoutMs: 30_000 })
        .catch(e => ({ ok: false, text: (e as Error).message }));
      if (!onto.ok) did.push('home cell not reached');
      const shut = await closeDoors(ctx, home);
      if (shut) did.push(`shut ${shut} door(s)`);
      const bed = ctx.world.landmarks.bed;
      if (ctx.s.activity === 'rest' && bed) {
        const sleep = () => ctx.call<{ sleeping: boolean; reason?: string }>('bed.sleep', { ...bed }, 15_000);
        // from home the bed is usually in reach already (walking right up to it timed out 2.8 blocks away)
        let sl = await sleep().catch(() => undefined);
        if (!sl) {
          const r = await ctx.act('move-to-position', { ...bed, range: 2, timeoutMs: 60_000 });
          if (!r.ok && !/Stopped at .* [0-3](\.\d+)? blocks away/.test(r.text)) throw new Error(`could not reach the bed: ${r.text}`);
          sl = await sleep();
        }
        if (!sl.sleeping) throw new Error(`could not sleep: ${sl.reason ?? 'unknown'}`);
        did.push(`asleep in the bed at (${bed.x}, ${bed.y}, ${bed.z})`);
      } else if (ctx.s.activity === 'rest' && !ctx.s.boxedIn) {
        // no bed yet: the night in a box of its own blocks, not out in the open with the mobs
        const w = await wallIn(ctx);
        did.push(`no bed yet: ${w.text}`);
      }
      return did.join(', ') || 'home';
    }
  };
}

/**
 * Shut the doors around home that stand open with nothing holding them open (a pressure plate keeps them powered:
 * those close by themselves). Monsters walk in through an open door; the bot once died to a zombie in its own cabin.
 */
export async function closeDoors(ctx: GoalContext, home: Pos): Promise<number> {
  const box = { x: home.x - 8, y: home.y - 2, z: home.z - 8, width: 17, height: 6, length: 17 };
  const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', box);
  // a door still powered by the plate the bot just stepped off shuts by itself when the plate lets go
  const me = (await ctx.status()).block;
  // toggle only: shut with a water bucket in hand (and the shield on), the click poured the water outside the door
  let shut = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] ?? '';
    // doors (their lower half) and fence gates
    const door = /_door\[/.test(b) && !/iron_door/.test(b) && /half=lower/.test(b);
    if (!(door || /_fence_gate\[/.test(b)) || !/open=true/.test(b) || /powered=true/.test(b)) continue;
    const at = { x: box.x + i % box.width, y: box.y + Math.floor(i / (box.width * box.length)), z: box.z + Math.floor(i / box.width) % box.length };
    if (me && me.x === at.x && me.z === at.z && Math.abs(me.y - at.y) <= 1) continue; // standing in it
    const r = await ctx.act('use-item-on-block', { ...at, face: 'up', toggle: true });
    if (r.ok && /open=false|closed/.test(r.text)) shut++;
  }
  // the gates in the fence and the doors of the other buildings, further out: the fishing trip left a gate open
  const inBox = (p: Pos) => p.x >= box.x && p.x < box.x + box.width && p.z >= box.z && p.z < box.z + box.length && p.y >= box.y && p.y < box.y + box.height;
  const far = Object.entries(ctx.world?.zones ?? {}).filter(([k]) => /:(gate|door)$/.test(k)).flatMap(([, zs]) => zs).filter(p => !inBox(p));
  for (const at of far) {
    if (ctx.signal.aborted) break;
    const { blocks: [b] } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...at, width: 1, height: 1, length: 1 });
    if (!b || !/open=true/.test(b) || /powered=true/.test(b) || /half=upper/.test(b)) continue;
    const r = await ctx.act('use-item-on-block', { ...at, face: 'up', toggle: true });
    if (r.ok && /open=false|closed/.test(r.text)) shut++;
  }
  return shut;
}

/** How far a point is outside a yard box (0 inside), in the larger of the two directions. */
export function outsideBy(yard: { x1: number; z1: number; x2: number; z2: number }, p: { x: number; z: number }): number {
  return Math.max(yard.x1 - p.x, 0, p.x - yard.x2, yard.z1 - p.z, p.z - yard.z2);
}

/** How far outside the yard's rectangle the bot may stand with nothing to do before it walks home. */
export const YARD_EDGE = 8;

/**
 * Wandered off with nothing to do (after an LLM job, say): come back home. "Off" is more than 32 blocks from home, as
 * it always was, or more than YARD_EDGE outside the yard's rectangle, which can be nearer. The 32 hold inside the
 * fence too: the yard is 96 blocks long by now, the chores of the home start within 10 to 24 blocks of home, and a
 * round that ends at the far end (the tree farm is 46 blocks from home) would leave the bot standing there, every one
 * of them "away", until the evening. This walk is what brings it back into their reach, and the chore that comes into
 * range on the way stops it (in two days' log, 103 of 139 walks ended so). Nowhere to walk to from another dimension
 * (its distance home is not a number there).
 */
export const returnIdle: Goal = {
  name: 'idle',
  priority: 1,
  timeoutMs: 10 * 60_000,
  retryMs: 5 * 60_000,
  wants: (s, world) => {
    if (s.activity !== 'work' || !s.home || !Number.isFinite(s.distHome)) return null;
    // under the yard the walk home stops in a second: that is out from under's, and the walk is for when it is up
    if (underNow(s, world)) return null;
    const yard = world.yard;
    // far from home, in the yard or out of it; or out past the fence, however near home. The fence counts only
    // while home stands inside it: the walk ends at home, and with home moved out of an old yard the bot would be
    // "out here" again the moment it arrived, and walk for ever. Off home's level is out of the chores' reach too:
    // the bot left standing down a mine shaft by a run would stay there all day
    const off = !nearHome(s, 32) || (!!yard && outsideBy(yard, s.home) === 0 && outsideBy(yard, s.position) > YARD_EDGE);
    return off ? 'nothing to do out here: back to the yard' : null;
  },
  run: async ctx => {
    // from down a mine it climbs out first: go-home from there plans its way under the ground into the yard's column
    // (live on Nov 13: from 96 out at y -45 to 53 under the yard in 70 s)
    const r = await walkHome(ctx, { timeoutMs: 600_000 });
    if (!r.ok) throw new Error(r.text);
    return 'back home';
  }
};
