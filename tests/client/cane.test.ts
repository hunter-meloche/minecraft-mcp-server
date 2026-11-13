import test from 'ava';
import { caneCellPlan, caneMilestone, caneRound, caneStands, shoreCells } from '../../src/client/brain/cane.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import { enchantingMilestone } from '../../src/client/brain/enchant.js';

// 6 x 3 x 1: water at x 0..1, grass at x 2..5 on layer 0, air above
function shore() {
  const box = { x: 10, y: 62, z: 0, width: 6, height: 3, length: 1 };
  const b: string[] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 6; x++) b.push(y > 0 ? 'air' : x < 2 ? 'water[level=0]' : 'grass_block[snowy=false]');
  return { box, b };
}

type Box = { x: number; y: number; z: number; width: number; height: number; length: number };
type P = { x: number; y: number; z: number };

/**
 * A flat shore for the round as the client answers it: grass at y 62 (water where `water` says: beside the cells'
 * ground), `grid`'s blocks over it, air above. world.region box by box (x fastest, then z, then y); goto walks onto
 * the block asked for, careful or not (each walk written down); dig.here digs a block within reach of the eye (4.5),
 * as the bridge's does, and says "out of reach or out of sight" beyond it.
 */
function flatShore(grid: Map<string, string>, water: (x: number, z: number) => boolean, from: P) {
  const me = { pos: { ...from }, walks: [] as { to: string; careful: boolean }[], digs: [] as string[] };
  const at = (x: number, y: number, z: number) => grid.get(`${x},${y},${z}`) ?? (y > 62 ? 'air' : y < 62 ? 'dirt' : water(x, z) ? 'water[level=0]' : 'grass_block[snowy=false]');
  const region = (b: Box) => {
    const out: string[] = [];
    for (let y = 0; y < b.height; y++) for (let z = 0; z < b.length; z++) for (let x = 0; x < b.width; x++) out.push(at(b.x + x, b.y + y, b.z + z));
    return out;
  };
  const reach = (p: P) => {
    const eye = { x: me.pos.x + 0.5, y: me.pos.y + 1.62, z: me.pos.z + 0.5 };
    const near = (v: number, lo: number) => Math.max(lo, Math.min(lo + 1, v));
    return Math.hypot(eye.x - near(eye.x, p.x), eye.y - near(eye.y, p.y), eye.z - near(eye.z, p.z));
  };
  const call = async (m: string, a: Record<string, unknown> = {}) => {
    const p = { x: Number(a.x), y: Number(a.y), z: Number(a.z) };
    const k = `${p.x},${p.y},${p.z}`;
    if (m === 'world.region') return { blocks: region(a as unknown as Box) };
    if (m === 'goto') { me.walks.push({ to: k, careful: !!a.careful }); me.pos = p; return { arrived: true, at: p }; }
    if (m === 'dig.here') {
      me.digs.push(k);
      const b = at(p.x, p.y, p.z);
      if (b === 'air') return { dug: false, reason: 'air' };
      if (reach(p) > 4.5) return { dug: false, reason: 'out of reach or out of sight', block: b };
      grid.set(k, 'air');
      return { dug: true, block: b };
    }
    return {};
  };
  return { me, at, call, reach };
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

test('caneStands: on the land beside the cell, never on the water, in or over a cell of the patch, and within a block of its level', async (t) => {
  // the water south of the cells' ground; a ditch 3 deep runs north from between the two cells (its floor at y 59)
  const grid = new Map<string, string>([['0,63,0', 'cobblestone'], ['0,62,0', 'dirt'], ['2,63,0', 'sugar_cane']]);
  for (let z = -4; z <= 0; z++) for (const y of [60, 61, 62]) grid.set(`1,${y},${z}`, 'air');
  const shore = flatShore(grid, (_x, z) => z >= 1, { x: 1, y: 60, z: -3 });
  const c = { x: 0, y: 63, z: 0 };
  const box = { x: c.x - 4, y: c.y - 6, z: c.z - 4, width: 9, height: 10, length: 9 };
  const view = { blocks: (await shore.call('world.region', box) as { blocks: string[] }).blocks, box };
  const cells = [c, { x: 2, y: 63, z: 0 }];
  const stands = caneStands(view, c, shore.me.pos, cells);
  t.true(stands.length > 0);
  // beside the cell first: west of it on the land, or north (the ditch is the nearest to the bot, 3 below: left out)
  t.deepEqual(stands.slice(0, 2).map(p => `${p.x},${p.y},${p.z}`).sort(), ['-1,63,0', '0,63,-1']);
  t.true(stands.every(p => p.y === 63 && p.z <= 0), JSON.stringify(stands));
  t.false(stands.some(p => cells.some(q => q.x === p.x && q.z === p.z)));
});

test('cane round: cells filled with cobblestone are dug out by hand from the land beside them and replanted from the cane carried', async (t) => {
  // live 2026-11-09: five cane cells held cobblestone; "cut 0 stalk(s) (0 cane)" every 20 min for 15 h, 15 cane carried.
  // Live 2026-11-13 Baritone's dig (dig-block) of such filler by the water timed out, 60 s a cell, every round: the
  // filler is dug by hand now (dig.here), from a stand cell on the land walked to carefully
  const cells = [{ x: 0, y: 63, z: 0 }, { x: 2, y: 63, z: 0 }];
  const world = { zones: { cane: cells }, lastDone: {} };
  const grid = new Map<string, string>([['0,63,0', 'cobblestone'], ['2,63,0', 'cobblestone'], ['0,62,0', 'dirt'], ['2,62,0', 'dirt']]);
  // the water south of the cells' ground; the bot 7 out to the north-east
  const shore = flatShore(grid, (_x, z) => z >= 1, { x: 6, y: 63, z: -3 });
  let cane = 15;
  const acts: string[] = [];
  const ctx = {
    // (the round asks the pockets rule for room before it starts: one slot in use, the cane)
    world, s: { now: 1, slotsUsed: 1, position: { x: 6.5, y: 63, z: -2.5 } }, progress: () => undefined, gain: () => undefined, signal: new AbortController().signal,
    status: async () => ({ position: { ...shore.me.pos } }),
    call: async (m: string, a: Record<string, unknown>) => (m === 'inventory' ? { items: [{ slot: 3, name: 'sugar_cane', count: cane }] } : shore.call(m, a)),
    act: async (tool: string, a: P) => {
      const k = `${a.x},${a.y},${a.z}`;
      // (out of reach, the tool walks there by Baritone's own way)
      acts.push(`${tool} ${k}${shore.reach(a) > 4.5 ? ' (walked by Baritone)' : ''}`);
      if (tool === 'dig-block') throw new Error(`Could not dig ${shore.at(a.x, a.y, a.z)} at (${a.x}, ${a.y}, ${a.z}) (timeout).`);
      if (shore.at(a.x, a.y, a.z) !== 'air') return { ok: true, text: `There's already a block (${shore.at(a.x, a.y, a.z)}) at (${k})` };
      grid.set(k, 'sugar_cane'); cane--;
      return { ok: true, text: `Placed sugar_cane at (${k}) using down face` };
    }
  } as unknown as GoalContext;
  const r = await caneRound.run(ctx);
  t.deepEqual(shore.me.digs, ['0,63,0', '2,63,0']);
  t.deepEqual(acts, ['place-block 0,63,0', 'place-block 2,63,0']);
  t.is(grid.get('0,63,0'), 'sugar_cane');
  t.is(grid.get('0,62,0'), 'dirt', 'the ground stays');
  // one careful walk, to the land between the two cells: both are in reach from there
  t.deepEqual(shore.me.walks, [{ to: '1,63,0', careful: true }]);
  t.regex(String(r), /replanted 2; cleared 2 cell\(s\) of scaffold; 0 skipped$/);
});

test('cane round: no cane carried and the cells bare, it takes cane from the chests to replant', async (t) => {
  // live 2026-11-10: the stash had put all the cane away (37 in the food chest); all five cells empty, "cut 0
  // stalk(s) (0 cane)" every 20 min for 9 hours
  const cells = [{ x: 0, y: 63, z: 0 }, { x: 2, y: 63, z: 0 }, { x: 4, y: 63, z: 0 }];
  const chest = { x: 9, y: 63, z: 9 };
  const world = { zones: { cane: cells }, lastDone: {}, landmarks: { chests: [chest] }, chestItems: { '9,63,9': { sugar_cane: 37 } } };
  const grid = new Map<string, string>([['4,63,0', 'sugar_cane']]);
  const shore = flatShore(grid, (_x, z) => z >= 1, { x: 6, y: 63, z: -3 });
  let cane = 0;
  const acts: string[] = [];
  const ctx = {
    world, s: { now: 1, slotsUsed: 0, position: { x: 6.5, y: 63, z: -2.5 } }, progress: () => undefined, gain: () => undefined, signal: new AbortController().signal,
    status: async () => ({ position: { ...shore.me.pos } }),
    call: async (m: string, a: Record<string, unknown>) => (m === 'inventory' ? { items: cane ? [{ slot: 3, name: 'sugar_cane', count: cane }] : [] } : shore.call(m, a)),
    act: async (tool: string, a: P & { count?: number }) => {
      const k = `${a.x},${a.y},${a.z}`;
      acts.push(tool === 'take-from-chest' ? `${tool} ${a.count}` : `${tool} ${k}${shore.reach(a) > 4.5 ? ' (walked by Baritone)' : ''}`);
      if (tool === 'take-from-chest') { cane += a.count!; return { ok: true, text: `Took ${a.count} sugar_cane` }; }
      grid.set(k, 'sugar_cane'); cane--;
      return { ok: true, text: `Placed sugar_cane at (${k}) using down face` };
    }
  } as unknown as GoalContext;
  const r = await caneRound.run(ctx);
  t.deepEqual(acts, ['take-from-chest 2', 'place-block 0,63,0', 'place-block 2,63,0'], 'two bare cells, two stalks; the growing one is left');
  t.regex(String(r), /replanted 2/);
});

test('cane round: stopped for something more urgent before it saw to a cell, the day is not written off', async (t) => {
  // live 2026-11-12: repair cut in 5 s after every morning's start; the mark written first kept the round off till the
  // next day, and it ran on 1 day of 9
  const cells = [{ x: 0, y: 63, z: 0 }];
  const world = { zones: { cane: cells }, lastDone: { cane: 5 } };
  const abort = new AbortController();
  const ctx = {
    world, s: { now: 100, slotsUsed: 1, position: { x: 1.5, y: 63, z: 0.5 } }, progress: () => undefined, gain: () => undefined, signal: abort.signal,
    call: async (m: string) => {
      if (m === 'inventory') return { items: [{ slot: 3, name: 'sugar_cane', count: 3 }] };
      abort.abort(); // stopped while it looks at the cells
      return { blocks: ['sugar_cane', 'sugar_cane', 'air'] };
    },
    act: async () => { throw new Error('aborted'); }
  } as unknown as GoalContext;
  await caneRound.run(ctx).catch(() => undefined);
  t.is(world.lastDone.cane, 5, 'the last finished round stands');

  // a round that gets through (here: cutting) is written down
  const shore = flatShore(new Map([['0,63,0', 'sugar_cane'], ['0,64,0', 'sugar_cane']]), (_x, z) => z >= 1, { x: 1, y: 63, z: 0 });
  const ok = { ...ctx, signal: new AbortController().signal, status: async () => ({ position: { ...shore.me.pos } }),
    call: async (m: string, a: Record<string, unknown>) => (m === 'inventory' ? { items: [] } : shore.call(m, a)),
    act: async () => ({ ok: true, text: 'Dug sugar_cane' }) } as unknown as GoalContext;
  t.is(await caneRound.run(ok), 'cut 1 stalk(s) (0 cane)');
  t.is(world.lastDone.cane, 100);
});
