import { fenceRing, storageHouse, type Side } from './blueprints.js';
import { cropPlotMilestone, treeFarmMilestone } from './farming.js';
import { penMilestone } from './pens.js';
import { caneMilestone } from './cane.js';
import { enchantingMilestone } from './enchant.js';
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

type Box2 = { x1: number; z1: number; x2: number; z2: number };
const onRing = (p: { x: number; z: number }, y: Box2) =>
  p.x >= y.x1 && p.x <= y.x2 && p.z >= y.z1 && p.z <= y.z2 && (p.x === y.x1 || p.x === y.x2 || p.z === y.z1 || p.z === y.z2);

/**
 * When the fence moves out: the gates stay where they are on the sides that stay, and the moved side's gates go
 * straight out to the new edge (so the paths through them still line up).
 */
export function gatesKept(yard: Box2, old: { x: number; z: number }[], moved: Side): { side: Side; offset: number }[] {
  const out: { side: Side; offset: number }[] = [];
  for (const g of old) {
    const side: Side = g.z === yard.z1 && g.x > yard.x1 && g.x < yard.x2 ? 'north' : g.z === yard.z2 && g.x > yard.x1 && g.x < yard.x2 ? 'south'
      : g.x === yard.x1 && g.z > yard.z1 && g.z < yard.z2 ? 'west' : g.x === yard.x2 && g.z > yard.z1 && g.z < yard.z2 ? 'east' : moved;
    const alongX = side === 'north' || side === 'south';
    const offset = alongX ? g.x - yard.x1 : g.z - yard.z1;
    const span = alongX ? yard.x2 - yard.x1 + 1 : yard.z2 - yard.z1 + 1;
    if (offset < 1 || offset > span - 2 || out.some(o => o.side === side && o.offset === offset)) continue;
    out.push({ side, offset });
  }
  return out;
}

/** The cells of one side of a yard's edge. */
export function sideCells(y: Box2, side: Side): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  if (side === 'north' || side === 'south') for (let x = y.x1; x <= y.x2; x++) out.push({ x, z: side === 'north' ? y.z1 : y.z2 });
  else for (let z = y.z1; z <= y.z2; z++) out.push({ x: side === 'west' ? y.x1 : y.x2, z });
  return out;
}

const perimeter: Milestone = {
  id: 'perimeter',
  title: 'fence round the yard',
  prereqs: ['storage'],
  done: v => !!v.world.zones?.fence?.length && !v.world.fenceMove,
  steps: [
    {
      name: 'take down the old side of the fence',
      run: async (ctx: GoalContext, st: MilestoneState) => {
        const mv = ctx.world.fenceMove;
        if (!mv) return { status: 'done', text: 'no fence to move' };
        const yard = await yardOf(ctx);
        const cells = sideCells(mv.old, mv.side).filter(p => !onRing(p, yard));
        let dug = 0;
        for (const c of cells) for (const dy of [2, 1]) { // the post's torch first, then the post (or gate)
          if (ctx.signal.aborted) return { status: 'progress', text: `took down ${dug} block(s)` };
          const at = { x: c.x, y: mv.old.y + dy, z: c.z };
          const { blocks: [b] } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...at, width: 1, height: 1, length: 1 });
          if (!/(_fence|_fence_gate|torch)(\[|$)/.test((b ?? '').replace(/^minecraft:/, ''))) continue;
          const r = await ctx.act('dig-block', { ...at });
          if (/^Dug/.test(r.text)) dug++;
        }
        // the ring is rebuilt round the new yard, landmarks and all; its gates stay put (see gatesKept)
        const z = ctx.world.zones ?? {};
        st.data.oldGates = (z['fence:gate'] ?? []).map(g => ({ x: g.x, z: g.z }));
        st.data.moved = mv.side;
        delete z.fence; delete z['fence:gate']; delete z['fence:torch'];
        ctx.world.fenceMove = undefined;
        return { status: 'done', text: `took down the ${mv.side} side (${dug} block(s))` };
      }
    },
    {
      name: 'mark the fence line',
      run: async (ctx: GoalContext, st: MilestoneState) => {
        const yard = await yardOf(ctx);
        st.data.site = { x: yard.x1, z: yard.z1, y: yard.y, width: yard.x2 - yard.x1 + 1, length: yard.z2 - yard.z1 + 1 };
        const old = st.data.oldGates as { x: number; z: number }[] | undefined;
        st.data.gates = old?.length ? gatesKept(yard, old, st.data.moved as Side) : gatesFor(yard, ctx.s.home!);
        return { status: 'done', text: `fence along the yard's edge, ${(st.data.gates as unknown[]).length} gates` };
      }
    },
    buildStep('fence', st => {
      const site = st.data.site as { width: number; length: number };
      return fenceRing({ width: site.width, length: site.length }, st.data.gates as { side: Side; offset: number }[]);
    })
  ]
};

export const TREE: Milestone[] = [storage, perimeter, cropPlotMilestone(1, ['perimeter']), treeFarmMilestone(['plot1']),
  penMilestone('cow', ['plot1']), penMilestone('sheep', ['pen-cow']),
  caneMilestone(['plot1']), enchantingMilestone(['cane', 'pen-cow'])];
