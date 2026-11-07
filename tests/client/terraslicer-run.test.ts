import test from 'ava';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { BuildJob, WorldMemory } from '../../src/client/brain/memory.js';
import { reservedCount, takeFromChests } from '../../src/client/brain/chests.js';
import { stashPlan } from '../../src/client/brain/kit.js';
import { provisionStep, provisioned, release, reserve, toolpathBill } from '../../src/client/structures/terraslicer/provision.js';
import { callGroups, needsCentring, runLoad } from '../../src/client/structures/terraslicer/executor.js';
import type { Station, Toolpath } from '../../src/client/structures/terraslicer/slicer.js';
import type { Load } from '../../src/client/structures/terraslicer/loads.js';

const CHEST = { x: 1, y: 64, z: 1 };
const world = (items: Record<string, number> = {}): WorldMemory => ({
  landmarks: { chests: [CHEST], farmland: [] }, leash: 96, chestItems: { '1,64,1': { ...items } }
});
const snap = (): Snapshot => ({
  now: 1e9, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 5,
  home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0
});
const job = (id = 7): BuildJob => ({ id, world: 'w', structure: 'tower', mode: 'apply', status: 'working', createdAt: 0, updatedAt: 0 });

/** A bridge and tools stand-in: an inventory, the one chest, the bot's position; every call recorded. */
function fakeCtx(w: WorldMemory, inv: Map<string, number>, calls: string[] = [], over: Partial<Record<string, (p: Record<string, unknown>) => unknown>> = {}) {
  let pos = { x: 0, y: 64, z: 0 };
  const ac = new AbortController();
  const ctx = {
    s: snap(), world: w, signal: ac.signal, progress: () => undefined,
    status: async () => ({ inWorld: true, username: 'b', screen: null, position: { ...pos } }),
    call: (async (m: string, p: Record<string, unknown> = {}) => {
      calls.push(`${m}${p.x !== undefined ? ` ${p.x},${p.y},${p.z}` : ''}`);
      if (over[m]) return over[m]!(p);
      if (m === 'inventory') return { items: [...inv].filter(([, n]) => n > 0).map(([name, count], slot) => ({ slot, name, count })) };
      if (m === 'goto') { pos = { x: Number(p.x), y: Number(p.y), z: Number(p.z) }; return { arrived: true }; }
      if (m === 'place.batch') return { results: (p.actions as unknown[]).map(() => ({ placed: true, block: 'oak_planks' })) };
      if (m === 'dig.here') return { dug: true };
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      calls.push(`${tool} ${a.item} ${a.count ?? ''}`.trim());
      const chest = w.chestItems!['1,64,1'];
      if (tool === 'take-from-chest') {
        const item = String(a.item), n = Math.min(Number(a.count), chest[item] ?? 0);
        chest[item] = (chest[item] ?? 0) - n;
        inv.set(item, (inv.get(item) ?? 0) + n);
        return { ok: true, text: `Took ${n} ${item}. It holds: ${Object.entries(chest).filter(([, k]) => k > 0).map(([k, v]) => `${k} x${v}`).join(', ') || 'nothing'}` };
      }
      if (tool === 'store-in-chest') {
        const item = String(a.item), n = inv.get(item) ?? 0;
        inv.set(item, 0);
        chest[item] = (chest[item] ?? 0) + n;
        return { ok: true, text: `Stored ${n} ${item}. It holds: ${Object.entries(chest).filter(([, k]) => k > 0).map(([k, v]) => `${k} x${v}`).join(', ')}` };
      }
      return { ok: true, text: 'ok' };
    }
  } as unknown as GoalContext;
  return { ctx, abort: () => ac.abort() };
}

const pathOf = (stations: Station[], loads: Load[], scaffoldItem = 'cobblestone'): Toolpath => ({
  version: 1, start: { x: 0, y: 64, z: 0 }, stations, objects: [], scaffoldItem, loads, stuck: [], skipped: [],
  stats: { objects: 1, stations: stations.length, place: 0, dig: 0, work: 0, sign: 0, scaffold: 0, scaffoldLeft: 0, scaffoldPeak: 0, hops: 0, loads: loads.length, walkSeconds: 0, buildSeconds: 0, stuck: 0, skipped: 0 }
});

// ------------------------------------------------------------------------------------------------ the bill and the ledger

test('toolpathBill: the loads together, scaffold at the most any load has up (it comes back), a 2% spare of the plentiful', t => {
  const path = pathOf([], [
    { from: 0, to: 1, items: { oak_planks: 100, cobblestone: 5 }, slots: 3, scaffold: 5 },
    { from: 1, to: 2, items: { oak_planks: 10, cobblestone: 3, oak_door: 2 }, slots: 3, scaffold: 3 }
  ]);
  t.deepEqual(toolpathBill(path), { oak_planks: 113, oak_door: 2, cobblestone: 5 });
  t.deepEqual(toolpathBill(path, false), { oak_planks: 110, oak_door: 2, cobblestone: 5 });
});

test('the ledger: what a job holds in the chests is left to it; others take only what is beyond it', async t => {
  const w = world({ oak_log: 50 });
  reserve(w, 7, { oak_log: 40, glass: 3 });
  t.deepEqual(w.reserved, { 7: { oak_log: 40 } }, 'only what is there is held');
  t.is(reservedCount(w, 'oak_log'), 40);
  t.is(reservedCount(w, 'oak_log', 7), 0);
  const inv = new Map<string, number>();
  const { ctx } = fakeCtx(w, inv);
  t.is(await takeFromChests(ctx, 'oak_log', 30), 10, 'the kit, the cook: the 10 beyond the job');
  t.is(await takeFromChests(ctx, 'oak_log', 30, { forJob: 7 }), 30, 'the job: its own');
  release(w, 7);
  t.is(reservedCount(w, 'oak_log'), 0);
});

test('stashPlan: what a job carries is never thrown away (its dirt for farmland beyond the usual 64)', t => {
  const items = [{ slot: 0, name: 'dirt', count: 64 }, { slot: 1, name: 'dirt', count: 30 }];
  t.deepEqual(stashPlan(items).drop, [{ name: 'dirt', count: 30 }]);
  t.deepEqual(stashPlan(items, { keep: new Set(['dirt']) }).drop, []);
});

test('provisionStep: missing stops it with the reason; short goes to the stock trips; all there is ready and held', async t => {
  const j = job();
  const w = world({ oak_log: 3 });
  const { ctx } = fakeCtx(w, new Map());
  const glass = await provisionStep(ctx, j, { white_wool: 2 }, []);
  t.false(glass.ready);
  t.deepEqual(glass.missing, { white_wool: 2 });
  t.regex(glass.note, /put them in a home chest/);
  const logs = await provisionStep(ctx, j, { oak_log: 10 }, []);
  t.deepEqual(logs.need, { oak_log: 7 });
  w.chestItems!['1,64,1'].oak_log = 12;
  const ready = await provisionStep(ctx, { ...j, bill: { oak_log: 10 } }, { oak_log: 10 }, []);
  t.true(ready.ready);
  t.deepEqual(w.reserved?.[7], { oak_log: 10 });
  t.deepEqual(provisioned(w, { ...j, bill: { oak_log: 10 } }), { held: 10, total: 10, short: {} });
});

test('provisionStep: a hoe to till with comes on the bill when there is none', async t => {
  const w = world({});
  const { ctx } = fakeCtx(w, new Map());
  const r = await provisionStep(ctx, job(), { dirt: 1 }, ['hoe']);
  t.truthy(r.need || r.missing);
  const w2 = world({ dirt: 5, iron_hoe: 1 });
  const { ctx: ctx2 } = fakeCtx(w2, new Map());
  t.true((await provisionStep(ctx2, job(), { dirt: 1 }, ['hoe'])).ready);
});

// ------------------------------------------------------------------------------------------------ the executor

const place = (x: number, y: number, z: number, item = 'oak_planks') => ({ op: 'place' as const, at: { x, y, z }, item, state: item, ref: 'down' as const });

test('callGroups and needsCentring: placements batched, the rest alone; centring for blocks beside its own cells', t => {
  const s: Station = { at: { x: 0, y: 64, z: 0 }, walk: 0, object: 0, actions: [place(1, 64, 0), place(2, 64, 0), { op: 'dig', at: { x: 3, y: 64, z: 0 } }, place(3, 64, 0)] };
  t.deepEqual(callGroups(s.actions).map(g => g.map(a => a.op).join('+')), ['place+place', 'dig', 'place']);
  t.true(needsCentring(s), 'a block next to its feet');
  t.false(needsCentring({ ...s, actions: [place(3, 66, 0)] }));
  t.true(needsCentring({ ...s, actions: [{ op: 'pillar', at: { x: 0, y: 64, z: 0 }, count: 2, item: 'dirt' }] }));
});

test('runLoad: takes the load from the chests, walks carefully, a station\'s blocks in one batch, and reports', async t => {
  const w = world({ oak_planks: 20 });
  reserve(w, 7, { oak_planks: 20 });
  const inv = new Map<string, number>();
  const calls: string[] = [];
  const { ctx } = fakeCtx(w, inv, calls);
  const stations: Station[] = [
    { at: { x: 0, y: 64, z: 0 }, walk: 0, object: 0, actions: [place(3, 64, 0), place(3, 65, 0)] },
    { at: { x: 5, y: 64, z: 0 }, walk: 1, object: 0, actions: [{ op: 'dig', at: { x: 6, y: 64, z: 0 }, state: 'cobblestone' }] }
  ];
  const built: unknown[] = [];
  const r = await runLoad(ctx, job(), pathOf(stations, [{ from: 0, to: 2, items: { oak_planks: 2 }, slots: 1, scaffold: 0 }]), { from: 0, to: 2, items: { oak_planks: 2 }, slots: 1, scaffold: 0 }, b => built.push(...b));
  t.is(inv.get('oak_planks'), 2, 'its own reserved planks, taken');
  t.is(r.placed, 2);
  t.is(r.dug, 1);
  t.is(r.stations, 2);
  t.false(r.stopped);
  t.true(built.length >= 2, 'what it built is protected');
  t.true(calls.includes('goto 5,64,0'), 'walked to the second station');
  t.is(calls.filter(c => c.startsWith('place.batch')).length, 1, 'one batch for the station');
});

test('runLoad: stops between stations when the brain gives it up', async t => {
  const w = world({});
  const inv = new Map([['oak_planks', 5]]);
  const calls: string[] = [];
  let abortNow = () => { /* set below */ };
  const { ctx, abort } = fakeCtx(w, inv, calls, { 'place.batch': p => { abortNow(); return { results: (p.actions as unknown[]).map(() => ({ placed: true })) }; } });
  abortNow = abort;
  const stations: Station[] = [
    { at: { x: 0, y: 64, z: 0 }, walk: 0, object: 0, actions: [place(3, 64, 0)] },
    { at: { x: 5, y: 64, z: 0 }, walk: 1, object: 0, actions: [place(8, 64, 0)] }
  ];
  const r = await runLoad(ctx, job(), pathOf(stations, []), { from: 0, to: 2, items: { oak_planks: 2 }, slots: 1, scaffold: 0 });
  t.true(r.stopped);
  t.false(calls.includes('goto 5,64,0'), 'never set out for the second');
});

test('runLoad: a placement the mod refuses is reported as failed, with its reason', async t => {
  const w = world({});
  const inv = new Map([['oak_planks', 5]]);
  const { ctx } = fakeCtx(w, inv, [], { 'place.batch': () => ({ results: [{ placed: true }, { placed: false, reason: 'too far' }] }) });
  const stations: Station[] = [{ at: { x: 0, y: 64, z: 0 }, walk: 0, object: 0, actions: [place(3, 64, 0), place(4, 64, 0)] }];
  const r = await runLoad(ctx, job(), pathOf(stations, []), { from: 0, to: 1, items: { oak_planks: 2 }, slots: 1, scaffold: 0 });
  t.is(r.placed, 1);
  t.deepEqual(r.failed, [{ at: { x: 4, y: 64, z: 0 }, why: 'too far', station: 0 }]);
});

test('provisionStep: makes stairs from the free logs while the bill\'s own logs stay held (they were counted twice)', async t => {
  const w = world({ oak_log: 50, oak_stairs: 0 });
  const inv = new Map<string, number>();
  const { ctx } = fakeCtx(w, inv);
  // crafting as the game does it: planks from logs, stairs from planks
  const act = ctx.act;
  (ctx as { act: GoalContext['act'] }).act = async (tool, a = {}) => {
    if (tool === 'craft-item') {
      const out = String(a.outputItem), n = Number(a.amount);
      if (out === 'oak_planks') { inv.set('oak_log', (inv.get('oak_log') ?? 0) - n); inv.set('oak_planks', (inv.get('oak_planks') ?? 0) + 4 * n); }
      if (out === 'oak_stairs') { inv.set('oak_planks', (inv.get('oak_planks') ?? 0) - 6 * n); inv.set('oak_stairs', (inv.get('oak_stairs') ?? 0) + 4 * n); }
      return { ok: true, text: 'crafted' };
    }
    return act(tool, a);
  };
  const bill = { oak_log: 45, oak_stairs: 8 };
  const made = await provisionStep(ctx, job(), bill, []);
  t.regex(made.note, /made oak_stairs$/, made.note);
  t.is(w.chestItems!['1,64,1'].oak_stairs, 8, 'the stairs went into the chest');
  t.true((w.chestItems!['1,64,1'].oak_log ?? 0) >= 45, 'the bill\'s own logs were not used');
  t.true((await provisionStep(ctx, job(), bill, [])).ready);
});
