import { brainRun, type InventoryItem, type ItemEnchantment } from '../tools.js';
import { nearHome, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Milestone, MilestoneState } from './progress.js';
import type { Pos, WorldMemory } from './memory.js';
import { buildStep, siteStep } from './milestones.js';
import { enchantRoom, type Side } from './blueprints.js';
import { chestTotals, freeChestTotals, kindChests, sameStack, storeStack, storedStacks, takeFromChests } from './chests.js';
import { prepare } from './project.js';
import { billKinds } from './chores.js';
// (anvil.ts takes plainLeft and wornSlot from here: each uses the other's exports inside functions only)
import { bookOfUse } from './anvil.js';
import { gearKind, tier } from './kit.js';
import { obsidianStep } from './cast.js';
import { ROOM } from './pockets.js';

/**
 * Enchanting: obsidian (mined with a diamond pickaxe), then a 7 x 7 room with the table in the middle and 15 shelves
 * (books from cane paper and cow leather: the stash, the cane round and the pens bring them in over the days), and a
 * chore that enchants the best unenchanted gear at level 30 with lapis.
 */

const MINUTE = 60_000;

// the obsidian step moved to cast.ts (obsidianStep, shared with the portal's); its pieces are still found here
export { OBSIDIAN_TRIP_SLOTS, obsidianTargets } from './cast.js';

/** The door of a 7 x 7 room (the enchanting room, the workshop) on the side of its site toward home. */
export function doorToward(st: MilestoneState, home: { x: number; z: number }): Side {
  const site = st.data.site as { x: number; z: number };
  const cx = site.x + 3.5, cz = site.z + 3.5;
  return Math.abs(home.x - cx) > Math.abs(home.z - cz) ? (home.x < cx ? 'west' : 'east') : (home.z < cz ? 'north' : 'south');
}

export function enchantingMilestone(prereqs: string[]): Milestone {
  const build = buildStep('enchanting', st => enchantRoom({ doorSide: st.data.door as Side }), 'enchanting room');
  return {
    id: 'enchanting',
    title: 'an enchanting room',
    prereqs,
    done: v => !!v.world.zones?.enchanting?.length,
    steps: [
      // (the trip out for it and the casting at home: cast.ts obsidianStep)
      obsidianStep('enchanting', 4),
      siteStep('enchanting room', 7, 7),
      { ...build, run: async (ctx, st) => { st.data.door ??= doorToward(st, ctx.s.home!); return build.run(ctx, st); } }
    ]
  };
}

/**
 * Gear worth enchanting, in the order the chore does it, one piece a run: the sword and the pickaxe (done first live,
 * Nov 14), then the armour, the chestplate first (it covers the most). Of diamond or better, not enchanted yet.
 */
export const ENCHANT_ORDER = ['sword', 'pickaxe', 'chestplate', 'leggings', 'helmet', 'boots'] as const;

/** A worn piece: its inventory index (36 boots .. 39 helmet) and armor.unequip's name for its slot. */
const WORN: Record<string, { index: number; slot: 'head' | 'chest' | 'legs' | 'feet' }> = {
  boots: { index: 36, slot: 'feet' }, leggings: { index: 37, slot: 'legs' }, chestplate: { index: 38, slot: 'chest' }, helmet: { index: 39, slot: 'head' }
};

/** The armour slot to take a worn piece off from, for armor.unequip; undefined for a carried one (0-35). */
export function wornSlot(i: Pick<InventoryItem, 'slot' | 'name'>): 'head' | 'chest' | 'legs' | 'feet' | undefined {
  const w = WORN[gearKind(i.name) ?? ''];
  return w && i.slot === w.index ? w.slot : undefined;
}

/**
 * The next piece to enchant: by ENCHANT_ORDER, of a kind the first plain one of diamond or better, carried or worn.
 * Of one kind the best tier first, and a carried one before the one worn (nothing to take off: the Guardian wears the
 * enchanted one over the plain). A worn piece only with a free pocket slot to take it off into (`free`: armor.unequip
 * refuses without one). Worn armour was left out until P0: the bot sat in plain diamond armour at level 59.
 */
export function enchantPick(items: InventoryItem[], free: number): InventoryItem | undefined {
  const plain = (i: InventoryItem) => !i.enchanted && !i.enchantments?.length;
  for (const kind of ENCHANT_ORDER) {
    const ofKind = items
      .filter(i => gearKind(i.name) === kind && plain(i) && tier(i.name) >= tier(`diamond_${kind}`))
      .filter(i => i.slot < 36 || (wornSlot(i) !== undefined && free > 0))
      .sort((a, b) => tier(b.name) - tier(a.name) || Number(a.slot >= 36) - Number(b.slot >= 36));
    if (ofKind[0]) return ofKind[0];
  }
  return undefined;
}

/**
 * Free pocket slots for a piece taken off, after the room the stash leaves a yard round (ROOM.yard: with fewer free it
 * stops whatever runs, to put things away); below 0 nothing is started. The lapis from the chests takes one first
 * when too little is carried. At 34 kept slots the lapis fetched made 35: the stash stopped the run on its walk to
 * the table and put the lapis back, and enchant wanted again, round and round.
 */
const freeFor = (s: Snapshot) => 36 - s.slotsUsed - ((s.counts.get('lapis_lazuli') ?? 0) < 3 ? 1 : 0) - ROOM.yard;

/** The next piece, where the pockets leave room for it (freeFor). */
const pickFor = (s: Snapshot) => {
  const free = freeFor(s);
  return free < 0 ? undefined : enchantPick(s.items, free);
};

/**
 * How long a piece taken off stays off whatever the Guardian's gear check would wear (Guardian.gearHoldUntil): it is
 * taken off at the table, so this covers the opening and the put, a few seconds. enchant.close ends it and wears the
 * piece again, also for a run the brain gave up (sent outside it, below): this is only the backstop for a close that
 * never reaches the client.
 */
const UNEQUIP_HOLD_MS = 30_000;

/**
 * Every so often by day at level 30 with lapis: enchant the next unenchanted piece at the table, worn armour too; with
 * every piece done, a book for the anvil now and then (bookFor: at 33, while fewer than 6 of use are stored).
 */
export const enchantGoal: Goal = {
  name: 'enchant',
  priority: 31,
  timeoutMs: 4 * MINUTE,
  retryMs: 30 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || s.sleeping || (s.xpLevel ?? 0) < 30 || !world.zones?.['enchanting:table']?.length || !nearHome(s, 24)) return null;
    const lapis = (s.counts.get('lapis_lazuli') ?? 0) + (chestTotals(world).lapis_lazuli ?? 0);
    if (lapis < 3) return null;
    const piece = pickFor(s);
    if (piece) return `level ${s.xpLevel}: enchant the ${piece.name}${wornSlot(piece) ? ' (worn)' : ''}`;
    const book = bookFor(s, world);
    return book ? `level ${s.xpLevel}: enchant a book (${book.ofUse} of use in store, keeps ${BOOK_STOCK})` : null;
  },
  // a plain piece cuts in as it always has (a handful of times, ever); a book waits for the hand-over, as the anvil
  // does: once every piece is done it wants whenever the level is past 33 near home, and at 31 it would have stopped
  // the project, the cane, the farm and the yard rounds midway for one to five books in a row
  cuts: s => !!pickFor(s),
  run: async ctx => {
    const table = ctx.world.zones!['enchanting:table'][0];
    const piece = pickFor(ctx.s);
    // every piece done: a book for the anvil (anvil.ts), if one is wanted
    if (!piece) return enchantBook(ctx, table);
    if ((ctx.s.counts.get('lapis_lazuli') ?? 0) < 3) await takeFromChests(ctx, 'lapis_lazuli', 16);
    await ctx.act('move-to-position', { ...table, range: 2, timeoutMs: 60_000 });
    const worn = wornSlot(piece);
    let done: string;
    let closed: { wore?: string[] } | undefined;
    try {
      // a worn piece comes off at the table, not before the walk (no armour off on the way), and before the table
      // opens: its menu has no armour slots, and armor.unequip shuts any open screen. The hold keeps the Guardian
      // (every 2 s) from wearing it again before the table has it; enchant.close (below) ends the hold and wears the
      // best there is again, the enchanted piece, whatever the Guardian's state (auto-defend off skips its gear check).
      // armor.unequip refuses with a hostile near or the bot just hurt: a failure, the piece still on
      let slot = piece.slot;
      if (worn) {
        const off = await ctx.call<{ ok: boolean; slot: number; name: string }>('armor.unequip', { slot: worn, holdMs: UNEQUIP_HOLD_MS });
        slot = off.slot;
        ctx.progress(`took the ${piece.name} off for the table`);
      }
      await ctx.call('enchant.open', { ...table });
      // one put: the piece (from its own slot: with two pickaxes, the first by name may be the enchanted one) and the
      // lapis with it. A second put of 'lapis_lazuli' took the piece back out and set one lapis in the item slot: 27
      // tries in a day, "no offer for the diamond_sword" every time, and it ping-ponged with signs and sort
      const st = await ctx.call<{ offers: { slot: number; cost: number; enchant: string | null }[]; enchantable?: boolean; put?: string }>(
        'enchant.put', { name: piece.name, slot, lapis: 3 }).catch((e: unknown) => {
        // the hold gives way while the bot is hurt, and a fight wears its best whatever the hold says: the piece can be
        // back on before the table has it. Said so, not as a piece lost from the pockets
        if (worn && e instanceof Error && e.message.includes(`no ${piece.name} in inventory`)) {
          throw new Error(`the ${piece.name} went back on before the table had it (hurt, or a fight)`);
        }
        throw e;
      });
      const offer = [...st.offers].filter(o => o.cost > 0 && o.cost <= (ctx.s.xpLevel ?? 0)).sort((a, b) => b.cost - a.cost)[0];
      // a failure, not a done: it holds for retryMs instead of coming back every few seconds
      if (!offer) throw new Error(`no offer for the ${st.put ?? piece.name}${st.enchantable === false ? ' (not enchantable)' : ''}`);
      const r = await ctx.call<{ ok: boolean; enchantments?: { name: string; level: number }[]; reason?: string }>('enchant.choose', { slot: offer.slot }, 15_000);
      if (!r.ok) throw new Error(r.reason ?? 'not enchanted');
      done = `enchanted the ${piece.name}: ${(r.enchantments ?? []).map(e => `${e.name} ${e.level}`).join(', ')}`;
    } finally {
      // outside the run: once the brain gives a run up (something more urgent, the LLM, the timeout) every call of it
      // is refused, and the table stayed open with the piece in it (the Guardian looks at gear only with no screen
      // open). The close ends the hold and wears the piece again
      closed = await brainRun.exit(() => ctx.call<{ wore?: string[] }>('enchant.close')).catch(() => undefined);
    }
    // a worn piece: whether it is on again (the Guardian's own "put on" notes reach the LLM, not brain.log)
    if (!worn) return done;
    return `${done}; ${closed?.wore?.includes(piece.name) ? 'worn again' : 'not worn again: enchant.close put nothing on'}`;
  }
};

// ------------------------------------------------------------------------------------------------ books for the anvil

/** Enchanted books the anvil has a use for (anvil.ts bookOfUse), kept in store: below this the chore makes another. */
export const BOOK_STOCK = 6;
/**
 * Enchanted books in store at most, of use or not: a book from the table is a draw (bane of arthropods, a bow's
 * power), each takes a chest slot of its own, and those of no use would pile up for ever.
 */
export const BOOK_PILE = 24;
/** The level from which a book is made: the table's dearest offer wants 30 and takes 3 of them. */
export const BOOK_LEVEL = 33;
/** Sugar cane left in the chests for the cane round's replanting: the books take the rest. */
export const CANE_KEEP = 16;
/** A book and what it is made from: none of them is taken while a bill has a use for one (chores.ts billKinds). */
const BOOK_KINDS = ['book', 'paper', 'sugar_cane', 'leather'];

const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const named = (list: ItemEnchantment[]) => list.map(e => `${e.name} ${e.level}`).join(', ');

/**
 * A plain piece of diamond or better left for the table, carried or worn (also one no pocket slot is free to take off
 * into: enchantPick passes it over for now, it is still the table's): its levels come first, for the anvil and for
 * books alike.
 */
export function plainLeft(items: InventoryItem[]): boolean {
  return items.some(i => {
    const kind = gearKind(i.name);
    return !!kind && (ENCHANT_ORDER as readonly string[]).includes(kind) && !i.enchanted && !i.enchantments?.length &&
      tier(i.name) >= tier(`diamond_${kind}`) && (i.slot < 36 || wornSlot(i) !== undefined);
  });
}

/**
 * The enchanted books there are, carried and stored (`all`), and those the anvil has a use for (`ofUse`): a book in a
 * chest whose stack memory has let go of (a tool's reply: chests.ts remember) counts as of use until the anvil looks.
 */
export function booksStored(s: Snapshot, world: WorldMemory): { all: number; ofUse: number } {
  const carried = s.items.filter(i => i.slot < 36 && i.name === 'enchanted_book');
  const known = storedStacks(world, st => st.name === 'enchanted_book').map(f => f.stack);
  const inChests = chestTotals(world).enchanted_book ?? 0;
  const count = (list: InventoryItem[]) => list.reduce((n, i) => n + i.count, 0);
  const unknown = Math.max(0, inChests - count(known));
  return { all: inChests + count(carried), ofUse: count([...carried, ...known].filter(b => bookOfUse(s.items, b))) + unknown };
}

/**
 * Whether the chore makes a book now, and where its plain book comes from. Only once no plain piece is left (plainLeft:
 * the table's levels are theirs first), at BOOK_LEVEL or more, with fewer than BOOK_STOCK books of use and BOOK_PILE in
 * all. Nothing is gathered for it: a book carried or stored, else paper from the cane and leather from the cows as the
 * cane round and the pens bring them in (CANE_KEEP of the cane stays), and none of it while a bill has a use for any
 * of them (the project's, a build job's, the community's). And with the pockets' room for a piece (freeFor), less what
 * the book takes on its way: a slot from the chests, two while it is made (the cane and the leather, the paper and the
 * leather).
 */
export function bookFor(s: Snapshot, world: WorldMemory): { from: 'carried' | 'stored' | 'made'; ofUse: number } | undefined {
  if ((s.xpLevel ?? 0) < BOOK_LEVEL || plainLeft(s.items)) return undefined;
  const { all, ofUse } = booksStored(s, world);
  if (ofUse >= BOOK_STOCK || all >= BOOK_PILE) return undefined;
  const billed = billKinds(s, world);
  if (BOOK_KINDS.some(k => billed.has(k))) return undefined;
  const stored = freeChestTotals(world);
  const have = (n: string) => (s.counts.get(n) ?? 0) + (stored[n] ?? 0);
  const from = (s.counts.get('book') ?? 0) > 0 ? 'carried' : (stored.book ?? 0) > 0 ? 'stored'
    : have('leather') >= 1 && (have('paper') >= 3 || have('sugar_cane') - CANE_KEEP >= 3) ? 'made' : undefined;
  if (!from || freeFor(s) - (from === 'carried' ? 0 : from === 'stored' ? 1 : 2) < 0) return undefined;
  return { from, ofUse };
}

/**
 * The home chests in the order a book goes into them: those the stash keeps its kind in first (storage.ts: with the
 * gear), the fullest of a kind as last seen after the emptier. storeStack tries three: in list order, the one misc chest
 * and the two after it were full, and the first four books stayed carried ("no chest took it", live Nov 14).
 */
export function bookChests(world: WorldMemory): Pos[] {
  return kindChests(world, 'enchanted_book');
}

/**
 * Enchant a book at the table for the anvil (bookFor says whether): the plain book from the pockets, the chests, or
 * made (prepare: paper crafted from the cane, the leather from the chests; it gathers nothing), the walk to the table on
 * foot only (A11), the dearest offer, the table closed in a finally outside the run, as for a piece. The book goes into
 * the chests by its slot, with the chest's stacks remembered: the anvil takes it out again by what it holds.
 */
async function enchantBook(ctx: GoalContext, table: Pos): Promise<string> {
  if (!bookFor(ctx.s, ctx.world)) return 'nothing to enchant';
  if ((ctx.s.counts.get('lapis_lazuli') ?? 0) < 3) await takeFromChests(ctx, 'lapis_lazuli', 16);
  const short = await prepare(ctx, 'book', 1);
  if (Object.keys(short).length) throw new Error(`no book to enchant: short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...table, range: 2, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
  if (walk?.arrived === false) throw new Error(`no way on foot to the enchanting table at ${fmt(table)}`);
  let made: ItemEnchantment[] = [];
  try {
    await ctx.call('enchant.open', { ...table });
    const st = await ctx.call<{ offers: { slot: number; cost: number }[]; enchantable?: boolean }>('enchant.put', { name: 'book', lapis: 3 });
    const offer = [...st.offers].filter(o => o.cost > 0 && o.cost <= (ctx.s.xpLevel ?? 0)).sort((a, b) => b.cost - a.cost)[0];
    if (!offer) throw new Error(`no offer for the book${st.enchantable === false ? ' (not enchantable)' : ''}`);
    const r = await ctx.call<{ ok: boolean; enchantments?: ItemEnchantment[]; reason?: string }>('enchant.choose', { slot: offer.slot }, 15_000);
    if (!r.ok) throw new Error(r.reason ?? 'not enchanted');
    made = r.enchantments ?? [];
  } finally {
    await brainRun.exit(() => ctx.call('enchant.close')).catch(() => undefined);
  }
  const done = `enchanted a book: ${named(made)}`;
  ctx.progress(done);
  const like = { slot: -1, name: 'enchanted_book', count: 1, enchantments: made };
  const book = (await ctx.call<{ items: InventoryItem[] }>('inventory')).items.find(i => i.slot < 36 && sameStack(i, like));
  const chest = book && await storeStack(ctx, 'enchanted_book', book.slot, bookChests(ctx.world));
  return `${done}; ${chest ? `into the chest at ${fmt(chest)}` : 'kept carried: no chest took it'}`;
}
