import type { Goal, GoalContext, Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { freeChestTotals, takeFromChests } from './chests.js';
import { deepTripReady, pickMineStart, tripBudgetMs, MINE_FROM_BUILDS } from './mine.js';
import { nearestZone, type Zone } from './courtesy.js';
import { daylightLeft } from './schedule.js';
import { fuelFor } from './project.js';
import { tripCheck, diamondsWanted } from './deep.js';

/**
 * The community chests: chests on a shared server where players and bots leave surplus for each other (a friend put
 * "community1" down for it). They are never home storage: the bot only ever puts things in them, never takes.
 *
 * Two ways things get there:
 * - missions, only when asked in so many words ("gather 64 diamond for the community1 chest"): the bot gathers the
 *   count for the chest. What it gathers for a mission is the chest's, not the bot's: held apart until delivered
 *   (reserved in the home chests, left out of the kit's counts), then carried over trip by trip;
 * - donations, now and then: the precious things (diamonds, emeralds, gold, iron) beyond what the bot keeps for itself.
 * Anything else the bot gathers stays in its own chests.
 */

export interface Mission {
  id: number;
  /** what the chest gets (iron_ingot, diamond, oak_log ...) */
  item: string;
  count: number;
  /** the community chest's name */
  chest: string;
  /** got for it so far (raw ore counts toward its ingot), and carried over */
  gathered: number;
  delivered: number;
  status: 'active' | 'done' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  note?: string;
}

export interface CommunityMemory {
  chests: Record<string, Pos>;
  missions: Mission[];
  nextId: number;
  /** when the last donation round ran (ms) */
  lastDonation?: number;
  /** everything donated so far, by item */
  donated?: Record<string, number>;
}

/** The key the community's share of the home chests is held under in world.reserved (beside the build jobs' ids). */
export const RESERVE = 'community';
const MINUTE = 60_000;

/** How the bot gets an item: what to mine, what the mining yields, whether it's a trip under ground. */
export interface Source { mine: string; gives: string; underground: boolean }

const ORE = (n: string) => `${n}_ore,deepslate_${n}_ore`;
const SOURCES: Record<string, Source> = {
  diamond: { mine: ORE('diamond'), gives: 'diamond', underground: true },
  emerald: { mine: ORE('emerald'), gives: 'emerald', underground: true },
  lapis_lazuli: { mine: ORE('lapis'), gives: 'lapis_lazuli', underground: true },
  redstone: { mine: ORE('redstone'), gives: 'redstone', underground: true },
  coal: { mine: ORE('coal'), gives: 'coal', underground: true },
  iron_ingot: { mine: ORE('iron'), gives: 'raw_iron', underground: true },
  raw_iron: { mine: ORE('iron'), gives: 'raw_iron', underground: true },
  gold_ingot: { mine: ORE('gold'), gives: 'raw_gold', underground: true },
  raw_gold: { mine: ORE('gold'), gives: 'raw_gold', underground: true },
  copper_ingot: { mine: ORE('copper'), gives: 'raw_copper', underground: true },
  raw_copper: { mine: ORE('copper'), gives: 'raw_copper', underground: true },
  cobblestone: { mine: 'stone', gives: 'cobblestone', underground: false },
  clay_ball: { mine: 'clay', gives: 'clay_ball', underground: false },
  flint: { mine: 'gravel', gives: 'flint', underground: false }
};
/** Items that come out of the furnace: the ore the mission mines comes home raw and is smelted before it goes. */
const SMELTS_FROM: Record<string, string> = { iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper' };

/** Things that are no block to mine and come no other way the bot knows: a mission for them is refused. */
const UNSOURCEABLE = /^(netherite|ancient_debris|quartz|nether_|blaze|ender|shulker|elytra|totem|wool|.*_wool|.*_dye|string|leather|feather)/;

/** How the bot gets an item, or why it can't. */
export function sourceOf(item: string): Source | { error: string } {
  const name = item.replace(/^minecraft:/, '').trim();
  if (SOURCES[name]) return SOURCES[name];
  if (UNSOURCEABLE.test(name)) return { error: `the bot has no way to get ${name} by itself` };
  if (/_(ingot|nugget|block|planks|slab|stairs|pickaxe|sword|axe|shovel|hoe|helmet|chestplate|leggings|boots)$/.test(name)) {
    return { error: `${name} is made, not mined: ask for what it's made from (logs, ore, ingots), or put it in by hand` };
  }
  // a block that drops itself (logs, sand, gravel, dirt, the stone kinds)
  return { mine: name, gives: name, underground: false };
}

export function community(world: WorldMemory): CommunityMemory {
  world.community ??= { chests: {}, missions: [], nextId: 1 };
  world.community.chests ??= {};
  world.community.missions ??= [];
  world.community.nextId ??= 1;
  return world.community;
}

export const activeMissions = (world: WorldMemory) => (world.community?.missions ?? []).filter(m => m.status === 'active');
/** Gathered for a mission and not handed over yet. */
export const owed = (m: Mission) => Math.max(0, m.gathered - m.delivered);
/** Still to gather. */
export const left = (m: Mission) => Math.max(0, m.count - m.gathered);

/** What the community is owed, by item (the raw ore of an ingot counts as the ingot's too: it may still be raw). */
export function owedItems(world: WorldMemory): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of activeMissions(world)) {
    const n = owed(m);
    if (!n) continue;
    out[m.item] = (out[m.item] ?? 0) + n;
    const raw = SMELTS_FROM[m.item];
    if (raw) out[raw] = (out[raw] ?? 0) + n;
  }
  return out;
}

/** Hold the community's share of the home chests apart (other chores take only what's beyond it). */
export function syncReserve(world: WorldMemory): void {
  const o = owedItems(world);
  world.reserved ??= {};
  if (Object.keys(o).length) world.reserved[RESERVE] = o; else delete world.reserved[RESERVE];
}

/**
 * The bot's own things: what it carries less what it carries for a mission (the kit would craft the community's
 * diamonds into its own pickaxe). Takes from the largest stacks last, so the slots it keeps are the ones it uses.
 */
export function ownItems<T extends { name: string; count: number; slot: number }>(items: T[], world: WorldMemory): T[] {
  const o = owedItems(world);
  if (!Object.keys(o).length) return items;
  const out: T[] = [];
  const left = { ...o };
  for (const i of [...items].sort((a, b) => a.count - b.count)) {
    const take = i.slot < 36 ? Math.min(left[i.name] ?? 0, i.count) : 0;
    if (take) left[i.name] -= take;
    if (i.count - take > 0) out.push({ ...i, count: i.count - take });
  }
  return out.sort((a, b) => a.slot - b.slot);
}

// ------------------------------------------------------------------------------------------------ donations

/** What the bot keeps of each precious thing; what's beyond it goes to the community, a lot at a time. */
export const KEEP: Record<string, { keep: number; lot: number }> = {
  diamond: { keep: 8, lot: 4 },
  emerald: { keep: 0, lot: 4 },
  gold_ingot: { keep: 16, lot: 8 },
  iron_ingot: { keep: 48, lot: 16 }
};
/** How often a donation round may run: every few hours of play, not every day. */
export const DONATE_EVERY = 3 * 60 * MINUTE;

/**
 * The surplus to give: per precious thing, what the bot has (carried and in its chests, its own share only) beyond
 * what it keeps, when that's at least a lot. Diamonds only once its own diamond kit is done (diamondsWanted 0).
 */
export function donationPlan(have: Record<string, number>, diamondsStillWanted: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [item, k] of Object.entries(KEEP)) {
    if (item === 'diamond' && diamondsStillWanted > 0) continue;
    const spare = (have[item] ?? 0) - k.keep;
    if (spare >= k.lot) out[item] = spare;
  }
  return out;
}

function ownTotals(s: Pick<Snapshot, 'items'>, world: WorldMemory): Record<string, number> {
  const out: Record<string, number> = { ...freeChestTotals(world) };
  for (const i of ownItems(s.items.filter(i => i.slot < 36), world)) out[i.name] = (out[i.name] ?? 0) + i.count;
  return out;
}

// ------------------------------------------------------------------------------------------------ trips

const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;

/** Carry `items` to a community chest and put them in; returns what went in. Walks home after. */
async function handOver(ctx: GoalContext, chest: string, items: Record<string, number>): Promise<Record<string, number>> {
  const at = community(ctx.world).chests[chest];
  if (!at) throw new Error(`no community chest called ${chest}`);
  ctx.progress(`to the ${chest} chest at ${fmt(at)}`);
  await ctx.call('goto', { ...at, range: 3, timeoutMs: 240_000 }, 255_000).catch(() => undefined);
  const put: Record<string, number> = {};
  const fails: string[] = [];
  for (const [item, n] of Object.entries(items)) {
    if (n <= 0) continue;
    const r = await ctx.act('store-in-chest', { ...at, item, count: n });
    const got = Number(/^Stored (\d+)/.exec(r.text)?.[1] ?? 0);
    if (got) put[item] = got;
    if (!got || /chest is full/.test(r.text)) fails.push(`${item}: ${r.text.split('\n')[0].slice(0, 100)}`);
  }
  const back = await ctx.act('go-home', { name: 'home', timeoutMs: 300_000 });
  if (!Object.keys(put).length) throw new Error(`nothing went into ${chest}: ${fails.join('; ')}`);
  if (fails.length) ctx.progress(`${chest}: ${fails.join('; ')}`);
  if (!back.ok) ctx.progress(`could not get home: ${back.text.slice(0, 100)}`);
  return put;
}

async function carried(ctx: GoalContext, item: string): Promise<number> {
  const inv = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
  return inv.items.filter(i => i.slot < 36 && i.name === item).reduce((a, i) => a + i.count, 0);
}

/** Get a mission's owed share into the pockets (from the home chests, smelting raw ore first), then to its chest. */
async function deliver(ctx: GoalContext, m: Mission): Promise<string> {
  const due = owed(m);
  let have = await carried(ctx, m.item);
  if (have < due) have += await takeFromChests(ctx, m.item, due - have, { forJob: RESERVE });
  const raw = SMELTS_FROM[m.item];
  if (raw && have < due) {
    let ore = await carried(ctx, raw);
    if (ore < due - have) ore += await takeFromChests(ctx, raw, due - have - ore, { forJob: RESERVE });
    const n = Math.min(ore, due - have);
    const furnace = ctx.world.landmarks.furnace;
    if (n > 0 && furnace) {
      const fuel = await fuelFor(ctx);
      if (!fuel) throw new Error(`${n} ${raw} to smelt for the ${m.chest} chest, and nothing to burn`);
      ctx.progress(`smelting ${n} ${raw} for the ${m.chest} chest`);
      const r = await ctx.act('smelt-item', { ...furnace, inputItem: raw, inputCount: n, fuelItem: fuel, takeOutput: true, timeoutMs: n * 10_500 + 15_000 });
      if (!r.ok) throw new Error(`could not smelt ${raw}: ${r.text.slice(0, 120)}`);
      have = await carried(ctx, m.item);
    }
  }
  const n = Math.min(have, due);
  if (!n) throw new Error(`${due} ${m.item} owed to ${m.chest}, but none to be found (carried or in the chests)`);
  const put = await handOver(ctx, m.chest, { [m.item]: n });
  m.delivered += put[m.item] ?? 0;
  m.updatedAt = ctx.s.now;
  if (m.delivered >= m.count) { m.status = 'done'; m.note = `all ${m.count} delivered`; }
  syncReserve(ctx.world);
  return `${m.chest}: put in ${put[m.item] ?? 0} ${m.item} (${m.delivered}/${m.count})`;
}

/** One gathering run for a mission: a trip under ground (from the mine's departure point) or a surface run. */
async function gather(ctx: GoalContext, m: Mission, src: Source): Promise<string> {
  const want = Math.min(left(m), src.underground ? 16 : 64);
  const start = await carried(ctx, src.gives);
  let budget: number;
  if (src.underground) {
    budget = Math.min(10 * MINUTE, tripBudgetMs(ctx.s.timeOfDay, 2 * MINUTE));
    if (budget < 3 * MINUTE) throw new Error('too late in the day for a trip under ground');
    const zones = (await ctx.call<{ zones: Zone[] }>('foreign.zones').catch(() => ({ zones: [] as Zone[] }))).zones;
    const from = pickMineStart(ctx.s.home!, ctx.world.yard, ctx.world.zones?.mine?.[0], p => nearestZone(p, zones, true).distance);
    if (!from) throw new Error("every side of the yard has someone else's build by it: no trip under ground from here");
    (ctx.world.zones ??= {}).mine = [from];
    ctx.progress(`#${m.id} ${m.item} for ${m.chest}: out to the mine at (${from.x}, ${from.z})`);
    await ctx.call('goto', { ...from, xz: true, range: 4, timeoutMs: 180_000 }, 195_000);
    const here = (await ctx.call<{ position?: Pos }>('status').catch(() => undefined))?.position ?? from;
    const near = nearestZone({ x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) }, zones, true);
    if (near.distance < MINE_FROM_BUILDS) {
      delete ctx.world.zones.mine;
      await ctx.act('go-home', { name: 'home', timeoutMs: 300_000 });
      return `someone else's build ${Math.round(near.distance)} blocks from the mine site: the next trip sets out from another side`;
    }
  } else {
    budget = Math.min(6 * MINUTE, daylightLeft(ctx.s.timeOfDay) * 50 - 90_000);
    if (budget < 60_000) throw new Error('too late in the day');
  }
  ctx.progress(`#${m.id}: mining ${src.mine} for ${want} ${src.gives} (${Math.round(budget / MINUTE)} min)`);
  const r = await ctx.act('mine-blocks', { block: src.mine, count: start + want, timeoutMs: budget });
  const got = Math.min(want, Math.max(0, (await carried(ctx, src.gives)) - start));
  m.gathered += got;
  m.updatedAt = ctx.s.now;
  syncReserve(ctx.world);
  const line = `#${m.id} ${m.item} for ${m.chest}: got ${got} (${m.gathered}/${m.count} gathered)`;
  ctx.progress(line);
  if (src.underground) await ctx.act('go-home', { name: 'home', timeoutMs: 300_000 });
  if (!got) throw new Error(`${line}: ${r.text.split('\n')[0].slice(0, 120)}`);
  return line;
}

/** Hand over when a trip's worth is owed, or the last of it; otherwise gather. */
const deliverNow = (m: Mission, src: Source) => owed(m) > 0 && (left(m) === 0 || owed(m) >= (src.underground ? 1 : 32));

/**
 * The missions, oldest first: asked for by the user, so they rank with the build jobs (just under them), after
 * staying alive, the gear and the food stockpile. Trips under ground need the deep trip's kit (armour, food, torches).
 */
export const missionGoal: Goal = {
  name: 'community',
  priority: 42,
  timeoutMs: 14 * MINUTE,
  retryMs: 10 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || s.sleeping || s.dimension !== 'overworld' || !s.home || s.distHome > 16) return null;
    const m = activeMissions(world)[0];
    if (!m) return null;
    const src = sourceOf(m.item);
    if ('error' in src) return null;
    if (!world.community?.chests[m.chest]) return null;
    if (deliverNow(m, src)) return `#${m.id}: ${owed(m)} ${m.item} to take to ${m.chest}`;
    if (src.underground && !deepTripReady(tripCheck(s)).ok) return null; // the kit, the food goal and the stash first
    return `#${m.id}: ${left(m)} ${m.item} still to gather for ${m.chest}`;
  },
  run: async ctx => {
    const m = activeMissions(ctx.world)[0];
    if (!m) return 'no mission';
    const src = sourceOf(m.item);
    if ('error' in src) { m.status = 'cancelled'; m.note = src.error; return `#${m.id} dropped: ${src.error}`; }
    if (deliverNow(m, src)) return deliver(ctx, m);
    const line = await gather(ctx, m, src);
    // a load of ore comes home raw: the smelt goal (or the delivery itself) turns it into ingots first
    if (deliverNow(m, src) && !SMELTS_FROM[m.item]) return `${line}; ${await deliver(ctx, m)}`;
    return line;
  }
};

/** Now and then, the precious surplus to the first community chest. */
export const donateGoal: Goal = {
  name: 'donate',
  priority: 30,
  timeoutMs: 8 * MINUTE,
  retryMs: 30 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || s.sleeping || s.dimension !== 'overworld' || !s.home || s.distHome > 16) return null;
    const c = world.community;
    if (!c || !Object.keys(c.chests).length) return null;
    if (s.now - (c.lastDonation ?? 0) < DONATE_EVERY) return null;
    if (daylightLeft(s.timeOfDay) < 3000) return null;
    const plan = donationPlan(ownTotals(s, world), diamondsWanted(s, world));
    return Object.keys(plan).length ? `spare for the community: ${Object.entries(plan).map(([k, v]) => `${v} ${k}`).join(', ')}` : null;
  },
  run: async ctx => {
    const c = community(ctx.world);
    c.lastDonation = ctx.s.now;
    const chest = Object.keys(c.chests)[0];
    const plan = donationPlan(ownTotals(ctx.s, ctx.world), diamondsWanted(ctx.s, ctx.world));
    const items: Record<string, number> = {};
    for (const [item, n] of Object.entries(plan)) {
      const own = ownItems(ctx.s.items.filter(i => i.slot < 36 && i.name === item), ctx.world).reduce((a, i) => a + i.count, 0);
      const got = own >= n ? n : own + await takeFromChests(ctx, item, n - own);
      if (got) items[item] = Math.min(n, got);
    }
    if (!Object.keys(items).length) return 'the surplus was not in the chests after all';
    const put = await handOver(ctx, chest, items);
    c.donated ??= {};
    for (const [k, v] of Object.entries(put)) c.donated[k] = (c.donated[k] ?? 0) + v;
    return `donated to ${chest}: ${Object.entries(put).map(([k, v]) => `${v} ${k}`).join(', ')}`;
  }
};

/** brain-status lines. */
export function communityStatus(world: WorldMemory | undefined): string[] {
  const c = world?.community;
  if (!c || (!Object.keys(c.chests).length && !c.missions.length)) return [];
  const lines = [`Community chests: ${Object.entries(c.chests).map(([n, p]) => `${n} ${fmt(p)}`).join(', ') || 'none'}` +
    `${c.donated && Object.keys(c.donated).length ? `; donated so far: ${Object.entries(c.donated).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''}.`];
  for (const m of c.missions.filter(x => x.status === 'active' || Date.now() - x.updatedAt < 24 * 60 * MINUTE).slice(-5)) {
    lines.push(`  mission #${m.id} ${m.count} ${m.item} for ${m.chest}: ${m.status}, ${m.gathered} gathered, ${m.delivered} delivered${m.note ? ` (${m.note})` : ''}`);
  }
  return lines;
}
