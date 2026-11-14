import test from 'ava';
import { chestTotals, peekChest, remember, rememberReply, sameStack, storedStacks, takeSlot } from '../../src/client/brain/chests.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';
import type { ChestStack } from '../../src/client/tools.js';

const A = { x: 1, y: 64, z: 0 };
const B = { x: 2, y: 64, z: 0 };
const MENDING: ChestStack = { slot: 7, name: 'enchanted_book', count: 1, enchantments: [{ name: 'mending', level: 1 }] };
const UNBREAKING: ChestStack = { slot: 2, name: 'enchanted_book', count: 1, enchantments: [{ name: 'unbreaking', level: 3 }] };
const FIRE: ChestStack = { slot: 4, name: 'potion', count: 3, potion: 'long_fire_resistance' };
const WEAKNESS: ChestStack = { slot: 5, name: 'potion', count: 1, potion: 'weakness' };
const LOGS: ChestStack = { slot: 0, name: 'oak_log', count: 64 };

const totals = (stacks: ChestStack[]) => {
  const out: Record<string, number> = {};
  for (const st of stacks) out[st.name] = (out[st.name] ?? 0) + st.count;
  return out;
};

/**
 * A home chest as the mod's chest.open and chest.withdraw answer: the totals and each stack by its slot (`old`: an
 * older jar, totals only, `slot` ignored, and every stack of the name taken). Withdraw takes the slot asked for when
 * it holds the name, else the first of the name, then only stacks the same as the first (Interact.sources).
 */
function chest(stacks: ChestStack[], opts: { old?: boolean } = {}) {
  const calls: { m: string; p: Record<string, unknown> }[] = [];
  let inside = stacks.map(st => ({ ...st }));
  const reply = () => ({ slots: 27, free: 27 - inside.length, items: totals(inside), ...(opts.old ? {} : { stacks: inside.map(st => ({ ...st })) }) });
  const world = { landmarks: { chests: [A, B], farmland: [] }, leash: 96 } as WorldMemory;
  const ctx = {
    world,
    progress: () => undefined,
    act: async () => ({ ok: true, text: 'there' }),
    call: async (m: string, p: Record<string, unknown> = {}) => {
      calls.push({ m, p });
      if (m === 'chest.open') return reply();
      if (m === 'chest.withdraw') {
        const named = inside.filter(st => st.name === p.name);
        const want = opts.old ? undefined : named.find(st => st.slot === p.slot);
        const first = want ?? named[0];
        const order = opts.old ? named : first ? [first, ...named.filter(st => st !== first && sameStack(st, first))] : [];
        let left = typeof p.count === 'number' ? p.count : Infinity, moved = 0;
        for (const st of order) {
          const n = Math.min(left, st.count);
          st.count -= n; left -= n; moved += n;
        }
        inside = inside.filter(st => st.count > 0);
        return { ...reply(), moved, ...(opts.old || p.slot === undefined ? {} : { from: first ? first.slot : -1 }) };
      }
      if (m === 'container.close') return { ok: true };
      throw new Error(`unexpected ${m}`);
    }
  };
  return { ctx: ctx as unknown as GoalContext, world, calls, set: (s: ChestStack[]) => { inside = s.map(st => ({ ...st })); } };
}

test('peekChest remembers each stack by its slot with its detail; an older jar\'s reply leaves none', async (t) => {
  const c = chest([LOGS, UNBREAKING, MENDING, FIRE]);
  t.deepEqual(await peekChest(c.ctx, A), { oak_log: 64, enchanted_book: 2, potion: 3 });
  t.deepEqual(c.world.chestStacks, { '1,64,0': [LOGS, UNBREAKING, MENDING, FIRE] });
  const old = chest([LOGS, MENDING], { old: true });
  await peekChest(old.ctx, A);
  t.deepEqual(old.world.chestItems, { '1,64,0': { oak_log: 64, enchanted_book: 1 } });
  t.is(old.world.chestStacks, undefined);
});

test('a tool\'s "It holds:" reply keeps the stacks of the names it left as they were, and drops those whose count changed', (t) => {
  const world = { landmarks: { chests: [A], farmland: [] }, leash: 96 } as WorldMemory;
  remember(world, A, totals([LOGS, UNBREAKING, MENDING, FIRE]), [LOGS, UNBREAKING, MENDING, FIRE]);
  // one book taken by name: which of the two is not said, so neither slot is trusted; the logs and potions stand
  rememberReply(world, A, 'Took 1 enchanted_book from the chest at (1, 64, 0). It holds: oak_log x64, enchanted_book x1, potion x3.');
  t.deepEqual(world.chestItems!['1,64,0'], { oak_log: 64, enchanted_book: 1, potion: 3 });
  t.deepEqual(world.chestStacks!['1,64,0'], [LOGS, FIRE]);
  // logs put in: they may have topped up the stack or taken a new slot
  rememberReply(world, A, 'Stored 10 oak_log in the chest at (1, 64, 0). It holds: oak_log x74, enchanted_book x1, potion x3; 23/27 slots free.');
  t.deepEqual(world.chestStacks!['1,64,0'], [FIRE]);
  // nothing left that is known: no entry at all
  rememberReply(world, A, 'Took 3 potion from the chest at (1, 64, 0). It holds: oak_log x74, enchanted_book x1.');
  t.false('1,64,0' in world.chestStacks!);
  t.deepEqual(chestTotals(world), { oak_log: 74, enchanted_book: 1 });
});

test('storedStacks finds a stack by its detail in every home chest, and none in a chest no longer counted', (t) => {
  const world = { landmarks: { chests: [A, B], farmland: [] }, leash: 96 } as WorldMemory;
  remember(world, A, totals([LOGS, UNBREAKING]), [LOGS, UNBREAKING]);
  remember(world, B, totals([MENDING, FIRE, WEAKNESS]), [MENDING, FIRE, WEAKNESS]);
  remember(world, { x: 9, y: 64, z: 9 }, totals([MENDING]), [MENDING]);
  const mending = (st: ChestStack) => st.name === 'enchanted_book' && !!st.enchantments?.some(e => e.name === 'mending');
  t.deepEqual(storedStacks(world, mending), [{ chest: B, stack: MENDING }]);
  t.deepEqual(storedStacks(world, st => st.name === 'enchanted_book').map(f => f.stack.slot), [2, 7]);
  t.deepEqual(storedStacks(world, st => st.potion === 'long_fire_resistance'), [{ chest: B, stack: FIRE }]);
  t.deepEqual(storedStacks(world, st => st.name === 'diamond'), []);
  t.deepEqual(storedStacks({ landmarks: { chests: [A], farmland: [] }, leash: 96 }, () => true), []);
});

test('sameStack: the name, the enchantments in any order, the potion; not the wear or the count', (t) => {
  t.true(sameStack(MENDING, { ...MENDING, slot: 20 }));
  t.false(sameStack(MENDING, UNBREAKING));
  t.false(sameStack(FIRE, WEAKNESS));
  t.true(sameStack(FIRE, { ...FIRE, count: 1, slot: 9 }));
  const a: ChestStack = { slot: 0, name: 'diamond_pickaxe', count: 1, damage: 3, maxDamage: 1561, enchantments: [{ name: 'fortune', level: 3 }, { name: 'unbreaking', level: 3 }] };
  t.true(sameStack(a, { ...a, damage: 900, enchantments: [{ name: 'unbreaking', level: 3 }, { name: 'fortune', level: 3 }] }));
  t.false(sameStack(a, { ...a, enchantments: [{ name: 'fortune', level: 2 }, { name: 'unbreaking', level: 3 }] }));
  t.false(sameStack(a, { ...a, enchantments: undefined }));
});

test('takeSlot takes the book in the slot remembered, not the first of its name, and remembers what is left', async (t) => {
  const c = chest([LOGS, UNBREAKING, MENDING]);
  await peekChest(c.ctx, A);
  t.is(await takeSlot(c.ctx, A, 7), 1);
  t.deepEqual(c.calls.filter(x => x.m === 'chest.withdraw').map(x => x.p), [{ name: 'enchanted_book', slot: 7, count: 1 }]);
  t.deepEqual(c.world.chestStacks!['1,64,0'], [LOGS, UNBREAKING]);
  t.deepEqual(c.world.chestItems!['1,64,0'], { oak_log: 64, enchanted_book: 1 });
  t.is(c.calls.at(-1)!.m, 'container.close');
});

test('takeSlot takes that one stack: of two books with mending, the one asked for, not both', async (t) => {
  // without a count chest.withdraw goes on to every stack the same as the first (Interact.sources)
  const c = chest([LOGS, MENDING, { ...MENDING, slot: 8 }]);
  await peekChest(c.ctx, A);
  t.is(await takeSlot(c.ctx, A, 7), 1);
  t.deepEqual(c.calls.filter(x => x.m === 'chest.withdraw').map(x => x.p), [{ name: 'enchanted_book', slot: 7, count: 1 }]);
  t.deepEqual(c.world.chestStacks!['1,64,0'], [LOGS, { ...MENDING, slot: 8 }]);
});

test('takeSlot: three fire resistance of a slot and a count, never the weakness potion beside them', async (t) => {
  const c = chest([{ ...WEAKNESS, slot: 1 }, FIRE, { ...FIRE, slot: 9, count: 2 }]);
  await peekChest(c.ctx, A);
  t.is(await takeSlot(c.ctx, A, 4, 4), 4);
  t.deepEqual(c.calls.filter(x => x.m === 'chest.withdraw').map(x => x.p), [{ name: 'potion', slot: 4, count: 4 }]);
  t.deepEqual(c.world.chestStacks!['1,64,0'], [{ ...WEAKNESS, slot: 1 }, { ...FIRE, slot: 9, count: 1 }]);
});

test('takeSlot: a slot that holds something else now takes the same book from where it is; one that is gone takes nothing', async (t) => {
  const c = chest([LOGS, UNBREAKING, MENDING]);
  await peekChest(c.ctx, A);
  // someone moved things about (the sort round): the mending book is in slot 12 now, unbreaking in 7
  c.set([LOGS, { ...UNBREAKING, slot: 7 }, { ...MENDING, slot: 12 }]);
  t.is(await takeSlot(c.ctx, A, 7), 1);
  t.deepEqual(c.calls.filter(x => x.m === 'chest.withdraw').map(x => x.p), [{ name: 'enchanted_book', slot: 12, count: 1 }]);
  t.deepEqual(c.world.chestStacks!['1,64,0'], [LOGS, { ...UNBREAKING, slot: 7 }]);
  // the mending book is gone now: nothing is taken, and the chest's memory is fresh
  c.calls.length = 0;
  c.world.chestStacks!['1,64,0'].push({ ...MENDING, slot: 12 });
  t.is(await takeSlot(c.ctx, A, 12), 0);
  t.deepEqual(c.calls.filter(x => x.m === 'chest.withdraw'), []);
  t.deepEqual(c.world.chestStacks!['1,64,0'], [LOGS, { ...UNBREAKING, slot: 7 }]);
  t.is(c.calls.at(-1)!.m, 'container.close');
});

test('takeSlot: nothing remembered in that slot takes nothing and opens nothing; an older jar takes nothing at all', async (t) => {
  const c = chest([LOGS, MENDING]);
  t.is(await takeSlot(c.ctx, A, 7), 0);
  t.deepEqual(c.calls, []);
  // an older jar (the rollback one, with stacks still remembered from the newer jar): no stacks to check against, and
  // its withdraw would take the first of the name, the book with unbreaking. Nothing is taken, and the chest's stacks
  // are forgotten, so storedStacks offers them no more
  const old = chest([UNBREAKING, MENDING], { old: true });
  remember(old.world, A, totals([UNBREAKING, MENDING]), [UNBREAKING, MENDING]);
  t.is(await takeSlot(old.ctx, A, 7), 0);
  t.deepEqual(old.calls.filter(x => x.m === 'chest.withdraw'), []);
  t.false('1,64,0' in (old.world.chestStacks ?? {}));
  t.deepEqual(storedStacks(old.world, () => true), []);
  t.deepEqual(old.world.chestItems!['1,64,0'], { enchanted_book: 2 });
  t.is(old.calls.at(-1)!.m, 'container.close');
});
