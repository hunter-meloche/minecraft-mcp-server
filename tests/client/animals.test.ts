import test from 'ava';
import { inPen, nextAnimalAction, penState, strayToFetch, type Animal, type Pen } from '../../src/client/brain/animals.js';

const pen: Pen = { x1: 0, z1: 0, x2: 4, z2: 4, kind: 'cow' };
let nextId = 1;
function cow(x: number, z: number, extra: Partial<Animal> = {}): Animal {
  return { id: nextId++, name: 'cow', position: { x, y: 64, z }, distance: Math.hypot(x, z), ...extra };
}
const inside = (n: number, extra: Partial<Animal> = {}) => Array.from({ length: n }, (_, i) => cow(1 + (i % 4) * 0.5, 2, extra));

test('the pen covers its corner blocks', (t) => {
  t.true(inPen(pen, { x: 0, z: 0 }));
  t.true(inPen(pen, { x: 4.9, z: 4.5 }));
  t.false(inPen(pen, { x: 5.1, z: 2 }));
  t.true(inPen({ ...pen, x1: 4, x2: 0 }, { x: 2, z: 2 }));
});

test('pen state counts adults and babies inside, and nearby adult strays nearest first', (t) => {
  const far = cow(40, 0);
  const near = cow(10, 0);
  const s = penState(pen, [cow(1, 1), cow(2, 2, { baby: true }), near, cow(12, 0, { baby: true }), far, { ...cow(1, 1), name: 'pig' }, cow(20, 0)]);
  t.deepEqual(s.inside, { adults: 1, babies: 1 });
  t.deepEqual(s.outsideNear.map(e => e.position.x), [10, 20]);
});

test('too few adults: lure the nearest stray with wheat', (t) => {
  const stray = cow(10, 0);
  t.deepEqual(nextAnimalAction(pen, [cow(1, 1), stray], { wheat: 3 }), { kind: 'lure', target: stray.id, food: 'wheat' });
});

test('no food or no strays: wait and say why', (t) => {
  const a = nextAnimalAction(pen, [cow(1, 1), cow(10, 0)], {});
  t.is(a.kind, 'wait');
  t.regex((a as { why: string }).why, /no wheat/);
  const b = nextAnimalAction(pen, [cow(1, 1)], { wheat: 5 });
  t.regex((b as { why: string }).why, /none within 32/);
});

test('two ready adults and two wheat: breed', (t) => {
  const [a, b] = inside(2);
  t.deepEqual(nextAnimalAction(pen, [a, b], new Map([['wheat', 2]])), { kind: 'breed', ids: [a.id, b.id], food: 'wheat' });
});

test('no breeding while in love, on cooldown, short of food or with a full pen', (t) => {
  t.is(nextAnimalAction(pen, inside(2, { inLove: true }), { wheat: 9 }).kind, 'wait');
  const herd = inside(3);
  t.is(nextAnimalAction(pen, herd, { wheat: 9 }, { breedCooldownOk: id => id !== herd[0].id && id !== herd[1].id }).kind, 'wait');
  t.is(nextAnimalAction(pen, inside(2), { wheat: 1 }).kind, 'wait');
  // babies count towards the herd: they would only be culled when grown
  t.is(nextAnimalAction(pen, [...inside(6), ...inside(2, { baby: true })], { wheat: 9 }).kind, 'wait');
  t.is(nextAnimalAction(pen, inside(8), { wheat: 9 }).kind, 'wait');
});

test('chickens breed on seeds, pigs on carrots (or potatoes)', (t) => {
  const chick = (x: number) => ({ ...cow(x, 1), name: 'chicken' });
  const hens = [chick(1), chick(2)];
  t.deepEqual(nextAnimalAction({ ...pen, kind: 'chicken' }, hens, { wheat: 10, wheat_seeds: 4 }), { kind: 'breed', ids: [hens[0].id, hens[1].id], food: 'wheat_seeds' });
  const pigs = [{ ...cow(1, 1), name: 'pig' }, { ...cow(2, 1), name: 'pig' }];
  t.like(nextAnimalAction({ ...pen, kind: 'pig' }, pigs, { potato: 3 }), { kind: 'breed', food: 'potato' });
});

test('too many adults: cull one, never one that is in love', (t) => {
  const herd = inside(9);
  herd[0].inLove = true;
  const a = nextAnimalAction(pen, herd, {});
  t.is(a.kind, 'cull');
  t.not((a as { id: number }).id, herd[0].id);
  t.is(nextAnimalAction(pen, inside(5), {}, { minAdults: 2, maxAdults: 4 }).kind, 'cull');
  // maxAdults below minAdults is lifted to it: never cull below the minimum
  t.not(nextAnimalAction(pen, inside(3), {}, { minAdults: 3, maxAdults: 1 }).kind, 'cull');
});

test('a cull takes the adult with the fewest of the pen beside it, the nearest of those: the sword sweeps every one beside the one it hits', (t) => {
  // seven adults: the nearest stands by a calf, five huddle at the far side, one stands clear in a corner
  const near = cow(1, 1);
  const calf = cow(1.5, 1.5, { baby: true });
  const huddle = [cow(2.5, 3.5), cow(3, 3.5), cow(3.5, 3.5), cow(3, 4), cow(2.5, 4)];
  const clear = cow(4.5, 0.5);
  const herd = [near, calf, ...huddle, clear];
  t.deepEqual(nextAnimalAction(pen, herd, {}, { maxAdults: 6 }), { kind: 'cull', id: clear.id });
  // the clear one just fed (in love): the one beside the calf alone, not one of the huddle
  clear.inLove = true;
  t.deepEqual(nextAnimalAction(pen, herd, {}, { maxAdults: 6 }), { kind: 'cull', id: near.id });
  // all beside as many: the nearest, as before
  const row = inside(7);
  t.deepEqual(nextAnimalAction(pen, row, {}, { maxAdults: 6 }), { kind: 'cull', id: row[0].id });
});

test('sheep with wool are sheared when shears are carried; unknown wool is left alone', (t) => {
  const sheepPen: Pen = { ...pen, kind: 'sheep' };
  const sheep = (extra: Partial<Animal>) => ({ ...cow(1, 1), name: 'sheep', ...extra });
  const woolly = sheep({ sheared: false });
  const flock = [sheep({ sheared: true }), woolly, sheep({})];
  t.deepEqual(nextAnimalAction(sheepPen, flock, { shears: 1 }), { kind: 'shear', id: woolly.id });
  t.not(nextAnimalAction(sheepPen, flock, {}).kind, 'shear');
  t.not(nextAnimalAction(sheepPen, [sheep({}), sheep({})], { shears: 1 }).kind, 'shear');
});

test('strayToFetch: an empty pen fetches the nearest wild adult from past the lure range, within the reach given', (t) => {
  const far = cow(70, 0), farther = cow(90, 0), calf = cow(60, 0, { baby: true });
  t.is(strayToFetch(pen, [farther, far, calf], 96)?.id, far.id);
  // the pen chore's own range found none: 70 blocks off is past it
  t.is(nextAnimalAction(pen, [far], { wheat: 10 }).kind, 'wait');
  t.is(strayToFetch(pen, [farther], 80), undefined);
  // one adult inside is still short of a pair
  t.is(strayToFetch(pen, [...inside(1), far], 96)?.id, far.id);
  // a pair inside breeds: nothing to fetch
  t.is(strayToFetch(pen, [...inside(2), far], 96), undefined);
});
