import { AVOID_UNLESS_ASKED } from '../../food.js';
import { foodsFor26 } from '../tools.js';
import { AT_HOME, fromGate, nearHome, no, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { collectFurnace, farmAll } from './chores.js';
import { FOOD_CARRY } from './pockets.js';
import { chestTotals, peekChest, rememberReply, takeFromChests } from './chests.js';
import { someones, type Creature } from './courtesy.js';
import { placeNearHome } from './firsts.js';
import { underNow } from './underyard.js';
import { goHome, walkHome } from './homeward.js';
import { EXPLORE_MIN, exploreReach, leaveYard } from './yardgates.js';

/** How far round the bot the hunt looks for game. */
const HUNT_RANGE = 64;
/** Most animals one food round hunts. */
const HUNT_MAX = 4;

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
  priority: 76,
  // above the shelter's evening walk and the retreat, which kept pulling it back to the doorstep on its way to the
  // chests and the furnace in the yard, so it never ate
  urgency: s => (starving(s) ? 88 : 76),
  timeoutMs: 15 * 60_000,
  retryMs: 5 * 60_000,
  wants: s => {
    if (s.dimension !== 'overworld' || !s.home) return null;
    const need = short(s);
    if (need <= 0) return null;
    // at night only what can be done at home: cook, bake, the chest
    if (s.activity !== 'work' && !nearHome(s, starving(s) ? RETREAT_FROM : AT_HOME)) return null;
    return `carrying ${FOOD_TARGET - need} food points of ready food (want ${FOOD_TARGET})`;
  },
  run: ctx => gatherFood(ctx, FOOD_TARGET, true)
};

/** Ready food kept at home, carried and in the chests together (food points). */
export const LARDER = 60;
const storedFood = (world: WorldMemory) => readyFoodPoints(new Map(Object.entries(chestTotals(world))));

/**
 * Run now? The "no" is said in this order: no home to stock; the larder is full; then what keeps a round that is
 * wanted from going (not in the yard, hungry or hurt: the food goal's turn); the hour last.
 */
const larderGate = (s: Snapshot, world: WorldMemory): Gate => {
  if (!s.home || s.dimension !== 'overworld') return no.away(s, 'larder', 24);
  const total = readyFoodPoints(s.counts) + storedFood(world);
  if (!(total < LARDER)) return { cause: 'stocked', text: `${total} food points at home (keep ${LARDER})` };
  if (!nearHome(s, 24)) return no.away(s, 'larder', 24);
  if (s.health < 14 || s.food < 14) return no.health(s, 'larder', 14, 14);
  return no.late(s, 'larder', 3000) ?? { want: `${total} food points at home (keep ${LARDER})` };
};

/**
 * The stockpile (third after staying alive and the gear): by day, fed and healthy, farm, fish and hunt until the
 * home holds LARDER food points, so a bad day (rain, no fish, a fight) never leaves the bot short.
 */
export const larder: Goal = {
  name: 'larder',
  priority: 48,
  timeoutMs: 12 * 60_000,
  retryMs: 10 * 60_000,
  gate: larderGate,
  ...fromGate(larderGate),
  run: async ctx => {
    const before = readyFoodPoints(ctx.s.counts) + storedFood(ctx.world);
    const text = await gatherFood(ctx, Math.max(FOOD_TARGET, LARDER - storedFood(ctx.world)), false);
    const inv = await ctx.call<{ items: { name: string; count: number }[] }>('inventory');
    const counts = new Map<string, number>();
    for (const i of inv.items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
    // nothing gained (nothing ripe, no fish biting, no game about): a failure, so it waits before trying again rather
    // than going straight back to the same empty farm
    if (readyFoodPoints(counts) + storedFood(ctx.world) <= before) throw new Error(`nothing gained: ${text.slice(0, 120)}`);
    return text;
  }
};

/**
 * Get ready food up to `target` points carried: from the home chests (unless `useChests` is off: the larder adds to
 * the stock rather than moving it about), baked, cooked, farmed, fished, hunted.
 */
export async function gatherFood(ctx: GoalContext, target: number, useChests: boolean): Promise<string> {
  const did: string[] = [];
  const say = (t: string) => { did.push(t); ctx.progress(t); };
  const { landmarks } = ctx.world;
  let have = await counts(ctx);
  const enough = () => readyFoodPoints(have) >= target;
  const refresh = async () => { have = await counts(ctx); };
  const foods = foodsFor26();

  // 1. the home chests
  for (const chest of useChests ? landmarks.chests : []) {
    if (enough()) break;
    const inside = await peekChest(ctx, chest).catch(() => ({} as Record<string, number>));
    const edible = Object.entries(inside)
      .filter(([n]) => foods[n] && !AVOID_UNLESS_ASKED.has(n))
      .sort(([a], [b]) => (COOKS_TO[a] ? 1 : 0) - (COOKS_TO[b] ? 1 : 0) || foods[b].foodPoints - foods[a].foodPoints);
    for (const [name, n] of edible) {
      if (enough()) break;
      // never past the stack of a kind the stash leaves carried (FOOD_CARRY): all the raw meat of a chest came out to
      // be cooked, and with more than a stack of it and a furnace that would not cook, the stash would put the rest
      // back and this take it out again, turn about
      const most = FOOD_CARRY - (have.get(name) ?? 0);
      if (most <= 0) continue;
      const want = Math.min(most, COOKS_TO[name] ? n : Math.min(n, Math.ceil((target - readyFoodPoints(have)) / foods[name].foodPoints)));
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
  let cleared = false;
  const cook = async () => {
    // a new bot with meat and no furnace yet: one from 8 cobblestone beside home (raw meat isn't ready food)
    if (!landmarks.furnace && Object.keys(COOKS_TO).some(raw => (have.get(raw) ?? 0) > 0) && ctx.s.home &&
      ((have.get('furnace') ?? 0) > 0 || (have.get('cobblestone') ?? 0) + (have.get('cobbled_deepslate') ?? 0) >= 8)) {
      const at = await placeNearHome(ctx, 'furnace');
      if (at) { landmarks.furnace = at; say(`put a furnace down at (${at.x}, ${at.y}, ${at.z})`); }
    }
    if (!landmarks.furnace) return;
    // logs left in the input from a charcoal burn that ran out of fuel block every cook ("input slot is occupied"):
    // take them back first, and anything finished with them
    if (!cleared) {
      cleared = true;
      const took = await collectFurnace(ctx).catch(() => '');
      if (took) { ctx.progress(`took ${took} out of the furnace`); await refresh(); }
    }
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
      await refresh();
      // cooked means the raw meat went: "input slot is occupied" is no error, and counted as done the food goal
      // "cooked 2 beef; cooked 2 chicken" every 30 s for two hours, the same 4 raw pieces, the bot at 0 food points
      const left = have.get(raw) ?? 0;
      if (left < n) say(`cooked ${n - left} ${raw}`);
      else ctx.progress(`could not cook ${raw}: ${r.text.slice(0, 120)}`);
    }
  };
  if (!enough()) await cook();

  // the rest means going out: by day only
  const day = (await ctx.status()).timeOfDay ?? 0;
  const working = day < 11_000 || day >= 23_500;

  // 4. the farm
  if (!enough() && working && landmarks.farmland.length) {
    const before = readyFoodPoints(have) + (have.get('wheat') ?? 0);
    const r = await farmAll(ctx);
    await refresh();
    // farmed is something only when food or wheat came of it: "nothing ripe to harvest" counted as done, and with
    // the cooking also failing the goal finished every 20 s with nothing, instead of failing and waiting
    if (readyFoodPoints(have) + (have.get('wheat') ?? 0) > before) say(`farmed (${r.text.slice(0, 80)})`);
    else ctx.progress(`farmed, nothing to eat from it (${r.text.slice(0, 80)})`);
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

  // 6. hunt, keeping two of each kind: wild ones only (never named, tamed, on a lead, in someone's pen, or grazing by
  // someone's builds: on a friend's server those are theirs), one in particular each time, not "the nearest cow".
  // As many as it takes (up to HUNT_MAX) for what it carries to cook into the target, then all of it cooked: a trip
  // came back with one chicken, and the bot ate it raw
  if (!enough() && working) {
    const hungry = ctx.s.food < 14;
    const cookable = () => [...have].reduce((a, [n, k]) => a + (COOKS_TO[n] && foods[COOKS_TO[n]] ? k * foods[COOKS_TO[n]].foodPoints : 0), 0);
    const hunted = new Map<string, number>();
    let walked = false;
    // hungry with nothing to hunt round here (the herds near home hunted out, a horse left): out looking for game,
    // a side at a time within the leash, and the hunt goes on from where it found some
    if (hungry) {
      const near = (await ctx.call<{ entities: (Creature & { position: Pos })[] }>('world.entities', { maxDistance: HUNT_RANGE })).entities
        .filter(e => !someones(e, ctx.world.yard) && GAME.includes(e.name));
      if (!near.length) {
        const sides = ['north', 'east', 'south', 'west'] as const;
        for (let i = 0; i < sides.length && !ctx.signal.aborted; i++) {
          const target = GAME[i % GAME.length];
          // (out of the yard by the gate on that side, and in by one between the sides: not over the fence, yardgates.ts;
          // the explore from the gate no further than the leash is from home)
          const left = await exploreReach(ctx, await leaveYard(ctx, sides[i]), Math.min(ctx.world.leash ?? 96, 128));
          const r = left >= EXPLORE_MIN ? await ctx.act('explore', { target, direction: sides[i], maxDistance: left, step: 32, timeoutMs: 90_000 }) : { ok: false, text: '' };
          if (/^Found /.test(r.text)) { say(`found ${target} to the ${sides[i]}`); break; }
          await goHome(ctx, 300_000).catch(() => undefined);
        }
      }
    }
    for (let kills = 0; kills < HUNT_MAX && readyFoodPoints(have) + cookable() < target && !ctx.signal.aborted; kills++) {
      // 64 round: out on the plains the herds grazed 40 to 65 blocks off, never 3 of a kind within 32
      const { entities } = await ctx.call<{ entities: (Creature & { position: Pos })[] }>('world.entities', { maxDistance: HUNT_RANGE });
      const wild = entities.filter(e => !someones(e, ctx.world.yard));
      // fed, it leaves two of a kind to breed; hungry, a lone one will do (the herds had moved off, one of each stayed)
      const kind = GAME.find(g => wild.filter(e => e.name === g).length >= (hungry ? 1 : 3));
      const prey = kind ? wild.filter(e => e.name === kind).sort((a, b) => a.distance - b.distance)[0] : undefined;
      if (!kind || !prey) {
        // hungry, and the game it saw is past the hunting range (explore says "Found" for a cow 80 blocks off without
        // walking a step: the food goal spun on that, 3 s a run, the bot starving at home): walk over to it, once
        if (!hungry || walked) break;
        walked = true;
        const far = (await ctx.call<{ entities: (Creature & { position: Pos })[] }>('world.entities', { maxDistance: Math.min(Math.max(ctx.world.leash ?? 96, HUNT_RANGE), 128) })).entities
          .filter(e => !someones(e, ctx.world.yard) && GAME.includes(e.name) && e.position)
          .sort((a, b) => a.distance - b.distance)[0];
        if (!far) break;
        say(`walking over to a ${far.name} ${Math.round(far.distance)} blocks off`);
        await leaveYard(ctx, far.position);
        await ctx.call('goto', { x: Math.floor(far.position.x), y: Math.floor(far.position.y), z: Math.floor(far.position.z), range: 12, timeoutMs: 90_000 }, 100_000).catch(() => undefined);
        kills--;
        continue;
      }
      // the chase is Baritone's walk to the animal: from in the yard to one outside it, out by a gate first
      await leaveYard(ctx, prey.position);
      const r = await ctx.act('attack-entity', { target: `#${prey.id}`, maxDistance: HUNT_RANGE, timeoutMs: 45_000 });
      if (!r.ok) { say(`could not hunt a ${kind}`); break; }
      hunted.set(kind, (hunted.get(kind) ?? 0) + 1);
      await ctx.act('collect-items', { radius: 6, timeoutMs: 30_000 }).catch(() => undefined);
      await refresh();
    }
    if (hunted.size) say(`hunted ${[...hunted].map(([k, n]) => `${n} ${k}`).join(', ')}`);
    await cook();
  }

  const points = readyFoodPoints(have);
  if (!did.length) throw new Error(`no food to be had right now (carrying ${points} points)`);
  return `${did.join('; ')}; now carrying ${points} food points`;
}


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
  // (and under it: 15 from home across the ground in a cave 55 below the yard is not home). Under the yard itself the
  // walk home stops in a second, and three of those held the retreat for the rest of the day: out from under heals
  // first and digs out, and the retreat is for once it is up
  wants: (s, world) => (s.health < 10 && s.home && !nearHome(s, RETREAT_FROM) && Number.isFinite(s.distHome) && !underNow(s, world) ? `health ${s.health.toFixed(1)}: home to heal` : null),
  run: async ctx => {
    // up out of a mine first: from down there go-home's way runs under the ground into the yard's column (walkHome)
    const r = await walkHome(ctx, { timeoutMs: 600_000 });
    if (!r.ok) throw new Error(r.text);
    return 'home to heal';
  }
};
