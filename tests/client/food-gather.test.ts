import test from 'ava';
import { gatherFood } from '../../src/client/brain/food.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

test('gatherFood, hungry with no furnace: hunts a lone cow, puts a furnace down beside home, cooks the beef', async t => {
  const inv = new Map<string, number>([['cobblestone', 20], ['stone_sword', 1], ['coal', 3]]);
  const acts: string[] = [];
  const world = { landmarks: { chests: [], farmland: [] }, leash: 96, zones: {} } as unknown as WorldMemory;
  // grass under the 9 x 9 round home, air over it
  const region = Array.from({ length: 243 }, (_, i) => (Math.floor(i / 81) === 0 ? 'grass_block' : 'air'));
  const s = { food: 9, home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, counts: inv, position: { x: 0, y: 64, z: 0 } } as unknown as Snapshot;
  const ctx = {
    s, world, signal: new AbortController().signal, progress: () => undefined,
    status: async () => ({ timeOfDay: 2000 }),
    call: (async (m: string) => {
      if (m === 'inventory') return { items: [...inv].map(([name, count], slot) => ({ slot, name, count })) };
      if (m === 'world.entities') return { entities: [{ id: 7, name: 'cow', category: 'creature', distance: 40, position: { x: 40, y: 64, z: 0 } }] };
      if (m === 'world.region') return { blocks: region };
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      acts.push(`${tool}${a.item ? ` ${a.item}` : a.outputItem ? ` ${a.outputItem}` : a.target ? ` ${a.target}` : ''}`);
      if (tool === 'attack-entity') { inv.set('beef', 2); return { ok: true, text: 'Killed cow' }; }
      if (tool === 'craft-item' && a.outputItem === 'furnace') { inv.set('cobblestone', 12); inv.set('furnace', 1); return { ok: true, text: 'Successfully crafted furnace' }; }
      if (tool === 'place-block') { inv.delete('furnace'); return { ok: true, text: 'Placed furnace at (2, 64, 0)' }; }
      if (tool === 'smelt-item') { inv.delete('beef'); inv.set('cooked_beef', 2); return { ok: true, text: 'Smelted' }; }
      return { ok: false, text: 'no' };
    }
  } as unknown as GoalContext;
  const text = await gatherFood(ctx, 20, true);
  t.true(acts.includes('attack-entity #7'), acts.join(', '));
  t.true(acts.includes('craft-item furnace') && acts.includes('place-block furnace'), acts.join(', '));
  t.truthy(world.landmarks.furnace);
  t.regex(text, /put a furnace down/);
  t.regex(text, /cooked 2 beef/);
});
