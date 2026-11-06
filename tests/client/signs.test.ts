import test from 'ava';
import { signSpot } from '../../src/client/brain/signs.js';
import { categoryOfLabel, chestLabels } from '../../src/client/brain/storage.js';

test('chestLabels: numbered per category, a double chest sharing one number', (t) => {
  const chests = [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 0, y: 64, z: 3 }, { x: 5, y: 64, z: 0 }];
  const assign = { '0,64,0': 'food', '1,64,0': 'food', '0,64,3': 'food', '5,64,0': 'gear' };
  t.deepEqual(chestLabels(chests, assign), { '0,64,0': 'food1', '1,64,0': 'food1', '0,64,3': 'food2', '5,64,0': 'tools1' });
});

test('categoryOfLabel: the user\'s ways of writing them', (t) => {
  t.is(categoryOfLabel('food2'), 'food');
  t.is(categoryOfLabel('Tools 1'), 'gear');
  t.is(categoryOfLabel('miscBlocks2'), 'misc');
  t.is(categoryOfLabel('ore1'), 'ores');
  t.is(categoryOfLabel('seeds1'), 'farming');
  t.is(categoryOfLabel('Hello'), undefined);
});

test('signSpot: on the wall behind the chest, another wall, or standing on it', (t) => {
  const sides = (o: Record<string, string>) => ({ north: 'air', south: 'air', east: 'air', west: 'air', ...o });
  // a chest facing south (into the room) against a north wall
  t.deepEqual(signSpot('chest[facing=south,type=single]', { above: 'air', sides: sides({ north: 'oak_planks' }) }), { face: 'north' });
  t.deepEqual(signSpot('chest[facing=south,type=single]', { above: 'air', sides: sides({ east: 'stone' }) }), { face: 'east' });
  t.deepEqual(signSpot('chest[facing=south,type=single]', { above: 'air', sides: sides({}) }), { face: 'down' });
  t.is(signSpot('chest[facing=south]', { above: 'chest', sides: sides({}) }), undefined);
});
