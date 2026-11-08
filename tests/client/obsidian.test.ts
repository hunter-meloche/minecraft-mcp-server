import test from 'ava';
import { enchantingMilestone, obsidianTargets } from '../../src/client/brain/enchant.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

type P = { x: number; y: number; z: number };
const kitted = [
  { slot: 0, name: 'diamond_pickaxe', count: 1 }, { slot: 1, name: 'cooked_beef', count: 8 }, { slot: 2, name: 'torch', count: 32 },
  { slot: 3, name: 'cobblestone', count: 64 },
  { slot: 36, name: 'iron_boots', count: 1 }, { slot: 37, name: 'iron_leggings', count: 1 }, { slot: 38, name: 'iron_chestplate', count: 1 }, { slot: 39, name: 'iron_helmet', count: 1 }
];
const snap = (items: Snapshot['items']): Snapshot => ({
  now: 10 * 60 * 60_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items, counts: new Map(items.map(i => [i.name, i.count])), slotsUsed: 6,
  home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0
});

// a lit portal's frame by home (the community chest's), and natural obsidian 40 blocks north of the mine
const portal: P[] = [{ x: 10, y: 65, z: 0 }, { x: 10, y: 66, z: 0 }];
const frame: P[] = [{ x: 10, y: 64, z: 0 }, { x: 9, y: 65, z: 0 }, { x: 11, y: 66, z: 0 }, { x: 10, y: 68, z: 0 }];

test('obsidian targets: never a lit portal\'s frame, nearest first', (t) => {
  const wild = [{ x: 0, y: -40, z: -100 }, { x: 0, y: -40, z: -60 }];
  t.deepEqual(obsidianTargets([...frame, ...wild], portal, { x: 0, y: 64, z: 0 }), [wild[1], wild[0]]);
});

/** Where obsidian is in sight: the portal frame always; `wild` once the bot stands within 60 of it. */
function fake(items: Snapshot['items'], wild: P[]) {
  const calls: string[] = [];
  const dug = new Set<string>();
  let obsidian = 0;
  let at: P = { x: 0, y: 64, z: 0 };
  const world: WorldMemory = { landmarks: { chests: [], farmland: [] }, leash: 96, yard: { x1: -16, z1: -16, x2: 16, z2: 16, y: 63 } };
  const k = (p: P) => `${p.x},${p.y},${p.z}`;
  const ctx = {
    s: snap(items), world, signal: new AbortController().signal, progress: () => undefined, status: async () => ({}) as never,
    call: async <T>(method: string, p: Record<string, unknown> = {}): Promise<T> => {
      calls.push(method);
      if (method === 'inventory') return { items: [...items, ...(obsidian ? [{ slot: 5, name: 'obsidian', count: obsidian }] : [])] } as T;
      if (method === 'foreign.zones') return { zones: [] } as T;
      if (method === 'status') return { position: at } as T;
      if (method === 'goto') { at = { x: Number(p.x), y: 64, z: Number(p.z) }; return { arrived: true } as T; }
      if (method === 'world.findBlocks') {
        if (p.block === 'nether_portal') return { positions: portal } as T;
        const near = wild.filter(w => Math.hypot(w.x - at.x, w.z - at.z) <= 60);
        return { positions: [...frame, ...near].filter(q => !dug.has(k(q))) } as T;
      }
      throw new Error(`unexpected ${method}`);
    },
    act: async (tool: string, args: Record<string, unknown> = {}) => {
      calls.push(`${tool} ${args.x},${args.y},${args.z}`);
      if (tool === 'dig-block') {
        const q = { x: Number(args.x), y: Number(args.y), z: Number(args.z) };
        if (frame.some(f => k(f) === k(q))) return { ok: false, text: "Can't: part of a lit nether portal's frame" };
        dug.add(k(q)); obsidian++;
        return { ok: true, text: 'Dug obsidian' };
      }
      return { ok: true, text: 'ok' };
    }
  } as unknown as GoalContext;
  return { ctx, calls };
}

const step = enchantingMilestone([]).steps[0];
const wild = (z0: number): P[] => [0, 1, 2, 3, 4].map(i => ({ x: i, y: -40, z: z0 }));

test('obsidian: in sight near home (not the portal\'s): dug there, no trip', async (t) => {
  const { ctx, calls } = fake(kitted, wild(-30));
  const r = await step.run(ctx, { step: 0, data: {} });
  t.is(r.status, 'done', r.text);
  t.false(calls.some(c => c.startsWith('dig-block 10,') || c.startsWith('dig-block 9,') || c.startsWith('dig-block 11,')), calls.join(' | '));
  t.false(calls.includes('goto'));
});

test('obsidian: none near home but the portal: out from the mine a step at a time, kitted out, until it finds some', async (t) => {
  // the mine sets out 40 north of the yard (z -56); the obsidian is 40 further north, out of sight from there
  const { ctx, calls } = fake(kitted, wild(-160));
  const r = await step.run(ctx, { step: 0, data: {} });
  t.is(r.status, 'done', r.text);
  t.true(calls.filter(c => c === 'goto').length >= 2);
  t.false(calls.some(c => /^dig-block (9|10|11),/.test(c)), 'never the portal frame');
});

test('obsidian: none near home and not kitted out: it waits, and says for what', async (t) => {
  const { ctx, calls } = fake([{ slot: 0, name: 'diamond_pickaxe', count: 1 }], []);
  const r = await step.run(ctx, { step: 0, data: {} });
  t.is(r.status, 'blocked');
  t.regex(r.text, /waits for: .*food/);
  t.false(calls.includes('goto'));
});
