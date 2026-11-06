import test from 'ava';
import { compile, validateDesign, type Design } from '../../src/client/structures/format.js';
import { diff, sameBlock, summary } from '../../src/client/structures/diff.js';
import { packages } from '../../src/client/structures/order.js';
import { billFor, sourceBill } from '../../src/client/structures/bill.js';

const hut: Design = {
  version: 1, name: 'hut',
  palette: { P: 'oak_planks', L: 'oak_log[axis=y]', D: 'oak_door[facing=south,half=lower]', T: 'wall_torch[facing=south]' },
  parts: [
    { fill: { from: [0, 0, 0], to: [4, 0, 4], block: 'P' } },
    { walls: { from: [0, 1, 0], to: [4, 3, 4], block: 'P', corners: 'L' } },
    { clear: { from: [1, 1, 1], to: [3, 3, 3] } },
    { fill: { from: [0, 4, 0], to: [4, 4, 4], block: 'P' } },
    { set: { at: [2, 1, 4], block: 'D' } },
    { set: { at: [2, 3, 1], block: 'T' } }
  ],
  signs: [{ at: [1, 2, 1], facing: 'south', lines: ['food1'] }]
};

test('validateDesign: names the problems', (t) => {
  t.deepEqual(validateDesign(hut), []);
  const bad = validateDesign({ version: 1, name: 'x y', palette: { PP: 'oak_planks', Q: 'not a block!' }, parts: [{ set: { at: [0, 0], block: 'Z' } }] } as unknown as Design);
  t.true(bad.some(p => /name/.test(p)));
  t.true(bad.some(p => /palette key "PP"/.test(p)));
  t.true(bad.some(p => /"not a block!"/.test(p)));
  t.true(bad.some(p => /\[x, y, z\]/.test(p)));
  t.true(bad.some(p => /"Z" is not in the palette/.test(p)));
});

test('compile: parts in order, corners, the door\'s top as a second half, a sign cell, counts', (t) => {
  const c = compile(hut, { x: 100, y: 64, z: 200 });
  t.deepEqual(c.box, { x: 100, y: 64, z: 200, width: 5, height: 5, length: 5 });
  const at = (x: number, y: number, z: number) => c.cells.find(k => k.at.x === 100 + x && k.at.y === 64 + y && k.at.z === 200 + z);
  t.is(at(0, 1, 0)!.want, 'oak_log[axis=y]');
  t.is(at(1, 1, 0)!.want, 'oak_planks');
  t.is(at(2, 2, 2)!.want, 'air');
  t.is(at(2, 1, 4)!.want, 'oak_door[facing=south,half=lower]');
  t.like(at(2, 2, 4), { want: 'oak_door[facing=south,half=upper]', second: true });
  t.deepEqual(at(1, 2, 1), { at: { x: 101, y: 66, z: 201 }, want: 'oak_wall_sign[facing=south]', sign: ['food1'] });
  t.is(c.counts['oak_log[axis=y]'], 12);
  t.is(c.counts['oak_door[facing=south,half=lower]'], 1);
  t.falsy(c.counts['oak_door[facing=south,half=upper]']);
});

test('compile: turned 90 degrees, the box swaps sides and facings turn clockwise', (t) => {
  const long: Design = { version: 1, name: 'bar', parts: [{ fill: { from: [0, 0, 0], to: [3, 0, 0], block: 'stone' } }, { set: { at: [0, 1, 0], block: 'oak_stairs[facing=north]' } }] };
  const c = compile(long, { x: 0, y: 0, z: 0 }, 90);
  t.deepEqual({ w: c.box.width, l: c.box.length }, { w: 1, l: 4 });
  t.true(c.cells.some(k => k.want === 'oak_stairs[facing=east]'));
});

test('sameBlock: what changes by itself does not count; how it was placed does', (t) => {
  t.is(sameBlock('oak_door[facing=south,half=lower]', 'minecraft:oak_door[facing=south,half=lower,hinge=left,open=true,powered=false]'), 'same');
  t.is(sameBlock('oak_fence', 'oak_fence[east=true,north=false,south=false,west=true,waterlogged=false]'), 'same');
  t.is(sameBlock('chest[facing=north]', 'chest[facing=north,type=left,waterlogged=false]'), 'same');
  t.is(sameBlock('oak_stairs[facing=north]', 'oak_stairs[facing=east,half=bottom,shape=straight]'), 'state');
  t.is(sameBlock('oak_planks', 'short_grass'), 'empty');
  t.is(sameBlock('oak_planks', 'stone'), 'other');
});

test('diff: place, replace, restate, clear, a sign with other text, unloaded cells left be', (t) => {
  const c = compile(hut, { x: 0, y: 64, z: 0 });
  const world = c.cells.map(cell => {
    if (cell.at.x === 0 && cell.at.y === 64 && cell.at.z === 0) return 'air';                     // floor missing
    if (cell.at.x === 1 && cell.at.y === 64 && cell.at.z === 0) return 'stone';                   // wrong block
    if (cell.at.x === 2 && cell.at.y === 66 && cell.at.z === 2) return 'cobblestone';             // interior blocked
    if (cell.at.x === 2 && cell.at.y === 64 && cell.at.z === 2) return null;                      // not loaded
    if (cell.sign) return 'oak_wall_sign[facing=south,waterlogged=false]';
    if (cell.want === 'air') return 'air';
    return cell.want;
  });
  const d = diff(c.cells, world, { '1,66,1': ['wood1'] });
  t.like(summary(d), { place: 1, replace: 1, clear: 1, sign: 1, restate: 0 });
  t.is(d.find(x => x.at.x === 2 && x.at.y === 64 && x.at.z === 2)!.kind, 'ok');
  t.is(diff(c.cells, world, { '1,66,1': ['food1', ''] }).filter(x => x.kind === 'sign').length, 0);
});

test('packages: clearing top down first, then floors before walls, attachables last', (t) => {
  const c = compile(hut, { x: 0, y: 64, z: 0 });
  const d = diff(c.cells, c.cells.map(() => 'air'));
  const ps = packages(d, 16);
  t.true(ps.every(p => p.phase !== 'clear'));
  const firstBuild = ps.find(p => p.phase === 'build')!;
  t.true(firstBuild.changes.every(x => x.at.y === 64));
  const phases = ps.map(p => p.phase);
  t.is(phases.indexOf('attach'), phases.length - phases.filter(p => p === 'attach').length);
  t.true(ps.filter(p => p.phase === 'attach').flatMap(p => p.changes).some(x => /door|torch|sign/.test(x.want)));
  const blocked = diff(c.cells, c.cells.map(cell => (cell.want === 'air' ? 'stone' : cell.want)));
  t.is(packages(blocked)[0].phase, 'clear');
});

test('bill: what the changes place, sourced from what there is, recipes, smelting, trips, or nobody', (t) => {
  const c = compile(hut, { x: 0, y: 64, z: 0 });
  const bill = billFor(diff(c.cells, c.cells.map(() => 'air')));
  t.is(bill.oak_planks, 25 + 25 + 36 - 2); // floor, roof, the walls between the corner posts, less the door's two cells
  t.is(bill.oak_door, 1);
  t.is(bill.torch, 1);
  t.is(bill.oak_sign, 1);
  const s = sourceBill({ oak_planks: 10, torch: 4, glass: 2, iron_ingot: 2 }, { oak_log: 1, coal: 1, stick: 1, raw_iron: 1 });
  const by = Object.fromEntries(s.lines.map(l => [l.item, l.source]));
  t.is(by.oak_planks, 'gather'); // 1 log makes 4: 6 more planks need 2 more oak logs
  t.is(s.gather.oak_log, 2);
  t.is(by.torch, 'craft');
  t.is(by.glass, 'missing');
  t.is(by.iron_ingot, 'gather'); // one smelted from the raw iron, the other mined
  t.deepEqual(s.missing, { glass: 2 });
});

test('planText and render: what the LLM reads', async (t) => {
  const { planText, render } = await import('../../src/client/structures/tools.js');
  const c = compile(hut, { x: 0, y: 64, z: 0 });
  const changes = diff(c.cells, c.cells.map(() => 'air'));
  const text = planText('Plan for "hut"', c, changes, sourceBill(billFor(changes), { oak_log: 40, stick: 4, coal: 2 }));
  t.regex(text, /box \(0, 64, 0\) 5x5x5/);
  t.regex(text, /Changes: 99 to place/);
  t.regex(text, /oak_planks x84 \(have 0; craft it\)/);
  t.regex(text, /Work: \d+ package/);
  const upToDate = planText('x', c, diff(c.cells, c.cells.map(k => k.want), { '1,66,1': ['food1'] }), sourceBill({}, {}));
  t.regex(upToDate, /Up to date/);
  const pic = render(hut, c);
  t.regex(pic, /y 65:\n {2}LPPPL/);
  t.regex(pic, /Other blocks: .*oak_door\[facing=south,half=upper\]/);
});
