import { brainRun, type InventoryItem } from '../tools.js';
import { nearHome, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Milestone, MilestoneState, StepResult } from './progress.js';
import { buildStep, siteStep } from './milestones.js';
import { progressOf } from './progress.js';
import { enchantRoom, type Side } from './blueprints.js';
import { chestTotals, takeFromChests } from './chests.js';
import { gearKind, tier } from './kit.js';
import { DEEP_TRIP, deepTripReady, pickMineStart } from './mine.js';
import { tripCheck } from './deep.js';
import { nearestZone, type Zone } from './courtesy.js';
import { bucketsFor, castObsidian, fetchLava, LAVA_POOL } from './cast.js';
import { walkHome } from './homeward.js';
import { leaveYard } from './yardgates.js';
import { ROOM } from './pockets.js';

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

/**
 * Gear worth enchanting, in the order the chore does it, one piece a run: the sword and the pickaxe (done first live,
 * Nov 14), then the armour, the chestplate first (it covers the most). Of diamond or better, not enchanted yet.
 */
export const ENCHANT_ORDER = ['sword', 'pickaxe', 'chestplate', 'leggings', 'helmet', 'boots'] as const;

/** A worn piece: its inventory index (36 boots .. 39 helmet) and armor.unequip's name for its slot. */
const WORN: Record<string, { index: number; slot: 'head' | 'chest' | 'legs' | 'feet' }> = {
  boots: { index: 36, slot: 'feet' }, leggings: { index: 37, slot: 'legs' }, chestplate: { index: 38, slot: 'chest' }, helmet: { index: 39, slot: 'head' }
};

/** The armour slot to take a worn piece off from, for armor.unequip; undefined for a carried one (0-35). */
export function wornSlot(i: Pick<InventoryItem, 'slot' | 'name'>): 'head' | 'chest' | 'legs' | 'feet' | undefined {
  const w = WORN[gearKind(i.name) ?? ''];
  return w && i.slot === w.index ? w.slot : undefined;
}

/**
 * The next piece to enchant: by ENCHANT_ORDER, of a kind the first plain one of diamond or better, carried or worn.
 * Of one kind the best tier first, and a carried one before the one worn (nothing to take off: the Guardian wears the
 * enchanted one over the plain). A worn piece only with a free pocket slot to take it off into (`free`: armor.unequip
 * refuses without one). Worn armour was left out until P0: the bot sat in plain diamond armour at level 59.
 */
export function enchantPick(items: InventoryItem[], free: number): InventoryItem | undefined {
  const plain = (i: InventoryItem) => !i.enchanted && !i.enchantments?.length;
  for (const kind of ENCHANT_ORDER) {
    const ofKind = items
      .filter(i => gearKind(i.name) === kind && plain(i) && tier(i.name) >= tier(`diamond_${kind}`))
      .filter(i => i.slot < 36 || (wornSlot(i) !== undefined && free > 0))
      .sort((a, b) => tier(b.name) - tier(a.name) || Number(a.slot >= 36) - Number(b.slot >= 36));
    if (ofKind[0]) return ofKind[0];
  }
  return undefined;
}

/**
 * Free pocket slots for a piece taken off, after the room the stash leaves a yard round (ROOM.yard: with fewer free it
 * stops whatever runs, to put things away); below 0 nothing is started. The lapis from the chests takes one first
 * when too little is carried. At 34 kept slots the lapis fetched made 35: the stash stopped the run on its walk to
 * the table and put the lapis back, and enchant wanted again, round and round.
 */
const freeFor = (s: Snapshot) => 36 - s.slotsUsed - ((s.counts.get('lapis_lazuli') ?? 0) < 3 ? 1 : 0) - ROOM.yard;

/** The next piece, where the pockets leave room for it (freeFor). */
const pickFor = (s: Snapshot) => {
  const free = freeFor(s);
  return free < 0 ? undefined : enchantPick(s.items, free);
};

/**
 * How long a piece taken off stays off whatever the Guardian's gear check would wear (Guardian.gearHoldUntil): it is
 * taken off at the table, so this covers the opening and the put, a few seconds. enchant.close ends it and wears the
 * piece again, also for a run the brain gave up (sent outside it, below): this is only the backstop for a close that
 * never reaches the client.
 */
const UNEQUIP_HOLD_MS = 30_000;

/** Every so often by day at level 30 with lapis: enchant the next unenchanted piece at the table, worn armour too. */
export const enchantGoal: Goal = {
  name: 'enchant',
  priority: 31,
  timeoutMs: 4 * MINUTE,
  retryMs: 30 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || s.sleeping || (s.xpLevel ?? 0) < 30 || !world.zones?.['enchanting:table']?.length || !nearHome(s, 24)) return null;
    const piece = pickFor(s);
    if (!piece) return null;
    const lapis = (s.counts.get('lapis_lazuli') ?? 0) + (chestTotals(world).lapis_lazuli ?? 0);
    return lapis >= 3 ? `level ${s.xpLevel}: enchant the ${piece.name}${wornSlot(piece) ? ' (worn)' : ''}` : null;
  },
  run: async ctx => {
    const table = ctx.world.zones!['enchanting:table'][0];
    const piece = pickFor(ctx.s);
    if (!piece) return 'nothing to enchant';
    if ((ctx.s.counts.get('lapis_lazuli') ?? 0) < 3) await takeFromChests(ctx, 'lapis_lazuli', 16);
    await ctx.act('move-to-position', { ...table, range: 2, timeoutMs: 60_000 });
    const worn = wornSlot(piece);
    let done: string;
    let closed: { wore?: string[] } | undefined;
    try {
      // a worn piece comes off at the table, not before the walk (no armour off on the way), and before the table
      // opens: its menu has no armour slots, and armor.unequip shuts any open screen. The hold keeps the Guardian
      // (every 2 s) from wearing it again before the table has it; enchant.close (below) ends the hold and wears the
      // best there is again, the enchanted piece, whatever the Guardian's state (auto-defend off skips its gear check).
      // armor.unequip refuses with a hostile near or the bot just hurt: a failure, the piece still on
      let slot = piece.slot;
      if (worn) {
        const off = await ctx.call<{ ok: boolean; slot: number; name: string }>('armor.unequip', { slot: worn, holdMs: UNEQUIP_HOLD_MS });
        slot = off.slot;
        ctx.progress(`took the ${piece.name} off for the table`);
      }
      await ctx.call('enchant.open', { ...table });
      // one put: the piece (from its own slot: with two pickaxes, the first by name may be the enchanted one) and the
      // lapis with it. A second put of 'lapis_lazuli' took the piece back out and set one lapis in the item slot: 27
      // tries in a day, "no offer for the diamond_sword" every time, and it ping-ponged with signs and sort
      const st = await ctx.call<{ offers: { slot: number; cost: number; enchant: string | null }[]; enchantable?: boolean; put?: string }>(
        'enchant.put', { name: piece.name, slot, lapis: 3 }).catch((e: unknown) => {
        // the hold gives way while the bot is hurt, and a fight wears its best whatever the hold says: the piece can be
        // back on before the table has it. Said so, not as a piece lost from the pockets
        if (worn && e instanceof Error && e.message.includes(`no ${piece.name} in inventory`)) {
          throw new Error(`the ${piece.name} went back on before the table had it (hurt, or a fight)`);
        }
        throw e;
      });
      const offer = [...st.offers].filter(o => o.cost > 0 && o.cost <= (ctx.s.xpLevel ?? 0)).sort((a, b) => b.cost - a.cost)[0];
      // a failure, not a done: it holds for retryMs instead of coming back every few seconds
      if (!offer) throw new Error(`no offer for the ${st.put ?? piece.name}${st.enchantable === false ? ' (not enchantable)' : ''}`);
      const r = await ctx.call<{ ok: boolean; enchantments?: { name: string; level: number }[]; reason?: string }>('enchant.choose', { slot: offer.slot }, 15_000);
      if (!r.ok) throw new Error(r.reason ?? 'not enchanted');
      done = `enchanted the ${piece.name}: ${(r.enchantments ?? []).map(e => `${e.name} ${e.level}`).join(', ')}`;
    } finally {
      // outside the run: once the brain gives a run up (something more urgent, the LLM, the timeout) every call of it
      // is refused, and the table stayed open with the piece in it (the Guardian looks at gear only with no screen
      // open). The close ends the hold and wears the piece again
      closed = await brainRun.exit(() => ctx.call<{ wore?: string[] }>('enchant.close')).catch(() => undefined);
    }
    // a worn piece: whether it is on again (the Guardian's own "put on" notes reach the LLM, not brain.log)
    if (!worn) return done;
    return `${done}; ${closed?.wore?.includes(piece.name) ? 'worn again' : 'not worn again: enchant.close put nothing on'}`;
  }
};
