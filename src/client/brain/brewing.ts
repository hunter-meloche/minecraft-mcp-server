import { fromGate, no, onHomeLevel, outsideBy, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { haveFn, progressOf, stepOf, type Milestone, type Step, type StepResult } from './progress.js';
import { prepare } from './project.js';
import { chestTotals, freeChestTotals, key, kindChests, peekChest, storedStacks, storeStackAt, takeFromChests, takeSlot } from './chests.js';
import { ROOM } from './pockets.js';
import { holdHarmless } from './fluidpick.js';
import { goHome } from './homeward.js';
import { inFence } from './yardgates.js';
import { brewingGate } from './netherfortress.js';
import { CANE_KEEP } from './enchant.js';
import { unseenIn } from './netherset.js';
import { BREW_TICKS, brainRun, brewStandText, type BrewPut, type BrewStack, type BrewStatus, type BrewTake, type InventoryItem } from '../tools.js';

/**
 * Brewing (P4 of the progression plan): a brewing stand at the workshop's stand cell (the brewing milestone, after the
 * workshop and the portal, once a blaze rod is home: the fortress trips bring them), and a chore that keeps a stock of
 * three long potions in the chests, by their contents: fire resistance for the Nether (the debris and the tunnels drink
 * it, the fortress where lava is by its way, the Guardian's hook in lava or fire, the bastion later), strength for the
 * bastion's fight (P6), swiftness for the long walks. A batch is three water bottles filled at the workshop's water cell,
 * nether wart (awkward), the effect's ingredient and redstone (the long version), one brew of the stand's 20 s after
 * another, blaze powder for its fuel. Potions are told apart by their contents only: every one of them is `potion` by
 * name (the bridge's `potion` field, Brewing.java's `potion` on a put).
 *
 * Checked against the 26.3 jar (data/minecraft/recipe/brewing/*.json): potion_water_nether_wart (water -> awkward),
 * potion_awkward_magma_cream / _blaze_powder / _sugar (-> fire_resistance / strength / swiftness), and
 * potion_<effect>_redstone (-> long_<effect>). A brew takes 400 ticks and one of the ingredient for all three bottles;
 * one blaze powder fuels 20 brews (tools.ts BREW_TICKS, BREWS_PER_POWDER).
 *
 * Nothing here is used at the module's top level but its own constants (tree.ts builds the milestone as it loads, and
 * this module reaches the Nether's).
 */

const MINUTE = 60_000;
const ID = 'brewing';
/** The zone the stand's placing puts down: the stand's own cell. */
export const ZONE = 'brewing';

/** A potion the chore keeps in stock: its contents, how many, the ingredient that makes its base from awkward, the base. */
export interface BrewRow { potion: string; want: number; effect: string; base: string }

/**
 * The potions kept in the chests, by contents (the plan's): long fire resistance 6 (8:00 each: the debris trip drinks
 * one at its portal, the tunnel one at its face, the fortress one where lava is by its way, the Guardian's hook one in
 * lava), long strength 3 and long swiftness 3 (the bastion, P6). Only the long ones are counted: a plain potion of fire
 * resistance from the barter is drunk as any is, and counts toward the barter's own target (nether.ts NETHER_STOCK).
 *
 * Splash weakness for curing zombie villagers (P5d's cure route) is not on the list: a cure needs a golden apple too
 * and a zombie villager kept in a cell, and nothing of that route exists. WEAKNESS_FOR_CURING says so; its fermented
 * spider eye has its recipe (progress.ts RECIPES) for when it does.
 */
export const POTION_STOCK: readonly BrewRow[] = [
  { potion: 'long_fire_resistance', want: 6, effect: 'magma_cream', base: 'fire_resistance' },
  { potion: 'long_strength', want: 3, effect: 'blaze_powder', base: 'strength' },
  { potion: 'long_swiftness', want: 3, effect: 'sugar', base: 'swiftness' }
];
/** Splash weakness for curing (off: see POTION_STOCK). */
export const WEAKNESS_FOR_CURING = false;
/** Bottles a batch fills: the stand's three. */
export const BOTTLES = 3;
/** Blaze rods never made into powder: the last one is the stand's own, should the stand ever need putting back. */
export const ROD_KEEP = 1;
/** Nether wart never brewed: kept for replanting the wart farm (and its bare cells, once it stands: wartKeep). */
export const WART_KEEP = 2;
/** Pocket slots a batch fills at most: three water bottles (a potion does not stack), the wart, the effect and what it is made of, redstone, the powder. */
export const BATCH_SLOTS = 8;
/** Daylight a batch wants left (ticks): the fill at the water, three brews of 20 s, the walks. */
const DAY_LEFT = 2400;
/** The waits on the stand: a status every pollMs while a brew goes, every startMs for a brew's start (a test sets them to nothing; the counts stand). */
export const BREW_WAITS = { pollMs: 1000, startMs: 250 };
/** Looks for a brew's start after a put that did not show it yet: 2.5 s, a round trip and a lagging server's ticks. */
const START_LOOKS = 10;
/** Looks at a brew under way at most: its 20 s and some. */
const BREW_LOOKS = Math.ceil(BREW_TICKS / 20) + 15;

/** The brewing's memory: the stand as the last look saw it (its bottles' contents, the fuel), and a stand found gone. */
export interface BrewMemory {
  /** the bottles' contents as last seen (null an empty slot), and when */
  bottles?: (string | null)[];
  seenAt?: number;
  /** brews left in the burning powder, and the powder waiting in the fuel slot */
  fuelUses?: number;
  fuelCount?: number;
  /** the stand found gone from its cell: the milestone puts one back (and clears it) */
  gone?: Pos;
}

const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const pause = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const ok = (text: string): StepResult => ({ status: 'done', text });
const blocked = (text: string, retryMs = 10 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });
const shortOf = (text: string, need: Record<string, number>): StepResult => ({ status: 'blocked', text, retryMs: 3 * MINUTE, need });
const list = (short: Record<string, number>) => Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ');
const inYardBox = (p: { x: number; z: number }, y: NonNullable<WorldMemory['yard']>) => p.x >= y.x1 && p.x <= y.x2 && p.z >= y.z1 && p.z <= y.z2;
const STAND = /^brewing_stand$/;
const AIR = /^(air|cave_air|void_air)$/;
const blockAt = async (ctx: GoalContext, p: Pos) =>
  ((await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...p, width: 1, height: 1, length: 1 })).blocks[0] ?? '')
    .replace(/^minecraft:/, '').replace(/\[.*$/, '');
const inventory = async (ctx: GoalContext): Promise<InventoryItem[]> => (await ctx.call<{ items: InventoryItem[] }>('inventory')).items;
const carried = (items: InventoryItem[], is: (i: InventoryItem) => boolean) => items.filter(i => i.slot >= 0 && i.slot < 36 && is(i)).reduce((a, i) => a + i.count, 0);

// ------------------------------------------------------------------------------------------------ the stand

/**
 * The stand to brew at: the milestone's own (its zone), else one standing in the yard as the last look round home saw
 * it (findLandmarks: the improvement run's or a player's, which the milestone counts as its own).
 */
export function brewStand(world: WorldMemory): Pos | undefined {
  const own = world.zones?.[ZONE]?.[0];
  if (own) return { x: own.x, y: own.y, z: own.z };
  const seen = world.landmarks.brewing;
  return seen && world.yard && inYardBox(seen, world.yard) ? { ...seen } : undefined;
}

/** The workshop's cell kept for the stand (P1's `workshop:stand`), where the milestone puts it. */
export const standCell = (world: WorldMemory): Pos | undefined => {
  const c = world.zones?.['workshop:stand']?.[0];
  return c ? { x: c.x, y: c.y, z: c.z } : undefined;
};

/** A potion is this one: by its contents, never by its name alone (every potion is `potion`). */
export const potionIs = (contents: string) => (i: { name: string; potion?: string }) => i.name === 'potion' && i.potion === contents;

/** Potions of these contents at home: carried (the pockets and the off hand) and in the chests by their stacks as last seen. */
export function potionCount(items: InventoryItem[], world: WorldMemory, contents: string): number {
  const is = potionIs(contents);
  return items.filter(i => i.slot >= 0 && (i.slot < 36 || i.slot === 40) && is(i)).reduce((a, i) => a + i.count, 0) +
    storedStacks(world, is).reduce((a, f) => a + f.stack.count, 0);
}

/** The stock rows short of their targets, each with what the home has, in POTION_STOCK's order. */
export function potionShort(items: InventoryItem[], world: WorldMemory): { row: BrewRow; have: number }[] {
  return POTION_STOCK.map(row => ({ row, have: potionCount(items, world, row.potion) })).filter(r => r.have < r.row.want);
}

/** The stock in words: `long_fire_resistance 2/6, long_strength 3/3, long_swiftness 0/3`. */
export function stockLine(items: InventoryItem[], world: WorldMemory): string {
  return POTION_STOCK.map(r => `${r.potion} ${potionCount(items, world, r.potion)}/${r.want}`).join(', ');
}

/** What the wart farm needs kept: WART_KEEP, and the bare cells its round last found once the strip stands. */
export function wartKeep(world: WorldMemory): number {
  const bare = world.zones?.['wart:cell']?.length ? world.wart?.bare : 0;
  return WART_KEEP + (typeof bare === 'number' && bare > 0 ? Math.floor(bare) : 0);
}

// ------------------------------------------------------------------------------------------------ the batch, pure

/** Where a batch stands: no bottles in the stand yet, water bottles, awkward, its row's base potion, its long potion. */
export type BrewFrom = 'empty' | 'water' | 'awkward' | 'base' | 'long';

/** What a bottle of these contents is for a row: where it stands on the row's way, or undefined when it is off it. */
export function stageOf(row: BrewRow, contents: string | null | undefined): BrewFrom | undefined {
  if (contents === 'water') return 'water';
  if (contents === 'awkward') return 'awkward';
  if (contents === row.base) return 'base';
  if (contents === row.potion) return 'long';
  return undefined;
}

/** The ingredients still to go in, in order, from where a batch stands: wart, the effect, redstone. */
export function stepsFrom(row: BrewRow, from: BrewFrom): string[] {
  const all = ['nether_wart', row.effect, 'redstone'];
  return from === 'empty' || from === 'water' ? all : from === 'awkward' ? all.slice(1) : from === 'base' ? all.slice(2) : [];
}

/** What a bottle holds once an ingredient has brewed it, on a row's way. */
export function brewsInto(row: BrewRow, ingredient: string): string {
  return ingredient === 'nether_wart' ? 'awkward' : ingredient === 'redstone' ? row.potion : row.base;
}

/** A batch to brew: the row, where it stands, the ingredients to go in, whether the stand needs a powder of fuel and bottles. */
export interface BrewPlan { row: BrewRow; from: BrewFrom; steps: string[]; fuel: boolean; bottles: number; have: number }
/** Why there is none: everything in stock, or the means short (the Nether trips and the stock trips bring them). */
export type NoBrew = { why: string; stocked?: true };

/**
 * The stand's bottles as remembered, as a batch: all of one contents that is on some row's way (and the row, where
 * those contents are one row's alone), or undefined for an empty stand. `mixed`: bottles that are on no way together
 * (the run takes them out first).
 */
export function inStand(bottles: readonly (string | null)[] | undefined): { contents: string; row?: BrewRow } | 'mixed' | undefined {
  const held = (bottles ?? []).filter((b): b is string => typeof b === 'string' && b.length > 0);
  if (!held.length) return undefined;
  if (new Set(held).size > 1) return 'mixed';
  const contents = held[0];
  if (contents === 'water' || contents === 'awkward') return { contents };
  const row = POTION_STOCK.find(r => r.base === contents || r.potion === contents);
  return row ? { contents, row } : 'mixed';
}

/** How much of a kind the home has: carried and in the chests beyond what the jobs hold. */
const homeOf = (s: Pick<Snapshot, 'counts'>, world: WorldMemory, free = freeChestTotals(world)) => (kind: string) => (s.counts.get(kind) ?? 0) + (free[kind] ?? 0);

/**
 * The next batch, pure, or why none (the gate's and the run's): a batch the stand holds midway goes on (its row's, or
 * the first short row it can make from there); else the first row short of its target (potionShort) whose means are at
 * home. The means, carried and in the chests: three bottles, or those that top a stand of fewer water bottles up to
 * three (water bottles by contents, glass bottles, glass, or sand where a furnace smelts it), nether wart beyond what the wart farm keeps (wartKeep), the effect (magma cream, or a slime
 * ball and powder for one; blaze powder; sugar, or cane beyond the books' CANE_KEEP), redstone, and blaze powder for
 * the fuel and the effect, the last rod kept (ROD_KEEP). The fuel: one powder where the stand's own (as last seen) will
 * not do the batch's brews.
 */
export function brewPlan(s: Pick<Snapshot, 'counts' | 'items'>, world: WorldMemory, standBottles: readonly (string | null)[] | undefined = world.brewing?.bottles): BrewPlan | NoBrew {
  const have = homeOf(s, world);
  const short = potionShort(s.items, world);
  const stand = inStand(standBottles);
  const midway = stand && stand !== 'mixed' ? stand : undefined;
  const rows = midway?.row ? [midway.row] : short.length ? short.map(r => r.row) : midway ? [...POTION_STOCK] : [];
  if (!rows.length) return { why: `the potions are in stock (${stockLine(s.items, world)})`, stocked: true };
  const brewUses = (world.brewing?.fuelUses ?? 0) + 20 * (world.brewing?.fuelCount ?? 0);
  const powder = have('blaze_powder') + 2 * Math.max(0, have('blaze_rod') - ROD_KEEP);
  const why: string[] = [];
  for (const row of rows) {
    const from: BrewFrom = midway ? stageOf(row, midway.contents) ?? 'empty' : 'empty';
    const steps = stepsFrom(row, from);
    const fuel = steps.length > brewUses;
    const lack: string[] = [];
    // the bottles to put in: three for an empty stand; a stand of fewer water bottles (a run cut between its puts) topped
    // up to three, as a full set of reagents and three brews of fuel would go on one or two (later stages cannot be)
    const bottles = from === 'empty' ? BOTTLES : from === 'water' ? Math.max(0, BOTTLES - (standBottles ?? []).filter(b => b === 'water').length) : 0;
    if (bottles) {
      const ready = potionCount(s.items, world, 'water') + have('glass_bottle');
      // (bottles are crafted three of three glass: one or two glass or sand make none, and a batch counted on them filled
      // two bottles and failed every 20 min from then on)
      const glass = have('glass') + (world.landmarks.furnace ? have('sand') : 0);
      const makeable = 3 * Math.floor(glass / 3);
      if (ready < bottles && ready + makeable < bottles) lack.push(`${bottles} bottles (${ready} glass or water bottles, ${glass} glass or sand)`);
    }
    let powderUsed = fuel ? 1 : 0;
    for (const ing of steps) {
      if (ing === 'nether_wart' && have('nether_wart') - wartKeep(world) < 1) lack.push(`nether wart (${have('nether_wart')}, ${wartKeep(world)} kept for the wart farm)`);
      if (ing === 'redstone' && have('redstone') < 1) lack.push('redstone');
      if (ing === 'sugar' && have('sugar') < 1 && have('sugar_cane') <= CANE_KEEP) lack.push(`sugar (cane ${have('sugar_cane')}, ${CANE_KEEP} kept for books)`);
      if (ing === 'magma_cream' && have('magma_cream') < 1) {
        if (have('slime_ball') < 1) lack.push('magma cream (no slime ball)');
        else powderUsed++;
      }
      if (ing === 'blaze_powder') powderUsed++;
    }
    if (powderUsed > powder) lack.push(`blaze powder (${powderUsed} wanted, ${powder} at home, the last rod kept)`);
    if (!lack.length) {
      return { row, from, steps, fuel, bottles, have: potionCount(s.items, world, row.potion) };
    }
    why.push(`${row.potion} ${potionCount(s.items, world, row.potion)}/${row.want}: short of ${lack.join(', ')}`);
  }
  return { why: why.join('; ') };
}

/** A batch in words: `long_fire_resistance 0/6: nether_wart, magma_cream, redstone (from water bottles)`. */
export function describe(p: BrewPlan): string {
  const from = p.from === 'empty' ? 'three bottles filled at the water' : p.from === 'long' ? 'done in the stand' : `the stand's ${p.from === 'base' ? p.row.base : p.from} bottles`;
  return `${p.row.potion} ${p.have}/${p.row.want}: ${p.steps.join(', ') || 'take them out'} (from ${from}${p.fuel ? '; a blaze powder for fuel' : ''})`;
}

// ------------------------------------------------------------------------------------------------ the gate

/** In the yard (inside the fence line) on home's level: from where the stand is a walk on foot. */
const inYard = (s: Snapshot, world: WorldMemory) =>
  !!world.yard && !!s.home && s.dimension === 'overworld' && outsideBy(world.yard, s.position) === 0 && onHomeLevel(s.position, s.home);

/**
 * Run now? The "no" in this order: no stand (none yet, or found gone), nothing to brew (in stock, or the means short),
 * then what keeps a batch from going (not in the yard, too few free slots), the hour last. A look only (A16).
 */
const gate = (s: Snapshot, world: WorldMemory): Gate => {
  if (world.brewing?.gone) return { cause: 'unneeded', text: `the brewing stand at ${fmt(world.brewing.gone)} is gone (the brewing milestone puts one back)` };
  const at = brewStand(world);
  if (!at) return { cause: 'unneeded', text: world.progress?.done?.includes(ID) ? 'no brewing stand in the yard' : 'no brewing stand yet' };
  const plan = brewPlan(s, world);
  if ('why' in plan) return { cause: plan.stocked ? 'stocked' : 'unneeded', text: `brewing: ${plan.why}` };
  if (!inYard(s, world)) {
    return { cause: 'away', text: !s.home ? 'no home set' : s.dimension !== 'overworld' ? `in ${s.dimension}` : `${Math.round(s.distHome)} blocks from home, not in the yard on home's level (the brewing works from the yard)` };
  }
  if (36 - s.slotsUsed - ROOM.yard < BATCH_SLOTS) return no.pockets(s, 'brewing', 36 - ROOM.yard - BATCH_SLOTS + 1);
  return no.late(s, 'brewing', DAY_LEFT) ?? { want: describe(plan) };
};

// ------------------------------------------------------------------------------------------------ the stand, driven

/** The stand as a status says it, into the brewing's memory (the gate reads it: the batch midway, the fuel). */
function noteStand(world: WorldMemory, st: BrewStatus, now: number): void {
  if (!st.open) return;
  const mem = (world.brewing ??= {});
  mem.bottles = (st.bottles ?? [null, null, null]).map(b => (b ? b.potion ?? b.name : null));
  mem.fuelUses = st.fuelUses ?? 0;
  mem.fuelCount = st.fuel?.name === 'blaze_powder' ? st.fuel.count : 0;
  mem.seenAt = now;
}

/** brew.open from where the bot stands, walking on foot to within 2 of the stand when it is too far. */
async function openStand(ctx: GoalContext, at: Pos): Promise<BrewStatus> {
  try {
    return await ctx.call<BrewStatus>('brew.open', { ...at });
  } catch (e) {
    if (!/too far|sneaking/.test((e as Error).message)) throw e;
  }
  const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...at, range: 2, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
  if (walk?.arrived === false) throw new Error(`no way on foot to the brewing stand at ${fmt(at)}`);
  return ctx.call<BrewStatus>('brew.open', { ...at });
}

/** Until the brew under way is done (or BREW_LOOKS looks): the stand as it is then. */
async function brewDone(ctx: GoalContext, st: BrewStatus): Promise<BrewStatus> {
  for (let i = 0; i < BREW_LOOKS && st.brewing; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    await pause(BREW_WAITS.pollMs);
    st = await ctx.call<BrewStatus>('brew.status', {});
    noteStand(ctx.world, st, ctx.s.now);
  }
  if (st.brewing) throw new Error(`the brew at the stand did not end in ${BREW_LOOKS} looks: ${brewStandText(st)}`);
  return st;
}

/** The bottles' contents in a status (null an empty slot). */
const bottlesOf = (st: BrewStatus): (string | null)[] => (st.bottles ?? [null, null, null]).map((b: BrewStack | null) => (b ? b.potion ?? b.name : null));

/**
 * Water bottles into the pockets, `n` of them by their contents: those carried; then those in the chests by their slot
 * (takeSlot: the water ones, not the first potion); then glass bottles (carried, from the chests, else made of glass,
 * which prepare smelts from sand) filled at the workshop's water cell, from a floor cell beside it (A11: on foot only),
 * the bridge's useOn aimed just under the water's surface with a glass bottle in hand, the server's word on each
 * (`bottle`: filled, or why not). A fill the server did not confirm, or one it dropped for want of room, ends the fill:
 * another would be a guess too (as fluidpick.fillAt has it for buckets). Returns how many water bottles are carried.
 */
async function waterBottles(ctx: GoalContext, n: number): Promise<number> {
  const water = () => inventory(ctx).then(items => carried(items, potionIs('water')));
  let have = await water();
  for (const f of storedStacks(ctx.world, potionIs('water'))) {
    if (have >= n || ctx.signal.aborted) break;
    if (await takeSlot(ctx, f.chest, f.stack.slot, 1).catch(() => 0)) have = await water();
  }
  if (have >= n) return have;
  const want = n - have;
  const glass = () => inventory(ctx).then(items => carried(items, i => i.name === 'glass_bottle'));
  if ((await glass()) < want) await takeFromChests(ctx, 'glass_bottle', want - (await glass())).catch(() => 0);
  if ((await glass()) < want) {
    const short = await prepare(ctx, 'glass_bottle', want);
    if (Object.keys(short).length && !(await glass())) throw new Error(`no glass bottles to fill: short of ${list(short)}`);
  }
  const cell = ctx.world.zones?.['workshop:water']?.[0];
  if (!cell) throw new Error('no water cell at the workshop to fill the bottles at');
  const at = { x: cell.x, y: cell.y, z: cell.z };
  const beside = await besideWater(ctx, at);
  if (!beside) throw new Error(`no floor cell beside the workshop's water at ${fmt(at)} to stand on`);
  await holdHarmless(ctx);
  const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...beside, range: 0, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
  if (walk?.arrived === false) throw new Error(`no way on foot to the workshop's water at ${fmt(at)}`);
  let why = '';
  try {
    for (let i = 0; i < want; i++) {
      if (ctx.signal.aborted) throw new Error('aborted');
      if (!(await glass())) { why = 'no glass bottle left'; break; }
      await ctx.call('item.select', { name: 'glass_bottle' });
      type Used = { used: boolean; reason?: string; bottle?: string };
      const r = await ctx.call<Used>('useOn', { ...at, face: 'up' }, 15_000).catch((e: unknown): Used => ({ used: false, reason: e instanceof Error ? e.message : String(e) }));
      if (r.bottle && /^filled/.test(r.bottle)) {
        if (/no room/.test(r.bottle)) { why = r.bottle; break; }
        continue;
      }
      why = r.used ? r.bottle ?? 'nothing filled' : r.reason ?? 'not used';
      break;
    }
  } finally {
    await holdHarmless(ctx);
  }
  have = await water();
  if (have < n) throw new Error(`${have} of ${n} water bottles filled at the workshop's water at ${fmt(at)}${why ? `: ${why}` : ''}`);
  return have;
}

/** A floor cell beside a water cell in the floor (feet and head clear, a solid floor), from where the bot fills bottles; not the stand's own cell. */
async function besideWater(ctx: GoalContext, cell: Pos): Promise<Pos | undefined> {
  const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { x: cell.x - 1, y: cell.y, z: cell.z - 1, width: 3, height: 3, length: 3 });
  const at = (dx: number, dy: number, dz: number) => (blocks[(dx + 1) + (dz + 1) * 3 + dy * 9] ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const floor = at(dx, 0, dz), feet = at(dx, 1, dz), head = at(dx, 2, dz);
    if (floor && !AIR.test(floor) && !/^(water|lava)$/.test(floor) && AIR.test(feet) && AIR.test(head)) return { x: cell.x + dx, y: cell.y + 1, z: cell.z + dz };
  }
  return undefined;
}

/** What is made of blaze powder: the powder itself, and the magma cream. */
const OF_POWDER = new Set(['blaze_powder', 'magma_cream']);

/**
 * `n` of an ingredient (or the fuel's powder) carried: from the chests, else made (magma cream, sugar, powder). The
 * last blaze rod is kept (ROD_KEEP): prepare holds that many of the carried rods back from the craft, so the rods it
 * may use are carried first (it takes from a chest only what it counts short, and with the kept one held back it
 * counted the first rod out of the chest as none, and came back short of a rod with three in the chests).
 */
async function carry(ctx: GoalContext, item: string, n = 1): Promise<void> {
  const has = async () => carried(await inventory(ctx), i => i.name === item);
  const had = await has();
  if (had >= n) return;
  if (item === 'nether_wart' || item === 'redstone') {
    await takeFromChests(ctx, item, n - had).catch(() => 0);
    if (await has() < n) throw new Error(`no ${item} to brew with`);
    return;
  }
  // the powder the craft may use: a rod for every two short (magma cream takes one), the kept one on top
  const powder = carried(await inventory(ctx), i => i.name === 'blaze_powder');
  const powderShort = item === 'blaze_powder' ? n - powder : item === 'magma_cream' ? n - had - powder : 0;
  if (OF_POWDER.has(item) && powderShort > 0) {
    const rods = carried(await inventory(ctx), i => i.name === 'blaze_rod');
    const want = ROD_KEEP + Math.ceil(powderShort / 2);
    if (rods < want) await takeFromChests(ctx, 'blaze_rod', want - rods).catch(() => 0);
  }
  const short = await prepare(ctx, item, n, 0, { blaze_rod: ROD_KEEP });
  if (Object.keys(short).length || await has() < n) throw new Error(`no ${item} for the brew: short of ${list(Object.keys(short).length ? short : { [item]: n - (await has()) })}`);
}

/** Put the batch's ingredient in and wait out its brew: the bottles must come out as `into` (they did not: why). */
async function brewWith(ctx: GoalContext, item: string, into: string): Promise<BrewStatus> {
  const put = await ctx.call<BrewPut>('brew.put', { into: 'ingredient', name: item, count: 1 }, 15_000);
  noteStand(ctx.world, put, ctx.s.now);
  // the brew starts on the server, and its word comes a round trip and a tick or two after the put's own: a few looks
  // more before it counts as not started (a put that answered first had the run fail on a stand that brewed)
  let started: BrewStatus = put;
  for (let i = 0; i < START_LOOKS && !started.brewing; i++) {
    if (ctx.signal.aborted) throw new Error('aborted');
    await pause(BREW_WAITS.startMs);
    started = await ctx.call<BrewStatus>('brew.status', {});
    noteStand(ctx.world, started, ctx.s.now);
  }
  if (!started.brewing) throw new Error(`the ${item} did not start a brew: ${brewStandText(started)}`);
  const st = await brewDone(ctx, started);
  const now = bottlesOf(st).filter((b): b is string => !!b);
  if (!now.length || now.some(b => b !== into)) throw new Error(`the ${item} brewed ${now.join(', ') || 'nothing'}, not ${into}: ${brewStandText(st)}`);
  return st;
}

/**
 * By day, from the yard, at the stand: the next batch of brewPlan. The stand looked into first (a brew under way waited
 * out; bottles off every row's way, or a batch done, taken out); then what the batch takes into the pockets (the
 * ingredients, the fuel's powder, three water bottles filled at the workshop's water); then at the stand: the powder in
 * where its fuel will not do the batch, the bottles in, and one ingredient after another, each brew waited out (20 s)
 * and its bottles checked by their contents; the potions out, the stand closed (in a finally: it keeps brewing with its
 * menu shut, and keeps what is in it), and each potion stored by its pocket slot in the potions' chests (the gear's:
 * storeStackAt remembers them by their stacks, so they are counted by contents). A batch cut short stays in the stand,
 * and the next run goes on from where its bottles stand.
 */
export const brewGoal: Goal = {
  name: 'brewing',
  priority: 31,
  // the glass smelted from sand for the bottles can come first (prepare: a furnace load)
  timeoutMs: 8 * MINUTE,
  retryMs: 20 * MINUTE,
  gate,
  ...fromGate(gate),
  // a batch a minute or two long that can always wait: it takes over at the hand-over, never stops what runs
  cuts: () => false,
  gains: true,
  run: async ctx => {
    const at = brewStand(ctx.world);
    if (!at) return 'no brewing stand';
    // the chests whose potions are not all known by their stacks looked into first: the stash puts potions away by
    // name, and its text reply makes that chest's memory forget every potion in it, so the stock read empty and a batch
    // was brewed for potions in the chest. A look costs a walk to the chest, a batch a blaze rod
    const unseen = unseenIn(ctx.world, 'potion');
    if (unseen.length) {
      const seen = new Set<string>();
      for (const c of unseen) {
        if (ctx.signal.aborted || seen.has(key(c))) continue;
        seen.add(key(c));
        await peekChest(ctx, c).catch((e: unknown) => ctx.progress(`chest at ${fmt(c)}: ${e instanceof Error ? e.message : String(e)}`));
      }
      const plan = brewPlan(ctx.s, ctx.world);
      if ('why' in plan && !inStand(ctx.world.brewing?.bottles)) return `looked into ${seen.size} chest${seen.size === 1 ? '' : 's'}; nothing to brew: ${plan.why}`;
    }
    // the walk with a harmless hand, on foot (A11)
    await holdHarmless(ctx);
    const here = (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
    if (!inFence(ctx.world, here)) await goHome(ctx, 180_000).catch(() => undefined);
    const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...at, range: 2, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
    if (walk?.arrived === false) throw new Error(`no way on foot to the brewing stand at ${fmt(at)}`);
    const block = await blockAt(ctx, at);
    if (!STAND.test(block)) {
      if (!AIR.test(block)) throw new Error(`no brewing stand at ${fmt(at)} (${block || 'nothing'})`);
      (ctx.world.brewing ??= {}).gone = { ...at };
      return `the brewing stand at ${fmt(at)} is gone: the brewing milestone puts one back`;
    }
    const taken: InventoryItem[] = [];
    let did = '';
    let none: string | undefined;
    try {
      // ---- the stand as it is: a brew under way waited out, what is off the batch's way taken out
      let st = await openStand(ctx, at);
      noteStand(ctx.world, st, ctx.s.now);
      st = await brewDone(ctx, st);
      const was = inStand(bottlesOf(st));
      if (was === 'mixed' || (was && was.row && was.contents === was.row.potion)) {
        const r = await ctx.call<BrewTake>('brew.take', {}, 15_000);
        taken.push(...r.taken);
        noteStand(ctx.world, r, ctx.s.now);
        st = r;
      }
      // (the pockets as they are now: what came out of the stand counts, as the run's snapshot did not see it)
      const items = await inventory(ctx);
      const counts = new Map<string, number>();
      for (const i of items) if (i.slot >= 0 && i.slot < 36) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
      const plan = brewPlan({ items, counts }, ctx.world, bottlesOf(st));
      if ('why' in plan) none = plan.why;
      else did = await batchAt(ctx, at, plan, taken);
    } finally {
      // (outside the brain's run: one it gave up has every call refused, the close too, and the stand's menu stayed
      // open: the Guardian keeps no gear up under a screen, and the next job worked with the stand's menu open)
      await brainRun.exit(() => ctx.call('brew.close', {})).catch(() => undefined);
      // what came out of the stand into the chests by its pocket slot (the potions' chests first), remembered by its stacks
      let stored = 0;
      for (const p of taken.filter(i => i.name === 'potion' && i.slot >= 0 && i.slot < 36)) {
        if (ctx.signal.aborted) break;
        if (await storeStackAt(ctx, 'potion', p.slot, kindChests(ctx.world, 'potion')).catch(() => undefined)) stored++;
      }
      if (stored) did = did ? `${did}; ${stored} stored` : `took ${stored} potion${stored === 1 ? '' : 's'} out of the stand and stored them`;
    }
    const stock = stockLine(await inventory(ctx).catch(() => ctx.s.items), ctx.world);
    return none ? `${did ? `${did}; ` : ''}nothing to brew: ${none}` : `${did}; stock ${stock}`;
  }
};

/**
 * A batch at the stand (brewGoal's run, the stand looked into): the menu shut while it gathers (the chests and the
 * water are walks of their own); the ingredients, the fuel's powder and the bottles into the pockets; at the stand
 * again the powder, the bottles, and the brews one after another. What comes out of the stand goes into `taken`.
 */
async function batchAt(ctx: GoalContext, at: Pos, plan: BrewPlan, taken: InventoryItem[]): Promise<string> {
  await ctx.call('brew.close', {}).catch(() => undefined);
  // the effect before the fuel: one rod's two powders are the magma cream's and the fuel's. The powder last, all of
  // it at once: the strength's step and the fuel are two (one carried for both, the fuel burnt the one, and the
  // strength had none left, the bottles stuck at awkward)
  for (const ing of plan.steps) if (ing !== 'blaze_powder') await carry(ctx, ing);
  const powder = (plan.fuel ? 1 : 0) + plan.steps.filter(s => s === 'blaze_powder').length;
  if (powder) await carry(ctx, 'blaze_powder', powder);
  if (plan.bottles) await waterBottles(ctx, plan.bottles);
  await holdHarmless(ctx);
  let st = await openStand(ctx, at);
  noteStand(ctx.world, st, ctx.s.now);
  // an ingredient left in the stand (a put whose brew never started, a player's) out first: water bottles and magma
  // cream, sugar, powder or redstone brew mundane the moment the first bottle goes in
  if ((plan.from === 'empty' || plan.from === 'water') && st.ingredient && st.ingredient.name !== plan.steps[0] && !st.brewing) {
    const r = await ctx.call<BrewTake>('brew.take', { from: 'ingredient' }, 15_000);
    noteStand(ctx.world, r, ctx.s.now);
    taken.push(...r.taken);
    if (!r.ok) throw new Error(`the ${st.ingredient.name} left in the stand did not come out: ${r.reason ?? 'no answer'}`);
    st = r;
  }
  if (plan.fuel) noteStand(ctx.world, await ctx.call<BrewPut>('brew.put', { into: 'fuel', name: 'blaze_powder', count: 1 }, 15_000), ctx.s.now);
  for (let i = 0; i < plan.bottles; i++) {
    noteStand(ctx.world, await ctx.call<BrewPut>('brew.put', { into: 'bottle', name: 'potion', potion: 'water' }, 15_000), ctx.s.now);
  }
  // the stand's stage written to brain.json as it goes (the brain saves at a run's end): a restart mid-batch had the
  // disk's empty stand of the batch before, the gate planned from three new bottles, and with the home's last wart (or
  // slime ball) in the stand it said short and never looked at the awkward bottles waiting there
  ctx.save?.();
  const way = [plan.from === 'empty' ? 'water' : plan.from === 'base' ? plan.row.base : plan.from];
  for (const ing of plan.steps) {
    const into = brewsInto(plan.row, ing);
    await brewWith(ctx, ing, into);
    ctx.save?.();
    way.push(into);
    ctx.progress(`the ${ing} brewed the bottles into ${into}`);
  }
  const r = await ctx.call<BrewTake>('brew.take', {}, 15_000);
  noteStand(ctx.world, r, ctx.s.now);
  taken.push(...r.taken);
  if (!r.ok) throw new Error(`the potions did not come out of the stand: ${r.reason ?? 'no answer'}`);
  const made = r.taken.filter(potionIs(plan.row.potion)).reduce((a, i) => a + i.count, 0);
  ctx.gain(made);
  const did = `brewed ${made} ${plan.row.potion} (${way.join(' -> ')})${r.fuelUses !== undefined ? `; ${r.fuelUses} brew${r.fuelUses === 1 ? '' : 's'} left in the fuel` : ''}`;
  ctx.progress(did);
  return did;
}

// ------------------------------------------------------------------------------------------------ the milestone

/**
 * A brewing stand standing in the yard as the last look round home saw it (findLandmarks), not the milestone's own:
 * the improvement run's or a player's, which the milestone counts as its own.
 */
export function standStanding(world: WorldMemory): boolean {
  const seen = world.landmarks.brewing;
  return !!seen && !!world.yard && inYardBox(seen, world.yard);
}

/**
 * A blaze rod home first (netherfortress.ts brewingGate: the fortress trips bring them). A wait the project cannot end
 * by itself (`waits`): it stops nothing for it, and says why.
 */
export const rodStep: Step = {
  name: 'a blaze rod from the fortress',
  waits: v => brewingGate(v.s, v.world)?.text,
  run: async ctx => {
    const g = brewingGate(ctx.s, ctx.world);
    return g ? blocked(g.text, 30 * MINUTE) : ok('a blaze rod home');
  }
};

/** A brewing stand carried or in the chests, else crafted (a blaze rod over three cobblestone, at a table). */
export const craftStandStep: Step = {
  name: 'craft a brewing stand',
  run: async ctx => {
    if (haveFn(ctx.s, ctx.world)('brewing_stand') >= 1) return ok('a brewing stand at home');
    const short = await prepare(ctx, 'brewing_stand', 1);
    await holdHarmless(ctx);
    if (Object.keys(short).length) return shortOf(`a brewing stand: short of ${list(short)}`, short);
    return ok('crafted a brewing stand');
  }
};

/**
 * The stand into the workshop's stand cell (`workshop:stand`): on foot into the room (A11), from inside the fence; the
 * cell read first (a stand there already is the one; anything else there is left alone, and it waits), the stand
 * fetched or made again if the stash put it away, placed on the floor and read again. Remembered as the zone `brewing`;
 * a stand the brewing found gone is let go.
 */
export const placeStandStep: Step = {
  name: 'put the brewing stand in the workshop',
  run: async ctx => {
    const at = standCell(ctx.world);
    if (!at) return blocked('the workshop keeps no cell for the stand (workshop:stand): a brewing stand put in the yard by hand will do', 60 * MINUTE);
    const there = await blockAt(ctx, at);
    const keep = (text: string) => {
      ctx.world.zones ??= {};
      ctx.world.zones[ZONE] = [{ ...at }];
      if (ctx.world.brewing) delete ctx.world.brewing.gone;
      return ok(text);
    };
    if (STAND.test(there)) return keep(`a brewing stand stands at ${fmt(at)}`);
    if (!there) return blocked(`the stand's cell at ${fmt(at)} is out of sight`, 5 * MINUTE);
    if (!AIR.test(there)) return blocked(`${there} stands in the stand's cell at ${fmt(at)}: left alone`, 60 * MINUTE);
    if (carried(await inventory(ctx), i => i.name === 'brewing_stand') < 1) {
      const short = await prepare(ctx, 'brewing_stand', 1);
      if (Object.keys(short).length) return shortOf(`the brewing stand to put in the workshop: short of ${list(short)}`, short);
    }
    await holdHarmless(ctx);
    const here = (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
    if (!inFence(ctx.world, here)) await goHome(ctx, 180_000).catch(() => undefined);
    if (ctx.signal.aborted) return { status: 'progress', text: 'stopped on the way to the workshop' };
    const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...at, range: 2, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
    if (walk?.arrived === false) return blocked(`no way on foot into the workshop to put the brewing stand at ${fmt(at)}`);
    const r = await ctx.act('place-block', { ...at, item: 'brewing_stand', faceDirection: 'down' });
    if (!STAND.test(await blockAt(ctx, at))) return blocked(`could not put the brewing stand at ${fmt(at)}: ${r.text.split('\n')[0].slice(0, 120)}`);
    return keep(`put the brewing stand in the workshop at ${fmt(at)}`);
  }
};

/**
 * Glass bottles the milestone gets in before it is done: the whole stock's (POTION_STOCK, 12), as nothing else fetches
 * the sand for them (the brewing's gate writes nothing, A16). Drunk potions give theirs back; a death down there loses them.
 */
export const BOTTLE_STOCK = POTION_STOCK.reduce((a, r) => a + r.want, 0);

/**
 * BOTTLE_STOCK glass bottles at home (carried and in the chests, the water bottles with them): made of glass at the
 * table, the glass smelted from the chests' sand (prepare). Short, it writes the sand still to fetch where the stock
 * trips read it (progress.need: a glass a sand; no stock row fetches glass, as the hall's windows found: "short of 1
 * glass" and nobody went).
 */
export const bottlesStep: Step = {
  name: 'glass bottles for the brewing',
  run: async ctx => {
    const home = async () => {
      const items = await inventory(ctx);
      return carried(items, i => i.name === 'glass_bottle') + (chestTotals(ctx.world).glass_bottle ?? 0) + potionCount(items, ctx.world, 'water');
    };
    const had = await home();
    if (had >= BOTTLE_STOCK) return ok(`${had} glass bottles for the brewing`);
    const short = await prepare(ctx, 'glass_bottle', BOTTLE_STOCK - potionCount(await inventory(ctx), ctx.world, 'water'));
    await holdHarmless(ctx);
    const now = await home();
    if (now >= BOTTLE_STOCK || !Object.keys(short).length) return ok(`${now} glass bottles for the brewing`);
    const sand = (short.sand ?? 0) + (short.glass ?? 0);
    const rest = Object.fromEntries(Object.entries(short).filter(([k]) => k !== 'sand' && k !== 'glass' && k !== 'glass_bottle'));
    const need = sand ? { ...rest, sand } : Object.keys(rest).length ? rest : short;
    if (sand) progressOf(ctx.world).need = need;
    return shortOf(`glass bottles for the brewing (${now} of ${BOTTLE_STOCK}): short of ${list(need)}`, need);
  }
};

/**
 * The brewing milestone (P4), after the workshop and the portal: a blaze rod home, a brewing stand crafted, and put in
 * the workshop's stand cell, and glass bottles for the first batches. Done once the world shows it: its zone, with the stand put down (and not found gone since),
 * or a brewing stand already standing in the yard (standStanding). Due again when the brewing found its stand gone.
 */
export function brewingMilestone(prereqs: string[]): Milestone {
  return {
    id: ID,
    title: 'a brewing stand',
    prereqs,
    done: v => !v.world.brewing?.gone && ((!!v.world.zones?.[ZONE]?.length && !(stepOf(v.world.progress, ID) > 0)) || standStanding(v.world)),
    again: v => !!v.world.brewing?.gone,
    steps: [rodStep, craftStandStep, placeStandStep, bottlesStep]
  };
}
