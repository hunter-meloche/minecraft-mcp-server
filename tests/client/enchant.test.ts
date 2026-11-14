import test from 'ava';
import {
  BOOK_LEVEL, BOOK_PILE, BOOK_STOCK, CANE_KEEP, ENCHANT_ORDER, bookChests as bookChestOrder, bookFor, booksStored, enchantGoal, enchantPick, plainLeft, wornSlot
} from '../../src/client/brain/enchant.js';
import { stash } from '../../src/client/brain/chores.js';
import type { Goal, GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import { decide } from '../../src/client/brain/brain.js';
import { projectGoal } from '../../src/client/brain/project.js';
import { TREE } from '../../src/client/brain/tree.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import { key, remember } from '../../src/client/brain/chests.js';
import { brainRun, type ChestStack, type InventoryItem, type ItemEnchantment } from '../../src/client/tools.js';

const TABLE = { x: -547, y: 63, z: 2209 };
const snap = (items: InventoryItem[]): Snapshot => {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return {
    now: 10 * 60 * 60_000, timeOfDay: 4000, activity: 'work', health: 20, food: 20, position: { x: -547, y: 63, z: 2207 }, dimension: 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items, counts, slotsUsed: items.length, xpLevel: 59,
    home: { x: -549, y: 63, z: 2183, dimension: 'overworld' }, distHome: 24
  } as Snapshot;
};

/**
 * The table as the mod's enchant.put works it: the item slot is cleared first, then one of the named item goes in from
 * the pockets, 0-35 (from `slot` if it holds that item, else the first by name: Interact.pick), lapis topped up. An
 * enchanted piece or lapis gets no offers. armor.unequip as the mod's: the worn piece is shift-clicked to the first
 * free slot of the main pocket, 9-35, then the hotbar (26.3 InventoryMenu.quickMoveStack), which it answers with, and
 * its slot is held; `regear`: the hold gives way at once (the bot hurt), and the piece is back on before the put.
 * enchant.close as the mod's: the held slots wear the best of their kind in the pockets again, named in `wore`.
 */
function table(items: InventoryItem[], opts: { regear?: boolean } = {}) {
  const calls: string[] = [];
  const held = new Set<number>();
  let inSlot: InventoryItem | undefined;
  const offers = () => (inSlot && /_(sword|pickaxe|helmet|chestplate|leggings|boots)$/.test(inSlot.name) && !inSlot.enchanted
    ? [{ slot: 0, cost: 8, enchant: 'unbreaking' }, { slot: 1, cost: 19, enchant: 'sharpness' }, { slot: 2, cost: 30, enchant: 'sharpness' }]
    : [0, 1, 2].map(slot => ({ slot, cost: 0, enchant: null })));
  const ctx = {
    s: snap(items), world: { landmarks: { chests: [] }, leash: 96, zones: { 'enchanting:table': [TABLE] } } as unknown as WorldMemory,
    signal: new AbortController().signal,
    act: async () => ({ ok: true, text: 'ok' }),
    call: (async (m: string, a: Record<string, unknown> = {}) => {
      calls.push(`${m} ${JSON.stringify(a)}`);
      if (m === 'enchant.put') {
        const named = items.filter(i => i.name === a.name && i.slot < 36);
        if (!named.length) throw new Error(`no ${String(a.name)} in inventory`);
        inSlot = named.find(i => i.slot === a.slot) ?? named[0];
        return { put: inSlot?.name, enchantable: offers()[0].cost > 0, offers: offers() };
      }
      if (m === 'enchant.status') return { offers: offers() };
      if (m === 'armor.unequip') {
        const index = { feet: 36, legs: 37, chest: 38, head: 39 }[a.slot as string]!;
        const worn = items.find(i => i.slot === index);
        if (!worn) throw new Error(`nothing worn on the ${String(a.slot)}`);
        const free = [...[...Array(27).keys()].map(k => k + 9), ...Array(9).keys()].find(k => !items.some(i => i.slot === k));
        if (free === undefined) throw new Error(`no free slot to take the ${worn.name} off into`);
        worn.slot = opts.regear ? index : free;
        held.add(index);
        return { ok: true, slot: free, name: worn.name, count: 1, holdMs: a.holdMs };
      }
      if (m === 'enchant.choose') {
        const armour = /_(helmet|chestplate|leggings|boots)$/.test(inSlot?.name ?? '');
        const enchantments = [armour ? { name: 'protection', level: 4 } : { name: 'sharpness', level: 5 }];
        if (inSlot) Object.assign(inSlot, { enchanted: true, enchantments });
        return { ok: true, enchantments };
      }
      if (m === 'enchant.close') {
        const wore: string[] = [];
        const kinds: Record<number, string> = { 36: 'boots', 37: 'leggings', 38: 'chestplate', 39: 'helmet' };
        for (const index of held) {
          if (items.some(i => i.slot === index)) continue;
          const piece = items.filter(i => i.slot < 36 && i.name.endsWith(`_${kinds[index]}`))
            .sort((x, y) => Number(!!y.enchantments?.length) - Number(!!x.enchantments?.length))[0];
          if (piece) { piece.slot = index; wore.push(piece.name); }
        }
        held.clear();
        return { ok: true, wasOpen: true, wore };
      }
      return {};
    }) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined, gain: () => undefined
  } as unknown as GoalContext;
  return { ctx, calls };
}

test('enchant: one put of the piece with its lapis, then the dearest offer (a second lapis put took the sword back out)', async (t) => {
  // live 2026-11-14: 27 tries, "no offer for the diamond_sword (are the shelves in place?)" every time
  const items: InventoryItem[] = [{ slot: 3, name: 'diamond_sword', count: 1 }, { slot: 13, name: 'lapis_lazuli', count: 7 }];
  const { ctx, calls } = table(items);
  t.regex(enchantGoal.wants(ctx.s, ctx.world) ?? '', /enchant the diamond_sword/);
  t.is(await enchantGoal.run(ctx), 'enchanted the diamond_sword: sharpness 5');
  t.deepEqual(calls.filter(c => c.startsWith('enchant.put')), ['enchant.put {"name":"diamond_sword","slot":3,"lapis":3}']);
  t.true(calls.includes('enchant.choose {"slot":2}'));
});

test('enchant: of two pickaxes it puts the unenchanted one, by its slot', async (t) => {
  const items: InventoryItem[] = [
    { slot: 5, name: 'diamond_pickaxe', count: 1, enchanted: true }, { slot: 34, name: 'diamond_pickaxe', count: 1 },
    { slot: 13, name: 'lapis_lazuli', count: 7 }
  ];
  const { ctx } = table(items);
  t.is(await enchantGoal.run(ctx), 'enchanted the diamond_pickaxe: sharpness 5');
});

test('enchant: no offer is a failure (held for retryMs), not a done that comes back every few seconds', async (t) => {
  const items: InventoryItem[] = [{ slot: 3, name: 'diamond_sword', count: 1, enchanted: true }, { slot: 4, name: 'diamond_pickaxe', count: 1 }];
  // the snapshot says the pickaxe is plain, but the table finds nothing to offer (it gets the enchanted sword's name)
  const { ctx } = table(items.map(i => (i.name === 'diamond_pickaxe' ? { ...i, enchanted: true } : i)));
  ctx.s = snap([...items, { slot: 13, name: 'lapis_lazuli', count: 7 }]);
  await t.throwsAsync(enchantGoal.run(ctx), { message: /no offer for the diamond_pickaxe/ });
});

/** The live kit on Nov 14: the sword and pickaxe enchanted by then, the diamond armour worn and plain. */
const live = (): InventoryItem[] => [
  { slot: 0, name: 'diamond_sword', count: 1, enchanted: true, enchantments: [{ name: 'unbreaking', level: 3 }] },
  { slot: 1, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: [{ name: 'fortune', level: 3 }, { name: 'unbreaking', level: 3 }] },
  { slot: 13, name: 'lapis_lazuli', count: 7 },
  { slot: 36, name: 'diamond_boots', count: 1, damage: 12, maxDamage: 429 },
  { slot: 37, name: 'diamond_leggings', count: 1, damage: 30, maxDamage: 495 },
  { slot: 38, name: 'diamond_chestplate', count: 1, damage: 41, maxDamage: 528 },
  { slot: 39, name: 'diamond_helmet', count: 1, damage: 9, maxDamage: 363 }
];

test('enchant: a worn chestplate comes off at the table first, held off for the Guardian, then one put of it from the slot it went to', async (t) => {
  // live 2026-11-14: level 59 in plain diamond armour; the chore took carried pieces only, so it had nothing left
  const items = live();
  const { ctx, calls } = table(items);
  t.is(enchantGoal.wants(ctx.s, ctx.world), 'level 59: enchant the diamond_chestplate (worn)');
  t.is(await enchantGoal.run(ctx), 'enchanted the diamond_chestplate: protection 4; worn again');
  t.deepEqual(calls, [
    'armor.unequip {"slot":"chest","holdMs":30000}',
    `enchant.open ${JSON.stringify(TABLE)}`,
    'enchant.put {"name":"diamond_chestplate","slot":9,"lapis":3}', // the first free of the main pocket, as the mod's shift-click
    'enchant.choose {"slot":2}',
    'enchant.close {}' // ends the hold and wears the enchanted piece again
  ]);
  t.like(items.find(i => i.name === 'diamond_chestplate'), { slot: 38, enchantments: [{ name: 'protection', level: 4 }] });
});

test('enchant: a run stopped after the piece came off still closes the table (its hold ends, the piece goes back on)', async (t) => {
  // the runtime refuses every call of a run the brain gave up (tools.ts); the close in the finally was refused too, and
  // the table could stay open with the chestplate in it
  const items = live();
  const { ctx, calls } = table(items);
  const abort = new AbortController();
  const inner = ctx.call;
  ctx.call = (async (m: string, a?: Record<string, unknown>, ms?: number) => {
    if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
    const r = await inner(m, a, ms);
    if (m === 'armor.unequip') abort.abort(); // something more urgent, right after the piece came off
    return r;
  }) as GoalContext['call'];
  await t.throwsAsync(brainRun.run({ signal: abort.signal }, () => enchantGoal.run(ctx)), { message: /aborted/ });
  t.deepEqual(calls, ['armor.unequip {"slot":"chest","holdMs":30000}', 'enchant.close {}']);
  t.is(items.find(i => i.name === 'diamond_chestplate')?.slot, 38);
});

test('enchant: a piece back on before the put (the hold gave way: hurt) is a failure that says so, and the table is closed', async (t) => {
  const items = live();
  const { ctx, calls } = table(items, { regear: true });
  await t.throwsAsync(enchantGoal.run(ctx), { message: 'the diamond_chestplate went back on before the table had it (hurt, or a fight)' });
  t.is(calls.at(-1), 'enchant.close {}');
  t.false(calls.some(c => c.startsWith('enchant.choose')));
});

test('enchant: a put after the piece came off that gets no offer still closes the table (the hold ends with it)', async (t) => {
  const items = live();
  const { ctx, calls } = table(items.map(i => (i.slot === 38 ? { ...i, enchanted: true } : i)));
  ctx.s = snap(items); // the snapshot says plain; the table finds it enchanted
  await t.throwsAsync(enchantGoal.run(ctx), { message: /no offer for the diamond_chestplate/ });
  t.is(calls[0], 'armor.unequip {"slot":"chest","holdMs":30000}');
  t.is(calls.at(-1), 'enchant.close {}');
});

test('enchant: the order is sword, pickaxe, chestplate, leggings, helmet, boots, one piece a run; diamond or better only', (t) => {
  t.deepEqual([...ENCHANT_ORDER], ['sword', 'pickaxe', 'chestplate', 'leggings', 'helmet', 'boots']);
  const items: InventoryItem[] = [
    ...live().map(i => ({ ...i, enchanted: false, enchantments: undefined })),
    { slot: 5, name: 'iron_axe', count: 1 }, { slot: 6, name: 'iron_sword', count: 1 }
  ];
  const done: string[] = [];
  for (let piece = enchantPick(items, 20); piece; piece = enchantPick(items, 20)) {
    done.push(`${piece.name}${wornSlot(piece) ? ' (worn)' : ''}`);
    piece.enchantments = [{ name: 'unbreaking', level: 3 }];
  }
  t.deepEqual(done, ['diamond_sword', 'diamond_pickaxe', 'diamond_chestplate (worn)', 'diamond_leggings (worn)', 'diamond_helmet (worn)', 'diamond_boots (worn)']);
});

test('enchant: of one kind netherite before diamond, a carried piece before the worn one; a worn one only with a pocket slot free', (t) => {
  const worn: InventoryItem = { slot: 38, name: 'diamond_chestplate', count: 1 };
  t.is(enchantPick([worn, { slot: 4, name: 'diamond_chestplate', count: 1 }], 10)?.slot, 4);
  t.is(enchantPick([worn, { slot: 4, name: 'netherite_chestplate', count: 1 }], 10)?.name, 'netherite_chestplate');
  t.is(enchantPick([{ slot: 38, name: 'netherite_chestplate', count: 1 }, { slot: 4, name: 'diamond_chestplate', count: 1 }], 10)?.slot, 38);
  // no free slot to take it off into: not the worn piece (armor.unequip would refuse), still a carried one
  t.is(enchantPick([worn], 0), undefined);
  t.is(enchantPick([worn, { slot: 7, name: 'diamond_boots', count: 1 }], 0)?.slot, 7);
  // a piece in another armour slot (an older jar's index, the off-hand) is not taken off
  t.is(enchantPick([{ slot: 40, name: 'diamond_chestplate', count: 1 }], 10), undefined);
  // the pockets' last slots: the lapis from the chests takes one first, the worn piece one, and the stash's room for a
  // yard round (2) is left over, or the stash would stop the run to put things away
  const { ctx } = table([worn]);
  const stored = { ...ctx.world, landmarks: { chests: [{ x: 0, y: 64, z: 0 }], farmland: [] }, chestItems: { '0,64,0': { lapis_lazuli: 40 } } };
  const lapis: InventoryItem = { slot: 13, name: 'lapis_lazuli', count: 5 };
  t.is(enchantGoal.wants({ ...snap([worn]), slotsUsed: 35 }, stored), null);
  t.is(enchantGoal.wants({ ...snap([worn]), slotsUsed: 34 }, stored), null);
  t.is(enchantGoal.wants({ ...snap([worn]), slotsUsed: 33 }, stored), null);
  t.is(enchantGoal.wants({ ...snap([worn]), slotsUsed: 32 }, stored), 'level 59: enchant the diamond_chestplate (worn)');
  t.is(enchantGoal.wants({ ...snap([worn, lapis]), slotsUsed: 35 }, stored), null);
  t.is(enchantGoal.wants({ ...snap([worn, lapis]), slotsUsed: 34 }, stored), null);
  t.is(enchantGoal.wants({ ...snap([worn, lapis]), slotsUsed: 33 }, stored), 'level 59: enchant the diamond_chestplate (worn)');
  // a carried piece takes no slot more: two free after the lapis
  const carried: InventoryItem = { slot: 4, name: 'diamond_chestplate', count: 1 };
  t.is(enchantGoal.wants({ ...snap([carried]), slotsUsed: 34 }, stored), null);
  t.is(enchantGoal.wants({ ...snap([carried]), slotsUsed: 33 }, stored), 'level 59: enchant the diamond_chestplate');
  t.is(enchantGoal.wants({ ...snap([carried, lapis]), slotsUsed: 34 }, stored), 'level 59: enchant the diamond_chestplate');
});

test('enchant: never starts a run the stash would cut short at its fullest (the lapis fetched, the piece taken off)', (t) => {
  // live probe: at 34 kept slots it wanted the worn chestplate; the 16 lapis it fetched made 35, the stash stopped it
  // on its walk to the table and put the lapis back, and enchant wanted again, round and round
  const world = {
    landmarks: { chests: [{ x: 0, y: 64, z: 0 }], farmland: [] }, leash: 96, zones: { 'enchanting:table': [TABLE] },
    chestItems: { '0,64,0': { lapis_lazuli: 400 } }
  } as unknown as WorldMemory;
  for (const pieceSlot of [4, 38]) {
    for (const carriedLapis of [0, 5]) {
      for (let used = 20; used <= 36; used++) {
        const items: InventoryItem[] = [{ slot: pieceSlot, name: 'diamond_chestplate', count: 1 }];
        if (carriedLapis) items.push({ slot: 13, name: 'lapis_lazuli', count: carriedLapis });
        const s = { ...snap(items), slotsUsed: used };
        if (!enchantGoal.wants(s, world)) continue;
        const peak = used + (carriedLapis < 3 ? 1 : 0) + (pieceSlot >= 36 ? 1 : 0);
        t.false(stash.cuts!({ ...s, slotsUsed: peak }, world), `slots ${used}, lapis ${carriedLapis}, piece in ${pieceSlot}: at ${peak} the stash cuts in`);
      }
    }
  }
});

test('enchant: never below level 30, nor with fewer than 3 lapis carried and stored', (t) => {
  const { ctx } = table(live());
  t.is(enchantGoal.wants({ ...ctx.s, xpLevel: 29 }, ctx.world), null);
  const noLapis = live().filter(i => i.name !== 'lapis_lazuli');
  t.is(enchantGoal.wants(snap(noLapis), ctx.world), null);
  t.regex(enchantGoal.wants(snap(noLapis), { ...ctx.world, landmarks: { chests: [{ x: 0, y: 64, z: 0 }], farmland: [] }, chestItems: { '0,64,0': { lapis_lazuli: 40 } } }) ?? '', /diamond_chestplate/);
});

// ------------------------------------------------------------------------------------------------ books for the anvil

const en = (s: string): ItemEnchantment[] => s.split(', ').map(x => { const [name, l] = x.split(' '); return { name, level: Number(l) }; });
/** The kit on Nov 14 once the table had done every piece (brain.log 07:00-07:34Z): where the books start. */
const allDone = (): InventoryItem[] => [
  { slot: 0, name: 'diamond_sword', count: 1, enchanted: true, enchantments: en('unbreaking 3') },
  { slot: 1, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: en('fortune 3, unbreaking 3') },
  { slot: 13, name: 'lapis_lazuli', count: 7 },
  { slot: 36, name: 'diamond_boots', count: 1, enchanted: true, enchantments: en('protection 4, depth_strider 3, unbreaking 3') },
  { slot: 37, name: 'diamond_leggings', count: 1, enchanted: true, enchantments: en('protection 3, unbreaking 3') },
  { slot: 38, name: 'diamond_chestplate', count: 1, enchanted: true, enchantments: en('protection 3, unbreaking 3, thorns 2') },
  { slot: 39, name: 'diamond_helmet', count: 1, enchanted: true, enchantments: en('protection 4, unbreaking 3') }
];
/** The storage house's seeds, misc and drops chests (their signs: seeds1, misc1, drops1). */
const SEEDS: Pos = { x: -547, y: 63, z: 2182 };
const MISC: Pos = { x: -551, y: 65, z: 2179 };
const DROPS: Pos = { x: -547, y: 65, z: 2179 };
const book = (slot: number, s: string): ChestStack => ({ slot, name: 'enchanted_book', count: 1, enchantments: en(s) });
const stacksOf = (o: Record<string, number>, from = 0) => Object.entries(o).map(([name, count], i): ChestStack => ({ slot: from + i, name, count }));
const totalsOf = (stacks: ChestStack[]) => {
  const out: Record<string, number> = {};
  for (const st of stacks) out[st.name] = (out[st.name] ?? 0) + st.count;
  return out;
};
/** What the three chests hold (each by its stacks, as the jar's replies remember them): cane 40, leather 10 by default. */
function bookChests(over: { seeds?: ChestStack[]; misc?: ChestStack[]; drops?: ChestStack[] } = {}) {
  return {
    [key(SEEDS)]: over.seeds ?? stacksOf({ wheat: 64, sugar_cane: 40 }),
    [key(MISC)]: over.misc ?? stacksOf({ oak_sign: 4 }),
    [key(DROPS)]: over.drops ?? stacksOf({ leather: 10, string: 14 })
  };
}
function booksWorld(chests: Record<string, ChestStack[]> = bookChests(), over: Partial<WorldMemory> = {}): WorldMemory {
  const world = {
    landmarks: { chests: [SEEDS, MISC, DROPS], farmland: [] }, leash: 96, zones: { 'enchanting:table': [TABLE] },
    chestAssign: { [key(SEEDS)]: 'farming', [key(MISC)]: 'misc', [key(DROPS)]: 'mobdrops' }, ...over
  } as WorldMemory;
  for (const c of world.landmarks.chests) remember(world, c, totalsOf(chests[key(c)] ?? []), (chests[key(c)] ?? []).map(st => ({ ...st })));
  return world;
}
const at45 = (items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot => ({ ...snap(items), xpLevel: 45, slotsUsed: 10, ...over });

test('enchant: a book only once no plain piece is left, at level 33 or more', (t) => {
  const world = booksWorld();
  t.is(enchantGoal.wants(at45(allDone()), world), `level 45: enchant a book (0 of use in store, keeps ${BOOK_STOCK})`);
  // a plain piece left, carried or worn, also one with no slot free to take it off (the table passes it over for now)
  const plainWorn = allDone().map(i => (i.slot === 39 ? { slot: 39, name: 'diamond_helmet', count: 1 } : i));
  t.true(plainLeft(plainWorn));
  t.is(bookFor(at45(plainWorn), world), undefined);
  t.is(enchantGoal.wants(at45(plainWorn, { slotsUsed: 34 }), world), null);
  t.is(enchantGoal.wants(at45(plainWorn), world), 'level 45: enchant the diamond_helmet (worn)');
  t.true(plainLeft([...allDone(), { slot: 6, name: 'netherite_sword', count: 1 }]));
  // a plain iron piece, or one in the off-hand, is no piece for the table
  t.false(plainLeft([...allDone(), { slot: 5, name: 'iron_helmet', count: 1 }, { slot: 40, name: 'diamond_boots', count: 1 }]));
  t.is(BOOK_LEVEL, 33);
  t.is(bookFor(at45(allDone(), { xpLevel: 32 }), world), undefined);
  t.like(bookFor(at45(allDone(), { xpLevel: 33 }), world), { from: 'made' });
});

test('enchant: books are kept to 6 the anvil has a use for, and 24 in all; one whose stack memory lost counts as of use', (t) => {
  const useful = ['protection 4', 'mending 1', 'efficiency 5', 'sharpness 5', 'feather_falling 4', 'respiration 3'].map((e, i) => book(i, e));
  t.like(booksStored(at45(allDone()), booksWorld(bookChests({ misc: useful }))), { all: 6, ofUse: 6 });
  t.is(bookFor(at45(allDone()), booksWorld(bookChests({ misc: useful }))), undefined);
  t.truthy(bookFor(at45(allDone()), booksWorld(bookChests({ misc: useful.slice(1) }))));
  // six the anvil cannot use (a bow's, one that clashes with sharpness, levels the gear has): they do not stop the books
  const useless = ['bane_of_arthropods 5', 'power 4', 'protection 2', 'fire_protection 4', 'unbreaking 3', 'thorns 1'].map((e, i) => book(i, e));
  t.like(booksStored(at45(allDone()), booksWorld(bookChests({ misc: useless }))), { all: 6, ofUse: 0 });
  t.like(bookFor(at45(allDone()), booksWorld(bookChests({ misc: useless }))), { ofUse: 0 });
  // but a pile of them does: each takes a chest slot
  const pile = Array.from({ length: BOOK_PILE }, (_, i) => book(i, 'bane_of_arthropods 5'));
  t.is(bookFor(at45(allDone()), booksWorld(bookChests({ misc: pile }))), undefined);
  // the stash put six in with a tool: which they are is not known, so they count until the anvil looks them over
  const lost = booksWorld();
  remember(lost, MISC, { oak_sign: 4, enchanted_book: 6 });
  t.like(booksStored(at45(allDone()), lost), { all: 6, ofUse: 6 });
  t.is(bookFor(at45(allDone()), lost), undefined);
  // carried books count with the stored
  t.like(booksStored(at45([...allDone(), { ...book(20, 'protection 4') }]), booksWorld(bookChests({ misc: useful.slice(1) }))), { all: 6, ofUse: 6 });
});

test('enchant: a book only from what the cane and the cows bring in, and never from what a bill needs', (t) => {
  const s = at45(allDone());
  t.like(bookFor(s, booksWorld()), { from: 'made' });
  t.is(bookFor(s, booksWorld(bookChests({ drops: stacksOf({ string: 14 }) }))), undefined, 'no leather');
  t.is(CANE_KEEP, 16);
  t.is(bookFor(s, booksWorld(bookChests({ seeds: stacksOf({ sugar_cane: 18 }) }))), undefined, 'the cane round keeps 16');
  t.truthy(bookFor(s, booksWorld(bookChests({ seeds: stacksOf({ sugar_cane: 19 }) }))));
  t.truthy(bookFor(s, booksWorld(bookChests({ seeds: [], misc: stacksOf({ paper: 3 }) }))), 'paper will do');
  t.like(bookFor(s, booksWorld(bookChests({ seeds: [], drops: [], misc: stacksOf({ book: 2 }) }))), { from: 'stored' });
  t.like(bookFor(at45([...allDone(), { slot: 20, name: 'book', count: 1 }]), booksWorld(bookChests({ seeds: [], drops: [] }))), { from: 'carried' });
  // what a bill has a use for: the project's shortfall, its carry, its back-off's need, a build job's bill
  const project = (p: Partial<NonNullable<WorldMemory['progress']>>) => booksWorld(bookChests(), { progress: { done: [], journal: [], ...p } });
  t.is(bookFor(s, project({ need: { leather: 4 } })), undefined);
  t.is(bookFor(s, project({ carry: ['sugar_cane', 'paper'] })), undefined);
  t.is(bookFor(s, project({ blocked: { id: 'hall/2', n: 1, at: 0, need: { book: 3 } } })), undefined);
  t.truthy(bookFor(s, project({ need: { iron_ingot: 31 } })));
  const job = booksWorld(bookChests(), { buildJobs: [{ id: 3, world: 'w', structure: 'library', mode: 'apply', status: 'working', createdAt: 0, updatedAt: 0, bill: { bookshelf: 6, book: 2 } }] });
  t.is(bookFor(s, job), undefined);
});

test('enchant: the pockets for a book: a slot more from the chests, two while it is made, and the stash\'s room left', (t) => {
  const made = booksWorld();
  // lapis carried: 36 - used - 2 (the stash's) - 2 (made) >= 0
  t.truthy(bookFor(at45(allDone(), { slotsUsed: 32 }), made));
  t.is(bookFor(at45(allDone(), { slotsUsed: 33 }), made), undefined);
  const stored = booksWorld(bookChests({ misc: stacksOf({ book: 1 }) }));
  t.truthy(bookFor(at45(allDone(), { slotsUsed: 33 }), stored));
  t.is(bookFor(at45(allDone(), { slotsUsed: 34 }), stored), undefined);
  const carried = [...allDone(), { slot: 20, name: 'book', count: 1 }];
  t.truthy(bookFor(at45(carried, { slotsUsed: 34 }), made));
  // no lapis carried: one slot more for it
  t.is(bookFor(at45(allDone().filter(i => i.name !== 'lapis_lazuli'), { slotsUsed: 32 }), booksWorld(bookChests({ misc: stacksOf({ lapis_lazuli: 40 }) }))), undefined);
});

/**
 * The table, the crafting and the storage house for a book, as the mod and the tools work them: take-from-chest and
 * craft-item (paper from 3 cane, a book from 3 paper and a leather, as 26.3's recipes have them); enchant.put takes one
 * book from the pockets; enchant.choose makes it an enchanted book with `makes` and shift-clicks it back (the hotbar's
 * end first); chest.open and chest.deposit (that pocket slot, into the first free chest slot). `offers: false`: the
 * table offers nothing.
 */
function bookTable(items: InventoryItem[], chests: Record<string, ChestStack[]>, opts: { makes?: ItemEnchantment[]; offers?: boolean } = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  let open: string | undefined;
  let inTable: InventoryItem | undefined;
  const pocket = () => [8, 7, 6, 5, 4, 3, 2, 1, 0, ...[...Array(27).keys()].map(k => 35 - k)].find(k => !items.some(i => i.slot === k))!;
  const add = (name: string, count: number) => {
    const onto = items.find(i => i.slot < 36 && i.name === name && i.count + count <= 64);
    if (onto) onto.count += count; else items.push({ slot: pocket(), name, count });
  };
  const use = (name: string, count: number) => {
    let left = count;
    for (const i of items.filter(x => x.slot < 36 && x.name === name)) {
      const n = Math.min(left, i.count);
      i.count -= n; left -= n;
    }
    items.splice(0, items.length, ...items.filter(i => i.count > 0));
    if (left) throw new Error(`missing ingredients: needs ${name} x${count}`);
  };
  const reply = (k: string) => ({ slots: 27, free: 27 - chests[k].length, items: totalsOf(chests[k]), stacks: chests[k].map(st => ({ ...st })) });
  const world = booksWorld(chests);
  const ctx = {
    s: at45(items), world, signal: new AbortController().signal,
    progress: (text: string) => { lines.push(`${enchantGoal.name}: ${text}`); }, gain: () => undefined,
    act: async (tool: string, p: Record<string, unknown> = {}) => {
      calls.push(`${tool} ${JSON.stringify(p)}`);
      if (tool === 'take-from-chest') {
        const k = key(p as unknown as Pos);
        const st = chests[k].find(x => x.name === p.item);
        const n = Math.min((p.count as number | undefined) ?? 64, st?.count ?? 0);
        if (st) { st.count -= n; chests[k] = chests[k].filter(x => x.count > 0); add(st.name, n); }
        return { ok: true, text: `Took ${n} ${String(p.item)} from the chest at (${p.x}, ${p.y}, ${p.z}). It holds: ${Object.entries(totalsOf(chests[k])).map(([nm, c]) => `${nm} x${c}`).join(', ') || 'nothing'}.` };
      }
      if (tool === 'craft-item') {
        const n = p.amount as number;
        if (p.outputItem === 'paper') { use('sugar_cane', 3 * n); add('paper', 3 * n); }
        if (p.outputItem === 'book') { use('paper', 3 * n); use('leather', n); add('book', n); }
        return { ok: true, text: `Crafted ${String(p.outputItem)}` };
      }
      return { ok: true, text: 'ok' };
    },
    call: (async (m: string, p: Record<string, unknown> = {}) => {
      if (m !== 'inventory') calls.push(`${m} ${JSON.stringify(p)}`);
      if (m === 'inventory') return { items: items.map(i => ({ ...i })) };
      if (m === 'goto') return { arrived: true };
      if (m === 'enchant.open') return { open: true };
      if (m === 'enchant.put') {
        const from = items.find(i => i.slot < 36 && i.name === p.name);
        if (!from) throw new Error(`no ${String(p.name)} in inventory`);
        use(from.name, 1);
        inTable = { ...from, count: 1 };
        const offers = opts.offers === false ? [0, 1, 2].map(slot => ({ slot, cost: 0 })) : [{ slot: 0, cost: 8 }, { slot: 1, cost: 19 }, { slot: 2, cost: 30 }];
        return { put: inTable.name, enchantable: opts.offers !== false, offers };
      }
      if (m === 'enchant.choose') {
        const enchantments = opts.makes ?? en('unbreaking 3');
        items.push({ slot: pocket(), name: 'enchanted_book', count: 1, enchantments });
        inTable = undefined;
        return { ok: true, item: 'enchanted_book', enchantments };
      }
      if (m === 'enchant.close') { if (inTable) { add(inTable.name, 1); inTable = undefined; } return { ok: true, wore: [] }; }
      if (m === 'chest.open') { open = key(p as unknown as Pos); return reply(open); }
      if (m === 'chest.deposit') {
        const i = items.findIndex(x => x.slot === p.slot && x.name === p.name);
        if (i < 0 || !open) return { ...reply(open!), moved: 0 };
        const [st] = items.splice(i, 1);
        const free = [...Array(27).keys()].find(k => !chests[open!].some(x => x.slot === k))!;
        chests[open].push({ ...st, slot: free });
        return { ...reply(open), moved: 1 };
      }
      if (m === 'container.close') { open = undefined; return { ok: true }; }
      return {};
    }) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null })
  } as unknown as GoalContext;
  return { ctx, calls, lines, items, chests, world };
}

test('enchant: a book made of the chests\' cane and leather, enchanted at the table, into the misc chest by its slot: "enchant: enchanted a book: unbreaking 3"', async (t) => {
  const items = allDone();
  const b = bookTable(items, bookChests());
  t.is(await enchantGoal.run(b.ctx), 'enchanted a book: unbreaking 3; into the chest at (-551, 65, 2179)');
  t.deepEqual(b.calls, [
    `take-from-chest ${JSON.stringify({ ...SEEDS, item: 'sugar_cane', count: 3 })}`,
    'craft-item {"outputItem":"paper","amount":1}',
    `take-from-chest ${JSON.stringify({ ...DROPS, item: 'leather', count: 1 })}`,
    'craft-item {"outputItem":"book","amount":1}',
    `goto ${JSON.stringify({ ...TABLE, range: 2, careful: true, timeoutMs: 60_000 })}`, // on foot only
    `enchant.open ${JSON.stringify(TABLE)}`,
    'enchant.put {"name":"book","lapis":3}',
    'enchant.choose {"slot":2}', // the dearest offer
    'enchant.close {}',
    `chest.open ${JSON.stringify(MISC)}`, // no gear chest (the stash's for enchanted books): the emptiest first
    'chest.deposit {"name":"enchanted_book","slot":8,"count":1}', // that one, by its slot
    'container.close {}'
  ]);
  t.deepEqual(b.lines, ['enchant: enchanted a book: unbreaking 3']);
  // remembered by its stack: the anvil picks it by what it holds
  t.deepEqual(b.world.chestStacks![key(MISC)], [{ slot: 0, name: 'oak_sign', count: 4 }, { slot: 1, name: 'enchanted_book', count: 1, enchantments: en('unbreaking 3') }]);
  t.false(items.some(i => /book|paper|leather|sugar_cane/.test(i.name)), 'nothing left over in the pockets');
  t.is(b.chests[key(SEEDS)].find(st => st.name === 'sugar_cane')?.count, 37);
  t.is(b.chests[key(DROPS)].find(st => st.name === 'leather')?.count, 9);
});

test('enchant: a book carried goes straight to the table; no offer for it is a failure, and the table is closed', async (t) => {
  const b = bookTable([...allDone(), { slot: 20, name: 'book', count: 2 }], bookChests());
  t.regex(await enchantGoal.run(b.ctx), /^enchanted a book: unbreaking 3; into the chest at/);
  t.false(b.calls.some(c => /^(take-from-chest|craft-item)/.test(c)));
  const none = bookTable([...allDone(), { slot: 20, name: 'book', count: 1 }], bookChests(), { offers: false });
  await t.throwsAsync(enchantGoal.run(none.ctx), { message: 'no offer for the book (not enchantable)' });
  t.is(none.calls.at(-1), 'enchant.close {}');
  t.is(none.items.find(i => i.name === 'book')?.count, 1, 'the book back from the table');
});

test('enchant: a book waits for the running project (and whatever else runs under 31) and takes over at the hand-over; a plain piece still cuts in', (t) => {
  const world = booksWorld();
  const s = at45(allDone());
  // the project mid-build (28, as the tree's): the brain's own filter while it runs, more urgent and worth the stop
  const project: Goal = { name: 'project', priority: projectGoal(TREE).priority, timeoutMs: 60_000, retryMs: 60_000, wants: () => 'a workshop: build the workshop', run: async () => 'built' };
  const cutters = (at: Snapshot) => [project, enchantGoal].filter(g => g.priority > project.priority && (g.cuts?.(at, world) ?? true));
  t.is(enchantGoal.wants(s, world), `level 45: enchant a book (0 of use in store, keeps ${BOOK_STOCK})`);
  t.false(enchantGoal.cuts!(s, world), 'a book can wait');
  t.is(decide(s, world, cutters(s), new Map()), undefined, 'nothing stops the project for a book');
  // the project ended: the book is next, ahead of it
  t.is(decide(s, world, [project, enchantGoal], new Map())?.goal.name, 'enchant');
  // a plain piece left for the table: it stops the project as it always has
  const plain = at45(allDone().map(i => (i.slot === 39 ? { slot: 39, name: 'diamond_helmet', count: 1 } : i)));
  t.true(enchantGoal.cuts!(plain, world));
  t.like(decide(plain, world, cutters(plain), new Map()), { goal: { name: 'enchant' }, reason: 'level 45: enchant the diamond_helmet (worn)' });
  // a gate only looks: nothing written
  const before = JSON.stringify(world);
  enchantGoal.cuts!(s, world);
  t.is(JSON.stringify(world), before);
});

test('bookChests: the gear chests first (books go with the gear), the emptier of a kind before the fuller', (t) => {
  // live, Nov 14: the one misc chest and the two after it in list order were full, and four books stayed carried
  const at = (x: number) => ({ x, y: 63, z: 0 });
  const stacks = (n: number) => Array.from({ length: n }, (_, i) => ({ slot: i, name: 'cobblestone', count: 64 }));
  const w = {
    landmarks: { chests: [at(0), at(1), at(2), at(3), at(4)], farmland: [] }, leash: 96,
    chestAssign: { '0,63,0': 'misc', '1,63,0': 'food', '2,63,0': 'gear', '3,63,0': 'gear', '4,63,0': 'stone' },
    chestStacks: { '0,63,0': stacks(27), '1,63,0': stacks(54), '2,63,0': stacks(15), '3,63,0': stacks(5), '4,63,0': stacks(7) }
  } as unknown as WorldMemory;
  t.deepEqual(bookChestOrder(w).map(c => c.x), [3, 2, 4, 0, 1]);
});
