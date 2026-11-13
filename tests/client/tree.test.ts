import test from 'ava';
import { gatesKept, sideCells } from '../../src/client/brain/tree.js';

// the live yard, grown 16 east (x2 -32 -> -16)
const old = { x1: -65, z1: -31, x2: -32, z2: -6 };
const grown = { ...old, x2: -16 };
const gates = [{ x: -48, z: -31 }, { x: -32, z: -18 }, { x: -48, z: -6 }, { x: -52, z: -6 }, { x: -65, z: -18 }];

test('gatesKept: gates on the sides that stay keep their place; the moved side\'s go straight out', (t) => {
  const kept = gatesKept(grown, gates, 'east');
  t.deepEqual(kept, [
    { side: 'north', offset: 17 }, { side: 'east', offset: 13 }, { side: 'south', offset: 17 }, { side: 'south', offset: 13 }, { side: 'west', offset: 13 }
  ]);
});

test('sideCells: the old east side, corners included', (t) => {
  const cells = sideCells(old, 'east');
  t.is(cells.length, 26);
  t.deepEqual(cells[0], { x: -32, z: -31 });
  t.deepEqual(cells[25], { x: -32, z: -6 });
});

test('outerBand: two blocks all round outside the yard, corners in the north and south strips', async (t) => {
  const { outerBand } = await import('../../src/client/brain/tree.js');
  const band = outerBand({ x1: 0, z1: 0, x2: 9, z2: 4 });
  t.deepEqual(band, [
    { x1: -2, z1: -2, x2: 11, z2: -1 }, { x1: -2, z1: 5, x2: 11, z2: 6 }, { x1: -2, z1: 0, x2: -1, z2: 4 }, { x1: 10, z1: 0, x2: 11, z2: 4 }
  ]);
  const cells = band.reduce((a, b) => a + (b.x2 - b.x1 + 1) * (b.z2 - b.z1 + 1), 0);
  t.is(cells, 14 * 9 - 10 * 5);
});

test('sideOf: the storage house door on its south wall', async (t) => {
  const { sideOf } = await import('../../src/client/brain/tree.js');
  const site = { x: -63, z: -24, width: 7, length: 9 };
  t.is(sideOf(site, { x: -60, z: -16 }), 'south');
  t.is(sideOf(site, { x: -60, z: -24 }), 'north');
  t.is(sideOf(site, { x: -57, z: -20 }), 'east');
});

test('quarters: the yard in four pieces, every column in exactly one', async (t) => {
  const { quarters } = await import('../../src/client/brain/tree.js');
  const yard = { x1: -565, z1: 2167, x2: -533, z2: 2199 };
  const q = quarters(yard);
  t.is(q.length, 4);
  let cols = 0;
  for (let x = yard.x1; x <= yard.x2; x++) for (let z = yard.z1; z <= yard.z2; z++) {
    const n = q.filter(b => x >= b.x1 && x <= b.x2 && z >= b.z1 && z <= b.z2).length;
    t.is(n, 1, `(${x}, ${z})`);
    cols++;
  }
  t.is(cols, 33 * 33);
});

test('yard-level: comes after the ground outside the fence, levels each quarter to the yard, done for this yard', async (t) => {
  const { TREE } = await import('../../src/client/brain/tree.js');
  const m = TREE.find(x => x.id === 'yard-level')!;
  t.deepEqual(m.prereqs, ['fence-clear']);
  const yard = { x1: 0, z1: 0, x2: 9, z2: 9, y: 64 };
  const world = { yard, landmarks: { chests: [], farmland: [] }, leash: 96 } as never as import('../../src/client/brain/memory.js').WorldMemory;
  const levelled: string[] = [];
  const ctx = {
    world, signal: new AbortController().signal, progress: () => undefined,
    call: (async () => ({})) as never,
    act: async (tool: string, a: Record<string, unknown>) => { levelled.push(`${tool} ${a.x1},${a.z1}..${a.x2},${a.z2} at ${a.level}`); return { ok: true, text: 'Now level' }; }
  } as never;
  const st = { data: {} } as never as import('../../src/client/brain/progress.js').MilestoneState;
  t.false(m.done!({ world } as never));
  const r = await m.steps[0].run(ctx, st);
  t.is(r.status, 'done');
  t.deepEqual(levelled, ['level-area 0,0..4,4 at 64', 'level-area 5,0..9,4 at 64', 'level-area 0,5..4,9 at 64', 'level-area 5,5..9,9 at 64']);
  t.true(m.done!({ world } as never));
});

test('fence-clear: due again once the yard has grown and its fence is round it again', async (t) => {
  const { TREE } = await import('../../src/client/brain/tree.js');
  const m = TREE.find(x => x.id === 'fence-clear')!;
  type W = import('../../src/client/brain/memory.js').WorldMemory;
  // the live yard: cleared round when it was z 2167..2199, grown four times since to 2119..2215 (the north gate on a hill)
  const yard = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
  const world = { yard, fenceClearFor: '-565,2167,-533,2199', landmarks: { chests: [], farmland: [] }, leash: 96 } as never as W;
  t.false(m.done!({ world } as never));
  t.true(m.again!({ world } as never));
  // the fence still to move: not yet (the band goes outside the new fence)
  const moving = { ...world, fenceMove: { side: 'north', old: { ...yard, z1: 2135 } } } as never as W;
  t.false(m.again!({ world: moving } as never));
  // cleared round this yard: done, and not due again
  const cleared = { ...world, fenceClearFor: '-565,2119,-533,2215' } as never as W;
  t.true(m.done!({ world: cleared } as never));
  t.false(m.again!({ world: cleared } as never));
});

type Strip = { x1: number; z1: number; x2: number; z2: number };
const LEVEL = 'Level (0, 0)..(9, 4) to ground y 64: cut 0 block(s), fill 0 dirt + 0 cobblestone; left alone: 0 water column(s), 0 column(s) with builds, crops or furniture.';
/**
 * The band's step as level-area answers it: `dry` is its dry run's fill for a side, `level` what levelling that side
 * comes back with (each strip by its corners); the inventory and the chests as given, take-from-chest taking what a
 * chest holds.
 */
function band(world: import('../../src/client/brain/memory.js').WorldMemory, opts: {
  dry?: (s: Strip) => string; level?: (s: Strip) => { ok: boolean; text: string }; inventory?: { name: string; count: number; slot: number }[];
} = {}) {
  const levelled: string[] = [];
  const took: string[] = [];
  const inventory = opts.inventory ?? [];
  const ctx = {
    world, s: { now: 1e9 }, signal: new AbortController().signal, progress: () => undefined,
    call: (async (m: string) => (m === 'inventory' ? { items: inventory } : {})) as never,
    act: async (tool: string, a: Record<string, unknown>) => {
      const s = a as unknown as Strip;
      if (tool === 'level-area' && a.dryRun) return { ok: true, text: opts.dry?.(s) ?? LEVEL };
      if (tool === 'level-area') {
        levelled.push(`${s.x1},${s.z1}..${s.x2},${s.z2} at ${a.level}`);
        return opts.level?.(s) ?? { ok: true, text: `${LEVEL}\nWorked 1/1 tile(s) of 8x8 in 3s. Now level.` };
      }
      if (tool === 'take-from-chest') {
        const held = world.chestItems?.[`${a.x},${a.y},${a.z}`]?.[String(a.item)] ?? 0;
        const n = Math.min(held, Number(a.count));
        took.push(`${n} ${a.item}`);
        inventory.push({ name: String(a.item), count: n, slot: 20 + inventory.length });
        return { ok: true, text: `Took ${n} ${a.item}. It holds: nothing.` };
      }
      return { ok: false, text: `unexpected ${tool}` };
    }
  } as never;
  return { ctx, levelled, took };
}

test('fence-clear: set aside midway and the yard grown since, it clears the new band whole', async (t) => {
  const { TREE } = await import('../../src/client/brain/tree.js');
  const m = TREE.find(x => x.id === 'fence-clear')!;
  // its north and south sides cleared for the yard as it was (0..9 by 0..9); the yard is 0..9 by 0..4 now
  const world = { yard: { x1: 0, z1: 0, x2: 9, z2: 4, y: 64 }, landmarks: { chests: [], farmland: [] }, leash: 96 } as never as import('../../src/client/brain/memory.js').WorldMemory;
  const st = { step: 0, data: { for: '0,0,9,9', strips: [0, 1] } };
  const { ctx, levelled } = band(world);
  t.like(await m.steps[0].run(ctx, st), { status: 'done' });
  t.deepEqual(levelled, ['-2,-2..11,-1 at 64', '-2,5..11,6 at 64', '-2,0..-1,4 at 64', '10,0..11,4 at 64']);
  t.deepEqual(st.data, { for: '0,0,9,4', strips: [0, 1, 2, 3] });
  t.is(world.fenceClearFor, '0,0,9,4');
});

test('fence-clear: a side\'s fill out of the chests first; short still, it waits for the stock trips and leaves the room\'s record be', async (t) => {
  const { TREE } = await import('../../src/client/brain/tree.js');
  const m = TREE.find(x => x.id === 'fence-clear')!;
  const chest = { x: 1, y: 64, z: 0 };
  // live 2026-11-13: the room's record (38 leather short) is what the cow search goes by
  const room = { id: 'enchanting/2', n: 125, at: 1e9 - 60_000, need: { leather: 45 } };
  const world = {
    yard: { x1: 0, z1: 0, x2: 9, z2: 4, y: 64 }, landmarks: { chests: [chest], farmland: [] }, leash: 96, chestItems: { '1,64,0': { dirt: 3 } },
    progress: { done: [], journal: [], blocked: room, need: { leather: 38 } }
  } as never as import('../../src/client/brain/memory.js').WorldMemory;
  const st = { step: 0, data: {} as Record<string, unknown> };
  // the east side dips: 5 dirt to fill it, 3 in the chests, none carried
  const dry = (s: Strip) => (s.x1 === 10 ? LEVEL.replace('fill 0 dirt', 'fill 5 dirt') : LEVEL);
  const short = band(world, { dry });
  const r = await m.steps[0].run(short.ctx, st);
  t.like(r, { status: 'blocked', retryMs: 10 * 60_000 });
  t.regex(r.text, /^side 4: short of 2 dirt to fill it/);
  t.deepEqual(short.took, ['3 dirt']);
  t.deepEqual(short.levelled, ['-2,-2..11,-1 at 64', '-2,5..11,6 at 64', '-2,0..-1,4 at 64'], 'the east side not begun');
  t.deepEqual(world.progress?.need, { dirt: 2 });
  t.is(world.progress?.blocked, room);
  t.false('need' in r, 'not the back-off record: that stays the room\'s');
  // what it took out of the chests is the band's: the stash throws none of it away
  t.deepEqual(world.progress?.fill, ['dirt', 'cobblestone', 'cobbled_deepslate']);
  // the stock trips brought the dirt: the east side is filled, the band done, the met need and the marks gone
  const done = band(world, { dry, inventory: [{ name: 'dirt', count: 5, slot: 3 }] });
  t.like(await m.steps[0].run(done.ctx, st), { status: 'done' });
  t.deepEqual(done.levelled, ['10,0..11,4 at 64']);
  t.is(world.progress?.need, undefined);
  t.is(world.progress?.fill, undefined);
  t.is(world.fenceClearFor, '0,0,9,4');
});

test('fence-clear: a side\'s cobblestone fill comes out of the chests though deepslate is carried; level-area fills with plain cobblestone only', async (t) => {
  const { TREE } = await import('../../src/client/brain/tree.js');
  const m = TREE.find(x => x.id === 'fence-clear')!;
  const chest = { x: 1, y: 64, z: 0 };
  // the chests' 865 cobblestone as brain.json had them on Nov 13
  const world = {
    yard: { x1: 0, z1: 0, x2: 9, z2: 4, y: 64 }, landmarks: { chests: [chest], farmland: [] }, leash: 96, chestItems: { '1,64,0': { cobblestone: 865 } }
  } as never as import('../../src/client/brain/memory.js').WorldMemory;
  // the east side's crater takes 20 cobblestone; the pockets hold a deep trip's 64 deepslate and no cobblestone
  const crater = 'fill 0 dirt + 20 cobblestone';
  const dry = (s: Strip) => (s.x1 === 10 ? LEVEL.replace('fill 0 dirt + 0 cobblestone', crater) : LEVEL);
  const inventory = [{ name: 'cobbled_deepslate', count: 64, slot: 3 }];
  // level-area as tools.ts has it: a tile is filled only with that much plain cobblestone carried, else nothing is placed
  const level = (s: Strip) => (s.x1 !== 10 || inventory.some(i => i.name === 'cobblestone' && i.count >= 20)
    ? { ok: true, text: `${LEVEL}\nWorked 1/1 tile(s) of 8x8 in 3s. Now level.` }
    : { ok: false, text: `Failed: ${LEVEL.replace('fill 0 dirt + 0 cobblestone', crater)}\nWorked 1/1 tile(s) of 8x8 in 3s. Still to do: cut 0, fill 0 dirt (have 0) + 20 cobblestone (have 0). Run level-area again to continue.` });
  const { ctx, took, levelled } = band(world, { dry, level, inventory });
  t.like(await m.steps[0].run(ctx, { step: 0, data: {} }), { status: 'done' });
  t.deepEqual(took, ['20 cobblestone']);
  t.is(levelled.at(-1), '10,0..11,4 at 64');
  t.is(world.fenceClearFor, '0,0,9,4');
});

test('fence-clear: a side that got somewhere goes on next run; one that got nowhere waits, so the work queue gets its turn', async (t) => {
  const { TREE } = await import('../../src/client/brain/tree.js');
  const m = TREE.find(x => x.id === 'fence-clear')!;
  const world = () => ({ yard: { x1: 0, z1: 0, x2: 9, z2: 4, y: 64 }, landmarks: { chests: [], farmland: [] }, leash: 96 }) as never as import('../../src/client/brain/memory.js').WorldMemory;
  const hill = (left: number) => ({
    ok: false,
    text: `Failed: ${LEVEL.replace('cut 0 block(s)', 'cut 12 block(s) (ground 12)')}\nWorked 2/2 tile(s) of 8x8 in 360s. Still to do: cut ${left}, fill 0 dirt (have 0) + 0 cobblestone (have 0). Run level-area again to continue.`
  });
  // the north hill, 8 of its 12 cut in the run's 6 minutes; nothing to fill, so what it digs is not marked (the stash
  // may throw the chests' glut of dirt and stone away as ever)
  const hillOnly = world();
  const some = await m.steps[0].run(band(hillOnly, { level: () => hill(4) }).ctx, { step: 0, data: {} });
  t.like(some, { status: 'progress' });
  t.regex(some.text, /^side 1: Worked 2\/2 tile/);
  t.is(hillOnly.progress?.fill, undefined);
  // a side with a dip to fill: its fill carried stays the band's until it is placed
  const dip = { dry: () => LEVEL.replace('fill 0 dirt', 'fill 2 dirt'), inventory: [{ name: 'dirt', count: 5, slot: 3 }] };
  const going = world();
  t.like(await m.steps[0].run(band(going, { ...dip, level: () => hill(4) }).ctx, { step: 0, data: {} }), { status: 'progress' });
  t.deepEqual(going.progress?.fill, ['dirt', 'cobblestone', 'cobbled_deepslate']);
  // none of it cut (a block it cannot break), or the area not loaded: it waits, and its fill is plain stone meanwhile
  const stuck = world();
  t.like(await m.steps[0].run(band(stuck, { ...dip, level: () => hill(12) }).ctx, { step: 0, data: {} }), { status: 'blocked', retryMs: 30 * 60_000 });
  t.is(stuck.progress?.fill, undefined);
  const unloaded = { ok: false, text: 'Failed: Part of the area is not loaded; move closer to it first' };
  t.like(await m.steps[0].run(band(world(), { level: () => unloaded }).ctx, { step: 0, data: {} }), { status: 'blocked', retryMs: 30 * 60_000 });
});

test('the live homestead, its band still the first yard\'s: the band first, the room set aside at its build step with its site kept, then back to it', async (t) => {
  const { TREE } = await import('../../src/client/brain/tree.js');
  const { projectGoal } = await import('../../src/client/brain/project.js');
  const { keptSites } = await import('../../src/client/structures/site.js');
  const { liveWorld, lookAt, pocketsOf, withProject } = await import('../helpers/homestead.js');
  // brain.json as it stood on Nov 13: the yard grown four times since the band was cleared round its first box
  const w = withProject(liveWorld(), false);
  w.fenceClearFor = '-565,2167,-533,2199';
  const room = structuredClone(w.progress!.current!);
  const s = lookAt(pocketsOf(10, true, 'kept things only'), 1000);
  const goal = projectGoal(TREE);
  t.is(goal.wants(s, w), 'clear ground outside the fence: level 2 blocks outside the fence');
  const levelled: string[] = [];
  const ctx = {
    s, world: w, signal: new AbortController().signal, progress: () => undefined, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    call: (async (m: string) => (m === 'inventory' ? { items: s.items } : {})) as never,
    act: async (tool: string, a: Record<string, unknown>) => {
      if (tool === 'level-area' && a.dryRun) return { ok: true, text: `${LEVEL}` };
      if (tool === 'level-area') { levelled.push(`${a.x1}..${a.x2}, ${a.z1}..${a.z2} at ${a.level}`); return { ok: true, text: `${LEVEL}\nWorked 1/1 tile(s) of 8x8 in 3s. Now level.` }; }
      return { ok: false, text: `unexpected ${tool}` };
    }
  } as never;
  t.is(await goal.run(ctx), 'clear ground outside the fence complete');
  // the north side the hill outside the north gate, z 2117..2118; the whole band 2 wide round the 33 x 97 yard
  t.deepEqual(levelled, ['-567..-531, 2117..2118 at 62', '-567..-531, 2216..2217 at 62', '-567..-566, 2119..2215 at 62', '-532..-531, 2119..2215 at 62']);
  t.is(w.fenceClearFor, '-565,2119,-533,2215');
  t.true(w.progress!.done.includes('fence-clear'));
  t.is(w.progress!.current, undefined);
  t.deepEqual(w.progress!.aside, { enchanting: { step: 2, data: room.data } });
  // its 7 x 7 site stays reserved meanwhile (structure-site, the woods, the cane keep off it)
  t.true(keptSites(w).some(b => b.x === -547 && b.z === 2206 && b.width === 7));
  // and the room comes back at its build step, the same site
  t.is(goal.wants(s, w), 'an enchanting room: build the enchanting room');
});
