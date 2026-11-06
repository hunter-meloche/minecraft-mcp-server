import type { Goal, GoalContext } from './goals.js';
import type { Milestone, MilestoneState, StepResult } from './progress.js';
import { buildStep, siteStep } from './milestones.js';
import { enchantRoom, type Side } from './blueprints.js';
import { chestTotals, takeFromChests } from './chests.js';
import { tier } from './kit.js';

/**
 * Enchanting: obsidian (mined with a diamond pickaxe), then a 7 x 7 room with the table in the middle and 15 shelves
 * (books from cane paper and cow leather: the stash, the cane round and the pens bring them in over the days), and a
 * chore that enchants the best unenchanted gear at level 30 with lapis.
 */

const MINUTE = 60_000;
const ok = (text: string): StepResult => ({ status: 'done', text });
const blocked = (text: string, retryMs = 20 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });

const countOf = async (ctx: GoalContext, item: string) =>
  (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items
    .filter(i => i.name === item).reduce((a, i) => a + i.count, 0);

function doorToward(st: MilestoneState, home: { x: number; z: number }): Side {
  const site = st.data.site as { x: number; z: number };
  const cx = site.x + 3.5, cz = site.z + 3.5;
  return Math.abs(home.x - cx) > Math.abs(home.z - cz) ? (home.x < cx ? 'west' : 'east') : (home.z < cz ? 'north' : 'south');
}

export function enchantingMilestone(prereqs: string[]): Milestone {
  const build = buildStep('enchanting', st => enchantRoom({ doorSide: st.data.door as Side }), 'enchanting room');
  return {
    id: 'enchanting',
    title: 'an enchanting room',
    prereqs,
    done: v => !!v.world.zones?.enchanting?.length,
    steps: [
      {
        name: 'mine 4 obsidian',
        run: async ctx => {
          const stored = chestTotals(ctx.world).obsidian ?? 0;
          if (stored && (await countOf(ctx, 'obsidian')) < 4) await takeFromChests(ctx, 'obsidian', 4);
          const have = await countOf(ctx, 'obsidian');
          if (have >= 4) return ok(`${have} obsidian`);
          if (!(await countOf(ctx, 'diamond_pickaxe'))) return blocked('waiting for a diamond pickaxe to mine obsidian with', 30 * MINUTE);
          const r = await ctx.act('mine-blocks', { block: 'obsidian', count: 4 - have, timeoutMs: 6 * MINUTE });
          await ctx.act('go-home', { name: 'home', timeoutMs: 300_000 }).catch(() => undefined);
          if ((await countOf(ctx, 'obsidian')) >= 4) return ok(r.text.split('\n')[0].slice(0, 100));
          return blocked(`short of obsidian: ${r.text.split('\n')[0].slice(0, 100)}`, 60 * MINUTE);
        }
      },
      siteStep('enchanting room', 7, 7),
      { ...build, run: async (ctx, st) => { st.data.door ??= doorToward(st, ctx.s.home!); return build.run(ctx, st); } }
    ]
  };
}

/** Gear worth enchanting: diamond (or better) tools and armour that aren't enchanted yet. */
const WORTH = /_(pickaxe|sword|helmet|chestplate|leggings|boots)$/;

/** Every so often by day at level 30 with lapis: enchant the best unenchanted piece at the table. */
export const enchantGoal: Goal = {
  name: 'enchant',
  priority: 31,
  timeoutMs: 4 * MINUTE,
  retryMs: 30 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || s.sleeping || (s.xpLevel ?? 0) < 30 || !world.zones?.['enchanting:table']?.length || s.distHome > 24) return null;
    const piece = s.items.find(i => i.slot >= 9 && WORTH.test(i.name) && !i.enchanted && tier(i.name) >= tier(i.name.replace(/^[a-z]+_/, 'diamond_')));
    if (!piece) return null;
    const lapis = (s.counts.get('lapis_lazuli') ?? 0) + (chestTotals(world).lapis_lazuli ?? 0);
    return lapis >= 3 ? `level ${s.xpLevel}: enchant the ${piece.name}` : null;
  },
  run: async ctx => {
    const table = ctx.world.zones!['enchanting:table'][0];
    // carried pieces (worn armour isn't in the slots the table takes from: it waits for a spare)
    const piece = ctx.s.items.filter(i => i.slot >= 9 && WORTH.test(i.name) && !i.enchanted).sort((a, b) => tier(b.name) - tier(a.name))[0];
    if (!piece) return 'nothing to enchant';
    if ((ctx.s.counts.get('lapis_lazuli') ?? 0) < 3) await takeFromChests(ctx, 'lapis_lazuli', 16);
    await ctx.act('move-to-position', { ...table, range: 2, timeoutMs: 60_000 });
    try {
      await ctx.call('enchant.open', { ...table });
      await ctx.call('enchant.put', { name: piece.name });
      await ctx.call('enchant.put', { name: 'lapis_lazuli' });
      const st = await ctx.call<{ offers: { slot: number; cost: number; enchant: string | null }[]; level?: number }>('enchant.status');
      const offer = [...st.offers].filter(o => o.cost > 0 && o.cost <= (ctx.s.xpLevel ?? 0)).sort((a, b) => b.cost - a.cost)[0];
      if (!offer) return `no offer for the ${piece.name} (are the shelves in place?)`;
      const r = await ctx.call<{ ok: boolean; enchantments?: { name: string; level: number }[]; reason?: string }>('enchant.choose', { slot: offer.slot }, 15_000);
      if (!r.ok) throw new Error(r.reason ?? 'not enchanted');
      return `enchanted the ${piece.name}: ${(r.enchantments ?? []).map(e => `${e.name} ${e.level}`).join(', ')}`;
    } finally {
      await ctx.call('enchant.close').catch(() => undefined);
    }
  }
};
