import { AVOID_UNLESS_ASKED } from '../../food.js';
import { foodsFor26 } from '../tools.js';
import { AT_HOME, type Goal, type GoalContext, type Snapshot } from './goals.js';
import { farmCentre, type Pos } from './memory.js';
import { chestTotals, peekChest, rememberReply, takeFromChests } from './chests.js';

/**
 * Food: keep enough ready-to-eat food on the bot that the Guardian can always heal it, the cheapest way first:
 * the home chest, cooking what it carries, bread from wheat, the farm, fishing, and last hunting (never the last two
 * of a kind nearby, so the herds stay).
 */

/** Raw foods worth cooking (a third of the cooked value raw, and some make you sick). */
export const COOKS_TO: Record<string, string> = {
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton', rabbit: 'cooked_rabbit',
  cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato'
};
/** Carry at least this many food points of ready food. */
export const FOOD_TARGET = 20;
/** Fuel, best first (coal smelts 8, a log or planks 1.5). */
const FUELS = ['coal', 'charcoal', 'coal_block', 'oak_log', 'birch_log', 'spruce_log', 'acacia_log', 'jungle_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'oak_planks', 'birch_planks', 'spruce_planks'];
/** Animals to hunt, preferred first (sheep last: they're the wool for beds). */
const GAME = ['cow', 'pig', 'chicken', 'rabbit', 'sheep'];

/** Food points of ready food (cooked, bread, ...) in a count map; raw meat and harmful food don't count. */
export function readyFoodPoints(counts: Map<string, number>): number {
  const foods = foodsFor26();
  let points = 0;
  for (const [name, n] of counts) {
    if (!foods[name] || COOKS_TO[name] || AVOID_UNLESS_ASKED.has(name)) continue;
    points += foods[name].foodPoints * n;
  }
  return points;
}

const short = (s: Snapshot) => FOOD_TARGET - readyFoodPoints(s.counts);
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;

async function counts(ctx: GoalContext): Promise<Map<string, number>> {
  const inv = await ctx.call<{ items: { name: string; count: number }[] }>('inventory');
  const m = new Map<string, number>();
  for (const it of inv.items) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
  return m;
}

/** Within this of home the bot is in its fenced, lit yard: no need to retreat, and the chests and furnace are there. */
const RETREAT_FROM = 16;

/** Nothing ready to eat while hungry or hurt: worse than being out at dusk (it went to bed at 7 health, food 8). */
const starving = (s: Snapshot) => readyFoodPoints(s.counts) < 3 && (s.food <= 14 || s.health < 10);

export const food: Goal = {
  name: 'food',
  priority: 70,
  // above the shelter's evening walk and the retreat, which kept pulling it back to the doorstep on its way to the
  // chests and the furnace in the yard, so it never ate
  urgency: s => (starving(s) ? 88 : 70),
  timeoutMs: 15 * 60_000,
  retryMs: 5 * 60_000,
  wants: s => {
    if (s.dimension !== 'overworld' || !s.home) return null;
    const need = short(s);
    if (need <= 0) return null;
    // at night only what can be done at home: cook, bake, the chest
    if (s.activity !== 'work' && s.distHome > (starving(s) ? RETREAT_FROM : AT_HOME)) return null;
    return `carrying ${FOOD_TARGET - need} food points of ready food (want ${FOOD_TARGET})`;
  },
  run: async ctx => {
    const did: string[] = [];
    const say = (t: string) => { did.push(t); ctx.progress(t); };
    const { landmarks } = ctx.world;
    let have = await counts(ctx);
    const enough = () => readyFoodPoints(have) >= FOOD_TARGET;
    const refresh = async () => { have = await counts(ctx); };
    const foods = foodsFor26();

    // 1. the home chests
    for (const chest of landmarks.chests) {
      if (enough()) break;
      const inside = await peekChest(ctx, chest).catch(() => ({} as Record<string, number>));
      const edible = Object.entries(inside)
        .filter(([n]) => foods[n] && !AVOID_UNLESS_ASKED.has(n))
        .sort(([a], [b]) => (COOKS_TO[a] ? 1 : 0) - (COOKS_TO[b] ? 1 : 0) || foods[b].foodPoints - foods[a].foodPoints);
      for (const [name, n] of edible) {
        if (enough()) break;
        const want = COOKS_TO[name] ? n : Math.min(n, Math.ceil((FOOD_TARGET - readyFoodPoints(have)) / foods[name].foodPoints));
        const r = await ctx.act('take-from-chest', { ...chest, item: name, count: want });
        rememberReply(ctx.world, chest, r.text);
        if (r.ok) say(`took ${want} ${name}`);
        await refresh();
      }
      if (Object.keys(inside).includes('wheat') && !enough()) {
        const r = await ctx.act('take-from-chest', { ...chest, item: 'wheat', count: 27 });
        rememberReply(ctx.world, chest, r.text);
        if (r.ok) say('took wheat');
        await refresh();
      }
    }

    // 2. bread from wheat
    const wheat = have.get('wheat') ?? 0;
    if (!enough() && wheat >= 3) {
      const r = await ctx.act('craft-item', { outputItem: 'bread', amount: Math.floor(wheat / 3) });
      if (r.ok) say(`baked ${Math.floor(wheat / 3)} bread`);
      await refresh();
    }

    // 3. cook what it carries
    const cook = async () => {
      if (!landmarks.furnace) return;
      for (const [raw] of Object.entries(COOKS_TO)) {
        const n = have.get(raw) ?? 0;
        if (!n) continue;
        let fuel = FUELS.find(f => (have.get(f) ?? 0) > 0);
        if (!fuel) {
          // the stash puts the coal and the logs away: fetch some back (it sat at 7 health with raw fish and no fuel)
          const stored = chestTotals(ctx.world);
          const want = FUELS.find(f => (stored[f] ?? 0) > 0);
          if (want && await takeFromChests(ctx, want, Math.min(stored[want], Math.ceil(n / (/_planks$/.test(want) ? 1.5 : 8)) + 1))) {
            await refresh();
            fuel = FUELS.find(f => (have.get(f) ?? 0) > 0);
          }
        }
        if (!fuel) { say('no fuel to cook with'); return; }
        const r = await ctx.act('smelt-item', { ...landmarks.furnace, inputItem: raw, inputCount: n, fuelItem: fuel, takeOutput: true, timeoutMs: n * 10_500 + 15_000 });
        if (r.ok) say(`cooked ${n} ${raw}`);
        await refresh();
      }
    };
    if (!enough()) await cook();

    // the rest means going out: by day only
    const day = (await ctx.status()).timeOfDay ?? 0;
    const working = day < 11_000 || day >= 23_500;

    // 4. the farm
    if (!enough() && working && landmarks.farmland.length) {
      const centre = farmCentre(ctx.world)!;
      await ctx.act('move-to-position', { ...centre, range: 3, timeoutMs: 90_000 });
      const r = await ctx.act('farm', { range: 16, timeoutMs: 180_000 });
      if (r.ok) say(`farmed (${r.text.slice(0, 80)})`);
      await refresh();
      const w = have.get('wheat') ?? 0;
      if (w >= 3) {
        const b = await ctx.act('craft-item', { outputItem: 'bread', amount: Math.floor(w / 3) });
        if (b.ok) say(`baked ${Math.floor(w / 3)} bread`);
        await refresh();
      }
    }

    // 5. fish (a rod wears out: make another from string and sticks, the chests' included)
    if (!enough() && working && !(have.get('fishing_rod') ?? 0)) {
      if (await makeRod(ctx)) say('made a fishing rod');
      await refresh();
    }
    if (!enough() && working && (have.get('fishing_rod') ?? 0) > 0) {
      const r = await ctx.act('fish', { times: 8, timeoutMs: 240_000 });
      if (r.ok) say(`fished (${r.text.slice(0, 80)})`);
      await refresh();
      await cook();
    }

    // 6. hunt, keeping two of each kind
    if (!enough() && working) {
      const { entities } = await ctx.call<{ entities: { name: string; distance: number; position: Pos }[] }>('world.entities', { maxDistance: 32 });
      const kind = GAME.find(g => entities.filter(e => e.name === g).length >= 3);
      if (kind) {
        const r = await ctx.act('attack-entity', { target: kind, maxDistance: 32, timeoutMs: 30_000 });
        say(r.ok ? `hunted a ${kind}` : `could not hunt a ${kind}`);
        await ctx.act('collect-items', { radius: 6, timeoutMs: 30_000 }).catch(() => undefined);
        await refresh();
        await cook();
      }
    }

    const points = readyFoodPoints(have);
    if (!did.length) throw new Error(`no food to be had right now (carrying ${points} points)`);
    return `${did.join('; ')}; now carrying ${points} food points`;
  }
};

/** Craft a fishing rod (3 sticks, 2 string) from what's carried and in the home chests; true when it has one. */
export async function makeRod(ctx: GoalContext): Promise<boolean> {
  const count = async (n: string) => (await ctx.call<{ items: { name: string; count: number }[] }>('inventory')).items
    .filter(i => i.name === n).reduce((a, i) => a + i.count, 0);
  if ((await count('string')) < 2) await takeFromChests(ctx, 'string', 2 - (await count('string')));
  if ((await count('stick')) < 3) await takeFromChests(ctx, 'stick', 3 - (await count('stick')));
  if ((await count('stick')) < 3) await ctx.act('craft-item', { outputItem: 'stick', amount: 1 });
  if ((await count('string')) < 2 || (await count('stick')) < 3) return false;
  return (await ctx.act('craft-item', { outputItem: 'fishing_rod', amount: 1 })).ok;
}

/** Died a moment ago: go back for the drops while they last (5 minutes), by day and when the spot is safe enough. */
export function recoverGoal(lastDeath: () => { at: Pos; time: number } | undefined): Goal {
  let handled = 0;
  return {
    name: 'recover',
    priority: 90,
    timeoutMs: 4 * 60_000,
    retryMs: 60_000,
    wants: s => {
      const d = lastDeath();
      if (!d || d.time <= handled || s.now - d.time > 4 * 60_000) return null;
      if (s.activity !== 'work' || d.at.y < -60) return null; // night, or fell into the void
      return `died at ${fmt(d.at)} ${Math.round((s.now - d.time) / 1000)}s ago: get the drops back`;
    },
    run: async ctx => {
      const d = lastDeath()!;
      handled = d.time;
      const r = await ctx.act('collect-items', { ...d.at, radius: 10, timeoutMs: 180_000 });
      if (!r.ok) throw new Error(r.text);
      return r.text;
    }
  };
}

/** Badly hurt away from home by day: go home where it's safe and let the Guardian eat and heal. */
export const retreat: Goal = {
  name: 'retreat',
  priority: 85,
  timeoutMs: 10 * 60_000,
  retryMs: 60_000,
  // the yard counts as home: within it the food goal walks to the chests and the furnace, which is how it heals (with
  // AT_HOME it pulled the bot back to the doorstep every few steps, and the food never got fetched)
  wants: s => (s.health < 10 && s.home && s.distHome > RETREAT_FROM && Number.isFinite(s.distHome) ? `health ${s.health.toFixed(1)}: home to heal` : null),
  run: async ctx => {
    const r = await ctx.act('go-home', { name: 'home', timeoutMs: 600_000 });
    if (!r.ok) throw new Error(r.text);
    return 'home to heal';
  }
};
