import type { Goal, GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { Milestone, MilestoneState, Step, StepResult } from './progress.js';
import { cabin, COLOURS, type Side } from './blueprints.js';
import { chestTotals } from './chests.js';
import { someones, type Creature } from './courtesy.js';
import { buildStep, siteStep } from './milestones.js';
import { prepare } from './project.js';

/**
 * The first home: a bed under a roof. On a new server the bot had none: nothing crafted or placed a bed, and the plan
 * began with the storage house, so it walled itself in with dirt every night (the cottage on the friend's server was
 * designed and furnished by hand). Now the plan starts here:
 *   1. a bed: one carried or in a chest, else crafted from three wool of a colour, the wool from wild sheep;
 *   2. a site near home, and the cabin (blueprints.ts `cabin`: bed, crafting table, furnace, torch), door toward home.
 * No sheep to be had after a few tries: the cabin goes up without its bed (the plan moves on), and the bed goal puts
 * one in its place once there's wool.
 */

const MINUTE = 60_000;
/** Bed tries (no wool, no sheep in reach) before the cabin goes up without its bed. */
const BED_TRIES = 3;
/** Sheep at most per hunting run (one wool each). */
const SHEEP_PER_RUN = 4;

const ok = (text: string): StepResult => ({ status: 'done', text });
const blocked = (text: string, retryMs = 10 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });

/** Carried (main inventory) and in the home chests together, by item. */
function totals(items: { name: string; count: number; slot: number }[], world: WorldMemory): Record<string, number> {
  const out: Record<string, number> = { ...chestTotals(world) };
  for (const i of items) if (i.slot < 36) out[i.name] = (out[i.name] ?? 0) + i.count;
  return out;
}

/** A bed the bot has (carried or in a chest), or one it can craft from its wool: the bed's item name, and how. */
export function bedFrom(have: Record<string, number>): { bed: string; craft: boolean } | undefined {
  const owned = Object.keys(have).find(n => /_bed$/.test(n) && have[n] > 0);
  if (owned) return { bed: owned, craft: false };
  // the colour there's most wool of, with three at least
  const wool = COLOURS.map(c => ({ c, n: have[`${c}_wool`] ?? 0 })).filter(w => w.n >= 3).sort((a, b) => b.n - a.n)[0];
  return wool ? { bed: `${wool.c}_bed`, craft: true } : undefined;
}

/** Wool from wild sheep (never someone's: named, tamed, penned or by a build): up to a few per run. */
async function huntSheep(ctx: GoalContext): Promise<number> {
  let got = 0;
  for (let i = 0; i < SHEEP_PER_RUN && !ctx.signal.aborted; i++) {
    const { entities } = await ctx.call<{ entities: (Creature & { position: Pos })[] }>('world.entities', { maxDistance: 64 });
    const sheep = entities.filter(e => e.name === 'sheep' && !someones(e, ctx.world.yard)).sort((a, b) => a.distance - b.distance)[0];
    if (!sheep) break;
    const r = await ctx.act('attack-entity', { target: `#${sheep.id}`, maxDistance: 64, timeoutMs: 45_000 });
    if (!r.ok) break;
    await ctx.act('collect-items', { radius: 6, timeoutMs: 30_000 }).catch(() => undefined);
    got++;
  }
  return got;
}

/** Step 1: a bed in hand (or, after BED_TRIES, none: the cabin goes up without it). */
export const bedStep: Step = {
  name: 'get a bed',
  run: async (ctx: GoalContext, st: MilestoneState) => {
    const inv = async () => totals((await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items, ctx.world);
    let b = bedFrom(await inv());
    if (!b) {
      const n = await huntSheep(ctx);
      if (n) ctx.progress(`hunted ${n} sheep for wool`);
      b = bedFrom(await inv());
    }
    if (b?.craft) {
      const short = await prepare(ctx, b.bed, 1);
      // (short of materials: with `need` the project waits longer each time, until all of it is there)
      if (Object.keys(short).length) return { ...blocked(`crafting a ${b.bed}: short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')}`, 3 * MINUTE), need: short };
    }
    if (b) { st.data.bed = b.bed; return ok(`${b.bed} in hand`); }
    st.data.bedTries = ((st.data.bedTries as number | undefined) ?? 0) + 1;
    if ((st.data.bedTries as number) >= BED_TRIES) {
      st.data.bed = null;
      return ok('no wool to be had for a bed yet: the cabin goes up without it, the bed comes later');
    }
    return blocked(`no bed and no wool for one (no wild sheep within 64): try ${st.data.bedTries}/${BED_TRIES}`, 15 * MINUTE);
  }
};

/** The door faces home: north or south when the cabin stands upright (5 x 7), east or west when turned. */
function doorTowardHome(st: MilestoneState, home: { x: number; z: number }): Side {
  const site = st.data.site as { x: number; z: number; width: number; length: number; rotated: boolean };
  const cx = site.x + site.width / 2, cz = site.z + site.length / 2;
  return site.rotated ? (home.x < cx ? 'west' : 'east') : (home.z < cz ? 'north' : 'south');
}

const plan = (st: MilestoneState) => cabin({ bed: (st.data.bed as string | null) ?? undefined, doorSide: st.data.door as Side });
const cabinBuild = buildStep('home', plan, 'cabin');

export const homeMilestone: Milestone = {
  id: 'home',
  title: 'a home: a bed under a roof',
  prereqs: [],
  // a home built (its zone), or a bed the bot sleeps in already (one put down by hand, the cottage's): nothing to do
  done: v => !!v.world.zones?.home?.length || !!v.world.landmarks.bed,
  steps: [
    bedStep,
    siteStep('home', 5, 7),
    {
      ...cabinBuild,
      run: async (ctx, st) => {
        st.data.door ??= doorTowardHome(st, ctx.s.home!);
        return cabinBuild.run(ctx, st);
      }
    }
  ]
};

/**
 * The bed for a cabin that went up without one: once there's a bed or wool, it goes in the cabin's bed cells (by day,
 * at home). Also a bed that went missing from the cabin (broken, taken) comes back the same way.
 */
export const bedGoal: Goal = {
  name: 'bed',
  priority: 45,
  timeoutMs: 6 * MINUTE,
  retryMs: 20 * MINUTE,
  wants: (s, world) => {
    if (s.sleeping || s.activity !== 'work' || s.dimension !== 'overworld' || !s.home || s.distHome > 16) return null;
    if (world.landmarks.bed || !world.zones?.['home:bed']?.length) return null;
    const have: Record<string, number> = { ...chestTotals(world) };
    for (const [n, k] of s.counts) have[n] = (have[n] ?? 0) + k;
    return bedFrom(have) ? 'the cabin has no bed: put one in' : null;
  },
  run: async ctx => {
    const head = ctx.world.zones!['home:bed'][0], foot = ctx.world.zones?.['home:bed-foot']?.[0];
    if (!foot) throw new Error('the cabin has no foot cell for its bed');
    const have = totals((await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items, ctx.world);
    const b = bedFrom(have);
    if (!b) throw new Error('no bed and no wool for one');
    const short = await prepare(ctx, b.bed, 1);
    if (Object.keys(short).length) throw new Error(`crafting a ${b.bed}: short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    // facing is from the foot to the head
    const facing = head.z < foot.z ? 'north' : head.z > foot.z ? 'south' : head.x < foot.x ? 'west' : 'east';
    const o = { x: Math.min(head.x, foot.x), y: head.y, z: Math.min(head.z, foot.z) };
    const cell = (p: Pos) => (p.x === head.x && p.z === head.z ? 'H' : 'F');
    const rows: string[] = [];
    for (let z = o.z; z <= Math.max(head.z, foot.z); z++) {
      let row = '';
      for (let x = o.x; x <= Math.max(head.x, foot.x); x++) row += cell({ x, y: o.y, z });
      rows.push(row);
    }
    const spec = { palette: { H: `${b.bed}[facing=${facing},part=head]`, F: `${b.bed}[facing=${facing},part=foot]` }, layers: [rows] };
    const r = await ctx.act('build-structure', { ...o, spec, name: 'cabin_bed', timeoutMs: 120_000 });
    if (!r.ok) throw new Error(r.text.split('\n')[0].slice(0, 140));
    ctx.world.landmarks.foundAt = 0; // look for the bed
    return `put a ${b.bed} in the cabin`;
  }
};

