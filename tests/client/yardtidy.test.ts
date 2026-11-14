import test from 'ava';
import { strayCells, tidyGoal, yardFence, type YardFence } from '../../src/client/brain/tidy.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import type { Pos } from '../../src/client/brain/memory.js';
import type { ClientRuntime } from '../../src/client/tools.js';
import type { Cluster } from '../../src/client/survey.js';
import { liveWorld, lookAt } from '../helpers/homestead.js';

/**
 * The tidy round and scaffold against the yard fence, on the live homestead's north fence (Nov 13): a cobblestone
 * stair over the north gate (-549, 63, 2119) kept the gateway a block high and let mobs walk over the fence, and the
 * round left it be every day because it touched the gate.
 */

type Cell = { x: number; y: number; z: number; block: string };
const key = (p: Pos) => `${p.x},${p.y},${p.z}`;
const cluster = (cells: Cell[]): Cluster => ({
  min: { x: Math.min(...cells.map(c => c.x)), y: Math.min(...cells.map(c => c.y)), z: Math.min(...cells.map(c => c.z)) },
  max: { x: Math.max(...cells.map(c => c.x)), y: Math.max(...cells.map(c => c.y)), z: Math.max(...cells.map(c => c.z)) },
  blocks: cells.length,
  kinds: cells.reduce<Record<string, number>>((k, c) => ({ ...k, [c.block]: (k[c.block] ?? 0) + 1 }), {}),
  cells
});
const cobble = (ps: [number, number, number][]): Cell[] => ps.map(([x, y, z]) => ({ x, y, z, block: 'cobblestone' }));
const keys = (ps: Pos[]) => ps.map(key);

const RING = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
const POST = 'oak_fence[east=true,north=true,south=false,waterlogged=false,west=true]';
const GATE = '-549,63,2119';

/**
 * The north fence as it stands, of the bot's record: its posts at y 63, the gate, the torches on every sixth post, and
 * the lawn torch at (-547, 63, 2123) that was gone. `stand` is what the world holds there now.
 */
function northFence(): { built: Set<string>; stand: Map<string, string> } {
  const stand = new Map<string, string>();
  for (let x = RING.x1; x <= RING.x2; x++) stand.set(`${x},63,2119`, POST);
  stand.set(GATE, 'oak_fence_gate[facing=north,in_wall=false,open=false,powered=false]');
  for (const x of [-565, -559, -553, -547, -541, -535, -533]) stand.set(`${x},64,2119`, 'torch');
  stand.set('-547,63,2123', 'air');
  return { built: new Set(stand.keys()), stand };
}
const lookOf = (stand: Map<string, string>, built: Set<string>): YardFence => {
  const at = (p: Pos) => stand.get(key(p)) ?? 'air';
  const pos = [...built].map(k => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; });
  return { ring: RING, fence: yardFence(pos, at, RING), at };
};

// the stair: a step inside, one on the gate, a step outside
const STAIR = cobble([[-549, 63, 2120], [-549, 64, 2119], [-549, 63, 2118]]);
// the whole of it as the maintenance run copied it: the stair, cobblestone along the fence east of the gate (on posts,
// on the torch on the post at (-547, 63, 2119)) and pillars inside, up to y 67
const NORTH = cobble([
  ...[[-549, 2118], [-549, 2120], [-547, 2120], [-546, 2120], [-543, 2120], [-548, 2121], [-547, 2121], [-543, 2121], [-548, 2122]].map(([x, z]) => [x, 63, z] as [number, number, number]),
  ...[[-549, 2119], [-548, 2119], [-546, 2119], [-545, 2120], [-543, 2120]].map(([x, z]) => [x, 64, z] as [number, number, number]),
  ...[[-547, 2119], [-546, 2119], [-545, 2119], [-545, 2120], [-544, 2120]].map(([x, z]) => [x, 65, z] as [number, number, number]),
  [-548, 66, 2120], [-547, 67, 2120]
]);

test('yardFence: the ring\'s posts, its gate and the torches on them as they stand; a pen\'s fence, a post gone or replaced, a lone torch are none', t => {
  const { built, stand } = northFence();
  stand.set('-560,63,2119', 'air'); // a post gone
  stand.set('-556,63,2119', 'cobblestone'); // another block in a post's place
  stand.set('-553,63,2119', 'air'); // the post under a torch gone: the torch is left alone on air (it would drop)
  stand.set('-555,63,2160', POST); built.add('-555,63,2160'); // the cow pen's fence, inside the yard
  stand.set('-540,63,2119', POST); built.delete('-540,63,2119'); // a post that is not the bot's
  const fence = lookOf(stand, built).fence;
  t.true(fence.has(GATE) && fence.has('-548,63,2119') && fence.has('-547,64,2119'));
  for (const k of ['-560,63,2119', '-556,63,2119', '-553,64,2119', '-555,63,2160', '-540,63,2119', '-547,63,2123']) t.false(fence.has(k), k);
});

test('strayCells: the stair over the north gate is cleared, top down; without the fence\'s look it is left be, as before', t => {
  const { built, stand } = northFence();
  const got = strayCells([cluster(STAIR)], 62, built, lookOf(stand, built));
  t.is(key(got[0]), '-549,64,2119');
  t.deepEqual(keys(got.slice(1)).sort(), ['-549,63,2118', '-549,63,2120']);
  t.true(got.every(p => p.fence));
  t.deepEqual(strayCells([cluster(STAIR)], 62, built), []);
});

test('strayCells: the north gate\'s 21, by the torch on a post and the lawn torch that was gone, come down; as big away from the fence, or over 32 by it, they stay', t => {
  const { built, stand } = northFence();
  const look = lookOf(stand, built);
  const got = strayCells([cluster(NORTH)], 62, built, look);
  t.is(got.length, 21);
  t.deepEqual(got[0], { x: -547, y: 67, z: 2120, fence: true });
  // with the lawn torch standing it is a build of the bot's by the pillar: left be
  const lit = new Map(stand).set('-547,63,2123', 'torch');
  t.deepEqual(strayCells([cluster(NORTH)], 62, built, lookOf(lit, built)), []);
  // the torch on the post counted as any built block (not the fence's): left be
  t.deepEqual(strayCells([cluster(NORTH)], 62, built, { ...look, fence: new Set([...look.fence].filter(k => k !== '-547,64,2119')) }), []);
  // the same 21 out on the lawn, by nothing: too many for a stray cluster
  const lawn = NORTH.map(c => ({ ...c, z: c.z + 40 }));
  t.deepEqual(strayCells([cluster(lawn)], 62, built, look), []);
  // over FENCE_CLUSTER by the fence: left be
  const more = [...NORTH, ...cobble(Array.from({ length: 12 }, (_, i) => [-540 + (i % 6), 63 + Math.floor(i / 6), 2120] as [number, number, number]))];
  t.deepEqual(strayCells([cluster(more)], 62, built, look), []);
});

test('strayCells: against the fence, any other built block still keeps the cluster; one gone, or in the ground under it, does not', t => {
  const { built, stand } = northFence();
  // a house's wall by the step inside
  const walled = new Set([...built, '-550,64,2121']);
  const wall = new Map(stand).set('-550,64,2121', 'oak_planks');
  t.deepEqual(strayCells([cluster(STAIR)], 62, walled, lookOf(wall, walled)), []);
  // that block gone: nothing there to keep
  t.is(strayCells([cluster(STAIR)], 62, walled, lookOf(new Map(stand).set('-550,64,2121', 'air'), walled)).length, 3);
  // the repair round's fill under the posts, the bot's own, at the yard's ground: the steps stand on it
  const filled = new Set([...built, '-549,62,2120', '-548,62,2118', '-550,61,2118']);
  const ground = new Map(stand).set('-549,62,2120', 'dirt').set('-548,62,2118', 'cobblestone').set('-550,61,2118', 'cobblestone');
  t.is(strayCells([cluster(STAIR)], 62, filled, lookOf(ground, filled)).length, 3);
});

test('strayCells: against the fence, a block something stands on, hangs from or is hung on keeps its cluster (a lamp post, not scaffold)', t => {
  const { built, stand } = northFence();
  const held = (cell: string, block: string) => strayCells([cluster(STAIR)], 62, built, lookOf(new Map(stand).set(cell, block), built));
  t.deepEqual(held('-549,64,2120', 'torch'), []); // on the step inside (not the bot's: no record of it)
  t.deepEqual(held('-549,63,2121', 'wall_torch[facing=south]'), []); // on its side
  t.deepEqual(held('-549,62,2118', 'lantern[hanging=true]'), []); // under the step outside
  t.deepEqual(held('-549,65,2119', 'oak_sign[rotation=0]'), []); // on the block on the gate
  // grass by it, or a torch on the post beside it: nothing of it is held
  t.is(held('-550,63,2120', 'short_grass').length, 3);
});

test('strayCells: a block in the fence\'s own line where a post is missing is never dug; the way over it is', t => {
  const { built, stand } = northFence();
  // the post at (-560, 63, 2119) gone from the record and the world, a cobblestone in its place, a step on it and one inside
  built.delete('-560,63,2119');
  stand.delete('-560,63,2119');
  const gap = cobble([[-560, 63, 2119], [-560, 64, 2119], [-560, 63, 2120]]);
  t.deepEqual(keys(strayCells([cluster(gap)], 62, built, lookOf(stand, built))), ['-560,64,2119', '-560,63,2120']);
});

test('strayCells: by the fence but reaching two outside the ring, the cluster is left be, as before', t => {
  const { built, stand } = northFence();
  const far = [...STAIR, ...cobble([[-549, 63, 2117]])];
  t.deepEqual(strayCells([cluster(far)], 62, built, lookOf(stand, built)), []);
  // one outside on the other side of the ring (the east fence at x -533): fine
  const east = cobble([[-532, 63, 2120], [-533, 64, 2120], [-534, 63, 2120]]);
  built.add('-533,63,2120');
  stand.set('-533,63,2120', POST);
  t.is(strayCells([cluster(east)], 62, built, lookOf(stand, built)).length, 3);
});

test('strayCells: away from the fence the rule is as it was: a built block by it keeps it, even one gone; small and by nothing it goes', t => {
  const { built, stand } = northFence();
  const look = lookOf(stand, built);
  // a pillar by the lawn torch that is gone: the record keeps it, as before (that rule is only lifted by the fence)
  const pillar = cobble([[-548, 63, 2124], [-548, 64, 2124]]);
  t.deepEqual(strayCells([cluster(pillar)], 62, built, look), []);
  const lone = cobble([[-550, 63, 2160], [-550, 64, 2160]]);
  const got = strayCells([cluster(lone)], 62, built, look);
  t.deepEqual(got, [{ x: -550, y: 64, z: 2160 }, { x: -550, y: 63, z: 2160 }]);
  // not a scaffold kind: never, by the fence or not
  t.deepEqual(strayCells([cluster(STAIR.map(c => ({ ...c, block: 'oak_planks' })))], 62, built, look), []);
});

/**
 * The round itself on the live homestead: the world read round the yard (grass at the yard's ground, the north fence,
 * the stair over its gate), the bot's record of that fence, every dig by hand on the spot.
 */
function liveRound(opts: { fenceMove?: boolean } = {}) {
  const { built, stand } = northFence();
  for (const c of STAIR) stand.set(key(c), c.block);
  const world = liveWorld();
  if (opts.fenceMove) world.fenceMove = { side: 'north', old: { ...RING } };
  const digs: Record<string, unknown>[] = [];
  const rt = {
    builtNear: (c: Pos, r: number) => [...built].map(k => { const [x, y, z] = k.split(',').map(Number); return { at: { x, y, z } }; })
      .filter(b => Math.hypot(b.at.x - c.x, b.at.z - c.z) <= r && Math.abs(b.at.y - c.y) <= r)
  } as unknown as ClientRuntime;
  const ctx = {
    s: lookAt([], 9000), world, signal: new AbortController().signal, progress: () => undefined, gain: () => undefined,
    status: async () => ({}) as never, act: async () => ({ ok: false, text: 'no' }),
    call: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      if (method === 'world.region') {
        const b = params as { x: number; y: number; z: number; width: number; height: number; length: number };
        const blocks: string[] = [];
        for (let y = b.y; y < b.y + b.height; y++) for (let z = b.z; z < b.z + b.length; z++) for (let x = b.x; x < b.x + b.width; x++) {
          blocks.push(stand.get(`${x},${y},${z}`) ?? (y < 62 ? 'dirt' : y === 62 ? 'grass_block[snowy=false]' : 'air'));
        }
        return { blocks } as T;
      }
      if (method === 'dig.here') { digs.push(params); stand.set(key(params as unknown as Pos), 'air'); return { dug: true } as T; }
      throw new Error(`unexpected call ${method}`);
    }
  } as unknown as GoalContext;
  return { run: () => tidyGoal(rt).run(ctx), digs, stand };
}

test('the tidy round digs the stair off the north gate, top down, by hand where it stands, and nothing of the fence', async t => {
  const r = liveRound();
  const text = await r.run();
  t.is(text, 'cleared 3 of 3 stray block(s) (3 against the yard fence)');
  const dug = r.digs.map(d => key(d as unknown as Pos));
  t.is(dug[0], '-549,64,2119');
  t.deepEqual(dug.slice(1).sort(), ['-549,63,2118', '-549,63,2120']);
  // the place and a timeout only go to the bridge
  t.deepEqual(Object.keys(r.digs[0]).sort(), ['timeoutMs', 'x', 'y', 'z']);
  t.regex(r.stand.get(GATE)!, /^oak_fence_gate/);
  t.is(r.stand.get('-547,64,2119'), 'torch');
});

test('the tidy round leaves scaffold by the fence be while the fence is being moved out (its old side comes down)', async t => {
  const r = liveRound({ fenceMove: true });
  t.is(await r.run(), 'the lawn is clear');
  t.deepEqual(r.digs, []);
});
