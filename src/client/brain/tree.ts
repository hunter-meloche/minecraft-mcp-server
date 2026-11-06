import { fenceRing, STORAGE_HOUSE_MAX_CHESTS, storageHouse, type Side } from './blueprints.js';
import { CATEGORIES } from './storage.js';
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

const fenceRingStep = buildStep('fence', st => {
  const site = st.data.site as { width: number; length: number };
  return fenceRing({ width: site.width, length: site.length }, st.data.gates as { side: Side; offset: number }[]);
});

/**
 * The fence, in the wood of the fence already standing (a moved fence picked "the wood there's most of", oak, for a
 * birch fence): a post on the ring decides it, else the build step picks.
 */
const fenceBuild = {
  ...fenceRingStep,
  run: async (ctx: GoalContext, st: MilestoneState) => {
    if (!st.data.wood) {
      const site = st.data.site as { x: number; y: number; z: number; width: number; length: number };
      const ring = sideCells({ x1: site.x, z1: site.z, x2: site.x + site.width - 1, z2: site.z + site.length - 1 }, 'north');
      const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { x: site.x, y: site.y + 1, z: site.z, width: ring.length, height: 1, length: 1 });
      const wood = blocks.map(b => /^(?:minecraft:)?([a-z_]+?)_fence(?:_gate)?(?:\[|$)/.exec(b ?? '')?.[1]).find(Boolean);
      if (wood) st.data.wood = wood;
    }
    return fenceRingStep.run(ctx, st);
  }
};

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
    fenceBuild
  ]
};

/** The yard box as a key: the band outside the fence is cleared for one box (it moves when the yard grows). */
const boxKey = (y: Box2) => `${y.x1},${y.z1},${y.x2},${y.z2}`;

/** The 2-block band just outside a yard's edge, as four strips (north and south take the corners). */
export function outerBand(y: Box2, w = 2): Box2[] {
  return [
    { x1: y.x1 - w, z1: y.z1 - w, x2: y.x2 + w, z2: y.z1 - 1 },
    { x1: y.x1 - w, z1: y.z2 + 1, x2: y.x2 + w, z2: y.z2 + w },
    { x1: y.x1 - w, z1: y.z1, x2: y.x1 - 1, z2: y.z2 },
    { x1: y.x2 + 1, z1: y.z1, x2: y.x2 + w, z2: y.z2 }
  ];
}

/**
 * Two blocks cleared outside the fence, level with the yard: a 3-high hill against the fence let creepers walk
 * straight over it into the yard. Done for the yard as it is; when the fence moves out, again.
 */
const fenceClear: Milestone = {
  id: 'fence-clear',
  title: 'clear ground outside the fence',
  prereqs: ['perimeter'],
  done: v => !!v.world.yard && v.world.fenceClearFor === boxKey(v.world.yard) && !v.world.fenceMove,
  steps: [{
    name: 'level 2 blocks outside the fence',
    run: async (ctx: GoalContext, st: MilestoneState) => {
      const yard = await yardOf(ctx);
      const strips = outerBand(yard);
      const doneStrips = (st.data.strips as number[] | undefined) ?? [];
      for (let i = 0; i < strips.length; i++) {
        if (doneStrips.includes(i)) continue;
        if (ctx.signal.aborted) return { status: 'progress', text: `${doneStrips.length} of 4 sides cleared` };
        const s = strips[i];
        ctx.progress(`clearing outside the fence (${s.x1}..${s.x2}, ${s.z1}..${s.z2})`);
        const r = await ctx.act('level-area', { x1: s.x1, z1: s.z1, x2: s.x2, z2: s.z2, level: yard.y, fillWater: false, timeoutMs: 6 * 60_000 });
        if (!/Now level|Already level/.test(r.text)) return { status: 'progress', text: `side ${i + 1}: ${r.text.split('\n').pop()?.slice(0, 100)}` };
        doneStrips.push(i);
        st.data.strips = doneStrips;
      }
      ctx.world.fenceClearFor = boxKey(yard);
      return { status: 'done', text: 'the ground outside the fence is level with the yard' };
    }
  }]
};

/** The side of a footprint a point on its edge is on. */
export function sideOf(site: { x: number; z: number; width: number; length: number }, p: { x: number; z: number }): Side {
  if (p.z === site.z) return 'north';
  if (p.z === site.z + site.length - 1) return 'south';
  if (p.x === site.x) return 'west';
  return 'east';
}

const moreChestsBuild = buildStep('storage', st => storageHouse({ chests: STORAGE_HOUSE_MAX_CHESTS, doorSide: st.data.door as Side }), 'rest of the chests');

/**
 * A chest for every kind of thing: the storage house filled up to its six double chests (it went up with four, and
 * with six chests for eight kinds the food and the tools had none). Same site, door and wood as the house.
 */
const moreChests: Milestone = {
  id: 'storage-more',
  title: 'a chest for every kind of thing',
  prereqs: ['storage'],
  done: v => v.world.landmarks.chests.length >= CATEGORIES.length || !v.world.zones?.storage?.length,
  steps: [{
    ...moreChestsBuild,
    run: async (ctx: GoalContext, st: MilestoneState) => {
      const z = ctx.world.zones!.storage[0];
      const site = { x: z.x, y: z.y, z: z.z, width: z.width!, length: z.length! };
      st.data.site ??= site;
      const door = ctx.world.zones?.['storage:door']?.[0];
      st.data.door ??= door ? sideOf(site, door) : 'south';
      if (!st.data.wood) {
        const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { x: site.x, y: site.y + 1, z: site.z, width: 1, height: 1, length: 1 });
        st.data.wood = /^(?:minecraft:)?([a-z_]+?)_log/.exec(blocks[0] ?? '')?.[1] ?? undefined;
      }
      return moreChestsBuild.run(ctx, st);
    }
  }]
};

export const TREE: Milestone[] = [storage, moreChests, perimeter, fenceClear, cropPlotMilestone(1, ['perimeter']), treeFarmMilestone(['plot1']),
  penMilestone('cow', ['plot1']), penMilestone('sheep', ['pen-cow']),
  caneMilestone(['plot1']), enchantingMilestone(['cane', 'pen-cow'])];
