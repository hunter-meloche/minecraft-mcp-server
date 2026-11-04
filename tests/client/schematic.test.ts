import test from 'ava';
import zlib from 'zlib';
import nbt from 'prismarine-nbt';
import { layoutSpec, varints, writeSchematic } from '../../src/client/schematic.js';

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
