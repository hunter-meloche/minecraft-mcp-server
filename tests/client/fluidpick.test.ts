import test from 'ava';
import { aroundBox, holdHarmless, openToSky, standSpots, SKY, type Box, type P } from '../../src/client/brain/fluidpick.js';
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
