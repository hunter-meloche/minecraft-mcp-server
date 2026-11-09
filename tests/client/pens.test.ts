import test from 'ava';
import { fetchForPens, gateOf, penMilestone } from '../../src/client/brain/pens.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

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

// a cow pen at x 0..6, z 0..6 with its gate on the south side; home just south of it
function fetchWorld() {
  return { landmarks: { chests: [], farmland: [] }, leash: 96, lastDone: {},
    zones: { 'pen:cow': [{ x: 0, y: 64, z: 0, width: 7, length: 7 }], 'pen:cow:gate': [{ x: 3, y: 64, z: 6 }] } } as unknown as WorldMemory;
}
function fetchCtx(world: WorldMemory, cowAt: { x: number; z: number } | undefined, acts: string[], grazes = false) {
  let me = { x: 3, y: 64, z: 10 };
  let cow = cowAt ? { x: cowAt.x, y: 64, z: cowAt.z } : undefined;
  let penned = false;
  let grazed = !grazes;
  const s = { now: 10 * 60 * 60_000, counts: new Map([['wheat', 10]]), items: [{ name: 'diamond_sword', count: 1, slot: 0 }], home: { x: 3, y: 64, z: 12 } } as unknown as Snapshot;
  return {
    s, world, signal: new AbortController().signal, progress: () => undefined,
    status: async () => ({ position: me }),
    call: (async (m: string, a: Record<string, number> = {}) => {
      if (m === 'world.entities') {
        if (!cow) return { entities: [] };
        const distance = Math.hypot(cow.x - me.x, cow.z - me.z);
        return { entities: distance <= a.maxDistance ? [{ id: 5, name: 'cow', category: 'creature', distance, position: cow }] : [] };
      }
      if (m === 'world.region') return { blocks: ['oak_fence_gate[open=true]'] };
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: Record<string, number> = {}) => {
      acts.push(tool);
      if (tool === 'move-to-position') {
        me = { x: a.x, y: 64, z: a.z };
        // the first time the bot gets to it, it has grazed 12 blocks on (live: "it stopped following" at 77 out)
        if (cow && !grazed) { grazed = true; cow = { x: cow.x + 12, y: 64, z: cow.z }; return { ok: true, text: 'ok' }; }
        // it follows the wheat from within 10 blocks, and stays once in the pen
        if (cow && !penned && Math.hypot(cow.x - me.x, cow.z - me.z) <= 10) { cow = { x: me.x + 0.5, y: 64, z: me.z - 1 }; penned = cow.x >= 0 && cow.x < 7 && cow.z >= 0 && cow.z < 7; }
      }
      if (tool === 'explore') return { ok: true, text: 'No cow within 96 blocks north' };
      return { ok: true, text: 'ok' };
    }
  } as unknown as GoalContext;
}

test('fetchForPens: an empty pen with a cow 90 blocks off (past the chore\'s 32), grazed on by the time the bot gets there, is led in', async (t) => {
  const acts: string[] = [];
  const text = await fetchForPens(fetchCtx(fetchWorld(), { x: 3, z: 100 }, acts, true));
  t.regex(text ?? '', /led one into the pen/);
  t.false(acts.includes('explore'));
});

test('fetchForPens: none in sight, a look out finds none: home again, and no new look for half an hour', async (t) => {
  const acts: string[] = [];
  const world = fetchWorld();
  const ctx = fetchCtx(world, undefined, acts);
  t.regex((await fetchForPens(ctx)) ?? '', /no cow to fetch/);
  t.deepEqual(acts, ['explore', 'go-home']);
  t.is(await fetchForPens(ctx), undefined);
});

test('fetchForPens: a pen with a pair in it fetches nothing', async (t) => {
  const acts: string[] = [];
  const ctx = fetchCtx(fetchWorld(), { x: 2, z: 2 }, acts);
  const call = ctx.call;
  ctx.call = (async (m: string, a: Record<string, unknown>) => (m === 'world.entities'
    ? { entities: [1, 2].map(id => ({ id, name: 'cow', category: 'creature', distance: 9, position: { x: 2 + id, y: 64, z: 2 } })) }
    : call(m, a))) as GoalContext['call'];
  t.is(await fetchForPens(ctx), undefined);
  t.deepEqual(acts, []);
});
