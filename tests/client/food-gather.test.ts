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

test('gatherFood: hunts until what it carries cooks into the target, then cooks it all at once', async t => {
  const inv = new Map<string, number>([['coal', 4]]);
  const acts: string[] = [];
  const world = { landmarks: { chests: [], farmland: [], furnace: { x: 2, y: 64, z: 0 } }, leash: 96, zones: {} } as unknown as WorldMemory;
  const s = { food: 10, home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, counts: inv, position: { x: 0, y: 64, z: 0 } } as unknown as Snapshot;
  let id = 10;
  const ctx = {
    s, world, signal: new AbortController().signal, progress: () => undefined,
    status: async () => ({ timeOfDay: 2000 }),
    call: (async (m: string) => {
      if (m === 'inventory') return { items: [...inv].map(([name, count], slot) => ({ slot, name, count })) };
      if (m === 'world.entities') return { entities: [0, 1, 2, 3, 4, 5].map(i => ({ id: id + i, name: 'chicken', category: 'creature', distance: 20 + i, position: { x: 20, y: 64, z: i } })) };
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      acts.push(tool);
      if (tool === 'attack-entity') { id++; inv.set('chicken', (inv.get('chicken') ?? 0) + 1); return { ok: true, text: 'Killed chicken' }; }
      if (tool === 'smelt-item') { const n = inv.get('chicken') ?? 0; inv.delete('chicken'); inv.set('cooked_chicken', n); return { ok: true, text: `Smelted ${a.inputCount}` }; }
      return { ok: true, text: 'ok' };
    }
  } as unknown as GoalContext;
  const text = await gatherFood(ctx, 20, true);
  // cooked chicken is 6 food points: 3 make 18, the 4th makes 24
  t.is(acts.filter(a => a === 'attack-entity').length, 4, acts.join(', '));
  t.is(acts.filter(a => a === 'smelt-item').length, 1, 'all cooked in one go');
  t.regex(text, /hunted 4 chicken/);
  t.regex(text, /cooked 4 chicken/);
});

test('gatherFood: hungry and nothing to hunt round home: goes looking, and hunts where it found game', async t => {
  const inv = new Map<string, number>([['coal', 4]]);
  const acts: string[] = [];
  const world = { landmarks: { chests: [], farmland: [], furnace: { x: 2, y: 64, z: 0 } }, leash: 96, zones: {} } as unknown as WorldMemory;
  const s = { food: 6, home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, counts: inv, position: { x: 0, y: 64, z: 0 } } as unknown as Snapshot;
  let out = false, id = 50;
  const ctx = {
    s, world, signal: new AbortController().signal, progress: () => undefined,
    status: async () => ({ timeOfDay: 2000 }),
    call: (async (m: string) => {
      if (m === 'inventory') return { items: [...inv].map(([name, count], slot) => ({ slot, name, count })) };
      if (m === 'world.entities') return { entities: out ? [0, 1, 2, 3].map(i => ({ id: id + i, name: 'cow', category: 'creature', distance: 10, position: { x: 90, y: 64, z: i } })) : [{ id: 1, name: 'horse', category: 'creature', distance: 5, position: { x: 3, y: 64, z: 0 } }] };
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      acts.push(tool === 'explore' ? `explore ${a.target} ${a.direction}` : tool);
      if (tool === 'explore') { if (a.direction === 'east') { out = true; return { ok: true, text: 'Found cow at (90, 64, 0)' }; } return { ok: true, text: 'cow not found' }; }
      if (tool === 'attack-entity') { id++; inv.set('beef', (inv.get('beef') ?? 0) + 2); return { ok: true, text: 'Killed cow' }; }
      if (tool === 'smelt-item') { const n = inv.get('beef') ?? 0; inv.delete('beef'); inv.set('cooked_beef', n); return { ok: true, text: 'Smelted' }; }
      return { ok: true, text: 'ok' };
    }
  } as unknown as GoalContext;
  const text = await gatherFood(ctx, 20, true);
  t.deepEqual(acts.filter(a => a.startsWith('explore')), ['explore cow north', 'explore pig east']);
  t.regex(text, /found pig to the east/);
  t.regex(text, /hunted 2 cow/);
  t.regex(text, /cooked 4 beef/);
});
