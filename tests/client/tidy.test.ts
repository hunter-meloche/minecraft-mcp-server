import test from 'ava';
import { baseline, doorways, standSpots, strays, tidyBox } from '../../src/client/structures/tidy.js';

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
