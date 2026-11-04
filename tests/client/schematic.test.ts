import test from 'ava';
import zlib from 'zlib';
import nbt from 'prismarine-nbt';
import { checkBuild, layoutSpec, placerFacing, splitDirectional, varints, writeSchematic } from '../../src/client/schematic.js';

test('layoutSpec: dimensions, palette, Sponge index order, and material counts', (t) => {
  const s = layoutSpec({ palette: { L: 'acacia_log[axis=y]', P: 'acacia_planks' }, layers: [['LP', 'P.L'], ['L']] });
  t.like(s, { width: 3, length: 2, height: 2 });
  t.deepEqual(s.palette, { 'minecraft:air': 0, 'minecraft:acacia_log[axis=y]': 1, 'minecraft:acacia_planks': 2 });
  // index = x + z*W + y*W*L
  t.is(s.blocks[0], 1);
  t.is(s.blocks[1], 2);
  t.is(s.blocks[2], 0); // short row padded with air
  t.is(s.blocks[3], 2);
  t.is(s.blocks[4], 0); // '.'
  t.is(s.blocks[5], 1);
  t.is(s.blocks[6], 1); // second layer
  t.deepEqual(s.counts, { acacia_log: 3, acacia_planks: 2 });
});

test('layoutSpec rejects unknown characters and bad palette keys', (t) => {
  t.throws(() => layoutSpec({ palette: { L: 'oak_log' }, layers: [['LX']] }), { message: /"X" is not in the palette/ });
  t.throws(() => layoutSpec({ palette: { LL: 'oak_log' }, layers: [['L']] }), { message: /single characters/ });
});

test('varints encodes like Sponge expects (signed bytes)', (t) => {
  t.deepEqual(varints([0, 1, 127, 128, 300]), [0, 1, 127, -128, 1, -84, 2]);
});

test('writeSchematic round-trips through NBT', async (t) => {
  const s = layoutSpec({ palette: { L: 'oak_log' }, layers: [['L.L']] });
  const parsed = nbt.simplify((await nbt.parse(zlib.gunzipSync(writeSchematic(s)))).parsed) as Record<string, unknown>;
  t.like(parsed, { Version: 2, DataVersion: 5023, Width: 3, Height: 1, Length: 1, PaletteMax: 2 });
  t.deepEqual(parsed.Palette, { 'minecraft:air': 0, 'minecraft:oak_log': 1 });
  t.deepEqual(parsed.BlockData, [1, 0, 1]);
});

test('splitDirectional: Baritone gets structure_void where stairs go; the stairs come back bottom up', (t) => {
  const s = layoutSpec({
    palette: { P: 'oak_planks', S: 'oak_stairs[facing=south,half=bottom]', N: 'oak_stairs[facing=north,half=bottom]' },
    layers: [['PP', 'PP'], ['S.', '.N']]
  });
  const { baritone, cells } = splitDirectional(s);
  t.deepEqual(baritone.palette, { 'minecraft:air': 0, 'minecraft:oak_planks': 1, 'minecraft:structure_void': 2 });
  t.deepEqual(baritone.blocks, [1, 1, 1, 1, 2, 0, 0, 2]);
  t.deepEqual(cells.map(c => [c.x, c.y, c.z, c.id, c.facing]), [[0, 1, 0, 'oak_stairs', 'south'], [1, 1, 1, 'oak_stairs', 'north']]);
});

test('placerFacing: stairs and doors face where the player looks, furnaces and chests face back', (t) => {
  t.is(placerFacing('oak_stairs', 'south'), 'south');
  t.is(placerFacing('oak_door', 'east'), 'east');
  t.is(placerFacing('furnace', 'south'), 'north');
  t.is(placerFacing('chest', 'west'), 'east');
});

test('checkBuild: counts only the structure, and only the properties the spec names', (t) => {
  const s = layoutSpec({ palette: { L: 'oak_log[axis=y]', P: 'oak_planks' }, layers: [['LP.']] });
  t.deepEqual(checkBuild(s, ['oak_log[axis=y]', 'oak_planks', 'stone']), { placed: 2, total: 2, missing: {}, misplaced: {} });
  t.deepEqual(checkBuild(s, ['oak_log[axis=z]', null, 'air']), { placed: 0, total: 2, missing: { oak_log: 1, oak_planks: 1 }, misplaced: { oak_log: 1 } });
});

test('a door or bed needs one item for its two cells', (t) => {
  const bed = layoutSpec({ palette: { B: 'red_bed[facing=north,part=foot]', b: 'red_bed[facing=north,part=head]' }, layers: [['b', 'B']] });
  t.deepEqual(bed.counts, { red_bed: 1 });
  const door = layoutSpec({ palette: { D: 'oak_door[facing=north,half=lower]', d: 'oak_door[facing=north,half=upper]' }, layers: [['D'], ['d']] });
  t.deepEqual(door.counts, { oak_door: 1 });
  t.deepEqual(checkBuild(door, ['air', 'air']).missing, { oak_door: 1 });
});
