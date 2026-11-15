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

test('prepare: the smelt goal\'s ore in the furnace comes back out, and a job\'s stone goes first (the cleanup\'s 4 stone found raw gold, then raw iron, in it for an hour, Nov 15)', async (t) => {
  /** The fake bot with a furnace holding `held`: smelt-item refuses while it is there, as the tool's reply says. */
  const busyFurnace = (held: { name: string; count: number }) => {
    const bot = fakeBot({ cobblestone: 10, coal: 2 });
    let input: { name: string; count: number } | null = held;
    const calls: string[] = [];
    const ctx = {
      ...bot.ctx,
      act: async (tool: string, a: Record<string, unknown>) => {
        if (tool === 'smelt-item' && input) { bot.acts.push(`smelt-item refused (${input.name} in it)`); return { ok: true, text: `Furnace input slot is occupied by ${input.name}` }; }
        return bot.ctx.act(tool, a);
      },
      call: async (m: string, a?: Record<string, unknown>) => {
        if (m !== 'inventory') calls.push(m);
        if (m === 'furnace.open') return { open: true, input, output: null, fuel: { name: 'coal', count: 1 }, lit: true };
        if (m === 'furnace.take' && a?.slot === 'input' && input) {
          const took = input;
          input = null;
          bot.inv.set(took.name, (bot.inv.get(took.name) ?? 0) + took.count);
          return { took };
        }
        return bot.ctx.call(m);
      }
    } as unknown as GoalContext;
    return { ...bot, ctx, calls };
  };
  const ore = busyFurnace({ name: 'raw_iron', count: 9 });
  t.deepEqual(await prepare(ore.ctx, 'stone', 4), {});
  t.is(ore.inv.get('stone'), 4);
  t.deepEqual(ore.acts, ['smelt-item refused (raw_iron in it)', 'smelt-item cobblestone 4']);
  t.deepEqual(ore.calls, ['furnace.open', 'furnace.take', 'container.close']);
  // the ore back in the pockets, for the smelt goal's next batch
  t.is(ore.inv.get('raw_iron'), 9);
  // something else of somebody's (the hall's sand) is left where it is: the stone is still to come
  const sand = busyFurnace({ name: 'sand', count: 12 });
  t.deepEqual(await prepare(sand.ctx, 'stone', 4), { stone: 4 });
  t.deepEqual(sand.calls, []);
});
