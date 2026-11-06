import { fenceRing, storageHouse, type Side } from './blueprints.js';
import { cropPlotMilestone } from './farming.js';
import { buildStep, siteStep, yardOf } from './milestones.js';
import type { Milestone, MilestoneState } from './progress.js';
import type { GoalContext } from './goals.js';

/**
 * The bot's long game, in order. Each milestone is done once the world shows it (a zone the build registered), so
 * restarts, and work the LLM did by hand, count.
 */

/** The door of a house faces home: north or south when it stands upright (7 x 9), east or west when turned (9 x 7). */
function doorTowardHome(st: MilestoneState, home: { x: number; z: number }): Side {
  const site = st.data.site as { x: number; z: number; width: number; length: number; rotated: boolean };
  const cx = site.x + site.width / 2, cz = site.z + site.length / 2;
  return site.rotated ? (home.x < cx ? 'west' : 'east') : (home.z < cz ? 'north' : 'south');
}

const storage: Milestone = {
  id: 'storage',
  title: 'storage house',
  prereqs: [],
  done: v => !!v.world.zones?.storage?.length,
  steps: [
    siteStep('storage', 7, 9),
    {
      ...buildStep('storage', st => storageHouse({ chests: 4, doorSide: st.data.door as Side })),
      run: async (ctx, st) => {
        st.data.door ??= doorTowardHome(st, ctx.s.home!);
        return buildStep('storage', s2 => storageHouse({ chests: 4, doorSide: s2.data.door as Side })).run(ctx, st);
      }
    }
  ]
};

/**
 * Gates where the bot comes and goes: one in the middle of each side, and one in line with the front door of the
 * house (the way to the lake south of it).
 */
function gatesFor(yard: { x1: number; z1: number; x2: number; z2: number }, home: { x: number; z: number }) {
  const w = yard.x2 - yard.x1 + 1, l = yard.z2 - yard.z1 + 1;
  const mid = (n: number) => Math.max(1, Math.min(n - 2, Math.floor(n / 2)));
  const front = Math.max(1, Math.min(w - 2, home.x - yard.x1));
  const gates: { side: Side; offset: number }[] = [
    { side: 'north', offset: mid(w) }, { side: 'west', offset: mid(l) }, { side: 'east', offset: mid(l) }, { side: 'south', offset: front }
  ];
  if (Math.abs(front - mid(w)) > 3) gates.push({ side: 'south', offset: mid(w) });
  return gates;
}

const perimeter: Milestone = {
  id: 'perimeter',
  title: 'fence round the yard',
  prereqs: ['storage'],
  done: v => !!v.world.zones?.fence?.length,
  steps: [
    {
      name: 'mark the fence line',
      run: async (ctx: GoalContext, st: MilestoneState) => {
        const yard = await yardOf(ctx);
        st.data.site = { x: yard.x1, z: yard.z1, y: yard.y, width: yard.x2 - yard.x1 + 1, length: yard.z2 - yard.z1 + 1 };
        st.data.gates = gatesFor(yard, ctx.s.home!);
        return { status: 'done', text: `fence along the yard's edge, ${(st.data.gates as unknown[]).length} gates` };
      }
    },
    buildStep('fence', st => {
      const site = st.data.site as { width: number; length: number };
      return fenceRing({ width: site.width, length: site.length }, st.data.gates as { side: Side; offset: number }[]);
    })
  ]
};

export const TREE: Milestone[] = [storage, perimeter, cropPlotMilestone(1, ['perimeter'])];
