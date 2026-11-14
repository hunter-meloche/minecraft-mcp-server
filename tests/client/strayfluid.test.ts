import test from 'ava';
import { FLUID_TIMING, fluidOwner, plugSpots, strayFluids, tidyGoal } from '../../src/client/brain/tidy.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { ClientRuntime } from '../../src/client/tools.js';
import { liveWorld, lookAt } from '../helpers/homestead.js';

FLUID_TIMING.dry = 0;

/**
 * F1's sweep for stray fluid in the yard, on the live homestead of Nov 14: the water bucket carried home from the lake
 * poured itself 3 blocks in front of the workshop's door, on the crop plot at (-542, 63, 2161), and 3 in front of the
 * storage house's at (-547, 63, 2189); the flow walled both doors off for Baritone. The plot's own water, the
 * workshop's floor cell, the cast pit and the cane's water are the bot's and stay.
 */

const key = (p: Pos) => `${p.x},${p.y},${p.z}`;
const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
const PLOT_SPILL = { x: -542, y: 63, z: 2161 };
const DOOR_SPILL = { x: -547, y: 63, z: 2189 };
const SOURCE = 'water[level=0]';

/** The live world with the workshop as P1 built it (its zone, its water cell, its door). */
function homestead(): WorldMemory {
  const w = liveWorld();
  Object.assign(w.zones!, {
    workshop: [{ x: -546, y: 62, z: 2152, width: 7, length: 7 }], 'workshop:water': [{ x: -545, y: 62, z: 2156 }], 'workshop:door': [{ x: -543, y: 63, z: 2158 }]
  });
  return w;
}

/**
 * The yard as blocks: grass at its ground (y 62) over dirt, the crop plot's farmland round its water, the workshop's
 * walls (2 high) with its door, and the water in the workshop's floor; `set` what a test adds.
 */
function yardBlocks() {
  const m = new Map<string, string>();
  const get = (p: Pos) => m.get(key(p)) ?? (p.y < 62 ? 'dirt' : p.y === 62 ? 'grass_block[snowy=false]' : 'air');
  const set = (p: Pos, b: string) => { m.set(key(p), b); };
  for (let z = 2161; z <= 2169; z++) for (let x = -545; x <= -537; x++) set({ x, y: 62, z }, 'farmland[moisture=7]');
  set({ x: -541, y: 62, z: 2165 }, SOURCE);
  for (let x = -546; x <= -540; x++) for (const z of [2152, 2158]) for (const y of [63, 64]) set({ x, y, z }, 'oak_planks');
  for (let z = 2152; z <= 2158; z++) for (const x of [-546, -540]) for (const y of [63, 64]) set({ x, y, z }, 'oak_planks');
  set({ x: -543, y: 63, z: 2158 }, 'oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]');
  set({ x: -543, y: 64, z: 2158 }, 'oak_door[facing=south,half=upper,hinge=left,open=false,powered=false]');
  set({ x: -545, y: 62, z: 2156 }, SOURCE);
  /** A source poured at `s` and its flow over the flat (water 7 out, lava 3), round walls, never into a hole. */
  const pour = (s: Pos, fluid: 'water' | 'lava' = 'water') => {
    set(s, `${fluid}[level=0]`);
    const reach = fluid === 'water' ? 7 : 3;
    const seen = new Set([key(s)]);
    let ring = [s];
    for (let d = 1; d <= reach; d++) {
      const next: Pos[] = [];
      for (const q of ring) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = { x: q.x + dx, y: q.y, z: q.z + dz };
        if (seen.has(key(n)) || get(n) !== 'air' || /^(air|water|lava)/.test(get({ ...n, y: n.y - 1 }))) continue;
        seen.add(key(n)); next.push(n);
        set(n, `${fluid}[level=${fluid === 'water' ? d : 2 * d}]`);
      }
      ring = next;
    }
  };
  /** A plugged source's flow dries: every flowing cell of it gone. */
  const dry = () => { for (const [k, b] of m) if (/^(water|lava)\[level=([1-9]|1[0-5])\]$/.test(b)) m.delete(k); };
  return { get, set, pour, dry };
}

test('strayFluids: the two live spills go; the plot\'s water, the workshop\'s cell, the cast pit, the cane\'s water, a pond, a build\'s cell and the project\'s site stay', (t) => {
  const yb = yardBlocks();
  yb.pour(PLOT_SPILL);
  yb.pour(DOOR_SPILL);
  const world = homestead();
  // a cane planted in the yard by its own water; a pond of three; the cast pit with its water in; lava in a pothole
  world.zones!.cane.push({ x: -536, y: 63, z: 2125 });
  yb.set({ x: -537, y: 62, z: 2125 }, SOURCE);
  for (const z of [2140, 2141, 2142]) yb.set({ x: -560, y: 62, z }, SOURCE);
  yb.set({ x: -556, y: 62, z: 2180 }, SOURCE);
  yb.set({ x: -560, y: 62, z: 2200 }, 'lava[level=0]');
  // a cell of the bot's builds, the enchanting room's site (the project's), the fence's line and past it, up a wall
  const built = new Set(['-550,63,2150']);
  yb.set({ x: -550, y: 63, z: 2150 }, SOURCE);
  yb.set({ x: -545, y: 63, z: 2208 }, SOURCE);
  yb.set({ x: -565, y: 63, z: 2150 }, SOURCE);
  yb.set({ x: -570, y: 63, z: 2150 }, SOURCE);
  yb.set({ x: -552, y: 64, z: 2150 }, SOURCE);
  const { stray, kept } = strayFluids(yb.get, YARD, fluidOwner(world), built);
  t.deepEqual(stray.map(f => `${f.fluid} ${key(f)} on ${f.under.replace(/\[.*$/, '')}`).sort(), [
    'lava -560,62,2200 on dirt', 'water -542,63,2161 on farmland', 'water -547,63,2189 on grass_block'
  ]);
  const why = Object.fromEntries(kept.map(k => [key(k.at), k.why]));
  t.deepEqual(why, {
    '-541,62,2165': "the crop plot's water",
    '-545,62,2156': "the workshop's water",
    '-556,62,2180': 'the cast pit',
    '-537,62,2125': "the cane's water",
    '-560,62,2140': 'a pond', '-560,62,2141': 'a pond', '-560,62,2142': 'a pond',
    '-550,63,2150': "a cell of the bot's builds",
    '-545,63,2208': "the project's site"
  });
  // the flow is no source; on the fence's line, past it, and up off the lawn: not looked at
  t.false([...stray, ...kept.map(k => k.at)].some(p => [key({ x: -565, y: 63, z: 2150 }), key({ x: -570, y: 63, z: 2150 }), key({ x: -552, y: 64, z: 2150 })].includes(key(p))));
});

test('plugSpots: water on the crop plot, its flow 7 round it: the one dry cell in reach is the workshop\'s doorway; then a wade in along each line with dry ground at its end, not past a wall or from farmland', (t) => {
  const yb = yardBlocks();
  yb.pour(PLOT_SPILL);
  const spots = plugSpots(yb.get, PLOT_SPILL, { x: -549, y: 63, z: 2183 }, 'water');
  // east and west along z 2161: three out, the shore eight out; north is the workshop's wall, south the plot to its end
  t.deepEqual(spots, [
    { at: { x: -543, y: 63, z: 2158 } },
    { at: { x: -539, y: 63, z: 2161 }, shore: { x: -534, y: 63, z: 2161 } },
    { at: { x: -545, y: 63, z: 2161 }, shore: { x: -550, y: 63, z: 2161 } }
  ]);
  // the same water poured in a hole of the lawn stays in it: dry ground round it, nearest the bot first, never on it
  const hole = yardBlocks();
  const pit = { x: -550, y: 62, z: 2140 };
  hole.set(pit, SOURCE);
  const dry = plugSpots(hole.get, pit, { x: -549, y: 63, z: 2183 }, 'water');
  t.true(dry.length > 10);
  t.true(dry.every(s => !s.shore && s.at.y === 63 && key(s.at) !== key({ ...pit, y: 63 })));
  // (the bot is at home, 40 south: the spot on the hole's south side, in reach of it)
  t.deepEqual(dry[0].at, { x: -549, y: 63, z: 2143 });
});

test('plugSpots: lava on the lawn has no safe spot in reach (its flow runs 3, and nothing hot may be by the feet); in a hole, dry spots 2 or more from it', (t) => {
  const yb = yardBlocks();
  const lava = { x: -555, y: 63, z: 2140 };
  yb.pour(lava, 'lava');
  t.deepEqual(plugSpots(yb.get, lava, { x: -549, y: 63, z: 2183 }, 'lava'), []);
  const hole = yardBlocks();
  const pit = { x: -555, y: 62, z: 2140 };
  hole.set(pit, 'lava[level=0]');
  const spots = plugSpots(hole.get, pit, { x: -549, y: 63, z: 2183 }, 'lava');
  t.true(spots.length > 0);
  t.true(spots.every(s => !s.shore && Math.max(Math.abs(s.at.x - pit.x), Math.abs(s.at.z - pit.z)) >= 2));
});

/**
 * The tidy round over the fake yard: careful walks (never into flowing water, nor out of it: Baritone won't), a wade
 * in by steer, the plug placed only in reach (4.5 from the eye) and only into a fluid, its flow drying, the plug dug,
 * the hoe. `quirks`: wades that end a cell short of their spot (against the current), spots a place is refused from.
 */
function round(yb: ReturnType<typeof yardBlocks>, items: { slot: number; name: string; count: number }[], world = homestead(), cutOff: string[] = [],
  quirks: { short?: string[]; refused?: string[] } = {}) {
  let at: Pos = { x: -549, y: 63, z: 2183 };
  let held = items[0].name;
  const did: string[] = [];
  const lines: string[] = [];
  const rt = { builtNear: () => [] } as unknown as ClientRuntime;
  const ctx = {
    s: lookAt(items, 1000), world, signal: new AbortController().signal, gain: () => undefined, progress: (l: string) => { lines.push(l); },
    status: async () => ({ position: at }),
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      const p = { x: Number(a.x), y: Number(a.y), z: Number(a.z) };
      did.push(`${tool} ${key(p)} ${String(a.item)}`);
      if (tool === 'use-item-on-block' && /_hoe$/.test(String(a.item)) && /^dirt/.test(yb.get(p)) && yb.get({ ...p, y: p.y + 1 }) === 'air') {
        yb.set(p, 'farmland[moisture=0]');
        return { ok: true, text: `Used ${String(a.item)} on dirt at (${p.x}, ${p.y}, ${p.z}): it became farmland[moisture=0]` };
      }
      return { ok: false, text: `unexpected ${tool}` };
    },
    call: async <T>(m: string, a: Record<string, unknown> = {}): Promise<T> => {
      const p = { x: Number(a.x), y: Number(a.y), z: Number(a.z) };
      if (m === 'world.region') {
        const blocks: string[] = [];
        for (let y = p.y; y < p.y + Number(a.height); y++) for (let z = p.z; z < p.z + Number(a.length); z++) for (let x = p.x; x < p.x + Number(a.width); x++) blocks.push(yb.get({ x, y, z }));
        return { blocks } as T;
      }
      if (m === 'inventory') return { items, held: { name: held, count: 1 } } as T;
      if (m === 'item.select') { held = String(a.name); return {} as T; }
      if (m === 'status') return { position: { x: at.x + 0.5, y: at.y, z: at.z + 0.5 } } as T;
      if (m === 'goto') {
        did.push(`goto ${key(p)}${a.careful ? ' careful' : ''}`);
        // (`cutOff`: cells the walk could only reach through the flow; from inside a flow no walk is planned at all)
        if (/^water\[level=[1-9]/.test(yb.get(p)) || /^water\[level=[1-9]/.test(yb.get(at)) || cutOff.includes(key(p))) return { arrived: false, at } as T;
        at = p;
        return { arrived: true, at } as T;
      }
      if (m === 'steer') {
        did.push(`steer ${Math.floor(Number(a.x))},${Math.floor(Number(a.z))}`);
        const to = { x: Math.floor(Number(a.x)), y: Number(a.y) + 1, z: Math.floor(Number(a.z)) };
        if (quirks.short?.includes(key(to))) {
          at = { x: to.x - Math.sign(to.x - at.x), y: to.y, z: to.z - Math.sign(to.z - at.z) };
          return { reached: false, at } as T;
        }
        at = to;
        return { reached: true, at } as T;
      }
      if (m === 'place') {
        const eye = { x: at.x + 0.5, y: at.y + 1.62, z: at.z + 0.5 };
        const d = Math.hypot(p.x + 0.5 - eye.x, p.y + 0.5 - eye.y, p.z + 0.5 - eye.z);
        did.push(`place ${held} at ${key(p)} from ${key(at)}`);
        if (d > 4.5) return { placed: false, reason: 'too far' } as T;
        if (quirks.refused?.includes(key(at))) return { placed: false, reason: 'the server did not accept it' } as T;
        if (!/^(air|water|lava)/.test(yb.get(p))) return { placed: false, reason: `occupied by ${yb.get(p)}` } as T;
        yb.set(p, held);
        if (/^farmland/.test(yb.get({ ...p, y: p.y - 1 }))) yb.set({ ...p, y: p.y - 1 }, 'dirt');
        yb.dry();
        return { placed: true, block: held, face: 'down' } as T;
      }
      if (m === 'dig.here') { did.push(`dig ${key(p)}`); yb.set(p, 'air'); return { dug: true } as T; }
      throw new Error(`unexpected call ${m}`);
    }
  } as unknown as GoalContext;
  return { run: () => tidyGoal(rt).run(ctx), did, lines, world, held: () => held };
}
const KIT = [{ slot: 0, name: 'diamond_sword', count: 1 }, { slot: 1, name: 'cobblestone', count: 30 }, { slot: 2, name: 'dirt', count: 20 }, { slot: 3, name: 'diamond_hoe', count: 1 }];

test('the tidy round plugs the spill on the crop plot: a careful walk to dry ground, a wade in, cobblestone into the source, dug out, the farmland tilled back', async (t) => {
  const yb = yardBlocks();
  yb.pour(PLOT_SPILL);
  // the workshop's doorway is in reach, but the only way to it is through the flow outside it
  const r = round(yb, KIT, homestead(), ['-543,63,2158']);
  t.is(await r.run(), 'plugged 1 of 1 stray water source(s); the lawn is clear');
  t.deepEqual(r.lines, ['a stray water source at (-542, 63, 2161) plugged and cleared; the farmland under it tilled back']);
  t.deepEqual(r.did, [
    'goto -543,63,2158 careful', 'goto -534,63,2161 careful', 'steer -539,2161', 'place cobblestone at -542,63,2161 from -539,63,2161', 'dig -542,63,2161',
    'use-item-on-block -542,62,2161 diamond_hoe'
  ]);
  t.is(yb.get(PLOT_SPILL), 'air');
  t.regex(yb.get({ ...PLOT_SPILL, y: 62 }), /^farmland/);
  // the plot's own water and the workshop's are where they were
  t.is(yb.get({ x: -541, y: 62, z: 2165 }), SOURCE);
  t.is(yb.get({ x: -545, y: 62, z: 2156 }), SOURCE);
  t.false(Object.keys(r.world.tidyTries ?? {}).length > 0);
});

test('the tidy round: a wade that ends short in the flow, or a plug refused from the waded spot, steps back to the shore before the next spot\'s walk (none is planned from inside a flow)', async (t) => {
  for (const quirk of [{ short: ['-539,63,2161'] }, { refused: ['-539,63,2161'] }]) {
    const yb = yardBlocks();
    yb.pour(PLOT_SPILL);
    const r = round(yb, KIT, homestead(), ['-543,63,2158'], quirk);
    t.is(await r.run(), 'plugged 1 of 1 stray water source(s); the lawn is clear', JSON.stringify(quirk));
    const first = quirk.short ? ['steer -539,2161'] : ['steer -539,2161', 'place cobblestone at -542,63,2161 from -539,63,2161'];
    t.deepEqual(r.did, [
      'goto -543,63,2158 careful', 'goto -534,63,2161 careful', ...first, 'steer -534,2161',
      'goto -550,63,2161 careful', 'steer -545,2161', 'place cobblestone at -542,63,2161 from -545,63,2161', 'dig -542,63,2161',
      'use-item-on-block -542,62,2161 diamond_hoe'
    ], JSON.stringify(quirk));
    t.is(yb.get(PLOT_SPILL), 'air');
  }
});

test('the tidy round: water in a pothole is plugged with dirt and left (the hole filled); with no hoe the farmland is said to be dirt now', async (t) => {
  const yb = yardBlocks();
  const pit = { x: -550, y: 62, z: 2140 };
  yb.set(pit, SOURCE);
  const r = round(yb, KIT);
  t.is(await r.run(), 'plugged 1 of 1 stray water source(s); the lawn is clear');
  t.deepEqual(r.lines, ['a stray water source at (-550, 62, 2140) plugged (the hole filled with dirt)']);
  t.is(yb.get(pit), 'dirt');
  t.false(r.did.some(d => d.startsWith('dig')));
  const plot = yardBlocks();
  plot.pour(PLOT_SPILL);
  const bare = round(plot, KIT.filter(i => i.name !== 'diamond_hoe'), homestead(), ['-543,63,2158']);
  await bare.run();
  t.deepEqual(bare.lines, ['a stray water source at (-542, 63, 2161) plugged and cleared; the farmland under it is dirt now (no hoe carried to till it back)']);
});

test('the tidy round: lava on the lawn is never walked up to: not plugged, said why, and after two rounds left be; the stray blocks go on as ever', async (t) => {
  const yb = yardBlocks();
  const lava = { x: -555, y: 63, z: 2140 };
  yb.pour(lava, 'lava');
  const world = homestead();
  // and a pillar of Baritone's on the lawn, by nothing
  yb.set({ x: -550, y: 63, z: 2160 }, 'cobblestone');
  yb.set({ x: -550, y: 64, z: 2160 }, 'cobblestone');
  const one = round(yb, KIT, world);
  // (where it stays is said in the round's own words: a maintenance run reads those)
  t.is(await one.run(), 'plugged 0 of 1 stray lava source(s); not plugged: lava at (-555, 63, 2140); cleared 2 of 2 stray block(s)');
  t.deepEqual(one.lines, ['a stray lava source at (-555, 63, 2140) not plugged: no safe spot in reach of it to stand at']);
  t.deepEqual(one.did, ['dig -550,64,2160', 'dig -550,63,2160']);
  // with the lava still there the lawn is not "clear": its blocks are
  t.is(await round(yb, KIT, world).run(), 'plugged 0 of 1 stray lava source(s); not plugged: lava at (-555, 63, 2140); no stray blocks');
  const three = round(yb, KIT, world);
  t.is(await three.run(), 'plugged 0 of 0 stray lava source(s); left be after two tries, for a hand to clear: lava at (-555, 63, 2140); no stray blocks');
  t.deepEqual(three.lines, []);
  // gone (dried up some other way): forgotten
  yb.set(lava, 'air');
  const four = round(yb, KIT, world);
  t.is(await four.run(), 'the lawn is clear');
  t.deepEqual(world.tidyTries, {});
});

/** The storage house's front wall (z 2186, 2 high) with its door at (-549, 63, 2186), and the spill 3 in front of it. */
function storehouseFront(yb: ReturnType<typeof yardBlocks>) {
  for (let x = -552; x <= -546; x++) for (const y of [63, 64]) yb.set({ x, y, z: 2186 }, 'oak_planks');
  yb.set({ x: -549, y: 63, z: 2186 }, 'oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]');
  yb.set({ x: -549, y: 64, z: 2186 }, 'oak_door[facing=south,half=upper,hinge=left,open=false,powered=false]');
  yb.pour(DOOR_SPILL);
}

test('plugSpots: the storage house\'s spill, its flow over every cell outside the door: the doorway is the one dry cell in reach of it, first', (t) => {
  const yb = yardBlocks();
  storehouseFront(yb);
  const spots = plugSpots(yb.get, DOOR_SPILL, { x: -549, y: 63, z: 2183 }, 'water');
  t.deepEqual(spots[0], { at: { x: -549, y: 63, z: 2186 } });
  t.true(spots.slice(1).every(s => !!s.shore), JSON.stringify(spots));
});

test('the tidy round plugs the storage house\'s spill from its doorway, from inside, where the bot was walled in', async (t) => {
  const yb = yardBlocks();
  storehouseFront(yb);
  const r = round(yb, KIT);
  t.is(await r.run(), 'plugged 1 of 1 stray water source(s); the lawn is clear');
  t.deepEqual(r.lines, ['a stray water source at (-547, 63, 2189) plugged and cleared']);
  t.deepEqual(r.did, ['goto -549,63,2186 careful', 'place cobblestone at -547,63,2189 from -549,63,2186', 'dig -547,63,2189']);
  t.is(yb.get(DOOR_SPILL), 'air');
  t.is(yb.get({ x: -547, y: 63, z: 2190 }), 'air', 'its flow dried');
});


test('the tidy round with both live spills: the storage house\'s first (nearer home), then the plot\'s, each from a fresh look round it', async (t) => {
  const yb = yardBlocks();
  storehouseFront(yb);
  yb.pour(PLOT_SPILL);
  const r = round(yb, KIT, homestead(), ['-543,63,2158']);
  t.is(await r.run(), 'plugged 2 of 2 stray water source(s); the lawn is clear');
  t.deepEqual(r.lines, [
    'a stray water source at (-547, 63, 2189) plugged and cleared',
    'a stray water source at (-542, 63, 2161) plugged and cleared; the farmland under it tilled back'
  ]);
  t.true(r.did.every(d => !d.startsWith('goto') || d.endsWith(' careful')));
});
