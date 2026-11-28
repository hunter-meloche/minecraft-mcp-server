import test from 'ava';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { InventoryItem } from '../../src/client/tools.js';
import { gateRead, gatesRead, inByGate, leaveYard, onYardFence, openGate, outByGate, outOfPen, penFences, shutGate, shutNow, strictGates, strictSet, throughPenGate, yardWhy, type PenWay } from '../../src/client/brain/yardgates.js';
import { inHallOrLock } from '../../src/client/brain/fetch.js';
import { lockOf } from '../../src/client/brain/villagerwalk.js';
import { brainRun } from '../../src/client/tools.js';
import { H as HALL_GATE, P as LOCK_GATE, YARD_GATES as LIVE_GATES, isOpen, yard, type Pasture } from '../helpers/pasture.js';
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
  const me = { pos: { ...at }, walks: [] as string[], climbs: [] as string[], said: [] as string[], acts: [] as string[], homeMs: [] as number[], looks: 0, explored: [] as Pos[], throws: [] as string[] };
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
      if (tool === 'drop-item') { me.throws.push(`${a.item} from ${fmt(me.pos)} toward ${fmt(to)}`); return { ok: true, text: `Dropped ${a.count} ${a.item}` }; }
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
  // thrown away from the fence, 8 further out from the yard's middle (along the look it had, at the ground or a hill,
  // it fell at its feet and came back: "stored 0, dropped 605", three stashes in a row, Nov 19)
  t.deepEqual(junk.me.throws, ['dirt from (-549, 63, 2111) toward (-549, 64, 2103)']);
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

// ------------------------------------------------------------------------------------------------ a gate read, clicked, read again

/**
 * The gates' own clicks (shutGate, openGate, shutNow) over the pasture (tests/helpers/pasture.ts): the live yard with
 * its fence and gates, the hall, the lock in front of it and the pens, the bridge's reach rules and its gate closer
 * ported from the Java. The bot's own walk opens a gate it passes; the closer shuts one once the bot is 2.2 clear of
 * it; a raw click (useOn) lands two ticks after it is asked and toggles the gate as it stands THEN.
 */

const SOUTH = LIVE_GATES.south, EAST = LIVE_GATES.east;
/** The last of a list that `ok` takes, and where it is (-1: none). */
const lastIndex = <T>(list: readonly T[], ok: (e: T) => boolean): number => { for (let i = list.length - 1; i >= 0; i--) if (ok(list[i])) return i; return -1; };
const lastOf = <T>(list: readonly T[], ok: (e: T) => boolean): T | undefined => list[lastIndex(list, ok)];
/** what was asked of the bridge and the tools since call `from`, by name */
const asked = (p: Pasture, from = 0) => p.log.slice(from).map(e => (e.kind === 'act' ? `act ${e.name}` : e.name));
/** what happened to a gate, in order: opened or shut, and by what */
const swings = (p: Pasture, g: Pos) => p.changed.filter(c => k(c.at) === k(g)).map(c => `${isOpen(c.to) ? 'open' : 'shut'}: ${c.how}`);
/** the last look at a gate's block on the log: what it read */
const lastRead = (p: Pasture, g: Pos) => {
  const e = lastOf(p.log, x => x.name === 'world.region' && x.params.width === 1 && x.params.height === 1 && k(x.params as unknown as Pos) === k(g));
  return (e?.reply as { blocks?: (string | null)[] } | undefined)?.blocks?.[0];
};
/** a jar from before the gate holds: the bridge knows no gates.release */
const oldJar = (p: Pasture) => { p.on.call['gates.release'] = () => { throw new Error('unknown method gates.release'); }; };

test('never a blind toggle: a gate read shut is left alone, one that cannot be read is never clicked, one read open is clicked by the bridge\'s own shut-if-open and read again', async (t) => {
  // 3 inside the yard's south gate: in the click's reach, no walk
  const p = yard({ at: { x: -549, y: 63, z: 2212 } });
  t.true(await shutGate(p.ctx, SOUTH));
  t.deepEqual(asked(p), ['world.region'], 'shut: a look, and nothing else');
  // not read (the seconds after a rejoin: every cell null): not clicked, and not called shut
  p.swing(SOUTH, true, 'a player');
  p.blind(40);
  let n = p.log.length;
  t.false(await shutGate(p.ctx, SOUTH));
  t.deepEqual(asked(p, n), ['world.region']);
  t.is(await gateRead(p.ctx, SOUTH), undefined);
  t.true(isOpen(p.get(SOUTH)));
  p.advance(40);
  // read open: where the bot stands, the shut click, the look again
  n = p.log.length;
  t.true(await shutGate(p.ctx, SOUTH));
  t.deepEqual(asked(p, n), ['world.region', 'status', 'gates.release', 'world.region']);
  t.deepEqual(swings(p, SOUTH), ['open: a player', 'shut: shut (released)']);
  t.false(isOpen(lastRead(p, SOUTH)));
  // a jar without the bridge's own click: the raw useOn on the gate just read open, and the look again
  const q = yard({ at: { x: -549, y: 63, z: 2212 } });
  oldJar(q);
  q.swing(SOUTH, true, 'a player');
  t.true(await shutGate(q.ctx, SOUTH));
  t.deepEqual(asked(q), ['world.region', 'status', 'gates.release', 'world.region', 'useOn', 'world.region']);
  t.deepEqual(swings(q, SOUTH), ['open: a player', 'shut: useOn']);
  // never the tool (its own walk into reach is a plain one), and no walk at all from within reach
  for (const w of [p, q]) {
    t.false(w.log.some(e => e.kind === 'act'));
    t.deepEqual(w.walks, []);
  }
});

test('a gate the closer shuts between the look and the click: the bridge\'s own click cannot open it again; the raw click does, and the look after it catches that', async (t) => {
  // the bridge's shut-if-open reads the gate on the tick it clicks
  const p = yard({ at: { x: -549, y: 63, z: 2212 } });
  p.swing(SOUTH, true, 'a player');
  p.on.call['gates.release'] = (_a, w) => { w.swing(SOUTH, false, 'shut (closer)'); return undefined; };
  t.true(await shutGate(p.ctx, SOUTH));
  t.deepEqual(swings(p, SOUTH), ['open: a player', 'shut: shut (closer)']);
  t.false(asked(p).includes('useOn'));
  // the raw click toggles the gate as it stands when it lands, two ticks on (Interact.java): shut in between, it is
  // opened by the very click meant to shut it. Read again, clicked again, read shut: never left as it was not read
  const q = yard({ at: { x: -549, y: 63, z: 2212 } });
  oldJar(q);
  q.swing(SOUTH, true, 'a player');
  let once = true;
  q.on.call.useOn = (_a, w) => {
    if (once) w.at(w.tick + 1, () => w.swing(SOUTH, false, 'shut (closer)'));
    once = false;
    return undefined;
  };
  t.true(await shutGate(q.ctx, SOUTH));
  t.deepEqual(swings(q, SOUTH), ['open: a player', 'shut: shut (closer)', 'open: useOn', 'shut: useOn']);
  t.is(asked(q).filter(a => a === 'useOn').length, 2);
  t.false(isOpen(q.get(SOUTH)));
  t.false(isOpen(lastRead(q, SOUTH)), 'the last word on the gate is a look at it');
});

test('a gate that will not shut is said so after three tries, each a look, a click and a look; shutNow walks nowhere and clicks only a gate it reads open', async (t) => {
  const p = yard({ at: { x: -549, y: 63, z: 2212 } });
  p.swing(SOUTH, true, 'a player');
  // (the bridge cannot click it, and the raw click does nothing: something holds it)
  p.on.call['gates.release'] = () => ({ released: false, open: true });
  p.on.call.useOn = () => ({ used: true, changed: false });
  t.false(await shutGate(p.ctx, SOUTH));
  t.is(asked(p).filter(a => a === 'gates.release').length, 3);
  t.is(asked(p).filter(a => a === 'useOn').length, 3);
  t.is(asked(p).at(-1), 'world.region');
  t.true(isOpen(p.get(SOUTH)));
  // shutNow, the click of a run given up: from 16 off it asks the bridge (which goes on trying by itself) and the raw
  // click answers "too far": no walk
  const q = yard({ at: { x: -549, y: 63, z: 2199 } });
  q.swing(SOUTH, true, 'a player');
  await shutNow(q.ctx, SOUTH);
  t.deepEqual(asked(q), ['gates.release', 'world.region', 'useOn']);
  t.like(q.log.at(-1)!.reply, { used: false, reason: 'too far' });
  t.deepEqual(q.walks, []);
  // a gate that reads shut: asked of the bridge, never toggled
  const r = yard({ at: { x: -549, y: 63, z: 2212 } });
  oldJar(r);
  await shutNow(r.ctx, SOUTH);
  t.deepEqual(asked(r), ['gates.release', 'world.region']);
  t.deepEqual(swings(r, SOUTH), []);
});

test('out of the click\'s reach a shut walks up to the gate first, carefully, to 2 from it on the bot\'s own side; with `stay` it walks nowhere', async (t) => {
  // 16 in from the south gate, which a player left open: nobody's gate to the closer
  const p = yard({ at: { x: -549, y: 63, z: 2199 } });
  p.swing(SOUTH, true, 'a player');
  t.false(await shutGate(p.ctx, SOUTH, { stay: true }));
  t.deepEqual(p.walks, []);
  t.true(await shutGate(p.ctx, SOUTH));
  t.is(p.walks.length, 1);
  t.like(p.walks[0], { careful: true, arrived: true, to: { x: -549, y: 63, z: 2213 } });
  // (its own side: it never went through the gate to shut it)
  t.true(p.bot.at.z < SOUTH.z);
  t.false(isOpen(p.get(SOUTH)));
  t.false(p.log.some(e => e.kind === 'act'));
  t.is(p.broke.length, 0);
});

test('a gate opened by the raw click from where the bot stands: read first, clicked, read again; no wait at a gate that was only thought open, no walk to one out of reach', async (t) => {
  const p = yard({ at: { x: -549, y: 63, z: 2212 } });
  // shut: one click, and it reads open
  t.true(await openGate(p.ctx, SOUTH));
  t.deepEqual(asked(p), ['world.region', 'useOn', 'world.region']);
  // open already: a look, no click (a click would shut it)
  const n = p.log.length;
  t.true(await openGate(p.ctx, SOUTH));
  t.deepEqual(asked(p, n), ['world.region']);
  t.true(isOpen(p.get(SOUTH)));
  // one that does not open (the click does nothing): three tries, then "not open" is the answer
  const q = yard({ at: { x: -549, y: 63, z: 2212 } });
  q.on.call.useOn = () => ({ used: true, changed: false });
  t.false(await openGate(q.ctx, SOUTH));
  t.is(asked(q).filter(a => a === 'useOn').length, 3);
  t.is(asked(q).at(-1), 'world.region');
  // out of reach: the one click says so, and nothing walks
  const r = yard({ at: { x: -549, y: 63, z: 2199 } });
  t.false(await openGate(r.ctx, SOUTH));
  t.deepEqual(asked(r), ['world.region', 'useOn']);
  t.deepEqual(r.walks, []);
  // the look at the gate fails: it throws (the caller decides), nothing is clicked
  const f = yard({ at: { x: -549, y: 63, z: 2212 } });
  f.on.call['world.region'] = () => { throw new Error('timeout: world.region'); };
  await t.throwsAsync(openGate(f.ctx, SOUTH), { message: 'timeout: world.region' });
  t.deepEqual(asked(f), ['world.region']);
  t.false(await shutGate(f.ctx, SOUTH), 'and a shut, which never throws, says "not read shut"');
});

test('after a passage the gate is read shut: out of the yard by a gate, in by one, the closer on or off, the bridge with its own shut click or without', async (t) => {
  // out by the east gate from home: the bot stops 2 outside it, not yet the 2.2 clear the closer waits for
  const out = yard();
  t.like(await outByGate(out.ctx, { x: -493, z: 2183 }), { gate: EAST });
  t.deepEqual(swings(out, EAST), ['open: the bot\'s walk', 'shut: shut (released)']);
  t.false(isOpen(lastRead(out, EAST)));
  // (the look at the gate comes after the last step of the walk through it)
  t.true(lastIndex(out.log, e => e.name === 'world.region' && k(e.params as unknown as Pos) === k(EAST)) > lastIndex(out.log, e => e.name === 'goto'));
  t.true(out.walks.every(w => w.careful));
  // the closer switched off (as the pens have it for a walk in with an animal): the walk leaves the gate open, the
  // passage does not
  const off = yard();
  await off.ctx.call('gates.auto', { enabled: false, forMs: 120_000 });
  t.like(await leaveYard(off.ctx, 'east'), { gate: EAST });
  t.false(isOpen(off.get(EAST)));
  t.false(isOpen(lastRead(off, EAST)));
  // a jar without the bridge's own click: the raw one, read back
  const old = yard();
  oldJar(old);
  t.like(await outByGate(old.ctx, { x: -493, z: 2183 }), { gate: EAST });
  t.deepEqual(swings(old, EAST), ['open: the bot\'s walk', 'shut: useOn']);
  t.false(isOpen(lastRead(old, EAST)));
  // in by the east gate from 12 outside it: shut behind the bot before go-home walks on
  const into = yard({ at: { x: -521, y: 63, z: 2183 } });
  t.like(await inByGate(into.ctx, 120_000), { gate: EAST });
  t.true(into.bot.at.x < EAST.x);
  t.false(isOpen(into.get(EAST)));
  t.false(isOpen(lastRead(into, EAST)));
  t.true(lastIndex(into.log, e => e.name === 'world.region' && k(e.params as unknown as Pos) === k(EAST)) > lastIndex(into.log, e => e.name === 'goto'));
  // every yard gate reads shut after each of them, and no tool was used on a gate
  for (const w of [out, off, old, into]) {
    t.deepEqual((await gatesRead(w.ctx, w.world)).filter(g => g.open !== false).map(g => g.name), []);
    t.false(w.log.some(e => e.kind === 'act'));
    t.is(w.broke.length, 0);
  }
});

test('out of a pen by its gate: opened by the raw click from 2 inside, walked through, and shut and read shut behind; a run given up there has it shut from where the bot stands', async (t) => {
  const p = yard();
  const pen = penFences(p.world).find(f => f.kind === 'cow')!;
  const way: PenWay = pen.way!;
  p.bot.at = { ...way.deep };
  await throughPenGate(p.ctx, way);
  t.deepEqual(p.bot.at, way.outside);
  t.deepEqual(swings(p, way.gate), ['open: useOn', 'shut: shut (released)']);
  t.false(isOpen(lastRead(p, way.gate)));
  t.true(p.walks.every(w => w.careful));
  t.false(p.log.some(e => e.kind === 'act'));
  // (both cows still in the pen)
  t.is(p.animals.filter(a => a.name === 'cow' && a.position.x > pen.x1 && a.position.x < pen.x2 + 1 && a.position.z > pen.z1 && a.position.z < pen.z2 + 1).length, 2);
  // given up as the gate opens (the brain's stop: every call of the run fails from then on): the gate is asked shut
  // outside the run, from where the bot stands, by a click that cannot open it
  const q = yard();
  q.bot.at = { ...way.deep };
  const ac = new AbortController();
  const base = q.ctx;
  const ctx: GoalContext = {
    ...base, signal: ac.signal,
    call: (async (method: string, a?: Record<string, unknown>) => {
      if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      const r = await base.call(method, a);
      if (method === 'useOn') ac.abort();
      return r;
    }) as GoalContext['call']
  };
  q.bot.at = { ...way.inside };
  await t.throwsAsync(brainRun.run({ signal: ac.signal }, () => outOfPen(ctx)), { message: 'aborted' });
  t.deepEqual(swings(q, way.gate), ['open: useOn', 'shut: shut (released)']);
  t.deepEqual(q.walks.map(w => w.arrived), [true], 'the walk to the cell inside, and none after the stop');
});

test('the lock\'s two gates are clicked from where a click is safe: from the yard at the lock\'s post, never by a walk into the lock; from inside the hall, the lock\'s gate from the cell before the hall\'s', async (t) => {
  const p = yard({ at: { x: -550, y: 63, z: 2145 } });
  const lock = lockOf(p.world)!;
  // the hall's gate left open (a player's click): from the yard, to the post, and shut from there
  p.swing(HALL_GATE, true, 'a player');
  t.true(await shutGate(p.ctx, HALL_GATE));
  t.deepEqual(p.walks.map(w => [w.to, w.careful, w.arrived]), [[lock.post, true, true]]);
  t.deepEqual(p.bot.at, lock.post);
  t.deepEqual(swings(p, HALL_GATE), ['open: a player', 'shut: shut (released)']);
  t.deepEqual(swings(p, LOCK_GATE), [], 'the lock\'s gate never opened for it');
  // the lock's own gate from the post too
  p.bot.at = { x: -550, y: 63, z: 2145 };
  p.swing(LOCK_GATE, true, 'a player');
  t.true(await shutGate(p.ctx, LOCK_GATE));
  t.deepEqual(p.bot.at, lock.post);
  t.false(p.walks.some(w => inHallOrLock(p.world, w.at)));
  // from inside the hall (5 in from its gate): the lock's gate from the cell before the hall's gate, 4.2 by the eye,
  // the hall's gate never touched
  const q = yard({ at: { x: -556, y: 63, z: 2129 } });
  q.swing(LOCK_GATE, true, 'a player');
  t.false(await shutGate(q.ctx, LOCK_GATE, { stay: true }), 'from 5 in it is out of reach, and `stay` walks nowhere');
  t.deepEqual(q.walks, []);
  t.true(await shutGate(q.ctx, LOCK_GATE));
  t.deepEqual(q.bot.at, { x: HALL_GATE.x, y: 63, z: HALL_GATE.z - 1 });
  t.deepEqual(swings(q, HALL_GATE), []);
  t.false(isOpen(q.get(LOCK_GATE)));
  // and the hall's own gate from inside: up to it on the bot's own side, inside the hall
  q.bot.at = { x: -553, y: 63, z: 2128 };
  q.swing(HALL_GATE, true, 'a player');
  t.true(await shutGate(q.ctx, HALL_GATE));
  t.true(q.bot.at.z < HALL_GATE.z);
  // (the lock's gate was shut by the bridge itself: asked from 5 in, out of reach, it went on trying, and clicked as
  // the bot came within reach on its walk to the cell before the hall's gate)
  t.deepEqual(swings(q, LOCK_GATE), ['open: a player', 'shut: shut (hold)']);
  for (const w of [p, q]) {
    t.true(w.walks.every(x => x.careful));
    t.is(w.broke.length, 0);
  }
});

test('the strict gates: the yard\'s four, the hall\'s, the lock\'s and the portal ring\'s; the lock\'s two as a pair and its own guarded by its inside; each read by its block', async (t) => {
  const p = yard();
  const lock = lockOf(p.world)!;
  const ring = p.world.zones!['ring:gate'][0];
  t.deepEqual(strictGates(p.world).map(g => g.name),
    ['the yard\'s north gate', 'the yard\'s east gate', 'the yard\'s south gate', 'the yard\'s west gate', 'the hall\'s gate', 'the lock\'s gate', 'the portal ring\'s gate']);
  const set = strictSet(p.world);
  t.deepEqual(set.gates, [LIVE_GATES.north, LIVE_GATES.east, LIVE_GATES.south, LIVE_GATES.west, HALL_GATE, LOCK_GATE, { x: ring.x, y: ring.y, z: ring.z }]);
  t.deepEqual(set.pairs, [[LOCK_GATE, HALL_GATE]]);
  t.deepEqual(set.guard, [{ gate: LOCK_GATE, box: lock.box }]);
  // the bridge takes it as it is
  t.deepEqual(await p.ctx.call('gates.strict', set), { strict: 7, pairs: 1, guard: 1 });
  // every one read by its block: one a player opened reads open, whoever the closer thinks it is
  p.swing(LIVE_GATES.west, true, 'a player');
  const read = await gatesRead(p.ctx, p.world);
  t.deepEqual(read.filter(g => g.open).map(g => g.name), ['the yard\'s west gate']);
  t.is(read.filter(g => g.open === false).length, 6);
  // not loaded (just rejoined): not read, and not called shut
  p.blind(20);
  t.true((await gatesRead(p.ctx, p.world)).every(g => g.open === undefined));
  // before the lock and the ring stand: the yard's gates and the hall's own, no pair, no guard
  const bare = yard({ lock: false, ring: false });
  t.deepEqual(strictGates(bare.world).map(g => g.name).slice(4), ['the hall\'s gate']);
  t.like(strictSet(bare.world), { pairs: [], guard: [] });
  // and a world with no yard: none
  t.deepEqual(strictSet(liveWorld({ yard: undefined, zones: {} })), { gates: [], pairs: [], guard: [] });
});

test('S1 follow-up R1: yardWhy, the yard whole on the records: the live yard is; a fence moving out, the ring off the box (taken down, or the box grown), no gate, a gate off the line each say why; onYardFence by the records', async (t) => {
  const whole = (): WorldMemory => ({
    landmarks: { chests: [], farmland: [] }, leash: 96, yard: { ...YARD },
    zones: { fence: [{ x: YARD.x1, y: YARD.y, z: YARD.z1, width: YARD.x2 - YARD.x1 + 1, length: YARD.z2 - YARD.z1 + 1 }], 'fence:gate': Object.values(GATES).map(g => ({ ...g })) }
  });
  t.is(yardWhy(whole()), undefined);
  t.true(onYardFence(whole(), GATES.west));
  t.true(onYardFence(whole(), { x: -564.5, y: 63.2, z: 2183.9 }), 'by its cell');
  t.false(onYardFence(whole(), { x: -549, y: 63, z: 2120 }));
  t.is(yardWhy({ ...whole(), yard: undefined }), 'no yard');
  // Nov 27, 06:07: the box grown north, the fence to move out (the old north gate now off the box's line)
  const grown = whole();
  grown.fenceMove = { side: 'north', old: { ...YARD } };
  grown.yard = { ...YARD, z1: YARD.z1 - 16 };
  t.is(yardWhy(grown), 'the fence is moving out to the north');
  t.false(onYardFence(grown, GATES.north), 'the trip\'s north gate is no gate of the grown yard');
  // 06:12: the old side taken down, the zones deleted, the move done but the ring not up yet
  const down = whole();
  down.yard = { ...YARD, z1: YARD.z1 - 16 };
  delete down.zones!.fence;
  down.zones!['fence:gate'] = [];
  t.is(yardWhy(down), 'the fence is not up round the yard as it stands (being rebuilt)');
  // a fence zone that is not the box (the box grown by hand, or an old ring)
  const off = whole();
  off.zones!.fence = [{ x: YARD.x1, y: YARD.y, z: YARD.z1 + 16, width: YARD.x2 - YARD.x1 + 1, length: YARD.z2 - YARD.z1 - 15 }];
  t.is(yardWhy(off), 'the fence is not up round the yard as it stands (being rebuilt)');
  const none = whole();
  none.zones!['fence:gate'] = [];
  t.is(yardWhy(none), 'no gate in the yard\'s fence on the records');
  const stray = whole();
  stray.zones!['fence:gate']!.push({ x: -549, y: 63, z: 2150 });
  t.is(yardWhy(stray), '1 of the yard\'s 5 gate(s) off its fence line');
  // the pasture's yard, as the fetch's tests build it, is whole
  t.is(yardWhy(yard().world), undefined);
});
