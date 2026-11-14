import test from 'ava';
import { treeCells, cropPlotMilestone, treeFarmMilestone } from '../../src/client/brain/farming.js';
import type { GoalContext } from '../../src/client/brain/goals.js';

test('treeCells: a 4 x 3 grid, 4 apart, a block above the ground', (t) => {
  const cells = treeCells({ x: 10, y: 66, z: -20 });
  t.is(cells.length, 12);
  t.deepEqual(cells[0], { x: 10, y: 67, z: -20 });
  t.deepEqual(cells[11], { x: 22, y: 67, z: -12 });
});

test('the plot and the tree farm count as done once their zones are there', (t) => {
  const view = (zones: Record<string, unknown[]>) => ({ s: {} as never, world: { landmarks: { chests: [], farmland: [] }, leash: 96, zones } as never, have: () => 0 });
  t.false(cropPlotMilestone(1, []).done!(view({})));
  t.true(cropPlotMilestone(1, []).done!(view({ plot: [{}] })));
  t.false(cropPlotMilestone(2, []).done!(view({ plot: [{}] })));
  t.true(treeFarmMilestone([]).done!(view({ trees: [{}] })));
});

test('till: grass with its state is tilled, and a plot with no farmland is not done', async (t) => {
  const { tillStep } = await import('../../src/client/brain/farming.js');
  const used: string[] = [];
  const ctx = {
    s: { items: [{ slot: 0, name: 'stone_hoe', count: 1 }] }, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown>) => { used.push(`${tool} ${a.x},${a.z}`); return { ok: true, text: 'grass_block -> grass_block' }; },
    call: async () => ({ blocks: new Array(81).fill('minecraft:grass_block[snowy=false]') })
  };
  const r = await tillStep.run(ctx as never, { step: 3, data: { site: { x: 0, y: 64, z: 0 } } });
  t.is(used.length, 81);
  t.is(r.status, 'progress');
});

// ------------------------------------------------------------------------------------------------ F1: the water bucket

type Pos = { x: number; y: number; z: number };
const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };

/**
 * The bucket step over a fake lake east of the yard (water at y 62 in grass, open sky; the cane at (-527, 63, 2208)
 * on its shore): the pockets with the hand as the bridge reports it, `walk` answering each goto, and every call made.
 */
function lakeCtx(opts: { items: { slot: number; name: string; count: number }[]; water?: string[]; walk?: (p: Record<string, unknown>) => Record<string, unknown>; fills?: boolean; chest?: Record<string, number> }) {
  const items = opts.items.map(i => ({ ...i }));
  const water = new Set(opts.water ?? ['-524,62,2210', '-526,62,2208']);
  let held = items[0]?.name ?? '';
  let at: Pos = { x: -549, y: 63, z: 2183 };
  const calls: string[] = [];
  const chest = { x: -547, y: 63, z: 2184 };
  const world = {
    landmarks: { chests: opts.chest ? [chest] : [], farmland: [] }, leash: 96, yard: { ...YARD }, zones: { cane: [{ x: -527, y: 63, z: 2208 }] },
    chestItems: opts.chest ? { [`${chest.x},${chest.y},${chest.z}`]: { ...opts.chest } } : {}
  };
  const block = (x: number, y: number, z: number) => (water.has(`${x},${y},${z}`) ? 'water[level=0]' : y < 62 ? 'dirt' : y === 62 ? 'grass_block' : 'air');
  const ctx = {
    s: { position: at, items, counts: new Map(items.map(i => [i.name, i.count])) }, world, signal: new AbortController().signal,
    progress: (l: string) => { calls.push(`progress ${l}`); }, gain: () => undefined, status: async () => ({ position: at }),
    call: async (m: string, p: Record<string, unknown> = {}) => {
      calls.push(m === 'goto' ? `goto ${p.x},${p.y},${p.z}${p.careful ? ' careful' : ''} with ${held}` : m === 'item.select' ? `select ${String(p.name)}` : m);
      if (m === 'inventory') return { items: items.filter(i => i.count > 0), held: held ? { name: held, count: 1 } : null };
      if (m === 'item.select') { held = String(p.name); return {}; }
      if (m === 'world.findBlocks') return { positions: [...water].map(k => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; }) };
      if (m === 'status') return { position: at };
      if (m === 'world.region') {
        const b = p as unknown as Pos & { width: number; height: number; length: number };
        const out: string[] = [];
        for (let y = b.y; y < b.y + b.height; y++) for (let z = b.z; z < b.z + b.length; z++) for (let x = b.x; x < b.x + b.width; x++) out.push(block(x, y, z));
        return { blocks: out };
      }
      if (m === 'goto') {
        const r = opts.walk?.(p) ?? { arrived: true };
        if (r.arrived) at = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
        return r;
      }
      if (m === 'useOn') {
        if (opts.fills === false) return { used: true, bucket: 'nothing happened (the server did not fill the bucket)' };
        const b = items.find(i => i.name === 'bucket')!;
        b.count--; items.push({ slot: 9, name: 'water_bucket', count: 1 }); held = 'water_bucket';
        return { used: true, bucket: `filled (the water at (${p.x}, ${p.y}, ${p.z}))` };
      }
      throw new Error(`unexpected ${m}`);
    },
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      calls.push(`act ${tool}`);
      if (tool === 'take-from-chest') {
        // a chest's shift-click fills the hotbar from its far end: the bucket in the slot in hand
        items.push({ slot: 8, name: 'water_bucket', count: 1 }); held = 'water_bucket';
        return { ok: true, text: `Took 1 ${String(a.item)}` };
      }
      return { ok: false, text: `unexpected ${tool}` };
    }
  } as unknown as GoalContext;
  return { ctx, calls, held: () => held };
}
const KIT = [{ slot: 0, name: 'bucket', count: 1 }, { slot: 1, name: 'diamond_sword', count: 1 }, { slot: 2, name: 'diamond_hoe', count: 1 }];

test('the water bucket: the lake the safe way, a careful walk to a spot beside it with a harmless hand, the bucket used from there; never the cane\'s water', async (t) => {
  const { waterBucketStep } = await import('../../src/client/brain/farming.js');
  const f = lakeCtx({ items: KIT });
  const r = await waterBucketStep.run(f.ctx, { step: 1, data: {} });
  t.is(r.status, 'done');
  t.regex(r.text, /^filled a water_bucket at \(-524, 62, 2210\) from \(/);
  const walks = f.calls.filter(c => c.startsWith('goto'));
  t.true(walks.length >= 1 && walks.every(w => / careful with diamond_sword$/.test(w)), walks.join(' | '));
  t.false(f.calls.some(c => c.startsWith('act use-item-on-block')), 'not the tool\'s own walk');
  t.false(f.calls.some(c => /-526,62,2208/.test(c)), 'the cane\'s water is not taken');
  t.is(f.held(), 'diamond_sword', 'the filled bucket is not walked with in hand');
});

test('the water bucket: the walks to the water all fail, and it says so (the live miss said "no still water within 64 blocks")', async (t) => {
  const { waterBucketStep } = await import('../../src/client/brain/farming.js');
  // the storage house's door walled off by spilled water: Baritone found no path from there
  const f = lakeCtx({ items: KIT, walk: () => ({ arrived: false, reason: 'done', seconds: 0.4, distance: 41.6, baritone: ['No path found'] }) });
  const r = await waterBucketStep.run(f.ctx, { step: 1, data: {} });
  t.like(r, { status: 'blocked', retryMs: 10 * 60_000 });
  t.regex(r.text, /^the walk to the water failed: \(-524, 62, 2210\): couldn't get to \(-?\d+, 63, \d+\): no path, 41.6 blocks short \(No path found\)/);
  t.notRegex(r.text, /no still water/);
});

test('the water bucket: nothing in sight, or nothing with a safe spot, or a bucket the server never filled: each said as it is', async (t) => {
  const { waterBucketStep } = await import('../../src/client/brain/farming.js');
  const none = lakeCtx({ items: KIT, water: [] });
  t.like(await waterBucketStep.run(none.ctx, { step: 1, data: {} }), { status: 'blocked', text: 'no still water open to the sky in sight outside the yard', retryMs: 20 * 60_000 });
  // only the cane's water and the yard's own: none looked at
  const theirs = lakeCtx({ items: KIT, water: ['-526,62,2208', '-540,62,2190'] });
  t.like(await waterBucketStep.run(theirs.ctx, { step: 1, data: {} }), { status: 'blocked', text: 'no still water open to the sky in sight outside the yard' });
  const dry = lakeCtx({ items: KIT, fills: false });
  const r = await waterBucketStep.run(dry.ctx, { step: 1, data: {} });
  t.like(r, { status: 'blocked' });
  t.regex(r.text, /^the water is in sight, but no bucket filled: \(-524, 62, 2210\): from \(.*\): nothing happened \(the server did not fill the bucket\)/);
  t.is(dry.held(), 'diamond_sword');
});

test('the water bucket: one from the chest (it lands in the slot in hand) or one carried: a harmless item in hand before the next step walks', async (t) => {
  const { waterBucketStep } = await import('../../src/client/brain/farming.js');
  const chest = lakeCtx({ items: [{ slot: 1, name: 'diamond_sword', count: 1 }], chest: { water_bucket: 1 } });
  t.deepEqual(await waterBucketStep.run(chest.ctx, { step: 1, data: {} }), { status: 'done', text: 'a water bucket from the chest' });
  t.is(chest.held(), 'diamond_sword');
  const carried = lakeCtx({ items: [{ slot: 0, name: 'water_bucket', count: 1 }, { slot: 1, name: 'iron_pickaxe', count: 1 }] });
  t.deepEqual(await waterBucketStep.run(carried.ctx, { step: 1, data: {} }), { status: 'done', text: 'a water bucket in hand' });
  t.is(carried.held(), 'iron_pickaxe');
});

test('the plot\'s pour: the walks to level and dig go with a harmless hand, and a pour that did not take leaves none in it', async (t) => {
  const { waterStep } = await import('../../src/client/brain/farming.js');
  const site = { x: 0, y: 64, z: 0 };
  const items = [{ slot: 0, name: 'water_bucket', count: 1 }, { slot: 1, name: 'diamond_sword', count: 1 }];
  let held = 'water_bucket';
  const did: string[] = [];
  const ctx = {
    signal: new AbortController().signal,
    call: async (m: string, p: Record<string, unknown> = {}) => {
      if (m === 'inventory') return { items, held: { name: held, count: 1 } };
      if (m === 'item.select') { held = String(p.name); did.push(`select ${held}`); return {}; }
      if (m === 'world.region') return { blocks: ['grass_block'] };
      throw new Error(`unexpected ${m}`);
    },
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      did.push(`${tool} with ${held}`);
      if (tool === 'level-area') return { ok: true, text: 'Now level' };
      if (tool === 'use-item-on-block') { held = String(a.item); return { ok: true, text: 'Used water_bucket on dirt at (4, 63, 4): nothing happened (the server did not pour the water_bucket)' }; }
      return { ok: true, text: 'ok' };
    }
  } as unknown as GoalContext;
  const r = await waterStep.run(ctx, { step: 2, data: { site } });
  t.is(r.status, 'progress');
  t.deepEqual(did, ['select diamond_sword', 'level-area with diamond_sword', 'dig-block with diamond_sword', 'use-item-on-block with diamond_sword', 'select diamond_sword']);
  t.is(held, 'diamond_sword');
});

test('the plot\'s pour that took: the emptied bucket is not left in hand either (its use along the look takes up the first source it meets)', async (t) => {
  const { waterStep } = await import('../../src/client/brain/farming.js');
  const site = { x: 0, y: 64, z: 0 };
  const items = [{ slot: 0, name: 'water_bucket', count: 1 }, { slot: 1, name: 'diamond_sword', count: 1 }];
  let held = 'water_bucket';
  let poured = false;
  const did: string[] = [];
  const ctx = {
    signal: new AbortController().signal,
    call: async (m: string, p: Record<string, unknown> = {}) => {
      if (m === 'inventory') return { items, held: { name: held, count: 1 } };
      if (m === 'item.select') { held = String(p.name); did.push(`select ${held}`); return {}; }
      // the middle cell (4, 64, 4): air until the pour, then the water
      if (m === 'world.region') return { blocks: [poured ? 'water[level=0]' : 'air'] };
      throw new Error(`unexpected ${m}`);
    },
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      did.push(`${tool} with ${held}`);
      if (tool === 'level-area') return { ok: true, text: 'Now level' };
      if (tool === 'use-item-on-block') {
        poured = true; items[0].name = 'bucket'; held = 'bucket';
        return { ok: true, text: `Used ${String(a.item)} on dirt at (4, 63, 4): poured at (4, 64, 4)` };
      }
      return { ok: true, text: 'ok' };
    }
  } as unknown as GoalContext;
  const r = await waterStep.run(ctx, { step: 2, data: { site } });
  t.like(r, { status: 'done', text: 'water at (4, 64, 4)' });
  t.deepEqual(did, ['select diamond_sword', 'level-area with diamond_sword', 'use-item-on-block with diamond_sword', 'select diamond_sword']);
  t.is(held, 'diamond_sword');
});
