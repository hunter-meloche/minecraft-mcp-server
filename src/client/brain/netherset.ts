import type { ChestStack, InventoryItem, ItemEnchantment } from '../tools.js';
import type { Goal, GoalContext, Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { better, fireProtected, gearKind, tier, type ArmourKind } from './kit.js';
import { kindChests, key, peekChest, sameStack, spareHeld, storeStackAt, storedStacks, takeSlot } from './chests.js';
import { out as afield, inYardOrNear } from './pockets.js';

/**
 * The Nether set (D1 of the progression plan, the user's "prioritize getting fire resistance gear for nether in
 * general"): a second armour set wanted with fire protection 4, worn for the Nether and for nothing else, while the
 * main set keeps its protection 4 (the two exclude each other: anvil.ts ENCHANTMENTS' `armor` set).
 *
 * - **Its pieces.** A diamond (or better) chestplate, leggings and boots with fire protection on them, and the golden
 *   helmet as its helmet: the Guardian wears a golden helmet down there whatever else it has (piglins leave a player in
 *   gold alone, Nether.helmetRank), so a diamond one with fire protection would never be worn. The golden helmet takes
 *   the same enchantments (gold's enchantability is 25 to diamond's 10). What tells a piece of the set from the main
 *   set's is its fire protection (kit.ts fireProtected), in the pockets and in the chests' stacks alike: no record of
 *   the set to go stale when the sort moves a stack. It is apart from the spare set (chests.ts SpareSet: plain pieces
 *   in their recorded slots for the regear after a death), which nothing here takes or moves.
 * - **Made by** the enchant chore (enchant.ts: a plain piece at the table, an offer showing fire protection, the seed
 *   turned with a book where none does) and **raised by** the anvil (anvil.ts: fire protection, unbreaking, mending
 *   and feather falling books onto it in its chest, NETHER_WANTED; a protection book never, and a fire protection book
 *   never onto the main set).
 * - **Worn** from the swap at home before the portal (wearNetherSet, the last of the Nether kit: nethersetup.ts
 *   fetchSetupKit): the bridge's gear check told to dress for the Nether (armor.wearset), the main set's pieces put in
 *   the gear chests by their slots (world.gearSwap). Never swapped in the Nether: a death there loses that set only.
 *   Back home the swap back (homeSetGoal) puts the main set on again and the Nether set in the chests.
 */

/** The Nether set's kinds, in the order the table makes them: the chestplate first (it covers the most). */
export const NETHER_SET_KINDS: readonly ArmourKind[] = ['chestplate', 'leggings', 'boots', 'helmet'];
/** The Nether set's helmet: the golden one the Nether kit takes anyway (mine.ts NETHER_TRIP). */
export const NETHER_HELMET = 'golden_helmet';

const SET = { fire_protection: 4, unbreaking: 3, mending: 1 };
/**
 * The enchantments wanted on each piece of the Nether set (the anvil's WANTED for it): fire protection 4, unbreaking 3,
 * mending 1, and the boots feather falling 4 (a fall in the Nether is a fall into lava as like as not). The helmet's
 * respiration and aqua affinity are not wanted: there is no water down there.
 */
export const NETHER_WANTED: Readonly<Record<ArmourKind, Readonly<Record<string, number>>>> = {
  helmet: SET, chestplate: SET, leggings: SET, boots: { ...SET, feather_falling: 4 }
};

const ARMOUR = new Set<string>(['helmet', 'chestplate', 'leggings', 'boots']);
const isArmour = (name: string) => ARMOUR.has(gearKind(name) ?? '');
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const MINUTE = 60_000;

/**
 * A piece the swap counts as the Nether set's, to wear down there and put away at home: fire protection on it, or a
 * golden helmet (plain or not: it is the helmet worn down there either way, and nothing at home wears one).
 */
export const isNetherPiece = (i: Pick<InventoryItem, 'name' | 'enchantments'>): boolean => isArmour(i.name) && (fireProtected(i) || i.name === NETHER_HELMET);

/**
 * A piece that makes its kind of the set whole: the golden helmet with fire protection, or a diamond-or-better
 * chestplate, leggings or boots with it.
 */
export function netherSetPiece(i: Pick<InventoryItem, 'name' | 'enchantments'>): boolean {
  const kind = gearKind(i.name);
  if (!kind || !ARMOUR.has(kind) || !fireProtected(i)) return false;
  return kind === 'helmet' ? i.name === NETHER_HELMET : tier(i.name) >= tier(`diamond_${kind}`);
}

/** The Guardian's armour tiers (Combat.ARMOR_TIER: kit.ts tier() puts copper apart, the bridge does not). */
const GUARDIAN_TIER: Record<string, number> = { leather: 1, golden: 2, copper: 2, chainmail: 3, iron: 4, turtle: 4, diamond: 5, netherite: 6 };

/**
 * A piece's rank to the Guardian dressed in the main set (pure; Combat.armorRank and setRank): its tier by the thousand,
 * its enchantment levels (a curse's against), and a fire protection piece 500 down. 0: no armour.
 */
export function mainRank(i: Pick<InventoryItem, 'name' | 'enchantments'>): number {
  const t = GUARDIAN_TIER[/^([a-z]+)_(?:helmet|chestplate|leggings|boots)$/.exec(i.name)?.[1] ?? ''] ?? 0;
  if (!t) return 0;
  const levels = (i.enchantments ?? []).reduce((a, e) => a + (/_curse$/.test(e.name) ? -e.level : e.level), 0);
  return t * 1000 + Math.max(-999, Math.min(999, levels)) - (fireProtected(i) ? 500 : 0);
}

/**
 * A main piece the Guardian dressed in the main set puts on over `on`, the piece worn (pure; Combat.pickArmor: strictly
 * better, never one bound by its curse); over nothing, any. A diamond one with fire protection worn still outranks a
 * plain iron one: taken out for the swap back, it never went on, and the swap back failed and came back every 5
 * minutes, the iron piece in and out of its chest each time.
 */
export const wornOver = (c: Pick<InventoryItem, 'name' | 'enchantments'>, on?: Pick<InventoryItem, 'name' | 'enchantments'>): boolean =>
  !c.enchantments?.some(e => e.name === 'binding_curse') && (!on || mainRank(c) > mainRank(on));

/** A worn armour slot (36 boots .. 39 helmet). */
const worn = (i: Pick<InventoryItem, 'slot'>) => i.slot >= 36 && i.slot <= 39;
const pocket = (i: Pick<InventoryItem, 'slot'>) => i.slot >= 0 && i.slot < 36;

/** The spare set's pieces as slots of their chests: never taken or moved by anything here. */
const spareKeys = (world: WorldMemory) => new Set(spareHeld(world).map(p => `${key(p.chest)}|${p.slot}|${p.name}`));
const notSpare = (world: WorldMemory) => {
  const kept = spareKeys(world);
  return (f: { chest: Pos; stack: ChestStack }) => !kept.has(`${key(f.chest)}|${f.stack.slot}|${f.stack.name}`);
};

/** The set's pieces in the home chests, as their stacks were last seen (with the chest each is in), the best first. */
export function storedNetherPieces(world: WorldMemory, kind?: ArmourKind): { chest: Pos; stack: ChestStack }[] {
  return storedStacks(world, st => netherSetPiece(st) && (!kind || gearKind(st.name) === kind)).filter(notSpare(world))
    .sort((a, b) => better(a.stack, b.stack));
}

/**
 * The kinds of the set it has no piece of yet, carried, worn or in the chests (storedNetherPieces), in the order the
 * table makes them. Pure.
 */
export function netherSetMissing(items: InventoryItem[], world: WorldMemory): ArmourKind[] {
  return NETHER_SET_KINDS.filter(kind => !items.some(i => netherSetPiece(i) && gearKind(i.name) === kind) && !storedNetherPieces(world, kind).length);
}

/** The set is wanted at all: the nether trips switched on, and the portal milestone done (its pieces are for the trips). */
export const netherSetDue = (world: WorldMemory): boolean => world.nether?.trips === true && !!world.progress?.done?.includes('nether-portal');

// ------------------------------------------------------------------------------------------------ the swap

/** A main set's piece put away for a trip: its name and enchantments, the chest and the chest's own slot it went into. */
export interface SwapPiece { name: string; chest: Pos; slot: number; enchantments?: ItemEnchantment[] }
/** world.gearSwap: the Nether set is on (since `at`, ms), and where the main set's pieces went. */
export interface GearSwap { wearing: 'nether'; stored: SwapPiece[]; at: number }

/**
 * The pockets as the kit counts them (chores.ts kit, kitSteps, the stock's kit gathering; worktasks.ts trip kit):
 * while the swap's record says the Nether set is on, the main set's pieces it put in the chests count as carried (slot
 * -1, never a pocket's). Else the kit saw the golden helmet alone after the swap, wanted a diamond helmet ("upgrade")
 * at 70 and stopped the Nether trip by home, the swap back (74) put the main set on again, and the next trip swapped
 * and was stopped the same way. The swap back is homeSetGoal's, not the kit's. Pure.
 */
export function withSwapped<T extends InventoryItem>(items: T[], world: WorldMemory): (T | InventoryItem)[] {
  const swap = world.gearSwap;
  if (swap?.wearing !== 'nether' || !swap.stored?.length) return items;
  return [...items, ...swap.stored.map((p): InventoryItem => ({ slot: -1, name: p.name, count: 1, ...(p.enchantments?.length ? { enchantments: p.enchantments, enchanted: true } : {}) }))];
}

/** What armor.wearset answers (client-mod Interact.java): the set dressed in, what went on, what is worn. An older jar: none of it. */
interface WearSet { set?: string; wore?: string[]; worn?: InventoryItem[] }

type Inv = { items: InventoryItem[] };
const inventory = async (ctx: GoalContext): Promise<InventoryItem[]> => (await ctx.call<Inv>('inventory').catch((): Inv => ({ items: [] }))).items ?? [];

/** Tell the bridge's gear check which set to dress in, and dress so now; undefined from a jar that has no such call. */
async function wearSet(ctx: GoalContext, set?: 'main' | 'nether'): Promise<WearSet | undefined> {
  const r = await ctx.call<WearSet>('armor.wearset', set ? { set } : {}).catch(() => undefined);
  return r && typeof r.set === 'string' ? r : undefined;
}

/**
 * Chests whose memory of a name holds more than the stacks it knows of it (a tool's text reply let them go: chests.ts
 * remember): looked into again before the swap or the table counts on them.
 */
export function unseenIn(world: WorldMemory, name: string): Pos[] {
  return world.landmarks.chests.filter(c => {
    const total = world.chestItems?.[key(c)]?.[name] ?? 0;
    const known = (world.chestStacks?.[key(c)] ?? []).filter(st => st.name === name).reduce((a, st) => a + st.count, 0);
    return total > known;
  });
}

/** Look into the chests whose stacks of these names are not all known (unseenIn), once each. */
async function lookOver(ctx: GoalContext, names: string[]): Promise<void> {
  const seen = new Set<string>();
  for (const n of names) {
    for (const c of unseenIn(ctx.world, n)) {
      if (seen.has(key(c)) || ctx.signal.aborted) continue;
      seen.add(key(c));
      await peekChest(ctx, c).catch((e: unknown) => ctx.progress(`chest at ${fmt(c)}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}

/** Put one carried piece into the gear chests by its pocket slot; where it went, or undefined. */
async function putAway(ctx: GoalContext, piece: InventoryItem): Promise<{ chest: Pos; slot?: number } | undefined> {
  return storeStackAt(ctx, piece.name, piece.slot, kindChests(ctx.world, piece.name));
}

/**
 * The swap at home before the portal, the Nether kit's last step (nethersetup.ts fetchSetupKit, once nothing else is
 * short): the Nether set's pieces out of the chests by their slots where none of a kind is carried (the best of each;
 * a golden helmet with fire protection over a plain one carried), the gear check told to dress for the Nether
 * (armor.wearset: the set's pieces and the golden helmet on, piece for piece, nothing bare), then every main set's
 * piece that came off into the gear chests by its pocket slot, each remembered where it went (world.gearSwap) for the
 * swap back. A kind the set has no piece of yet keeps its main piece on: it goes down there as before. A jar with no
 * armor.wearset swaps nothing and says so: everything goes along as before. Undefined when it is dressed (or could not
 * swap at all); else what keeps the trip at home: a main piece no chest took (a death down there would lose it).
 */
export async function wearNetherSet(ctx: GoalContext): Promise<string | undefined> {
  if (!(await wearSet(ctx))) {
    ctx.progress('nether set: this jar cannot swap armour sets (no armor.wearset): the main set goes along');
    return undefined;
  }
  let items = await inventory(ctx);
  await lookOver(ctx, ['diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots', NETHER_HELMET]);
  const took: string[] = [];
  for (const kind of NETHER_SET_KINDS) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const have = items.filter(i => (pocket(i) || worn(i)) && gearKind(i.name) === kind && (kind === 'helmet' ? i.name === NETHER_HELMET : netherSetPiece(i)));
    // the golden helmet the kit took may be a plain one, with the set's in a chest
    if (have.some(i => netherSetPiece(i)) || (kind !== 'helmet' && have.length)) continue;
    const f = storedNetherPieces(ctx.world, kind)[0];
    if (!f) continue;
    const got = await takeSlot(ctx, f.chest, f.stack.slot, 1).catch((e: unknown) => { ctx.progress(`nether set: the ${f.stack.name}: ${e instanceof Error ? e.message : String(e)}`); return 0; });
    if (got > 0) took.push(f.stack.name);
  }
  if (took.length) items = await inventory(ctx);
  const r = await wearSet(ctx, 'nether');
  if (!r) return 'the bridge did not dress for the nether (armor.wearset)';
  items = await inventory(ctx);
  // the main set's pieces that came off: of each kind whose worn piece is the Nether set's now, every other piece carried
  const dressed = new Set(items.filter(i => worn(i) && isNetherPiece(i)).map(i => gearKind(i.name)));
  // (and a plain golden helmet the kit took, where the set's own went on: the trip's 12 free slots were counted without it)
  const setHelmet = items.some(i => i.slot === 39 && netherSetPiece(i));
  const off = items.filter(i => pocket(i) && isArmour(i.name) && dressed.has(gearKind(i.name)) && (!isNetherPiece(i) || (setHelmet && i.name === NETHER_HELMET)));
  const stored: SwapPiece[] = [];
  const kept: string[] = [];
  for (const piece of off) {
    if (ctx.signal.aborted) break;
    const at = await putAway(ctx, piece);
    // (the plain golden helmet is no main piece: not remembered, and one no chest took is only a slot gone)
    if (isNetherPiece(piece)) continue;
    // (a jar that says no slot: in the chest all the same, found again by what it is)
    if (at) stored.push({ name: piece.name, chest: { ...at.chest }, slot: at.slot ?? -1, ...(piece.enchantments?.length ? { enchantments: piece.enchantments.map(e => ({ ...e })) } : {}) });
    else kept.push(piece.name);
  }
  const before = ctx.world.gearSwap?.wearing === 'nether' ? ctx.world.gearSwap.stored : [];
  ctx.world.gearSwap = { wearing: 'nether', stored: [...before, ...stored], at: ctx.s.now };
  const on = items.filter(i => worn(i) && isNetherPiece(i)).sort((a, b) => b.slot - a.slot).map(i => i.name);
  ctx.progress(`nether set: wearing ${on.length ? on.join(', ') : 'none of it'}${stored.length ? `; the main ${stored.map(p => p.name).join(', ')} into the chests` : ''}`);
  if (ctx.signal.aborted) throw new Error('aborted');
  return kept.length ? `the main ${kept.join(', ')}: no home chest took it (not taken down there)` : undefined;
}

/**
 * The main set's piece of a kind to wear again over `on` (the piece of it worn, if any: wornOver): the one the swap put
 * away (by its record), else the best other piece in the chests.
 */
function mainPieceFor(world: WorldMemory, kind: ArmourKind, on?: InventoryItem): { chest: Pos; stack: ChestStack } | undefined {
  const isMain = (st: ChestStack) => gearKind(st.name) === kind && !isNetherPiece(st) && wornOver(st, on);
  const free = storedStacks(world, isMain).filter(notSpare(world));
  for (const p of world.gearSwap?.stored ?? []) {
    if (gearKind(p.name) !== kind) continue;
    const like: ChestStack = { slot: p.slot, name: p.name, count: 1, ...(p.enchantments ? { enchantments: p.enchantments } : {}) };
    const there = free.find(f => key(f.chest) === key(p.chest) && f.stack.slot === p.slot && sameStack(f.stack, like)) ??
      free.find(f => sameStack(f.stack, like));
    if (there) return there;
  }
  return free.sort((a, b) => better(a.stack, b.stack))[0];
}

/** The piece of a kind worn, if any. */
const wornOf = (items: InventoryItem[], kind: ArmourKind) => items.find(i => worn(i) && gearKind(i.name) === kind);
/** A main piece of a kind carried that the Guardian would put on over the one worn (wornOver). */
const carriedMain = (items: InventoryItem[], kind: ArmourKind) => items.some(c => pocket(c) && gearKind(c.name) === kind && !isNetherPiece(c) && wornOver(c, wornOf(items, kind)));
/** A main piece of a kind to wear instead of what is worn: carried, or in the chests. */
const mainFor = (items: InventoryItem[], world: WorldMemory, kind: ArmourKind) => carriedMain(items, kind) || !!mainPieceFor(world, kind, wornOf(items, kind));

/** Kinds the bot wears the Nether set's piece of, or nothing, at home: what the swap back sees to. */
function kindsToSwapBack(items: InventoryItem[]): ArmourKind[] {
  return NETHER_SET_KINDS.filter(kind => {
    const on = items.find(i => worn(i) && gearKind(i.name) === kind);
    return !on || isNetherPiece(on);
  });
}

/**
 * Why the main set goes back on now, or null: awake at home in the overworld (the yard or near it), no work run under
 * way (the trip that just dressed for the Nether walks to the portal in its run), and the swap's record says the Nether
 * set is on, or a piece of it is worn with a main piece of its kind carried or in the chests to wear instead. A look
 * only (A16).
 */
export function homeSetWant(s: Snapshot, world: WorldMemory): string | null {
  if (s.sleeping || s.dimension !== 'overworld' || !inYardOrNear(s, world) || afield.work || afield.trip) return null;
  const on = s.items.filter(i => worn(i) && isNetherPiece(i)).sort((a, b) => b.slot - a.slot);
  const recorded = world.gearSwap?.wearing === 'nether';
  const instead = on.filter(i => mainFor(s.items, world, gearKind(i.name) as ArmourKind));
  if (!recorded && !instead.length) return null;
  return `home: the main set on again${on.length ? ` (the nether set's ${on.map(i => i.name).join(', ')} worn)` : ''}`;
}

/**
 * The swap back at home (74: above the regear and the kit, which would wear the spare set or make a new piece where
 * the main set's lies in the chests; below food): the gear check told to dress in the main set (armor.wearset), the
 * main set's pieces out of the chests (where the swap's record says, else the best other piece of the kind there; never
 * the spare set's) for every kind the Nether set's piece or nothing is worn of, dressed so, and the Nether set's pieces
 * that came off into the gear chests by their slots. The record is let go once every kind it can wear is the main
 * set's again. After a death down there the same: the main set lay at home, and only what it took (the tools) is the
 * regear's. Nothing done at all: a failure (the retry time).
 */
export const homeSetGoal: Goal = {
  name: 'home set',
  priority: 74,
  timeoutMs: 3 * MINUTE,
  retryMs: 5 * MINUTE,
  wants: (s, world) => homeSetWant(s, world),
  run: async ctx => {
    const first = await wearSet(ctx, 'main');
    let items = await inventory(ctx);
    const kinds = kindsToSwapBack(items);
    await lookOver(ctx, [...new Set(kinds.flatMap(k => [`diamond_${k}`, `netherite_${k}`, `iron_${k}`, ...(ctx.world.gearSwap?.stored ?? []).filter(p => gearKind(p.name) === k).map(p => p.name)]))]);
    const took: string[] = [];
    for (const kind of kinds) {
      if (ctx.signal.aborted) throw new Error('aborted');
      // one carried already (put away no further than the pockets) goes on as it is
      if (carriedMain(items, kind)) continue;
      const f = mainPieceFor(ctx.world, kind, wornOf(items, kind));
      if (!f) continue;
      const got = await takeSlot(ctx, f.chest, f.stack.slot, 1).catch((e: unknown) => { ctx.progress(`home set: the ${f.stack.name}: ${e instanceof Error ? e.message : String(e)}`); return 0; });
      if (got > 0) took.push(f.stack.name);
    }
    const r = await wearSet(ctx, 'main');
    // (an older jar: its own gear check wears the best of what is carried, every 2 s)
    items = await inventory(ctx);
    const away: string[] = [];
    const left: string[] = [];
    for (const piece of items.filter(i => pocket(i) && isNetherPiece(i))) {
      if (ctx.signal.aborted) break;
      // only what has a main piece worn in its place: a kind with none keeps the Nether set's on
      if (kindsToSwapBack(items).includes(gearKind(piece.name) as ArmourKind)) continue;
      if (await putAway(ctx, piece)) away.push(piece.name);
      else left.push(piece.name);
    }
    items = await inventory(ctx);
    const still = kindsToSwapBack(items).filter(k => mainFor(items, ctx.world, k));
    if (!still.length) delete ctx.world.gearSwap;
    const wore = [...new Set([...(first?.wore ?? []), ...(r?.wore ?? [])])];
    if (!took.length && !wore.length && !away.length) {
      if (!still.length) return 'the main set is on (nothing to swap back)';
      throw new Error(`could not put the main set on again: ${still.join(', ')} still the nether set's`);
    }
    const line = `home set: ${wore.length ? `wore ${wore.join(', ')} again` : `took ${took.join(', ') || 'nothing'} out`}` +
      `${away.length ? `; the nether set's ${away.join(', ')} into the chests` : ''}${left.length ? `; ${left.join(', ')} kept carried: no chest took it` : ''}` +
      `${still.length ? `; ${still.join(', ')} not on yet` : ''}`;
    ctx.progress(line);
    return line.replace(/^home set: /, '');
  }
};
