import type { ClientRuntime } from '../tools.js';
import { nearHome, type Goal, type GoalContext } from './goals.js';
import { key } from './chests.js';
import { prepare } from './project.js';
import { missingBuilt, type BuiltBlock } from './integrity.js';
import type { Pos, WorldMemory } from './memory.js';
import { roundDue, roundFrom, toRound } from './work.js';
import { FILL_MAX, fenceBuilt, fenceGround, mendFence, yardRing } from './fence.js';

/**
 * Once a day: look over everything the bot built around home and put back what went missing (a creeper's crater in
 * the cabin wall, a torch an enderman took, the block Baritone broke walking past). Built blocks are the protected
 * positions with the state each had when built; see integrity.ts for what counts as missing. The yard's fence is
 * looked over all the way round, however far it runs from home, and mended with the ground under it (fence.ts).
 */

const MINUTE = 60_000;
/** Near enough home to start the round where it is; from further out in the yard it walks home first (work.ts roundFrom). */
const NEAR_HOME = 10;
/** How far around home built blocks are checked. */
export const REPAIR_RADIUS = 24;
/** world.region's limit (cells per call). */
const REGION_MAX = 65_536;

// the same daily bookkeeping as chores.ts
const done = (world: WorldMemory, chore: string, now: number) => { world.lastDone ??= {}; world.lastDone[chore] = now; };

/** The blocks at `positions` (as world.region gives them: null where unloaded), read over their bounding box in slabs. */
export async function readCells(ctx: Pick<GoalContext, 'call'>, positions: Pos[]): Promise<(string | null)[]> {
  if (!positions.length) return [];
  const min = (k: keyof Pos) => Math.min(...positions.map(p => p[k]));
  const max = (k: keyof Pos) => Math.max(...positions.map(p => p[k]));
  const box = { x: min('x'), y: min('y'), z: min('z'), width: max('x') - min('x') + 1, height: max('y') - min('y') + 1, length: max('z') - min('z') + 1 };
  const per = Math.max(1, Math.floor(REGION_MAX / (box.width * box.length)));
  const blocks: (string | null)[] = [];
  for (let y = 0; y < box.height; y += per) {
    const part = await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...box, y: box.y + y, height: Math.min(per, box.height - y) }, 60_000);
    blocks.push(...part.blocks);
  }
  return positions.map(p => blocks[(p.x - box.x) + (p.z - box.z) * box.width + (p.y - box.y) * box.width * box.length] ?? null);
}

/** The daily home-integrity round (register it with the brain's goals). */
export function repairGoal(rt: ClientRuntime): Goal {
  // the fence's own blocks near home are the fence pass's (its walks are careful, and it sees to the ground first);
  // what of the ring that pass leaves (past a leash set under 24) is the round's own still, as it always was
  const builtAround = (home: Pos, world: WorldMemory): BuiltBlock[] => {
    const fence = new Set(fenceBuilt(rt, world, home).map(b => key(b.at)));
    return rt.builtNear(home, REPAIR_RADIUS).filter(b => !fence.has(key(b.at)));
  };
  return {
    name: 'repair',
    priority: 38,
    timeoutMs: 10 * MINUTE,
    retryMs: 15 * MINUTE,
    // blocks put back: a round that finds nothing missing (or can put none of it back) brought nothing
    gains: true,
    // anywhere in the yard on home's level (work.ts roundFrom): wanted within 10 of home only, it went an hour unrun
    wants: (s, world) => {
      if (s.activity !== 'work' || s.sleeping || s.dimension !== 'overworld' || !s.home || !roundFrom(s, world, NEAR_HOME)) return null;
      // after 20 min, and then in the evening, or when no trip could go instead (or it has waited 40): the morning is the trips'
      if (!roundDue(s, world, 'repair', 20 * MINUTE)) return null;
      // the fence counts wherever it runs: 42 from home, a hole in it was out of the round's sight
      return rt.builtNear(s.home, REPAIR_RADIUS).length || fenceBuilt(rt, world, s.home).length ? 'daily round: anything missing from what the bot built' : null;
    },
    // within 10 of home it cuts in as ever; from out in the yard it waits for what runs to end
    cuts: s => nearHome(s, NEAR_HOME),
    run: async run => {
      // from out in the yard, home first (on foot): the round as it always started, from within 10 of home
      const ctx: GoalContext = { ...run, s: await toRound(run, NEAR_HOME) };
      const home = ctx.s.home!;
      const ring = yardRing(ctx.world);
      const fence = fenceBuilt(rt, ctx.world, home);
      // blocks built before states were kept: take what stands there now as how they should be (once)
      const unknown = [...builtAround(home, ctx.world), ...fence].filter(b => !b.state);
      if (unknown.length) {
        const now = await readCells(ctx, unknown.map(b => b.at));
        const adopt = unknown.map((b, i) => ({ at: b.at, state: now[i] ?? '' }))
          .filter(b => b.state && !/^(minecraft:)?(air|cave_air|void_air)$/.test(b.state));
        rt.adoptStates(adopt);
        if (adopt.length) ctx.progress(`took the current state of ${adopt.length} older built block(s) as their baseline`);
      }
      const built = builtAround(home, ctx.world).filter(b => b.state);
      const ringBuilt = fenceBuilt(rt, ctx.world, home).filter(b => b.state);
      if (!built.length && !ringBuilt.length) { done(ctx.world, 'repair', ctx.s.now); return 'nothing built near home to check'; }
      const plan = missingBuilt(built, await readCells(ctx, built.map(b => b.at)));
      const fencePlan = ring && ringBuilt.length ? missingBuilt(ringBuilt, await readCells(ctx, ringBuilt.map(b => b.at))) : undefined;
      done(ctx.world, 'repair', ctx.s.now);
      // a hole in the fence: the ground under it, read now, so the fill it takes is fetched with the rest (not for a
      // cell put back in vain twice: that is left alone, and nothing is fetched for it)
      const fails = ctx.world.repairFails ?? {};
      const fenceTodo = fencePlan?.restore.filter(r => (fails[key(r.at)] ?? 0) < 2) ?? [];
      const ground = ring && fenceTodo.length ? await fenceGround(ctx, ring, fenceTodo) : undefined;
      const taken = plan.occupied ? `; ${plan.occupied} cell(s) hold another block now (left alone)` : '';
      const lost = plan.lost.length
        ? `; not put back: ${plan.lost.slice(0, 5).map(l => `${l.state.replace(/\[.*$/, '')} at ${key(l.at)} (${l.why})`).join(', ')}` : '';
      // a whole fence is counted with the rest; one with a hole says so in its own words, after the rest
      const fenceDue = !!(fencePlan && (fencePlan.restore.length || fencePlan.lost.length || fencePlan.occupied));
      const checked = built.length + (fenceDue ? 0 : ringBuilt.length);
      const nearText = !checked ? '' : `${plan.lost.length ? 'missing blocks' : `all ${checked} built blocks checked, none missing`}${lost}${taken}`;
      const both = (...parts: string[]) => parts.filter(Boolean).join('; ');
      if (!plan.restore.length && !fenceTodo.length) return fenceDue ? both(nearText, await mendFence(ctx, rt, ring!, fencePlan!, ground, new Map())) : nearText;
      if (plan.restore.length) ctx.progress(`${plan.restore.length} block(s) to put back`);

      // what's needed, carried or fetched from the home chests
      const inv = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
      const have = new Map<string, number>();
      for (const i of inv.items) have.set(i.name, (have.get(i.name) ?? 0) + i.count);
      const need = new Map<string, number>();
      for (const r of [...plan.restore, ...fenceTodo]) need.set(r.item, (need.get(r.item) ?? 0) + 1);
      // the fill under the fence: dirt, as much as a run puts down at most
      const fillWant = ground?.cells ? Math.min(ground.cells, FILL_MAX) : 0;
      if (fillWant) need.set('dirt', (need.get('dirt') ?? 0) + fillWant);
      for (const [item, n] of need) {
        if (n - (have.get(item) ?? 0) <= 0) continue;
        // from the chests, else crafted (planks and stairs from the logs in the chests: a creeper took cabin planks
        // and the round put back only what it found as it was)
        const short = await prepare(ctx, item, n).catch(() => ({ [item]: n }));
        if (!Object.keys(short).length) { have.set(item, n); ctx.progress(`got ${n} ${item} ready`); continue; }
        const now = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
        have.set(item, now.items.filter(i => i.name === item).reduce((a, i) => a + i.count, 0));
      }
      // what dirt there is not, cobblestone or cobbled deepslate (prepare's "cobblestone" takes both): live the chests
      // held no dirt and hundreds of both, and short of dirt the posts went back over the open ground
      const noDirt = Math.min(fillWant, (need.get('dirt') ?? 0) - (have.get('dirt') ?? 0));
      const stone = (m: Map<string, number>) => (m.get('cobblestone') ?? 0) + (m.get('cobbled_deepslate') ?? 0);
      if (noDirt > 0 && stone(have) < stone(need) + noDirt) {
        await prepare(ctx, 'cobblestone', stone(need) + noDirt).catch(() => undefined);
        const now = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
        for (const kind of ['cobblestone', 'cobbled_deepslate']) have.set(kind, now.items.filter(i => i.name === kind).reduce((a, i) => a + i.count, 0));
      }

      let restored = 0;
      const noItem = new Map<string, number>();
      const failed: string[] = [];
      // a cell put back in vain two days running (buried fill out of reach, say) is left alone from then on
      const tries = (ctx.world.repairFails ??= {});
      for (const r of plan.restore) {
        if ((tries[key(r.at)] ?? 0) >= 2) continue;
        if ((have.get(r.item) ?? 0) <= 0) { noItem.set(r.item, (noItem.get(r.item) ?? 0) + 1); continue; }
        const why = await rt.restoreBlock(r.at, r.item, r.facing);
        if (why) {
          tries[key(r.at)] = (tries[key(r.at)] ?? 0) + 1;
          failed.push(`${r.item} at ${key(r.at)}: ${why}`); ctx.progress(failed.at(-1)!); continue;
        }
        delete tries[key(r.at)];
        restored++;
        ctx.gain(1);
        have.set(r.item, have.get(r.item)! - 1);
        ctx.progress(`put back ${r.item} at ${key(r.at)}`);
      }
      const missing = noItem.size ? `; no ${[...noItem].map(([n, c]) => `${n} (x${c})`).join(', ')} to put back` : '';
      const couldnt = failed.length ? `; couldn't place ${failed.slice(0, 5).join('; ')}` : '';
      const out = plan.restore.length ? `put back ${restored}/${plan.restore.length} missing block(s)${missing}${couldnt}${lost}${taken}` : nearText;
      // the fence last: its walk goes out along the yard and ends with the walk home
      if (!fenceDue) return out;
      const mended = await mendFence(ctx, rt, ring!, fencePlan!, ground, have);
      ctx.progress(mended);
      return both(out, mended);
    }
  };
}
