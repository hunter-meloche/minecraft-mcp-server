import test from 'ava';
import { BREED_STOCK, PEN_FOOD } from '../../src/client/brain/animals.js';
import { farm } from '../../src/client/brain/chores.js';
import { breadToBake, gatherFood } from '../../src/client/brain/food.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

/**
 * The pens' wheat (S6 part `wheat`): the bake leaves BREED_STOCK of it, carried and stored together, for the pens
 * round to take out of the chests and breed from. Live on Nov 15 the cow pen said "need 2 wheat to breed (have 0)"
 * every round, 723 bread stored and no wheat: every 3 wheat went into bread, the pens round's leftover with it.
 * (The pens round breeding from the chests' stock: tests/client/cows.test.ts, "the pens round breeds from the wheat
 * the bake keeps". The farm round's own part of the need, from 9b52f00: wheat seeds sown while the cow pen is short and
 * no wait on a full larder then, tests/client/caps.test.ts "the cows' wheat"; its keep is this one rule now.)
 */

const CHEST = { x: 1, y: 64, z: 0 };
const CHEST_KEY = '1,64,0';

test('the pens keep 16 wheat, the usual food of both pens', t => {
  t.is(BREED_STOCK, 16);
  t.is(PEN_FOOD.cow[0], 'wheat');
  t.is(PEN_FOOD.sheep[0], 'wheat');
});

test('breadToBake: only the wheat beyond the pens\' stock, carried and stored together; starving, all of it', t => {
  // nothing stored: the carried wheat up to 16 stays
  t.is(breadToBake(0, 0), 0);
  t.is(breadToBake(7, 0), 0);
  t.is(breadToBake(16, 0), 0);
  t.is(breadToBake(18, 0), 0, 'two over: no loaf');
  t.is(breadToBake(19, 0), 1);
  t.is(breadToBake(30, 0), 4, '14 over: 4 loaves, 18 left');
  // some of the stock stored: the carried makes up the rest
  t.is(breadToBake(7, 10), 0, 'one over');
  t.is(breadToBake(7, 12), 1);
  // the stock stored in full: all the carried is spare, as before
  t.is(breadToBake(7, 16), 2);
  t.is(breadToBake(7, 300), 2, 'the chests\' wheat is not the bake\'s to carry');
  // a stored count that makes no sense counts as none
  t.is(breadToBake(19, -5), 1);
  t.is(breadToBake(19, Number.NaN), 1);
  t.is(breadToBake(Number.NaN, 0), 0);
  // starving: staying alive comes before a calf
  t.is(breadToBake(7, 0, true), 2);
  t.is(breadToBake(2, 0, true), 0);
  // what is left after the bake, carried and stored: the stock, or all of it when there was less; and no loaf the
  // spare wheat would make is left unbaked (fewer than 3 over the stock, or fewer than 3 carried)
  for (let carried = 0; carried <= 70; carried++) {
    for (const stored of [0, 1, 5, 10, 15, 16, 17, 40, 300]) {
      const loaves = breadToBake(carried, stored);
      const left = carried - 3 * loaves + stored;
      t.true(left >= Math.min(carried + stored, BREED_STOCK), `${carried} carried, ${stored} stored: ${left} left`);
      t.true(left - BREED_STOCK < 3 || carried - 3 * loaves < 3, `${carried} carried, ${stored} stored: ${loaves} loaves`);
    }
  }
});

/**
 * The food goal over one home chest holding `stored` (wheat and whatever else), the bot carrying `carried`, in the
 * evening (no farm, no fishing, no hunt: the chest and the bake alone). Like the client: chest.open answers what the
 * chest holds, take-from-chest says what it holds after, craft-item bread takes 3 wheat a loaf.
 */
function home(carried: Record<string, number>, stored: Record<string, number>, over: Partial<Snapshot> = {}) {
  const inv = new Map(Object.entries(carried));
  const inside = { ...stored };
  const acts: string[] = [];
  const world = { landmarks: { chests: [{ ...CHEST }], farmland: [] }, leash: 96, zones: {}, chestItems: { [CHEST_KEY]: { ...stored } } } as unknown as WorldMemory;
  const s = { now: 10 * 3_600_000, food: 18, health: 20, home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, counts: inv, position: { x: 0, y: 64, z: 0 }, ...over } as unknown as Snapshot;
  const holds = () => Object.entries(inside).filter(([, n]) => n > 0).map(([i, n]) => `${i} x${n}`).join(', ') || 'nothing';
  const ctx = {
    s, world, signal: new AbortController().signal, progress: () => undefined,
    status: async () => ({ timeOfDay: 11_500 }),
    call: (async (m: string) => {
      if (m === 'inventory') return { items: [...inv].filter(([, n]) => n > 0).map(([name, count], slot) => ({ slot, name, count })) };
      if (m === 'chest.open') return { items: Object.fromEntries(Object.entries(inside).filter(([, n]) => n > 0)), stacks: [], free: 20, slots: 27 };
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      acts.push(`${tool} ${a.item ?? a.outputItem ?? ''} ${a.count ?? a.amount ?? ''}`.trim());
      if (tool === 'take-from-chest') {
        const item = String(a.item), n = Math.min(Number(a.count), inside[item] ?? 0);
        inside[item] = (inside[item] ?? 0) - n;
        inv.set(item, (inv.get(item) ?? 0) + n);
        return { ok: true, text: `Took ${n} ${item} from the chest at (1, 64, 0). It holds: ${holds()}.` };
      }
      if (tool === 'craft-item' && a.outputItem === 'bread') {
        const n = Number(a.amount);
        if ((inv.get('wheat') ?? 0) < 3 * n) return { ok: false, text: 'missing ingredients for bread' };
        inv.set('wheat', (inv.get('wheat') ?? 0) - 3 * n);
        inv.set('bread', (inv.get('bread') ?? 0) + n);
        return { ok: true, text: `Successfully crafted bread ${n} time(s)` };
      }
      return { ok: false, text: 'no' };
    }
  } as unknown as GoalContext;
  return { ctx, inv, inside, acts, world };
}

test('the food goal bakes the wheat it carries beyond the pens\' 16, and keeps them carried for the stash to put away', async t => {
  const h = home({ wheat: 22 }, {});
  const text = await gatherFood(h.ctx, 20, true);
  t.regex(text, /^baked 2 bread; now carrying 10 food points$/);
  t.is(h.inv.get('wheat'), 16);
  t.deepEqual(h.acts, ['craft-item bread 2']);
});

test('the food goal takes out of the chests only the wheat beyond the pens\' 16, and leaves the 16 stored', async t => {
  const h = home({}, { wheat: 20 });
  const text = await gatherFood(h.ctx, 20, true);
  t.is(text, 'took wheat; baked 1 bread; now carrying 5 food points');
  t.deepEqual(h.acts, ['take-from-chest wheat 4', 'craft-item bread 1']);
  t.is(h.inside.wheat, 16);
  t.is(h.world.chestItems![CHEST_KEY].wheat, 16, 'the chest\'s memory says so too');
  t.is(h.inv.get('wheat'), 1);
});

test('the pens\' 16 stored and nothing else: the food goal leaves them, and fails as having no food to be had (its retry), not "took wheat" each time', async t => {
  const h = home({}, { wheat: 16 });
  await t.throwsAsync(gatherFood(h.ctx, 20, true), { message: /no food to be had/ });
  t.deepEqual(h.acts, []);
  t.is(h.inside.wheat, 16);
  // some of it carried, the rest stored: still the pens'
  const g = home({ wheat: 9 }, { wheat: 7 });
  await t.throwsAsync(gatherFood(g.ctx, 20, true), { message: /no food to be had/ });
  t.deepEqual(g.acts, []);
});

test('the food goal, starving with the pens\' wheat alone: bakes all of it (staying alive first)', async t => {
  const h = home({}, { wheat: 16 }, { food: 6 });
  const text = await gatherFood(h.ctx, 20, true);
  t.is(text, 'took wheat; baked 5 bread; now carrying 25 food points');
  t.deepEqual(h.acts, ['take-from-chest wheat 16', 'craft-item bread 5']);
  // hurt and hungry, with no ready food, the same
  const g = home({ wheat: 9 }, {}, { food: 15, health: 8 });
  t.regex(await gatherFood(g.ctx, 20, true), /^baked 3 bread/);
});

test('bread in the chest is taken before any wheat, as before: the pens\' wheat is not touched', async t => {
  const h = home({}, { bread: 40, wheat: 30 });
  const text = await gatherFood(h.ctx, 20, true);
  // 20 points and the chests' spare of 20: 8 loaves; then at the target, no wheat taken
  t.is(text, 'took 8 bread; now carrying 40 food points');
  t.is(h.inside.wheat, 30);
});

/** A farm round over two cells that harvests `harvest` wheat, `stored` wheat in the chest (and the bread under its cap). */
function farmRound(harvest: number, stored: number) {
  const acts: string[] = [];
  const world = {
    landmarks: { chests: [{ ...CHEST }], farmland: [{ x: 4, y: 63, z: 4 }, { x: 6, y: 63, z: 4 }] }, leash: 96,
    chestItems: { [CHEST_KEY]: { wheat: stored, bread: 100 } }
  } as unknown as WorldMemory;
  const s = {
    now: 10 * 3_600_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 0,
    home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0
  } as unknown as Snapshot;
  const ctx = {
    s, world, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown> = {}) => { acts.push(`${tool}${a.amount ? ` ${a.amount}` : ''}`); return { ok: true, text: tool === 'farm' ? `Harvested wheat x${harvest}` : 'ok' }; },
    call: (async (m: string) => (m === 'inventory' ? { items: harvest ? [{ slot: 3, name: 'wheat', count: harvest }] : [] } : {})) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined, gain: () => undefined
  } as GoalContext;
  return { ctx, acts };
}

test('the farm round bakes its harvest only beyond the pens\' stock, with or without a cow pen (the bake\'s one rule, breadToBake): none stored, the 7 stay (the stash stores them) and the log says so; 12 stored, one loaf and 4 kept; the stock stored, all of it as before', async t => {
  const none = farmRound(7, 0);
  t.is(await farm.run(none.ctx), 'Harvested wheat x7; kept 7 wheat for the cows');
  t.deepEqual(none.acts, ['move-to-position', 'farm']);
  const some = farmRound(7, 12);
  t.is(await farm.run(some.ctx), 'Harvested wheat x7; baked 1 bread; kept 4 wheat for the cows');
  t.deepEqual(some.acts, ['move-to-position', 'farm', 'craft-item 1']);
  const full = farmRound(7, 16);
  t.is(await farm.run(full.ctx), 'Harvested wheat x7; baked 2 bread');
  // a big harvest with none stored: the 16 kept, the rest baked
  const big = farmRound(31, 0);
  t.is(await farm.run(big.ctx), 'Harvested wheat x31; baked 5 bread; kept 16 wheat for the cows');
});
