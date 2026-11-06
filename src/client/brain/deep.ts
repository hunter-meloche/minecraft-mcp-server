import type { Goal, Snapshot } from './goals.js';
import type { WorldMemory } from './memory.js';
import { deepTripReady, tripBudgetMs } from './mine.js';
import { readyFoodPoints } from './food.js';
import { tier } from './kit.js';
import { chestTotals } from './chests.js';
import { addZone } from './milestones.js';

/**
 * Deep trips for diamonds: by day, kitted out (deepTripReady: health, food, iron armour, torches, blocks, room), from a
 * departure point outside the home zone, Baritone's miner after diamond ore for as long as the day allows, then home.
 * The kit turns the diamonds into gear (its upgrade pass), pickaxe first; the enchanting table wants two more.
 */

const MINUTE = 60_000;
/** Diamonds for the whole diamond kit: pickaxe, sword, the four armour pieces, and the enchanting table. */
const COST: Record<string, number> = { pickaxe: 3, sword: 2, helmet: 5, chestplate: 8, leggings: 7, boots: 4 };
const TABLE = 2;
const ORE = 'diamond_ore,deepslate_diamond_ore';

/** How many diamonds the bot still wants: the kit pieces not yet diamond (or better), the table, less what it has. */
export function diamondsWanted(s: Pick<Snapshot, 'items'>, world: WorldMemory): number {
  const wear = s.items; // carried (0-35) and worn (36-40)
  let want = TABLE;
  for (const [kind, n] of Object.entries(COST)) {
    const best = Math.max(0, ...wear.filter(i => new RegExp(`_${kind}$`).test(i.name)).map(i => tier(i.name)),
      ...Object.keys(chestTotals(world)).filter(i => new RegExp(`_${kind}$`).test(i)).map(i => tier(i)));
    if (best < tier(`diamond_${kind}`)) want += n;
  }
  const have = (s.items.filter(i => i.name === 'diamond').reduce((a, i) => a + i.count, 0)) + (chestTotals(world).diamond ?? 0);
  return Math.max(0, want - have);
}

/** The deep-trip checklist from a snapshot. */
export function tripCheck(s: Snapshot) {
  // the bridge's raw slots: 36-39 are the worn armour (feet, legs, chest, head)
  const armour = [36, 37, 38, 39].map(slot => s.items.find(i => i.slot === slot)?.name);
  const blocks = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone'].reduce((a, n) => a + (s.counts.get(n) ?? 0), 0);
  return {
    health: s.health, food: s.food, readyFoodPoints: readyFoodPoints(s.counts),
    armorTier: Math.min(...armour.map(n => (n ? tier(n) : 0))),
    torches: s.counts.get('torch') ?? 0, blocks, timeOfDay: s.timeOfDay, slotsFree: 36 - s.slotsUsed
  };
}

export const deepTrip: Goal = {
  name: 'deep trip',
  priority: 37,
  timeoutMs: 14 * MINUTE,
  retryMs: 30 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || s.sleeping || s.dimension !== 'overworld' || !s.home || s.distHome > 16) return null;
    if (s.now - (world.lastDone?.deep ?? 0) < 20 * MINUTE) return null; // once a day
    const want = diamondsWanted(s, world);
    if (!want) return null;
    // not ready (food, torches, armour, ...): the food goal, the kit and the stash see to that first
    return deepTripReady(tripCheck(s)).ok ? `${want} diamond(s) wanted: a deep trip` : null;
  },
  run: async ctx => {
    (ctx.world.lastDone ??= {}).deep = ctx.s.now;
    const budget = Math.min(10 * MINUTE, tripBudgetMs(ctx.s.timeOfDay, 2 * MINUTE));
    if (budget < 3 * MINUTE) throw new Error('too late in the day for a deep trip');
    const home = ctx.s.home!;
    // the departure point: remembered; at first well outside the home zone on the side away from the lake (south)
    let start = ctx.world.zones?.mine?.[0];
    if (!start) {
      const yard = ctx.world.yard;
      const north = (yard ? home.z - yard.z1 : 16) + 40;
      start = { x: home.x, y: home.y, z: home.z - north };
      addZone(ctx.world, 'mine', start);
    }
    ctx.progress(`out to the mine at (${start.x}, ${start.z})`);
    await ctx.call('goto', { ...start, xz: true, range: 4, timeoutMs: 180_000 }, 195_000);
    const want = diamondsWanted(ctx.s, ctx.world);
    ctx.progress(`mining for ${want} diamond(s), ${Math.round(budget / MINUTE)} min`);
    const r = await ctx.act('mine-blocks', { block: ORE, count: Math.min(want, 8), timeoutMs: budget });
    ctx.progress(r.text.split('\n')[0].slice(0, 140));
    const back = await ctx.act('go-home', { name: 'home', timeoutMs: 300_000 });
    if (!back.ok) throw new Error(`mined, but could not get home: ${back.text.slice(0, 120)}`);
    return `${r.text.split('\n')[0].slice(0, 120)}; back home`;
  }
};
