import test from 'ava';
import { gateOf, penMilestone } from '../../src/client/brain/pens.js';

const pen = { x1: 0, z1: 0, x2: 6, z2: 6, kind: 'cow' as const };

test('gateOf: a south gate leads out to +z and in to -z', (t) => {
  const g = gateOf({ x: 3, y: 67, z: 6 }, pen)!;
  t.is(g.side, 'south');
  t.deepEqual(g.outside, { x: 3, y: 67, z: 7 });
  t.deepEqual(g.inside, { x: 3, y: 67, z: 4 });
});

test('gateOf: a west gate', (t) => {
  const g = gateOf({ x: 0, y: 67, z: 3 }, pen)!;
  t.is(g.side, 'west');
  t.deepEqual(g.outside, { x: -1, y: 67, z: 3 });
});

test('a pen milestone is done once its zone is there', (t) => {
  const view = (zones: Record<string, unknown[]>) => ({ s: {} as never, world: { zones } as never, have: () => 0 });
  t.false(penMilestone('cow', []).done!(view({})));
  t.true(penMilestone('cow', []).done!(view({ 'pen:cow': [{}] })));
});
