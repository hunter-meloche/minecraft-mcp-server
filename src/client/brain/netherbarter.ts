/**
 * Bartering with piglins by its own Nether-side portal (P3a of the progression plan, stage 1 of the Nether trips), and
 * the gold for it.
 *
 * The gold: a chore at home, `gold for bartering`, smelts the raw gold the deep trips brought (990 raw, 41 ingots
 * stored on Nov 14) into ingots at the home furnace, at most 64 a game day, while the barter wants; it keeps 64 raw
 * gold it never smelts and 21 ingots the barter never gives: the netherite's 16 (P6) and the golden helmet's repairs'
 * 5. A trip takes up to 32 of the rest.
 *
 * The trip (worktasks.ts NETHER_WORK `barter`, from stage 1 while a barter target is short and there is gold): the
 * Nether kit at home and the gold, through the home portal into its own hut (anywhere else: the link is broken the one
 * way, as the look trip has it: straight back, the setup held a day), and out on foot. Within 48 of its own portal, on
 * a careful walk over the ground read (never into anyone's build, never by lava or the edge of a drop, nothing broken
 * or placed), an adult piglin that is no brute, not angry, not admiring already, with no player or hoglin within 16 of
 * it and no other piglin by it (a baby keeps the gold, and only one piglin takes it); 16 from anyone's Nether build or
 * a natural fortress or bastion (the bridge's zones, asked again at every look). It stands 3 to 4 from it and tosses
 * one ingot to its feet (the bridge's item.toss: the pitch whose throw rests nearest them), waits while it admires
 * (about 6 s, 10 at most), picks up on foot what it throws (what lies new within 6 of it, never by lava, none with a
 * player by it), and goes on to the next. A tossed ingot left lying (the server's
 * mobGriefing off: no mob picks anything up then) is given by a right click instead (PiglinAi.mobInteract takes it
 * whatever the gamerule), and after three such the gold goes by hand first. The Guardian keeps the shield up against
 * whatever comes at it, as on every walk down there.
 *
 * It stops at the trip's 32 ingots (given, or gone from the pockets) or its time, on any hit taken, a hoglin, a brute
 * or a ghast near (looked for between the legs of every walk out too), the pockets full, or every barter target met,
 * and walks back into its hut and through its own portal; the leave nether goal sees to
 * dusk and to anything that goes wrong. A piglin turned aggressive (the bot's own hit, a gold block broken, someone
 * else's quarrel: the flag cannot say at whom) sends it back at once and holds the barter for the rest of the game day.
 *
 * Coordinates are `nether (x, y, z)` and `overworld (x, y, z)` in the lines, as nether.ts says them. Nothing here is
 * used at the module's top level (worktasks.ts and brain.ts reach it, and this module reaches most of the brain).
 */
import type { InventoryItem } from '../tools.js';
import { nearHome, no, type Decline, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { WorkResult } from './work.js';
import { NEAR_HOME } from './pockets.js';
import { freeChestTotals, key, storeInChests, takeFromChests } from './chests.js';
import { SMELTED, fuelFor } from './project.js';
import { collectFurnace } from './chores.js';
import { homePortal, tripsOn } from './portal.js';
import {
  NETHER, NETHER_STOCK, OVERWORLD, barterHold, gameDay, netherOf, netherShort, netherStock, notePortals, peekNether, portalCells, stockName,
  type NetherStockKind, type PortalShape
} from './nether.js';
import { DEEP_WALK_BACK, DEEP_WORTH, tripBudgetMs } from './mine.js';
import {
  FROM_BUILDS, GONE, LINK_RANGE, MAX_DROP, SETUP_HEALTH, SETUP_WAITS, blockAt, bottomOf, boxGap, boxOf, cellOf, enter, fetchSetupKit, footing, holdSetup,
  inNether, intoNether, listPortals, pathOf, readGround, setupShort, walkAlong, walkFrom, zoneBox, type Box, type Entered, type Grid, type Listed, type NetherZone
} from './nethersetup.js';

const MINUTE = 60_000;

const fmt = (p: { x: number; y: number; z: number }) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
const pause = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const cellKey = (p: Pos) => `${p.x},${p.y},${p.z}`;
const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;
const floorOf = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });
/** Along the ground, to a mob's feet or an item where they are (not their blocks). */
const across = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const dist3 = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** A standing cell's middle, where the bot's feet are once it is there. */
const middleOf = (c: Pos): Pos => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
/**
 * Whether a player standing here takes up an item lying there, pure: the game's pickup box (the player's, 0.6 wide and
 * 1.8 high, grown by 1 across and 0.5 up and down) meets the item's (0.25 a side), a little short of it across. An item
 * a block under the feet (thrown down a step) is not taken where the bot stands: its top is 0.75 under them.
 */
export function takesAt(feet: { x: number; y: number; z: number }, item: { x: number; y: number; z: number }): boolean {
  return across(feet, item) <= 1.3 && item.y + 0.25 >= feet.y - 0.5 && item.y <= feet.y + 2.3;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------------------------------------ the gold

/**
 * The gold of it: the ingots never given (the netherite's 16 in P6: four netherite ingots of four gold each; the
 * golden helmet's repairs, 5: its own five's worth), the raw gold never smelted for it, the ingots smelted a game day
 * at most, and the ingots a trip takes and gives at most.
 */
export const GOLD = { netherite: 16, helmet: 5, rawKept: 64, perDay: 64, trip: 32 } as const;
/** Ingots the barter never gives (community.ts KEEP.gold_ingot keeps these and a trip's worth from the donations). */
export const GOLD_RESERVE = GOLD.netherite + GOLD.helmet;

/** Gold ingots carried and in the chests (beyond what a build job or a mission holds there). */
const ingotsOf = (s: Pick<Snapshot, 'counts'>, free: Record<string, number>) => (s.counts.get('gold_ingot') ?? 0) + (free.gold_ingot ?? 0);
/** The ingots the barter may give: those over the reserve. */
export const spareGold = (s: Pick<Snapshot, 'counts'>, world: WorldMemory, free = freeChestTotals(world)): number => Math.max(0, ingotsOf(s, free) - GOLD_RESERVE);

/** What the barter is for (quartz is the quartz work's: the barter brings it 5 to 12 at a time, 1 barter in 23). */
export const BARTER_FOR: readonly NetherStockKind[] = ['fire_resistance', 'soul_sand', 'leather', 'obsidian', 'ender_pearl'];

/** The targets in words: `fire resistance 1/4, soul_sand 16/16, ...`. */
function targetsText(s: Pick<Snapshot, 'items' | 'counts'>, world: WorldMemory, kinds: readonly NetherStockKind[] = BARTER_FOR): string {
  const free = freeChestTotals(world);
  return kinds.map(k => `${stockName(k)} ${netherStock(k, s, world, free)}/${NETHER_STOCK[k]}`).join(', ');
}

/** The barter is open from stage 1, its own portal standing and the two sides linked (the setup's and the look's before it). */
export function barterOpen(world: WorldMemory): boolean {
  const n = peekNether(world);
  return n.linked === true && !!n.portal && n.stage >= 1;
}

/** The ingots the gold chore smelted on this game day. */
const smeltedToday = (world: WorldMemory): number => {
  const sm = peekNether(world).barter?.smelted;
  return sm && sm.day === gameDay(world) ? sm.n : 0;
};

/**
 * What the gold chore would smelt now, pure, or null: awake at home with a furnace, the switch on and the barter open,
 * two slots free, every chest looked into (a half-read list looks like no gold), a barter target short; fewer spare ingots than a
 * trip's 32; raw gold over the 64 kept; fewer than 64 smelted this game day; and not in the morning while a deep or a
 * Nether trip may still set out (until tod 5000: the deep rung's window holds the Nether's, which ends at 3800). Its
 * 5.5 min at the furnace, above every work rung, would cost such a trip its morning; the rest of the day is the
 * furnace's. At most a trip's worth a run: what brings the spare to 32 (the reserve's 21 first, where the ingots are
 * short of it), within the day's 64 and the raw over the 64 kept.
 */
export function goldWant(s: Snapshot, world: WorldMemory): { n: number; text: string } | null {
  if (s.sleeping || s.dimension !== OVERWORLD || !s.home || !nearHome(s, NEAR_HOME) || !world.landmarks.furnace) return null;
  if (!tripsOn(world) || !barterOpen(world)) return null;
  // (a slot for the raw gold and one for the ingots: with the pockets fuller the stash goes first)
  if (s.slotsUsed > 34) return null;
  if (world.landmarks.chests.some(c => !world.chestItems?.[key(c)])) return null;
  if (!netherShort(s, world, BARTER_FOR).length) return null;
  const free = freeChestTotals(world);
  const ingots = ingotsOf(s, free);
  if (ingots - GOLD_RESERVE >= GOLD.trip) return null;
  const raw = (s.counts.get('raw_gold') ?? 0) + (free.raw_gold ?? 0) - GOLD.rawKept;
  if (raw <= 0) return null;
  const today = smeltedToday(world);
  if (today >= GOLD.perDay) return null;
  if (s.activity === 'work' && tripBudgetMs(s.timeOfDay, DEEP_WALK_BACK) >= DEEP_WORTH) return null;
  const n = Math.min(GOLD.trip + GOLD_RESERVE - ingots, GOLD.perDay - today, raw, GOLD.trip);
  return { n, text: `${n} raw gold to smelt for bartering (${ingots} gold ingots, ${GOLD_RESERVE} kept; ${today}/${GOLD.perDay} smelted today)` };
}

type Inv = { items: InventoryItem[] };
const inventory = async (ctx: GoalContext): Promise<InventoryItem[]> => (await ctx.call<Inv>('inventory').catch((): Inv => ({ items: [] }))).items ?? [];
const carried = (items: InventoryItem[], name: string) => items.filter(i => i.slot < 36 && i.name === name).reduce((a, i) => a + i.count, 0);
const freeSlots = (items: InventoryItem[]) => 36 - new Set(items.filter(i => i.slot >= 0 && i.slot < 36).map(i => i.slot)).size;
/** Counts by name, as a look's. */
const countsOf = (items: InventoryItem[]) => { const m = new Map<string, number>(); for (const i of items) m.set(i.name, (m.get(i.name) ?? 0) + i.count); return m; };

/**
 * Gold for bartering (67: above the smelt goal, which would take the raw gold it carries to the furnace out of its
 * hands midway, the raw ore and the fuel carried being smelt's own want; it stops nothing and takes over at the
 * hand-over): the raw gold out of the chests, into the home furnace with fuel (the chests' coal or logs where none is
 * carried), the ingots taken out. Booked for the day as the raw gold goes in: a run stopped midway leaves what it
 * carried to the smelt goal, smelted all the same. Says `gold: smelted N raw_gold into ingots for bartering (...)`.
 */
export const goldGoal: Goal = {
  name: 'gold for bartering',
  priority: 67,
  // (a trip's 32 at the furnace: 10 s each)
  timeoutMs: 8 * MINUTE,
  retryMs: 10 * MINUTE,
  cuts: () => false,
  wants: (s, world) => goldWant(s, world)?.text ?? null,
  run: async ctx => {
    const plan = goldWant(ctx.s, ctx.world);
    const furnace = ctx.world.landmarks.furnace;
    if (!plan || !furnace) return 'no gold to smelt for bartering';
    const raw = SMELTED.gold_ingot;
    const took = await collectFurnace(ctx).catch(() => '');
    if (took) ctx.progress(`took ${took} out of the furnace`);
    const before = await inventory(ctx);
    if (carried(before, raw) < plan.n) await takeFromChests(ctx, raw, plan.n - carried(before, raw));
    const n = Math.min(carried(await inventory(ctx), raw), plan.n);
    if (!n) throw new Error(`no ${raw} came out of the chests`);
    const fuel = await fuelFor(ctx);
    if (!fuel) throw new Error(`${n} ${raw} to smelt for bartering, and nothing to burn`);
    if (ctx.signal.aborted) throw new Error('aborted');
    const today = smeltedToday(ctx.world);
    (netherOf(ctx.world).barter ??= {}).smelted = { day: gameDay(ctx.world), n: today + n };
    const r = await ctx.act('smelt-item', { ...furnace, inputItem: raw, inputCount: n, fuelItem: fuel, takeOutput: true, timeoutMs: n * 10_500 + 15_000 });
    const got = carried(await inventory(ctx), 'gold_ingot') - carried(before, 'gold_ingot');
    if (got <= 0) throw new Error(`could not smelt ${raw}: ${r.text.replace(/\s+/g, ' ').slice(0, 120)}`);
    const line = `gold: smelted ${got} ${raw} into ingots for bartering (${today + n}/${GOLD.perDay} today; ${GOLD_RESERVE} ingots and ${GOLD.rawKept} raw gold kept)`;
    ctx.progress(line);
    return line.replace(/^gold: /, '');
  }
};

// ------------------------------------------------------------------------------------------------ the gate

/**
 * Whether the barter can set out now, pure: not held (a piglin turned on it today), a barter target short (stocked:
 * all met), gold over the reserve, not hurt past what the run heals at home, and nothing of the Nether kit short that
 * the chests lack (the setup's own list: no frame's obsidian, its own portal stands). The hour is the rung's.
 */
export function barterReady(s: Snapshot, world: WorldMemory): Decline | null {
  const held = barterHold(world, s.now);
  if (held) return { cause: 'hold', text: `barter held for the day: ${held.why}` };
  if (!netherShort(s, world, BARTER_FOR).length) return { cause: 'stocked', text: `every barter target met (${targetsText(s, world)})` };
  const free = freeChestTotals(world);
  if (spareGold(s, world, free) < 1) {
    return { cause: 'kit', text: `no gold to barter: ${ingotsOf(s, free)} gold ingots, ${GOLD_RESERVE} kept (the netherite's ${GOLD.netherite}, the golden helmet's repairs ${GOLD.helmet})` };
  }
  if (s.health < SETUP_HEALTH) return no.health(s, 'the barter', SETUP_HEALTH, 10);
  const short = setupShort(s, world);
  if (short.length) return { cause: 'kit', text: `barter: short of ${short.join(', ')} (carried or in the chests)` };
  return null;
}

// ------------------------------------------------------------------------------------------------ the ground

/** How far from its own portal the barter goes (its walks, the piglins, what it picks up). */
export const BARTER_RADIUS = 48;
/** The ground read round its portal: down and up from it. */
const GROUND_DOWN = 8;
const GROUND_UP = 8;
/**
 * No lava or fire within this of a cell it walks or stands on, across (a cell a misstep, a knock-back or a ghast's
 * blast away from it), and under its floor as deep: the walks' own rule (standable) keeps only one off.
 */
export const LAVA_GAP = 2;

const passable = (c: ReturnType<typeof cellOf>) => c === 'open' || c === 'plant';
const firm = (c: ReturnType<typeof cellOf>) => c === 'dig' || c === 'solid' || c === 'falls';

/**
 * Lava or fire within LAVA_GAP across of a standing cell, from two under its floor to its head; a cell not loaded
 * counts as such. And what lies at the bottom of every column open beside it (feet and head clear, within LAVA_GAP
 * across): lava or fire there however deep, or the bottom not read (past the ground read: a chasm too deep to know),
 * is lava by it. A ledge one or two back from the edge over a lava lake 6 down (the look saw such lakes at nether
 * (-73, 85, 259) and (-70, 84, 264), 6 under its portal's floor) passed the rest of the rule and the drop's edge, and
 * one knock-back there puts the bot in the lake.
 */
export function lavaBy(g: Grid, p: Pos): boolean {
  for (let dy = -LAVA_GAP - 1; dy <= 1; dy++) for (let dx = -LAVA_GAP; dx <= LAVA_GAP; dx++) for (let dz = -LAVA_GAP; dz <= LAVA_GAP; dz++) {
    const c = cellOf(blockAt(g, { x: p.x + dx, y: p.y + dy, z: p.z + dz }));
    if (c === 'hot' || c === 'unknown') return true;
  }
  for (let dx = -LAVA_GAP; dx <= LAVA_GAP; dx++) for (let dz = -LAVA_GAP; dz <= LAVA_GAP; dz++) {
    if (!dx && !dz) continue;
    const x = p.x + dx, z = p.z + dz;
    if (!passable(cellOf(blockAt(g, { x, y: p.y, z }))) || !passable(cellOf(blockAt(g, { x, y: p.y + 1, z })))) continue;
    // (outside the read blockAt says null, which is no passable cell: the walk down ends there)
    let y = p.y - 1;
    while (passable(cellOf(blockAt(g, { x, y, z })))) y--;
    const c = cellOf(blockAt(g, { x, y, z }));
    if (c === 'hot' || c === 'unknown') return true;
  }
  return false;
}

/** A standing cell at the edge of a drop deeper than a walk's fall (3): a side open at feet and head with no ground within that under it. */
export function overDrop(g: Grid, p: Pos): boolean {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const q = { x: p.x + dx, y: p.y, z: p.z + dz };
    if (!passable(cellOf(blockAt(g, q))) || !passable(cellOf(blockAt(g, { ...q, y: q.y + 1 })))) continue;
    let ground = false;
    for (let f = q.y - 1; f >= q.y - 1 - MAX_DROP; f--) {
      const c = cellOf(blockAt(g, { ...q, y: f }));
      if (firm(c)) { ground = true; break; }
      if (!passable(c)) break;
    }
    if (!ground) return true;
  }
  return false;
}

/**
 * The cells the barter may walk and stand on, pure: within BARTER_RADIUS of its own portal, FROM_BUILDS (16) from every
 * zone the bridge's scan has down there (anyone's build: courtesy; a natural fortress or bastion: blazes and brutes),
 * no lava or fire by it, at no drop's edge. Each cell judged once (the walks are searched again for every barter and
 * every thing picked up, over the same ground).
 */
export function barterGround(g: Grid, portal: Box, zones: Box[]): (p: Pos) => boolean {
  const judged = new Map<string, boolean>();
  return p => {
    const k = cellKey(p);
    let ok = judged.get(k);
    if (ok === undefined) {
      ok = boxGap(portal, cellBox(p)) <= BARTER_RADIUS && !zones.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS) && !lavaBy(g, p) && !overDrop(g, p);
      judged.set(k, ok);
    }
    return ok;
  };
}

/** Nothing solid between a standing cell and a point at the height a throw passes (its feet and a block up), stepping a quarter block. */
export function throwClear(g: Grid, from: Pos, to: Pos): boolean {
  const a = middleOf(from);
  const n = Math.max(1, Math.ceil(across(a, to) * 4));
  const top = Math.max(from.y, Math.floor(to.y));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = Math.floor(a.x + (to.x - a.x) * t), z = Math.floor(a.z + (to.z - a.z) * t);
    if (x === from.x && z === from.z) continue;
    for (const y of [top, from.y + 1]) if (!passable(cellOf(blockAt(g, { x, y, z })))) return false;
  }
  return true;
}

// ------------------------------------------------------------------------------------------------ the piglins

/** A thing world.entities reports (its position its feet). */
export interface Seen {
  id: number; name: string; position: Pos; distance: number;
  baby?: boolean; aggressive?: boolean; admiring?: boolean; offhand?: string; mainhand?: string;
  item?: string; count?: number; foreign?: boolean; buildDistance?: number;
}

/** Where it stands to toss: this far from the piglin's feet, along the ground. */
export const STANCE = { near: 3, far: 4 } as const;
/** The toss goes from here to there along the ground (item.toss rests about 3.75 out at most on stone). */
const TOSS = { least: 1.5, most: 4.2 } as const;
/** A right click reaches a piglin this near (the bridge's 4.5, eye to its box). */
const HAND_REACH = 4.2;
/** No hoglin within this of a piglin it barters with: they fight, and a piglin hunting is aggressive. */
export const HOGLIN_GAP = 16;
/** No other piglin (a baby keeps the gold) within this of the target's feet, where the ingot comes down. */
export const CROWD = 2;
/** What sends it back to its portal, by how near to the bot. */
export const NEAR = { angry: 16, brute: 16, hoglin: 16, ghast: 32 } as const;
/** What it throws is picked up within this of where the piglin stood. */
export const LOOT_RANGE = 6;
/**
 * No player within this of a piglin it barters with (someone else's barter or quarrel; and a piglin throws its loot
 * toward the nearest player it sees: the bot must be that player), nor within LOOT_RANGE of an item it picks up
 * (theirs, dropped or thrown to them). The community's own Nether portal is 23 from the bot's.
 */
export const PLAYER_GAP = 16;
/** The barter's whole time, from the kit at home to back through its own portal; what it still needs after the kit; what the bartering leaves for the way back. */
export const BARTER_MAX_MS = 8 * MINUTE;
export const BARTER_LEAST_MS = 2 * MINUTE;
export const BACK_MS = 45_000;
/** Tossed ingots in a row that lay untaken while a right click then worked: from these on the gold goes by hand first. */
export const TOSS_FAILS = 3;
/**
 * The waits, in looks a pollMs apart (a test sets pollMs to nothing; the counts stand): a tossed ingot taken within
 * 5 s (the bridge's toss comes back once it rests, a piglin may pick it up from 2 s after the throw, and walks to it
 * from up to 9), the admiring over within 10 s of its start (119 ticks: 6 s), the loot down 2 s after.
 */
export const BARTER_WAITS = { pollMs: 500, takenLooks: 10, admireLooks: 20, lootLooks: 4 };

const HOGLINS = /^(hoglin|zoglin)$/;
const PIGLINS = /^(piglin|piglin_brute|zombified_piglin)$/;

/**
 * What sends the bot back to its portal now, or null, pure: a piglin of any kind turned aggressive near it (`angry`:
 * the barter is held for the day), a hit taken since the last look (health down), a brute, a hoglin or a ghast near.
 */
export function barterDanger(ents: Seen[], health: number, was: number): { why: string; angry?: true } | null {
  const mad = ents.filter(e => PIGLINS.test(e.name) && e.aggressive && e.distance <= NEAR.angry).sort((a, b) => a.distance - b.distance)[0];
  if (mad) return { why: `a ${mad.name} turned aggressive at nether ${fmt(mad.position)}`, angry: true };
  if (health < was - 0.5) return { why: `a hit taken (health ${Math.round(was)} -> ${Math.round(health)})` };
  const near = (re: RegExp, d: number) => ents.filter(e => re.test(e.name) && e.distance <= d).sort((a, b) => a.distance - b.distance)[0];
  const brute = near(/^piglin_brute$/, NEAR.brute);
  if (brute) return { why: `a piglin brute near (${Math.round(brute.distance)} off)` };
  const hoglin = near(HOGLINS, NEAR.hoglin);
  if (hoglin) return { why: `a ${hoglin.name} near (${Math.round(hoglin.distance)} off)` };
  const ghast = near(/^ghast$/, NEAR.ghast);
  if (ghast) return { why: `a ghast near (${Math.round(ghast.distance)} off)` };
  return null;
}

/**
 * A piglin it may barter with, pure, or why not: an adult piglin (no brute: the name), not aggressive, not admiring
 * already (a loved thing in its off hand: it takes no more gold), within BARTER_RADIUS of its portal, FROM_BUILDS from
 * every zone and not in anyone's build by the bridge's own word, no player within PLAYER_GAP of it, no hoglin within
 * HOGLIN_GAP of it, no other piglin within CROWD of its feet (a baby keeps the gold), on ground the read holds.
 */
export function barterable(e: Seen, ents: Seen[], g: Grid, portal: Box, zones: Box[]): string | null {
  if (e.name !== 'piglin') return 'no piglin';
  if (e.baby) return 'a baby';
  if (e.aggressive) return 'aggressive';
  if (e.admiring) return `admiring ${e.offhand ?? 'something'} already`;
  const at = floorOf(e.position);
  if (boxGap(portal, cellBox(at)) > BARTER_RADIUS) return `more than ${BARTER_RADIUS} from its portal`;
  if (e.foreign || (e.buildDistance ?? Infinity) < FROM_BUILDS || zones.some(z => boxGap(z, cellBox(at)) < FROM_BUILDS)) return `within ${FROM_BUILDS} of someone's build`;
  if (ents.some(o => o.name === 'player' && dist3(o.position, e.position) < PLAYER_GAP)) return `a player within ${PLAYER_GAP} of it`;
  const hoglin = ents.find(h => HOGLINS.test(h.name) && dist3(h.position, e.position) < HOGLIN_GAP);
  if (hoglin) return `a ${hoglin.name} ${Math.round(dist3(hoglin.position, e.position))} from it`;
  const crowd = ents.find(o => o.id !== e.id && o.name === 'piglin' && across(o.position, e.position) < CROWD && Math.abs(o.position.y - e.position.y) < 2);
  if (crowd) return `${crowd.baby ? 'a baby' : 'another piglin'} by it`;
  if (!footing(g, e.position)) return 'on no ground the read holds';
  return null;
}

/**
 * Where to stand to toss to a piglin, pure: of the cells a walk reaches (`reach`, from where the bot stands), one
 * STANCE.near to STANCE.far from its feet along the ground, on its level or a step from it, with the throw's way clear;
 * the one of fewest steps. Undefined with none.
 */
export function stanceFor(g: Grid, reach: Map<string, { from: string | null; n: number }>, at: Pos): Pos | undefined {
  const f = floorOf(at);
  let best: { p: Pos; n: number } | undefined;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -STANCE.far - 1; dx <= STANCE.far + 1; dx++) for (let dz = -STANCE.far - 1; dz <= STANCE.far + 1; dz++) {
    const p = { x: f.x + dx, y: f.y + dy, z: f.z + dz };
    const r = reach.get(cellKey(p));
    if (!r || (best && r.n >= best.n)) continue;
    const d = across(middleOf(p), at);
    if (d < STANCE.near || d > STANCE.far || !throwClear(g, p, at)) continue;
    best = { p, n: r.n };
  }
  return best?.p;
}

// ------------------------------------------------------------------------------------------------ to its own portal and back

/**
 * From home through the home portal to its own Nether-side one (the trips of stage 1 on: the barter, the quartz): the
 * walk to it and through (nethersetup.ts intoNether, with its line), and where it came out. Out at its own portal:
 * the portal as listed and where the bot stands. Anywhere else the link is broken the one way, as the look trip has
 * it: the two marked not linked, straight back through the portal it came out of (nothing touched there, not a
 * step), the setup held a day; that, or a portal the bridge does not list, is the run's end (`result`).
 */
export async function toOwnPortal(ctx: GoalContext, home: Pos, own: Pos, now: () => number, work: string):
  Promise<{ arrived: Listed; homeShape: Listed; me: Pos } | { result: WorkResult }> {
  const went = await intoNether(ctx, home);
  if ('why' in went) return { result: { gain: 0, text: went.why, untried: true } };
  const { homeShape, r, came } = went;
  const st = await ctx.status().catch(() => undefined);
  const me = st?.position ?? r.position ?? came;
  const block = floorOf(came);
  const by = (list: Listed[]) => list.find(p => portalCells(p).some(c => same(c, block))) ??
    list.find(p => portalCells(p).some(c => dist3(c, me) <= 3));
  let arrived: Listed | undefined = r.arrived ?? by(await listPortals(ctx, 128));
  if (!arrived) {
    await pause(SETUP_WAITS.loadMs);
    if (ctx.signal.aborted) throw new Error('aborted');
    arrived = by(await listPortals(ctx, 128));
  }
  if (!arrived) return { result: { gain: 0, text: `came out at nether ${fmt(block)} by no portal the bridge lists: no ${work}` } };
  const isOwn = (p: PortalShape) => portalCells(p).some(c => Math.abs(c.x - own.x) <= 1 && Math.abs(c.y - own.y) <= 1 && Math.abs(c.z - own.z) <= 1);
  if (isOwn(arrived)) return { arrived, homeShape, me };
  const theirs = arrived;
  const seen = (await ctx.call<{ portals?: PortalShape[] }>('foreign.portals', { dimension: NETHER }).catch(() => ({ portals: [] as PortalShape[] }))).portals ?? [];
  notePortals(ctx.world, NETHER, seen.some(p => p.x === theirs.x && p.y === theirs.y && p.z === theirs.z) ? seen : [...seen, theirs]);
  netherOf(ctx.world).linked = false;
  const said = `nether: not linked: the home portal came out at nether ${fmt(theirs)}, not at its own at nether ${fmt(own)}`;
  holdSetup(ctx, now(), `${said}: setup held a day`, said.replace(/^nether: /, ''));
  const b = await enter(ctx, nearestCell(theirs, me));
  const ok = b.ok === true && b.dimension === OVERWORLD;
  return {
    result: {
      gain: 0,
      text: `the home portal came out at nether ${fmt(theirs)}, not at its own: not linked; ${ok ? `back at overworld ${fmt(b.portal ?? b.block ?? b.position ?? came)}` : `back through it: ${b.reason ?? b.dimension ?? 'no answer'}`}; setup held a day`,
      ...(ok ? { cameBack: true as const } : {})
    }
  };
}

/** A portal's bottom cell nearest a place: where the bot steps in. */
const nearestCell = (p: PortalShape, me: Pos) => bottomOf(p).sort((a, b) => across(a, me) - across(b, me))[0];

/**
 * Back through its own portal from by it: out by the home portal, the two still linked (`cameBack`); out elsewhere,
 * not linked and the setup held a day (the lead looks); not through, what the bridge said (the wrapper's way home
 * tries again). The text to add to the run's.
 */
export async function backThroughOwn(ctx: GoalContext, arrived: Listed, homeShape: Listed, now: () => number): Promise<{ text: string; cameBack: boolean }> {
  const st = await ctx.status().catch(() => undefined);
  const b: Entered = await enter(ctx, nearestCell(arrived, st?.position ?? ctx.s.position));
  if (!b.ok || b.dimension !== OVERWORLD) return { text: `back through its own portal: ${b.ok ? `came out in ${b.dimension ?? 'the same place'}` : b.reason ?? 'no answer'}`, cameBack: false };
  const out = b.portal ?? b.block ?? b.position ?? ctx.s.position;
  if (portalCells(homeShape).some(c => dist3(c, out) <= LINK_RANGE)) return { text: `back at overworld ${fmt(out)}`, cameBack: true };
  netherOf(ctx.world).linked = false;
  holdSetup(ctx, now(), `nether: not linked: came out at overworld ${fmt(out)}`, `its own portal at nether ${fmt(arrived)} led back to overworld ${fmt(out)}, not home`);
  return { text: `its own portal led back to overworld ${fmt(out)}: not linked; setup held a day`, cameBack: true };
}

// ------------------------------------------------------------------------------------------------ the trip

/** What it took home, by kind (a potion by its contents: `potion of fire_resistance`). */
const lootKey = (i: InventoryItem) => (i.potion ? `${i.name} of ${i.potion}` : i.name);
function tally(items: InventoryItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of items) if (i.slot >= 0 && i.slot < 41) out.set(lootKey(i), (out.get(lootKey(i)) ?? 0) + i.count);
  return out;
}
/** The loot in words, the most first: `4 soul_sand, 2 leather, 1 obsidian`. */
export const lootWords = (loot: Map<string, number>): string =>
  [...loot].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${n} ${k}`).join(', ');

/**
 * Take the trip's gold: what of the spare over the reserve a trip may give (GOLD.trip), out of the chests where it is
 * not carried; more carried than that (the reserve among it: the gold chore smelts into the pockets, and the gold chest
 * is full live) put back, so a death down there does not take it. What will not go back rides along: the loop counts
 * what leaves the pockets. What it may give, carried.
 */
async function fetchGold(ctx: GoalContext): Promise<number> {
  const has = carried(await inventory(ctx), 'gold_ingot');
  const free = freeChestTotals(ctx.world);
  const may = Math.min(GOLD.trip, Math.max(0, has + (free.gold_ingot ?? 0) - GOLD_RESERVE));
  if (has < may) await takeFromChests(ctx, 'gold_ingot', may - has);
  else if (has > may) await storeInChests(ctx, 'gold_ingot', has - may).catch(() => 0);
  return Math.min(may, carried(await inventory(ctx), 'gold_ingot'));
}

/**
 * The barter trip (see the top of the file). From home with the Nether kit and the gold (or it does not set out:
 * untried), through the home portal into its own hut, out on foot to the piglins round it, and back through its own
 * portal at the end; `nether: bartered N gold: 4 soul_sand, 1 obsidian, ...` said once it is done. Gain: the things
 * it brought back. Out of the Nether halfway (a death), it stops at once and writes nothing more.
 */
export async function barterRun(ctx: GoalContext, budgetMs: number, now: () => number): Promise<WorkResult> {
  const began = now();
  const left = () => Math.min(budgetMs, BARTER_MAX_MS) - (now() - began);
  const world = ctx.world;
  const home = homePortal(world);
  const own = peekNether(world).portal;
  if (!home) return { gain: 0, text: 'no home portal lit', untried: true };
  if (!own) return { gain: 0, text: 'no portal of its own down there to barter by', untried: true };
  const lacking = await fetchSetupKit(ctx);
  if (lacking) return { gain: 0, text: `not setting out: ${lacking}`, untried: true };
  const gold = await fetchGold(ctx);
  if (gold < 1) return { gain: 0, text: `not setting out: no gold to barter (${GOLD_RESERVE} ingots kept)`, untried: true };
  if (left() < BARTER_LEAST_MS) {
    return { gain: 0, text: `not setting out: the kit took ${Math.round((now() - began) / 1000)} s, too little of the barter's ${BARTER_MAX_MS / MINUTE} min is left`, untried: true };
  }
  const to = await toOwnPortal(ctx, home, own, now, 'barter');
  if ('result' in to) return to.result;
  const { arrived, homeShape } = to;
  if (left() <= BACK_MS) return { gain: 0, text: `out of the barter's ${BARTER_MAX_MS / MINUTE} min on the way down: no barter` };

  // ---- the ground round its portal (the bridge's scan follows the protection sync: a moment), then the zones down
  // there: asked once the read is in (the bridge's scan reads loaded chunks only: a build in a chunk that came in while
  // the ground was read was in no answer asked before it, as setupRun found), and again at every look (its scan
  // follows the bot, 48 round it, and the barter walks 48 from its portal keeping 16 from builds up to 64 out). Every
  // zone seen on the trip is kept (one gone from a later scan is still someone's); the ground it may walk follows them
  await pause(SETUP_WAITS.loadMs);
  if (ctx.signal.aborted) throw new Error('aborted');
  const pb = boxOf(portalCells(arrived));
  const g = await readGround(ctx, {
    x1: pb.x1 - BARTER_RADIUS, y1: Math.max(1, pb.y1 - GROUND_DOWN), z1: pb.z1 - BARTER_RADIUS,
    x2: pb.x2 + BARTER_RADIUS, y2: Math.min(126, pb.y2 + GROUND_UP), z2: pb.z2 + BARTER_RADIUS
  });
  const seenZones = new Map<string, Box>();
  let zones: Box[] = [];
  let may = barterGround(g, pb, zones);
  /** The bridge's zones down there added to those seen: false when it did not answer. */
  const askZones = async (): Promise<boolean> => {
    const r = await ctx.call<{ zones?: NetherZone[] }>('foreign.zones', { dimension: NETHER }).catch(() => undefined);
    if (!r) return false;
    let more = false;
    for (const z of (r.zones ?? []).map(zoneBox)) {
      const k = `${z.x1},${z.y1},${z.z1},${z.x2},${z.y2},${z.z2}`;
      if (!seenZones.has(k)) { seenZones.set(k, z); more = true; }
    }
    if (more) { zones = [...seenZones.values()]; may = barterGround(g, pb, zones); }
    return true;
  };
  // (no word of the builds down there: no rule of 16 from them to walk by. Back through its portal, from where it
  // stands by it)
  if (!(await askZones())) {
    const b = await backThroughOwn(ctx, arrived, homeShape, now);
    return { gain: 0, text: `no barter: the bridge did not say where the builds down there are; ${b.text}`, mark: 'same', ...(b.cameBack ? { cameBack: true as const } : {}) };
  }
  const st0 = await ctx.status().catch(() => undefined);
  const start = footing(g, st0?.position ?? to.me);
  if (!start) return { gain: 0, text: `no ground to stand on by its portal at nether ${fmt(arrived)}: no barter` };

  // ---- the looks: where it stands, what is round it, and what would send it back
  let health = st0?.health ?? 20;
  let me = st0?.position ?? to.me;
  let ents: Seen[] = [];
  let stop: string | undefined;
  let angry: string | undefined;
  /** sent back by a danger (not by the place): the trip says nothing of the piglins there */
  let danger = false;
  let gone = false;
  /** A look round: false when something sends it back (`stop` says what) or it is out of the Nether (`gone`). */
  const watch = async (): Promise<boolean> => {
    if (ctx.signal.aborted) throw new Error('aborted');
    const st = await ctx.status().catch(() => undefined);
    if ((st?.dimension ?? NETHER) !== NETHER) { gone = true; return false; }
    me = st?.position ?? me;
    await askZones();
    ents = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 64 }).catch(() => ({ entities: [] as Seen[] }))).entities ?? [];
    const was = health;
    health = st?.health ?? health;
    const d = barterDanger(ents, health, was);
    if (d) { stop = d.why; danger = true; if (d.angry) angry = d.why; return false; }
    if (st?.onFire) { stop = 'on fire'; danger = true; return false; }
    return true;
  };
  /**
   * Between the legs of a walk out: a look round (false on what sends it back), and the rest of the way still on ground
   * it may walk (a zone come in since it set out: false with nothing set, and the walk is planned again).
   */
  const onTheWay = (path: Pos[]) => {
    const was = zones;
    return async () => (await watch()) && (zones === was || path.slice(1).every(p => may(p)));
  };
  /** Looks a poll apart until `done` (or `looks` of them): `done`, `timeout`, or `back` (something sends it back, or it is gone). */
  const wait = async (looks: number, done: () => boolean): Promise<'done' | 'timeout' | 'back'> => {
    for (let i = 0; i < looks; i++) {
      await pause(BARTER_WAITS.pollMs);
      if (!(await watch())) return 'back';
      if (done()) return 'done';
    }
    return 'timeout';
  };
  const find = (id: number) => ents.find(e => e.id === id);
  const reachFrom = () => {
    const here = footing(g, me);
    return here ? walkFrom(g, [here], may) : new Map<string, { from: string | null; n: number }>();
  };

  /**
   * What a piglin threw (new items within LOOT_RANGE of where it stood) picked up on foot, never by lava, none with a
   * player by it (theirs, or thrown to them: looked at again each round): false when sent back.
   */
  const pickUp = async (around: Pos, before: Set<number>): Promise<boolean> => {
    const passed = new Set<number>();
    const waited = new Set<number>();
    for (let round = 0; round < 8; round++) {
      if (!(await watch())) return false;
      const players = ents.filter(e => e.name === 'player');
      const next = ents.filter(e => e.name === 'item' && !before.has(e.id) && !passed.has(e.id) && dist3(e.position, around) <= LOOT_RANGE &&
        !players.some(o => dist3(o.position, e.position) <= LOOT_RANGE))
        .sort((a, b) => dist3(a.position, me) - dist3(b.position, me))[0];
      if (!next) return true;
      // (in reach of the pickup where it stands: a look more; still lying there after it (a block under its feet, down
      // a step: the game's box reaches half a block under them), a cell to take it from)
      if (takesAt(me, next.position) && !waited.has(next.id)) { waited.add(next.id); await pause(BARTER_WAITS.pollMs); continue; }
      const c = floorOf(next.position);
      const reach = reachFrom();
      let best: { p: Pos; n: number } | undefined;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -2; dy <= 1; dy++) {
        const q = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        const r = reach.get(cellKey(q));
        if (r && across(middleOf(q), next.position) <= 1.2 && takesAt(middleOf(q), next.position) && (!best || r.n < best.n)) best = { p: q, n: r.n };
      }
      // (by lava, over a drop, in someone's build, or where it stands already: left where it lies)
      if (!best || best.n === 0) { passed.add(next.id); continue; }
      const way = pathOf(reach, best.p);
      const w = await walkAlong(ctx, way, 4, onTheWay(way));
      if (w === 'gone') { gone = true; return false; }
      if (w === 'back') { if (stop || gone) return false; continue; }
      if (w === 'stuck') passed.add(next.id);
    }
    return true;
  };

  // ---- the bartering
  let given = 0;
  const piglins = new Set<number>();
  const skipped = new Set<number>();
  const tries = new Map<number, number>();
  const loot = new Map<string, number>();
  let lootCount = 0;
  const startItems = await inventory(ctx);
  const startTally = tally(startItems);
  // (what left the pockets counts as well as what was taken: a toss lost to a piglin off to the side or left by lava
  // is spent all the same, and past the trip's gold it would be the reserve's, where that rode along)
  const startGold = carried(startItems, 'gold_ingot');
  /** What came into the pockets since the start that is not booked yet, booked as loot (the gold excepted: its own, picked up again). */
  const book = (items: InventoryItem[]) => {
    for (const [k, n] of tally(items)) {
      const more = n - (startTally.get(k) ?? 0) - (loot.get(k) ?? 0);
      if (more <= 0 || k === 'gold_ingot') continue;
      loot.set(k, (loot.get(k) ?? 0) + more);
      lootCount += more;
      ctx.gain(more);
    }
  };
  while (!stop && !gone) {
    if (given >= gold) { stop = `the trip's ${gold} gold given`; break; }
    if (left() < BACK_MS) { stop = 'the barter\'s time is up'; break; }
    if (!(await watch())) break;
    const items = await inventory(ctx);
    if (!carried(items, 'gold_ingot')) { stop = 'no gold left'; break; }
    const spent = startGold - carried(items, 'gold_ingot');
    if (spent >= gold) { stop = `the trip's ${gold} gold gone (${given} given, ${spent - given} lost)`; break; }
    if (freeSlots(items) < 2) { stop = `pockets full (${36 - freeSlots(items)}/36 slots)`; break; }
    if (!netherShort({ items, counts: countsOf(items) }, world, BARTER_FOR).length) { stop = 'every barter target met'; break; }
    // the piglin of fewest steps to a place to toss from; the others' reasons counted for the line (none seen, all
    // by someone's build, a hoglin by each: no barter reads alike without them)
    const reach = reachFrom();
    let target: { e: Seen; stance: Pos; n: number } | undefined;
    const refused = new Map<string, number>();
    const note = (why: string) => refused.set(why, (refused.get(why) ?? 0) + 1);
    for (const e of ents) {
      if (e.name !== 'piglin') continue;
      if (skipped.has(e.id)) { note('tried already'); continue; }
      const why = barterable(e, ents, g, pb, zones);
      if (why) { note(why); continue; }
      const stance = stanceFor(g, reach, e.position);
      const n = stance ? reach.get(cellKey(stance))?.n : undefined;
      if (!stance || n === undefined) { note('no place to stand that a walk reaches'); continue; }
      if (!target || n < target.n) target = { e, stance, n };
    }
    if (!target) {
      const whys = [...refused].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} ${k}`).join(', ');
      stop = `no piglin to barter with within ${BARTER_RADIUS} of its portal (${whys || 'none seen'})`;
      break;
    }
    const id = target.e.id;
    const way = pathOf(reach, target.stance);
    const walked = await walkAlong(ctx, way, 4, onTheWay(way));
    if (walked === 'gone') { gone = true; break; }
    if (walked === 'back') { if (stop || gone) break; continue; }
    if (walked === 'stuck') { skipped.add(id); continue; }
    if (!(await watch())) break;
    // it may have walked on: tossed to where it is now from here, or a new place to stand (twice at most)
    const seen = find(id);
    const off = seen ? barterable(seen, ents, g, pb, zones) : 'gone';
    if (!seen || off || across(me, seen.position) < TOSS.least || across(me, seen.position) > TOSS.most || Math.abs(seen.position.y - me.y) > 1.2) {
      const n = (tries.get(id) ?? 0) + 1;
      tries.set(id, n);
      if (off || n >= 2) skipped.add(id);
      continue;
    }
    const piglin: Seen = seen;

    // ---- the gold to it: tossed to its feet; by hand after a toss left lying, or first once tosses have lain three times
    const itemsBefore = new Set(ents.filter(e => e.name === 'item').map(e => e.id));
    const admiringBefore = new Set(ents.filter(e => e.admiring).map(e => e.id));
    // (another piglin by it that took it barters all the same)
    const taker = (): number | undefined => (find(id)?.admiring ? id
      : ents.find(e => e.name === 'piglin' && e.admiring && !admiringBefore.has(e.id) && dist3(e.position, piglin.position) <= CROWD + 2)?.id);
    let took: number | undefined;
    let lay = false;
    if ((peekNether(world).barter?.untaken ?? 0) < TOSS_FAILS) {
      const t = await ctx.call<{ tossed?: number }>('item.toss', { name: 'gold_ingot', count: 1, toward: { ...piglin.position } }).catch((e: Error) => ({ refused: e.message }));
      if (ctx.signal.aborted) throw new Error('aborted');
      if ('refused' in t) {
        // (a piglin in mid-jump has no floor under its feet: tried again from a fresh look, once; lava where the throw
        // would come down, or too far after all: let be for this trip)
        const n = tries.get(id) ?? 0;
        if (/^nothing to land on/.test(t.refused) && n < 1) { tries.set(id, n + 1); continue; }
        ctx.progress(`barter: no toss to the piglin at nether ${fmt(piglin.position)}: ${t.refused.slice(0, 120)}`);
        skipped.add(id);
        continue;
      }
      const w = await wait(BARTER_WAITS.takenLooks, () => taker() !== undefined);
      if (w === 'back') break;
      took = taker();
      if (took === undefined) lay = true;
      else if (peekNether(world).barter?.untaken) netherOf(world).barter!.untaken = 0;
    }
    if (took === undefined) {
      const q = find(id);
      if (q && !q.admiring && across(me, q.position) <= HAND_REACH) {
        const u = await ctx.call<{ success?: boolean }>('entity.use', { id, item: 'gold_ingot' }).catch(() => ({ success: false }));
        if (ctx.signal.aborted) throw new Error('aborted');
        if (u?.success && (await wait(BARTER_WAITS.takenLooks, () => taker() !== undefined)) === 'back') break;
        took = u?.success ? taker() : undefined;
        if (took !== undefined && lay) {
          const b = (netherOf(world).barter ??= {});
          b.untaken = (b.untaken ?? 0) + 1;
          if (b.untaken === TOSS_FAILS) ctx.progress(`barter: ${TOSS_FAILS} tossed ingots in a row lay untaken (the server's mobGriefing off?): the gold goes by hand from now on`);
        }
      }
    }
    if (took === undefined) {
      skipped.add(id);
      // (a toss left lying is its own gold: picked up again)
      if (lay && !(await pickUp(piglin.position, itemsBefore))) break;
      continue;
    }
    const barterer = took;
    given += 1;
    piglins.add(barterer);
    // ---- its admiring (the off hand empty again: the loot thrown), 10 s at most; a moment for it to come down; picked up on foot
    if ((await wait(BARTER_WAITS.admireLooks, () => !find(barterer)?.admiring)) === 'back') break;
    if ((await wait(BARTER_WAITS.lootLooks, () => false)) === 'back') break;
    const ok = await pickUp(find(barterer)?.position ?? piglin.position, itemsBefore);
    book(await inventory(ctx));
    if (!ok) break;
  }
  if (!gone && given) book(await inventory(ctx));

  // ---- done: said, and back into the hut and through its own portal
  const words = lootWords(loot);
  const did = given ? `bartered ${given} gold with ${plural(piglins.size, 'piglin')}: ${words || 'nothing picked up'}` : 'no barter';
  if (given) ctx.progress(`nether: bartered ${given} gold: ${words || 'nothing picked up'}`);
  if (gone || !(await inNether(ctx))) return { gain: lootCount, text: given ? `${did}; ${GONE.text}` : GONE.text };
  if (angry) {
    (netherOf(world).barter ??= {}).held = { day: gameDay(world), at: now(), why: angry.slice(0, 160) };
    ctx.progress(`nether: ${angry}: back to its portal, the barter held for the day`);
  }
  const why = `${stop ?? 'done'}${angry ? ', the barter held for the day' : ''}`;
  // (turned back by a danger before a barter: the place is not found empty of piglins, and the wrapper's dry mark
  // must not grow 20, 40, 80, 160 min as for one: the mark stays as it was, 20 min at least)
  const mark = danger && !given ? { mark: 'same' as const } : {};
  const here = footing(g, me);
  const back = here ? walkFrom(g, [here], p => same(p, start) || may(p)) : undefined;
  if (!back?.has(cellKey(start))) return { gain: lootCount, text: `${did}; ${why}; no way back on foot to its hut`, ...mark };
  const w = await walkAlong(ctx, pathOf(back, start), 4);
  if (w === 'gone') return { gain: lootCount, text: `${did}; ${GONE.text}` };
  if (w === 'stuck') return { gain: lootCount, text: `${did}; ${why}; stuck on the way back to its hut`, ...mark };
  const b = await backThroughOwn(ctx, arrived, homeShape, now);
  return { gain: lootCount, text: `${did}; ${why}; ${b.text}`, ...mark, ...(b.cameBack ? { cameBack: true as const } : {}) };
}
