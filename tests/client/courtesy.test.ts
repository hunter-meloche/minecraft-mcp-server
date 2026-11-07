import test from 'ava';
import { HOME_FROM_BUILDS, HOME_FROM_UNDERGROUND, WILD_DISTANCE, boxMeetsZone, homeProblems, nearestZone, someones, zoneDistance } from '../../src/client/brain/courtesy.js';

const cow = (over: Record<string, unknown> = {}) => ({ id: 1, name: 'cow', distance: 5, ...over });

test('someones: named, tamed, on a lead, in a pen, or grazing by a build is someone\'s; a wild one far out is not', t => {
  t.false(someones(cow()));
  t.false(someones(cow({ buildDistance: WILD_DISTANCE + 10 })));
  t.true(someones(cow({ named: true })));
  t.true(someones(cow({ tamed: true })));
  t.true(someones(cow({ leashed: true })));
  t.true(someones(cow({ foreign: true })));
  t.true(someones(cow({ buildDistance: 10 })), 'grazing by a friend\'s farm');
});

test('someones: in the bot\'s own yard a build nearby makes no difference; a name tag or a lead still does', t => {
  const yard = { x1: 0, z1: 0, x2: 30, z2: 20 };
  const penned = { position: { x: 12.5, y: 64, z: 7.5 }, buildDistance: 15 };
  t.false(someones(cow(penned), yard), 'its own pen, 15 from a friend\'s build');
  t.true(someones(cow(penned)), 'no yard known: theirs, most likely');
  t.true(someones(cow({ ...penned, named: true }), yard));
  t.true(someones(cow({ ...penned, leashed: true }), yard));
  t.true(someones(cow({ position: { x: 31.5, y: 64, z: 7.5 }, buildDistance: 15 }), yard), 'just outside the yard');
});

test('zoneDistance: straight line to the box, 0 inside; a mineshaft far under the yard is far away', t => {
  const zone = { x1: 10, y1: 60, z1: 10, x2: 20, y2: 70, z2: 20 };
  t.is(zoneDistance({ x: 15, y: 65, z: 15 }, zone), 0);
  t.is(zoneDistance({ x: 0, y: 65, z: 15 }, zone), 10);
  t.is(zoneDistance({ x: 15, y: 100, z: 15 }, zone), 30, 'right over it, 30 up');
  t.is(zoneDistance({ x: 23, y: 74, z: 15 }, zone), 5);
  const mineshaft = { x1: -120, y1: -57, z1: -84, x2: -16, y2: -16, z2: 51, surface: false };
  t.is(Math.round(zoneDistance({ x: -54, y: 68, z: -19 }, mineshaft)), 84);
});

test('nearestZone: by kind, zones with no kind counted as on the surface (an older mod)', t => {
  const house = { x1: 10, y1: 60, z1: 10, x2: 20, y2: 70, z2: 20, surface: true };
  const cellar = { x1: 0, y1: 40, z1: 0, x2: 4, y2: 44, z2: 4, surface: false };
  const old = { x1: 40, y1: 60, z1: 0, x2: 44, y2: 70, z2: 4 };
  const at = { x: 0, y: 64, z: 0 };
  t.is(nearestZone(at, [house, cellar, old], true).zone, house);
  t.is(nearestZone(at, [cellar, old], true).zone, old);
  t.is(nearestZone(at, [cellar], false).distance, 20);
  t.is(nearestZone(at, [house], false).distance, Infinity);
});

test('homeProblems: too near a build, over something built under ground, or in spawn protection; fine far from all', t => {
  const at = { x: 100, y: 64, z: 100 };
  t.deepEqual(homeProblems(at, [], { x: 0, z: 0 }), []);
  t.deepEqual(homeProblems(at, [], undefined), []);
  t.deepEqual(homeProblems(at, [{ x1: 180, y1: 60, z1: 90, x2: 190, y2: 70, z2: 110, surface: true }], { x: 0, z: 0 }), [], '80 away');
  const near = homeProblems(at, [{ x1: 120, y1: 60, z1: 90, x2: 130, y2: 70, z2: 110, surface: true, sample: 'oak_planks' }], undefined);
  t.is(near.length, 1);
  t.regex(near[0], new RegExp(`20 blocks away \\(oak_planks round x 120..130, z 90..110\\): keep home at least ${HOME_FROM_BUILDS}`));
  t.deepEqual(homeProblems(at, [{ x1: 120, y1: 141, z1: 90, x2: 130, y2: 155, z2: 110, surface: true }], undefined), [], 'a sky build 77 up is no neighbour');
  t.deepEqual(homeProblems(at, [{ x1: 90, y1: -50, z1: 90, x2: 110, y2: -20, z2: 110, surface: false }], undefined), [], 'a mineshaft 84 down');
  const cellar = homeProblems(at, [{ x1: 95, y1: 50, z1: 95, x2: 105, y2: 54, z2: 105, surface: false, sample: 'chest' }], undefined);
  t.is(cellar.length, 1);
  t.regex(cellar[0], new RegExp(`under ground is 10 blocks away \\(chest at y 50..54\\).*keep ${HOME_FROM_UNDERGROUND}`));
  const spawn = homeProblems({ x: 5, y: 64, z: 5 }, [], { x: 0, z: 0 });
  t.is(spawn.length, 1);
  t.regex(spawn[0], /spawn protection/);
});

test('boxMeetsZone: overlap counted inclusively, a gap is none', t => {
  const zone = { x1: 10, y1: 60, z1: 10, x2: 20, y2: 70, z2: 20 };
  t.true(boxMeetsZone({ x: 0, y: 64, z: 0, width: 11, height: 3, length: 11 }, zone), 'corner on corner');
  t.false(boxMeetsZone({ x: 0, y: 64, z: 0, width: 10, height: 3, length: 10 }, zone), 'a block short');
  t.false(boxMeetsZone({ x: 12, y: 80, z: 12, width: 3, height: 3, length: 3 }, zone), 'above it');
});
