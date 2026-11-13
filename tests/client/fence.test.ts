import test from 'ava';
import { canPlaceAgainst, isReplaceable } from '../../src/build-protection.js';
import { FILL_DEPTH, FILL_MAX, YARD_MARGIN, groundUnder, spanOf, standsFor, yardRing, type CellAt, type FenceRing } from '../../src/client/brain/fence.js';
import { REPAIR_RADIUS, repairGoal } from '../../src/client/brain/repair.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { ClientRuntime } from '../../src/client/tools.js';

/**
 * The yard's fence and the repair round, on the live yard (brain.json, Nov 13): the fence's ring x -565..-533,
 * z 2119..2215, its ground at y 62, the posts at 63 and their torches at 64, home at (-549, 63, 2183). The live gap:
 * no posts at (-533, 63, 2144..2151), the ground gone under five of them, a crater open down to y 58 beside them.
 * The game is a stand-in that places as the bridge does (a block goes on the first solid face of the order down,
 * north, south, east, west, up, "too far" past 4.5 from the eye to the face it clicks, "nothing solid next to it" with
 * none), walks as a careful goto does (to a cell with ground under it and room for a body, or not at all), and puts
 * back as restoreBlock does: when that would walk (too far, or the bot in the cell), the stand-in notes the walk,
 * which Baritone makes breaking and placing as it likes.
 */

const HOUR = 3_600_000;
const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
const k = (p: Pos) => `${p.x},${p.y},${p.z}`;
const HOME = at(-549, 63, 2183);
const Y0 = 62;
const RING: FenceRing = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: Y0 };
const SIDE_POST = 'oak_fence[east=false,north=true,south=true,waterlogged=false,west=false]';
const END_POST = 'oak_fence[east=true,north=false,south=false,waterlogged=false,west=true]';
const GATES: Record<string, string> = { '-549,2119': 'north', '-533,2183': 'east', '-549,2215': 'south', '-565,2183': 'west' };
/** The live gap, and the posts in it the record has a torch on. */
const GAP = [2144, 2145, 2146, 2147, 2148, 2149, 2150, 2151];
const TORCHED = [2145, 2147, 2151];
/** The posts with the ground gone under them. */
const UNGROUNDED = [2146, 2147, 2148, 2149, 2150];

const id = (b: string) => b.replace(/^minecraft:/, '').replace(/\[.*$/, '');
const props = (b: string): Record<string, string> =>
  Object.fromEntries((/\[(.*)\]$/.exec(b)?.[1] ?? '').split(',').filter(Boolean).map(kv => kv.split('=') as [string, string]));
const replaceable = (b: string) => isReplaceable({ name: id(b), getProperties: () => props(b) });
const STEP: Record<string, [number, number, number]> = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
/** What each item places, as world.region names it. */
const BLOCK_OF: Record<string, string> = { oak_fence: SIDE_POST, dirt: 'dirt', torch: 'torch', oak_fence_gate: 'oak_fence_gate[facing=east,in_wall=false,open=false,powered=false]' };
const strictlyInside = (p: { x: number; z: number }) => p.x > RING.x1 && p.x < RING.x2 && p.z > RING.z1 && p.z < RING.z2;
const outsideYard = (p: { x: number; z: number }) => Math.max(RING.x1 - p.x, 0, p.x - RING.x2, RING.z1 - p.z, p.z - RING.z2);

/** The ring's cells, as the perimeter milestone lays them. */
function ringCells(): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let x = RING.x1; x <= RING.x2; x++) out.push({ x, z: RING.z1 }, { x, z: RING.z2 });
  for (let z = RING.z1 + 1; z < RING.z2; z++) out.push({ x: RING.x1, z }, { x: RING.x2, z });
  return out;
}

interface Placed { at: Pos; block: string; was: string; by: 'fill' | 'restore' }

/** The live homestead in the stand-in game: the whole ring, recorded with its states, a few builds by home. */
function homestead(opts: { inventory?: Record<string, number>; record?: (key: string) => boolean } = {}) {
  const blocks = new Map<string, string>();
  const record = new Map<string, string | undefined>();
  const build = (p: Pos, state: string) => { blocks.set(k(p), state); if (opts.record?.(k(p)) ?? true) record.set(k(p), state); };
  for (const c of ringCells()) {
    const gate = GATES[`${c.x},${c.z}`];
    build(at(c.x, Y0 + 1, c.z), gate ? `oak_fence_gate[facing=${gate},in_wall=false,open=false,powered=false]` : c.x === RING.x1 || c.x === RING.x2 ? SIDE_POST : END_POST);
  }
  for (const z of [2141, ...TORCHED, 2153, 2155]) build(at(RING.x2, Y0 + 2, z), 'torch');
  build(at(-549, 64, 2190), 'oak_planks');
  build(at(-547, 63, 2193), 'torch');
  const inv = new Map(Object.entries(opts.inventory ?? { oak_fence: 9, torch: 12, dirt: 64 }));
  const f = {
    blocks, record, inv,
    bot: { x: -548.5, y: 63, z: 2183.5 },
    held: undefined as string | undefined,
    entities: [] as { name: string; position: Pos }[],
    foreign: (_p: Pos): boolean | 'fail' => false,
    calls: [] as { m: string; p: Record<string, unknown> }[],
    placed: [] as Placed[],
    /** walks that let Baritone break and place: restoreBlock's own, or a goto that is not careful */
    rough: [] as string[],
    walks: [] as (Pos & { careful: boolean; range: number })[],
    progress: [] as string[],
    gained: 0,
    get: (p: Pos) => blocks.get(k(p)) ?? (p.y > Y0 ? 'air' : p.y === Y0 ? 'grass_block[snowy=false]' : 'dirt'),
    set: (p: Pos, b: string) => { blocks.set(k(p), b); }
  };
  const place = (c: Pos, face = 'down', item?: string): { placed: boolean; block?: string; reason?: string } => {
    const now = f.get(c);
    if (!replaceable(now)) return { placed: false, reason: `occupied by ${now}` };
    const feet = { x: Math.floor(f.bot.x), y: Math.floor(f.bot.y), z: Math.floor(f.bot.z) };
    if (feet.x === c.x && feet.z === c.z && (feet.y === c.y || feet.y + 1 === c.y)) return { placed: false, reason: 'the bot is standing there' };
    for (const d of [face, ...['down', 'north', 'south', 'east', 'west', 'up'].filter(x => x !== face)]) {
      const [dx, dy, dz] = STEP[d];
      const ref = f.get(at(c.x + dx, c.y + dy, c.z + dz));
      if (!canPlaceAgainst({ name: id(ref), getProperties: () => props(ref) })) continue;
      // the bridge clicks the face between them, a side face low
      const hit = { x: c.x + 0.5 + dx / 2, y: c.y + 0.5 + dy / 2 - (dy ? 0 : 0.25), z: c.z + 0.5 + dz / 2 };
      if (Math.hypot(hit.x - f.bot.x, hit.y - (f.bot.y + 1.62), hit.z - f.bot.z) > 4.5) return { placed: false, reason: 'too far' };
      if (item) {
        if (!f.inv.get(item)) throw new Error(`no ${item} in inventory`);
        f.held = item;
      }
      if (!f.held || !f.inv.get(f.held)) return { placed: false };
      // the server places nothing where an animal stands
      if (f.entities.some(e => Math.floor(e.position.x) === c.x && Math.floor(e.position.z) === c.z && [c.y, c.y - 1].includes(Math.floor(e.position.y)))) return { placed: false };
      const block = BLOCK_OF[f.held] ?? f.held;
      blocks.set(k(c), block);
      f.inv.set(f.held, f.inv.get(f.held)! - 1);
      f.placed.push({ at: c, block, was: now, by: item ? 'fill' : 'restore' });
      return { placed: true, block };
    }
    return { placed: false, reason: 'nothing solid next to it to place against' };
  };
  const call = async (m: string, p: Record<string, unknown> = {}): Promise<unknown> => {
    f.calls.push({ m, p });
    const P = p as Record<string, number>;
    if (m === 'world.region') {
      const out: string[] = [];
      for (let y = 0; y < P.height; y++) for (let z = 0; z < P.length; z++) for (let x = 0; x < P.width; x++) out.push(f.get(at(P.x + x, P.y + y, P.z + z)));
      return { blocks: out };
    }
    if (m === 'inventory') return { items: [...f.inv].filter(([, n]) => n > 0).map(([name, count], slot) => ({ slot, name, count })) };
    // as the bridge lists them: within maxDistance of the bot's feet
    if (m === 'world.entities') return { entities: f.entities.filter(e => Math.hypot(e.position.x - f.bot.x, e.position.y - f.bot.y, e.position.z - f.bot.z) <= (P.maxDistance ?? 32)) };
    if (m === 'foreign.at') {
      const said = (p.positions as number[][]).map(([x, y, z]) => f.foreign(at(x, y, z)));
      if (said.includes('fail')) throw new Error('unknown method foreign.at');
      return { inside: said };
    }
    if (m === 'item.select') {
      if (!f.inv.get(String(p.name))) throw new Error(`no ${p.name} in inventory`);
      f.held = String(p.name);
      return { held: 0 };
    }
    if (m === 'place') return place(at(P.x, P.y, P.z), String(p.face ?? 'down'), p.item as string | undefined);
    if (m === 'goto') {
      const to = at(P.x, P.y, P.z);
      f.walks.push({ ...to, careful: p.careful === true, range: P.range });
      if (p.careful !== true) f.rough.push(`goto ${k(to)}`);
      // the walk home (to within 3 of the home cell): the lawn is open all the way
      if (P.range === 3) { f.bot = { x: to.x + 0.5, y: to.y, z: to.z + 0.5 }; return { arrived: true }; }
      // (on a path or farmland the feet sink under the cell, and the bridge says the walk did not arrive)
      const floor = f.get(at(to.x, to.y - 1, to.z));
      const ok = !replaceable(floor) && !/^(dirt_path|farmland|mud)/.test(floor) && replaceable(f.get(to)) && replaceable(f.get(at(to.x, to.y + 1, to.z)));
      if (ok) f.bot = { x: to.x + 0.5, y: to.y, z: to.z + 0.5 };
      return { arrived: ok };
    }
    throw new Error(`unexpected ${m}`);
  };
  const rt = {
    builtNear: (c: Pos, r: number) => [...f.record].map(([key, state]) => {
      const [x, y, z] = key.split(',').map(Number);
      return { at: at(x, y, z), ...(state ? { state } : {}) };
    }).filter(b => Math.hypot(b.at.x - c.x, b.at.z - c.z) <= r && Math.abs(b.at.y - c.y) <= r),
    restoreBlock: async (c: Pos, item: string) => {
      if (!f.inv.get(item)) return `no ${item} in the inventory`;
      f.held = item;
      const r = place(c, 'down');
      // restoreBlock's own way on: a Baritone walk, which breaks and places as it likes
      if (!r.placed && (r.reason === 'too far' || r.reason === 'the bot is standing there')) { f.rough.push(`restoreBlock's walk at ${k(c)}`); return r.reason; }
      if (!r.placed) return r.reason ?? 'the server did not accept it';
      return undefined;
    },
    adoptStates: (bs: { at: Pos; state: string }[]) => { for (const b of bs) if (!f.record.get(k(b.at))) f.record.set(k(b.at), b.state); },
    protectBuilt: (bs: { at: Pos; state: string }[]) => { for (const b of bs) f.record.set(k(b.at), b.state); }
  } as unknown as ClientRuntime;
  return { ...f, f, call, rt };
}
type Homestead = ReturnType<typeof homestead>;

/**
 * The live crater, on the fence line `line` with the way out `out` (+1 east), eight posts from `from` on: the posts
 * and their torches gone, the ground 2 deep under the third to the seventh, the lip open down to y 59 one and two out
 * (to 58 by the second post, and three out there), and the lawn one in by the fourth to the sixth.
 */
function crater(h: Homestead, line: number, out: number, from: number) {
  const air = (x: number, y: number, z: number) => h.f.set(at(x, y, z), 'air');
  for (let i = 0; i < 8; i++) air(line, Y0 + 1, from + i);
  for (const i of [1, 3, 7]) air(line, Y0 + 2, from + i);
  for (let i = 2; i <= 6; i++) { air(line, Y0, from + i); air(line, Y0 - 1, from + i); }
  for (let i = 1; i <= 6; i++) for (const d of [1, 2]) for (let y = 59; y <= Y0; y++) air(line + d * out, y, from + i);
  air(line + 2 * out, 58, from + 1);
  for (let y = 58; y <= Y0; y++) air(line + 3 * out, y, from + 1);
  for (let i = 3; i <= 5; i++) air(line - out, Y0, from + i);
}
const liveGap = (h: Homestead) => crater(h, RING.x2, 1, GAP[0]);

const memory = (): WorldMemory => ({
  landmarks: { chests: [at(-551, 63, 2181)], farmland: [] }, leash: 96,
  yard: { x1: RING.x1, z1: RING.z1, x2: RING.x2, z2: RING.z2, y: Y0 },
  zones: { fence: [{ x: RING.x1, y: Y0, z: RING.z1, width: 33, length: 97 }], 'fence:gate': Object.keys(GATES).map(g => { const [x, z] = g.split(',').map(Number); return at(x, Y0 + 1, z); }) },
  chestItems: { '-551,63,2181': {} }
});

const snap = (now = 10 * HOUR): Snapshot => ({
  now, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: -548.5, y: 63, z: 2183.5 }, dimension: 'overworld', sleeping: false,
  raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 0, home: { ...HOME, dimension: 'overworld' }, distHome: 0
} as Snapshot);

function ctxFor(h: Homestead, world: WorldMemory, s = snap()): GoalContext {
  return {
    s, world, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      if (tool !== 'take-from-chest') throw new Error(`unexpected ${tool}`);
      const c = `${a.x},${a.y},${a.z}`, item = String(a.item);
      const there = world.chestItems?.[c]?.[item] ?? 0, n = Math.min(there, Number(a.count));
      h.f.inv.set(item, (h.f.inv.get(item) ?? 0) + n);
      const left = Object.entries({ ...world.chestItems?.[c], [item]: there - n }).filter(([, v]) => v > 0).map(([nm, v]) => `${nm} x${v}`).join(', ') || 'nothing';
      return { ok: true, text: `Took ${n} ${item} from the chest at (${a.x}, ${a.y}, ${a.z}). It holds: ${left}.` };
    },
    call: h.call as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null, position: { ...h.f.bot } }),
    progress: (x: string) => { h.f.progress.push(x); },
    gain: (n: number) => { h.f.gained += n; }
  } as GoalContext;
}

/** What a run did to the world: every placement a fill or a put-back, and never a Baritone walk. */
function sound(t: { deepEqual: (a: unknown, b: unknown, m?: string) => void; true: (a: boolean, m?: string) => void }, h: Homestead) {
  t.deepEqual(h.f.rough, [], 'no walk that may break or place');
  for (const w of h.f.walks) t.true(w.careful && (strictlyInside(w) || w.range === 3), `careful, inside the fence or home: ${k(w)}`);
  for (const p of h.f.placed.filter(x => x.by === 'fill')) {
    t.true(p.at.y <= Y0 && p.at.y > Y0 - FILL_DEPTH, `fill from the ground's level down, ${FILL_DEPTH} at most: ${k(p.at)}`);
    t.true(outsideYard(p.at) <= YARD_MARGIN, `fill within the yard and its margin: ${k(p.at)}`);
    t.true(!/water|lava/.test(p.was), `never in water or lava: ${k(p.at)}`);
  }
}

/** The posts back in the gap stand on ground, and the ground within 2 either side of the line by each is shut at the top. */
function grounded(t: { false: (a: boolean, m?: string) => void }, h: Homestead) {
  for (const z of GAP.filter(z => /^oak_fence/.test(h.f.get(at(RING.x2, Y0 + 1, z))))) {
    for (const x of [-535, -534, -533, -532, -531]) t.false(replaceable(h.f.get(at(x, Y0, z))), `open by the post at ${z}: (${x}, ${Y0}, ${z})`);
  }
}

test('the yard\'s ring is the fence as the perimeter milestone built it; none while it is being moved', (t) => {
  const world = memory();
  t.deepEqual(yardRing(world), RING);
  t.is(yardRing({ ...world, fenceMove: { side: 'east', old: { ...world.yard! } } }), undefined);
  t.is(yardRing({ ...world, zones: {} }), undefined);
  t.is(spanOf(GAP.map(z => at(-533, 63, z))), '(-533, 63, 2144..2151)');
  t.is(spanOf([at(-533, 63, 2144)]), '(-533, 63, 2144)');
  t.is(spanOf([at(-550, 63, 2119), at(-533, 63, 2144)]), '(-550, 63, 2119), (-533, 63, 2144)');
});

test('repair: the live gap in the east fence, 42 from home, mended in one or two rounds: the ground first, then the posts and their torches', async (t) => {
  const h = homestead();
  liveGap(h);
  const world = memory();
  const goal = repairGoal(h.rt);
  // the gap is out of the old round's reach: 36 to 42 from home, and the fence 64 north of it
  t.true(Math.hypot(-533 - HOME.x, 2144 - HOME.z) > 42 && Math.hypot(-533 - HOME.x, 2151 - HOME.z) > REPAIR_RADIUS);
  t.regex(goal.wants(snap(), world) ?? '', /daily round/);
  const first = await goal.run(ctxFor(h, world));
  // in one round: 36 of fill (the deep end of the lip is out of reach from the lawn: closed at the top, hollow under)
  t.is(first, 'all 2 built blocks checked, none missing; fence: put back 8 post(s) at (-533, 63, 2144..2151), 3 torch(es) on them; filled 36 under them' +
    '; 25 cell(s) under them out of reach from the yard');
  t.true(h.f.progress.includes(first.replace(/^.*?; fence/, 'fence')), 'the round says it as it ends');
  t.is(h.f.gained, 36 + 8 + 3);
  for (const z of GAP) t.is(h.f.get(at(-533, 63, z)), SIDE_POST, `the post at 2144..2151: ${z}`);
  for (const z of TORCHED) t.is(h.f.get(at(-533, 64, z)), 'torch', `its torch: ${z}`);
  // each post the ground had gone from stands on ground again, put in before it
  for (const z of UNGROUNDED) {
    const fill = h.f.placed.findIndex(p => k(p.at) === k(at(-533, Y0, z)));
    const post = h.f.placed.findIndex(p => k(p.at) === k(at(-533, Y0 + 1, z)));
    t.true(fill >= 0 && fill < post, `the ground under the post at ${z} before the post`);
    t.is(h.f.get(at(-533, Y0, z)), 'dirt');
  }
  // the crater's mouth at the fence is shut: no open top within 2 either side of the line by the gap
  for (const z of GAP) for (const x of [-535, -534, -533, -532, -531]) t.false(replaceable(h.f.get(at(x, Y0, z))), `open at (${x}, ${Y0}, ${z})`);
  // the fill is the bot's own from now on (the round puts it back if it goes); the far end of the crater (3 out) is not filled
  t.is(h.f.record.get(k(at(-533, Y0, 2148))), 'dirt');
  t.is(h.f.get(at(-530, Y0, 2145)), 'air');
  sound(t, h);
  // and home at the end, carefully
  t.like(h.f.walks.at(-1), { x: HOME.x, z: HOME.z, range: 3, careful: true });
  // a round after it finds nothing to do on the fence: no walk, no placing
  const n = h.f.calls.length;
  t.regex(await goal.run(ctxFor(h, world, snap(12 * HOUR))), /^all \d+ built blocks checked, none missing$/);
  t.deepEqual(h.f.calls.slice(n).map(c => c.m).filter(m => m !== 'world.region'), []);
});

test('repair: a crater wider than a round\'s 40 of fill: the posts whose ground does not fit wait for the next round, and go back then', async (t) => {
  const h = homestead({ inventory: { oak_fence: 20, torch: 12, dirt: 100 } });
  liveGap(h);
  // the same again on the west fence, nearer home: its ground takes most of the first round's fill
  crater(h, RING.x1, -1, 2150);
  const world = memory();
  const goal = repairGoal(h.rt);
  const first = await goal.run(ctxFor(h, world));
  const fills = () => h.f.placed.filter(p => p.by === 'fill').length;
  const one = fills();
  t.true(one <= FILL_MAX && one > 30, `${one}`);
  t.regex(first, /fence: put back \d+ post\(s\) at .*; filled \d+ under them; \d post\(s\) wait for their ground \(40 filled a run\): the next round/);
  const west = (i: number) => h.f.get(at(RING.x1, 63, 2150 + i));
  t.true([0, 1, 2, 3, 4, 5, 6, 7].every(i => /^oak_fence/.test(west(i))), 'the nearer gap first');
  const waiting = GAP.filter(z => h.f.get(at(RING.x2, 63, z)) === 'air');
  t.true(waiting.length > 0 && waiting.length < GAP.length);
  // a post that waits is not tried: nothing counts against it
  for (const z of waiting) t.is(world.repairFails?.[`-533,63,${z}`], undefined);
  const second = await goal.run(ctxFor(h, world, snap(11 * HOUR)));
  t.true(fills() - one <= FILL_MAX);
  t.regex(second, new RegExp(`fence: put back ${waiting.length} post\\(s\\) at \\(-533, 63, `));
  t.true(GAP.every(z => h.f.get(at(RING.x2, 63, z)) === SIDE_POST));
  for (const z of UNGROUNDED) t.is(h.f.get(at(RING.x2, Y0, z)), 'dirt');
  sound(t, h);
});

test('repair: a post 42 out with the ground in place goes back with its state, from a careful walk; the round wants for the fence alone', async (t) => {
  // only the far post in the record: nothing within the old round's 24 of home
  const h = homestead({ record: key => key === '-533,63,2144' });
  h.f.set(at(-533, 63, 2144), 'air');
  const world = memory();
  const goal = repairGoal(h.rt);
  t.is(h.rt.builtNear(HOME, REPAIR_RADIUS).length, 0);
  t.regex(goal.wants(snap(), world) ?? '', /daily round/, 'the fence alone is something built to look after');
  const r = await goal.run(ctxFor(h, world));
  t.is(r, 'fence: put back 1 post(s) at (-533, 63, 2144)');
  t.is(h.f.get(at(-533, 63, 2144)), SIDE_POST);
  t.deepEqual(h.f.placed.map(p => p.by), ['restore']);
  t.like(h.f.walks[0], { x: -534, y: 63, z: 2144, careful: true, range: 0 });
  sound(t, h);
  t.is(h.f.gained, 1);
});

test('repair: nothing is done to a whole fence; the round reads it with the rest', async (t) => {
  const h = homestead();
  const world = memory();
  const r = await repairGoal(h.rt).run(ctxFor(h, world));
  t.is(r, `all ${h.f.record.size} built blocks checked, none missing`);
  t.deepEqual([...new Set(h.f.calls.map(c => c.m))], ['world.region']);
  t.deepEqual([h.f.placed, h.f.walks], [[], []]);
});

test('repair: no fill in water, in someone else\'s build, or outside the fence when the mod cannot say whose it is', async (t) => {
  const setUp = () => {
    const h = homestead();
    liveGap(h);
    // the lip at 2150 two out is a pool, one out has water under it; someone's build over x -531 by 2146..2148
    for (let y = 59; y <= Y0; y++) h.f.set(at(-531, y, 2150), 'water[level=0]');
    h.f.set(at(-532, 59, 2149), 'water[level=0]');
    h.f.set(at(-532, 60, 2149), 'water[level=1]');
    return h;
  };
  const h = setUp();
  h.f.foreign = p => p.x === -531 && p.z >= 2146 && p.z <= 2148;
  await repairGoal(h.rt).run(ctxFor(h, memory()));
  sound(t, h);
  const filled = h.f.placed.filter(p => p.by === 'fill');
  t.false(filled.some(p => p.at.x === -531 && p.at.z >= 2146 && p.at.z <= 2148), 'nothing in their build');
  t.false(filled.some(p => p.at.x === -531 && p.at.z === 2150), 'nothing in the pool');
  t.true(filled.some(p => k(p.at) === k(at(-532, 61, 2149))), 'over the water, not in it');
  t.false(filled.some(p => p.at.x === -532 && p.at.z === 2149 && p.at.y <= 60));
  // a client that cannot say whose a block is: nothing outside the fence (the line and the yard are the bot's own)
  const h2 = setUp();
  h2.f.foreign = () => 'fail';
  const r = await repairGoal(h2.rt).run(ctxFor(h2, memory()));
  sound(t, h2);
  const out = h2.f.placed.filter(p => p.by === 'fill' && p.at.x > RING.x2);
  t.deepEqual(out, []);
  t.true(h2.f.placed.some(p => p.by === 'fill' && p.at.x === RING.x2), 'under the posts it fills');
  t.regex(r, /hole\(s\) by them left open \(no ground under it, or someone's build\)/);
});

test('repair: an animal or an item in the crater is not buried, and a post waits for the cow in its gap', async (t) => {
  const h = homestead();
  liveGap(h);
  // a cow in the crater one out by 2148, an item lying in it two out by 2149, a cow in the gap at 2151
  h.f.entities = [
    { name: 'cow', position: { x: -531.6, y: 59, z: 2148.4 } }, { name: 'item', position: { x: -530.5, y: 59.1, z: 2149.5 } },
    { name: 'cow', position: { x: -532.5, y: 63, z: 2151.5 } }
  ];
  h.f.entities[0].position.x = -531.6; // floor -532
  const world = memory();
  const r = await repairGoal(h.rt).run(ctxFor(h, world));
  sound(t, h);
  const filled = h.f.placed.filter(p => p.by === 'fill');
  t.false(filled.some(p => p.at.x === -532 && p.at.z === 2148), 'the cow\'s hole is left open');
  t.false(filled.some(p => p.at.x === -531 && p.at.z === 2149), 'the item\'s hole is left open');
  t.is(h.f.get(at(-533, 63, 2151)), 'air');
  t.regex(r, /1 post\(s\) wait for an animal to leave the gap/);
  t.is(world.repairFails?.['-533,63,2151'], undefined, 'no try counted against the post');
});

test('repair: a post with no ground inside the fence to stand on by it is left alone after two rounds, with no walk out to it', async (t) => {
  const h = homestead();
  h.f.set(at(-533, 63, 2160), 'air');
  // the lawn gone inside the fence round it (2 deep): nowhere to stand within 2
  for (let z = 2158; z <= 2162; z++) for (let x = -536; x <= -534; x++) { h.f.set(at(x, Y0, z), 'air'); h.f.set(at(x, Y0 - 1, z), 'air'); }
  const world = memory();
  const goal = repairGoal(h.rt);
  for (const hour of [10, 11]) t.regex(await goal.run(ctxFor(h, world, snap(hour * HOUR))), /couldn't place oak_fence at -533,63,2160: no ground inside the fence by it to stand on/);
  const n = h.f.calls.length;
  t.regex(await goal.run(ctxFor(h, world, snap(12 * HOUR))), /fence: 1 left alone \(put back in vain twice\)/);
  t.deepEqual(h.f.calls.slice(n).map(c => c.m).filter(m => m !== 'world.region'), []);
  t.deepEqual(h.f.walks, [], 'never a walk out to it');
});

test('repair: the fence\'s posts and the dirt come from the chests when not carried', async (t) => {
  const h = homestead({ inventory: { torch: 4 } });
  liveGap(h);
  const world = memory();
  world.chestItems = { '-551,63,2181': { oak_fence: 12, dirt: 30 } };
  const r = await repairGoal(h.rt).run(ctxFor(h, world));
  sound(t, h);
  t.true(GAP.every(z => h.f.get(at(-533, 63, z)) === SIDE_POST || /wait/.test(r)), r);
  t.is(world.chestItems['-551,63,2181'].oak_fence, 4);
  t.true(h.f.placed.filter(p => p.by === 'fill').length > 0);
  // the 30 do not fill all of it: what goes back stands on ground with its lip shut, and the rest waits untried
  grounded(t, h);
  const waiting = GAP.filter(z => h.f.get(at(-533, 63, z)) === 'air');
  t.true(waiting.length > 0, r);
  t.regex(r, new RegExp(`${waiting.length} post\\(s\\) wait for their ground \\(no dirt or cobblestone to fill it with\\): the next round`));
  for (const z of waiting) t.is(world.repairFails?.[`-533,63,${z}`], undefined);
});

test('repair: with no dirt carried nor in the chests, the ground is filled with their cobblestone, then cobbled deepslate', async (t) => {
  // live: the chests hold no dirt, and hundreds of both stones
  const h = homestead({ inventory: { oak_fence: 9, torch: 12 } });
  liveGap(h);
  const world = memory();
  world.chestItems = { '-551,63,2181': { cobblestone: 20, cobbled_deepslate: 40 } };
  const r = await repairGoal(h.rt).run(ctxFor(h, world));
  t.is(r, 'all 2 built blocks checked, none missing; fence: put back 8 post(s) at (-533, 63, 2144..2151), 3 torch(es) on them; filled 36 under them' +
    '; 25 cell(s) under them out of reach from the yard');
  sound(t, h);
  grounded(t, h);
  for (const z of GAP) t.is(h.f.get(at(-533, 63, z)), SIDE_POST);
  // the cobblestone first, then the deepslate; each the bot's own from then on
  const fills = h.f.placed.filter(p => p.by === 'fill');
  t.deepEqual([...new Set(fills.map(p => p.block))], ['cobblestone', 'cobbled_deepslate']);
  t.is(fills.filter(p => p.block === 'cobblestone').length, 20);
  for (const p of fills) t.is(h.f.record.get(k(p.at)), p.block);
});

test('repair: with nothing to fill the ground with, the posts by open ground wait untried (no walk out to them), and go back once there is', async (t) => {
  const h = homestead({ inventory: { oak_fence: 9, torch: 12 } });
  liveGap(h);
  const world = memory();
  const goal = repairGoal(h.rt);
  const first = await goal.run(ctxFor(h, world));
  // 2144 and 2151 stand on their ground with none open by them: those go back
  t.regex(first, /fence: put back 2 post\(s\) at .*, 1 torch\(es\) on them; 6 post\(s\) wait for their ground \(no dirt or cobblestone to fill it with\): the next round/);
  t.deepEqual(GAP.filter(z => h.f.get(at(-533, 63, z)) === SIDE_POST), [2144, 2151]);
  t.deepEqual(h.f.placed.filter(p => p.by === 'fill'), []);
  t.deepEqual(h.f.walks.filter(w => w.range === 0).map(w => w.z), [2151, 2144], 'walks only to the posts that go back');
  t.deepEqual(world.repairFails ?? {}, {});
  grounded(t, h);
  sound(t, h);
  // dirt by the next round: the rest of the gap goes back on its ground
  h.f.inv.set('dirt', 64);
  const second = await goal.run(ctxFor(h, world, snap(11 * HOUR)));
  t.regex(second, /fence: put back 6 post\(s\) at \(-533, 63, 2145\.\.2150\), 2 torch\(es\) on them; filled 36 under them/);
  for (const z of GAP) t.is(h.f.get(at(-533, 63, z)), SIDE_POST);
  for (const z of GAP) for (const x of [-535, -534, -533, -532, -531]) t.false(replaceable(h.f.get(at(x, Y0, z))), `open at (${x}, ${Y0}, ${z})`);
  sound(t, h);
});

test('repair: a post whose own ground does not go in is not put back over the hole; it is tried again next round', async (t) => {
  const h = homestead();
  liveGap(h);
  const world = memory();
  const goal = repairGoal(h.rt);
  // the server turns down the dirt straight under the post at 2148, once
  let refuse = true;
  const call = async (m: string, p: Record<string, unknown> = {}) =>
    refuse && m === 'place' && k(at(Number(p.x), Number(p.y), Number(p.z))) === k(at(-533, Y0, 2148)) ? { placed: false, reason: 'the server did not accept it' } : h.call(m, p);
  const first = await goal.run(ctxFor({ ...h, call }, world));
  t.regex(first, /fence: put back 7 post\(s\) at .*couldn't place oak_fence at -533,63,2148: the ground under it did not go in/);
  t.is(h.f.get(at(-533, 63, 2148)), 'air');
  t.is(world.repairFails?.['-533,63,2148'], 1);
  sound(t, h);
  refuse = false;
  const second = await goal.run(ctxFor(h, world, snap(11 * HOUR)));
  t.is(second, 'all 2 built blocks checked, none missing; fence: put back 1 post(s) at (-533, 63, 2148); filled 1 under them');
  t.is(h.f.get(at(-533, Y0, 2148)), 'dirt');
  t.is(h.f.get(at(-533, 63, 2148)), SIDE_POST);
  t.is(world.repairFails?.['-533,63,2148'], undefined);
  sound(t, h);
});

test('repair: a pit deeper than the fill with a cow at its bottom is not roofed over; the post over it waits, and a cave under solid ground does not hold the fill', async (t) => {
  const h = homestead();
  h.f.set(at(-533, 63, 2160), 'air');
  // under the post a pit down to y 58 with a cow at its bottom; one out a hole 2 deep over solid ground, a zombie in
  // the cave under that; two out a pit to 58 with an item lying in it
  for (let y = 58; y <= Y0; y++) { h.f.set(at(-533, y, 2160), 'air'); h.f.set(at(-531, y, 2160), 'air'); }
  for (const y of [61, 62, 55, 56]) h.f.set(at(-532, y, 2160), 'air');
  const cow = { name: 'cow', position: { x: -532.5, y: 58, z: 2160.5 } };
  h.f.entities = [cow, { name: 'zombie', position: { x: -531.6, y: 55, z: 2160.5 } }, { name: 'item', position: { x: -530.5, y: 57.2, z: 2160.5 } }];
  const world = memory();
  const goal = repairGoal(h.rt);
  const first = await goal.run(ctxFor(h, world));
  t.regex(first, /fence: 1 missing, none put back; 1 post\(s\) wait for an animal to leave the gap \(or the hole under it\)/);
  t.deepEqual([h.f.placed, h.f.walks], [[], []], 'nothing placed over the cow, and no walk out to it');
  t.deepEqual(world.repairFails ?? {}, {});
  // the cow gone: the post goes back on its column (closed at the top); the hole over the cave is filled, the item's pit is not
  h.f.entities = h.f.entities.filter(e => e !== cow);
  const second = await goal.run(ctxFor(h, world, snap(11 * HOUR)));
  t.regex(second, /fence: put back 1 post\(s\) at \(-533, 63, 2160\); filled 5 under them; .*1 hole\(s\) left open with an animal or an item in it/);
  t.is(h.f.get(at(-533, 63, 2160)), SIDE_POST);
  t.is(h.f.get(at(-533, Y0, 2160)), 'dirt');
  t.deepEqual([61, 62].map(y => h.f.get(at(-532, y, 2160))), ['dirt', 'dirt']);
  t.false(h.f.placed.some(p => p.at.x === -531), 'the item\'s pit is left open');
  sound(t, h);
});

test('repair: something that stays in the gap (a boat) holds its post with a look each round, never a walk out to it, and the post goes back once it is gone', async (t) => {
  const h = homestead();
  h.f.set(at(-533, 63, 2144), 'air');
  h.f.entities = [{ name: 'oak_boat', position: { x: -532.5, y: 63, z: 2144.5 } }];
  const world = memory();
  const goal = repairGoal(h.rt);
  for (const hour of [10, 11, 12]) t.regex(await goal.run(ctxFor(h, world, snap(hour * HOUR))), /fence: 1 missing, none put back; 1 post\(s\) wait for an animal to leave the gap/);
  t.deepEqual(h.f.walks, []);
  t.deepEqual(world.repairFails ?? {}, {});
  h.f.entities = [];
  t.is(await goal.run(ctxFor(h, world, snap(13 * HOUR))), 'all 2 built blocks checked, none missing; fence: put back 1 post(s) at (-533, 63, 2144)');
  sound(t, h);
});

test('repair: due, and 22 out at the farm plot where the farm round left the bot: home first on foot, then the gap 42 out mended as from home, careful all the way', async (t) => {
  const h = homestead();
  liveGap(h);
  const world = memory();
  const goal = repairGoal(h.rt);
  // the plot (-545, 2161): in the yard, past the round's old 10 (it wanted from there never, and the gap waited)
  const plot = { ...snap(), position: { x: -544.5, y: 63, z: 2161.5 }, distHome: Math.hypot(4.5, 21.5) };
  h.f.bot = { ...plot.position };
  t.regex(goal.wants(plot, world) ?? '', /daily round/);
  const r = await goal.run(ctxFor(h, world, plot));
  t.like(h.f.walks[0], { x: HOME.x, y: HOME.y, z: HOME.z, range: 8, careful: true });
  t.is(r, 'all 2 built blocks checked, none missing; fence: put back 8 post(s) at (-533, 63, 2144..2151), 3 torch(es) on them; filled 36 under them' +
    '; 25 cell(s) under them out of reach from the yard');
  for (const z of GAP) t.is(h.f.get(at(-533, 63, z)), SIDE_POST, `the post at ${z}`);
  sound(t, h);
  t.like(h.f.walks.at(-1), { x: HOME.x, z: HOME.z, range: 3, careful: true });
  // under the yard, or out past the fence by the gap itself: not from there
  t.is(goal.wants({ ...plot, position: { x: -544.5, y: 8, z: 2161.5 } }, world), null);
  t.is(goal.wants({ ...plot, position: { x: -530.5, y: 63, z: 2147.5 }, distHome: Math.hypot(18.5, 35.5) }, world), null);
});

test('repair: with a leash under 24, the ring\'s blocks past it near home are still the round\'s to check', async (t) => {
  const h = homestead();
  // 20.6 from home: past a leash of 20, within the round's 24
  h.f.set(at(-533, 63, 2170), 'air');
  const world = { ...memory(), leash: 20 };
  const r = await repairGoal(h.rt).run(ctxFor(h, world));
  // (the stand-in's restoreBlock does not walk: from home it is too far)
  t.regex(r, /^put back 0\/1 missing block\(s\); couldn't place oak_fence at -533,63,2170: too far/);
});

test('groundUnder: the post\'s column and its lip, bottom up, 4 deep at most; never on what is not ground, nor past the yard\'s margin', (t) => {
  const world = new Map<string, string>();
  const cell: CellAt = (x, y, z) => world.get(`${x},${y},${z}`) ?? (y > Y0 ? 'air' : y === Y0 ? 'grass_block' : 'stone');
  const post = { x: RING.x2, z: 2150 };
  // under the post 2 deep; one out 6 deep (4 filled, hanging); two out on a chest at y 60; one in, nothing
  for (const y of [62, 61]) world.set(`-533,${y},2150`, 'air');
  for (let y = 57; y <= 62; y++) world.set(`-532,${y},2150`, 'air');
  for (const y of [62, 61]) world.set(`-531,${y},2150`, 'air');
  world.set('-531,60,2150', 'chest[facing=west,type=single,waterlogged=false]');
  const g = groundUnder(RING, post, cell, RING);
  t.deepEqual(g.columns.map(c => [c.x, c.across, c.cells.map(p => p.y)]), [[-533, 0, [61, 62]], [-532, 1, [59, 60, 61, 62]]]);
  t.is(g.left, 1, 'the chest');
  // the yard's margin: with the yard remembered short of the fence, what is more than 6 past it is left out
  t.deepEqual(groundUnder(RING, post, cell, { ...RING, x2: RING.x2 - 5 }).columns.map(c => c.x), [-533, -532]);
  t.deepEqual(groundUnder(RING, post, cell, { ...RING, x2: RING.x2 - 6 }).columns.map(c => c.x), [-533]);
  t.deepEqual(groundUnder(RING, post, cell, { ...RING, x2: RING.x2 - 7 }).columns, []);
  // unloaded: nothing
  t.deepEqual(groundUnder(RING, post, () => null, RING).columns, []);
  // where to stand: inside the fence, never on the line or past it, on ground with room for a body
  t.deepEqual(standsFor(RING, post, cell)[0], at(-534, 63, 2150));
  world.set('-534,62,2150', 'air');
  t.deepEqual(standsFor(RING, post, cell).slice(0, 2), [at(-534, 63, 2149), at(-534, 63, 2151)]);
  t.true(standsFor(RING, post, cell).every(p => strictlyInside(p)));
  // never on a path or farmland: on a path the feet sink under the cell, and the walk to it "did not arrive"
  world.set('-534,62,2149', 'dirt_path');
  world.set('-534,62,2151', 'farmland[moisture=7]');
  t.deepEqual(standsFor(RING, post, cell)[0], at(-535, 63, 2150));
});
