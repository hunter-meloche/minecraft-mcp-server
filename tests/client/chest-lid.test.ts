import test from 'ava';
import { freeLid } from '../../src/client/brain/chests.js';

test('freeLid digs throwaway blocks off a chest and its other half, and nothing else', async (t) => {
  const world: Record<string, { name: string; properties?: Record<string, string> }> = {
    '0,64,0': { name: 'chest', properties: { type: 'left', facing: 'west' } },
    '0,64,1': { name: 'chest', properties: { type: 'right', facing: 'west' } },
    '1,64,0': { name: 'furnace' },
    '0,65,1': { name: 'cobblestone' }, // on the other half's lid
    '0,65,0': { name: 'air' }
  };
  const dug: string[] = [];
  const call = (async (m: string, p: { x: number; y: number; z: number }) => {
    const k = `${p.x},${p.y},${p.z}`;
    if (m === 'world.block') return world[k] ?? { name: 'air' };
    if (m === 'dig') { dug.push(k); world[k] = { name: 'air' }; return { dug: true }; }
    throw new Error(m);
  }) as Parameters<typeof freeLid>[0];
  t.deepEqual(await freeLid(call, { x: 0, y: 64, z: 0 }), [{ x: 0, y: 65, z: 1 }]);
  world['0,65,0'] = { name: 'oak_planks' }; // someone's building on top: stays
  t.deepEqual(await freeLid(call, { x: 0, y: 64, z: 0 }), []);
  t.deepEqual(dug, ['0,65,1']);
});
