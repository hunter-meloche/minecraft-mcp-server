import test from 'ava';
import { sourceBill } from '../../src/client/structures/bill.js';
import { oreOut, prepare, SMELT_BATCH } from '../../src/client/brain/project.js';
import { recipeFor } from '../../src/client/brain/progress.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

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

const NOW = 10 * 60 * 60_000;
type Stack = { name: string; count: number } | null;
/**
 * A bot by a furnace cooking `held` (lit, unless `o.input` says the input holds something else), as the smelt goal
 * loaded it `o.cooked` items ago (6) and remembers it, with `o.output` cooked in the output. smelt-item refuses another
 * item while the input holds one, and on the same ore tops it up and waits for all of it; a take moves the slot's lot
 * into the pockets (the slots: one a kind carried).
 */
function cooking(held: { name: string; count: number }, start: Record<string, number>, o: { input?: Stack; output?: Stack; cooked?: number } = {}) {
  const inv = new Map(Object.entries(start));
  const add = (n: string, k: number) => inv.set(n, (inv.get(n) ?? 0) + k);
  let input: Stack = o.input === undefined ? held : o.input;
  let output: Stack = o.output ?? null;
  const cooked = o.cooked ?? 6;
  const acts: string[] = [];
  const world = {
    landmarks: { chests: [], farmland: [], furnace: { x: 0, y: 64, z: 0 } }, leash: 96, chestItems: {},
    furnaceLoad: { item: held.name, count: held.count + cooked, at: NOW - cooked * 10_500 }
  } as unknown as WorldMemory;
  const ctx = {
    s: { now: NOW }, world,
    act: async (tool: string, a: Record<string, unknown>) => {
      if (tool !== 'smelt-item') { acts.push(tool); return { ok: true, text: 'ok' }; }
      const from = String(a.inputItem), k = Number(a.inputCount);
      if (input && input.name !== from) { acts.push(`smelt-item refused (${input.name} in it)`); return { ok: true, text: `Furnace input slot is occupied by ${input.name}` }; }
      // (on the same ore the tool tops it up and waits for all of it)
      acts.push(`smelt-item ${from} ${k}${input ? ` (waited for ${input.count + k})` : ''}`);
      add(from, -k);
      add({ cobblestone: 'stone', raw_iron: 'iron_ingot' }[from]!, k + (input?.count ?? 0));
      input = null;
      return { ok: true, text: 'Smelted' };
    },
    call: async (m: string, a?: Record<string, unknown>) => {
      if (m === 'inventory') return { items: [...inv].filter(([, k]) => k > 0).map(([name, count], slot) => ({ name, count, slot })) };
      if (m === 'furnace.open') return { open: true, input, output, fuel: { name: 'coal', count: 4 }, lit: !!input };
      if (m === 'furnace.take' && a?.slot === 'input' && input) { const took = input; input = null; add(took.name, took.count); return { took }; }
      if (m === 'furnace.take' && !a?.slot && output) { const took = output; output = null; add(took.name, took.count); return { took }; }
      return {};
    }
  } as unknown as GoalContext;
  return { ctx, inv, acts, world, furnace: () => ({ input, output }) };
}

test('prepare: the smelt goal\'s load as it left it (it loads the furnace and goes) comes out before a job\'s or the project\'s few go in: another ore refuses them, and on the same ore smelt-item would wait for all of it', async (t) => {
  // the cleanup's 4 stone, with 40 raw gold cooking: out first, the stone in alone
  const gold = cooking({ name: 'raw_gold', count: 40 }, { cobblestone: 10, coal: 2 });
  t.deepEqual(await prepare(gold.ctx, 'stone', 4), {});
  t.deepEqual(gold.acts, ['move-to-position', 'smelt-item cobblestone 4']);
  t.is(gold.inv.get('raw_gold'), 40, 'the gold back in the pockets, the smelt\'s next load');
  t.is(gold.world.furnaceLoad, undefined);
  // the project's 4 iron ingots, with 50 raw iron cooking: its own 4 alone, not the 54 waited for at the furnace
  const iron = cooking({ name: 'raw_iron', count: 50 }, { raw_iron: 4, coal: 2 });
  t.deepEqual(await prepare(iron.ctx, 'iron_ingot', 4), {});
  t.deepEqual(iron.acts, ['move-to-position', 'smelt-item raw_iron 4']);
  t.is(iron.inv.get('raw_iron'), 50);
  // the load's time up: its ingots wait in the output, where the furnace cooks nothing else onto them (smelt-item
  // would take them out into the slot the stone needs): out first, and the load forgotten
  const done = cooking({ name: 'raw_gold', count: 40 }, { cobblestone: 10, coal: 2 }, { input: null, output: { name: 'gold_ingot', count: 46 } });
  done.world.furnaceLoad!.at = NOW - 60 * 10_500;
  t.deepEqual(await prepare(done.ctx, 'stone', 4), {});
  t.deepEqual(done.acts, ['move-to-position', 'smelt-item cobblestone 4']);
  t.is(done.inv.get('gold_ingot'), 46);
  t.is(done.world.furnaceLoad, undefined);
  // its time up by the clock and the furnace still on it (its chunk unloaded a while, the server's lag): out all the
  // same, or the stone would be refused
  const late = cooking({ name: 'raw_gold', count: 40 }, { cobblestone: 10, coal: 2 });
  late.world.furnaceLoad!.at = NOW - 60 * 10_500;
  t.deepEqual(await prepare(late.ctx, 'stone', 4), {});
  t.is(late.inv.get('raw_gold'), 40);
  // the smelt's charcoal logs cooking (8 logs are 84 s after it left): out the same way, the stone in alone
  const logs = cooking({ name: 'oak_log', count: 8 }, { cobblestone: 10, coal: 2 }, { cooked: 0 });
  t.deepEqual(await prepare(logs.ctx, 'stone', 4), {});
  t.deepEqual(logs.acts, ['move-to-position', 'smelt-item cobblestone 4']);
  t.is(logs.inv.get('oak_log'), 8);
  t.is(logs.world.furnaceLoad, undefined);
});

test('prepare: the smelt\'s load comes out only with room for what comes out and for the job\'s own after it: short of that it throws on the pockets and takes nothing out (at 35/36 the ingots and the ore took the last slots, and the job\'s 4 stone were written down short for the stock trips)', async (t) => {
  const junk = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`dirt_${i}`, 1]));
  // a load of 64 raw gold, 20 cooked: the ingots in the output, 44 in the input; the job's cobblestone and coal carried
  const at = (start: Record<string, number>) => cooking({ name: 'raw_gold', count: 44 }, start, { output: { name: 'gold_ingot', count: 20 }, cooked: 20 });
  const tight = at({ cobblestone: 64, coal: 3, ...junk(32) });
  await t.throwsAsync(prepare(tight.ctx, 'stone', 4), { message: /^pockets: 34\/36, no room to take the smelt's 20 gold_ingot and 44 raw_gold out of the furnace/ });
  t.deepEqual(tight.furnace(), { input: { name: 'raw_gold', count: 44 }, output: { name: 'gold_ingot', count: 20 } });
  t.false(tight.acts.some(a => a.startsWith('smelt-item')), tight.acts.join(', '));
  t.like(tight.world.furnaceLoad, { item: 'raw_gold' });
  // a slot more: the ingots out, then the ore, then the stone in alone
  const room = at({ cobblestone: 64, coal: 3, ...junk(31) });
  t.deepEqual(await prepare(room.ctx, 'stone', 4), {});
  t.is(room.inv.get('gold_ingot'), 20);
  t.is(room.inv.get('raw_gold'), 44);
  t.deepEqual(room.acts, ['move-to-position', 'smelt-item cobblestone 4']);
  // at 34/36 again, the ingots fitting in a stack of them carried: a slot less wanted
  const stacked = at({ cobblestone: 64, coal: 3, gold_ingot: 30, ...junk(31) });
  t.deepEqual(await prepare(stacked.ctx, 'stone', 4), {});
  t.is(stacked.inv.get('gold_ingot'), 50);
});

test('oreOut: what came out of the input is counted in the pockets, not taken at the bridge\'s word (it answers with the slot as it was, moved or not): none moved, the load stays remembered and it says no; some, the load is what is left', async (t) => {
  const furnace = (moves: number) => {
    const inv = new Map<string, number>([['cobblestone', 10]]);
    const world = {
      landmarks: { chests: [], farmland: [], furnace: { x: 0, y: 64, z: 0 } }, leash: 96, chestItems: {},
      furnaceLoad: { item: 'raw_iron', count: 9, at: NOW - 5000 }
    } as unknown as WorldMemory;
    const ctx = {
      s: { now: NOW }, world,
      call: async (m: string, a?: Record<string, unknown>) => {
        if (m === 'inventory') return { items: [...inv].map(([name, count], slot) => ({ name, count, slot })) };
        if (m === 'furnace.open') return { open: true, input: { name: 'raw_iron', count: 9 }, output: null, lit: true };
        // (the mod's take: what the slot held before its move, whatever moved)
        if (m === 'furnace.take' && a?.slot === 'input') { if (moves) inv.set('raw_iron', moves); return { took: { name: 'raw_iron', count: 9 } }; }
        return {};
      }
    } as unknown as GoalContext;
    return { ctx, world };
  };
  const full = furnace(0);
  t.false(await oreOut(full.ctx));
  t.deepEqual(full.world.furnaceLoad, { item: 'raw_iron', count: 9, at: NOW - 5000 });
  const some = furnace(5);
  t.false(await oreOut(some.ctx));
  t.deepEqual(some.world.furnaceLoad, { item: 'raw_iron', count: 4, at: NOW });
  const all = furnace(9);
  t.true(await oreOut(all.ctx));
  t.is(all.world.furnaceLoad, undefined);
});
