import test from 'ava';
import { WART_STRIP, wartStrip } from '../../src/client/brain/blueprints.js';
import {
  WART_CELLS, WART_EVERY, WART_STOCK, WART_WAITS, tendStrip, walkFor, wartCell, wartFarmMilestone, wartRound, wartWaits
} from '../../src/client/brain/wart.js';
import { TREE } from '../../src/client/brain/tree.js';
import { key, remember } from '../../src/client/brain/chests.js';
import { planLevel } from '../../src/client/level.js';
import { occupancy } from '../../src/client/brain/site.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { ChestStack, InventoryItem } from '../../src/client/tools.js';

WART_WAITS.pollMs = 0;
const MINUTE = 60_000;

// ------------------------------------------------------------------------------------------------ the strip

test('the wart strip: two rows of six cells over the ground with the ground between them left to walk on, 12 cells, every cell beside the walk; the build places nothing in the ground (no grass dug by Baritone); turned along x', (t) => {
  const bp = wartStrip();
  t.deepEqual(bp.size, { width: 3, height: 2, length: 6 });
  t.deepEqual(WART_STRIP, { width: 3, length: 6 });
  t.is(bp.groundOffset, 0, 'layer 0 is the top ground layer');
  t.deepEqual(bp.bill, {});
  t.is(WART_CELLS, 12);
  t.deepEqual(bp.spec.layers[0], Array(6).fill('   '), 'nothing placed in the ground: the soul sand is set in by hand (sandStep)');
  t.deepEqual(bp.spec.palette, {});
  t.deepEqual(bp.spec.layers[1], Array(6).fill('...'), 'the grass over the rows and the walk cleared');
  for (const along of ['z', 'x'] as const) {
    const b = wartStrip({ along });
    const cells = b.landmarks.filter(l => l.kind === 'cell').map(l => l.at);
    const walks = b.landmarks.filter(l => l.kind === 'walk').map(l => l.at);
    t.is(cells.length, 12, along);
    t.is(walks.length, 6, along);
    for (const c of cells) {
      t.is(c.y, 1, 'a wart\'s cell over its soul sand');
      t.truthy(walkFor(c, walks), `${along}: ${c.x},${c.z} beside the walk`);
      t.is(b.spec.layers[0][c.z][c.x], ' ');
    }
  }
  t.deepEqual(wartStrip({ along: 'x' }).size, { width: 6, height: 2, length: 3 });
});

test('a wart cell by its block: age 3 ripe, younger growing, open over soul sand bare, anything else left be', (t) => {
  t.is(wartCell('minecraft:nether_wart[age=3]', 'minecraft:soul_sand'), 'ripe');
  t.is(wartCell('minecraft:nether_wart[age=1]', 'minecraft:soul_sand'), 'growing');
  t.is(wartCell('minecraft:air', 'minecraft:soul_sand'), 'bare');
  t.is(wartCell('minecraft:short_grass', 'minecraft:soul_sand'), 'bare');
  t.is(wartCell('minecraft:air', 'minecraft:dirt'), 'other', 'its soul sand gone');
  t.is(wartCell('minecraft:cobblestone', 'minecraft:soul_sand'), 'other');
});

test('a levelling of the yard leaves the wart\'s columns whole (level.ts KEEP), and the brewing stand\'s', (t) => {
  const w = 3, l = 1, h = 6;
  const b: string[] = new Array(w * l * h).fill('air');
  const set = (x: number, y: number, n: string) => { b[x + y * w * l] = n; };
  for (let x = 0; x < w; x++) { set(x, 0, 'stone'); set(x, 1, 'dirt'); set(x, 2, 'grass_block'); }
  set(0, 2, 'soul_sand'); set(0, 3, 'nether_wart[age=2]');
  set(1, 3, 'brewing_stand[has_bottle_0=false]');
  set(2, 3, 'dirt'); // a bump to cut beside them
  const p = planLevel({ x: 0, y: 60, z: 0, width: w, height: h, length: l }, b, 62);
  t.is(p.cut, 1, 'only the bump');
  t.is(p.kept.built, 2);
});

// ------------------------------------------------------------------------------------------------ the milestone

const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
const STORE: Pos = { x: -547, y: 63, z: 2180 };
const HOME = { x: -549, y: 63, z: 2183, dimension: 'overworld' };
/** The strip built at (-560, 62, 2170) along z: its cells and its walk as buildStep puts them down (y 63). */
const ORIGIN = { x: -560, y: 62, z: 2170 };
const STRIP = wartStrip();
const CELLS = STRIP.landmarks.filter(l => l.kind === 'cell').map(l => ({ x: ORIGIN.x + l.at.x, y: ORIGIN.y + l.at.y, z: ORIGIN.z + l.at.z }));
const WALKS = STRIP.landmarks.filter(l => l.kind === 'walk').map(l => ({ x: ORIGIN.x + l.at.x, y: ORIGIN.y + l.at.y, z: ORIGIN.z + l.at.z }));
const k3 = (p: Pos) => `${p.x},${p.y},${p.z}`;

const snap = (items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot => {
  const counts = new Map<string, number>();
  for (const i of items) if (i.slot < 36) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return {
    now: 10 * 60 * MINUTE, timeOfDay: 2000, activity: 'work', health: 20, food: 20, position: { x: -555, y: 63, z: 2175 }, dimension: 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items, counts, slotsUsed: items.filter(i => i.slot < 36).length,
    xpLevel: 20, home: HOME, distHome: 10, ...over
  } as Snapshot;
};

function farmWorld(stacks: ChestStack[], over: Partial<WorldMemory> = {}): WorldMemory {
  const world = {
    landmarks: { chests: [STORE], farmland: [] }, leash: 96, yard: { ...YARD }, chestAssign: { [key(STORE)]: 'farming' },
    zones: { wart: [{ ...ORIGIN, width: 3, length: 6 }], 'wart:cell': CELLS.map(c => ({ ...c })), 'wart:walk': WALKS.map(c => ({ ...c })) },
    progress: { done: ['brewing', 'wart-farm'], journal: [] }, ...over
  } as WorldMemory;
  const totals: Record<string, number> = {};
  for (const st of stacks) totals[st.name] = (totals[st.name] ?? 0) + st.count;
  remember(world, STORE, totals, stacks.map(st => ({ ...st })));
  return world;
}

test('the wart farm milestone: after the brewing stand, the last of the tree but the netherite (P6); it waits on the Nether for its soul sand and a wart, and says so; then a site, the strip, the planting', (t) => {
  const m = TREE.at(-2)!;
  t.is(m.id, 'wart-farm');
  t.is(TREE.at(-1)!.id, 'netherite');
  t.is(m.title, 'a nether wart farm');
  t.deepEqual(m.prereqs, ['brewing']);
  t.deepEqual(m.steps.map(s => s.name), ['soul sand and nether wart from the Nether', 'find room for the wart farm', 'build the wart farm\'s soul sand', 'set the wart farm\'s soul sand into the ground', 'plant the nether wart']);
  t.deepEqual(wartFarmMilestone(['brewing']).steps.map(s => s.name), m.steps.map(s => s.name));
  const none = farmWorld([], { zones: {}, progress: { done: ['brewing'], journal: [] } });
  t.is(wartWaits(snap([]), none), 'the wart farm waits on the Nether: 0 of 12 soul sand, 0 nether wart at home (the fortress and the barter bring them)');
  t.is(m.steps[0].waits!({ s: snap([]), world: none, have: () => 0 }), wartWaits(snap([]), none));
  t.is(wartWaits(snap([]), farmWorld([{ slot: 0, name: 'soul_sand', count: 12 }, { slot: 1, name: 'nether_wart', count: 1 }])), undefined);
  t.is(wartWaits(snap([]), farmWorld([{ slot: 0, name: 'soul_sand', count: 11 }, { slot: 1, name: 'nether_wart', count: 4 }])), 'the wart farm waits on the Nether: 11 of 12 soul sand, 4 nether wart at home (the fortress and the barter bring them)');
  // done: its zone, and the project past its last step
  t.true(m.done!({ s: snap([]), world: farmWorld([]), have: () => 0 }));
  t.false(m.done!({ s: snap([]), world: farmWorld([], { progress: { done: ['brewing'], journal: [], current: { id: 'wart-farm', step: 4, data: {} } } }), have: () => 0 }));
  t.false(m.done!({ s: snap([]), world: none, have: () => 0 }));
});

/**
 * The strip as the server has it (cells by position: `blocks`), the bot's pockets, the chest: the careful walks arrive,
 * dig.here harvests a ripe wart from beside it (three wart, lying on its soul sand until the next look picks them up),
 * place-block plants a carried wart on soul sand, world.entities shows the drops.
 */
function strip(items: InventoryItem[], world: WorldMemory, stacks: ChestStack[], blocks: Map<string, string>) {
  const calls: string[] = [];
  const inside = stacks.map(st => ({ ...st }));
  const lying: { at: Pos; n: number }[] = [];
  let me: Pos = { x: -555, y: 63, z: 2175 };
  const get = (p: Pos) => blocks.get(k3(p)) ?? (p.y === ORIGIN.y ? (CELLS.some(c => c.x === p.x && c.z === p.z) ? 'minecraft:soul_sand' : 'minecraft:grass_block') : 'minecraft:air');
  const give = (name: string, n: number) => {
    const onto = items.find(i => i.slot < 36 && i.name === name && i.count + n <= 64);
    if (onto) onto.count += n;
    else items.push({ slot: [...Array(36).keys()].find(s => !items.some(i => i.slot === s))!, name, count: n });
  };
  const use = (name: string) => {
    const i = items.find(x => x.slot < 36 && x.name === name)!;
    i.count -= 1;
    if (!i.count) items.splice(items.indexOf(i), 1);
  };
  const ctx = {
    s: snap(items), world, signal: new AbortController().signal, progress: () => undefined, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'b', screen: null, dimension: 'overworld', position: { ...me } }),
    call: (async (m: string, p: Record<string, unknown> = {}) => {
      if (m === 'inventory') return { items: items.map(i => ({ ...i })), held: { name: 'diamond_sword' } };
      if (m === 'item.select') return {};
      if (m === 'world.region') {
        const out: string[] = [];
        for (let y = 0; y < Number(p.height ?? 1); y++) for (let z = 0; z < Number(p.length ?? 1); z++) for (let x = 0; x < Number(p.width ?? 1); x++) {
          out.push(get({ x: Number(p.x) + x, y: Number(p.y) + y, z: Number(p.z) + z }));
        }
        return { blocks: out };
      }
      if (m === 'goto') { me = { x: Number(p.x), y: Number(p.y), z: Number(p.z) }; calls.push(`goto ${k3(me)}${p.careful ? ' careful' : ''}`); return { arrived: true }; }
      if (m === 'dig.here') {
        const at = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
        calls.push(`dig ${k3(at)}`);
        if (Math.abs(at.x - me.x) + Math.abs(at.z - me.z) !== 1) return { dug: false, reason: 'out of reach' };
        const was = get(at);
        blocks.set(k3(at), 'minecraft:air');
        if (/nether_wart/.test(was)) lying.push({ at, n: 3 });
        return { dug: true };
      }
      // the drops are picked up as the bot stands by them: shown once, then in the pockets
      if (m === 'world.entities') {
        const shown = lying.splice(0).map(d => ({ item: 'nether_wart', position: { x: d.at.x + 0.5, y: d.at.y, z: d.at.z + 0.5 }, n: d.n }));
        for (const d of shown) give('nether_wart', d.n);
        return { entities: shown };
      }
      if (m === 'chest.open') return { slots: 27, free: 27 - inside.length, items: {}, stacks: inside };
      if (m === 'container.close') return { ok: true };
      return {};
    }) as GoalContext['call'],
    act: (async (tool: string, p: Record<string, unknown> = {}) => {
      const at = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
      if (tool === 'take-from-chest') {
        const st = inside.find(x => x.name === p.item);
        const n = Math.min(Number(p.count ?? 64), st?.count ?? 0);
        if (st && n) { st.count -= n; if (!st.count) inside.splice(inside.indexOf(st), 1); give(String(p.item), n); }
        calls.push(`take ${String(p.item)} x${n}`);
        return { ok: true, text: `Took ${n} ${String(p.item)} from the chest at (${STORE.x}, ${STORE.y}, ${STORE.z}). It holds: ${inside.map(x => `${x.name} x${x.count}`).join(', ') || 'nothing'}.` };
      }
      if (tool === 'place-block' && p.item === 'soul_sand') {
        calls.push(`place soul_sand ${k3(at)}`);
        if (!/air/.test(get(at))) return { ok: true, text: `There's already a block (${get(at)}) at ${k3(at)}` };
        use('soul_sand');
        blocks.set(k3(at), 'minecraft:soul_sand');
        return { ok: true, text: `Placed minecraft:soul_sand at ${k3(at)} using up face` };
      }
      if (tool === 'place-block') {
        calls.push(`plant ${k3(at)}`);
        if (!items.some(i => i.slot < 36 && i.name === p.item)) return { ok: true, text: `No ${String(p.item)} in inventory to place` };
        if (!/soul_sand/.test(get({ ...at, y: at.y - 1 }))) return { ok: true, text: 'Failed to place block' };
        use(String(p.item));
        blocks.set(k3(at), 'minecraft:nether_wart[age=0]');
        return { ok: true, text: `Placed minecraft:nether_wart at ${k3(at)} using up face` };
      }
      return { ok: true, text: 'ok' };
    }) as GoalContext['act']
  } as unknown as GoalContext;
  return { ctx, calls, items, inside, blocks };
}

const wartOf = (items: InventoryItem[]) => items.filter(i => i.name === 'nether_wart').reduce((a, i) => a + i.count, 0);

test('the planting: the fortress\'s 4 wart into 4 of the 12 cells from the walk between the rows, on foot; the rest the round plants as the harvests come', async (t) => {
  const world = farmWorld([{ slot: 0, name: 'nether_wart', count: 4 }], { progress: { done: ['brewing'], journal: [], current: { id: 'wart-farm', step: 4, data: {} } } });
  const f = strip([{ slot: 0, name: 'diamond_sword', count: 1 }], world, [{ slot: 0, name: 'nether_wart', count: 4 }], new Map());
  const m = wartFarmMilestone(['brewing']);
  const r = await m.steps[4].run(f.ctx, world.progress!.current!);
  t.like(r, { status: 'done', text: 'planted 4: 4 of 12 cells growing (the round plants the rest as the wart comes)' });
  t.is(f.calls[0], 'take nether_wart x4');
  t.is(f.calls.filter(c => c.startsWith('plant')).length, 4);
  // every walk on foot, onto the walk between the rows; each plant from beside it
  for (const c of f.calls.filter(x => x.startsWith('goto'))) {
    t.true(c.endsWith(' careful'));
    t.true(WALKS.some(w => c.startsWith(`goto ${k3(w)}`)), c);
  }
  t.like(world.wart, { bare: 8, growing: 4, ripe: 0 });
  // none at all: short of it (blocked, with what it needs)
  const empty = farmWorld([], { progress: { done: ['brewing'], journal: [], current: { id: 'wart-farm', step: 4, data: {} } } });
  const g = strip([], empty, [], new Map());
  t.like(await m.steps[4].run(g.ctx, empty.progress!.current!), { status: 'blocked', text: 'no nether wart to plant', need: { nether_wart: 1 } });
  // all planted: done
  const full = new Map(CELLS.map(c => [k3(c), 'minecraft:nether_wart[age=1]']));
  const h = strip([], farmWorld([]), [], full);
  t.like(await m.steps[4].run(h.ctx, { step: 4, data: {} }), { status: 'done', text: 'nether wart in all 12 cell(s) of the farm (planted 0 now)' });
});

test('the wart round: the ripe ones harvested from beside them and planted again, the bare planted, the young left; said; due again in 40 min', async (t) => {
  const blocks = new Map<string, string>();
  CELLS.forEach((c, i) => blocks.set(k3(c), i < 5 ? 'minecraft:nether_wart[age=3]' : i < 9 ? 'minecraft:nether_wart[age=1]' : 'minecraft:air'));
  const world = farmWorld([{ slot: 0, name: 'nether_wart', count: 2 }]);
  const items: InventoryItem[] = [{ slot: 0, name: 'diamond_sword', count: 1 }];
  const s = snap(items);
  t.is(wartRound.wants(s, world), 'round: the nether wart');
  const f = strip(items, world, [{ slot: 0, name: 'nether_wart', count: 2 }], blocks);
  const r = await wartRound.run({ ...f.ctx, s });
  t.is(r, 'harvested 5 wart plant(s) (15 wart), planted 8; 0 ripe, 12 growing, 0 bare');
  t.is(f.calls.filter(c => c.startsWith('dig')).length, 5);
  for (const c of CELLS.slice(0, 5)) t.true(f.calls.includes(`dig ${k3(c)}`), `${k3(c)} harvested`);
  for (const c of CELLS.slice(5, 9)) t.false(f.calls.includes(`dig ${k3(c)}`), `${k3(c)} young: left`);
  // 5 x 3 harvested + 2 taken, 8 planted: 9 carried
  t.is(wartOf(f.items), 9);
  t.like(world.wart, { bare: 0, ripe: 0, growing: 12 });
  // not due again for its 40 minutes
  t.like(wartRound.declines!(snap(f.items, { now: s.now + MINUTE }), world), { cause: 'unneeded', text: `wart is not due for ${WART_EVERY / MINUTE - 1} min (every 40)` });
  t.is(wartRound.wants(snap(f.items, { now: s.now + WART_EVERY + 1 }), world), 'round: the nether wart');
});

test('the wart round\'s gate: no farm, not planted yet, the stock met with nothing bare (the ripe stay on the plant), out of the yard; it writes nothing', (t) => {
  const s = snap([]);
  t.like(wartRound.declines!(s, farmWorld([], { zones: {} })), { cause: 'unneeded', text: 'no wart farm' });
  t.like(wartRound.declines!(s, farmWorld([], { progress: { done: ['brewing'], journal: [] } })), { cause: 'unneeded', text: 'the wart farm is not planted yet' });
  const stocked = farmWorld([{ slot: 0, name: 'nether_wart', count: WART_STOCK }]);
  t.like(wartRound.declines!(s, stocked), { cause: 'stocked', text: 'enough nether wart at home (64 of 64)' });
  stocked.wart = { bare: 2 };
  t.is(wartRound.wants(s, stocked), 'round: the nether wart', 'bare cells to plant: it goes');
  t.like(wartRound.declines!(snap([], { position: { x: -520, y: 63, z: 2175 }, distHome: 29 }), farmWorld([])), { cause: 'away' });
  const world = farmWorld([]);
  const before = JSON.stringify(world);
  for (const tod of [0, 2000, 11000]) { wartRound.wants(snap([], { timeOfDay: tod }), world); wartRound.declines!(snap([], { timeOfDay: tod }), world); }
  t.is(JSON.stringify(world), before);
});

test('tendStrip with the stock met harvests nothing: the ripe stay on the plant, the bare are planted', async (t) => {
  const blocks = new Map<string, string>([[k3(CELLS[0]), 'minecraft:nether_wart[age=3]']]);
  const world = farmWorld([]);
  const f = strip([{ slot: 3, name: 'nether_wart', count: 64 }], world, [], blocks);
  const r = await tendStrip(f.ctx, false);
  t.like(r, { harvested: 0, planted: 11, ripe: 1, growing: 11, bare: 0 });
  t.false(f.calls.some(c => c.startsWith('dig')));
});

test('the soul sand set in by hand, cell by cell from the walk: the bridge\'s own dig of that one grass block, the soul sand in its hole; nothing else dug; a cell over something else left be', async (t) => {
  const m = wartFarmMilestone(['brewing']);
  const step = m.steps[3];
  t.is(step.name, 'set the wart farm\'s soul sand into the ground');
  // the strip just built over the lawn: grass under every cell, one cell over a cobblestone someone left
  const blocks = new Map<string, string>(CELLS.map(c => [k3({ ...c, y: c.y - 1 }), 'minecraft:grass_block']));
  const odd = { ...CELLS[5], y: CELLS[5].y - 1 };
  blocks.set(k3(odd), 'minecraft:cobblestone');
  const world = farmWorld([{ slot: 0, name: 'soul_sand', count: 12 }], { progress: { done: ['brewing'], journal: [], current: { id: 'wart-farm', step: 3, data: {} } } });
  const f = strip([{ slot: 0, name: 'diamond_sword', count: 1 }], world, [{ slot: 0, name: 'soul_sand', count: 12 }], blocks);
  const r = await step.run(f.ctx, world.progress!.current!);
  t.like(r, { status: 'progress', text: 'soul sand under 11 of 12 wart cells, 1 over something else' });
  t.is(f.calls[0], 'take soul_sand x12');
  const dug = f.calls.filter(c => c.startsWith('dig ')).map(c => c.slice(4));
  t.deepEqual(dug.sort(), CELLS.filter((_, i) => i !== 5).map(c => k3({ ...c, y: c.y - 1 })).sort(), 'only the grass under the wart cells');
  t.is(f.calls.filter(c => c.startsWith('place soul_sand')).length, 11);
  t.is(f.blocks.get(k3(odd)), 'minecraft:cobblestone', 'left be');
  for (const c of f.calls.filter(x => x.startsWith('goto'))) t.true(WALKS.some(w => c === `goto ${k3(w)} careful`), c);
  // all set: done
  const g = strip([], farmWorld([]), [], new Map());
  t.like(await step.run(g.ctx, { step: 3, data: {} }), { status: 'done', text: 'soul sand under all 12 wart cells' });
  // none to set: short of it
  const h = strip([], farmWorld([]), [], new Map(CELLS.map(c => [k3({ ...c, y: c.y - 1 }), 'minecraft:grass_block'])));
  t.like(await step.run(h.ctx, { step: 3, data: {} }), { status: 'blocked', need: { soul_sand: 12 } });
});

test('the ground the site step finds free is lifted too: stone a levelling bared, sand, deepslate under a cell get their soul sand (left be, the milestone stalled at every run); the site finder calls them free', async (t) => {
  const step = wartFarmMilestone(['brewing']).steps[3];
  // the site step's look (site.ts occupancy): a column whose top block at the level is stone or sand is free
  for (const top of ['minecraft:stone', 'minecraft:sand', 'minecraft:deepslate']) {
    t.is(occupancy({ x: 0, y: 61, z: 0, width: 1, height: 4, length: 1 }, ['minecraft:dirt', top, 'minecraft:air', 'minecraft:air'], 62).cells[0], 'free', top);
  }
  const blocks = new Map<string, string>(CELLS.map(c => [k3({ ...c, y: c.y - 1 }), 'minecraft:grass_block']));
  const odd = [CELLS[2], CELLS[5], CELLS[9]].map(c => ({ ...c, y: c.y - 1 }));
  blocks.set(k3(odd[0]), 'minecraft:stone');
  blocks.set(k3(odd[1]), 'minecraft:sand');
  blocks.set(k3(odd[2]), 'minecraft:deepslate');
  const world = farmWorld([{ slot: 0, name: 'soul_sand', count: 12 }], { progress: { done: ['brewing'], journal: [], current: { id: 'wart-farm', step: 3, data: {} } } });
  const f = strip([{ slot: 0, name: 'diamond_sword', count: 1 }], world, [{ slot: 0, name: 'soul_sand', count: 12 }], blocks);
  const digs: number[] = [];
  const inner = f.ctx.call;
  f.ctx.call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'dig.here') digs.push(Number(p?.timeoutMs));
    return inner(m, p);
  }) as GoalContext['call'];
  t.like(await step.run(f.ctx, world.progress!.current!), { status: 'done', text: 'soul sand set under all 12 wart cells' });
  for (const g of odd) t.is(f.blocks.get(k3(g)), 'minecraft:soul_sand', k3(g));
  t.true(digs.every(ms => ms >= 15_000), `a dig long enough for deepslate by hand: ${digs.join(', ')}`);
});
