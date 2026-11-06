import test from 'ava';
import { sourceBill } from '../../src/client/structures/bill.js';
import { prepare, SMELT_BATCH } from '../../src/client/brain/project.js';
import { recipeFor } from '../../src/client/brain/progress.js';
import type { GoalContext } from '../../src/client/brain/goals.js';

test('sources: glass from sand, stone bricks from cobblestone through the furnace, bricks from clay, panes from glass', (t) => {
  const s = sourceBill({ glass: 8, stone_bricks: 8, bricks: 2, glass_pane: 16 }, { sand: 4, cobblestone: 20, coal: 2 });
  const by = Object.fromEntries(s.lines.map(l => [l.item, l.source]));
  t.is(by.stone_bricks, 'smelt'); // 8 stone from 8 cobblestone, then crafted
  t.is(by.glass, 'gather'); // 4 sand there, 4 more to fetch
  t.is(by.bricks, 'gather'); // 8 clay balls to dig
  t.is(by.glass_pane, 'gather'); // 6 more glass: more sand
  t.is(s.gather.sand, 4 + 6);
  t.is(s.gather.clay_ball, 8);
  t.deepEqual(s.missing, {});
});

test('recipes: wooden trapdoors of any wood, stone and brick building blocks', (t) => {
  t.deepEqual(recipeFor('spruce_trapdoor'), { makes: 2, from: { spruce_planks: 6 } });
  t.deepEqual(recipeFor('stone_brick_stairs'), { makes: 4, from: { stone_bricks: 6 } });
  t.deepEqual(recipeFor('lantern'), { makes: 1, from: { iron_nugget: 8, torch: 1 } });
});

/** A bot with an inventory, a furnace and a crafting grid that do what they're told. */
function fakeBot(start: Record<string, number>) {
  const inv = new Map(Object.entries(start));
  const acts: string[] = [];
  const add = (n: string, k: number) => inv.set(n, (inv.get(n) ?? 0) + k);
  const ctx = {
    world: { landmarks: { chests: [], farmland: [], furnace: { x: 0, y: 64, z: 0 } }, leash: 96, chestItems: {} },
    act: async (tool: string, a: Record<string, unknown>) => {
      acts.push(`${tool} ${a.inputItem ?? a.outputItem} ${a.inputCount ?? a.amount}`);
      if (tool === 'smelt-item') {
        const from = String(a.inputItem), k = Number(a.inputCount);
        const out = { cobblestone: 'stone', sand: 'glass' }[from]!;
        add(from, -k); add(out, k);
      }
      if (tool === 'craft-item') {
        const item = String(a.outputItem), times = Number(a.amount);
        const r = recipeFor(item)!;
        for (const [i, n] of Object.entries(r.from)) add(i, -n * times);
        add(item, r.makes * times);
      }
      return { ok: true, text: 'ok' };
    },
    call: async (m: string) => (m === 'inventory' ? { items: [...inv].filter(([, k]) => k > 0).map(([name, count], slot) => ({ name, count, slot })) } : {})
  } as unknown as GoalContext;
  return { ctx, inv, acts };
}

test('prepare: stone bricks from cobblestone, smelted to stone and then crafted', async (t) => {
  const { ctx, inv, acts } = fakeBot({ cobblestone: 10, coal: 2 });
  t.deepEqual(await prepare(ctx, 'stone_bricks', 8), {});
  t.is(inv.get('stone_bricks'), 8);
  t.deepEqual(acts, ['smelt-item cobblestone 8', 'craft-item stone_bricks 2']);
});

test('prepare: a big smelt goes a batch at a time, and no sand means sand is short', async (t) => {
  const { ctx } = fakeBot({ sand: 64, coal: 8 });
  t.deepEqual(await prepare(ctx, 'glass', 40), { glass: 40 - SMELT_BATCH });
  const none = fakeBot({ coal: 8 });
  t.deepEqual(await prepare(none.ctx, 'glass', 10), { sand: 10 });
  const noFuel = fakeBot({ sand: 10 });
  t.deepEqual(await prepare(noFuel.ctx, 'glass', 10), { coal: 2 });
});
