import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { lights, smelt, stashKeep } from '../../src/client/brain/chores.js';
import { stashPlan } from '../../src/client/brain/kit.js';
import { shelterGoal, type GoalContext, type Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { Change, FetchMemory, Trip, TripState, Ward } from '../../src/client/brain/fetch.js';
import type { ClientRuntime, InventoryItem } from '../../src/client/tools.js';

// The chores keep off what the villager fetch holds (idle-plan V, 6.3 and section 7's "R", "P" and "S" rows: E10, E21,
// D21; INV-8): the stash leaves the lifted blocks and a trip's kit carried, the lights, the tidy and the repair round
// keep out of the villager hall and its lock and off the fetch's cells, the structures build round a held cell, no job
// block goes up while a villager is out (placeGuard), the goals that use a lifted block wait for it (liftedFor), the
// yard does not grow and the pens lead nothing through a gate while one is out (wardOut), and thunder by day does not
// call a live lead in. Each is inert with no fetch record, or an empty one: nothing then changes for today's bot.

const NOW = 10 * 60 * 60_000;
const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
const HOME = at(0, 64, 0);
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: NOW, timeOfDay: 3000, activity: 'work', health: 20, food: 20, position: { ...HOME }, dimension: 'overworld', sleeping: false,
  raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 0,
  home: { ...HOME, dimension: 'overworld' }, distHome: 0, ...over
});
/** The hall's box: x 10..15, z 10..15, its floor's level 64; the lock's six inside cells south of it (its box x 11..15, z 15..18). */
const HALL = { x: 10, y: 63, z: 10, width: 6, length: 6 };
const LOCK_INSIDE = [12, 13, 14].flatMap(x => [16, 17].map(z => at(x, 64, z)));
const world = (over: Partial<WorldMemory> = {}): WorldMemory => ({
  landmarks: { chests: [], farmland: [] }, leash: 96, zones: { hall: [HALL], 'lock:inside': LOCK_INSIDE }, ...over
});

const record = (over: Partial<FetchMemory> = {}): FetchMemory => ({ v: 1, journal: [], wards: [], nextId: 10, ...over });
const lift = (p: Pos, item: string, id = 1): Change => ({ k: 'lift', id, trip: 1, at: p, block: item, item, st: 'done', why: 'job site', t: NOW });
const lure = (p: Pos, id = 2): Change => ({ k: 'lure', id, trip: 1, at: p, item: 'fletching_table', st: 'down', role: 'yard', t: NOW });
const ward = (where: Ward['where'], p: Pos = at(40, 64, 40)): Ward => ({
  key: 'uuid-1', uuid: 'uuid-1', from: { site: '-693,2262', at: p }, since: NOW, bell: true, where,
  last: { at: p, t: NOW, tod: 3000, health: 17, profession: 'fletcher' }, health0: 17
});
const trip = (state: TripState, over: Partial<Trip> = {}): Trip => ({
  id: 1, kind: 'bring', site: '-693,2262', state, beat: NOW, prep: {},
  gate: { at: at(0, 64, -20), side: 'north', inner: at(0, 64, -19), outer: at(0, 64, -23), yard: 20 },
  spare: [], lure: 'fletching_table', avoid: [], times: {}, counts: { hops: 0, misses: 0, wedges: 0, pins: 0 }, ...over
});
/** A villager on its way: a ward led, a mile out. */
const out = (over: Partial<FetchMemory> = {}) => record({ wards: [ward('led')], ...over });

// ------------------------------------------------------------------------------------------------ R: the stash

test('R: the stash leaves a lifted block and a prepared trip\'s kit carried, whatever the room is for; nothing with no trip and an empty journal', (t) => {
  const items: InventoryItem[] = [
    { slot: 0, name: 'smithing_table', count: 2 }, { slot: 1, name: 'fletching_table', count: 6 },
    { slot: 2, name: 'oak_planks', count: 20 }, { slot: 3, name: 'birch_planks', count: 5 }, { slot: 4, name: 'loom', count: 1 }
  ];
  const deposit = (w: WorldMemory, kind?: Parameters<typeof stashKeep>[1]) =>
    Object.fromEntries(stashPlan(items, stashKeep(w, kind)).deposit.map(d => [d.name, d.count]));
  const none = deposit(world());
  t.deepEqual(none, { smithing_table: 2, fletching_table: 6, oak_planks: 20, birch_planks: 5, loom: 1 });
  // inert: a record with nothing in it is no record
  t.deepEqual(deposit(world({ fetch: record() })), none);
  t.deepEqual(stashKeep(world({ fetch: record() }), 'trip'), stashKeep(world(), 'trip'));
  // the evening before: the workshop's table lifted (one of the two carried stays, to go back), the kit packed (the four
  // lures, two planks of each wood for the lock's socket)
  const packed = world({ fetch: record({ trip: trip('prep', { prep: { read: NOW, kit: NOW, lifts: NOW } }), journal: [lift(at(-541, 63, 2153), 'smithing_table')] }) });
  const kept = { smithing_table: 1, fletching_table: 2, oak_planks: 18, birch_planks: 3, loom: 1 };
  t.deepEqual(deposit(packed), kept);
  for (const kind of ['trip', 'deep', 'nether', 'yard'] as const) t.deepEqual(deposit(packed, kind), kept, `making room for ${kind}`);
  // restoring: the kit goes back in the chests, the lift is carried until it is back in its cell
  const restoring = world({ fetch: record({ trip: trip('restore'), journal: [lift(at(-541, 63, 2153), 'smithing_table')] }) });
  t.deepEqual(deposit(restoring), { ...none, smithing_table: 1 });
  // a cap of the home's own that is higher stands (a bill's planks carried for the project)
  const building = world({ fetch: packed.fetch, progress: { done: [], carry: ['oak_planks'], carryCap: { oak_planks: 12 } } as unknown as WorldMemory['progress'] });
  t.is(deposit(building).oak_planks, 8);
});

// ------------------------------------------------------------------------------------------------ R: the lights

test('R: the lights round puts no torch in the villager hall nor its lock, and leaves their dark cells out of its count', async (t) => {
  // a 33 x 13 x 33 yard from (-16, 60, -16): dirt at y 60, dark everywhere; the hall's box over x 10..15, z 10..15
  const W = 33, H = 13, L = 33, ox = -16, oy = 60, oz = -16;
  const blocks = new Array(W * H * L).fill('air');
  for (let i = 0; i < W * L; i++) blocks[i] = 'dirt';
  const torches: Pos[] = [];
  const light = () => blocks.map((_, i) => {
    const x = ox + i % W, y = oy + Math.floor(i / (W * L)), z = oz + Math.floor(i / W) % L;
    return Math.max(0, ...torches.map(p => 14 - Math.abs(p.x - x) - Math.abs(p.y - y) - Math.abs(p.z - z)));
  });
  const hall = { x: 6, y: 60, z: 6, width: 10, length: 10 };
  const inHall = (p: Pos) => p.x >= 6 && p.x <= 15 && p.z >= 6 && p.z <= 15;
  const acts: Pos[] = [];
  const w = world({ zones: { hall: [hall] }, landmarks: { chests: [], farmland: [] } });
  const ctx = {
    s: snap({ items: [{ slot: 0, name: 'torch', count: 20 }], counts: new Map([['torch', 20]]), position: at(0, 61, 0), home: { x: 0, y: 61, z: 0, dimension: 'overworld' } }),
    world: w, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      const p = at(Number(a.x), Number(a.y), Number(a.z));
      if (tool === 'place-block') { acts.push(p); torches.push(p); }
      return { ok: true, text: tool === 'place-block' ? `Placed torch at (${p.x}, ${p.y}, ${p.z})` : 'Dug torch' };
    },
    call: (async (m: string) => (m === 'world.region' ? { blocks } : { block: light() })) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined, gain: () => undefined
  } as unknown as GoalContext;
  const r = await lights.run(ctx);
  t.regex(r, /^yard: placed \d+ torch\(es\)/);
  t.true(acts.length > 0);
  t.false(acts.some(inHall), 'no torch in the hall');
  // (the control: with no hall known, the same round puts one there)
  torches.length = 0;
  acts.length = 0;
  ctx.world = world({ zones: {}, landmarks: { chests: [], farmland: [] } });
  await lights.run(ctx);
  t.true(acts.some(inHall));
  t.false((w.darkIgnore ?? []).some(k => inHall(at(...(k.split(',').map(Number) as [number, number, number])))), 'none of its cells left out for good either');
});

test('R: the smelt waits while its furnace, a smoker or a blast furnace, is lifted out of a villager\'s way', (t) => {
  const furnace = at(-1, 64, 0);
  const w = (fetch?: FetchMemory) => world({ landmarks: { chests: [], farmland: [], furnace }, ...(fetch ? { fetch } : {}) });
  t.regex(smelt.wants(snap(), w()) ?? '', /check the furnace/);
  t.regex(smelt.wants(snap(), w(record())) ?? '', /check the furnace/);
  t.is(smelt.wants(snap(), w(record({ journal: [lift(furnace, 'smoker')] }))), null);
});

// ------------------------------------------------------------------------------------------------ S: the shelter

test('D21 S: thunder by day leaves a live lead alone; at night, or with no lead driven, the shelter calls the bot home as ever', (t) => {
  const g = shelterGoal();
  const away = (over: Partial<Snapshot> = {}) => snap({ activity: 'rest', thundering: true, distHome: 120, position: at(120, 64, 0), ...over });
  const leading = (beat = NOW) => world({ fetch: record({ trip: trip('hop', { beat, hop: { n: 4, replaced: 0 } }), wards: [ward('led')] }) });
  t.is(g.wants(away(), world()), 'night: get home', 'no trip: as ever');
  t.is(g.wants(away(), world({ fetch: record() })), 'night: get home');
  t.is(g.wants(away(), leading()), null, 'a lead at hop 4 runs on by the clock');
  t.is(g.wants(away({ timeOfDay: 23_800 }), leading()), null, 'the dawn is day');
  t.is(g.wants(away({ timeOfDay: 11_500 }), leading()), 'night: get home', 'after 11000 the shelter has it');
  t.is(g.wants(away(), leading(NOW - 120_000)), 'night: get home', 'a trip nobody drives (its beat 2 min old) is no live lead');
  t.is(g.wants(away(), world({ fetch: record({ trip: trip('prep'), wards: [] }) })), 'night: get home', 'a trip preparing is no lead');
  t.is(g.wants(away({ thundering: false, activity: 'rest', timeOfDay: 13_000 }), leading()), 'night: get home', 'a plain night');
});

// ------------------------------------------------------------------------------------------------ R: the structures

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keepoffs-'));
/** A fake world of blocks for world.region: stone to y 63, air above, and what `put` says. */
function blocksCtx(put: Map<string, string>, over: Partial<GoalContext> = {}, calls: string[] = []) {
  const k = (x: number, y: number, z: number) => `${x},${y},${z}`;
  return {
    s: snap(), signal: new AbortController().signal, progress: () => undefined, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'b', screen: null, position: { ...HOME } }),
    act: async (tool: string) => { calls.push(tool); return { ok: true, text: 'ok' }; },
    call: (async (m: string, p: Record<string, number> = {}) => {
      calls.push(m);
      if (m !== 'world.region') return {};
      const out: string[] = [];
      for (let y = p.y; y < p.y + p.height; y++) for (let z = p.z; z < p.z + p.length; z++) for (let x = p.x; x < p.x + p.width; x++) out.push(put.get(k(x, y, z)) ?? (y <= 63 ? 'stone' : 'air'));
      return { blocks: out };
    }) as GoalContext['call'],
    ...over
  } as unknown as GoalContext;
}

test('E10 R: keptOff: a cell the fetch holds, any change; while a villager is out, a job block still to go up outside the hall; nothing with no record', async (t) => {
  const { keptOff } = await import('../../src/client/structures/job.js');
  const change = (p: Pos, kind: 'place' | 'ok' | 'clear', want: string) => ({ at: p, kind, want, have: kind === 'ok' ? want : 'air' });
  const table = change(at(30, 64, 30), 'place', 'smithing_table'), inHall = change(at(12, 64, 12), 'place', 'lectern[facing=north]');
  const planks = change(at(31, 64, 30), 'place', 'oak_planks'), standing = change(at(32, 64, 30), 'ok', 'smithing_table');
  const onLure = change(at(33, 64, 30), 'clear', 'air');
  const all = [table, inHall, planks, standing, onLure];
  const off = (w: WorldMemory) => all.filter(keptOff(w, NOW));
  t.deepEqual(off(world()), []);
  t.deepEqual(off(world({ fetch: record() })), []);
  t.deepEqual(off(world({ fetch: record({ journal: [lure(at(33, 64, 30))] }) })), [onLure], 'the lure: no villager out, still the fetch\'s');
  t.deepEqual(off(world({ fetch: out({ journal: [lure(at(33, 64, 30))] }) })), [table, onLure], 'a villager out: the table waits, the hall\'s lectern and the planks go on');
});

test('E10 R: a homestead job runs without the held cell, waits for it instead of calling itself complete, and is complete once it is back', async (t) => {
  const { driftGoal, queueJob, structureGoal } = await import('../../src/client/structures/job.js');
  const { StructureStore } = await import('../../src/client/structures/store.js');
  const root = tmp();
  const store = new StructureStore(root);
  store.saveStructure('seed:1', {
    version: 1, name: 'shop', anchor: at(30, 64, 30),
    design: { version: 1, name: 'shop', parts: [{ set: { at: [0, 0, 0], block: 'oak_planks' } }, { set: { at: [1, 0, 0], block: 'smithing_table' } }] }
  });
  const put = new Map([['30,64,30', 'oak_planks']]);
  const table = at(31, 64, 30);
  const w = world({ id: 'seed:1', fetch: out({ journal: [lift(table, 'smithing_table')] }) });
  const ctx = { ...blocksCtx(put), world: w } as GoalContext;
  // no drift while it is lifted; the lift gone and the cell bare, it is drift
  t.is(await driftGoal(store).run(ctx), 'every structure matches its file');
  const job = queueJob(w, 'seed:1', 'shop', 'apply', NOW);
  const goal = structureGoal(store);
  t.regex(await goal.run(ctx), /waiting: 1 cell\(s\) kept for a villager on its way/);
  t.like(job, { status: 'waiting', retryAt: NOW + 10 * 60_000 });
  t.not(job.status, 'done');
  // the villager in, the table put back by the fetch: the next look finds it whole
  w.fetch = record();
  put.set('31,64,30', 'smithing_table');
  const later = { ...ctx, s: snap({ now: NOW + 11 * 60_000 }) } as GoalContext;
  t.is(await goal.run(later), 'shop complete');
  t.is(job.status, 'done');
  put.delete('31,64,30');
  t.regex(await driftGoal(store).run(later), /shop: 1 cell\(s\) differ \(reported\)/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------ R: placing and using job blocks

test('E10 R: no stand is placed while a ward is out: the build step and the brewing milestone\'s stand step wait; with none out they go on', async (t) => {
  const { buildStep, growStep } = await import('../../src/client/brain/milestones.js');
  const { placeStandStep } = await import('../../src/client/brain/brewing.js');
  const step = buildStep('stall', () => ({ name: 'stall', spec: { palette: { S: 'brewing_stand' }, layers: [['S']] }, size: { width: 1, height: 1, length: 1 }, bill: {}, landmarks: [], groundOffset: 0 }));
  const st = () => ({ step: 0, data: { site: { x: 30, y: 64, z: 30 }, wood: 'oak' } });
  const calls: string[] = [];
  const ctx = (fetch?: FetchMemory) => ({ ...blocksCtx(new Map(), {}, calls), world: world(fetch ? { fetch } : {}) }) as GoalContext;
  t.deepEqual(await step.run(ctx(out()), st()), { status: 'blocked', text: 'waiting: a villager is on its way', retryMs: 10 * 60_000 });
  t.false(calls.some(c => c !== 'world.region'), 'nothing made, nothing built');
  const free = await step.run(ctx(record()), st());
  t.like(free, { status: 'blocked' });
  t.regex(free.text, /^gathering for the stall: short of/, 'no villager out: on to its materials as ever');
  // the stand into the workshop's cell
  const cell = at(-541, 63, 2150);
  const standCtx = (fetch?: FetchMemory) => ({
    ...blocksCtx(new Map(), { call: (async (m: string) => { if (m === 'world.region') return { blocks: ['air'] }; throw new Error(`on to ${m}`); }) as GoalContext['call'] }),
    world: world({ zones: { 'workshop:stand': [cell] }, ...(fetch ? { fetch } : {}) })
  }) as GoalContext;
  t.deepEqual(await placeStandStep.run(standCtx(out()), st()), { status: 'blocked', text: 'waiting: a villager is on its way', retryMs: 10 * 60_000 });
  t.regex((await placeStandStep.run(standCtx(record({ journal: [lift(cell, 'brewing_stand')] })), st())).text, /held for a villager: its stand goes back once it is in/);
  await t.throwsAsync(placeStandStep.run(standCtx(record()), st()), { message: 'on to inventory' }, 'with none out, to the pockets for the stand');
  // the yard is not grown for a build while one is out (the fence moves out after it)
  calls.length = 0;
  const grow = await growStep(ctx(out()), { x1: -16, z1: -16, x2: 16, z2: 16, y: 63 }, { width: 9, length: 9 }, 'barn');
  t.like(grow, { status: 'blocked' });
  t.regex(grow.text, /^waiting: a villager is on its way/);
  t.deepEqual(calls, []);
});

test('E10 R: the netherite job and the brewing wait for a lifted smithing table and stand; nothing waits with no lift', async (t) => {
  const { pieceStep, tableLifted } = await import('../../src/client/brain/netherite.js');
  const { brewGoal } = await import('../../src/client/brain/brewing.js');
  const table = at(-541, 63, 2153), stand = at(-541, 63, 2150);
  const w = (fetch?: FetchMemory) => world({ zones: { 'workshop:smithing': [table], brewing: [stand] }, yard: { x1: -560, z1: 2120, x2: -520, z2: 2200, y: 62 }, ...(fetch ? { fetch } : {}) });
  const lifted = record({ journal: [lift(table, 'smithing_table', 1), lift(stand, 'brewing_stand', 2)] });
  t.is(tableLifted(w()), undefined);
  t.is(tableLifted(w(record())), undefined);
  t.is(tableLifted(w(lifted)), 'the smithing table at (-541, 63, 2153) is lifted for a villager (back once it is in)');
  const view = (world: WorldMemory) => ({ s: snap(), world, have: () => 0 });
  const step = pieceStep('chestplate');
  t.regex(step.waits!(view(w())) ?? '', /^no diamond_chestplate/);
  t.regex(step.waits!(view(w(lifted))) ?? '', /lifted for a villager/);
  t.deepEqual(brewGoal.declines!(snap(), w(lifted)), { cause: 'hold', text: 'the brewing stand at (-541, 63, 2150) is lifted for a villager (back once it is in)' });
  t.is(brewGoal.wants(snap(), w(lifted)), null);
  t.notRegex(brewGoal.declines!(snap(), w(record()))?.text ?? '', /lifted/);
});

test('E21 R: the yard does not grow and the fence is not moved out while a villager is out', async (t) => {
  const { yardGrowGoal } = await import('../../src/client/brain/yardgrow.js');
  const { TREE } = await import('../../src/client/brain/tree.js');
  const asked = { yardGrow: { width: 9, length: 9, why: 'a barn', at: NOW } };
  t.regex(yardGrowGoal.wants(snap(), world(asked)) ?? '', /room asked for/);
  t.regex(yardGrowGoal.wants(snap(), world({ ...asked, fetch: record() })) ?? '', /room asked for/);
  t.is(yardGrowGoal.wants(snap(), world({ ...asked, fetch: out() })), null);
  const takeDown = TREE.find(m => m.id === 'perimeter')!.steps[0];
  const calls: string[] = [];
  const moving = (fetch?: FetchMemory) => ({
    ...blocksCtx(new Map(), {}, calls),
    world: world({ yard: { x1: -16, z1: -20, x2: 16, z2: 16, y: 63 }, fenceMove: { side: 'north', old: { x1: -16, z1: -16, x2: 16, z2: 16, y: 63 } }, ...(fetch ? { fetch } : {}) })
  }) as GoalContext;
  t.deepEqual(await takeDown.run(moving(out()), { step: 0, data: {} }), { status: 'blocked', text: 'waiting: a villager is on its way (the fence moves out once it is in)', retryMs: 10 * 60_000 });
  t.deepEqual(calls, []);
  t.like(await takeDown.run(moving(record()), { step: 0, data: {} }), { status: 'done', text: 'took down the north side (0 block(s))' });
});

// ------------------------------------------------------------------------------------------------ R: repair and tidy

test('E21 R: the repair round puts back no block the fetch lifted, nor a fence segment it dug for a wedged villager, nor any job block while a villager is out', async (t) => {
  const { repairGoal } = await import('../../src/client/brain/repair.js');
  // the workshop's table lifted, and a post of the yard's fence dug to free a wedged villager (both read as air)
  const table = at(3, 64, 0), post = at(-5, 64, 0);
  const placed: string[] = [];
  let built = [{ at: table, state: 'smithing_table' }, { at: post, state: 'oak_fence' }];
  const rt = {
    builtNear: () => built,
    restoreBlock: async (p: Pos, item: string) => { placed.push(`${item} ${p.x},${p.y},${p.z}`); return undefined; },
    adoptStates: () => undefined
  } as unknown as ClientRuntime;
  const ctx = (over: Partial<WorldMemory>) => ({
    ...blocksCtx(new Map(), { call: (async (m: string, p: Record<string, number> = {}) => (m === 'inventory' ? { items: [{ slot: 0, name: 'smithing_table', count: 1 }] } : { blocks: Array(p.width * p.height * p.length).fill('air') })) as GoalContext['call'] }),
    world: world(over)
  }) as GoalContext;
  const wedge: Change = { ...lift(post, 'oak_fence', 3), why: 'wedge' } as Change;
  const fence = { ...world().zones, fence: [{ x: -5, y: 63, z: -5, width: 11, length: 11 }] };
  t.is(await repairGoal(rt).run(ctx({ zones: fence, fetch: record({ journal: [lift(table, 'smithing_table'), wedge] }) })), 'nothing built near home to check');
  t.deepEqual(placed, []);
  // not lifted, gone all the same (a creeper), and a villager on its way: it waits too, said
  built = built.slice(0, 1);
  t.is(await repairGoal(rt).run(ctx({ fetch: out() })), 'missing blocks; smithing_table at 3,64,0 not put back yet: a villager is on its way');
  t.deepEqual(placed, []);
  // (the control: nothing lifted and nobody out, the table goes back)
  t.is(await repairGoal(rt).run(ctx({ fetch: record() })), 'put back 1/1 missing block(s)');
  t.deepEqual(placed, ['smithing_table 3,64,0']);
});

test('E21 R: the tidy round takes no stray from the hall or the lock but a doorway of theirs, none in a cell the fetch holds, and digs a doorway from outside', async (t) => {
  const { mayTidy } = await import('../../src/client/brain/tidy.js');
  const { digByHand } = await import('../../src/client/structures/job.js');
  const doorways = new Set(['12,65,10', '13,65,18']);
  const w = world({ fetch: record({ journal: [lure(at(0, 64, 5))] }) });
  t.true(mayTidy(world(), at(0, 64, 5)), 'no record: a stray as ever');
  t.false(mayTidy(w, at(0, 64, 5)), 'the lure is the fetch\'s');
  t.true(mayTidy(w, at(0, 64, 6)));
  t.false(mayTidy(w, at(12, 65, 12), doorways), 'in the hall');
  t.false(mayTidy(w, at(11, 64, 18), doorways), 'in the lock\'s box');
  t.true(mayTidy(w, at(12, 65, 10), doorways), 'over the hall\'s gate');
  t.true(mayTidy(w, at(13, 65, 18), doorways), 'over the lock\'s gate');
  // the cell over the hall's gate, the bot standing inside the hall: dug from the yard, never from in there
  const box = { x: 0, y: 62, z: 0, width: 20, height: 6, length: 20 };
  const blocks = Array.from({ length: box.width * box.height * box.length }, (_, i): string => (Math.floor(i / (box.width * box.length)) + box.y <= 63 ? 'stone' : 'air'));
  const target = at(10, 65, 12);
  blocks[(target.x - box.x) + (target.z - box.z) * box.width + (target.y - box.y) * box.width * box.length] = 'cobblestone';
  const run = async (keepOut?: (p: Pos) => boolean) => {
    const walks: Pos[] = [];
    let moved = false;
    const ctx = {
      ...blocksCtx(new Map()), world: w,
      call: (async (m: string, p: Record<string, number> = {}) => {
        if (m === 'goto') { walks.push(at(p.x, p.y, p.z)); moved = true; return { arrived: true, at: at(p.x, p.y, p.z) }; }
        if (m === 'dig.here') return moved ? { dug: true } : { dug: false, reason: 'out of reach' };
        return {};
      }) as GoalContext['call']
    } as GoalContext;
    t.is(await digByHand(ctx, blocks, box, target, { at: at(13, 64, 12) }, new Set(), keepOut), '');
    return walks;
  };
  const inHall = (p: Pos) => p.x >= 10 && p.x <= 15 && p.z >= 10 && p.z <= 15;
  t.true(inHall((await run())[0]), 'as before: the nearest spot, in the hall');
  const walks = await run(p => inHall(p));
  t.is(walks.length, 1);
  t.false(inHall(walks[0]));
});

// ------------------------------------------------------------------------------------------------ P: the pens

test('E21 P: the pens round and the cows fetch lead nothing through a gate while a villager is out; as ever with none', async (t) => {
  const { fetchForPens, pens, pensWait } = await import('../../src/client/brain/pens.js');
  const zones = { hall: [HALL], 'pen:cow': [{ x: 20, y: 63, z: 20, width: 5, length: 5 }], 'pen:cow:gate': [at(22, 64, 20)] };
  const w = (fetch?: FetchMemory) => world({ zones, lastDone: { pens: 0 }, ...(fetch ? { fetch } : {}) });
  const wait = { cause: 'hold', text: 'a villager is on its way: no animal led through a gate until it is in' };
  t.is(pensWait(snap(), w()), null);
  t.is(pensWait(snap(), w(record())), null);
  t.deepEqual(pensWait(snap(), w(out())), wait);
  t.regex(pens.wants(snap(), w(record())) ?? '', /the pens/);
  t.is(pens.wants(snap(), w(out())), null);
  t.deepEqual(pens.declines!(snap(), w(out())), wait);
  // an astray ward by the yard holds them too (two game days), a ward in the lock as well
  t.deepEqual(pensWait(snap(), w(record({ wards: [ward('astray', at(5, 64, 5))] }))), wait);
  t.deepEqual(pensWait(snap(), w(record({ wards: [ward('lock')] }))), wait);
  const calls: string[] = [];
  const ctx = { ...blocksCtx(new Map(), {}, calls), world: w(out()) } as GoalContext;
  t.deepEqual(await fetchForPens(ctx, 'north', { kind: 'cow' }), { gain: 0, text: `cow: ${wait.text}`, untried: true });
  t.deepEqual(calls, [], 'not a look, not a walk');
});
