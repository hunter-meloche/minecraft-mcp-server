import test from 'ava';
import { farm, kit, lightArea, lights, smelt, sortStorage, stash, stock, outsideBy, stockShort } from '../../src/client/brain/chores.js';
import { food, makeRod, readyFoodPoints } from '../../src/client/brain/food.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';
import type { InventoryItem } from '../../src/client/tools.js';

const CHEST = { x: 1, y: 64, z: 0 };
const world = (over: Partial<WorldMemory> = {}): WorldMemory => ({
  landmarks: { chests: [CHEST], farmland: [], furnace: { x: -1, y: 64, z: 0 } }, leash: 96, chestItems: { '1,64,0': {} }, ...over
});
const snap = (items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot => {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return {
    now: 10 * 60 * 60_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items, counts, slotsUsed: items.filter(i => i.slot < 36).length,
    home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, ...over
  };
};
const gear = (): InventoryItem[] => ['stone_pickaxe', 'stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword', 'stone_hoe']
  .map((name, slot): InventoryItem => ({ slot, name, count: 1, damage: 0, maxDamage: 131 }))
  .concat(['iron_boots', 'iron_leggings', 'iron_chestplate', 'iron_helmet'].map((name, i) => ({ slot: 36 + i, name, count: 1, damage: 0, maxDamage: 200 })))
  .concat([{ slot: 10, name: 'torch', count: 20 }, { slot: 11, name: 'cobblestone', count: 40 }, { slot: 12, name: 'bread', count: 5 }]);

test('ready food counts cooked food and bread, not raw meat or poison', (t) => {
  t.is(readyFoodPoints(new Map([['bread', 2], ['cooked_cod', 1], ['beef', 5], ['pufferfish', 3], ['rotten_flesh', 4]])), 2 * 5 + 5);
  t.is(food.wants(snap([{ slot: 0, name: 'bread', count: 4 }]), world()), null); // 20 points: enough
  t.regex(food.wants(snap([{ slot: 0, name: 'bread', count: 1 }]), world()) ?? '', /carrying 5 food points/);
  // at night only from home
  t.is(food.wants(snap([], { activity: 'rest', distHome: 40 }), world()), null);
});

test('stash: when nearly full, or now and then with things to put away; never away from home', (t) => {
  const junk = Array.from({ length: 22 }, (_, i) => ({ slot: 13 + i, name: `oak_log`, count: 64 }));
  t.regex(stash.wants(snap([...gear(), ...junk]), world()) ?? '', /slots used/);
  t.is(stash.wants(snap([...gear(), ...junk], { distHome: 60 }), world()), null);
  t.is(stash.wants(snap(gear()), world()), null);
  t.regex(stash.wants(snap([...gear(), ...junk.slice(0, 3).map((j, i) => ({ ...j, name: ['oak_log', 'bone', 'string'][i] }))]), world()) ?? '', /3 kinds/);
  t.is(stash.wants(snap([...gear(), ...junk.slice(0, 3).map((j, i) => ({ ...j, name: ['oak_log', 'bone', 'string'][i] }))]),
    world({ lastDone: { stash: 10 * 60 * 60_000 - 60_000 } })), null); // put away a minute ago
});

test('stash: makes room when a build job materials trip waits on the pockets (stock sets out under 30 slots)', (t) => {
  const seeds = Array.from({ length: 22 }, (_, i) => ({ slot: 13 + i, name: 'wheat_seeds', count: 64 }));
  const items = [...gear(), ...seeds]; // 31 slots
  const job = { id: 5, world: 'w', structure: 'home', mode: 'repair' as const, status: 'gathering' as const, createdAt: 0, updatedAt: 0, need: { oak_log: 77 }, carry: ['oak_log'] };
  t.is(stock.wants(snap(items), world({ buildJobs: [job] })), null); // too full to set out
  t.regex(stash.wants(snap(items), world({ buildJobs: [job] })) ?? '', /a materials trip waits for room/);
  // from the job's site too, 24 blocks out (the plain at-home stash doesn't go that far)
  t.regex(stash.wants(snap(items, { distHome: 24 }), world({ buildJobs: [job] })) ?? '', /a materials trip waits for room/);
  t.is(stash.wants(snap(gear(), { distHome: 24 }), world({ buildJobs: [job] })), null);
});

test('smelt: raw ore and fuel at home', (t) => {
  t.regex(smelt.wants(snap([{ slot: 0, name: 'raw_iron', count: 5 }, { slot: 1, name: 'coal', count: 1 }]), world()) ?? '', /5 raw_iron/);
  // no fuel: nothing to smelt, but a furnace not looked at in half an hour gets its finished smelting taken out
  t.regex(smelt.wants(snap([{ slot: 0, name: 'raw_iron', count: 5 }]), world()) ?? '', /check the furnace/);
  const s = snap([{ slot: 0, name: 'raw_iron', count: 5 }]);
  t.is(smelt.wants(s, world({ lastDone: { furnace: s.now - 60_000 } })), null);
});

test('kit: looks in unknown chests first, then wants only what it can take or craft', (t) => {
  t.is(kit.wants(snap(gear()), world({ chestItems: {} })), 'look in the home chests');
  t.is(kit.wants(snap(gear()), world()), null);
  const noAxe = gear().filter(i => i.name !== 'stone_axe');
  t.is(kit.wants(snap(noAxe.filter(i => i.name !== 'cobblestone')), world()), null); // nothing to make it from: stock's job
  t.regex(kit.wants(snap(noAxe.concat([{ slot: 20, name: 'stick', count: 4 }])), world()) ?? '', /axe \(missing\)/);
});

test('stock: the kit\'s gathering first, then the home stock; by day, fit and not too late', (t) => {
  const s = snap(gear().filter(i => i.name !== 'stone_axe' && i.name !== 'cobblestone'));
  const short = stockShort(s, world({ chestItems: { '1,64,0': { oak_log: 40, coal: 20, iron_ingot: 20 } } }));
  t.deepEqual(short.map(x => x.name), ['cobblestone']);
  t.regex(stock.wants(s, world()) ?? '', /short of .*cobblestone/);
  t.is(stock.wants(snap(gear(), { timeOfDay: 10_000 }), world()), null); // too late
  t.is(stock.wants(snap(gear(), { health: 9 }), world()), null);
  t.is(stock.wants(snap(gear()), world({ chestItems: {} })), null); // chests not looked in yet
});

test('lights: torches checked against the real light; one that lit nothing comes back up, and that spot is left out', async (t) => {
  // a 33 x 13 x 33 yard from (-16, 60, -16): dirt at y 60, dark everywhere; real light comes from placed torches
  // (14 less the taxicab distance), except one walled-off cell that stays dark whatever is placed
  const W = 33, H = 13, L = 33, ox = -16, oy = 60, oz = -16;
  const blocks = new Array(W * H * L).fill('air');
  for (let i = 0; i < W * L; i++) blocks[i] = 'dirt';
  const torches: { x: number; y: number; z: number }[] = [];
  const walled = { x: 16, y: 61, z: 16 };
  const light = () => blocks.map((_, i) => {
    const x = ox + i % W, y = oy + Math.floor(i / (W * L)), z = oz + Math.floor(i / W) % L;
    if (x === walled.x && y === walled.y && z === walled.z) return 0;
    return Math.max(0, ...torches.map(p => 14 - Math.abs(p.x - x) - Math.abs(p.y - y) - Math.abs(p.z - z)));
  });
  const acts: string[] = [];
  const w = world();
  const ctx = {
    s: snap([{ slot: 0, name: 'torch', count: 20 }]), world: w, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      const p = { x: Number(a.x), y: Number(a.y), z: Number(a.z) };
      acts.push(`${tool} ${p.x},${p.y},${p.z}`);
      if (tool === 'place-block') torches.push(p);
      if (tool === 'dig-block') torches.splice(torches.findIndex(q => q.x === p.x && q.y === p.y && q.z === p.z), 1);
      return { ok: true, text: tool === 'place-block' ? `Placed torch at (${p.x}, ${p.y}, ${p.z})` : 'Dug torch' };
    },
    call: (async (m: string) => (m === 'world.region' ? { blocks } : { block: light() })) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined
  } as GoalContext;
  t.regex(lights.wants(ctx.s, ctx.world) ?? '', /daily round/);
  const r = await lights.run(ctx);
  t.regex(r, /^yard: placed \d+ torch\(es\); 1 of \d+ dark spot\(s\) left \(left out from now on\)$/);
  t.true(acts.filter(a => a.startsWith('place-block')).every(a => / -?\d+,61,-?\d+$/.test(a)));
  t.deepEqual(w.darkIgnore, ['16,61,16']);
  t.is(lights.wants(ctx.s, ctx.world), null); // done for today
  // the next day: nothing left that a torch could do
  ctx.s = { ...ctx.s, now: ctx.s.now + 21 * 60_000 };
  acts.length = 0;
  t.is(await lights.run(ctx), 'the yard is lit');
  t.deepEqual(acts, []);
});

test('farm: a daily round from the middle of the farmland, wheat baked into bread', async (t) => {
  const w = world({ landmarks: { chests: [CHEST], farmland: [{ x: 4, y: 63, z: 4 }, { x: 6, y: 63, z: 4 }], furnace: undefined } });
  const s = snap(gear());
  t.is(farm.wants(s, w), 'daily round: the farm');
  const acts: string[] = [];
  const ctx = {
    s, world: w, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown> = {}) => { acts.push(`${tool} ${JSON.stringify(a)}`); return { ok: true, text: tool === 'farm' ? 'Harvested wheat x7' : 'ok' }; },
    call: (async () => ({ items: [{ slot: 3, name: 'wheat', count: 7 }] })) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined
  } as GoalContext;
  t.is(await farm.run(ctx), 'Harvested wheat x7; baked 2 bread');
  t.deepEqual(acts.map(a => a.split(' ')[0]), ['move-to-position', 'farm', 'craft-item']);
  t.regex(acts[0], /"x":5,"y":64,"z":4/);
  t.is(farm.wants(s, w), null);
});

test('stock: a trip that found nothing leaves that resource alone for a while', async (t) => {
  const s = snap(gear());
  const w = world({ chestItems: { '1,64,0': { oak_log: 40, cobblestone: 64, iron_ingot: 20 } } });
  t.deepEqual(stockShort(s, w).map(x => x.name), ['coal']);
  const ctx = {
    s, world: w, signal: new AbortController().signal,
    act: async (tool: string) => ({ ok: true, text: tool === 'mine-blocks' ? 'Stopped after 360s (time limit): nothing gained.' : 'Home' }),
    call: (async () => ({})) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined
  } as GoalContext;
  await stock.run(ctx);
  t.deepEqual(stockShort(s, w), []);
  t.deepEqual(stockShort({ ...s, now: s.now + 31 * 60_000 }, w).map(x => x.name), ['coal']);
});

test('lightArea: a torch that lights nothing dark is taken back up', async (t) => {
  // one spot a mob could stand on, walled off from any light; the plan's torch goes on it and does nothing
  const box = { x: -16, y: 60, z: -16, width: 33, height: 13, length: 33 };
  const blocks = new Array(box.width * box.height * box.length).fill('air');
  blocks[16 + 16 * box.width] = 'dirt'; // (0, 60, 0)
  const acts: string[] = [];
  const io = {
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      acts.push(`${tool} ${a.x},${a.y},${a.z}`);
      return { ok: true, text: tool === 'place-block' ? 'Placed torch at (0, 61, 0)' : 'Dug torch' };
    },
    call: (async (m: string) => (m === 'world.region' ? { blocks } : { block: new Array(blocks.length).fill(0) })) as GoalContext['call']
  };
  const r = await lightArea(io, { x: 0, y: 64, z: 0 }, 16, { place: true, max: 5, ignore: new Set() });
  t.deepEqual(acts, ['place-block 0,61,0', 'dig-block 0,61,0']);
  t.deepEqual(r.undone, [{ x: 0, y: 61, z: 0 }]);
  t.deepEqual(r.left, [{ x: 0, y: 61, z: 0 }]);
  t.deepEqual((await lightArea(io, { x: 0, y: 64, z: 0 }, 16, { place: false, max: 5, ignore: new Set(['0,61,0']) })).dark, []);
});

test('makeRod: string and sticks from the chest, then a fishing rod', async (t) => {
  const inv = new Map<string, number>([['oak_planks', 4]]);
  const acts: string[] = [];
  const chest: Record<string, number> = { string: 12, stick: 1 };
  const w = world({ chestItems: { '1,64,0': { ...chest } } });
  const ctx = {
    world: w, s: snap([]), signal: new AbortController().signal, progress: () => undefined,
    call: (async () => ({ items: [...inv].map(([name, count], slot) => ({ slot, name, count })) })) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      acts.push(`${tool} ${a.item ?? a.outputItem} ${a.count ?? a.amount}`);
      if (tool === 'take-from-chest') {
        const item = String(a.item), n = Math.min(Number(a.count), chest[item] ?? 0);
        chest[item] -= n;
        inv.set(item, (inv.get(item) ?? 0) + n);
        return { ok: true, text: `Took ${n} ${item} from the chest at (1, 64, 0). It holds: ${Object.entries(chest).filter(([, k]) => k > 0).map(([k, v]) => `${k} x${v}`).join(', ')}.` };
      }
      if (a.outputItem === 'stick') inv.set('stick', (inv.get('stick') ?? 0) + 4);
      return { ok: true, text: 'Successfully crafted' };
    }
  } as unknown as GoalContext;
  t.true(await makeRod(ctx));
  // one stick in the chest: the other two come from planks
  t.deepEqual(acts, ['take-from-chest string 2', 'take-from-chest stick 3', 'craft-item stick 1', 'craft-item fishing_rod 1']);
});

test('sort: things in the wrong chest go to their own', async (t) => {
  const chests = [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }];
  const contents: Record<string, Record<string, number>> = { '1,64,0': { cobblestone: 64, oak_log: 10 }, '2,64,0': { oak_planks: 5 }, '3,64,0': {} };
  const w = world({ landmarks: { chests, farmland: [] }, chestItems: contents, chestAssign: { '1,64,0': 'stone', '2,64,0': 'wood', '3,64,0': 'ores' } });
  t.regex(sortStorage.wants(snap(gear()), w) ?? '', /wrong chest/);
  const acts: string[] = [];
  const reply = (k: string) => `It holds: ${Object.entries(contents[k]).filter(([, v]) => v > 0).map(([n, v]) => `${n} x${v}`).join(', ') || 'nothing'}.`;
  const ctx = {
    s: snap(gear()), world: w, signal: new AbortController().signal, progress: () => undefined,
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    call: (async (m: string, p: Record<string, number>) => {
      if (m === 'chest.open') return { items: contents[`${p.x},${p.y},${p.z}`] };
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      const k = `${a.x},${a.y},${a.z}`, item = String(a.item), n = Number(a.count);
      acts.push(`${tool} ${k} ${item} ${n}`);
      if (tool === 'take-from-chest') { contents[k][item] -= n; return { ok: true, text: `Took ${n} ${item} from the chest. ${reply(k)}` }; }
      contents[k][item] = (contents[k][item] ?? 0) + n;
      return { ok: true, text: `Stored ${n} ${item} in the chest. ${reply(k)}` };
    }
  } as unknown as GoalContext;
  t.is(await sortStorage.run(ctx), 'moved 1 kind(s) of things to their own chest');
  t.deepEqual(acts, ['take-from-chest 1,64,0 oak_log 10', 'store-in-chest 2,64,0 oak_log 10']);
  t.is(sortStorage.wants(snap(gear()), w), null);
});

test('outsideBy: 0 inside the yard, else how far past its edge', (t) => {
  const yard = { x1: 0, z1: 0, x2: 10, z2: 20 };
  t.is(outsideBy(yard, { x: 5, z: 5 }), 0);
  t.is(outsideBy(yard, { x: -3, z: 5 }), 3);
  t.is(outsideBy(yard, { x: 12, z: 30 }), 10);
});

test('dumpSpot: 8 out from the side the bot walks least', async (t) => {
  const { dumpSpot } = await import('../../src/client/brain/chores.js');
  const { HeatMap } = await import('../../src/client/brain/paths.js');
  const yard = { x1: 0, z1: 0, x2: 20, z2: 10, y: 64 };
  const heat = new HeatMap();
  // the walk south to the lake, west and north: east is the quiet side
  for (let i = 0; i < 20; i++) { heat.visit({ x: 10, z: 18 + (i % 2) }); heat.visit({ x: -8 + (i % 2), z: 5 }); heat.visit({ x: 10, z: -8 + (i % 2) }); }
  t.deepEqual(dumpSpot(yard, heat), { x: 28, y: 65, z: 5 });
  // all four, quietest first: the next to try when one can't be reached (the east one was in a stone hill)
  const { dumpSpots } = await import('../../src/client/brain/chores.js');
  const all = dumpSpots(yard, heat);
  t.is(all.length, 4);
  t.deepEqual(all[0], { x: 28, y: 65, z: 5 });
});

test('smelt: ore still carried after the smelt is a failure, not "done" (the 7 raw copper smelted every 5 seconds)', async (t) => {
  const items = [{ slot: 0, name: 'raw_copper', count: 7 }, { slot: 1, name: 'coal', count: 3 }];
  const s = snap(items);
  const ctx = {
    s, world: world({ lastDone: { furnace: s.now } }), signal: new AbortController().signal,
    act: async () => ({ ok: true, text: 'Furnace input slot is occupied by raw_iron' }),
    call: (async (m: string) => {
      if (m === 'inventory') return { items };
      if (m === 'furnace.open') return { open: true, output: null, input: null, lit: true };
      return {};
    }) as never,
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined
  };
  await t.throwsAsync(smelt.run(ctx as never), { message: /could not smelt raw_copper: Furnace input slot is occupied/ });
});
