import test from 'ava';
import { ENCHANT_ORDER, enchantGoal, enchantPick, wornSlot } from '../../src/client/brain/enchant.js';
import { stash } from '../../src/client/brain/chores.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';
import { brainRun, type InventoryItem } from '../../src/client/tools.js';

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
