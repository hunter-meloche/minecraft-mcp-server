import test from 'ava';
import { SURVIVAL } from '../../src/client/brain/brain.js';
import { outOfPit, pitOut, resetYardPit, type Region } from '../../src/client/brain/underyard.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { InventoryItem } from '../../src/client/tools.js';
import type { Pos } from '../../src/client/brain/memory.js';
import { HOME, T0, liveWorld, lookAt } from '../helpers/homestead.js';

/**
 * Out of a pit in the yard (Nov 19, 00:40Z): the pens' sheep round walked the bot into a hole 2 deep at
 * (-557, 61, 2199), two cells the homestead's repair had given up on. In the yard Baritone may break no ground and its
 * walks there piled nothing up: for 1.5 hours every chore failed 18 blocks from home, the shelter walled it in each
 * night and break out dug the wall away each morning, into the same hole. The blocks are the live ones round it.
 */

test.beforeEach(() => { resetYardPit(); });
const PIT: Pos = { x: -557, y: 61, z: 2199 };
const COBBLE: InventoryItem[] = [{ slot: 8, name: 'cobblestone', count: 47 }];

/** The live blocks from y 60 to 64, x -558..-556, z 2198..2200 (get-block-info at 02:20Z). */
function livePit(): Map<string, string> {
  const m = new Map<string, string>();
  for (let x = -558; x <= -556; x++) for (let z = 2198; z <= 2200; z++) {
    m.set(`${x},60,${z}`, 'dirt'); m.set(`${x},61,${z}`, 'dirt'); m.set(`${x},62,${z}`, 'grass_block');
    m.set(`${x},63,${z}`, 'air'); m.set(`${x},64,${z}`, 'air');
  }
  m.set('-557,60,2198', 'grass_block'); m.set('-557,60,2199', 'grass_block');
  m.set('-557,61,2198', 'air'); m.set('-557,61,2199', 'air'); m.set('-557,61,2200', 'cobblestone');
  m.set('-557,62,2198', 'cobblestone'); m.set('-557,62,2199', 'air');
  return m;
}
function regionOf(m: Map<string, string>, b: Region): (string | null)[] {
  const out: (string | null)[] = [];
  for (let y = b.y; y < b.y + b.height; y++) for (let z = b.z; z < b.z + b.length; z++) for (let x = b.x; x < b.x + b.width; x++) out.push(m.get(`${x},${y},${z}`) ?? null);
  return out;
}
const BOX: Region = { x: -558, y: 60, z: 2198, width: 3, height: 5, length: 3 };

test('the live pit: shut in on every side 2 under the lawn (its one open neighbour is 1 high), open over its head: 2 blocks up', (t) => {
  t.deepEqual(pitOut(regionOf(livePit(), BOX), BOX, PIT, 62), { climb: 2 });
  // the cobblestone over the open cell beside it gone: a way out on foot, no pit
  const side = livePit(); side.set('-557,62,2198', 'air');
  t.deepEqual(pitOut(regionOf(side, BOX), BOX, PIT, 62), { why: 'a way out of (-557, 61, 2199) by (-557, 61, 2198): no pit' });
  // a step up out of it (a cell open on the ground's level, ground under it)
  const step = livePit(); step.set('-556,62,2199', 'air');
  t.deepEqual(pitOut(regionOf(step, BOX), BOX, PIT, 62), { why: 'a way out of (-557, 61, 2199) by (-556, 62, 2199): no pit' });
  // something over its head: no pillar
  const roof = livePit(); roof.set('-557,64,2199', 'oak_planks');
  t.deepEqual(pitOut(regionOf(roof, BOX), BOX, PIT, 62), { why: 'oak_planks over its head at (-557, 64, 2199): no pillar up' });
});

test('out of a pit wants after 2 minutes still in the same cell 2 or more under the lawn of the yard, never on the lawn, under the yard or asleep', (t) => {
  const world = liveWorld();
  const at = (p: Pos, now: number, over: Partial<Snapshot> = {}) => outOfPit.wants(lookAt(COBBLE, 3000, { position: p, now, distHome: Math.hypot(p.x - HOME.x, p.z - HOME.z), ...over }), world);
  t.is(at(PIT, T0), null);
  t.is(at(PIT, T0 + 60_000), null);
  t.is(at(PIT, T0 + 125_000), '125s in the same cell 2 under the lawn at (-557, 61, 2199)');
  // by night too: the wall-in is no way out of it
  t.truthy(at(PIT, T0 + 130_000, { activity: 'rest', timeOfDay: 15_000 }));
  // moved: the clock starts again
  t.is(at({ ...PIT, z: 2198 }, T0 + 140_000), null);
  // 1 under the lawn is a step up, and the lawn is home
  resetYardPit();
  t.is(at({ ...PIT, y: 62 }, T0), null);
  t.is(at({ ...PIT, y: 62 }, T0 + 300_000), null);
  t.is(at({ ...HOME }, T0 + 600_000), null);
  // under the yard is out from under's; asleep, or out past the margin, it is not this
  t.is(at({ ...PIT, y: 40 }, T0 + 700_000), null);
  t.is(at({ ...PIT, y: 40 }, T0 + 900_000), null);
  t.is(at({ x: -480, y: 61, z: 2199 }, T0 + 1_000_000), null);
  t.is(at({ x: -480, y: 61, z: 2199 }, T0 + 1_200_000), null);
  t.is(at(PIT, T0 + 1_300_000, { sleeping: true }), null);
});

type Seen = { id: number; name: string; category: string; position: Pos; distance?: number };
function ctxIn(blocks: Map<string, string>, items = COBBLE, boxedIn?: Pos[], entities: Seen[] = []) {
  const calls: { method: string; p?: Record<string, unknown> }[] = [];
  const dug: Pos[] = [];
  const attacked: string[] = [];
  const s = lookAt(items, 3000, { position: { x: PIT.x + 0.5, y: PIT.y, z: PIT.z + 0.5 }, distHome: 18 });
  const ctx = {
    s, world: liveWorld(), signal: new AbortController().signal, progress: () => {}, gain: () => {},
    act: async (tool: string, a?: Record<string, unknown>) => {
      if (tool === 'attack-entity') {
        const e = entities.findIndex(x => `#${x.id}` === a!.target);
        attacked.push(entities[e].name);
        entities.splice(e, 1);
        return { ok: true, text: `Killed ${attacked.at(-1)} with 2 swing(s)` };
      }
      if (tool !== 'dig-block') return { ok: false, text: 'no such tool here' };
      const c = { x: a!.x as number, y: a!.y as number, z: a!.z as number };
      dug.push(c);
      blocks.set(`${c.x},${c.y},${c.z}`, 'air');
      return { ok: true, text: `Dug cobblestone at (${c.x}, ${c.y}, ${c.z})` };
    },
    status: async () => ({ position: s.position, ...(boxedIn ? { boxedIn } : {}) }),
    call: (async (method: string, p?: Record<string, unknown>) => {
      calls.push({ method, p });
      if (method === 'world.region') return { blocks: regionOf(blocks, p as unknown as Region) };
      if (method === 'inventory') return { items };
      if (method === 'world.entities') return { entities: [...entities] };
      if (method === 'pillar') return { placed: p!.count };
      throw new Error(`unexpected ${method}`);
    }) as GoalContext['call']
  } as unknown as GoalContext;
  return { ctx, calls, dug, attacked };
}

test('the live pit: the run pillars up 2 on its cobblestone, the lawn\'s level and a head over it looked at first', async (t) => {
  const { ctx, calls } = ctxIn(livePit());
  t.is(await outOfPit.run(ctx), 'pillared up out of a pit 2 deep at (-557, 61, 2199) on 2 cobblestone (the pit filled with it)');
  t.deepEqual(calls.find(c => c.method === 'world.region')!.p, BOX as unknown as Record<string, unknown>);
  t.deepEqual(calls.find(c => c.method === 'pillar')!.p, { item: 'cobblestone', count: 2 });
});

test('out of a pit: dirt first when carried; with too little of anything to fill with it says so; no pit, no pillar', async (t) => {
  const dirt = ctxIn(livePit(), [...COBBLE, { slot: 3, name: 'dirt', count: 5 }]);
  await outOfPit.run(dirt.ctx);
  t.deepEqual(dirt.calls.find(c => c.method === 'pillar')!.p, { item: 'dirt', count: 2 });
  const none = ctxIn(livePit(), [{ slot: 3, name: 'dirt', count: 1 }]);
  await t.throwsAsync(outOfPit.run(none.ctx), { message: 'nothing to pillar out of the pit at (-557, 61, 2199) with (2 of dirt, cobblestone, cobbled_deepslate carried)' });
  t.false(none.calls.some(c => c.method === 'pillar'));
  const open = livePit(); open.set('-557,62,2198', 'air');
  const walk = ctxIn(open);
  t.is(await outOfPit.run(walk.ctx), 'a way out of (-557, 61, 2199) by (-557, 61, 2198): no pit');
  t.false(walk.calls.some(c => c.method === 'pillar'));
});

test('out of a pit by night: the shelter\'s wall-in roofed it over with its own cobblestone; that roof is dug first, then the pillar; a roof not its own stays', async (t) => {
  const walled = livePit();
  walled.set('-557,63,2199', 'cobblestone');
  const roof = { x: -557, y: 63, z: 2199 };
  const own = ctxIn(walled, COBBLE, [{ x: -556, y: 63, z: 2199 }, roof]);
  t.is(await outOfPit.run(own.ctx), 'pillared up out of a pit 2 deep at (-557, 61, 2199) on 2 cobblestone (the pit filled with it)');
  t.deepEqual(own.dug, [roof]);
  // the box not its own (none listed): the roof stays, and no pillar into it
  const theirs = livePit();
  theirs.set('-557,63,2199', 'cobblestone');
  const other = ctxIn(theirs, COBBLE, []);
  await t.throwsAsync(outOfPit.run(other.ctx), { message: 'cobblestone over its head at (-557, 63, 2199): no pillar up' });
  t.deepEqual(other.dug, []);
  t.false(other.calls.some(c => c.method === 'pillar'));
});

test('out of a pit is survival: it cuts in on a run walking an animal on a lead (the pens\' round walked it in)', (t) => {
  t.true(SURVIVAL.has(outOfPit.name));
});

test('the live pit at 02:39Z: one of the yard\'s cows in it with the bot (no block goes in where a mob stands): the cow is culled, then the pillar; a wolf (someone\'s pet) is left and no pillar tried', async (t) => {
  const cow: Seen = { id: 7, name: 'cow', category: 'creature', position: { x: -556.6, y: 61, z: 2199.4 } };
  const by: Seen = { id: 8, name: 'sheep', category: 'creature', position: { x: -555.5, y: 63, z: 2199.5 } };
  // and the pens' animals the live look listed at the pit's cell but 30 away (none was within 4 for the fight)
  const far: Seen = { id: 9, name: 'cow', category: 'creature', position: { x: -556.5, y: 61, z: 2199.5 }, distance: 31 };
  const live = ctxIn(livePit(), COBBLE, undefined, [{ ...cow, distance: 0.5 }, by, far]);
  t.is(await outOfPit.run(live.ctx), 'pillared up out of a pit 2 deep at (-557, 61, 2199) on 2 cobblestone (the pit filled with it)');
  // the sheep on the lawn beside it is no matter
  t.deepEqual(live.attacked, ['cow']);
  const order = live.calls.map(c => c.method);
  t.true(order.indexOf('world.entities') < order.indexOf('pillar'));
  const wolf = ctxIn(livePit(), COBBLE, undefined, [{ ...cow, name: 'wolf' }]);
  await t.throwsAsync(outOfPit.run(wolf.ctx), { message: 'a wolf in the pit with it at (-557, 61, 2199): no pillar up' });
  t.deepEqual(wolf.attacked, []);
  t.false(wolf.calls.some(c => c.method === 'pillar'));
});
