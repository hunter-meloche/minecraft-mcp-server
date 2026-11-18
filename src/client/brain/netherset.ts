import type { ChestStack, InventoryItem, ItemEnchantment } from '../tools.js';
import type { Goal, GoalContext, Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { better, fireProtected, gearKind, isWorn, tier, type ArmourKind } from './kit.js';
import { kindChests, key, peekChest, sameStack, spareHeld, storeStackAt, storedStacks, takeSlot } from './chests.js';
import { out as afield, inYardOrNear } from './pockets.js';

/**
 * The Nether gear (D1 of the progression plan, the user's "prioritize getting fire resistance gear for nether in
 * general", made over on Nov 18: "we just need the fire protection 4 gold helmet to do full nether missions along with
 * protection 4 diamond"): the golden helmet with fire protection 4 worn over the main set's diamond chestplate,
 * leggings and boots with their protection 4.
 *
 * - **Why that is enough.** Armour's enchantment protection factor (EPF) adds up over the four pieces worn against a
 *   kind of damage, to a cap of 20 (26.3 CombatRules.getDamageAfterMagicAbsorb clamps it to 0..20, 4% each: 80%).
 *   26.3's data/minecraft/enchantment/protection.json gives 1 a level against all damage, fire_protection.json 2 a
 *   level against damage tagged #minecraft:is_fire only (lava, fire, burning, hot floor, fireballs): FIRE_EPF. So
 *   fire protection 4 on the helmet (8) and protection 4 on the three main pieces (3 x 4) are 20 against fire, the cap,
 *   and the 12 of general protection stay (a whole fire protection set would have none). fireGear counts it.
 * - **The helmet.** Golden: the Guardian wears a golden helmet down there whatever else it has (piglins leave a player
 *   in gold alone, Nether.helmetRank), and gold's enchantability is 25 to diamond's 10. It wants fire protection 4,
 *   unbreaking 3 and mending (NETHER_HELMET_WANTED), never protection (the two exclude each other: anvil.ts
 *   ENCHANTMENTS' `armor` set). **Made by** the enchant chore (enchant.ts netherTableJob: the plain golden helmet at
 *   the table, an offer showing fire protection taken, the seed turned with a book where none does) and **raised by**
 *   the anvil (anvil.ts: fire protection, unbreaking and mending books onto it, in its chest between trips; its repair
 *   with gold ingots). What tells it from a plain one is its fire protection (netherHelmetPiece), in the pockets and in
 *   the chests' stacks alike.
 * - **Worn** from the swap at home before the portal (wearNetherSet, the last of the Nether kit: nethersetup.ts
 *   fetchSetupKit): the best golden helmet out of the chests, the bridge's gear check told to dress for the Nether
 *   (armor.wearset), the main diamond helmet put in the gear chests by its slot (world.gearSwap). The chestplate,
 *   leggings and boots stay on: nothing else is swapped. Back home the swap back (homeSetGoal) puts the main helmet on
 *   again and the golden one in the chests.
 * - **The gates.** The fortress and the tunnel go only with fireGear's 20 against fire and every main piece sound
 *   (netherfortress.ts fortressReady, nethertunnel.ts tunnelReady, and again at the set-out); brain-status says it
 *   (netherGearLine).
 * - **The old Nether set's pieces** (diamond ones with fire protection, made until Nov 18): plain stock in the chests.
 *   Nothing here takes, swaps, enchants or throws them away; the kit ranks them after a main piece of their tier
 *   (kit.ts better). The spare set (chests.ts SpareSet) is apart from all of it, and nothing here takes or moves it.
 */

/** The Nether helmet: the golden one the Nether kit takes anyway (mine.ts NETHER_TRIP). */
export const NETHER_HELMET = 'golden_helmet';
/** The enchantments wanted on it (the anvil's WANTED for it): no respiration nor aqua affinity, there is no water down there. */
export const NETHER_HELMET_WANTED: Readonly<Record<string, number>> = { fire_protection: 4, unbreaking: 3, mending: 1 };

/** EPF against fire a level of each enchantment gives (26.3 data/minecraft/enchantment/*.json, damage_protection). */
export const FIRE_EPF: Readonly<Record<string, number>> = { protection: 1, fire_protection: 2 };
/** The cap of EPF (26.3 CombatRules: 20, 80% less damage): what the fortress and the tunnel want against fire. */
export const FIRE_EPF_NEEDED = 20;

const ARMOUR = new Set<string>(['helmet', 'chestplate', 'leggings', 'boots']);
const isArmour = (name: string) => ARMOUR.has(gearKind(name) ?? '');
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const MINUTE = 60_000;
/** A worn armour slot (36 boots .. 39 helmet). */
const worn = (i: Pick<InventoryItem, 'slot'>) => i.slot >= 36 && i.slot <= 39;
const pocket = (i: Pick<InventoryItem, 'slot'>) => i.slot >= 0 && i.slot < 36;
const levelOf = (i: Pick<InventoryItem, 'enchantments'> | undefined, name: string) => i?.enchantments?.find(e => e.name === name)?.level ?? 0;

/** A piece's EPF against fire (pure): protection a level, fire protection two (FIRE_EPF). 0 for no armour. */
export function fireEpf(i: Pick<InventoryItem, 'name' | 'enchantments'> | undefined): number {
  if (!i || !isArmour(i.name)) return 0;
  return Object.entries(FIRE_EPF).reduce((n, [name, per]) => n + per * levelOf(i, name), 0);
}

/** A piece the swap counts as the Nether's, to wear down there and put away at home: a golden helmet, plain or not. */
export const isNetherPiece = (i: Pick<InventoryItem, 'name' | 'enchantments'>): boolean => i.name === NETHER_HELMET;

/** The Nether helmet made: the golden helmet with fire protection on it (the table's work done). */
export const netherHelmetPiece = (i: Pick<InventoryItem, 'name' | 'enchantments'>): boolean => i.name === NETHER_HELMET && fireProtected(i);

/** Best first among golden helmets: more EPF against fire, then the kit's order (levels, durability). */
const helmetOrder = (a: InventoryItem, b: InventoryItem) => fireEpf(b) - fireEpf(a) || better(a, b);

// ------------------------------------------------------------------------------------------------ the gate

/** A piece as the gate reads it. */
type Worn = Pick<InventoryItem, 'name' | 'enchantments' | 'damage' | 'maxDamage'>;
/** The main set's kinds under the helmet, and their worn slots. */
const MAIN_KINDS: readonly [ArmourKind, number][] = [['chestplate', 38], ['leggings', 37], ['boots', 36]];

/** fireGear's verdict: the EPF against fire, whether it is enough with every main piece sound, and what is short, in words. */
export interface FireGear { epf: number; ok: boolean; missing: string[] }

/**
 * The fire gear rule of the fortress and the tunnel, pure: the EPF against fire of the four pieces worn (slots 36 to
 * 39 of `items`; `helmet` in place of the one worn, for the look before the swap) at least FIRE_EPF_NEEDED, and each
 * main piece (chestplate, leggings, boots) worn, of diamond or better, and not worn out (kit.ts isWorn). `missing`
 * says what is short: a main piece, or the EPF with the pieces that fall short of their part (the helmet's fire
 * protection 4, a main piece's protection 4).
 */
export function fireGear(items: readonly (Worn & Pick<InventoryItem, 'slot'>)[], helmet?: Worn): FireGear {
  const at = (slot: number) => items.find(i => i.slot === slot);
  const head = helmet ?? at(39);
  const missing: string[] = [];
  const short: string[] = [];
  let epf = fireEpf(head);
  if (!head) short.push(`no ${NETHER_HELMET} worn`);
  else if (head.name !== NETHER_HELMET) short.push(`no ${NETHER_HELMET} (the ${head.name} worn)`);
  else if (levelOf(head, 'fire_protection') < 4) short.push(`the ${head.name} has fire_protection ${levelOf(head, 'fire_protection')} (4 wanted)`);
  for (const [kind, slot] of MAIN_KINDS) {
    const p = at(slot);
    if (!p) { missing.push(`no ${kind} worn`); continue; }
    epf += fireEpf(p);
    if (tier(p.name) < tier(`diamond_${kind}`)) missing.push(`the ${p.name} worn is below diamond`);
    else if (isWorn({ count: 1, ...p, slot })) missing.push(`the ${p.name} worn is worn out`);
    if (fireEpf(p) < 4) short.push(`the ${p.name} has protection ${levelOf(p, 'protection')} (4 wanted)`);
  }
  if (epf < FIRE_EPF_NEEDED) missing.unshift(`fire EPF ${epf} < ${FIRE_EPF_NEEDED}${short.length ? ` (${short.join('; ')})` : ''}`);
  return { epf, ok: !missing.length, missing };
}

/**
 * The golden helmet the swap would put on (pure): the best of those carried, worn and in the chests (never the spare
 * set's slots), by EPF against fire; undefined when there is none.
 */
export function netherHelmetFor(items: InventoryItem[], world: WorldMemory): InventoryItem | undefined {
  const own = items.filter(i => i.name === NETHER_HELMET && (pocket(i) || worn(i)));
  const stored = storedStacks(world, st => st.name === NETHER_HELMET).filter(notSpare(world)).map(f => f.stack);
  return [...own, ...stored].sort(helmetOrder)[0];
}

/**
 * The fire gear as it will be once dressed for the Nether (pure: fireGear with the golden helmet the swap would put on,
 * netherHelmetFor, in place of the helmet worn; the worn one where there is no golden helmet at all): what the
 * fortress and the tunnel ask before they set out.
 */
export const dressedFireGear = (items: InventoryItem[], world: WorldMemory): FireGear => fireGear(items, netherHelmetFor(items, world));

/** brain-status, `Nether gear:`: the EPF against fire once dressed for the Nether, and what is short of the fortress's and the tunnel's 20. */
export function netherGearLine(items: InventoryItem[], world: WorldMemory): string {
  const g = dressedFireGear(items, world);
  const h = netherHelmetFor(items, world);
  const helmet = h ? `${h.name}${h.enchantments?.length ? ` (${h.enchantments.map(e => `${e.name} ${e.level}`).join(', ')})` : ' (plain)'}` : `no ${NETHER_HELMET}`;
  return `Nether gear: fire EPF ${g.epf} of ${FIRE_EPF_NEEDED} dressed for it (${helmet} over the main set); ` +
    `${g.ok ? 'the fortress and the tunnel may go' : `short: ${g.missing.join('; ')}`}.`;
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

/** The spare set's pieces as slots of their chests: never taken or moved by anything here. */
const spareKeys = (world: WorldMemory) => new Set(spareHeld(world).map(p => `${key(p.chest)}|${p.slot}|${p.name}`));
const notSpare = (world: WorldMemory) => {
  const kept = spareKeys(world);
  return (f: { chest: Pos; stack: ChestStack }) => !kept.has(`${key(f.chest)}|${f.stack.slot}|${f.stack.name}`);
};

/** The Nether helmets made (netherHelmetPiece) in the home chests, as their stacks were last seen (with the chest each is in), the best first. */
export function storedNetherHelmets(world: WorldMemory): { chest: Pos; stack: ChestStack }[] {
  return storedStacks(world, netherHelmetPiece).filter(notSpare(world)).sort((a, b) => helmetOrder(a.stack, b.stack));
}

/** No Nether helmet made yet, carried, worn or in the chests (storedNetherHelmets): the table's to make. Pure. */
export function netherHelmetMissing(items: InventoryItem[], world: WorldMemory): boolean {
  return !items.some(netherHelmetPiece) && !storedNetherHelmets(world).length;
}

/** The Nether helmet is wanted at all: the nether trips switched on, and the portal milestone done (it is for the trips). */
export const netherSetDue = (world: WorldMemory): boolean => world.nether?.trips === true && !!world.progress?.done?.includes('nether-portal');

// ------------------------------------------------------------------------------------------------ the swap

/** The main helmet put away for a trip: its name and enchantments, the chest and the chest's own slot it went into. */
export interface SwapPiece { name: string; chest: Pos; slot: number; enchantments?: ItemEnchantment[] }
/** world.gearSwap: dressed for the Nether (since `at`, ms), and where the main set's pieces that came off went (the helmet). */
export interface GearSwap { wearing: 'nether'; stored: SwapPiece[]; at: number }

/**
 * The pockets as the kit counts them (chores.ts kit, kitSteps, the stock's kit gathering; worktasks.ts trip kit):
 * while the swap's record says it is dressed for the Nether, the main pieces it put in the chests (the diamond helmet)
 * count as carried (slot -1, never a pocket's). Else the kit saw the golden helmet alone after the swap, wanted a
 * diamond helmet ("upgrade") at 70 and stopped the Nether trip by home, the swap back (74) put the main helmet on
 * again, and the next trip swapped and was stopped the same way. The swap back is homeSetGoal's, not the kit's. Pure.
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
 * short): the best Nether helmet out of the chests by its slot where none is carried (a golden helmet with fire
 * protection over a plain one the kit took), the gear check told to dress for the Nether (armor.wearset: the golden
 * helmet on in place of the diamond one, piece for piece), then the main helmet that came off into the gear chests by
 * its pocket slot, remembered where it went (world.gearSwap) for the swap back, and a plain golden helmet left over
 * with it. The chestplate, leggings and boots stay on: the main set's protection 4 is the Nether gear's too (fireGear).
 * A jar with no armor.wearset swaps nothing and says so: everything goes along as before. Undefined when it is dressed
 * (or could not swap at all); else what keeps the trip at home: a main helmet no chest took (a death down there would
 * lose it).
 */
export async function wearNetherHelmet(ctx: GoalContext): Promise<string | undefined> {
  if (!(await wearSet(ctx))) {
    ctx.progress('nether helmet: this jar cannot swap armour sets (no armor.wearset): the main set goes along');
    return undefined;
  }
  let items = await inventory(ctx);
  await lookOver(ctx, [NETHER_HELMET]);
  // the golden helmet the kit took may be a plain one, with the made one in a chest
  if (!items.some(i => (pocket(i) || worn(i)) && netherHelmetPiece(i))) {
    const f = storedNetherHelmets(ctx.world)[0];
    if (f) await takeSlot(ctx, f.chest, f.stack.slot, 1).catch((e: unknown) => { ctx.progress(`nether helmet: the ${f.stack.name}: ${e instanceof Error ? e.message : String(e)}`); return 0; });
  }
  const r = await wearSet(ctx, 'nether');
  if (!r) return 'the bridge did not dress for the nether (armor.wearset)';
  items = await inventory(ctx);
  const head = items.find(i => i.slot === 39);
  // the main helmet that came off (every other helmet carried), and a plain golden helmet where a made one went on
  // (the trip's 12 free slots were counted without it); nothing while no golden helmet is worn
  const off = head && isNetherPiece(head) ? items.filter(i => pocket(i) && gearKind(i.name) === 'helmet' && (!isNetherPiece(i) || netherHelmetPiece(head))) : [];
  const stored: SwapPiece[] = [];
  const kept: string[] = [];
  for (const piece of off) {
    if (ctx.signal.aborted) break;
    const at = await putAway(ctx, piece);
    // (a golden helmet is no main piece: not remembered, and one no chest took is only a slot gone)
    if (isNetherPiece(piece)) continue;
    // (a jar that says no slot: in the chest all the same, found again by what it is)
    if (at) stored.push({ name: piece.name, chest: { ...at.chest }, slot: at.slot ?? -1, ...(piece.enchantments?.length ? { enchantments: piece.enchantments.map(e => ({ ...e })) } : {}) });
    else kept.push(piece.name);
  }
  const before = ctx.world.gearSwap?.wearing === 'nether' ? ctx.world.gearSwap.stored : [];
  ctx.world.gearSwap = { wearing: 'nether', stored: [...before, ...stored], at: ctx.s.now };
  const gear = fireGear(items);
  const on = head && isNetherPiece(head) ? `${head.name}${head.enchantments?.length ? ` (${head.enchantments.map(e => `${e.name} ${e.level}`).join(', ')})` : ''}` : 'no golden helmet';
  ctx.progress(`nether helmet: wearing ${on}${stored.length ? `; the main ${stored.map(p => p.name).join(', ')} into the chests` : ''}; fire EPF ${gear.epf}`);
  if (ctx.signal.aborted) throw new Error('aborted');
  return kept.length ? `the main ${kept.join(', ')}: no home chest took it (not taken down there)` : undefined;
}

/**
 * The main piece of a kind to wear again over `on` (the piece of it worn, if any: wornOver): the one the swap put away
 * (by its record), else the best other piece in the chests (never a golden helmet, nor the spare set's).
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

/**
 * The kinds the swap back sees to: the helmet, where the golden one or nothing is worn; and (a record of the old
 * diamond Nether set's swap, made before Nov 18) a chestplate, leggings or boots the record put away, where a fire
 * protection piece or nothing is worn of it.
 */
function kindsToSwapBack(items: InventoryItem[], world: WorldMemory): ArmourKind[] {
  const recorded = new Set((world.gearSwap?.stored ?? []).map(p => gearKind(p.name)));
  return (['helmet', 'chestplate', 'leggings', 'boots'] as const).filter(kind => {
    const on = wornOf(items, kind);
    if (kind === 'helmet') return !on || isNetherPiece(on);
    return recorded.has(kind) && (!on || fireProtected(on));
  });
}

/**
 * Why the main helmet goes back on now, or null: awake at home in the overworld (the yard or near it), no work run
 * under way (the trip that just dressed for the Nether walks to the portal in its run), and the swap's record says it
 * is dressed for the Nether, or a golden helmet is worn with a main helmet carried or in the chests to wear instead. A
 * look only (A16).
 */
export function homeSetWant(s: Snapshot, world: WorldMemory): string | null {
  if (s.sleeping || s.dimension !== 'overworld' || !inYardOrNear(s, world) || afield.work || afield.trip) return null;
  const on = wornOf(s.items, 'helmet');
  const gold = on && isNetherPiece(on) ? on : undefined;
  if (world.gearSwap?.wearing !== 'nether' && !(gold && mainFor(s.items, world, 'helmet'))) return null;
  return `home: the main helmet on again${gold ? ` (the ${gold.name} worn)` : ''}`;
}

/**
 * The swap back at home (74: above the regear and the kit, which would wear the spare set's or make a new one where
 * the main helmet lies in the chests; below food): the gear check told to dress in the main set (armor.wearset), the
 * main helmet out of the chests (where the swap's record says, else the best other one there; never the spare set's)
 * where the golden one or nothing is worn (kindsToSwapBack: and an old record's other pieces), dressed so, and the
 * golden helmet that came off into the gear chests by its slot. The record is let go once every kind it can wear is
 * the main set's again. After a death down there the same for the helmet; the chestplate, leggings and boots went
 * down with it and are the regear's (the spare set). Nothing done at all: a failure (the retry time).
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
    const kinds = kindsToSwapBack(items, ctx.world);
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
    // the golden helmets carried, once a main helmet is worn in their place (with none, the golden one stays on); an
    // old record's fire protection pieces that came off go in the chests with them
    const back = kindsToSwapBack(items, ctx.world);
    const offs = items.filter(i => pocket(i) && (isNetherPiece(i) ? !back.includes('helmet') : fireProtected(i) && (ctx.world.gearSwap?.stored ?? []).some(p => gearKind(p.name) === gearKind(i.name)) && !back.includes(gearKind(i.name) as ArmourKind)));
    for (const piece of offs) {
      if (ctx.signal.aborted) break;
      if (await putAway(ctx, piece)) away.push(piece.name);
      else left.push(piece.name);
    }
    items = await inventory(ctx);
    const still = kindsToSwapBack(items, ctx.world).filter(k => mainFor(items, ctx.world, k));
    if (!still.length) delete ctx.world.gearSwap;
    const wore = [...new Set([...(first?.wore ?? []), ...(r?.wore ?? [])])];
    if (!took.length && !wore.length && !away.length) {
      if (!still.length) return 'the main set is on (nothing to swap back)';
      throw new Error(`could not put the main set on again: ${still.join(', ')} not the main set's yet`);
    }
    const line = `home set: ${wore.length ? `wore ${wore.join(', ')} again` : `took ${took.join(', ') || 'nothing'} out`}` +
      `${away.length ? `; the ${away.join(', ')} into the chests` : ''}${left.length ? `; ${left.join(', ')} kept carried: no chest took it` : ''}` +
      `${still.length ? `; ${still.join(', ')} not on yet` : ''}`;
    ctx.progress(line);
    return line.replace(/^home set: /, '');
  }
};
