import test from 'ava';
import { shoreCells } from '../../src/client/brain/cane.js';
import { enchantingMilestone } from '../../src/client/brain/enchant.js';

// 6 x 3 x 1: water at x 0..1, grass at x 2..5 on layer 0, air above
function shore() {
  const box = { x: 10, y: 62, z: 0, width: 6, height: 3, length: 1 };
  const b: string[] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 6; x++) b.push(y > 0 ? 'air' : x < 2 ? 'water[level=0]' : 'grass_block[snowy=false]');
  return { box, b };
}

test('shoreCells: only the land cell right beside the water, a block up', (t) => {
  const { box, b } = shore();
  t.deepEqual(shoreCells(box, b, 10), [{ x: 12, y: 63, z: 0 }]);
});

test('shoreCells: nothing where something stands on the shore', (t) => {
  const { box, b } = shore();
  b[6 + 2] = 'oak_fence';
  t.deepEqual(shoreCells(box, b, 10), []);
});

test('enchanting is done once the room is there', (t) => {
  const view = (zones: Record<string, unknown[]>) => ({ s: {} as never, world: { zones } as never, have: () => 0 });
  t.false(enchantingMilestone([]).done!(view({})));
  t.true(enchantingMilestone([]).done!(view({ enchanting: [{}] })));
});
