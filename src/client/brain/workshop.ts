import type { GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { stepOf, type Milestone, type MilestoneState, type Step, type StepResult } from './progress.js';
import { buildStep, siteStep } from './milestones.js';
import { workshop, type Side } from './blueprints.js';
import { doorToward } from './enchant.js';
import { waterBucketStep } from './farming.js';
import { goHome } from './homeward.js';
import { inFence } from './yardgates.js';
import { holdHarmless } from './fluidpick.js';

/**
 * The workshop (P1 of the progression plan): a 7 x 7 room with the anvil, for enchanted books onto the gear and repairs
 * with diamonds (anvil.ts), a smithing table (netherite, P6), a crafting table, a cell kept for the brewing stand (P4)
 * and a cell of water in its floor for the stand's bottles. Its steps: a site, the build, the water poured.
 */

const MINUTE = 60_000;
const ID = 'workshop';
const ok = (text: string): StepResult => ({ status: 'done', text });
const blocked = (text: string, retryMs = 10 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });

type Site = { x: number; y: number; z: number; width?: number; length?: number };
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;

/** The workshop of a milestone's data: its door toward home, as the build step chose it. */
const planOf = (st: MilestoneState) => workshop({ doorSide: st.data.door as Side | undefined });

/**
 * Where a landmark of the workshop is in the world, by its site and door as the build step had them (the build's origin
 * is a block over the ground, groundOffset 1): the water's cell, at y -1, is in the ground itself.
 */
export function workshopCell(st: MilestoneState, kind: string): Pos | undefined {
  const site = st.data.site as Site | undefined;
  const bp = planOf(st);
  const l = bp.landmarks.find(m => m.kind === kind);
  if (!site || !l) return undefined;
  return { x: site.x + l.at.x, y: site.y + bp.groundOffset + l.at.y, z: site.z + l.at.z };
}

/** The floor cell in the middle of the room, where the bot stands to reach every cell inside it. */
function middleOf(st: MilestoneState): Pos | undefined {
  const site = st.data.site as Site | undefined;
  const bp = planOf(st);
  if (!site) return undefined;
  return { x: site.x + Math.floor(bp.size.width / 2), y: site.y + bp.groundOffset, z: site.z + Math.floor(bp.size.length / 2) };
}

const inside = (p: { x: number; z: number }, b: Site) =>
  !!b.width && !!b.length && p.x >= b.x && p.x < b.x + b.width && p.z >= b.z && p.z < b.z + b.length;
const inYard = (p: { x: number; z: number }, y: NonNullable<WorldMemory['yard']>) => p.x >= y.x1 && p.x <= y.x2 && p.z >= y.z1 && p.z <= y.z2;

/** The workshop's own ground: its zone once built, and the site it keeps meanwhile (in hand, or set aside midway). */
function ownGround(world: WorldMemory): Site[] {
  const p = world.progress;
  const kept = [p?.current?.id === ID ? p.current.data?.site : undefined, p?.aside?.[ID]?.data?.site] as unknown[];
  const sites = kept.filter((b): b is Site => !!b && typeof b === 'object' && typeof (b as Site).x === 'number' && typeof (b as Site).z === 'number');
  return [...sites, ...(world.zones?.[ID] ?? [])];
}

/**
 * An anvil and a smithing table standing in the yard, as the last look round home saw them (findLandmarks), and not on
 * the workshop's own ground: the improvement runs may put up a workshop of their own first (improve-prompt.md says
 * not to build it twice), and that one does. This milestone's own anvil, built and the water not in yet, does not: the
 * build places it before the walls are done, and the look every 10 minutes would have ended the milestone half built.
 */
export function workshopStanding(world: WorldMemory): boolean {
  const { anvil, smithing } = world.landmarks;
  const yard = world.yard;
  if (!anvil || !smithing || !yard) return false;
  const own = ownGround(world);
  return [anvil, smithing].every(p => inYard(p, yard) && !own.some(b => inside(p, b)));
}

/**
 * The anvil to work at: the workshop's landmark, whatever stands there now (anvil.ts puts a broken one back there),
 * else one standing in the yard (a workshop the improvement run built: the milestone counts it as done).
 */
export function workshopAnvil(world: WorldMemory): Pos | undefined {
  const own = world.zones?.[`${ID}:anvil`]?.[0];
  if (own) return { x: own.x, y: own.y, z: own.z };
  const a = world.landmarks.anvil;
  return a && world.yard && inYard(a, world.yard) ? { ...a } : undefined;
}

const SOURCE = /^water(\[level=0\])?$/;
const OPEN = /^(air|cave_air|water)(\[|$)/;
const AIR = /^(air|cave_air)(\[|$)/;
/** Blocks a stray pour's source is plugged with (and dug out again). */
const FILL = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone'];
const blockAt = async (ctx: GoalContext, p: Pos) =>
  ((await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...p, width: 1, height: 1, length: 1 })).blocks[0] ?? '').replace(/^minecraft:/, '');
const carried = async (ctx: GoalContext, item: string) =>
  (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items
    .filter(i => i.slot < 36 && i.name === item).reduce((a, i) => a + i.count, 0);

/**
 * Where the bot stands to pour: a floor cell beside the hole (feet and head clear, a floor under it), the one nearest
 * the room's middle; undefined when none is. A full bucket pours where the SERVER's look from the bot's eye meets a
 * block, and the server looks from the eye it has for the bot: standing (1.62), as the bridge crouches (1.27) for the
 * use a moment before it, 0.35 under the eye the aim came from. From the middle, 2 off, aimed at the hole's opening,
 * that higher look went over the hole onto the floor block past it, and the water stood on the room's floor over the
 * hole (live, Nov 14). From beside it, aimed at the inner face of the floor block across the hole (farWall), the look
 * from either eye, traced from either, anywhere in the cell, crosses the floor's top inside the hole and meets that
 * face: the water goes in the hole. (Aimed at the hole's bottom, a crouched eye 0.3 back from the hole crossed the
 * floor's top short of it.)
 */
async function besideHole(ctx: GoalContext, cell: Pos, middle: Pos): Promise<Pos | undefined> {
  const around = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: cell.x + dx, y: cell.y + 1, z: cell.z + dz }))
    .sort((a, b) => Math.hypot(a.x - middle.x, a.z - middle.z) - Math.hypot(b.x - middle.x, b.z - middle.z));
  for (const p of around) {
    const [floor, feet, head] = [await blockAt(ctx, { ...p, y: p.y - 1 }), await blockAt(ctx, p), await blockAt(ctx, { ...p, y: p.y + 1 })];
    if (AIR.test(feet) && AIR.test(head) && floor && !OPEN.test(floor)) return p;
  }
  return undefined;
}

/** The floor block across the hole from where the bot stands, and its face toward the hole; undefined if not solid. */
async function farWall(ctx: GoalContext, cell: Pos, beside: Pos): Promise<{ at: Pos; face: string } | undefined> {
  const dx = cell.x - beside.x, dz = cell.z - beside.z;
  const at = { x: cell.x + dx, y: cell.y, z: cell.z + dz };
  const b = await blockAt(ctx, at);
  if (!b || OPEN.test(b)) return undefined;
  return { at, face: dx > 0 ? 'west' : dx < 0 ? 'east' : dz > 0 ? 'north' : 'south' };
}

/**
 * The water in the workshop's floor: a bucket of it (from the chests, or a bucket filled at the lake: the crop plot's
 * step), the floor block of its cell dug out and the water poured in at the hole's open top. The walk into the room is
 * on foot only (A11: Baritone may neither break nor place on it), from inside the fence (in by a gate after the lake),
 * to the floor cell beside the hole (besideHole; else to within a block of the room's middle), from where the dig and
 * the pour reach the cell.
 *
 * Why the hole's top, not the block under it as the crop plot clicks: a full bucket pours nowhere it is clicked
 * (26.3 BucketItem has no use on a block, so the bridge's useOn falls back to "use"), but beside the first block its
 * look meets, on the side it meets. Aimed at the hole's bottom from 2 blocks off (the room's middle, or the cell a walk
 * in by the door stops on, a block short of it), the look came down onto the floor block beside the hole first: the
 * water went onto the floor, ran into the hole as falling water, never a source, and every 10 minutes it went to the
 * lake for another bucket (traced in scratch on the built room, standing and sneaking). Aimed at the middle of the
 * hole's top, the line can only go on into the hole: whichever of its sides or its bottom it meets, the water goes in
 * the cell. That held for a look from the eye the aim came from; the server's is higher (besideHole), and the water
 * stood on the floor over the hole. So now from beside the hole at its bottom, and from the middle at its top only
 * when no cell beside it is free.
 */
export const fillWaterStep: Step = {
  name: 'fill the water cell',
  run: async (ctx, st) => {
    const cell = workshopCell(st, 'water');
    const middle = middleOf(st);
    if (!cell || !middle) return blocked('no site chosen', MINUTE);
    if (SOURCE.test(await blockAt(ctx, cell))) return ok(`the water is in at ${fmt(cell)}`);
    if (!(await carried(ctx, 'water_bucket'))) {
      const got = await waterBucketStep.run(ctx, st);
      // (short of a bucket: blocked with its `need`, for the back-off and the stock trips)
      if (got.status !== 'done') return got;
      ctx.progress(`workshop water: ${got.text}`);
    }
    // the walk with a sword in hand, not the full bucket (fluidpick.ts holdHarmless: Baritone's click on the room's
    // door poured it on the crop plot outside, twice)
    await holdHarmless(ctx);
    const here = (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
    if (!inFence(ctx.world, here)) await goHome(ctx, 180_000).catch(() => undefined);
    if (ctx.signal.aborted) return { status: 'progress', text: 'stopped on the way to the workshop' };
    const beside = await besideHole(ctx, cell, middle);
    const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...(beside ?? middle), range: beside ? 0 : 1, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
    if (walk?.arrived === false) return blocked(`no way on foot into the workshop to pour its water at ${fmt(cell)}`);
    const b = await blockAt(ctx, cell);
    if (!OPEN.test(b)) {
      // from where it stands: nothing else broken (dig.here walks nowhere)
      const d = await ctx.call<{ dug: boolean; reason?: string }>('dig.here', { ...cell, timeoutMs: 15_000 }, 25_000)
        .catch((e: unknown) => ({ dug: false, reason: e instanceof Error ? e.message : String(e) }));
      if (!d.dug && d.reason !== 'air') return blocked(`could not dig out the ${b} for the water at ${fmt(cell)}: ${d.reason ?? 'not dug'}`);
    }
    // from beside the hole, at the far side's inner face (see besideHole); else from the middle at the opening (above)
    const far = beside && await farWall(ctx, cell, beside);
    const r = await ctx.act('use-item-on-block', far ? { ...far.at, item: 'water_bucket', face: far.face } : { ...cell, item: 'water_bucket', face: 'up' });
    if (SOURCE.test(await blockAt(ctx, cell))) return ok(`water in the workshop's floor at ${fmt(cell)}`);
    // a pour onto the floor over the hole floods the room: that source plugged with a block and dug out again (a
    // block placed is clicked on a face: the server takes it where the bridge says, not along its own look)
    const over = { ...cell, y: cell.y + 1 };
    if (SOURCE.test(await blockAt(ctx, over))) {
      const fill = FILL.find(n => ctx.s.counts.get(n));
      const placed = fill ? await ctx.act('place-block', { ...over, item: fill }) : undefined;
      if (placed?.ok && /^Placed/.test(placed.text)) await ctx.act('dig-block', { ...over });
      ctx.progress(`workshop water: poured onto the floor over the hole; ${placed?.ok && /^Placed/.test(placed.text) ? `plugged with ${fill} and dug out` : 'not plugged (no block to plug it with)'}`);
    }
    // a wait, not at once again: a step that comes back at once is run again at once
    return blocked(`pouring the water at ${fmt(cell)}: ${r.text.slice(0, 100)}`);
  }
};

/**
 * The workshop, after the enchanting room. Done once the world shows it: its zone, with the water in (the build step
 * puts the zone and its landmarks down, a step before the water: done on the zone alone, the water was never poured), or
 * an anvil and a smithing table already standing in the yard (workshopStanding).
 */
export function workshopMilestone(prereqs: string[]): Milestone {
  const build = buildStep(ID, planOf, 'workshop');
  return {
    id: ID,
    title: 'a workshop',
    prereqs,
    done: v => (!!v.world.zones?.[ID]?.length && !(stepOf(v.world.progress, ID) > 0)) || workshopStanding(v.world),
    steps: [
      siteStep('workshop', 7, 7),
      { ...build, run: async (ctx, st) => { st.data.door ??= doorToward(st, ctx.s.home!); return build.run(ctx, st); } },
      fillWaterStep
    ]
  };
}
