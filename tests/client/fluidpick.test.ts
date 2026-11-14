import test from 'ava';
import { aroundBox, fillAt, holdHarmless, isHazard, lakeSources, openToSky, standSpots, SKY, type Box, type P, type SourceVerdict } from '../../src/client/brain/fluidpick.js';
import type { GoalContext } from '../../src/client/brain/goals.js';

/** The blocks round a source at (0, 62, 0) as aroundBox reads them: grass ground (top y 62 is the source's level). */
function around(set: (x: number, y: number, z: number) => string | undefined) {
  const t = { x: 0, y: 62, z: 0 };
  const box = aroundBox(t);
  const blocks: (string | null)[] = [];
  for (let y = 0; y < box.height; y++) for (let z = 0; z < box.length; z++) for (let x = 0; x < box.width; x++) {
    const wx = box.x + x, wy = box.y + y, wz = box.z + z;
    blocks.push(set(wx, wy, wz) ?? (wy <= 62 ? 'minecraft:grass_block' : 'minecraft:air'));
  }
  return { t, box, blocks };
}
const k = (p: P) => `${p.x},${p.z}`;

test('a lava pool open to the sky: spots on solid ground, two or more from it, none next to lava, nearest the bot first', (t) => {
  // a 3 x 3 pool round the source, one block deep
  const { t: src, box, blocks } = around((x, y, z) => (y === 62 && Math.abs(x) <= 1 && Math.abs(z) <= 1 ? 'minecraft:lava[level=0]' : undefined));
  const spots = standSpots(blocks, box, src, { x: -6, y: 63, z: 0 }, 2);
  t.true(spots.length > 0);
  for (const s of spots) {
    t.true(Math.max(Math.abs(s.x), Math.abs(s.z)) >= 2, `${k(s)} is 2 or more from the source`);
    // the pool's edge is at 1: a spot at 2 would have lava beside it, so the nearest are at 3
    t.true(Math.max(Math.abs(s.x), Math.abs(s.z)) >= 3, `${k(s)} has no lava beside it`);
    t.is(s.y, 63);
  }
  t.is(spots[0].x < 0, true, 'the side the bot comes from first');
});

test('no spot when the only ground in reach is next to lava, or the line of sight is walled off', (t) => {
  // lava everywhere round it but a ring of grass at distance 2: every spot there has lava beside it
  const lavaSea = around((x, y, z) => (y === 62 && Math.max(Math.abs(x), Math.abs(z)) !== 2 ? 'minecraft:lava[level=0]' : undefined));
  t.deepEqual(standSpots(lavaSea.blocks, lavaSea.box, lavaSea.t, { x: 0, y: 63, z: -5 }, 2).filter(s => Math.max(Math.abs(s.x), Math.abs(s.z)) < 4), []);
  // a wall of stone two high round the source at distance 1: nothing sees it
  const walled = around((x, y, z) => (Math.max(Math.abs(x), Math.abs(z)) === 1 && y >= 63 && y <= 65 ? 'minecraft:stone' : undefined));
  t.deepEqual(standSpots(walled.blocks, walled.box, walled.t, { x: 0, y: 63, z: -5 }, 2), []);
});

test('open to the sky: every block above it air, all the way up; a cave roof or unknown is no', (t) => {
  t.true(openToSky(Array(SKY).fill('minecraft:air')));
  t.false(openToSky([...Array(10).fill('minecraft:air'), 'minecraft:stone', ...Array(SKY - 11).fill('minecraft:air')]));
  t.false(openToSky([...Array(SKY - 1).fill('minecraft:air'), null]));
  t.false(openToSky(Array(5).fill('minecraft:air')));
  // a tree over a surface pool is no cave
  t.true(openToSky([...Array(6).fill('minecraft:air'), 'minecraft:oak_leaves[distance=1,persistent=false]', 'minecraft:vine[east=true]', ...Array(SKY - 8).fill('minecraft:air')]));
  t.false(openToSky([...Array(6).fill('minecraft:air'), 'minecraft:oak_log[axis=y]', ...Array(SKY - 7).fill('minecraft:air')]));
});

test('water: one from the source will do', (t) => {
  const { t: src, box, blocks } = around((x, y, z) => (y === 62 && x === 0 && z === 0 ? 'minecraft:water[level=0]' : undefined));
  const spots = standSpots(blocks, box as Box, src, { x: 0, y: 63, z: -5 }, 1);
  t.true(spots.some(s => Math.max(Math.abs(s.x), Math.abs(s.z)) === 1));
});

test('the lava that killed it: 40 under the yard, under a roof: refused, and nothing is walked to', async (t) => {
  const { judgeSource } = await import('../../src/client/brain/fluidpick.js');
  const calls: string[] = [];
  const io = {
    call: async <T>(method: string, q: Record<string, unknown> = {}): Promise<T> => {
      calls.push(method);
      if (method !== 'world.region') throw new Error(`unexpected ${method}`);
      const p = q as Record<string, number>;
      const n = p.width * p.height * p.length;
      // the source itself, then (if asked) the column over it: a cave, stone 10 up
      if (n === 1) return { blocks: ['minecraft:lava[level=0]'] } as T;
      return { blocks: Array.from({ length: n }, (_, i) => (i === 10 ? 'minecraft:stone' : 'minecraft:air')) } as T;
    }
  };
  const deep = await judgeSource(io, { x: -537, y: 22, z: 2162 }, 'lava', 62, { x: -549, y: 63, z: 2183 });
  t.regex(deep.why, /from the ground level/);
  t.deepEqual(deep.spots, []);
  // near the ground but in a cave: refused too
  const cave = await judgeSource(io, { x: -537, y: 60, z: 2162 }, 'lava', 62, { x: -549, y: 63, z: 2183 });
  t.regex(cave.why, /not open to the sky/);
  t.false(calls.includes('goto'));
});

test('tall grass on the line from the eye to the water: still a spot, and the grass is what it breaks first', async (t) => {
  const { sightLine } = await import('../../src/client/brain/fluidpick.js');
  // the lake source at (0, 62, 0); the shore spot two east, tall grass on the cell between, as at the west fence
  const { t: src, box, blocks } = around((x, y, z) => (y === 62 && x <= 0 && z === 0 ? 'minecraft:water[level=0]'
    : x === 1 && z === 0 && y === 63 ? 'minecraft:tall_grass[half=lower]' : x === 1 && z === 0 && y === 64 ? 'minecraft:tall_grass[half=upper]' : undefined));
  const look = (x: number, y: number, z: number) => {
    const ix = x - box.x, iy = y - box.y, iz = z - box.z;
    return ix < 0 || iy < 0 || iz < 0 || ix >= box.width || iy >= box.height || iz >= box.length ? undefined : blocks[ix + iz * box.width + iy * box.width * box.length];
  };
  const spot = { x: 2, y: 63, z: 0 };
  t.true(standSpots(blocks, box, src, { x: 5, y: 63, z: 0 }, 1).some(s => s.x === spot.x && s.z === spot.z));
  // both halves of the tall grass lie on the line (breaking either takes the plant)
  t.deepEqual(sightLine(look, spot, src), [{ x: 1, y: 64, z: 0 }, { x: 1, y: 63, z: 0 }]);
});

test('holdHarmless: a sword before a pickaxe in hand (never the full bucket); none carried, nothing selected; armour slots do not count', async (t) => {
  const run = async (items: { name: string; slot: number; count: number }[]) => {
    const calls: string[] = [];
    const ctx = { call: (async (m: string, p: Record<string, unknown> = {}) => { calls.push(`${m} ${String(p.name ?? '')}`.trim()); return m === 'inventory' ? { items } : {}; }) as GoalContext['call'] };
    return { name: await holdHarmless(ctx), calls };
  };
  const a = await run([{ slot: 0, name: 'water_bucket', count: 1 }, { slot: 3, name: 'diamond_pickaxe', count: 1 }, { slot: 7, name: 'diamond_sword', count: 1 }]);
  t.is(a.name, 'diamond_sword');
  t.deepEqual(a.calls, ['inventory', 'item.select diamond_sword']);
  const b = await run([{ slot: 0, name: 'lava_bucket', count: 1 }, { slot: 3, name: 'iron_pickaxe', count: 1 }]);
  t.is(b.name, 'iron_pickaxe');
  const c = await run([{ slot: 0, name: 'water_bucket', count: 1 }, { slot: 38, name: 'diamond_sword', count: 1 }]);
  t.is(c.name, undefined);
  t.deepEqual(c.calls, ['inventory']);
});

// ------------------------------------------------------------------------------------------------ F1: buckets in hand

test('isHazard: every full bucket but milk, and the fire starters (the bridge\'s Hazards rule); never the empty bucket', (t) => {
  for (const n of ['water_bucket', 'lava_bucket', 'powder_snow_bucket', 'axolotl_bucket', 'sulfur_cube_bucket', 'flint_and_steel', 'fire_charge', 'minecraft:lava_bucket']) t.true(isHazard(n), n);
  for (const n of ['bucket', 'milk_bucket', 'diamond_sword', 'flint', '', undefined, null]) t.false(isHazard(n), String(n));
});

/** holdHarmless over an inventory reply with the hand in it (`held`, as the bridge sends it), the calls it made. */
const harmless = async (items: { name: string; slot: number; count: number }[], held: string | null) => {
  const calls: string[] = [];
  const ctx = { call: (async (m: string, p: Record<string, unknown> = {}) => { calls.push(`${m} ${String(p.name ?? '')}`.trim()); return m === 'inventory' ? { items, held: held ? { name: held, count: 1 } : null } : {}; }) as GoalContext['call'] };
  return { name: await holdHarmless(ctx), calls };
};

test('holdHarmless: a harmless hand the bridge reports is kept, no select; a full or an empty bucket in hand is put away for a sword', async (t) => {
  const kit = [{ slot: 0, name: 'diamond_pickaxe', count: 1 }, { slot: 1, name: 'diamond_sword', count: 1 }, { slot: 2, name: 'lava_bucket', count: 1 }, { slot: 3, name: 'bucket', count: 2 }];
  t.deepEqual(await harmless(kit, 'diamond_pickaxe'), { name: 'diamond_pickaxe', calls: ['inventory'] });
  t.deepEqual(await harmless(kit, null), { name: undefined, calls: ['inventory'] }, 'an empty hand uses nothing');
  t.deepEqual(await harmless(kit, 'lava_bucket'), { name: 'diamond_sword', calls: ['inventory', 'item.select diamond_sword'] });
  // the empty one too: its use along the look takes up the first source it meets (the plot's water, by a door)
  t.deepEqual(await harmless(kit, 'bucket'), { name: 'diamond_sword', calls: ['inventory', 'item.select diamond_sword'] });
  t.deepEqual(await harmless(kit, 'flint_and_steel'), { name: 'diamond_sword', calls: ['inventory', 'item.select diamond_sword'] });
});

test('holdHarmless: a copper sword is one (26.3); with no sword or pickaxe, something a use does nothing with: never food or a block', async (t) => {
  t.is((await harmless([{ slot: 0, name: 'water_bucket', count: 1 }, { slot: 4, name: 'copper_sword', count: 1 }], 'water_bucket')).name, 'copper_sword');
  const bare = [{ slot: 0, name: 'water_bucket', count: 1 }, { slot: 1, name: 'bread', count: 9 }, { slot: 2, name: 'cobblestone', count: 30 }, { slot: 3, name: 'iron_ingot', count: 4 }];
  t.deepEqual(await harmless(bare, 'water_bucket'), { name: 'iron_ingot', calls: ['inventory', 'item.select iron_ingot'] });
  t.deepEqual(await harmless(bare.filter(i => i.name !== 'iron_ingot'), 'water_bucket'), { name: undefined, calls: ['inventory'] });
});

test('holdHarmless: never string, which places a tripwire (it is the tripwire\'s block item): a stick before it, and string alone is nothing to hold', async (t) => {
  const pockets = [{ slot: 0, name: 'water_bucket', count: 1 }, { slot: 1, name: 'string', count: 5 }, { slot: 2, name: 'stick', count: 3 }];
  t.deepEqual(await harmless(pockets, 'water_bucket'), { name: 'stick', calls: ['inventory', 'item.select stick'] });
  t.deepEqual(await harmless(pockets.filter(i => i.name !== 'stick'), 'water_bucket'), { name: undefined, calls: ['inventory'] });
});

/**
 * A fake for fillAt: the pockets (with the hand, as the bridge reports it), the walks (`walk` answers each goto), and
 * every call made, with the hand at each walk. `fills` false: the server fills nothing; 'unconfirmed': the client
 * guesses the fill (its inventory shows the water bucket) and the server never says.
 */
function fillFake(walk: (p: Record<string, unknown>) => Record<string, unknown> | Error, fills: boolean | 'unconfirmed' = true) {
  const items = [{ slot: 0, name: 'diamond_sword', count: 1 }, { slot: 1, name: 'bucket', count: 1 }, { slot: 2, name: 'lava_bucket', count: 1 }];
  let held = 'lava_bucket'; // a lava bucket out of the chest, in hand
  let at: P = { x: 0, y: 63, z: 9 };
  const calls: string[] = [];
  const ctx = {
    signal: new AbortController().signal,
    call: (async (m: string, p: Record<string, unknown> = {}) => {
      calls.push(m === 'goto' ? `goto with ${held}` : m === 'item.select' ? `select ${String(p.name)}` : m);
      if (m === 'inventory') return { items: items.filter(i => i.count > 0), held: { name: held, count: 1 } };
      if (m === 'item.select') { held = String(p.name); return {}; }
      if (m === 'goto') { const r = walk(p); if (r instanceof Error) throw r; if (r.arrived) at = { x: Number(p.x), y: Number(p.y), z: Number(p.z) }; return r; }
      if (m === 'status') return { position: at };
      if (m === 'world.region') {
        // the lake's source at (0, 62, 0) in grass, open sky
        const out: string[] = [];
        for (let y = Number(p.y); y < Number(p.y) + Number(p.height); y++) for (let z = Number(p.z); z < Number(p.z) + Number(p.length); z++) for (let x = Number(p.x); x < Number(p.x) + Number(p.width); x++) {
          out.push(!x && y === 62 && !z ? 'water[level=0]' : y < 62 ? 'dirt' : y === 62 ? 'grass_block' : 'air');
        }
        return { blocks: out };
      }
      if (m === 'useOn') {
        if (!fills) return { used: true, bucket: 'nothing happened (the server did not fill the bucket; the client had guessed water_bucket)' };
        items.find(i => i.name === 'bucket')!.count--; items.push({ slot: 5, name: 'water_bucket', count: 1 }); held = 'water_bucket';
        if (fills === 'unconfirmed') return { used: true, bucket: 'nothing confirmed (no word from the server within 2 s; the client guessed water_bucket)' };
        return { used: true, bucket: 'filled' };
      }
      throw new Error(`unexpected ${m}`);
    }) as GoalContext['call']
  } as unknown as GoalContext;
  return { ctx, calls, held: () => held };
}
const LAKE: SourceVerdict = { at: { x: 0, y: 62, z: 0 }, why: '', spots: [{ x: 1, y: 63, z: 0 }, { x: -1, y: 63, z: 0 }] };

test('fillAt: a harmless item in hand for every walk (a lava bucket from the chest was in it), and after the fill', async (t) => {
  const f = fillFake(() => ({ arrived: true }));
  const r = await fillAt(f.ctx, LAKE, 'water');
  t.like(r, { ok: true, reached: 1 });
  t.true(f.calls.filter(c => c.startsWith('goto')).every(c => c === 'goto with diamond_sword'), f.calls.join(' | '));
  t.is(f.held(), 'diamond_sword', 'never walked on with the full bucket in hand');
});

test('fillAt: a walk that fails says why (Baritone\'s no path, how far short; a time-out), and that it got to no spot', async (t) => {
  const noPath = fillFake(() => ({ arrived: false, reason: 'done', seconds: 1.2, distance: 40.2, at: { x: 0, y: 63, z: 49 }, baritone: ['No path found to goal (open set size 0)'] }));
  const r = await fillAt(noPath.ctx, LAKE, 'water');
  t.like(r, { ok: false, reached: 0 });
  t.is(r.text, "couldn't get to (1, 63, 0): no path, 40.2 blocks short (No path found to goal (open set size 0)); couldn't get to (-1, 63, 0): no path, 40.2 blocks short (No path found to goal (open set size 0))");
  const slow = fillFake(() => ({ arrived: false, reason: 'timeout', seconds: 60 }));
  t.regex((await fillAt(slow.ctx, LAKE, 'water')).text, /^couldn't get to \(1, 63, 0\): timed out after 60s;/);
  const thrown = fillFake(() => new Error('bridge timeout: goto'));
  t.regex((await fillAt(thrown.ctx, LAKE, 'water')).text, /^couldn't get to \(1, 63, 0\): bridge timeout: goto;/);
});

test('fillAt: a fill the server did not make says the server\'s word, and the empty bucket is not left in hand', async (t) => {
  const f = fillFake(() => ({ arrived: true }), false);
  const r = await fillAt(f.ctx, LAKE, 'water');
  t.like(r, { ok: false, reached: 2 });
  t.regex(r.text, /^from \(1, 63, 0\): nothing happened \(the server did not fill the bucket; the client had guessed water_bucket\)/);
  t.is(f.held(), 'diamond_sword');
});

test('fillAt: a fill the server never confirmed is no fill, though the client\'s inventory shows the bucket full; no other spot is tried with it', async (t) => {
  const f = fillFake(() => ({ arrived: true }), 'unconfirmed');
  const r = await fillAt(f.ctx, LAKE, 'water');
  t.like(r, { ok: false, reached: 1 });
  t.is(r.text, 'from (1, 63, 0): nothing confirmed (no word from the server within 2 s; the client guessed water_bucket)');
  t.is(f.calls.filter(c => c.startsWith('goto')).length, 1, f.calls.join(' | '));
  t.is(f.held(), 'diamond_sword');
});

test('lakeSources: still water outside the yard only, and never beside the ground a cane stands on; those are not even judged', async (t) => {
  // the lake east of the yard at y 62 (grass round it, open sky), a cane at (-527, 63, 2208) on its shore
  const water = new Set(['-526,62,2208', '-524,62,2210', '-540,62,2190']);
  const block = (x: number, y: number, z: number) => (water.has(`${x},${y},${z}`) ? 'water[level=0]' : y < 62 ? 'dirt' : y === 62 ? 'grass_block' : 'air');
  const judged: string[] = [];
  const ctx = {
    s: { position: { x: -530, y: 63, z: 2200 } },
    world: { landmarks: { chests: [], farmland: [] }, leash: 96, yard: { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 }, zones: { cane: [{ x: -527, y: 63, z: 2208 }] } },
    call: (async (m: string, p: Record<string, unknown> = {}) => {
      if (m === 'world.findBlocks') return { positions: [...water].map(k => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; }) };
      if (m === 'status') return { position: { x: -530, y: 63, z: 2200 } };
      if (m === 'world.region') {
        const b = p as { x: number; y: number; z: number; width: number; height: number; length: number };
        if (b.width === 1 && b.height === 1) judged.push(`${b.x},${b.y},${b.z}`);
        const out: string[] = [];
        for (let y = b.y; y < b.y + b.height; y++) for (let z = b.z; z < b.z + b.length; z++) for (let x = b.x; x < b.x + b.width; x++) out.push(block(x, y, z));
        return { blocks: out };
      }
      throw new Error(`unexpected ${m}`);
    }) as GoalContext['call']
  } as unknown as Parameters<typeof lakeSources>[0];
  const got = await lakeSources(ctx);
  t.deepEqual(got.map(v => `${v.at.x},${v.at.y},${v.at.z}`), ['-524,62,2210']);
  t.is(got[0].why, '');
  // (-540, 62, 2190) is in the yard, (-526, 62, 2208) the cane's: neither looked at
  t.deepEqual(judged, ['-524,62,2210']);
});
