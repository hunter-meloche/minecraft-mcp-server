import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { atCaps, farm, larderFull, mineDrops, putAway, stash, stashKeep, stashList } from '../../src/client/brain/chores.js';
import { caneRound } from '../../src/client/brain/cane.js';
import { DUG, FOOD_CARRY, GLUT, pockets } from '../../src/client/brain/pockets.js';
import { Brain } from '../../src/client/brain/brain.js';
import type { Goal, GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import { explainIdle } from '../../src/client/brain/idlelog.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';
import type { ClientRuntime, InventoryItem, Status } from '../../src/client/tools.js';

// F2 (Nov 14): the produce filled the storage house. The stash failed "nothing could be put away" 44 times in four
// hours with 27-34 slots carried, all of it farm output and food, and no deep trip went for six hours. The caps in
// GLUT throw what more of it the bot brings in at the dump spot; the farm and cane rounds wait while all they would
// bring in is over its cap.

const CHEST = { x: 1, y: 64, z: 0 };
const KEY = '1,64,0';
const NOW = 10 * 60 * 60_000;
const MIN = 60_000;
/** what the storage house held on Nov 14 (brain.json, the kinds this touches), and some of what is never capped */
const STORED: Record<string, number> = {
  carrot: 3233, potato: 319, wheat: 310, bread: 991, beef: 148, sugar_cane: 1154, apple: 10, bone: 130, spider_eye: 14, egg: 9,
  feather: 11, white_wool: 2, leather: 67, string: 46, raw_gold: 987, lapis_lazuli: 1033, redstone: 2051, diamond: 512, cobblestone: 865
};
const world = (over: Partial<WorldMemory> = {}, stored: Record<string, number> = STORED): WorldMemory => ({
  landmarks: { chests: [CHEST], farmland: [], furnace: { x: -1, y: 64, z: 0 } }, leash: 96, chestItems: { [KEY]: { ...stored } }, ...over
} as WorldMemory);
const snap = (items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot => {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return {
    now: NOW, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items, counts, slotsUsed: items.filter(i => i.slot < 36).length,
    home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, ...over
  };
};
const tool = (slot: number, name: string, maxDamage = 1561): InventoryItem => ({ slot, name, count: 1, damage: 0, maxDamage });
/** the kit: tools, a spare pickaxe, torches, the climb's stone and a stack of bread, all of it kept */
const kit = (): InventoryItem[] => [tool(0, 'diamond_pickaxe'), tool(1, 'iron_pickaxe', 250), tool(2, 'diamond_sword'), tool(3, 'diamond_axe'),
  tool(4, 'diamond_shovel'), tool(5, 'diamond_hoe'), { slot: 6, name: 'torch', count: 32 }, { slot: 7, name: 'cobblestone', count: 64 }, { slot: 8, name: 'bread', count: 64 }];
/** what the bot carried on Nov 14 beside its kit (the maintenance report's list), from slot 9 on */
const produce = (): InventoryItem[] => [
  { slot: 9, name: 'carrot', count: 64 }, { slot: 10, name: 'carrot', count: 64 }, { slot: 11, name: 'carrot', count: 4 },
  { slot: 12, name: 'potato', count: 64 }, { slot: 13, name: 'apple', count: 64 }, { slot: 14, name: 'beef', count: 64 }, { slot: 15, name: 'beef', count: 3 },
  { slot: 16, name: 'sugar_cane', count: 64 }, { slot: 17, name: 'sugar_cane', count: 32 }, { slot: 18, name: 'wheat', count: 28 },
  { slot: 19, name: 'wheat_seeds', count: 32 }, { slot: 20, name: 'dirt', count: 64 }, { slot: 21, name: 'rotten_flesh', count: 8 }, { slot: 22, name: 'raw_gold', count: 50 }
];
const byName = (list: { name: string; count: number }[]): Record<string, number | undefined> => Object.fromEntries(list.map(e => [e.name, e.count]));

test('caps: the pockets of Nov 14, the surplus over each cap thrown at the dump; what the bot keeps carried stays', (t) => {
  const s = snap([...kit(), ...produce()]);
  const plan = stashList(s, world());
  // carrots over FOOD_CARRY go (3233 stored, the cap 640), and all the cane and the wheat; the beef over its stack and
  // the raw gold are stored as ever (148 beef under its 256; ore is never capped)
  t.deepEqual(byName(plan.drop), { carrot: 68, sugar_cane: 96, wheat: 28 });
  t.deepEqual(byName(plan.deposit), { beef: 3, raw_gold: 50 });
  // the stack of each food, the seeds for the farm, the dirt for holes and the few rotten flesh stay carried
  for (const name of ['potato', 'apple', 'bread', 'wheat_seeds', 'dirt', 'rotten_flesh']) {
    t.false([...plan.drop, ...plan.deposit].some(e => e.name === name), `${name} stays carried`);
  }
  t.is(FOOD_CARRY, 64);
  // with every chest full (the plan's chests have no room), the caps still free four slots: two of cane, the wheat, a
  // stack of carrots (the 4 more only top a stack down); before, the plan had nothing it could make room with
  t.is(pockets(s, world()).loose, 4);
  // the stash wants for it at home, and its body is the same list (stashWork)
  t.regex(stash.wants({ ...s, slotsUsed: 27 }, world()) ?? '', /27\/36 slots used/);
});

test('caps: under the cap stored, at it or over thrown; the dug stone as before', (t) => {
  const s = snap([...kit(), ...produce()]);
  const at = (stored: Record<string, number>) => stashList(s, world({}, stored));
  t.deepEqual(byName(at({ carrot: 639 }).deposit), { carrot: 68, beef: 3, sugar_cane: 96, wheat: 28, raw_gold: 50 });
  t.deepEqual(byName(at({ carrot: 639 }).drop), {});
  t.deepEqual(byName(at({ carrot: 640 }).drop), { carrot: 68 });
  t.deepEqual(byName(at({ sugar_cane: 511, wheat: 256 }).drop), { wheat: 28 });
  t.deepEqual(byName(at({ sugar_cane: 512, beef: 256 }).drop), { beef: 3, sugar_cane: 96 });
  // a cap of none: poisonous potatoes always go (the junk rule threw them already)
  const poison = stashList(snap([...kit(), { slot: 9, name: 'poisonous_potato', count: 5 }]), world({}, {}));
  t.deepEqual(byName(poison.drop), { poisonous_potato: 5 });
  // the wool, each colour on its own count
  const wool = snap([...kit(), { slot: 9, name: 'white_wool', count: 30 }, { slot: 10, name: 'black_wool', count: 30 }]);
  t.deepEqual(byName(stashList(wool, world({}, { white_wool: 128, black_wool: 127 })).drop), { white_wool: 30 });
  t.deepEqual(byName(stashList(wool, world({}, { white_wool: 128, black_wool: 127 })).deposit), { black_wool: 30 });
  // the stone and dirt kept their caps
  t.deepEqual(Object.fromEntries(DUG.map(n => [n, GLUT[n]])),
    { cobblestone: 640, cobbled_deepslate: 320, dirt: 320, gravel: 128, granite: 128, diorite: 128, andesite: 128, tuff: 128 });
});

test('caps: never capped, however much is stored: leather, string, cooked food, ore, gems, ingots, potions and the rest', (t) => {
  const never = ['leather', 'string', 'cooked_beef', 'baked_potato', 'raw_gold', 'raw_iron', 'gold_ingot', 'iron_ingot', 'diamond', 'emerald',
    'lapis_lazuli', 'redstone', 'obsidian', 'blaze_rod', 'nether_wart', 'potion', 'enchanted_book', 'experience_bottle'];
  for (const name of never) t.false(name in GLUT, name);
  // two stacks of each of the first twelve carried and one potion and one book (35 slots), 5000 of each stored
  const items: InventoryItem[] = [...kit()];
  let slot = 9;
  for (const name of never.slice(0, 12)) { items.push({ slot: slot++, name, count: 64 }); items.push({ slot: slot++, name, count: 64 }); }
  items.push({ slot: slot++, name: 'potion', count: 1 }, { slot: slot++, name: 'enchanted_book', count: 1, enchanted: true } as InventoryItem);
  const plan = stashList(snap(items), world({}, Object.fromEntries(never.map(n => [n, 5000]))));
  t.deepEqual(plan.drop, []);
  // cooked food keeps its stack carried; everything else goes in the chests
  t.is(byName(plan.deposit).cooked_beef, 64);
  t.is(byName(plan.deposit).leather, 128);
  t.is(byName(plan.deposit).raw_gold, 128);
});

test('caps: never a kind a bill carries or is short of, a build job\'s, a mission\'s, or held in the chests for a job', (t) => {
  const s = snap([...kit(), ...produce()]);
  const kept = (over: Partial<WorldMemory>) => { const p = stashList(s, world(over)); return { drop: byName(p.drop), deposit: byName(p.deposit) }; };
  // the project short of cane (the enchanting room waited on it): the cane is stored
  const need = kept({ progress: { done: [], journal: [], need: { sugar_cane: 100 } } });
  t.is(need.deposit.sugar_cane, 96);
  t.is(need.drop.sugar_cane, undefined);
  t.is(need.drop.carrot, 68, 'the rest still goes');
  // a build job's bill, and what a waiting one is missing
  const job = (over: object) => ({ id: 1, world: 'w', structure: 's', mode: 'apply', status: 'working', createdAt: 0, updatedAt: 0, ...over });
  t.is(kept({ buildJobs: [job({ phase: 'provisioning', bill: { wheat: 64 } })] as never }).deposit.wheat, 28);
  t.is(kept({ buildJobs: [job({ status: 'waiting', missing: { carrot: 10 } })] as never }).drop.carrot, undefined);
  // owed to the community chest, and held back in the chests for a job
  const mission: WorldMemory['community'] = {
    chests: { community1: { x: 300, y: 64, z: 300 } }, nextId: 2,
    missions: [{ id: 1, item: 'wheat', count: 64, chest: 'community1', gathered: 10, delivered: 0, status: 'active', createdAt: 0, updatedAt: 0 }]
  };
  t.is(kept({ community: mission }).deposit.wheat, 28);
  t.is(kept({ reserved: { job1: { sugar_cane: 10 } } }).deposit.sugar_cane, 96);
});

test('caps: by evening the produce stays carried (out to the dump by day only), and a trip down the mine throws none of it', (t) => {
  const evening = stashList(snap([...kit(), ...produce()], { activity: 'return', timeOfDay: 12_500 }), world());
  t.deepEqual(evening.drop, []);
  t.deepEqual(byName(evening.deposit), { beef: 3, raw_gold: 50 });
  // down the mine: only the stone beyond a stack goes, never the farm's produce or the mobs' drops, whatever is stored
  const down = [...kit(), { slot: 9, name: 'sugar_cane', count: 64 }, { slot: 10, name: 'sugar_cane', count: 64 }, { slot: 11, name: 'bone', count: 64 },
    { slot: 12, name: 'bone', count: 64 }, { slot: 13, name: 'bread', count: 64 }, { slot: 14, name: 'beef', count: 64 }, { slot: 15, name: 'beef', count: 64 },
    { slot: 16, name: 'cobbled_deepslate', count: 64 }, { slot: 17, name: 'gravel', count: 64 }, { slot: 18, name: 'gravel', count: 10 }];
  const s = snap(down);
  t.deepEqual(byName(mineDrops(down, s, world({}, { ...STORED, bone: 5000, beef: 5000 }))), { cobbled_deepslate: 64, gravel: 10 });
});

// ---- through the stash's body ----

/** one chest and the pockets, as the game would answer the stash's tools */
function game(items: InventoryItem[], held: Record<string, number>) {
  const inv = items.map(i => ({ ...i }));
  const chest = { ...held };
  const acts: string[] = [];
  let pos = { x: 0, y: 64, z: 0 };
  const count = (n: string) => inv.filter(i => i.name === n).reduce((a, i) => a + i.count, 0);
  const take = (n: string, want: number) => {
    let left = want;
    for (const i of inv.filter(i => i.name === n).sort((a, b) => a.slot - b.slot)) { const k = Math.min(left, i.count); i.count -= k; left -= k; }
    for (let j = inv.length - 1; j >= 0; j--) if (!inv[j].count) inv.splice(j, 1);
    return want - left;
  };
  const ctx = (s: Snapshot, w: WorldMemory): GoalContext => ({
    s, world: w, signal: new AbortController().signal,
    act: async (tool, a = {}) => {
      const item = String(a.item);
      if (tool === 'store-in-chest') {
        const n = take(item, (a.count as number | undefined) ?? count(item));
        chest[item] = (chest[item] ?? 0) + n;
        acts.push(`store-in-chest ${item} ${n}`);
        return { ok: true, text: `Stored ${n} ${item} in the chest at (1, 64, 0). It holds: ${Object.entries(chest).map(([k, v]) => `${k} x${v}`).join(', ')}.` };
      }
      if (tool === 'drop-item') { const n = take(item, a.count as number); acts.push(`drop-item ${item} ${n}`); return { ok: true, text: `Dropped ${n} ${item}` }; }
      if (tool === 'move-to-position') { pos = { x: a.x as number, y: a.y as number, z: a.z as number }; acts.push('move-to-position'); return { ok: true, text: 'Arrived' }; }
      if (tool === 'go-home') { pos = { x: 0, y: 64, z: 0 }; acts.push('go-home'); return { ok: true, text: 'Home' }; }
      throw new Error(`no tool ${tool}`);
    },
    call: (async (method: string) => (method === 'inventory' ? { items: inv.map(i => ({ ...i })) } : {})) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: pos, block: pos, timeOfDay: 1000, dimension: 'overworld', health: 20, food: 20 } as Status),
    progress: () => undefined, gain: () => undefined
  });
  return { inv, chest, acts, count, ctx };
}

test('caps: through the body, the potatoes under their cap go in the chest and the carrots over theirs out to the dump', async (t) => {
  const items = [...kit(), { slot: 9, name: 'carrot', count: 64 }, { slot: 10, name: 'carrot', count: 64 }, { slot: 11, name: 'carrot', count: 4 },
    { slot: 12, name: 'potato', count: 64 }, { slot: 13, name: 'potato', count: 64 }];
  const held = { carrot: 700, potato: 100 };
  const w = world({}, held);
  const s = snap(items);
  const g = game(items, held);
  const r = await putAway(g.ctx(s, w), s, stashKeep(w));
  t.deepEqual(r, { stored: 64, dropped: 68 });
  t.deepEqual(g.acts, ['store-in-chest potato 64', 'move-to-position', 'drop-item carrot 68', 'go-home']);
  t.is(g.chest.potato, 164);
  t.is(g.chest.carrot, 700, 'not one carrot more in the chest');
  t.is(g.count('carrot'), 64, 'the stack it carries stays');
  t.is(g.count('potato'), 64);
  // the stash's memory of the chest from the reply: the potatoes are counted, so 156 more and they are at their cap too
  t.is(w.chestItems?.[KEY]?.potato, 164);
});

// ---- the farm round's wait ----

const FARMLAND = [{ x: 4, y: 63, z: 4 }, { x: 6, y: 63, z: 4 }];
/** the home on Nov 14 with its farm, which the last round saw growing carrots, potatoes and wheat */
const farmWorld = (stored: Record<string, number>, over: Partial<WorldMemory> = {}): WorldMemory => world({
  landmarks: { chests: [CHEST], farmland: [...FARMLAND], furnace: { x: -1, y: 64, z: 0 } },
  farmCrops: { crops: ['carrots', 'potatoes', 'wheat'], cells: FARMLAND.length, at: NOW - 60 * MIN }, ...over
}, stored);
const OVER = { ...STORED, potato: 330 };

test('the farm round waits while every crop its plot grows is stored over its cap, and harvests once one is under', (t) => {
  const s = snap(kit());
  // live: the potatoes were one short of their cap, so the round still harvests
  t.is(larderFull(s, farmWorld(STORED)), null);
  t.is(farm.wants(s, farmWorld(STORED)), 'daily round: the farm');
  // one more potato stored, and all of it would go to the dump
  const full = 'carrot 3233/640, potato 330/320, wheat 310/256, bread 991/640';
  t.is(larderFull(s, farmWorld(OVER)), full);
  t.is(farm.wants(s, farmWorld(OVER)), null);
  t.deepEqual(farm.declines!(s, farmWorld(OVER)), { cause: 'stocked', text: `the larder is full (${full})` });
  t.is(farm.daily!(s, farmWorld(OVER)), `the larder is full (${full})`);
  t.is(farm.daily!(s, farmWorld(STORED)), null);
  // the wheat is baked into bread unless the bread is at its cap: the wheat crop is full only with both
  t.is(farm.wants(s, farmWorld({ ...OVER, bread: 639 })), 'daily round: the farm');
  t.is(farm.wants(s, farmWorld({ ...OVER, wheat: 255 })), 'daily round: the farm');
  // a bill short of one of them lifts its cap
  t.is(farm.wants(s, farmWorld(OVER, { progress: { done: [], journal: [], need: { potato: 10 } } })), 'daily round: the farm');
  // what the round saw says nothing once the farmland has grown (or shrunk), nor with nothing growing, nor a crop no
  // cap counts; and a farm not looked at yet harvests, as ever
  t.is(farm.wants(s, farmWorld(OVER, { landmarks: { chests: [CHEST], farmland: [...FARMLAND, { x: 8, y: 63, z: 4 }] } })), 'daily round: the farm');
  t.is(farm.wants(s, farmWorld(OVER, { farmCrops: { crops: [], cells: 2, at: NOW } })), 'daily round: the farm');
  t.is(farm.wants(s, farmWorld(OVER, { farmCrops: { crops: ['carrots', 'torchflower_crop'], cells: 2, at: NOW } })), 'daily round: the farm');
  t.is(farm.wants(s, farmWorld(OVER, { farmCrops: undefined })), 'daily round: the farm');
  t.is(farm.wants(s, farmWorld(OVER, { farmCrops: { crops: ['carrots'], cells: 2, at: NOW } })), null, 'a carrot plot: carrots alone');
  // the gate still says the rest as before: not due, away, the hour
  const ran = farmWorld(STORED, { lastDone: { farm: NOW - 5 * MIN } });
  t.like(farm.declines!(s, ran), { cause: 'unneeded', text: 'farm is not due for 15 min (every 20)' });
  t.like(farm.declines!(snap(kit(), { distHome: 30, position: { x: 30, y: 64, z: 0 } }), farmWorld(STORED)), { cause: 'away' });
  t.like(farm.declines!(snap(kit(), { activity: 'return', timeOfDay: 11_500 }), farmWorld(STORED)), { cause: 'late' });
  t.like(farm.declines!(snap(kit(), { sleeping: true }), farmWorld(STORED)), { cause: 'late', text: 'asleep' });
  t.like(farm.declines!(s, world()), { cause: 'unneeded', text: 'no farmland' });
  t.is(atCaps(s, farmWorld(OVER), []), null);
});

test('the farm due in the yard beyond 10 of home (by the bed) is not "away": a goal on an ordinary hold leads the idle line, as before the farm had a gate', t => {
  // the brain lets an ordinary hold go after 60 s only while `hold` leads (brain.ts releaseHold); "away" ranks first
  const yard = { x1: -20, z1: -20, x2: 40, z2: 20, y: 64 };
  const w = farmWorld(STORED, { yard });
  const s = snap(kit(), { distHome: 12, position: { x: 12, y: 64, z: 0 } });
  t.deepEqual(farm.declines!(s, w), { cause: 'unneeded', text: '12 blocks from home (farm works within 10)' });
  t.is(farm.wants(s, w), null);
  const held: Goal = { name: 'stash', priority: 60, timeoutMs: MIN, retryMs: 10 * MIN, wants: () => '27/36 slots used', run: async () => 'put away' };
  const why = explainIdle(s, w, [held, farm], new Map([['stash', NOW + 9 * MIN]]), new Map([['stash', 'failed: the chest at (1, 64, 0) did not open']]));
  t.is(why[0].cause, 'hold');
  t.deepEqual(why.map(d => d.cause), ['hold', 'unneeded']);
  // out of the yard, or in it off home's level (under it), the farm is away as ever
  t.like(farm.declines!(snap(kit(), { distHome: 25, position: { x: 0, y: 64, z: 25 } }), w), { cause: 'away', text: '25 blocks from home (farm works within 10)' });
  t.like(farm.declines!(snap(kit(), { distHome: 12, position: { x: 12, y: 40, z: 0 } }), w), { cause: 'away', text: '12 blocks from home and 24 below it (farm works within 10, on home\'s level)' });
  // with no yard known, beyond 10 is away
  t.like(farm.declines!(s, farmWorld(STORED)), { cause: 'away' });
});

/** a farm round over the two cells: carrots and young wheat standing on them after the harvest */
function farmRun(stored: Record<string, number>, region: (string | null)[] | null = ['carrots[age=0]', 'air', 'minecraft:wheat[age=0]']) {
  const w = farmWorld(stored, { farmCrops: undefined });
  const acts: string[] = [];
  const asked: Record<string, unknown>[] = [];
  const ctx = {
    s: snap(kit()), world: w, signal: new AbortController().signal,
    act: async (tool: string) => { acts.push(tool); return { ok: true, text: tool === 'farm' ? 'Farmed for 9s: carrot x12, wheat x7.' : 'ok' }; },
    call: (async (method: string, p?: Record<string, unknown>) => {
      if (method === 'world.region') { asked.push(p ?? {}); if (!region) throw new Error('no reply'); return { blocks: region }; }
      return { items: [{ slot: 3, name: 'wheat', count: 7 }, { slot: 4, name: 'carrot', count: 12 }] };
    }) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined, gain: () => undefined
  } as GoalContext;
  return { w, acts, asked, ctx };
}

test('the farm round looks at what it replanted, and bakes no bread the chests hold enough of', async (t) => {
  // the bread at its cap: the wheat goes in the chests as it is
  const full = farmRun(STORED);
  t.is(await farm.run(full.ctx), 'Farmed for 9s: carrot x12, wheat x7.');
  t.deepEqual(full.acts, ['move-to-position', 'farm']);
  // one read a block above the farmland, and what stands there remembered for the gate
  t.deepEqual(full.asked, [{ x: 4, y: 64, z: 4, width: 3, height: 1, length: 1 }]);
  t.deepEqual(full.w.farmCrops, { crops: ['carrots', 'wheat'], cells: 2, at: NOW });
  // with the potatoes gone from the plot, the carrots and the wheat are all it grows: both over, so the round waits
  t.is(larderFull(full.ctx.s, { ...full.w, lastDone: {} }), 'carrot 3233/640, wheat 310/256, bread 991/640');
  t.is(farm.wants(full.ctx.s, { ...full.w, lastDone: {} }), null);

  // the bread under its cap: baked as ever
  const under = farmRun({ ...STORED, bread: 100 });
  t.is(await farm.run(under.ctx), 'Farmed for 9s: carrot x12, wheat x7.; baked 2 bread');
  t.deepEqual(under.acts, ['move-to-position', 'farm', 'craft-item']);

  // no reply to the look: nothing remembered, and the round harvests next time as it did
  const blind = farmRun(STORED, null);
  await farm.run(blind.ctx);
  t.is(blind.w.farmCrops, undefined);
  const odd = farmRun(STORED, ['carrots']);
  await farm.run(odd.ctx);
  t.is(odd.w.farmCrops, undefined, 'a reply of the wrong size says nothing');
});

// ---- the cane round's ----

test('the cane round waits while the chests hold the cane\'s cap, unless a bill is short of cane', (t) => {
  const cane = (stored: Record<string, number>, over: Partial<WorldMemory> = {}) => world({ zones: { cane: [{ x: 5, y: 63, z: 5 }] }, ...over }, stored);
  const s = snap(kit());
  t.deepEqual(caneRound.declines!(s, cane(STORED)), { cause: 'stocked', text: 'enough cane in the chests (sugar_cane 1154/512)' });
  t.is(caneRound.wants(s, cane(STORED)), null);
  t.is(caneRound.daily!(s, cane(STORED)), 'enough cane in the chests (sugar_cane 1154/512)');
  t.is(caneRound.wants(s, cane({ ...STORED, sugar_cane: 511 })), 'daily round: the sugar cane');
  t.is(caneRound.daily!(s, cane({ ...STORED, sugar_cane: 511 })), null);
  t.is(caneRound.wants(s, cane(STORED, { progress: { done: [], journal: [], need: { sugar_cane: 100 } } })), 'daily round: the sugar cane');
  // no patch: that is said first, as before
  t.like(caneRound.declines!(s, world()), { cause: 'unneeded', text: 'no cane patch' });
});

// ---- the line once a day ----

test.serial('the brain says the farm\'s wait once a day: "farm: the larder is full (...)"', async (t) => {
  // a minute before midnight (UTC), then half a minute on, then past midnight: the landmarks were looked for just now
  const T0 = Date.UTC(2026, 10, 14, 23, 59, 0);
  let clock = T0;
  const w = farmWorld(OVER, { landmarks: { chests: [CHEST], farmland: [...FARMLAND], foundAt: T0 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-'));
  const file = path.join(dir, 'brain.json');
  const logFile = path.join(dir, 'brain.log');
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': w }));
  const rt = {
    actions: {},
    call: (async (method: string) => (method === 'inventory' ? { items: kit() } : method === 'world.region' ? { blocks: [] } : {})) as ClientRuntime['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { x: 0, y: 64, z: 0 }, block: { x: 0, y: 64, z: 0 }, timeOfDay: 1000,
      hashedSeed: '1', dimension: 'overworld', sleeping: false, health: 20, food: 20 }),
    home: () => ({ x: 0, y: 64, z: 0, dimension: 'overworld' }),
    lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [farm, caneRound], logFile, memoryFile: file });
  brain.setEnabled(true);
  const said = () => fs.readFileSync(logFile, 'utf8').split('\n').map(l => l.slice(25)).filter(l => /^(farm|cane): |^(start|done) /.test(l));
  await brain.tick();
  clock = T0 + 30_000;
  await brain.tick();
  t.deepEqual(said(), ['farm: the larder is full (carrot 3233/640, potato 330/320, wheat 310/256, bread 991/640)']);
  // a new day: said again; the farm never started
  clock = T0 + 90_000;
  await brain.tick();
  t.deepEqual(said(), ['farm: the larder is full (carrot 3233/640, potato 330/320, wheat 310/256, bread 991/640)',
    'farm: the larder is full (carrot 3233/640, potato 330/320, wheat 310/256, bread 991/640)']);
  brain.setEnabled(false);
});
