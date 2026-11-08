import test from 'ava';
import zlib from 'zlib';
import nbt from 'prismarine-nbt';
import { breakKinds, checkBuild, keepExisting, layoutSpec, missingCells, placerFacing, splitDirectional, varints, writeSchematic } from '../../src/client/schematic.js';

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

test('splitDirectional: logs on their side are placed by hand too, along their axis; upright ones go to Baritone', (t) => {
  const s = layoutSpec({ palette: { Y: 'oak_log[axis=y]', X: 'oak_log[axis=x]', Z: 'oak_log[axis=z]' }, layers: [['YXZ']] });
  const { baritone, cells } = splitDirectional(s);
  t.deepEqual(baritone.palette, { 'minecraft:air': 0, 'minecraft:oak_log[axis=y]': 1, 'minecraft:structure_void': 2 });
  t.deepEqual(baritone.blocks, [1, 2, 2]);
  t.deepEqual(cells.map(c => [c.x, c.axis, c.facing]), [[1, 'x', undefined], [2, 'z', undefined]]);
  t.deepEqual(missingCells(s, ['air', 'air', 'oak_log[axis=x]']).map(c => [c.x, c.axis]), [[0, undefined], [1, 'x'], [2, 'z']]);
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

test("' ' leaves a cell as it is: no material, never missing", (t) => {
  const s = layoutSpec({ palette: { L: 'oak_log' }, layers: [['L L']] });
  t.deepEqual(s.counts, { oak_log: 2 });
  t.is(s.blocks[1], s.palette['minecraft:structure_void']);
  t.deepEqual(checkBuild(s, ['oak_log', 'oak_door[half=lower]', 'oak_log']), { placed: 2, total: 2, missing: {}, misplaced: {} });
  t.deepEqual(missingCells(s, ['oak_log', 'air', 'air']).map(c => c.x), [2]);
});

test('keepExisting turns the picked air cells into leave-as-is cells', (t) => {
  const s = layoutSpec({ palette: { L: 'oak_log' }, layers: [['L..']] });
  const kept = keepExisting(s, i => i === 1);
  t.deepEqual(kept.blocks, [1, 2, 0]);
  t.is(kept.palette['minecraft:structure_void'], 2);
  t.is(keepExisting(s, () => false), s);
});

test('breakKinds: only what stands where the build clears or replaces, never what the bot keeps', (t) => {
  // 3 cells along x: clear (.), want planks, leave alone (' ')
  const layout = layoutSpec({ palette: { P: 'oak_planks' }, layers: [['.P ']] });
  t.deepEqual(breakKinds(layout, ['minecraft:dirt', 'minecraft:grass_block[snowy=false]', 'minecraft:oak_log[axis=y]']), ['dirt', 'grass_block']);
  // what's right already, and air, need nothing broken; a kept block in a clear cell stays
  t.deepEqual(breakKinds(layout, ['minecraft:air', 'minecraft:oak_planks', null]), []);
  t.deepEqual(breakKinds(layout, ['minecraft:cobblestone', 'minecraft:air', null], i => i === 0), []);
});

test('a fence gate stands either way along its line (opening it turns it), not across it', (t) => {
  // the fence build re-ran 516 times on 2 gates facing back into the yard after use
  const s = layoutSpec({ palette: { G: 'oak_fence_gate[facing=south]', S: 'oak_stairs[facing=south]' }, layers: [['GS']] });
  const used = ['oak_fence_gate[facing=north,in_wall=false,open=false,powered=false]', 'oak_stairs[facing=south,half=bottom]'];
  t.deepEqual(checkBuild(s, used), { placed: 2, total: 2, missing: {}, misplaced: {} });
  t.deepEqual(missingCells(s, used), []);
  // across the line it no longer closes the fence; and a stair turned round is still wrong
  const off = ['oak_fence_gate[facing=east]', 'oak_stairs[facing=north]'];
  t.deepEqual(checkBuild(s, off).misplaced, { oak_fence_gate: 1, oak_stairs: 1 });
  t.deepEqual(missingCells(s, off).map(c => c.id), ['oak_fence_gate', 'oak_stairs']);
});
