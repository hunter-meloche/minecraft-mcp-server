import type { Goal } from './goals.js';
import { FOOD_TARGET, gatherFood, readyFoodPoints } from './food.js';
import { stock, stockShort } from './chores.js';

/**
 * The idle watchdog's last resort: something useful when nothing else would run by day. The bot stood at home for
 * a quarter of an hour, hungry (9) with no food, its storage house a log short: a wood trip doesn't set out under
 * hunger 10, and the food goal waited out a "morning" hold counted in real time though sleeping had brought the
 * morning at once. Hungry, it goes for food (the hunt, fishing, what the chests hold); else it fetches what a
 * project or the home is short of, the stock trip without the stock goal's own conditions.
 */
export const IDLE_FIRST = 3 * 60_000;
const GAME_DIRS = ['north', 'east', 'south', 'west'] as const;
export const IDLE_FORAGE = 6 * 60_000;

export const forage: Goal = {
  name: 'forage',
  priority: 1,
  timeoutMs: 12 * 60_000,
  retryMs: 10 * 60_000,
  wants: () => null, // never chosen by the brain's decide: only the idle watchdog starts it
  run: async ctx => {
    const carried = readyFoodPoints(ctx.s.counts);
    if (carried < FOOD_TARGET && ctx.s.food < 18) {
      ctx.progress(`idle and hungry (food ${ctx.s.food}, carrying ${carried} food points): out for food`);
      try {
        return `food: ${await gatherFood(ctx, FOOD_TARGET, true)}`;
      } catch {
        // no game round home: out looking for some, then the food round again from wherever it was found
        for (const target of ['cow', 'pig', 'sheep', 'chicken']) {
          const r = await ctx.act('explore', { target, direction: GAME_DIRS[Math.floor(Math.random() * GAME_DIRS.length)], maxDistance: Math.min(ctx.world.leash ?? 96, 128), step: 32, timeoutMs: 90_000 });
          if (/^Found /.test(r.text)) return `food: found ${target}: ${await gatherFood(ctx, FOOD_TARGET, true)}`;
        }
        await ctx.act('go-home', { name: 'home', timeoutMs: 300_000 }).catch(() => undefined);
        return 'idle and hungry: no game found round home';
      }
    }
    if (stockShort(ctx.s, ctx.world).length) {
      ctx.progress('idle: fetching what the home is short of');
      return `stock: ${await stock.run(ctx)}`;
    }
    return 'idle, and nothing short: nothing to forage for';
  }
};
