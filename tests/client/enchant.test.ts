import test from 'ava';
import { enchantGoal } from '../../src/client/brain/enchant.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';
import type { InventoryItem } from '../../src/client/tools.js';

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
 * The table as the mod's enchant.put works it: the item slot is cleared first, then one of the named item goes in (from
 * `slot` if it holds that item, else the first by name), lapis topped up. An enchanted piece or lapis gets no offers.
 */
function table(items: InventoryItem[]) {
  const calls: string[] = [];
  let inSlot: InventoryItem | undefined;
  const offers = () => (inSlot && /_(sword|pickaxe)$/.test(inSlot.name) && !inSlot.enchanted
    ? [{ slot: 0, cost: 8, enchant: 'unbreaking' }, { slot: 1, cost: 19, enchant: 'sharpness' }, { slot: 2, cost: 30, enchant: 'sharpness' }]
    : [0, 1, 2].map(slot => ({ slot, cost: 0, enchant: null })));
  const ctx = {
    s: snap(items), world: { landmarks: { chests: [] }, leash: 96, zones: { 'enchanting:table': [TABLE] } } as unknown as WorldMemory,
    signal: new AbortController().signal,
    act: async () => ({ ok: true, text: 'ok' }),
    call: (async (m: string, a: Record<string, unknown> = {}) => {
      calls.push(`${m} ${JSON.stringify(a)}`);
      if (m === 'enchant.put') {
        const named = items.filter(i => i.name === a.name);
        inSlot = named.find(i => i.slot === a.slot) ?? named[0];
        return { put: inSlot?.name, enchantable: offers()[0].cost > 0, offers: offers() };
      }
      if (m === 'enchant.status') return { offers: offers() };
      if (m === 'enchant.choose') return { ok: true, enchantments: [{ name: 'sharpness', level: 5 }] };
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
