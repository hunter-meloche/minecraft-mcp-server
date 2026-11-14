import test from 'ava';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { InventoryItem } from '../../src/client/tools.js';
import { inByGate, leaveYard } from '../../src/client/brain/yardgates.js';
import { goHome, walkHome } from '../../src/client/brain/homeward.js';
import { oreTrip } from '../../src/client/brain/deep.js';
import { LADDER } from '../../src/client/brain/worktasks.js';
import { lights, putAway, stashKeep, stock, stockShort, toTheWoods } from '../../src/client/brain/chores.js';
import { gatherFood } from '../../src/client/brain/food.js';
import { cutStand } from '../../src/client/brain/cane.js';
import { donateGoal } from '../../src/client/brain/community.js';

/**
 * The walks that cross the yard's fence go by its gates, both ways (yardgates.ts): Baritone's cheapest way across the
 * fence was over it, on cobblestone (the stair it left over the north gate, Nov 13). The live yard: x -565..-533, z
 * 2119..2215, its ground at y 62, home (-549, 63, 2183), the four gates on the fence's middles. The stand-in world is
 * flat at y 62; every walk gets where it is sent (or, as `shut` says, not), and one that goes from one side of the
 * fence to the other except through a gate (from its cell 2 inside to the one 2 outside, or back) is written down as
 * a climb over it.
 */

const HOME: Pos = { x: -549, y: 63, z: 2183 };
const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
const GATES: Record<'north' | 'east' | 'south' | 'west', Pos> = {
  north: { x: -549, y: 63, z: 2119 }, east: { x: -533, y: 63, z: 2183 }, south: { x: -549, y: 63, z: 2215 }, west: { x: -565, y: 63, z: 2183 }
};
const STEP: Record<string, [number, number]> = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
const T0 = Date.UTC(2026, 10, 13, 20, 0, 0);
const k = (p: Pos) => `${p.x},${p.y},${p.z}`;
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const inside = (p: { x: number; z: number }) => p.x > YARD.x1 && p.x < YARD.x2 && p.z > YARD.z1 && p.z < YARD.z2;
/**
 * A walk through a gate: both ends on its way (a block either side of its line across the fence at most), each
 * within 3 of it, one inside the fence and one in the gateway or outside it.
 */
const throughGate = (a: Pos, b: Pos) => Object.entries(GATES).some(([side, g]) => {
  const [dx, dz] = STEP[side];
  const along = (p: Pos) => (p.x - g.x) * dx + (p.z - g.z) * dz, across = (p: Pos) => Math.abs((p.x - g.x) * dz - (p.z - g.z) * dx);
  return [a, b].every(p => across(p) <= 1 && Math.abs(along(p)) <= 3) && Math.min(along(a), along(b)) <= -1 && Math.max(along(a), along(b)) >= 0;
});

const liveWorld = (over: Partial<WorldMemory> = {}): WorldMemory => ({
  landmarks: { chests: [], farmland: [] }, leash: 96, yard: { ...YARD }, zones: { 'fence:gate': Object.values(GATES).map(g => ({ ...g })) }, ...over
} as WorldMemory);

/**
 * The bot at `at` in that world. `shut`: blocks a walk to which does not get there (the bot stays where it was); the
 * miner's walk takes it to (-500, 63, 2150), east of the yard. Every walk is written down (`walks`: the block, careful, at any height), each
 * act (`acts`), go-home's time (`homeMs`), and every crossing of the fence that is not through a gate (`climbs`).
 */
function bot(at: Pos, opts: { world?: WorldMemory; shut?: (to: Pos) => boolean; dimension?: string; items?: InventoryItem[]; timeOfDay?: number } = {}) {
  const world = opts.world ?? liveWorld();
  const me = { pos: { ...at }, walks: [] as string[], climbs: [] as string[], said: [] as string[], acts: [] as string[], homeMs: [] as number[], looks: 0, explored: [] as Pos[] };
  const move = (to: Pos, how: string) => {
    if (inside(me.pos) !== inside(to) && !throughGate(me.pos, to)) me.climbs.push(`${how} ${fmt(me.pos)} to ${fmt(to)}`);
    me.pos = { ...to };
  };
  const items = opts.items ?? [];
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  const s: Snapshot = {
    now: T0, timeOfDay: opts.timeOfDay ?? 1000, activity: 'work', health: 20, food: 20, position: { x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, dimension: opts.dimension ?? 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items, counts, slotsUsed: items.filter(i => i.slot < 36).length,
    home: { ...HOME, dimension: 'overworld' }, distHome: Math.hypot(at.x - HOME.x, at.z - HOME.z)
  };
  const ac = new AbortController();
  const ctx: GoalContext = {
    s, world, signal: ac.signal,
    progress: l => { me.said.push(l); },
    gain: () => undefined,
    status: async () => { me.looks++; return { inWorld: true, username: 'claudebot', screen: null, position: { x: me.pos.x + 0.5, y: me.pos.y, z: me.pos.z + 0.5 }, dimension: opts.dimension ?? 'overworld' }; },
    call: (async (method: string, p: Record<string, unknown> = {}) => {
      if (method === 'world.region') {
        const out: string[] = [];
        for (let y = 0; y < Number(p.height); y++) for (let z = 0; z < Number(p.length); z++) for (let x = 0; x < Number(p.width); x++) {
          const h = Number(p.y) + y;
          out.push(h < YARD.y ? 'dirt' : h === YARD.y ? 'grass_block' : 'air');
        }
        return { blocks: out };
      }
      if (method === 'foreign.zones') return { zones: [] };
      // (no light anywhere: every spot a mob could stand on is dark)
      if (method === 'world.light') return { block: new Array(Number(p.width) * Number(p.height) * Number(p.length)).fill(0) };
      if (method === 'inventory') return { items: items.map(i => ({ ...i })) };
      if (method === 'world.findBlocks' || method === 'world.entities') return { positions: [], entities: [] };
      if (method === 'goto') {
        const to = { x: Number(p.x), y: p.xz ? 63 : Number(p.y), z: Number(p.z) };
        me.walks.push(`${k(to)}${p.careful ? ' careful' : ''}${p.xz ? ' xz' : ''}`);
        if (opts.shut?.(to)) return { arrived: false };
        move(to, 'goto');
        return { arrived: true };
      }
      return {};
    }) as GoalContext['call'],
    act: async (tool, a = {}) => {
      me.acts.push(tool);
      const to = { x: Number(a.x), y: Number(a.y), z: Number(a.z) };
      if (tool === 'go-home') { me.homeMs.push(Number(a.timeoutMs)); move({ ...HOME }, 'go-home'); return { ok: true, text: 'Home' }; }
      if (tool === 'move-to-position') { move(to, tool); return { ok: true, text: `Successfully moved to position near ${fmt(to)}` }; }
      if (tool === 'explore') {
        const [dx, dz] = STEP[String(a.direction)];
        move({ x: me.pos.x + dx * Number(a.maxDistance), y: 63, z: me.pos.z + dz * Number(a.maxDistance) }, `explore ${a.direction}`);
        me.explored.push({ ...me.pos });
        return { ok: true, text: `No ${a.target} within ${a.maxDistance} blocks ${a.direction}` };
      }
      if (tool === 'mine-blocks') { move({ x: -500, y: 63, z: 2150 }, tool); return { ok: true, text: `Mined 0 ${a.block}: nothing gained` }; }
      if (tool === 'drop-item') return { ok: true, text: `Dropped ${a.count} ${a.item}` };
      if (tool === 'store-in-chest') return { ok: true, text: `Stored ${a.count} ${a.item} in the chest at ${fmt(to)}` };
      return { ok: true, text: 'ok' };
    }
  };
  return { me, ctx, world, abort: () => ac.abort() };
}

const cells = (side: keyof typeof GATES, inward: boolean) => {
  const g = GATES[side], [dx, dz] = STEP[side];
  const inner = `${g.x - 2 * dx},63,${g.z - 2 * dz} careful`, outer = `${g.x + 2 * dx},63,${g.z + 2 * dz}`;
  return inward ? [outer, inner] : [inner, `${outer} careful`];
};

// ------------------------------------------------------------------------------------------------ coming home

test('a walk home from outside the fence goes to the cell 2 outside the gate on its way, through to the one 2 inside carefully, then go-home: never over the fence', async (t) => {
  // on the lake shore by the cane patch, 5 out from the east fence: careful along the fence (walk only) to the east gate
  const shore = bot({ x: -528, y: 63, z: 2200 });
  t.deepEqual(await walkHome(shore.ctx, { timeoutMs: 600_000 }), { ok: true, text: 'Home' });
  t.deepEqual(shore.me.walks, ['-531,63,2183 careful', '-535,63,2183 careful']);
  t.deepEqual(shore.me.said, ['into the yard by its east gate (-533, 63, 2183)']);
  t.deepEqual(shore.me.acts, ['go-home']);
  t.deepEqual(shore.me.climbs, []);
  // go-home has what is left of the walk's time
  t.true(shore.me.homeMs[0] <= 600_000 && shore.me.homeMs[0] > 590_000);
  // far out north: toward the north gate at any height first (as go-home's own legs go), to 32 from its outer cell,
  // then Baritone's own way to that cell (out there it is not careful), and through
  const far = bot({ x: -549, y: 70, z: 1900 });
  t.deepEqual(await walkHome(far.ctx, { timeoutMs: 600_000 }), { ok: true, text: 'Home' });
  t.deepEqual(far.me.walks, ['-549,63,2085 xz', ...cells('north', true)]);
  t.deepEqual(far.me.climbs, []);
  // 300 out: two legs, 200 at most each
  const farther = bot({ x: -549, y: 70, z: 1817 });
  await walkHome(farther.ctx, { timeoutMs: 600_000 });
  t.deepEqual(farther.me.walks, ['-549,63,2017 xz', '-549,63,2085 xz', ...cells('north', true)]);
  // in the gateway itself (on the fence line): straight through to the cell inside
  const gateway = bot({ ...GATES.south });
  await walkHome(gateway.ctx, { timeoutMs: 600_000 });
  t.deepEqual(gateway.me.walks, ['-549,63,2213 careful']);
  t.deepEqual(gateway.me.climbs, []);
  // the trips' own go-home between their legs comes in the same way
  const trip = bot({ x: -500, y: 63, z: 2183 });
  t.deepEqual(await goHome(trip.ctx, 300_000), { ok: true, text: 'Home' });
  t.deepEqual(trip.me.walks, cells('east', true));
  t.deepEqual(trip.me.climbs, []);
});

test('a walk home never takes a leg at any height across the yard: to the next gate round the fence it walks to the gate\'s cell itself', async (t) => {
  // 65 out west: a leg toward the west gate (its straight way clear of the yard), then its cells
  const west = bot({ x: -630, y: 63, z: 2160 });
  await walkHome(west.ctx, { timeoutMs: 600_000 });
  t.deepEqual(west.me.walks, ['-597,63,2172 xz', ...cells('west', true)]);
  // north-east of the yard, the east gate shut: a leg toward it, then on to the next gate, the north, 68 off round the
  // fence's corner. A leg toward that would end in the yard (and "any height" there is the caves under it): none,
  // and the walk to its cell is careful, along the fence
  const corner = bot({ x: -500, y: 63, z: 2100 }, { shut: p => p.x === -535 && p.z === 2183 });
  await walkHome(corner.ctx, { timeoutMs: 600_000 });
  t.deepEqual(corner.me.walks, ['-520,63,2153 xz', '-531,63,2183', '-535,63,2183 careful', '-549,63,2117 careful', '-549,63,2121 careful']);
  t.deepEqual(corner.me.said, ['into the yard by its east gate (-533, 63, 2183)', 'into the yard by its north gate (-549, 63, 2119)']);
  t.deepEqual([...west.me.climbs, ...corner.me.climbs], []);
});

test('inside the yard every walk home is go-home as it was: no gate, no look, the whole time', async (t) => {
  for (const at of [{ x: -549, y: 63, z: 2150 }, { x: -560, y: 63, z: 2125 }, { ...HOME }]) {
    const b = bot(at);
    t.deepEqual(await walkHome(b.ctx, { timeoutMs: 600_000 }), { ok: true, text: 'Home' });
    t.deepEqual(b.me.walks, []);
    t.deepEqual(b.me.said, []);
    t.deepEqual(b.me.homeMs, [600_000]);
  }
  // no gate known (a yard not fenced yet, a new home): go-home as it was, from anywhere, and nothing looked at
  const none = bot({ x: -500, y: 63, z: 2183 }, { world: liveWorld({ zones: {} }) });
  t.deepEqual(await inByGate(none.ctx, 300_000), {});
  t.is(none.me.looks, 0);
  await walkHome(none.ctx, { timeoutMs: 600_000 });
  t.deepEqual(none.me.walks, []);
  t.deepEqual(none.me.homeMs, [600_000]);
  // home outside the fence, another dimension, or deep down (walkHome climbs out first, or leaves it to go-home where
  // it may not climb): no gate walk
  const outHome = bot({ x: -500, y: 63, z: 2183 });
  outHome.ctx.s = { ...outHome.ctx.s, home: { x: -480, y: 63, z: 2183, dimension: 'overworld' } };
  t.deepEqual(await inByGate(outHome.ctx, 300_000), {});
  t.deepEqual(await inByGate(bot({ x: -500, y: 63, z: 2183 }, { dimension: 'the_nether' }).ctx, 300_000), {});
  const deep = bot({ x: -500, y: 40, z: 2183 });
  t.deepEqual(await inByGate(deep.ctx, 300_000), {});
  t.deepEqual(deep.me.walks, []);
});

test('a gate that does not let it in: the next on the way, two at most, then go-home\'s own way as it was, so the walk home at dusk still gets home', async (t) => {
  // the east gate's way through blocked (a cow in the gateway, a block in it): round to the next, the west
  const blocked = bot({ x: -528, y: 63, z: 2200 }, { shut: p => p.x === -535 && p.z === 2183 });
  t.like(await inByGate(blocked.ctx, 540_000), { gate: GATES.west });
  t.deepEqual(blocked.me.walks, ['-531,63,2183 careful', '-535,63,2183 careful', '-567,63,2183 careful', '-563,63,2183 careful']);
  t.deepEqual(blocked.me.said, ['into the yard by its east gate (-533, 63, 2183)', 'into the yard by its west gate (-565, 63, 2183)']);
  t.deepEqual(blocked.me.climbs, []);
  // neither lets it in: go-home all the same, in the evening as by day (the shelter's walk home is this one)
  const shut = bot({ x: -528, y: 63, z: 2200 }, { shut: p => inside(p), timeOfDay: 11_500 });
  t.deepEqual(await walkHome(shut.ctx, { timeoutMs: 600_000 }), { ok: true, text: 'Home' });
  t.deepEqual(shut.me.said.at(-1), 'no way into the yard by the east gate (-533, 63, 2183) or the west gate (-565, 63, 2183): home by go-home\'s own way');
  t.deepEqual(shut.me.acts, ['go-home']);
  t.true(shut.me.homeMs[0] >= 60_000);
  // a walk cut short (the brain stopped the run): no go-home after it
  const cut = bot({ x: -528, y: 63, z: 2200 });
  cut.ctx.call = (async () => { cut.abort(); return { arrived: false }; }) as GoalContext['call'];
  await t.throwsAsync(goHome(cut.ctx, 300_000), { message: 'aborted' });
  t.deepEqual(cut.me.acts, []);
});

// ------------------------------------------------------------------------------------------------ leaving

test('out of the yard by a gate: toward a place, by the gate on its way; along a side, by that side\'s; to an end not known, by the nearest; from outside or to inside, no walk', async (t) => {
  const mine = bot({ ...HOME });
  t.deepEqual(await leaveYard(mine.ctx, { x: -493, z: 2183 }), { gate: GATES.east, at: { x: -530.5, y: 63, z: 2183.5 } });
  t.deepEqual(mine.me.walks, cells('east', false));
  t.deepEqual(mine.me.said, ['out of the yard by its east gate (-533, 63, 2183)']);
  const north = bot({ ...HOME });
  t.like(await leaveYard(north.ctx, 'north'), { gate: GATES.north });
  t.deepEqual(north.me.walks, cells('north', false));
  // the miner's walk: where to is Baritone's to know, the gate nearest the bot (in the yard's north end: the north one)
  const miner = bot({ x: -560, y: 63, z: 2140 });
  t.like(await leaveYard(miner.ctx), { gate: GATES.north });
  t.deepEqual(miner.me.walks, cells('north', false));
  for (const [from, to] of [[{ x: -500, y: 63, z: 2183 }, { x: -480, z: 2183 }], [{ ...HOME }, { x: -540, z: 2150 }]] as const) {
    const b = bot(from);
    t.deepEqual(await leaveYard(b.ctx, to), {});
    t.deepEqual(b.me.walks, []);
  }
  t.deepEqual([mine, north, miner].flatMap(b => b.me.climbs), []);
  // no gate lets it out: said, and the walk goes on as it would have (Baritone may place nothing by the fence)
  const shut = bot({ ...HOME }, { shut: p => !inside(p) });
  t.like(await leaveYard(shut.ctx, { x: -493, z: 2183 }), { shut: 'no way out of the yard by the east gate (-533, 63, 2183) or the west gate (-565, 63, 2183) or the south gate (-549, 63, 2215) or the north gate (-549, 63, 2119)' });
  t.regex(shut.me.said.at(-1)!, /: on by Baritone's own way$/);
});

test('the walks that leave the yard go out by a gate: the deep trip to its mine start, the surface rung\'s and the stock trip\'s miner, the wood trip along each side and home between, a stand of wild cane, the junk to its dump, a gift to the community chest', async (t) => {
  // the deep trip's walk to the mine start east of the yard (it stops short there: the trip is untried, and ends)
  const deep = bot({ ...HOME }, { world: liveWorld({ zones: { 'fence:gate': Object.values(GATES).map(g => ({ ...g })), mine: [{ x: -493, y: 63, z: 2183 }] } }), shut: p => p.x === -493 });
  t.like(await oreTrip(deep.ctx, { wants: [{ family: 'iron', ores: 'iron_ore', items: ['raw_iron'], want: 8 }], budgetMs: 300_000 }), { untried: true });
  t.deepEqual(deep.me.walks, [...cells('east', false), '-493,63,2183 xz']);
  // the surface rung: Baritone's miner goes where it knows coal is, from outside the fence (the gate nearest home)
  const surface = bot({ ...HOME });
  t.like(await LADDER.find(r => r.name === 'surface')!.run(surface.ctx, 'coal', 300_000, Date.now), { gain: 0 });
  t.deepEqual(surface.me.walks, cells('east', false));
  t.deepEqual(surface.me.acts, ['mine-blocks']);
  // the stock trip for coal (the chests have the rest): out by the nearest gate, the miner, and home in by the gate on
  // the way back from where it mined
  const kit: InventoryItem[] = ['stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword'].map((name, slot): InventoryItem => ({ slot, name, count: 1, damage: 0, maxDamage: 131 }))
    .concat(['iron_boots', 'iron_leggings', 'iron_chestplate', 'iron_helmet'].map((name, i) => ({ slot: 36 + i, name, count: 1, damage: 0, maxDamage: 200 })))
    .concat([{ slot: 10, name: 'torch', count: 20 }, { slot: 11, name: 'cobblestone', count: 40 }, { slot: 12, name: 'bread', count: 5 }]);
  const chest = { x: -547, y: 63, z: 2182 };
  const stocked = liveWorld({ landmarks: { chests: [chest], farmland: [] }, chestItems: { [k(chest)]: { oak_log: 40, cobblestone: 64, iron_ingot: 20 } } });
  const trip = bot({ ...HOME }, { items: kit, world: stocked });
  t.deepEqual(stockShort(trip.ctx.s, stocked).map(x => x.name), ['coal']);
  t.is(await stock.run(trip.ctx), 'Mined 0 coal_ore,deepslate_coal_ore: nothing gained; back home');
  t.deepEqual(trip.me.walks, [...cells('east', false), ...cells('east', true)]);
  t.deepEqual(trip.me.acts, ['mine-blocks', 'go-home']);
  // the wood trip, no tree in sight: out by each side's gate to look along it, and home in by the same gate between
  const woods = bot({ ...HOME });
  t.false((await toTheWoods(woods.ctx, ['oak_log'])).ok);
  t.deepEqual(woods.me.said.filter(l => /the yard by/.test(l)), ['north', 'east', 'south', 'west'].flatMap(side => {
    const g = GATES[side as keyof typeof GATES];
    return [`out of the yard by its ${side} gate ${fmt(g)}`, `into the yard by its ${side} gate ${fmt(g)}`];
  }));
  t.deepEqual(woods.me.acts.filter(a => a !== 'go-home'), ['explore', 'explore', 'explore', 'explore']);
  // and each side's look from the gate no further than the leash is from home: explore counts from where it starts,
  // the gate's outer cell 66 out north, 18 east and west, 34 south (its whole 96 from there went to 162 out)
  t.true(woods.me.explored.every(p => horiz(p, HOME) <= 96 && horiz(p, HOME) >= 94), woods.me.explored.map(p => horiz(p, HOME).toFixed(1)).join(', '));
  t.is(woods.me.explored.length, 4);
  // a stand of wild cane 70 out east: by the east gate, then the walk to it
  const cane = bot({ ...HOME });
  t.like(await cutStand(cane.ctx, { x: -479, y: 63, z: 2182 }, () => true), { gone: true });
  t.deepEqual(cane.me.walks, cells('east', false));
  t.deepEqual(cane.me.acts, ['move-to-position']);
  // the stash's junk, thrown 8 out from the fence (north: no heat map, the first spot): out by the north gate, and
  // home in by it
  const items: InventoryItem[] = [0, 1, 2].map(slot => ({ slot, name: 'dirt', count: 64 }));
  const junk = bot({ ...HOME }, { items });
  await putAway(junk.ctx, junk.ctx.s, stashKeep(junk.world, 'trip'));
  t.deepEqual(junk.me.acts, ['move-to-position', 'drop-item', 'go-home']);
  // (from 6 out the walk back to the gate's cell is careful: by the fence)
  t.deepEqual(junk.me.walks, [...cells('north', false), '-549,63,2117 careful', '-549,63,2121 careful']);
  // the iron over what the bot and the work queue keep, to the community chest 120 out east-north-east: out by the
  // east gate, to the chest, and home by the same gate (a leg toward it first, at any height out there)
  const iron: InventoryItem[] = [64, 64, 64, 8].map((count, slot) => ({ slot, name: 'iron_ingot', count }));
  const gift = bot({ ...HOME }, { items: iron, world: liveWorld({ community: { chests: { community1: { x: -437, y: 68, z: 2134 } }, missions: [], nextId: 1 } }) });
  t.is(await donateGoal.run(gift.ctx), 'donated to community1: 104 iron_ingot');
  t.deepEqual(gift.me.walks, [...cells('east', false), '-437,68,2134', '-503,63,2168 xz', ...cells('east', true)]);
  t.deepEqual(gift.me.acts, ['store-in-chest', 'go-home']);
  t.deepEqual([deep, surface, trip, woods, cane, junk, gift].flatMap(b => b.me.climbs), []);
});

test('a side walk goes out by that side\'s own gate only: with it shut, not round by another side\'s (whose walk on along the side would cross the yard at any height); a walk to a place takes any', async (t) => {
  const eastShut = (p: Pos) => p.x >= -535 && Math.abs(p.z - GATES.east.z) <= 1;
  const side = bot({ ...HOME }, { shut: eastShut });
  t.deepEqual(await leaveYard(side.ctx, 'east'), { shut: 'no way out of the yard by the east gate (-533, 63, 2183)' });
  t.deepEqual(side.me.walks, [`${cells('east', false)[0]}`]);
  t.deepEqual(side.me.said.at(-1), 'no way out of the yard by the east gate (-533, 63, 2183): on by Baritone\'s own way');
  // the wood trip east from in the yard, its gate shut: explores from where it stands, home, never out by the west gate
  const woods = bot({ ...HOME }, { shut: eastShut });
  t.false((await toTheWoods(woods.ctx, ['oak_log'], false, { dirs: ['east'] })).ok);
  t.false(woods.me.said.some(l => /^out of the yard by its (north|south|west) gate/.test(l)), woods.me.said.join('\n'));
  t.true(woods.me.said.includes('no way out of the yard by the east gate (-533, 63, 2183): on by Baritone\'s own way'));
  t.is(woods.me.explored.length, 1);
  t.true(woods.me.explored.every(p => horiz(p, HOME) <= 96));
  const place = bot({ ...HOME }, { shut: eastShut });
  const out = await leaveYard(place.ctx, { x: -493, z: 2183 });
  t.truthy(out.gate);
  t.not(out.gate, GATES.east);
  t.deepEqual(place.me.climbs, []);
});

test('the food hunt, hungry with no game round home: out by each side\'s gate to look along it, and from there no further than the leash is from home', async (t) => {
  const b = bot({ ...HOME });
  b.ctx.s.food = 6;
  await t.throwsAsync(gatherFood(b.ctx, 20, false), { message: /^no food to be had right now/ });
  t.is(b.me.acts.filter(a => a === 'explore').length, 4);
  t.deepEqual(b.me.said.filter(l => /^out of the yard by/.test(l)), ['north', 'east', 'south', 'west'].map(side => `out of the yard by its ${side} gate ${fmt(GATES[side as keyof typeof GATES])}`));
  t.true(b.me.explored.every(p => horiz(p, HOME) <= 96 && horiz(p, HOME) >= 94), b.me.explored.map(p => horiz(p, HOME).toFixed(1)).join(', '));
  t.deepEqual(b.me.climbs, []);
});

test('the lights round\'s torches for the band outside the fence: out by a gate before the first, not by place-block\'s own walk over the fence', async (t) => {
  // (place-block walks into reach by Baritone's own way; the stand-in places none, so every torch planned is tried)
  const torches: InventoryItem[] = [{ slot: 0, name: 'torch', count: 30 }];
  const b = bot({ ...HOME }, { items: torches });
  const seq: string[] = [];
  const { act, call } = b.ctx;
  b.ctx.act = async (tool, a = {}) => {
    // (the yard's own round lights the fence line too: outside it by 2 or more is the band's)
    const out = Math.max(YARD.x1 - Number(a.x), Number(a.x) - YARD.x2, YARD.z1 - Number(a.z), Number(a.z) - YARD.z2);
    if (tool === 'place-block') seq.push(`torch ${out >= 2 ? 'outside' : 'in the yard'}`);
    return act(tool, a);
  };
  b.ctx.call = (async (method: string, p: Record<string, unknown> = {}, ms?: number) => {
    if (method === 'goto') seq.push(`walk ${p.x},${p.y},${p.z}`);
    return call(method, p, ms);
  }) as GoalContext['call'];
  await lights.run(b.ctx);
  const first = seq.indexOf('torch outside');
  t.true(first > 0, seq.join('\n'));
  // the gate's two cells, then the band's torches; none in the yard after it
  const gate = Object.entries(GATES).find(([side, g]) => seq[first - 2] === `walk ${g.x - 2 * STEP[side][0]},63,${g.z - 2 * STEP[side][1]}` && seq[first - 1] === `walk ${g.x + 2 * STEP[side][0]},63,${g.z + 2 * STEP[side][1]}`);
  t.truthy(gate, seq.slice(Math.max(0, first - 3), first + 1).join('; '));
  t.false(seq.slice(0, first - 2).some(l => l.startsWith('walk')), 'no walk before: the yard\'s torches are placed from the yard');
  t.false(seq.slice(first).includes('torch in the yard'));
});

test('without the gates the same walks went over the fence: the stand-in world tells a climb from a gate', async (t) => {
  // (the check the tests above lean on: with no gate known each walk goes straight, as before this fix)
  const world = liveWorld({ zones: {} });
  const surface = bot({ ...HOME }, { world });
  await LADDER.find(r => r.name === 'surface')!.run(surface.ctx, 'coal', 300_000, Date.now);
  t.deepEqual(surface.me.climbs, ['mine-blocks (-549, 63, 2183) to (-500, 63, 2150)']);
  const home = bot({ x: -528, y: 63, z: 2200 }, { world });
  await walkHome(home.ctx, { timeoutMs: 600_000 });
  t.deepEqual(home.me.climbs, ['go-home (-528, 63, 2200) to (-549, 63, 2183)']);
});
