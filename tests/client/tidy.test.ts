import test from 'ava';
import { baseline, doorways, standSpots, strays, tidyBox } from '../../src/client/structures/tidy.js';
import { doorwayCells, portalFence, strayCells, tidyGoal, yardFence, type YardFence } from '../../src/client/brain/tidy.js';
import { yardRing } from '../../src/client/brain/fence.js';
import type { Pos } from '../../src/client/brain/memory.js';
import { ringReady } from '../../src/client/brain/villagerwalk.js';
import type { Cluster } from '../../src/client/survey.js';
import type { ClientRuntime } from '../../src/client/tools.js';
import { yard, type Pasture } from '../helpers/pasture.js';

// a 5x4x1 slice (x 0..4, y 64..67, z 0): readBox order is x fastest, then z, then y
const box = { x: 0, y: 64, z: 0, width: 5, height: 4, length: 1 };
const grid = (rows: string[]) => rows.slice().reverse().flatMap(r => r.split(' ').map(b => b === '.' ? 'air' : b));

test('strays: new scaffold, top down; the baseline, the design\'s cells and what holds something up stay', (t) => {
  const blocks = grid([
    '. cobblestone . . .',                      // y 67: a pillar's top
    '. cobblestone . torch .',                  // y 66
    'andesite cobblestone . cobblestone chest', // y 65: the torch's post (x 3)
    'grass_block grass_block grass_block grass_block grass_block' // y 64
  ]);
  const keep = new Set(['0,65,0']); // natural andesite, there before the job
  const got = strays(blocks, box, keep, new Set()).map(p => `${p.x},${p.y}`);
  t.deepEqual(got, ['1,67', '1,66', '1,65']); // the pillar, top first; the torch's post stays
  t.deepEqual(strays(blocks, box, keep, new Set(['1,65,0'])).map(p => `${p.x},${p.y}`), ['1,67', '1,66']); // the design places that one
});

test('strays: a block with a wall torch on its side or a lantern under it stays', (t) => {
  const blocks = grid([
    '. . . . .',
    'cobblestone wall_torch . cobblestone .',
    '. . . lantern .',
    'stone stone stone stone stone'
  ]);
  t.deepEqual(strays(blocks, box, new Set(), new Set()), []);
});

test('baseline: everything throwaway there now; seeded, only the seed\'s and natural stone inside its box', (t) => {
  const blocks = grid([
    '. . . . .',
    '. . . . .',
    'cobblestone cobblestone diorite . cobblestone',
    'stone stone stone stone stone'
  ]);
  t.deepEqual(baseline(blocks, box).sort(), ['0,65,0', '1,65,0', '2,65,0', '4,65,0']);
  const within = { x: 0, y: 64, z: 0, width: 3, height: 4, length: 1 };
  // the import had the cobblestone at x 0; x 1 came later (scaffold); x 2 is natural; x 4 is outside the import
  t.deepEqual(baseline(blocks, box, { keep: ['0,65,0'], within }).sort(), ['0,65,0', '2,65,0', '4,65,0']);
});

test('tidyBox: the structure box and a margin round it', (t) => {
  t.deepEqual(tidyBox({ x: 10, y: 64, z: 20, width: 5, height: 4, length: 3 }), { x: 4, y: 62, z: 14, width: 17, height: 12, length: 15 });
});

test('standSpots: on a solid floor with head room, the block in reach, not on what it digs, nearest first', (t) => {
  // 9 wide (x -4..4), 7 high (y 62..68), 1 deep (z 0): ground at y 63 (grass), a fence at x 2, a cobblestone pillar at x 0 up to y 67
  const b = { x: -4, y: 62, z: 0, width: 9, height: 7, length: 1 };
  const rows: Record<number, string> = {
    68: '. . . . . . . . .',
    67: '. . . . cobblestone . . . .',
    66: '. . . . cobblestone . . . .',
    65: '. . . . cobblestone . . . .',
    64: '. . . . cobblestone . oak_fence . .',
    63: 'grass_block grass_block grass_block grass_block grass_block grass_block grass_block grass_block grass_block',
    62: 'dirt dirt dirt dirt dirt dirt dirt dirt dirt'
  };
  const blocks = [62, 63, 64, 65, 66, 67, 68].flatMap(y => rows[y].split(' ').map(s => s === '.' ? 'air' : s));
  const top = { x: 0, y: 67, z: 0 };
  const spots = standSpots(blocks, b, top, { x: -3, y: 64, z: 0 });
  t.true(spots.length > 0);
  for (const s of spots) {
    t.is(s.y, 64); // on the grass: nothing stands on the fence or the pillar
    t.not(s.x, 0);
    t.not(s.x, 2);
  }
  t.deepEqual(spots[0], { x: -3, y: 64, z: 0 }); // where the bot stands already reaches the top
  // too high to reach from the ground: no spot (the pillar's own top isn't one, it's what is dug)
  t.deepEqual(standSpots(blocks, b, { x: 0, y: 70, z: 0 }, { x: -3, y: 64, z: 0 }), []);
});

test('doorways: the cells a door opens onto, both sides and both heights', t => {
  const d = doorways([
    { at: { x: -52, y: 68, z: -17 }, want: 'oak_door[facing=south,half=lower,hinge=left]' },
    { at: { x: -52, y: 69, z: -17 }, want: 'oak_door[facing=south,half=upper,hinge=left]' },
    { at: { x: 0, y: 64, z: 0 }, want: 'oak_planks' }
  ]);
  t.deepEqual([...d].sort(), ['-52,68,-16', '-52,68,-18', '-52,69,-16', '-52,69,-18']);
});

// ---- the yard's daily tidy round (src/client/brain/tidy.ts; its own rows are in yardtidy.test.ts) and the fence
// round the Nether portal (hallshells.ts builds it from blueprints.ts portalRing): the round knows it as a second
// fence, on the pasture's yard (tests/helpers/pasture.ts: the ring on x -564..-555, z 2145..2149, its gate south at
// (-563, 63, 2149), the frame's foot along z 2147 two cells inside its long sides)

const key = (p: Pos) => `${p.x},${p.y},${p.z}`;
const cell = (k: string): Pos => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; };
const cluster = (ps: [number, number, number][], block = 'cobblestone'): Cluster => {
  const cells = ps.map(([x, y, z]) => ({ x, y, z, block }));
  return {
    min: { x: Math.min(...cells.map(c => c.x)), y: Math.min(...cells.map(c => c.y)), z: Math.min(...cells.map(c => c.z)) },
    max: { x: Math.max(...cells.map(c => c.x)), y: Math.max(...cells.map(c => c.y)), z: Math.max(...cells.map(c => c.z)) },
    blocks: cells.length, kinds: { [block]: cells.length }, cells
  };
};
/** The round's looks at a pasture: the bot's record, the yard's fence and the portal's ring as they stand. */
function looks(p: Pasture, over: Record<string, string> = {}) {
  const at = (c: Pos) => over[key(c)] ?? p.get(c);
  const built = [...p.protection.keys()].map(cell);
  const ring = yardRing(p.world)!, portal = portalFence(p.world);
  const fence: YardFence = { ring, fence: yardFence(built, at, ring), at };
  const inner: YardFence[] = portal ? [{ ring: portal, fence: yardFence(built, at, portal), at }] : [];
  return { at, built, set: new Set(p.protection.keys()), fence, inner, portal };
}
// a stair over the ring's south side, by the frame: a step outside, one on the fence, a step inside against the
// frame's foot
const STAIR: [number, number, number][] = [[-558, 63, 2150], [-558, 64, 2149], [-558, 63, 2148]];

test('portalFence: the ring\'s footprint as a ring, from its zone; none where no ring was begun', t => {
  t.deepEqual(portalFence(yard().world), { x1: -564, z1: 2145, x2: -555, z2: 2149, y: 62 });
  t.is(portalFence(yard({ ring: false }).world), undefined);
  // reserved and not built yet: a ring with no post of its own, and nothing by it is "against a fence"
  const bare = yard({ ring: false });
  bare.world.zones!.ring = [{ x: -564, y: 62, z: 2145, width: 10, length: 5 }];
  const l = looks(bare);
  t.is(l.inner[0].fence.size, 0);
  t.deepEqual(strayCells([cluster(STAIR)], 62, l.set, l.fence, undefined, l.inner), [], 'by the frame, a build of the bot\'s: left, as ever');
});

test('strayCells: a stair over the portal\'s ring comes down, top first, for all the frame beside it; the ring\'s own line is never dug', t => {
  const l = looks(yard());
  t.is(l.inner[0].fence.size, 26, 'its 25 posts and the gate');
  // the frame stands by the step inside: by the rule for a build of the bot\'s the whole stair stays
  t.true(l.set.has('-558,63,2147'));
  t.deepEqual(strayCells([cluster(STAIR)], 62, l.set, l.fence), []);
  t.deepEqual(strayCells([cluster(STAIR)], 62, l.set, l.fence, undefined, l.inner),
    [{ x: -558, y: 64, z: 2149, ring: true }, { x: -558, y: 63, z: 2150, ring: true }, { x: -558, y: 63, z: 2148, ring: true }]);
  // with no yard fence known (it is being moved out), the ring is still a fence
  t.is(strayCells([cluster(STAIR)], 62, l.set, undefined, undefined, l.inner).length, 3);
  // a cobblestone where a post of the ring is gone, a step on it and one outside: the gap is not dug open, the way over it is
  const gone = yard();
  gone.protection.delete('-559,63,2149');
  const g = looks(gone, { '-559,63,2149': 'cobblestone' });
  t.deepEqual(strayCells([cluster([[-559, 63, 2149], [-559, 64, 2149], [-559, 63, 2150]])], 62, g.set, g.fence, undefined, g.inner).map(key), ['-559,64,2149', '-559,63,2150']);
  // by the ring's west side the yard's own fence runs: each is fence to the other, and the block on them both goes
  t.deepEqual(strayCells([cluster([[-564, 64, 2146], [-565, 64, 2146]])], 62, l.set, l.fence, undefined, l.inner).map(key).sort(), ['-564,64,2146', '-565,64,2146']);
  // what is no scaffold stays: a lamp post by the ring (something stands on it), planks, a big heap
  const lamp = looks(yard(), { '-558,64,2150': 'torch' });
  t.deepEqual(strayCells([cluster([[-558, 63, 2150]])], 62, lamp.set, lamp.fence, undefined, lamp.inner), []);
  t.deepEqual(strayCells([cluster(STAIR, 'oak_planks')], 62, l.set, l.fence, undefined, l.inner), []);
  // a stray on the lawn inside the ring, by the frame and by no post, is by a build as before
  t.deepEqual(strayCells([cluster([[-560, 63, 2146]])], 62, l.set, l.fence, undefined, l.inner).map(key), ['-560,63,2146'], 'beside a post: against the ring');
  t.deepEqual(strayCells([cluster([[-562, 64, 2147]])], 62, l.set, l.fence, undefined, l.inner), [], 'on the plinth\'s end, two from every post');
});

test('doorwayCells: the gate of the portal\'s ring is no doorway of a build (the fence rule is its keeper)', t => {
  const p = yard();
  const l = looks(p);
  const all = doorwayCells(l.built, l.at, [l.fence.ring]);
  t.true(all.has('-563,64,2149'), 'unknown as a ring, its gate would be a doorway');
  const known = doorwayCells(l.built, l.at, [l.fence.ring, l.portal!]);
  t.false(known.has('-563,64,2149'));
  t.true(known.has('-556,64,2134') && known.has('-556,64,2137'), 'the hall\'s gate and the lock\'s are');
  // a block over the ring\'s gate goes by the fence rule all the same
  t.deepEqual(strayCells([cluster([[-563, 64, 2149]])], 62, l.set, l.fence, known, l.inner), [{ x: -563, y: 64, z: 2149, ring: true }]);
});

test('the tidy round digs scaffold from the portal\'s ring and leaves the ring and its gate be', async t => {
  const p = yard({ crossings: false });
  for (const [x, y, z] of STAIR) p.set({ x, y, z }, 'cobblestone');
  const blocks = { state: (x: number, y: number, z: number) => p.get({ x, y, z }) };
  t.deepEqual(ringReady(p.world, blocks).sort(), ['cobblestone beside the ring at (-558, 63, 2148): a way over it', 'cobblestone beside the ring at (-558, 63, 2150): a way over it']);
  const rt = {
    builtNear: (c: Pos, r: number) => [...p.protection.keys()].map(cell).filter(b => Math.hypot(b.x - c.x, b.z - c.z) <= r).map(b => ({ at: b }))
  } as unknown as ClientRuntime;
  const text = await tidyGoal(rt).run({ ...p.ctx, s: p.look({ timeOfDay: 9000 }) });
  t.is(text, 'cleared 3 of 3 stray block(s) (3 against the portal\'s ring)');
  for (const [x, y, z] of STAIR) t.is(p.get({ x, y, z }), 'air');
  t.deepEqual(p.changed.filter(c => c.how === 'dug').map(c => key(c.at)).slice(0, 1), ['-558,64,2149'], 'the block on the fence first');
  // the ring whole, its gate shut and never clicked, nothing placed, every walk a careful one
  t.deepEqual(ringReady(p.world, blocks), []);
  t.deepEqual(p.changed.filter(c => c.how !== 'dug'), []);
  t.deepEqual(p.broke, []);
  // and with nothing by it, the round finds nothing
  const clean = yard({ crossings: false });
  t.is(await tidyGoal({ builtNear: (c: Pos, r: number) => [...clean.protection.keys()].map(cell).filter(b => Math.hypot(b.x - c.x, b.z - c.z) <= r).map(b => ({ at: b })) } as unknown as ClientRuntime)
    .run({ ...clean.ctx, s: clean.look({ timeOfDay: 9000 }) }), 'the lawn is clear');
});
