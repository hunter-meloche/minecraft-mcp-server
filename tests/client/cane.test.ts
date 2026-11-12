import test from 'ava';
import { caneCellPlan, caneMilestone, caneRound, shoreCells } from '../../src/client/brain/cane.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import { enchantingMilestone } from '../../src/client/brain/enchant.js';

// 6 x 3 x 1: water at x 0..1, grass at x 2..5 on layer 0, air above
function shore() {
  const box = { x: 10, y: 62, z: 0, width: 6, height: 3, length: 1 };
  const b: string[] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 6; x++) b.push(y > 0 ? 'air' : x < 2 ? 'water[level=0]' : 'grass_block[snowy=false]');
  return { box, b };
}

test('shoreCells: only the land cell right beside the water, a block up', (t) => {
  const { box, b } = shore();
  t.deepEqual(shoreCells(box, b, 10), [{ x: 12, y: 63, z: 0 }]);
});

test('shoreCells: nothing where something stands on the shore', (t) => {
  const { box, b } = shore();
  b[6 + 2] = 'oak_fence';
  t.deepEqual(shoreCells(box, b, 10), []);
});

test('enchanting is done once the room is there', (t) => {
  const view = (zones: Record<string, unknown[]>) => ({ s: {} as never, world: { zones } as never, have: () => 0 });
  t.false(enchantingMilestone([]).done!(view({})));
  t.true(enchantingMilestone([]).done!(view({ enchanting: [{}] })));
});

test('find sugar cane: none in sight from home, it looks one side of home a run, in turn, and mines what it finds', async (t) => {
  // live 2026-11-08: "no sugar_cane in sight" hourly from home alone for 7 h, and the enchanting room never started
  const find = caneMilestone([]).steps[0];
  const world = { zones: {} as Record<string, unknown[]>, leash: 96, landmarks: { chests: [] }, chestItems: {} };
  const st = { id: 'cane', step: 0, data: {} as Record<string, unknown> };
  let cane = 0, foundSide = '';
  const acts: string[] = [];
  const ctx = {
    world, progress: () => undefined, signal: new AbortController().signal,
    call: async (m: string) => (m === 'inventory' ? { items: cane ? [{ slot: 0, name: 'sugar_cane', count: cane }] : [] }
      : m === 'world.findBlocks' ? { positions: [] } : {}),
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      acts.push(tool === 'explore' ? `explore ${a.direction}` : tool);
      if (tool === 'explore') return { ok: true, text: a.direction === foundSide ? 'Found sugar_cane at (40, 63, 0), 40 blocks east of where the search began; the bot is at (30, 63, 0).' : 'No sugar_cane within 96 blocks' };
      if (tool === 'mine-blocks') { cane = 6; return { ok: true, text: 'Mined 6 sugar_cane' }; }
      return { ok: true, text: 'ok' };
    }
  } as unknown as GoalContext;

  const first = await find.run(ctx, st as never);
  t.is(first.status, 'blocked');
  t.is((first as { retryMs?: number }).retryMs, 5 * 60_000, 'the next side soon');
  t.deepEqual(acts.filter(a => a.startsWith('explore')), ['explore north']);

  foundSide = 'east';
  acts.length = 0;
  const second = await find.run(ctx, st as never);
  t.deepEqual(acts.filter(a => a.startsWith('explore')), ['explore east'], 'the next side, not north again');
  t.true(acts.includes('mine-blocks'));
  t.is(second.status, 'done');
  t.deepEqual(world.zones.wildcane, [{ x: 40, y: 63, z: 0 }], 'and remembers where the cane grows');
});

test('find sugar cane: round all four sides with none found, it waits an hour', async (t) => {
  const find = caneMilestone([]).steps[0];
  const world = { zones: {}, leash: 96, landmarks: { chests: [] }, chestItems: {} };
  const st = { id: 'cane', step: 0, data: { caneLooked: 3 } as Record<string, unknown> };
  const ctx = {
    world, progress: () => undefined, signal: new AbortController().signal,
    call: async (m: string) => (m === 'inventory' ? { items: [] } : m === 'world.findBlocks' ? { positions: [] } : {}),
    act: async () => ({ ok: true, text: 'No sugar_cane within 96 blocks' })
  } as unknown as GoalContext;
  const r = await find.run(ctx, st as never);
  t.is((r as { retryMs?: number }).retryMs, 60 * 60_000);
  t.is(st.data.caneLooked, 4);
});

test('caneCellPlan: cut grown cane, replant into air, clear scaffold off its own cell, leave anything else', (t) => {
  t.is(caneCellPlan('sugar_cane', 'sugar_cane', false), 'cut');
  t.is(caneCellPlan('sugar_cane', 'air', true), 'leave');
  t.is(caneCellPlan('air', 'air', true), 'plant');
  t.is(caneCellPlan('cobblestone', 'air', true), 'clear');
  t.is(caneCellPlan('cobblestone', 'air', false), 'leave', 'nothing to plant: the block stays');
  t.is(caneCellPlan('oak_planks', 'air', true), 'leave', 'not scaffold: someone may have built there');
});

test('cane round: cells filled with cobblestone are cleared and replanted from the cane carried', async (t) => {
  // live 2026-11-09: five cane cells held cobblestone; "cut 0 stalk(s) (0 cane)" every 20 min for 15 h, 15 cane carried
  const cells = [{ x: 0, y: 63, z: 0 }, { x: 2, y: 63, z: 0 }];
  const world = { zones: { cane: cells }, lastDone: {} };
  const grid = new Map<string, string>([['0,63,0', 'cobblestone'], ['2,63,0', 'cobblestone']]);
  let cane = 15;
  const acts: string[] = [];
  const ctx = {
    // (the round asks the pockets rule for room before it starts: one slot in use, the cane)
    world, s: { now: 1, slotsUsed: 1 }, progress: () => undefined, gain: () => undefined, signal: new AbortController().signal,
    call: async (m: string, a: { x: number; y: number; z: number }) => (m === 'inventory'
      ? { items: [{ slot: 3, name: 'sugar_cane', count: cane }] }
      : { blocks: [0, 1, 2].map(dy => grid.get(`${a.x},${a.y + dy},${a.z}`) ?? 'air') }),
    act: async (tool: string, a: { x: number; y: number; z: number }) => {
      const k = `${a.x},${a.y},${a.z}`;
      acts.push(`${tool} ${k}`);
      if (tool === 'dig-block') { const b = grid.get(k); grid.delete(k); return { ok: true, text: `Dug ${b} at (${k})` }; }
      if (grid.has(k)) return { ok: true, text: `There's already a block (${grid.get(k)}) at (${k})` };
      grid.set(k, 'sugar_cane'); cane--;
      return { ok: true, text: `Placed sugar_cane at (${k}) using down face` };
    }
  } as unknown as GoalContext;
  const r = await caneRound.run(ctx);
  t.deepEqual(acts, ['dig-block 0,63,0', 'place-block 0,63,0', 'dig-block 2,63,0', 'place-block 2,63,0']);
  t.is(grid.get('0,63,0'), 'sugar_cane');
  t.regex(String(r), /replanted 2 \(2 cell\(s\) cleared of scaffold first\)/);
});

test('cane round: no cane carried and the cells bare, it takes cane from the chests to replant', async (t) => {
  // live 2026-11-10: the stash had put all the cane away (37 in the food chest); all five cells empty, "cut 0
  // stalk(s) (0 cane)" every 20 min for 9 hours
  const cells = [{ x: 0, y: 63, z: 0 }, { x: 2, y: 63, z: 0 }, { x: 4, y: 63, z: 0 }];
  const chest = { x: 9, y: 63, z: 9 };
  const world = { zones: { cane: cells }, lastDone: {}, landmarks: { chests: [chest] }, chestItems: { '9,63,9': { sugar_cane: 37 } } };
  const grid = new Map<string, string>([['4,63,0', 'sugar_cane']]);
  let cane = 0;
  const acts: string[] = [];
  const ctx = {
    world, s: { now: 1, slotsUsed: 0 }, progress: () => undefined, gain: () => undefined, signal: new AbortController().signal,
    call: async (m: string, a: { x: number; y: number; z: number }) => (m === 'inventory'
      ? { items: cane ? [{ slot: 3, name: 'sugar_cane', count: cane }] : [] }
      : { blocks: [0, 1, 2].map(dy => grid.get(`${a.x},${a.y + dy},${a.z}`) ?? 'air') }),
    act: async (tool: string, a: { x: number; y: number; z: number; count?: number }) => {
      const k = `${a.x},${a.y},${a.z}`;
      acts.push(tool === 'take-from-chest' ? `${tool} ${a.count}` : `${tool} ${k}`);
      if (tool === 'take-from-chest') { cane += a.count!; return { ok: true, text: `Took ${a.count} sugar_cane` }; }
      grid.set(k, 'sugar_cane'); cane--;
      return { ok: true, text: `Placed sugar_cane at (${k}) using down face` };
    }
  } as unknown as GoalContext;
  const r = await caneRound.run(ctx);
  t.deepEqual(acts, ['take-from-chest 2', 'place-block 0,63,0', 'place-block 2,63,0'], 'two bare cells, two stalks; the growing one is left');
  t.regex(String(r), /replanted 2/);
});
