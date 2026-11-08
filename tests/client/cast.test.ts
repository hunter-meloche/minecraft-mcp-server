import test from 'ava';
import { CAST_TIMING, castObsidian, castSite } from '../../src/client/brain/cast.js';

Object.assign(CAST_TIMING, { settle: 0, float: 0, drain: 0 });
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

type P = { x: number; y: number; z: number };
const k = (p: P) => `${p.x},${p.y},${p.z}`;

/** A lawn from (0, 60, 0), 20 x 20, ground top y 62 (grass over dirt), with whatever `extra` sets. */
function lawn(extra: Record<string, string> = {}) {
  const box = { x: 0, y: 60, z: 0, width: 20, height: 5, length: 20 };
  const world = new Map<string, string>();
  for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) {
    world.set(`${x},60,${z}`, 'minecraft:dirt'); world.set(`${x},61,${z}`, 'minecraft:dirt'); world.set(`${x},62,${z}`, 'minecraft:grass_block');
  }
  for (const [p, b] of Object.entries(extra)) world.set(p, b);
  const read = (b: typeof box) => {
    const out: (string | null)[] = [];
    for (let y = 0; y < b.height; y++) for (let z = 0; z < b.length; z++) for (let x = 0; x < b.width; x++) out.push(world.get(`${b.x + x},${b.y + y},${b.z + z}`) ?? 'minecraft:air');
    return out;
  };
  return { box, world, read };
}

test('the cast site: plain lawn with sealed walls, nothing built or burning within 2, not right by home', (t) => {
  const { box, read } = lawn();
  const home = { x: 10, y: 63, z: 10 };
  const c = castSite(read(box), box, 62, home)!;
  t.truthy(c);
  t.true(Math.hypot(c.x - home.x, c.z - home.z) >= 6);
  // a torch or a fence by a cell rules it out; so does the lamp walk's cobblestone
  const near = lawn({ [`${c.x + 1},63,${c.z}`]: 'minecraft:torch', [`${c.x},62,${c.z + 1}`]: 'minecraft:cobblestone' });
  const c2 = castSite(near.read(near.box), near.box, 62, home)!;
  t.true(Math.abs(c2.x - c.x) > 2 || Math.abs(c2.z - c.z) > 2);
  // farmland everywhere: nowhere
  const farm: Record<string, string> = {};
  for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) farm[`${x},62,${z}`] = 'minecraft:farmland';
  const f = lawn(farm);
  t.is(castSite(f.read(f.box), f.box, 62, home), undefined);
});

test('a cast: lava in the pit, water on it is obsidian, scooped, mined, floated up; the pit filled after', async (t) => {
  const { world, read } = lawn();
  const inv = new Map<string, number>([['lava_bucket', 2], ['water_bucket', 1], ['bucket', 0], ['diamond_pickaxe', 1], ['dirt', 10]]);
  const site = { x: 4, y: 62, z: 4 };
  const w: WorldMemory = { landmarks: { chests: [], farmland: [] }, leash: 96, yard: { x1: 0, z1: 0, x2: 19, z2: 19, y: 62 }, zones: { 'obsidian:cast': [site] }, lavaCasting: true };
  let feet: P = { x: 10, y: 63, z: 10 };
  let lying = 0; // obsidian at the pit's bottom, not picked up yet
  const set = (p: P, b: string) => world.set(k(p), `minecraft:${b}`);
  const get = (p: P) => (world.get(k(p)) ?? 'minecraft:air').replace('minecraft:', '');
  const ctx = {
    s: { position: feet, home: { x: 10, y: 63, z: 10, dimension: 'overworld' } } as unknown as Snapshot, world: w,
    signal: new AbortController().signal, progress: () => undefined, status: async () => ({}) as never,
    call: async <T>(method: string, p: Record<string, unknown> = {}): Promise<T> => {
      const q = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
      if (method === 'inventory') return { items: [...inv].filter(([, n]) => n > 0).map(([name, count], slot) => ({ name, count, slot })) } as T;
      if (method === 'world.region') return { blocks: read({ ...q, width: Number(p.width), height: Number(p.height), length: Number(p.length) }) } as T;
      if (method === 'goto') { feet = q; return { arrived: true } as T; }
      if (method === 'item.select') return {} as T;
      if (method === 'dig.here') {
        const b = get(q);
        if (b === 'obsidian') lying++;
        else if (/dirt|grass/.test(b)) inv.set('dirt', inv.get('dirt')! + 1);
        set(q, 'air');
        return { dug: true } as T;
      }
      throw new Error(`unexpected ${method}`);
    },
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      if (tool !== 'use-item-on-block') return { ok: true, text: 'ok' };
      t.deepEqual(feet, { x: 3, y: 63, z: 4 }, 'always beside the pit, never in it');
      const q = { x: Number(a.x), y: Number(a.y), z: Number(a.z) };
      const into = a.face === 'west' ? { ...q, x: q.x - 1 } : q; // the west face of the wall: the pit cell
      const item = String(a.item);
      if (item === 'lava_bucket') { set(into, 'lava[level=0]'); inv.set('lava_bucket', inv.get('lava_bucket')! - 1); inv.set('bucket', inv.get('bucket')! + 1); }
      else if (item === 'water_bucket') {
        set(into, 'water[level=0]');
        inv.set('water_bucket', 0); inv.set('bucket', inv.get('bucket')! + 1);
        const below = { ...into, y: into.y - 1 };
        if (/^lava/.test(get(below))) set(below, 'obsidian');
        if (lying) { inv.set('obsidian', (inv.get('obsidian') ?? 0) + lying); lying = 0; } // floats up within reach
      } else if (item === 'bucket' && /^water/.test(get(q))) { set(q, 'air'); inv.set('water_bucket', 1); inv.set('bucket', inv.get('bucket')! - 1); }
      else if (item === 'dirt') { set(into, 'dirt'); inv.set('dirt', inv.get('dirt')! - 1); }
      return { ok: true, text: 'Used' };
    }
  } as unknown as GoalContext;
  const r = await castObsidian(ctx, 4);
  t.is(r.have, 2, r.text);
  t.regex(r.text, /cast 2 obsidian/);
  t.regex(r.text, /out of lava/);
  // the lawn back: the pit filled with dirt, the water bucket kept
  t.is(get({ x: 4, y: 61, z: 4 }), 'dirt');
  t.is(get({ x: 4, y: 62, z: 4 }), 'dirt');
  t.is(inv.get('water_bucket'), 1);
});

test('casting is off until it is turned on: no lava fetched, nothing cast', async (t) => {
  const { fetchLava } = await import('../../src/client/brain/cast.js');
  const calls: string[] = [];
  const ctx = {
    s: { position: { x: 0, y: 63, z: 0 } }, world: { landmarks: { chests: [], farmland: [] }, leash: 96 },
    signal: new AbortController().signal, progress: () => undefined,
    call: async <T>(method: string): Promise<T> => { calls.push(method); return { items: [{ slot: 1, name: 'bucket', count: 4 }] } as T; },
    act: async (tool: string) => { calls.push(tool); return { ok: true, text: '' }; }
  } as unknown as GoalContext;
  t.is(await fetchLava(ctx, 4), 0);
  t.regex((await castObsidian(ctx, 4)).text, /casting is off/);
  t.deepEqual(calls.filter(c => c !== 'inventory'), []);
});
