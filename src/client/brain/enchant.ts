import { nearHome, type Goal, type GoalContext } from './goals.js';
import type { Milestone, MilestoneState, StepResult } from './progress.js';
import { buildStep, siteStep } from './milestones.js';
import { progressOf } from './progress.js';
import { enchantRoom, type Side } from './blueprints.js';
import { chestTotals, takeFromChests } from './chests.js';
import { tier } from './kit.js';
import { DEEP_TRIP, deepTripReady, pickMineStart } from './mine.js';
import { tripCheck } from './deep.js';
import { nearestZone, type Zone } from './courtesy.js';
import { bucketsFor, castObsidian, fetchLava, LAVA_POOL } from './cast.js';
import { walkHome } from './homeward.js';
import { leaveYard } from './yardgates.js';

/**
 * Enchanting: obsidian (mined with a diamond pickaxe), then a 7 x 7 room with the table in the middle and 15 shelves
 * (books from cane paper and cow leather: the stash, the cane round and the pens bring them in over the days), and a
 * chore that enchants the best unenchanted gear at level 30 with lapis.
 */

const MINUTE = 60_000;
const ok = (text: string): StepResult => ({ status: 'done', text });
const blocked = (text: string, retryMs = 20 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });

/** How far a trip for obsidian looks: steps of this many blocks out from the mine, scanning after each. */
const OBSIDIAN_STEP = 40;
const OBSIDIAN_STEPS = 3;
/** Free slots an obsidian trip wants (buckets of lava and the obsidian itself, not ore). */
export const OBSIDIAN_TRIP_SLOTS = 3;

type P = { x: number; y: number; z: number };

/**
 * Obsidian in sight to dig: every obsidian block the loaded chunks hold (all depths), nearest first, less a lit
 * nether portal's frame (anything within 4 of a portal block; the mod refuses those anyway).
 */
export function obsidianTargets(obsidian: P[], portals: P[], from: P): P[] {
  const d2 = (a: P, b: P) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
  return obsidian.filter(p => !portals.some(q => d2(p, q) <= 16)).sort((a, b) => d2(a, from) - d2(b, from));
}

/** Dig obsidian in sight until the inventory holds `want`; returns how many it holds. */
async function digObsidian(ctx: GoalContext, want: number): Promise<number> {
  const find = (block: string) => ctx.call<{ positions: P[] }>('world.findBlocks', { block, maxDistance: 96, count: 128 }).catch(() => ({ positions: [] as P[] }));
  const here = (await ctx.call<{ position?: P }>('status').catch(() => undefined))?.position ?? ctx.s.position;
  const targets = obsidianTargets((await find('obsidian')).positions, (await find('nether_portal')).positions, here);
  let have = await countOf(ctx, 'obsidian');
  for (const p of targets.slice(0, 8)) {
    if (have >= want || ctx.signal.aborted) break;
    const r = await ctx.act('dig-block', { ...p });
    ctx.progress(`obsidian at (${p.x}, ${p.y}, ${p.z}): ${r.text.split('\n')[0].slice(0, 100)}`);
    have = await countOf(ctx, 'obsidian');
  }
  return have;
}

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
        run: async (ctx, st) => {
          // what it gathers for the room stays carried: the step took the obsidian from the chest, the pockets went to
          // 28, the stash (more urgent) put it back, and round again every 15 s
          const p = progressOf(ctx.world);
          p.carry = [...new Set([...(p.carry ?? []), 'obsidian'])];
          const stored = chestTotals(ctx.world).obsidian ?? 0;
          if (stored && (await countOf(ctx, 'obsidian')) < 4) await takeFromChests(ctx, 'obsidian', 4);
          const have = await countOf(ctx, 'obsidian');
          if (have >= 4) return ok(`${have} obsidian`);
          if (!(await countOf(ctx, 'diamond_pickaxe'))) return blocked('waiting for a diamond pickaxe to mine obsidian with', 30 * MINUTE);
          // obsidian in sight (the loaded chunks, every depth) that isn't a lit portal's frame, one block at a time:
          // Baritone's own miner went for the nearest obsidian it knew, which was the community chest's portal, walked
          // a hundred blocks toward it twice, and gave up ("Unable to find any path") as the portal guard stopped it
          let got = await digObsidian(ctx, 4);
          if (got >= 4) return ok(`${got} obsidian (near home)`);
          // cast it at home from lava and water (cast.ts): buckets from iron, water from the lake, lava open to the sky
          // in sight; what's still short, a trip out for natural obsidian or lava
          const cast = async () => {
            if (!(await countOf(ctx, 'lava_bucket'))) return;
            const c = await castObsidian(ctx, 4);
            ctx.progress(c.text);
            got = c.have;
          };
          const noBuckets = await bucketsFor(ctx, 4 - got);
          if (!noBuckets) {
            await fetchLava(ctx, 4 - got);
            await cast();
            if (got >= 4) return ok(`${got} obsidian, cast at home`);
          } else ctx.progress(`casting obsidian: ${noBuckets}`);
          // none near home: out from the mine's departure point, kitted out like a deep trip, looking a step at a time
          // kitted out like a deep trip, but the pockets needn't be as empty: it brings back a few buckets and 4
          // obsidian, not a load of ore (it sat at home all morning, "4 free slots < 10", with the storage house full)
          const check = tripCheck(ctx.s);
          const ready = deepTripReady(check.slotsFree >= OBSIDIAN_TRIP_SLOTS ? { ...check, slotsFree: Math.max(check.slotsFree, DEEP_TRIP.slotsFree) } : check);
          if (!ready.ok) return blocked(`no obsidian or lava in sight near home; a trip out for it waits for: ${ready.why}`, 15 * MINUTE);
          const zones = (await ctx.call<{ zones: Zone[] }>('foreign.zones').catch(() => ({ zones: [] as Zone[] }))).zones;
          const start = pickMineStart(ctx.s.home!, ctx.world.yard, ctx.world.zones?.mine?.[0], p => nearestZone(p, zones, true).distance);
          if (!start) return blocked("every side of the yard has someone else's build by it: no trip out from here", 60 * MINUTE);
          (ctx.world.zones ??= {}).mine = [start];
          // a different way each trip
          const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
          const turn = ((st.data.obsidianTurn as number | undefined) ?? 0) % 4;
          st.data.obsidianTurn = turn + 1;
          const [dx, dz] = dirs[turn];
          const lavaEnough = async () => !noBuckets && got + (await countOf(ctx, 'lava_bucket')) >= 4;
          // a pool that gave lava before: straight there first
          const pool = ctx.world.zones?.[LAVA_POOL]?.[0];
          if (pool && !noBuckets) {
            ctx.progress(`obsidian: to the lava pool at (${pool.x}, ${pool.z})`);
            // (out of the yard by the gate on the way, not over the fence: yardgates.ts)
            await leaveYard(ctx, pool);
            await ctx.call('goto', { x: pool.x, y: pool.y, z: pool.z, xz: true, range: 8, timeoutMs: 180_000 }, 195_000).catch(() => undefined);
            await fetchLava(ctx, 4 - got);
            if (!(await countOf(ctx, 'lava_bucket'))) delete ctx.world.zones![LAVA_POOL]; // dry, or no safe spot now: look again
          }
          for (let step = 0; step <= OBSIDIAN_STEPS && got < 4 && !(await lavaEnough()) && !ctx.signal.aborted; step++) {
            const at = { x: start.x + dx * OBSIDIAN_STEP * step, y: start.y, z: start.z + dz * OBSIDIAN_STEP * step };
            ctx.progress(`obsidian: looking round (${at.x}, ${at.z})`);
            await leaveYard(ctx, at);
            await ctx.call('goto', { ...at, xz: true, range: 6, timeoutMs: 120_000 }, 135_000).catch(() => undefined);
            got = await digObsidian(ctx, 4);
            if (got < 4 && !noBuckets) await fetchLava(ctx, 4 - got);
            if (await lavaEnough()) break;
          }
          // (the obsidian and the lava pools it found may be down in a cave: from there it climbs out first)
          await walkHome(ctx, { timeoutMs: 300_000 }).catch(() => undefined);
          if (got < 4) await cast();
          if (got >= 4) return ok(`${got} obsidian`);
          return blocked(`short of obsidian (${got}/4): none in sight, and not enough lava, on a trip ${['north', 'east', 'south', 'west'][turn]} from the mine`, 20 * MINUTE);
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
    if (s.activity !== 'work' || s.sleeping || (s.xpLevel ?? 0) < 30 || !world.zones?.['enchanting:table']?.length || !nearHome(s, 24)) return null;
    const piece = s.items.find(i => i.slot < 36 && WORTH.test(i.name) && !i.enchanted && tier(i.name) >= tier(i.name.replace(/^[a-z]+_/, 'diamond_')));
    if (!piece) return null;
    const lapis = (s.counts.get('lapis_lazuli') ?? 0) + (chestTotals(world).lapis_lazuli ?? 0);
    return lapis >= 3 ? `level ${s.xpLevel}: enchant the ${piece.name}` : null;
  },
  run: async ctx => {
    const table = ctx.world.zones!['enchanting:table'][0];
    // carried pieces, 0-35 (worn armour, 36-39, isn't where the table takes from: it waits for a spare)
    const piece = ctx.s.items.filter(i => i.slot < 36 && WORTH.test(i.name) && !i.enchanted).sort((a, b) => tier(b.name) - tier(a.name))[0];
    if (!piece) return 'nothing to enchant';
    if ((ctx.s.counts.get('lapis_lazuli') ?? 0) < 3) await takeFromChests(ctx, 'lapis_lazuli', 16);
    await ctx.act('move-to-position', { ...table, range: 2, timeoutMs: 60_000 });
    try {
      await ctx.call('enchant.open', { ...table });
      // one put: the piece (from its own slot: with two pickaxes, the first by name may be the enchanted one) and the
      // lapis with it. A second put of 'lapis_lazuli' took the piece back out and set one lapis in the item slot: 27
      // tries in a day, "no offer for the diamond_sword" every time, and it ping-ponged with signs and sort
      const st = await ctx.call<{ offers: { slot: number; cost: number; enchant: string | null }[]; enchantable?: boolean; put?: string }>(
        'enchant.put', { name: piece.name, slot: piece.slot, lapis: 3 });
      const offer = [...st.offers].filter(o => o.cost > 0 && o.cost <= (ctx.s.xpLevel ?? 0)).sort((a, b) => b.cost - a.cost)[0];
      // a failure, not a done: it holds for retryMs instead of coming back every few seconds
      if (!offer) throw new Error(`no offer for the ${st.put ?? piece.name}${st.enchantable === false ? ' (not enchantable)' : ''}`);
      const r = await ctx.call<{ ok: boolean; enchantments?: { name: string; level: number }[]; reason?: string }>('enchant.choose', { slot: offer.slot }, 15_000);
      if (!r.ok) throw new Error(r.reason ?? 'not enchanted');
      return `enchanted the ${piece.name}: ${(r.enchantments ?? []).map(e => `${e.name} ${e.level}`).join(', ')}`;
    } finally {
      await ctx.call('enchant.close').catch(() => undefined);
    }
  }
};
