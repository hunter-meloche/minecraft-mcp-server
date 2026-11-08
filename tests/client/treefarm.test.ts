import test from 'ava';
import { plotLogs, plotScaffold, treeFarm, treePlot } from '../../src/client/brain/farming.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: 10 * 60 * 60_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 2, y: 63, z: 4 }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 5,
  home: { x: 0, y: 63, z: 0, dimension: 'overworld' }, distHome: 2, ...over
});

/**
 * A 5 x 5 plot from (0, 62, 0), ground at y 62, one sapling cell at (2, 63, 2): a trunk a stopped round left floating
 * (y 65..69 over a cut stump), a branch log at (3, 68, 2), and the cobblestone pillar Baritone climbed (1, 63..66, 2).
 */
function plot() {
  const box = { x: 0, y: 62, z: 0, width: 5, height: 14, length: 5 };
  const world = new Map<string, string>();
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) world.set(`${x},62,${z}`, 'minecraft:grass_block');
  for (let y = 65; y <= 69; y++) world.set(`2,${y},2`, 'minecraft:oak_log[axis=y]');
  world.set('3,68,2', 'minecraft:oak_log[axis=x]');
  for (let y = 63; y <= 66; y++) world.set(`1,${y},2`, 'minecraft:cobblestone');
  world.set('2,72,2', 'minecraft:oak_leaves[persistent=false]');
  // an old pillar's top, hanging once its foot was dug: out of reach from the ground
  world.set('4,69,4', 'minecraft:cobblestone');
  const read = (b: typeof box) => {
    const out: (string | null)[] = [];
    for (let y = 0; y < b.height; y++) for (let z = 0; z < b.length; z++) for (let x = 0; x < b.width; x++) out.push(world.get(`${b.x + x},${b.y + y},${b.z + z}`) ?? 'minecraft:air');
    return out;
  };
  return { box, world, read };
}

test('the plot: every log at any height (a floating trunk, a branch), top down; scaffold above the ground only', (t) => {
  const { box, read } = plot();
  const blocks = read(box);
  const logs = plotLogs(blocks, box);
  t.is(logs.length, 6);
  t.deepEqual(logs[0], { x: 2, y: 69, z: 2 });
  t.true(logs.some(p => p.x === 3 && p.y === 68));
  t.deepEqual(plotScaffold(blocks, box, 63).map(p => p.y), [69, 66, 65, 64, 63]);
  t.deepEqual(treePlot({ zones: { trees: [{ x: 0, y: 62, z: 0, width: 5, length: 5 }] } }, [{ x: 2, y: 63, z: 2 }]), box);
});

test('the harvest round: cuts by hand what it reaches, leaves the rest to Baritone, digs the pillar, replants', async (t) => {
  const { world, read } = plot();
  const w: WorldMemory = { landmarks: { chests: [], farmland: [] }, leash: 96, zones: { trees: [{ x: 0, y: 62, z: 0, width: 5, length: 5 }], 'trees:sapling': [{ x: 2, y: 63, z: 2 }] } };
  const acts: string[] = [];
  let feet = { x: 2, y: 63, z: 4 };
  // reach from where it stands: within 4.5 of the eye
  const reach = (p: { x: number; y: number; z: number }) => Math.hypot(p.x + 0.5 - (feet.x + 0.5), p.y + 0.5 - (feet.y + 1.62), p.z + 0.5 - (feet.z + 0.5)) <= 4.5;
  const ctx = {
    s: snap(), world: w, signal: new AbortController().signal, progress: () => undefined, status: async () => ({}) as never,
    call: async <T>(method: string, p: Record<string, number> = {}): Promise<T> => {
      if (method === 'world.region') return { blocks: read(p as unknown as Parameters<typeof read>[0]) } as T;
      if (method === 'dig.here') {
        const k = `${p.x},${p.y},${p.z}`;
        if (!world.has(k)) return { dug: false, reason: 'air' } as T;
        if (!reach(p as { x: number; y: number; z: number })) return { dug: false, reason: 'out of reach' } as T;
        world.delete(k);
        return { dug: true } as T;
      }
      // a careful walk climbs nothing (no blocks placed): only spots on the ground
      if (method === 'goto') { if (p.y > 63) return { arrived: false, at: feet } as T; feet = { x: p.x, y: p.y, z: p.z }; return { arrived: true, at: feet } as T; }
      if (method === 'inventory') return { items: [{ slot: 1, name: 'oak_sapling', count: 4 }] } as T;
      throw new Error(`unexpected ${method}`);
    },
    act: async (tool: string, args: Record<string, number> = {}) => {
      acts.push(tool);
      if (tool === 'dig-block') {
        world.delete(`${args.x},${args.y},${args.z}`);
        // Baritone pillars up to reach it and leaves its pillar
        if (args.y >= 69 && args.x === 4) for (let y = 63; y <= 65; y++) world.set(`4,${y},3`, 'minecraft:cobblestone');
        return { ok: true, text: 'Dug' };
      }
      if (tool === 'place-block') { world.set(`${args.x},${args.y},${args.z}`, 'minecraft:oak_sapling'); return { ok: true, text: 'Placed oak_sapling' }; }
      return { ok: true, text: 'ok' };
    }
  } as unknown as GoalContext;
  const r = await treeFarm.run(ctx);
  // no log and no cobblestone left in the plot; the sapling back on its cell
  t.false([...world.entries()].some(([, b]) => /_log|cobblestone/.test(b)), r);
  t.is(world.get('2,63,2'), 'minecraft:oak_sapling');
  t.regex(r, /cut 6 log\(s\)/);
  // the 4-high pillar, the hanging top (by Baritone), and Baritone's own pillar for it (3, by hand next pass)
  t.regex(r, /cleared 8 scaffold block\(s\)/);
  // the out-of-reach top went to Baritone only after the hand pass (no Baritone dig for what the hand reached)
  t.true(acts.filter(a => a === 'dig-block').length <= 3, acts.join(','));
});
