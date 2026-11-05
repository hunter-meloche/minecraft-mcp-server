import test from 'ava';
import { survey } from '../../src/client/survey.js';

// a 9 x 7 x 9 box: stone up to y=1, dirt at y=2, grass at y=3 (the ground), then air; things added per test
function world() {
  const w = 9, l = 9, h = 7;
  const b: string[] = new Array(w * l * h).fill('air');
  const set = (x: number, y: number, z: number, n: string) => { b[x + z * w + y * w * l] = n; };
  for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
    set(x, 0, z, 'stone'); set(x, 1, z, 'stone'); set(x, 2, z, 'dirt'); set(x, 3, z, 'grass_block[snowy=false]');
  }
  return { box: { x: 100, y: 60, z: 200, width: w, height: h, length: l }, b, set };
}

test('survey finds a scaffold pillar and an emergency wall, not the ground', (t) => {
  const { box, b, set } = world();
  set(1, 4, 1, 'cobblestone'); set(1, 5, 1, 'cobblestone'); set(1, 6, 1, 'dirt'); // pillar
  for (const [x, z] of [[6, 5], [7, 5], [6, 6]]) set(x, 4, z, 'oak_planks'); // wall pieces
  const r = survey(box, b);
  t.is(r.surface.median, 63);
  t.is(r.placed.length, 2);
  t.like(r.placed[0], { blocks: 3, min: { x: 101, y: 64, z: 201 }, max: { x: 101, y: 66, z: 201 } });
  t.deepEqual(r.placed[0].kinds, { cobblestone: 2, dirt: 1 });
  t.deepEqual(r.placed[1].kinds, { oak_planks: 3 });
});

test("survey leaves the bot's builds and furniture out, and finds pits", (t) => {
  const { box, b, set } = world();
  set(4, 4, 4, 'cobblestone'); // part of a protected build
  set(2, 4, 6, 'crafting_table');
  set(6, 3, 2, 'air'); set(6, 2, 2, 'air'); set(6, 1, 2, 'air'); // a 3-deep hole
  const r = survey(box, b, p => p.x === 104 && p.y === 64 && p.z === 204);
  t.is(r.placed.length, 0);
  t.is(r.pits.length, 1);
  t.like(r.pits[0], { x: 106, z: 202, surface: 60, around: 63 });
});

test('survey draws a map of what tops each column', (t) => {
  const { box, b, set } = world();
  set(0, 4, 0, 'oak_log'); set(8, 3, 8, 'water'); set(4, 4, 0, 'cobblestone'); set(2, 3, 0, 'air');
  const r = survey(box, b);
  t.is(r.map.length, 9);
  t.is(r.map[0], 'T0a0x0000');
  t.is(r.map[8], '00000000~');
});
