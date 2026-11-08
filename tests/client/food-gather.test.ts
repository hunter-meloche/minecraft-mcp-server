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

test('gatherFood: hungry, the only game it found past the hunting range: walks over to it and hunts it', async t => {
  // explore said "Found cow" for one 68 blocks off without walking a step, the hunt looks 64 round: the food goal
  // ran 311 times in 7 min, each "found cow to the north; now carrying 0 food points"
  const inv = new Map<string, number>([['coal', 4]]);
  const acts: string[] = [];
  const world = { landmarks: { chests: [], farmland: [], furnace: { x: 2, y: 64, z: 0 } }, leash: 96, zones: {} } as unknown as WorldMemory;
  const s = { food: 0, home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, counts: inv, position: { x: 0, y: 64, z: 0 } } as unknown as Snapshot;
  let there = false, id = 70;
  const ctx = {
    s, world, signal: new AbortController().signal, progress: () => undefined,
    status: async () => ({ timeOfDay: 2000 }),
    call: (async (m: string, a: Record<string, unknown> = {}) => {
      if (m === 'inventory') return { items: [...inv].map(([name, count], slot) => ({ slot, name, count })) };
      if (m === 'goto') { acts.push(`goto ${a.x}`); there = true; return {}; }
      if (m === 'world.entities') {
        const cows = [0, 1, 2].map(i => ({ id: id + i, name: 'cow', category: 'creature', distance: there ? 6 : 68, position: { x: 68, y: 64, z: i } }));
        return { entities: cows.filter(c => c.distance <= (a.maxDistance as number)) };
      }
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      acts.push(tool === 'explore' ? `explore ${a.target} ${a.direction}` : tool);
      if (tool === 'explore') return { ok: true, text: 'Found cow at (68, 64, 0)' };
      if (tool === 'attack-entity') { id++; inv.set('beef', (inv.get('beef') ?? 0) + 2); return { ok: true, text: 'Killed cow' }; }
      if (tool === 'smelt-item') { const n = inv.get('beef') ?? 0; inv.delete('beef'); inv.set('cooked_beef', n); return { ok: true, text: 'Smelted' }; }
      return { ok: true, text: 'ok' };
    }
  } as unknown as GoalContext;
  const text = await gatherFood(ctx, 20, true);
  t.true(acts.includes('goto 68'), acts.join(', '));
  t.true(acts.indexOf('goto 68') < acts.indexOf('attack-entity'), acts.join(', '));
  t.regex(text, /walking over to a cow 68 blocks off/);
  t.regex(text, /hunted \d+ cow/);
  t.notRegex(text, /now carrying 0 food points/);
});

/** A furnace that holds `input` unlit in its input slot: smelt-item answers (ok) that the slot is occupied until it's taken out. */
function blockedFurnaceCtx(inv: Map<string, number>, acts: string[], opts: { farmland?: boolean } = {}) {
  let input: { name: string; count: number } | null = { name: 'oak_log', count: 5 };
  const world = { landmarks: { chests: [], farmland: opts.farmland ? [{ x: 5, y: 63, z: 5 }] : [], furnace: { x: 2, y: 64, z: 0 } }, leash: 96, zones: {} } as unknown as WorldMemory;
  const s = { food: 20, health: 20, home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, counts: inv, position: { x: 0, y: 64, z: 0 } } as unknown as Snapshot;
  const ctx = {
    s, world, signal: new AbortController().signal, progress: () => undefined,
    // evening: no hunting, so only the cooking (and the farm) can bring food
    status: async () => ({ timeOfDay: 11_500 }),
    call: (async (m: string, a: Record<string, unknown> = {}) => {
      if (m === 'inventory') return { items: [...inv].map(([name, count], slot) => ({ slot, name, count })) };
      if (m === 'furnace.open') return { open: true, input, fuel: null, output: null, lit: false };
      if (m === 'furnace.take' && a.slot === 'input') { const took = input; input = null; if (took) inv.set(took.name, (inv.get(took.name) ?? 0) + took.count); return { took }; }
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      acts.push(`${tool}${a.inputItem ? ` ${a.inputItem}` : ''}`);
      if (tool === 'smelt-item') {
        if (input) return { ok: true, text: `Furnace input slot is occupied by ${input.name}` };
        const raw = String(a.inputItem);
        const n = inv.get(raw) ?? 0;
        inv.delete(raw);
        inv.set(`cooked_${raw}`, n);
        return { ok: true, text: `Smelted ${n} cooked_${raw}` };
      }
      if (tool === 'farm') return { ok: true, text: 'Farmed for 0.45s: nothing ripe to harvest. Baritone: Farm failed' };
      return { ok: true, text: 'ok' };
    }
  } as unknown as GoalContext;
  return { ctx, world };
}

test('gatherFood: logs left in the furnace input are taken out first, then the meat cooks', async t => {
  // a charcoal burn ran out of fuel and left 5 oak logs in the input: every cook after it was "input slot is occupied"
  const inv = new Map<string, number>([['beef', 2], ['chicken', 2], ['coal', 3]]);
  const acts: string[] = [];
  const { ctx } = blockedFurnaceCtx(inv, acts);
  const text = await gatherFood(ctx, 20, true);
  t.is(inv.get('oak_log'), 5, 'the logs came back');
  t.is(inv.get('cooked_beef'), 2);
  t.regex(text, /cooked 2 beef; cooked 2 chicken/);
});

test('gatherFood: a cook that leaves the meat raw and a farm with nothing ripe are no food: it fails, not "done"', async t => {
  // the food goal "cooked 2 beef; cooked 2 chicken; farmed (nothing ripe)" every 30 s for two hours, the same 4 raw
  // pieces each time, carrying 0 food points; as a failure it waits its retry instead
  const inv = new Map<string, number>([['beef', 2], ['chicken', 2], ['coal', 3]]);
  const acts: string[] = [];
  const { ctx } = blockedFurnaceCtx(inv, acts, { farmland: true });
  // by day, so the farm runs too; the logs can't be taken back (the bot's inventory is full, say), so the furnace
  // stays blocked; and no game about
  const call = ctx.call;
  const c = ctx as { call: GoalContext['call']; status: GoalContext['status'] };
  c.status = (async () => ({ timeOfDay: 2000 })) as GoalContext['status'];
  c.call = (async (m: string, a?: Record<string, unknown>) =>
    (m === 'furnace.take' ? { took: null } : m === 'world.entities' ? { entities: [] } : call(m, a))) as GoalContext['call'];
  await t.throwsAsync(gatherFood(ctx, 20, true), { message: /no food to be had/ });
  t.true(acts.includes('smelt-item beef') && acts.includes('farm'), acts.join(', '));
  t.is(inv.get('beef'), 2);
});
