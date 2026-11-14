import { brainRun, type ChestStack, type InventoryItem, type ItemEnchantment } from '../tools.js';
import { fromGate, no, onHomeLevel, outsideBy, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { carriedKit, gearKind, tier, type GearKind } from './kit.js';
import { freeChestTotals, key, peekChest, sameStack, storedStacks, takeFromChests, takeSlot } from './chests.js';
// (enchant.ts takes bookOfUse from here: each uses the other's exports inside functions only)
import { plainLeft, wornSlot } from './enchant.js';
import { workshopAnvil } from './workshop.js';
import { prepare } from './project.js';
import { ownItems } from './community.js';
import { ROOM } from './pockets.js';

/**
 * The anvil in the workshop (P1 of the progression plan): enchanted books onto the gear, and repairs of enchanted
 * gear with diamonds instead of wearing it out. The bridge's calls (client-mod Anvil.java: anvil.open, put, status,
 * take, close) are driven here the way enchant.ts drives the table's.
 */

/** A stack in one of the anvil's slots, with what tells it from others of its name (the mod's Handlers.withDetail). */
export interface AnvilStack {
  name: string; count: number; damage?: number; maxDamage?: number; enchanted?: boolean;
  /** an enchanted book's are the ones it stores */
  enchantments?: ItemEnchantment[];
  repairCost?: number;
}

/** What anvil.status answers, and anvil.open and anvil.put with it. */
export interface AnvilStatus {
  open: boolean;
  input?: AnvilStack | null;
  additional?: AnvilStack | null;
  result?: AnvilStack | null;
  /** the levels the result costs, as the server works it out (0: no result) */
  cost?: number;
  /** cost 40 and up: the anvil refuses ("Too Expensive!") and shows no result */
  tooExpensive?: boolean;
  xpLevel?: number;
  /** a result there, the level for it, and a free pocket slot to take it into */
  canTake?: boolean;
}

/** What anvil.take answers. */
export interface AnvilTake {
  ok: boolean;
  /** why not, when the server did not hand the result over */
  reason?: string;
  item: string; count?: number;
  /** the pocket slot (0-35) the result went to */
  slot?: number;
  /** the result's, [] for none */
  enchantments: ItemEnchantment[];
  damage?: number; maxDamage?: number; repairCost?: number;
  cost: number;
  /** what the take used of the additional slot: 1 book, or the diamonds the repair took (the rest are handed back) */
  used?: number;
  levelBefore: number; levelAfter: number;
  /** the anvil's block after the take: anvil, chipped_anvil, damaged_anvil, or air (worn out: gone) */
  anvil: string | null;
}

/** The most an anvil job may cost: from 40 the game refuses it ("Too Expensive!"). */
export const ANVIL_MAX_COST = 39;

/**
 * How long a worn piece taken off for the anvil stays off whatever the Guardian's gear check would wear: the opening,
 * two puts and the take, a few seconds. anvil.close ends the hold and wears it again; this is only the backstop for
 * a close that never reaches the client (as enchant.ts's UNEQUIP_HOLD_MS).
 */
export const ANVIL_HOLD_MS = 30_000;

export type WornSlot = 'head' | 'chest' | 'legs' | 'feet';

/** One job at the anvil: a piece, and a book or the repair material to go with it. */
export interface AnvilJob {
  /** the anvil, within reach (the caller walks there first) */
  at: Pos;
  /**
   * the piece: by name, from pocket `slot` (0-35) of several by the name; `worn`: it is worn, and comes off at the
   * anvil first (armor.unequip), into the slot the reply names
   */
  input: { name: string; slot?: number; worn?: WornSlot };
  /** the enchanted book, or the diamonds of a repair: `count` of them (default 1; each diamond used is a level more) */
  additional: { name: string; slot?: number; count?: number };
  /** the most levels it may spend; never above ANVIL_MAX_COST nor the level the bot has */
  maxCost: number;
  /** a last look at the result before it is paid for: false and it is left (a book whose enchantment didn't take) */
  wants?: (result: AnvilStack) => boolean;
}

/** Why a job was left untaken: the pair gives nothing, or what it gives costs too much or is not what it was for. */
export type AnvilRefusal = 'no result' | 'too expensive' | 'over the cap' | 'not wanted';

type Taken = { taken: true; take: AnvilTake };
type Left = { taken: false; why: AnvilRefusal; text: string; status: AnvilStatus };
/** How a job ended, and what anvil.close put on again (`wore`: a worn piece taken off for it, back on). */
export type AnvilOutcome = (Taken | Left) & { wore: string[] };

const optSlot = (slot: number | undefined) => (slot !== undefined && slot >= 0 ? { slot } : {});

/**
 * Do one anvil job, from the opening to the close: the piece in (a worn one taken off first), the book or the diamonds
 * with it, the server's result and cost read, and the result taken only when it is there, within the cap and wanted.
 * Anything else is no failure but `taken: false` with why, for the caller to remember (a pair with no result gives
 * none the next time either). The anvil is closed in a finally, outside the brain's run (brainRun.exit), as the table
 * is: once the brain gives a run up every call of it is refused, and the anvil would stay open with the piece in it
 * (the Guardian looks at gear only with no screen open). The close also ends the unequip's hold and wears the best
 * again; `wore` says what went on. A put or take that fails throws, closed all the same.
 */
export async function useAnvil(ctx: GoalContext, job: AnvilJob): Promise<AnvilOutcome> {
  let outcome: Taken | Left;
  let closed: { wore?: string[] } | undefined;
  try {
    // a worn piece comes off at the anvil, not before the walk, and before the anvil opens: its menu has no armour
    // slots, and armor.unequip shuts any open screen. It refuses with a hostile near or the bot just hurt: a failure,
    // the piece still on
    let slot = job.input.slot;
    if (job.input.worn) {
      const off = await ctx.call<{ ok: boolean; slot: number; name: string }>('armor.unequip', { slot: job.input.worn, holdMs: ANVIL_HOLD_MS });
      slot = off.slot;
      ctx.progress(`took the ${job.input.name} off for the anvil`);
    }
    await ctx.call<AnvilStatus>('anvil.open', { ...job.at });
    await ctx.call<AnvilStatus>('anvil.put', { which: 'input', name: job.input.name, ...optSlot(slot), count: 1 }).catch((e: unknown) => {
      // the hold gives way while the bot is hurt, and a fight wears its best whatever the hold says
      if (job.input.worn && e instanceof Error && e.message.includes(`no ${job.input.name} in inventory`)) {
        throw new Error(`the ${job.input.name} went back on before the anvil had it (hurt, or a fight)`);
      }
      throw e;
    });
    const st = await ctx.call<AnvilStatus>('anvil.put', {
      which: 'additional', name: job.additional.name, ...optSlot(job.additional.slot), count: Math.max(1, job.additional.count ?? 1)
    });
    // both must be in for "no result" to mean the pair gives nothing (and be remembered as such)
    if (!st.input || !st.additional) {
      throw new Error(`the anvil holds ${st.input ? 'no ' + job.additional.name : 'no ' + job.input.name} after the puts`);
    }
    const cost = st.cost ?? 0;
    const cap = Math.min(job.maxCost, ANVIL_MAX_COST, st.xpLevel ?? job.maxCost);
    if (!st.result) {
      outcome = st.tooExpensive || cost > ANVIL_MAX_COST
        ? { taken: false, why: 'too expensive', status: st, text: `too expensive: the ${job.additional.name} onto the ${job.input.name} costs ${cost} (the anvil refuses 40 and up)` }
        : { taken: false, why: 'no result', status: st, text: `the ${job.additional.name} and the ${job.input.name} don't combine (no result)` };
    } else if (cost > cap) {
      outcome = { taken: false, why: 'over the cap', status: st, text: `the ${job.additional.name} onto the ${job.input.name} costs ${cost}, over the ${cap} levels it may spend` };
    } else if (job.wants && !job.wants(st.result)) {
      const what = (st.result.enchantments ?? []).map(e => `${e.name} ${e.level}`).join(', ') || 'no enchantments';
      outcome = { taken: false, why: 'not wanted', status: st, text: `the ${st.result.name} it would make (${what}) is not what it was for` };
    } else {
      const take = await ctx.call<AnvilTake>('anvil.take', {}, 15_000);
      if (!take.ok) throw new Error(take.reason ?? `the anvil did not hand the ${job.input.name} over`);
      outcome = { taken: true, take };
    }
  } finally {
    closed = await brainRun.exit(() => ctx.call<{ wore?: string[] }>('anvil.close')).catch(() => undefined);
  }
  return { ...outcome, wore: closed?.wore ?? [] };
}

// ------------------------------------------------------------------------------------------------ what it is for

const MINUTE = 60_000;
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;

/**
 * The gear the anvil sees to, in its order: the pickaxe first (it wears out fastest, and mines the diamonds that mend
 * the rest), then the armour, the chestplate first (it covers the most), the sword last.
 */
export const ANVIL_ORDER = ['pickaxe', 'chestplate', 'leggings', 'helmet', 'boots', 'sword'] as const;
export type AnvilKind = typeof ANVIL_ORDER[number];

const ARMOUR_WANTED = { mending: 1, protection: 4, unbreaking: 3 };
/** The enchantments wanted on each kind, at the level wanted: a book goes on when it adds or raises one of them. */
export const WANTED: Readonly<Record<AnvilKind, Readonly<Record<string, number>>>> = {
  pickaxe: { mending: 1, unbreaking: 3, efficiency: 5, fortune: 3 },
  sword: { mending: 1, sharpness: 5, unbreaking: 3, looting: 3 },
  chestplate: ARMOUR_WANTED,
  leggings: ARMOUR_WANTED,
  helmet: { ...ARMOUR_WANTED, respiration: 3, aqua_affinity: 1 },
  boots: { ...ARMOUR_WANTED, feather_falling: 4, depth_strider: 3 }
};

const TOOLS: readonly GearKind[] = ['pickaxe', 'axe', 'shovel', 'hoe'];
const ARMOUR: readonly GearKind[] = ['helmet', 'chestplate', 'leggings', 'boots'];
const GEAR: readonly GearKind[] = [...TOOLS, 'sword', ...ARMOUR];
/**
 * The enchantments of 26.3 that go on the bot's gear, as its data/minecraft/enchantment/*.json have them: the anvil
 * cost (a book's is halved, at least 1, and counted for each level the enchantment ends at), the most there is, the
 * kinds it goes on (the enchantable/* item tags) and its exclusive set (tags/enchantment/exclusive_set: two of one set
 * never go on together). One that is not here goes on none of these kinds (a bow's, a trident's, a mace's).
 */
export const ENCHANTMENTS: Readonly<Record<string, { cost: number; max: number; on: readonly GearKind[]; set?: string }>> = {
  mending: { cost: 4, max: 1, on: GEAR },
  unbreaking: { cost: 2, max: 3, on: GEAR },
  vanishing_curse: { cost: 8, max: 1, on: GEAR },
  efficiency: { cost: 1, max: 5, on: TOOLS },
  fortune: { cost: 4, max: 3, on: TOOLS, set: 'mining' },
  silk_touch: { cost: 8, max: 1, on: TOOLS, set: 'mining' },
  sharpness: { cost: 1, max: 5, on: ['sword', 'axe'], set: 'damage' },
  smite: { cost: 2, max: 5, on: ['sword', 'axe'], set: 'damage' },
  bane_of_arthropods: { cost: 2, max: 5, on: ['sword', 'axe'], set: 'damage' },
  knockback: { cost: 2, max: 2, on: ['sword'] },
  fire_aspect: { cost: 4, max: 2, on: ['sword'] },
  looting: { cost: 4, max: 3, on: ['sword'] },
  sweeping_edge: { cost: 4, max: 3, on: ['sword'] },
  protection: { cost: 1, max: 4, on: ARMOUR, set: 'armor' },
  fire_protection: { cost: 2, max: 4, on: ARMOUR, set: 'armor' },
  blast_protection: { cost: 4, max: 4, on: ARMOUR, set: 'armor' },
  projectile_protection: { cost: 2, max: 4, on: ARMOUR, set: 'armor' },
  thorns: { cost: 8, max: 3, on: ARMOUR },
  binding_curse: { cost: 8, max: 1, on: ARMOUR },
  respiration: { cost: 4, max: 3, on: ['helmet'] },
  aqua_affinity: { cost: 4, max: 1, on: ['helmet'] },
  swift_sneak: { cost: 8, max: 3, on: ['leggings'] },
  feather_falling: { cost: 2, max: 4, on: ['boots'] },
  depth_strider: { cost: 4, max: 3, on: ['boots'], set: 'boots' },
  frost_walker: { cost: 4, max: 2, on: ['boots'], set: 'boots' },
  soul_speed: { cost: 8, max: 3, on: ['boots'] }
};

const levelOf = (list: ItemEnchantment[] | undefined, name: string) => list?.find(e => e.name === name)?.level ?? 0;
const clash = (a: string, b: string) => a !== b && !!ENCHANTMENTS[a]?.set && ENCHANTMENTS[a].set === ENCHANTMENTS[b]?.set;
const named = (list: ItemEnchantment[]) => list.map(e => `${e.name} ${e.level}`).join(', ');

/**
 * A book onto a piece as 26.3's AnvilMenu.createResult works it out. Each of the book's enchantments that goes on the
 * piece's kind and clashes with none on it ends one level above an equal one there, else at the higher of the two (never
 * past the most there is), and costs its anvil cost halved (at least 1) times that level; each one on the piece it
 * clashes with costs a level more, and it stays off. None that goes on: no result (undefined). The earlier work on the
 * piece and on the book (repairCost) is added: a cost of 40 and up the anvil shows, and refuses.
 */
export function bookOnto(piece: Pick<InventoryItem, 'name' | 'enchantments' | 'repairCost'>, book: Pick<InventoryItem, 'enchantments' | 'repairCost'>): { cost: number; enchantments: ItemEnchantment[] } | undefined {
  const kind = gearKind(piece.name);
  const out = (piece.enchantments ?? []).map(e => ({ ...e }));
  let points = 0, applied = false;
  for (const e of book.enchantments ?? []) {
    const def = ENCHANTMENTS[e.name];
    const have = out.find(x => x.name === e.name);
    let fits = !!def && !!kind && def.on.includes(kind);
    for (const o of out) if (clash(e.name, o.name)) { fits = false; points++; }
    if (!fits) continue;
    applied = true;
    const level = Math.min(have && have.level === e.level ? e.level + 1 : Math.max(e.level, have?.level ?? 0), def.max);
    if (have) have.level = level; else out.push({ name: e.name, level });
    points += Math.max(1, Math.floor(def.cost / 2)) * level;
  }
  return applied ? { cost: (piece.repairCost ?? 0) + (book.repairCost ?? 0) + points, enchantments: out } : undefined;
}

/** Diamonds a repair takes: each mends a quarter of the piece (AnvilMenu: maxDamage / 4, the last one what is left), 4 at most. */
export function repairUnits(piece: Pick<InventoryItem, 'damage' | 'maxDamage'>): number {
  const unit = Math.floor((piece.maxDamage ?? 0) / 4);
  const damage = piece.damage ?? 0;
  return unit > 0 && damage > 0 ? Math.min(4, Math.ceil(damage / unit)) : 0;
}

const durability = (i: Pick<InventoryItem, 'damage' | 'maxDamage'>) => (i.maxDamage ? 1 - (i.damage ?? 0) / i.maxDamage : 1);

/** Below this much of its durability an enchanted piece is mended with diamonds, before anything else is done. */
export const REPAIR_BELOW = 0.3;
/**
 * A piece worked on this much before (its repairCost: 0, 1, 3, 7, 15, 31 after each job) gets no more books: each one
 * costs more than the last, and two more would be too expensive. Mending and the repairs it still gets.
 */
export const REPAIR_COST_SKIP = 15;
/** The level the enchanting table's dearest offer wants: what the anvil leaves while a plain piece waits for the table. */
export const TABLE_LEVEL = 30;

/**
 * The most an anvil job may cost now: never past 39 (the game refuses 40 and up) nor the level there is; and while a
 * plain piece of diamond or better waits for the table (enchant.ts plainLeft), never into the 30 levels the table's
 * dearest offer wants: the table puts three or four enchantments on for 3 levels, more than any one book does.
 */
export function costCap(items: InventoryItem[], xpLevel: number): number {
  return Math.min(ANVIL_MAX_COST, xpLevel, plainLeft(items) ? xpLevel - TABLE_LEVEL : Infinity);
}

const kindOf = (name: string): AnvilKind | undefined => {
  const kind = gearKind(name);
  return (ANVIL_ORDER as readonly string[]).includes(kind ?? '') ? kind as AnvilKind : undefined;
};

/**
 * A piece the anvil works on: carried, or worn where it belongs (armor.unequip takes it off at the anvil); of diamond
 * or better; enchanted, with its enchantments known (an older jar says only `enchanted`); never one with the curse of
 * binding, which does not come off. A plain one is the table's first: once it has a book on it the table takes it no
 * more, and the table's three or four enchantments would be lost to it.
 */
function workable(i: InventoryItem): AnvilKind | undefined {
  const kind = kindOf(i.name);
  if (!kind || !(i.slot < 36 || wornSlot(i)) || tier(i.name) < tier(`diamond_${kind}`)) return undefined;
  if (!i.enchantments?.length || i.enchantments.some(e => e.name === 'binding_curse')) return undefined;
  return kind;
}

/** The piece of a kind in use (the kit's best of it, carried or worn), where the anvil may work on it. */
function inUse(items: InventoryItem[], kind: AnvilKind): InventoryItem | undefined {
  const best = carriedKit(items).best[kind];
  return best && workable(best) ? best : undefined;
}

/**
 * What a book would spoil: a curse put on, or an enchantment that shuts a wanted one out for good (blast protection
 * where protection is wanted, silk touch on a pickaxe without fortune, smite on a sword without sharpness).
 */
function spoils(kind: AnvilKind, before: ItemEnchantment[] | undefined, after: ItemEnchantment[]): boolean {
  return after.some(e => !levelOf(before, e.name) &&
    (/_curse$/.test(e.name) || Object.keys(WANTED[kind]).some(w => clash(e.name, w) && !levelOf(after, w))));
}

/** The wanted enchantments a result raises (up to the level wanted), at the level it has them. */
function raised(kind: AnvilKind, before: ItemEnchantment[] | undefined, after: ItemEnchantment[]): ItemEnchantment[] {
  return Object.entries(WANTED[kind])
    .filter(([name, want]) => Math.min(levelOf(after, name), want) > Math.min(levelOf(before, name), want))
    .map(([name]) => ({ name, level: levelOf(after, name) }));
}
const gain = (kind: AnvilKind, before: ItemEnchantment[] | undefined, after: ItemEnchantment[]) =>
  raised(kind, before, after).reduce((n, e) => n + Math.min(e.level, WANTED[kind][e.name]) - Math.min(levelOf(before, e.name), WANTED[kind][e.name]), 0);

/** Where the book or the diamonds of a job are: carried (`slot`, a pocket), in a chest (`chest`, `slot` its own), or in the chests by count alone (neither). */
export interface AnvilSource { name: string; count: number; slot?: number; chest?: Pos; enchantments?: ItemEnchantment[]; repairCost?: number }

/** The job the plan chose: what it is, the piece and what goes with it, what it should cost and may cost. */
export interface AnvilPlan {
  job: 'repair' | 'mending' | 'book';
  piece: InventoryItem;
  add: AnvilSource;
  /** the cost as the plan works it out by the game's rules (the anvil's own shown cost is what counts: useAnvil) */
  cost: number;
  /** the most it may spend (costCap) */
  cap: number;
  /** what the result must have to be taken: the wanted enchantments the book raises, at the levels it raises them to */
  for: ItemEnchantment[];
  /** the pair, as world.anvil.tried remembers it */
  key: string;
}

/** What the anvil remembers (world.anvil). */
export interface AnvilMemory {
  /**
   * pairs that gave nothing worth taking (pairKey -> why, the cost the anvil showed, when, ms): not tried again for
   * TRIED_MS, but for one over the day's cap, which is tried again once the cap comes up to its cost. Without it the
   * same book went into the anvil with the same piece every run: no result, and round again
   */
  tried?: Record<string, { why: AnvilRefusal; cost?: number; at: number }>;
  /** where the anvil stood that a take wore out (it went to air): one goes down there before anything else */
  gone?: Pos;
  /** when the books in the chests were last looked over for what they hold (ms) */
  lookedAt?: number;
}

/** How long a pair that gave nothing is left alone (the piece or the book changed is another pair at once). */
export const TRIED_MS = 7 * 24 * 60 * MINUTE;
const TRIED_MAX = 64;
/** How often the chests' books are looked over when a tool's reply has left their stacks unknown. */
export const LOOK_EVERY = 60 * MINUTE;

const enchKey = (list?: ItemEnchantment[]) => (list ?? []).map(e => `${e.name} ${e.level}`).sort().join(',');
/** A pair as tried: the piece and what went with it, each by its name and enchantments. */
export const pairKey = (piece: Pick<InventoryItem, 'name' | 'enchantments'>, add: Pick<AnvilSource, 'name' | 'enchantments'>) =>
  `${piece.name}[${enchKey(piece.enchantments)}]+${add.name}[${enchKey(add.enchantments)}]`;

const triedOf = (world: WorldMemory): NonNullable<AnvilMemory['tried']> => {
  const t = world.anvil?.tried;
  return t && typeof t === 'object' ? t : {};
};

/** A pair left alone: tried lately to no avail, or over a cap that is still under the cost it showed. */
function leftAlone(tried: NonNullable<AnvilMemory['tried']>, k: string, cap: number, now: number): boolean {
  const t = tried[k];
  if (!t || typeof t.at !== 'number' || !(now - t.at <= TRIED_MS)) return false;
  return t.why !== 'over the cap' || !(cap >= (t.cost ?? Infinity));
}

/** Pocket slots a job fills on its way: the piece off its armour slot, the book or the diamonds out of a chest. */
export const slotsFor = (j: Pick<AnvilPlan, 'piece' | 'add'>) =>
  (wornSlot(j.piece) ? 1 : 0) + (j.add.chest || j.add.slot === undefined ? 1 : 0);

export interface PlanOptions {
  /** world.anvil.tried */
  tried?: AnvilMemory['tried'];
  now?: number;
  /**
   * the chests' free diamonds, counted by name (freeChestTotals: less what a build job or a community mission holds
   * there): a repair takes them by name when no stack of them is known with enough, and a known stack only while they
   * cover it (the reserve is a count, and a take by the slot takes whatever the stack holds); no limit when not given
   */
  diamonds?: number;
  /**
   * the pockets less what a community mission is owed (ownItems), for a repair's diamonds: what is gathered for a
   * mission is the community chest's until it is handed over, and a delivery that failed leaves it carried for a
   * while; `items` by default
   */
  own?: InventoryItem[];
  /** the pocket slots a job may fill (slotsFor); no limit by default */
  free?: number;
}

/**
 * The next anvil job, pure: the pockets (`items`, worn armour too), the stacks in the chests (`stored`: books and
 * diamonds, storedStacks) and the level. In this order:
 * 1. a worn enchanted piece (below REPAIR_BELOW) mended with the diamonds it needs, the most worn of the first kind in
 *    ANVIL_ORDER first: an enchanted piece that breaks takes its enchantments with it;
 * 2. a mending book onto the next piece in use without mending, by ANVIL_ORDER;
 * 3. a book that adds or raises a WANTED enchantment on the piece in use, by ANVIL_ORDER, the one that raises most first.
 * Never a job that costs more than costCap, nor a pair tried to no avail (world.anvil.tried), nor a book that spoils a
 * piece; a piece worked on REPAIR_COST_SKIP before gets no more books (step 3). The books carried come before the
 * chests' (nothing to fetch).
 */
export function anvilPlan(items: InventoryItem[], stored: { chest: Pos; stack: ChestStack }[], xpLevel: number, opts: PlanOptions = {}): AnvilPlan | undefined {
  const cap = costCap(items, xpLevel);
  if (!(cap >= 1)) return undefined;
  const tried = opts.tried ?? {};
  const now = opts.now ?? 0;
  const job = (j: Omit<AnvilPlan, 'cap' | 'key'>): AnvilPlan | undefined => {
    const k = pairKey(j.piece, j.add);
    if (j.cost > cap || leftAlone(tried, k, cap, now) || slotsFor(j) > (opts.free ?? Infinity)) return undefined;
    return { ...j, cap, key: k };
  };
  const diamondsFor = (n: number): AnvilSource | undefined => {
    const carried = (opts.own ?? items).filter(i => i.slot < 36 && i.name === 'diamond' && i.count >= n).sort((a, b) => b.count - a.count)[0];
    if (carried) return { name: 'diamond', count: n, slot: carried.slot };
    const inChest = (opts.diamonds === undefined || opts.diamonds >= n) && stored.find(f => f.stack.name === 'diamond' && f.stack.count >= n);
    if (inChest) return { name: 'diamond', count: n, chest: inChest.chest, slot: inChest.stack.slot };
    return (opts.diamonds ?? 0) >= n ? { name: 'diamond', count: n } : undefined;
  };
  // 1. mended with diamonds: diamond pieces only (netherite takes netherite ingots: P6)
  for (const kind of ANVIL_ORDER) {
    const worn = items.filter(i => workable(i) === kind && i.name.startsWith('diamond_') && durability(i) < REPAIR_BELOW)
      .sort((a, b) => durability(a) - durability(b));
    for (const piece of worn) {
      const n = repairUnits(piece);
      const add = n ? diamondsFor(n) : undefined;
      const j = add && job({ job: 'repair', piece, add, cost: (piece.repairCost ?? 0) + n, for: [] });
      if (j) return j;
    }
  }
  const books: AnvilSource[] = [
    ...items.filter(i => i.slot < 36 && i.name === 'enchanted_book' && i.enchantments?.length)
      .map(i => ({ name: i.name, count: 1, slot: i.slot, enchantments: i.enchantments, repairCost: i.repairCost })),
    ...stored.filter(f => f.stack.name === 'enchanted_book' && f.stack.enchantments?.length)
      .map(f => ({ name: f.stack.name, count: 1, chest: f.chest, slot: f.stack.slot, enchantments: f.stack.enchantments, repairCost: f.stack.repairCost }))
  ];
  // 2. mending, whatever the piece's earlier work: from then on it mends itself
  for (const kind of ANVIL_ORDER) {
    const piece = inUse(items, kind);
    if (!piece || levelOf(piece.enchantments, 'mending')) continue;
    for (const add of books.filter(b => levelOf(b.enchantments, 'mending'))) {
      const r = bookOnto(piece, add);
      if (!r || !levelOf(r.enchantments, 'mending') || spoils(kind, piece.enchantments, r.enchantments)) continue;
      const j = job({ job: 'mending', piece, add, cost: r.cost, for: [{ name: 'mending', level: 1 }] });
      if (j) return j;
    }
  }
  // 3. the books that raise what is wanted
  for (const kind of ANVIL_ORDER) {
    const piece = inUse(items, kind);
    if (!piece || (piece.repairCost ?? 0) >= REPAIR_COST_SKIP) continue;
    const options = books.flatMap(add => {
      const r = bookOnto(piece, add);
      return r && !spoils(kind, piece.enchantments, r.enchantments) ? [{ add, r, gain: gain(kind, piece.enchantments, r.enchantments) }] : [];
    }).filter(o => o.gain > 0).sort((a, b) => b.gain - a.gain || a.r.cost - b.r.cost);
    for (const o of options) {
      const j = job({ job: 'book', piece, add: o.add, cost: o.r.cost, for: raised(kind, piece.enchantments, o.r.enchantments) });
      if (j) return j;
    }
  }
  return undefined;
}

/**
 * Whether the anvil has a use for a book: it would put mending on a piece in use without it, or raise a wanted
 * enchantment on one (and spoil nothing), whatever the levels now. What the enchant chore keeps BOOK_STOCK of: counted
 * by name, six books it had no use for (bane of arthropods, fire protection 2) would have stopped the books for good.
 */
export function bookOfUse(items: InventoryItem[], book: Pick<InventoryItem, 'enchantments' | 'repairCost'>): boolean {
  return ANVIL_ORDER.some(kind => {
    const piece = inUse(items, kind);
    const r = piece && bookOnto(piece, book);
    if (!piece || !r || spoils(kind, piece.enchantments, r.enchantments)) return false;
    if (levelOf(r.enchantments, 'mending') && !levelOf(piece.enchantments, 'mending')) return true;
    return (piece.repairCost ?? 0) < REPAIR_COST_SKIP && gain(kind, piece.enchantments, r.enchantments) > 0;
  });
}

/** The job in words, for the want: `protection 4 onto the diamond_chestplate (worn)`. */
export function describe(p: AnvilPlan): string {
  const worn = wornSlot(p.piece) ? ' (worn)' : '';
  if (p.job === 'repair') return `repair the ${p.piece.name}${worn} (${Math.floor(durability(p.piece) * 100)}% left) with ${p.add.count} diamonds`;
  return `${named(p.for)} onto the ${p.piece.name}${worn}`;
}

/** The plan for the pockets and the chests as they are now; `free`: the slots it may fill, leaving the stash its yard room (ROOM.yard). */
export function planFor(s: Snapshot, world: WorldMemory, free = 36 - s.slotsUsed - ROOM.yard): AnvilPlan | undefined {
  const stored = storedStacks(world, st => st.name === 'enchanted_book' || st.name === 'diamond');
  return anvilPlan(s.items, stored, s.xpLevel ?? 0, { tried: triedOf(world), now: s.now, diamonds: freeChestTotals(world).diamond ?? 0, own: ownItems(s.items, world), free });
}

/**
 * Chests that hold enchanted books memory counts but cannot tell apart: a tool's reply (the stash's store, the sort's
 * moves) says how many went, not which, and their stacks were let go (chests.ts remember).
 */
export function unseenBooks(world: WorldMemory): Pos[] {
  return world.landmarks.chests.filter(c => {
    const total = world.chestItems?.[key(c)]?.enchanted_book ?? 0;
    const known = (world.chestStacks?.[key(c)] ?? []).filter(st => st.name === 'enchanted_book').reduce((a, st) => a + st.count, 0);
    return total > known;
  });
}

/** Unseen books to look over: none looked over in the last LOOK_EVERY, and a piece in use the levels could see to. */
function lookDue(s: Snapshot, world: WorldMemory): boolean {
  const last = world.anvil?.lookedAt;
  return !!unseenBooks(world).length && !(s.now - (typeof last === 'number' ? last : 0) < LOOK_EVERY) &&
    costCap(s.items, s.xpLevel ?? 0) >= 1 && ANVIL_ORDER.some(k => inUse(s.items, k));
}

/** An anvil to put down: one carried or stored, or 31 iron for one (ingots, blocks of nine, raw iron where a furnace smelts it). */
function anvilMaterial(s: Snapshot, world: WorldMemory): boolean {
  const stored = freeChestTotals(world);
  const have = (n: string) => (s.counts.get(n) ?? 0) + (stored[n] ?? 0);
  return have('anvil') > 0 || have('iron_ingot') + 9 * have('iron_block') + (world.landmarks.furnace ? have('raw_iron') : 0) >= 31;
}

/** The anvil to work at: the one a take wore out first (to put back), else the workshop's, once the workshop is done. */
function anvilAt(world: WorldMemory): { at: Pos; gone: boolean } | undefined {
  const gone = world.anvil?.gone;
  if (gone && [gone.x, gone.y, gone.z].every(Number.isFinite)) return { at: { x: gone.x, y: gone.y, z: gone.z }, gone: true };
  if (!world.progress?.done?.includes('workshop')) return undefined;
  const at = workshopAnvil(world);
  return at && { at, gone: false };
}

/** In the yard (inside the fence line) on home's level: from where the anvil is a walk on foot. */
const inYard = (s: Snapshot, world: WorldMemory) =>
  !!world.yard && !!s.home && s.dimension === 'overworld' && outsideBy(world.yard, s.position) === 0 && onHomeLevel(s.position, s.home);
const notInYard = (s: Snapshot): Gate => ({
  cause: 'away',
  text: !s.home ? 'no home set' : s.dimension !== 'overworld' ? `in ${s.dimension}`
    : `${Math.round(s.distHome)} blocks from home, not in the yard on home's level (the anvil works from the yard)`
});
/** Daylight a job wants left (ticks): a minute's walk and the anvil. */
const DAY_LEFT = 1200;

/**
 * Run now? The "no" in this order: nothing to do (no workshop or anvil, no job the pockets and the level allow, no
 * books to look over), then what keeps a job from going (not in the yard, no room in the pockets), the hour last. A
 * look only (A16): it reads the plan and writes nothing.
 */
const gate = (s: Snapshot, world: WorldMemory): Gate => {
  const where = anvilAt(world);
  if (!where) return { cause: 'unneeded', text: world.progress?.done?.includes('workshop') ? 'no anvil in the yard' : 'no workshop yet' };
  if (where.gone) {
    if (!anvilMaterial(s, world)) return { cause: 'kit', text: `no anvil to put back at ${fmt(where.at)}, nor 31 iron for one` };
    if (!inYard(s, world)) return notInYard(s);
    // the anvil and what it is made of: three blocks of iron, the ingots
    if (36 - s.slotsUsed - ROOM.yard < 3) return no.pockets(s, 'anvil', 36 - ROOM.yard - 2);
    return no.late(s, 'anvil', DAY_LEFT) ?? { want: `put the anvil back at ${fmt(where.at)} (the last one wore out)` };
  }
  const level = s.xpLevel ?? 0;
  const any = planFor(s, world, Infinity);
  const look = !any && lookDue(s, world);
  if (!any && !look) return { cause: 'unneeded', text: `nothing for the anvil (level ${level}, may spend ${Math.max(0, costCap(s.items, level))})` };
  if (!inYard(s, world)) return notInYard(s);
  const plan = any && planFor(s, world);
  if (any && !plan) return no.pockets(s, 'anvil', 36 - ROOM.yard - slotsFor(any) + 1);
  return no.late(s, 'anvil', DAY_LEFT) ?? { want: plan ? `level ${level}: ${describe(plan)}` : `look over the enchanted books in ${unseenBooks(world).length} chest(s)` };
};

const ANVIL_BLOCK = /^(chipped_|damaged_)?anvil$/;
const AIR = /^(air|cave_air|void_air)$/;
const blockAt = async (ctx: GoalContext, p: Pos) =>
  ((await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...p, width: 1, height: 1, length: 1 })).blocks[0] ?? '')
    .replace(/^minecraft:/, '').replace(/\[.*$/, '');

/** Forget the pairs tried longest ago: past TRIED_MS, and beyond the TRIED_MAX newest. */
function forget(mem: AnvilMemory, now: number): void {
  if (!mem.tried || typeof mem.tried !== 'object') { delete mem.tried; return; }
  const fresh = Object.entries(mem.tried).filter(([, t]) => t && typeof t.at === 'number' && now - t.at <= TRIED_MS)
    .sort((a, b) => b[1].at - a[1].at).slice(0, TRIED_MAX);
  mem.tried = Object.fromEntries(fresh);
}

/**
 * The book or the diamonds into the pockets where they are in a chest: the book by its slot there (takeSlot: the one
 * with protection 4, not the first enchanted_book), the diamonds by their slot or by count. Returns the pocket slot to
 * put them in from: the book the same as the one taken, the diamonds the stack with enough.
 */
async function fetchAdd(ctx: GoalContext, add: AnvilSource): Promise<number> {
  if (add.slot !== undefined && !add.chest) return add.slot;
  const what = add.name === 'enchanted_book' ? `the book with ${named(add.enchantments ?? [])}` : `${add.count} ${add.name}`;
  const got = add.chest && add.slot !== undefined ? await takeSlot(ctx, add.chest, add.slot, add.count) : await takeFromChests(ctx, add.name, add.count);
  if (got < add.count) throw new Error(`${what} ${add.chest ? `was not in the chest at ${fmt(add.chest)} any more` : 'did not come out of the chests'}`);
  const mine = (await ctx.call<{ items: InventoryItem[] }>('inventory')).items.filter(i => i.slot < 36 && i.name === add.name);
  const like: ChestStack = { slot: -1, name: add.name, count: 1, enchantments: add.enchantments };
  const pick = add.name === 'enchanted_book' ? mine.find(i => sameStack(i, like)) : [...mine].sort((a, b) => b.count - a.count).find(i => i.count >= add.count);
  if (!pick) throw new Error(`${what} is not in the pockets after the take`);
  return pick.slot;
}

/**
 * Put an anvil down where the last one wore out: one carried, from the chests or made (three blocks of nine iron and
 * four ingots: prepare takes the ingots from the chests and smelts the raw iron), the walk there on foot only (A11).
 * Something else standing there now is left alone, and the place forgotten.
 */
async function putBack(ctx: GoalContext, at: Pos): Promise<string> {
  const mem = (ctx.world.anvil ??= {});
  const there = await blockAt(ctx, at);
  if (ANVIL_BLOCK.test(there)) { delete mem.gone; return `an anvil stands at ${fmt(at)} again`; }
  if (!there) throw new Error(`the anvil's place at ${fmt(at)} is out of sight`);
  if (!AIR.test(there)) { delete mem.gone; return `left the anvil's place at ${fmt(at)} alone: ${there} stands there now`; }
  const short = await prepare(ctx, 'anvil', 1);
  if (Object.keys(short).length) throw new Error(`no anvil to put back at ${fmt(at)}: short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...at, range: 3, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
  if (walk?.arrived === false) throw new Error(`no way on foot to the anvil's place at ${fmt(at)}`);
  const r = await ctx.act('place-block', { ...at, item: 'anvil', faceDirection: 'down' });
  if (!ANVIL_BLOCK.test(await blockAt(ctx, at))) throw new Error(`could not put the anvil back at ${fmt(at)}: ${r.text.split('\n')[0].slice(0, 120)}`);
  delete mem.gone;
  return `put a new anvil down at ${fmt(at)}`;
}

/** What a result must have to be taken: a repair mends, a book's raised enchantments are on it at their levels. */
const wantsFor = (p: AnvilPlan) => (r: AnvilStack) => (p.job === 'repair'
  ? (r.damage ?? 0) < (p.piece.damage ?? 0)
  : p.for.every(f => levelOf(r.enchantments, f.name) >= f.level));

/**
 * By day, from the yard, at the workshop's anvil: the next job of anvilPlan (a worn enchanted piece mended with
 * diamonds, mending, a book that raises a wanted enchantment). The book or the diamonds come out of the chests by their
 * slot, the walk to the anvil is on foot, a worn piece comes off at the anvil and goes back on at its close (useAnvil,
 * which closes the anvil in a finally outside the run, as the enchant chore closes the table). A pair that gives
 * nothing worth taking is remembered and not tried again (world.anvil.tried); an anvil the take wore out is put back
 * before anything else. Levels: never above min(level, 39), and none of the 30 the table wants while a plain piece
 * waits for it (costCap). Tried after the table in the same breath (the brain's list puts enchant first at 31).
 */
export const anvilGoal: Goal = {
  name: 'anvil',
  priority: 31,
  // putting a worn-out anvil back can smelt a furnace load for its iron first (prepare: four minutes and more)
  timeoutMs: 8 * MINUTE,
  retryMs: 20 * MINUTE,
  gate,
  ...fromGate(gate),
  // a job a minute long that can always wait: it takes over at the hand-over, never stops what runs
  cuts: () => false,
  run: async ctx => {
    const mem = (ctx.world.anvil ??= {});
    forget(mem, ctx.s.now);
    const where = anvilAt(ctx.world);
    if (!where) return 'no anvil to work at';
    if (where.gone) return putBack(ctx, where.at);
    let plan = planFor(ctx.s, ctx.world);
    if (!plan) {
      if (!lookDue(ctx.s, ctx.world)) return 'nothing for the anvil';
      const unseen = unseenBooks(ctx.world);
      mem.lookedAt = ctx.s.now;
      for (const c of unseen) {
        if (ctx.signal.aborted) break;
        await peekChest(ctx, c).catch((e: unknown) => ctx.progress(`chest at ${fmt(c)}: ${e instanceof Error ? e.message : String(e)}`));
      }
      plan = planFor(ctx.s, ctx.world);
      if (!plan) return `looked over the books in ${unseen.length} chest(s): nothing for the anvil`;
      ctx.progress(`looked over the books in ${unseen.length} chest(s): ${describe(plan)}`);
    }
    const slot = await fetchAdd(ctx, plan.add);
    const at = where.at;
    // on foot only (A11): Baritone neither breaks nor places in the yard, and the workshop's way in is its door
    const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...at, range: 2, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
    if (walk?.arrived === false) throw new Error(`no way on foot to the anvil at ${fmt(at)}`);
    const block = await blockAt(ctx, at);
    if (!ANVIL_BLOCK.test(block)) {
      if (!AIR.test(block)) throw new Error(`no anvil at ${fmt(at)} (${block || 'nothing'})`);
      mem.gone = { ...at };
      return `the anvil at ${fmt(at)} is gone: one goes down there next`;
    }
    const worn = wornSlot(plan.piece);
    const out = await useAnvil(ctx, {
      at, input: { name: plan.piece.name, ...(worn ? { worn } : { slot: plan.piece.slot }) },
      additional: { name: plan.add.name, slot, count: plan.add.count }, maxCost: plan.cap, wants: wantsFor(plan)
    });
    const back = !worn ? '' : `; ${out.wore.includes(plan.piece.name) ? 'worn again' : 'not worn again: anvil.close put nothing on'}`;
    if (!out.taken) {
      // remembered, so the next run takes the next job and never this pair again (the book or the diamonds stay
      // carried: the plan counts the pockets' books first, and the stash puts them away in time)
      (mem.tried ??= {})[plan.key] = { why: out.why, at: ctx.s.now, ...(out.status.cost ? { cost: out.status.cost } : {}) };
      forget(mem, ctx.s.now);
      return `left the ${plan.piece.name} as it was: ${out.text}${back}`;
    }
    const t = out.take;
    const used = t.used ?? plan.add.count;
    const gained = t.enchantments.filter(e => e.level > levelOf(plan.piece.enchantments, e.name));
    const text = plan.job === 'repair'
      ? `repaired the ${plan.piece.name} with ${used} diamond${used === 1 ? '' : 's'} (cost ${t.cost})`
      : `${named(gained.length ? gained : plan.for)} onto the ${plan.piece.name} (cost ${t.cost}, level ${t.levelBefore} -> ${t.levelAfter})`;
    ctx.progress(text);
    let wear = '';
    if (t.anvil && AIR.test(t.anvil)) {
      mem.gone = { ...at };
      wear = '; the anvil wore out: one goes down there next';
    } else if (t.anvil && t.anvil !== 'anvil' && ANVIL_BLOCK.test(t.anvil)) wear = `; the anvil is ${t.anvil.replace(/_anvil$/, '')} now`;
    return `${text}${wear}${back}`;
  }
};
