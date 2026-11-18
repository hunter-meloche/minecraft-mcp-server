import type { GoalContext } from './goals.js';
import type { Landmarks, Pos, WorldMemory } from './memory.js';
import { progressOf, RECIPES, reservedSites, STRING_KEEP, type KeptSite, type Milestone, type MilestoneState, type Step, type StepResult } from './progress.js';
import { buildStep, growStep, readBox, yardOf } from './milestones.js';
import { findSite, occupancy, type Grid, type Rect, type Site } from './site.js';
import { COLOURS, hall, HALL_SIZE, type Side } from './blueprints.js';
import { prepare } from './project.js';
import { freeChestTotals } from './chests.js';
import { penCount } from './work.js';

/**
 * The villager hall (P5b of the progression plan): the bot's own room at home for the villagers it brings in (P5c) and
 * the librarian it rerolls until Mending (P5d). A 9 x 7 room entered by a fence gate (villagers open doors, not gates),
 * three beds, a fletching table (a fletcher buys sticks: the emeralds), an empty cell for the lectern, and a panel in
 * its wall that the move digs out to bring them in. Its steps: a site well off the pens and the portal, the beds and
 * the windows' glass (what the build step cannot make by itself), the build.
 */

const MINUTE = 60_000;
export const ID = 'hall';
/** Blocks from the pens' rings (and their gates and torches) to the hall's walls at least: the herd kept off the room. */
export const FROM_PENS = 8;
/**
 * From the portal's footprint: zombified piglins come out of a lit portal now and then and wander. Villagers do not flee
 * them (26.3's VillagerHostilesSensor names zombies and illagers), so it is the bot that must not fight one by the hall:
 * a sword's sweep reaches the villager beside it.
 */
export const FROM_PORTAL = 6;
/**
 * From every other zone, the sites other milestones keep, and the improvement runs' builds (their structure boxes: they
 * keep no zone), as the portal's site keeps off them: room to walk round the hall. Not the portal's 8: in the live
 * yard (Nov 15) no 11 x 9 spot stands 8 off everything and 2 in from the fence, and the yard would grow for it; at 4
 * one does, at the north end by the tree farm.
 */
export const FROM_BUILDS = 4;
/** findSite's own clearance round the footprint (nothing built, farmed or wet within it). */
const CLEARANCE = 2;
/** How often the yard grows for the hall before the site step waits and says why. */
export const HALL_GROWS = 2;
/** The beds of the hall (a villager sleeps in its own, and breeds only with a bed free for the child). */
export const HALL_BEDS = 3;
/** The windows' glass (the blueprint's), smelted from sand before the build: the build step cannot make glass itself. */
export const HALL_GLASS = hall().bill.glass ?? 0;
/** The sheep pen's wool waited for before the beds' wool is made of string. */
export const WOOL_WAITS = 3;
const WOOL_WAIT_MS = 20 * MINUTE;
/** Wool a bed takes, and string a wool (the 26.3 recipes, as RECIPES has them). */
const WOOL_PER_BED = RECIPES.white_bed.from.white_wool;
const STRING_PER_WOOL = RECIPES.white_wool.from.string;
/** How far a bed may stand from the fletching table and be of the same room (a 9 x 7 room's farthest corners). */
const ROOM_REACH = 8;

const ok = (text: string): StepResult => ({ status: 'done', text });
const going = (text: string): StepResult => ({ status: 'progress', text });
const blocked = (text: string, retryMs = 10 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });
/** Short of materials: the project waits longer each time the step comes back so (project.ts backoffMs). */
const shortOf = (text: string, need: Record<string, number>): StepResult => ({ status: 'blocked', text, retryMs: 3 * MINUTE, need });
const list = (short: Record<string, number>) => Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ');

type HallSite = { x: number; y: number; z: number; width: number; length: number; rotated: boolean };
const inYard = (p: { x: number; z: number }, y: NonNullable<WorldMemory['yard']>) => p.x >= y.x1 && p.x <= y.x2 && p.z >= y.z1 && p.z <= y.z2;
const inside = (p: { x: number; z: number }, b: KeptSite) =>
  !!b.width && !!b.length && p.x >= b.x && p.x < b.x + b.width && p.z >= b.z && p.z < b.z + b.length;

// ------------------------------------------------------------------------------------------------ the site

/**
 * The rectangles the hall's site keeps off, padded so that findSite's own clearance round the site plus the padding is
 * the distance asked (portal.ts portalAvoid's way): every zone of the yard but the fence's ring (its gates and torches
 * with it: it rings them all), the pens' FROM_PENS off (their gates and torches with them), the portal's FROM_PORTAL,
 * the rest FROM_BUILDS; points as a block each. And the sites other milestones keep, and the boxes of the structures
 * placed (`builds`), FROM_BUILDS off. The hall's own zones are no reason (it chooses its site before it has any).
 */
export function hallAvoid(zones: WorldMemory['zones'], reserved: KeptSite[], builds: Rect[] = []): Rect[] {
  const pad = (b: { x: number; z: number; width?: number; length?: number }, by: number): Rect =>
    ({ x: b.x - by, z: b.z - by, width: (b.width ?? 1) + 2 * by, length: (b.length ?? 1) + 2 * by });
  const out: Rect[] = [];
  for (const [kind, boxes] of Object.entries(zones ?? {})) {
    if (kind === 'fence' || kind.startsWith('fence:') || kind === ID || kind.startsWith(`${ID}:`)) continue;
    const by = (/^pen:/.test(kind) ? FROM_PENS : /^portal(:|$)/.test(kind) ? FROM_PORTAL : FROM_BUILDS) - CLEARANCE;
    for (const b of boxes) if (b && typeof b.x === 'number' && typeof b.z === 'number') out.push(pad(b, by));
  }
  for (const r of [...reserved, ...builds]) out.push(pad(r, FROM_BUILDS - CLEARANCE));
  return out;
}

/** Where the hall goes, pure: an 11 x 9 patch of plain yard ground either way round, off `avoid`, nearest home. */
export function hallSite(grid: Grid, avoid: Rect[], home: { x: number; z: number }): Site | null {
  return findSite(grid, HALL_SIZE.width, HALL_SIZE.length, { near: home, clearance: CLEARANCE, avoidRect: avoid });
}

/**
 * The site: hallSite over the yard as it stands, kept in the milestone's data (`site`, reserved as every milestone's
 * is: structure-site and the improvement runs keep off it from now on). No room: the yard grows for it as a site step
 * grows it (growStep: a strip on its cheapest dry side, the fence moved out, the band outside it cleared), at most
 * HALL_GROWS times; after that it waits and says why, rather than grow the yard again and again for a room that the
 * pens or the builds by the new edge still keep out.
 */
export const hallSiteStep: Step = {
  name: 'find room for the hall',
  run: async (ctx, st) => {
    if (st.data.site) return ok('site chosen');
    const yard = await yardOf(ctx);
    const box = { x: yard.x1, y: yard.y - 1, z: yard.z1, width: yard.x2 - yard.x1 + 1, height: 7, length: yard.z2 - yard.z1 + 1 };
    const grid = occupancy(box, await readBox(ctx, box), yard.y);
    const site = hallSite(grid, hallAvoid(ctx.world.zones, reservedSites(progressOf(ctx.world)), ctx.builds?.() ?? []), ctx.s.home!);
    if (site) {
      st.data.site = { ...site, y: yard.y };
      return ok(`the hall goes at (${site.x}, ${yard.y}, ${site.z}), ${site.width} x ${site.length}`);
    }
    const why = `${HALL_SIZE.width} x ${HALL_SIZE.length} on plain ground, ${FROM_PENS} from the pens, ${FROM_PORTAL} from the portal, ${FROM_BUILDS} from every other build`;
    const grown = typeof st.data.grown === 'number' ? st.data.grown : 0;
    if (grown >= HALL_GROWS) return blocked(`no room in the yard for the hall (${why}), and it has grown ${grown} times for it already`, 60 * MINUTE);
    const r = await growStep(ctx, yard, HALL_SIZE, 'hall');
    if (r.status === 'progress' && /^grew the yard/.test(r.text)) st.data.grown = grown + 1;
    return r;
  }
};

// ------------------------------------------------------------------------------------------------ the sides

const centreOf = (site: { x: number; z: number; width: number; length: number }) => ({ x: site.x + site.width / 2, z: site.z + site.length / 2 });

/** The side of a site that faces a point: the axis it is further off along, scaled to the site's half sizes. */
export function sideToward(site: { x: number; z: number; width: number; length: number }, p: { x: number; z: number }): Side {
  const c = centreOf(site);
  const dx = (p.x + 0.5 - c.x) / site.width, dz = (p.z + 0.5 - c.z) / site.length;
  return Math.abs(dx) > Math.abs(dz) ? (dx < 0 ? 'west' : 'east') : (dz < 0 ? 'north' : 'south');
}

/**
 * The panel's side: toward the yard's gate nearest the hall (the move comes in through it, P5c), else toward home. The
 * hall's own gate faces home, as every building's door does.
 */
export function panelToward(site: { x: number; z: number; width: number; length: number }, world: WorldMemory, home: { x: number; z: number }): Side {
  const c = centreOf(site);
  const gate = [...(world.zones?.['fence:gate'] ?? [])].sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z))[0];
  return sideToward(site, gate ?? home);
}

/** The hall of a milestone's data: its sides and its bed as the build step chose them. */
const planOf = (st: MilestoneState) => {
  const site = st.data.site as HallSite | undefined;
  return hall({ gateSide: st.data.gate as Side | undefined, panelSide: st.data.panel as Side | undefined, turned: !!site && site.width < site.length, bed: st.data.bed as string | undefined });
};

// ------------------------------------------------------------------------------------------------ the beds and the glass

/** How the hall gets its three beds, pure: the bed and the string it makes wool of, or what it waits for, or is short of. */
export type BedPlan = { bed: string; string: number } | { wait: string } | { short: Record<string, number>; text: string };

/**
 * The beds, from what there is (carried and in the chests, by name): three of a colour already; else a colour whose
 * beds and wool make three (the sheep pen's shears bring in whatever its flock wears); else, while the sheep pen has
 * sheep (`sheep`), its wool is waited for; else white, the wool made of string, four a wool, leaving the leads' share
 * (STRING_KEEP). The string short of that is the shortfall. `beds`: how many (the hall's three; the chores' more for
 * the breeding, hallchores.ts).
 */
export function bedPlan(have: Record<string, number>, sheep: boolean, beds = HALL_BEDS): BedPlan {
  const n = (item: string) => Math.max(0, have[item] ?? 0);
  const colours = COLOURS.map(c => ({ bed: `${c}_bed`, beds: n(`${c}_bed`), wool: n(`${c}_wool`) }));
  const ready = colours.filter(c => c.beds >= beds).sort((a, b) => b.beds - a.beds)[0];
  if (ready) return { bed: ready.bed, string: 0 };
  const fromWool = colours.filter(c => c.beds + Math.floor(c.wool / WOOL_PER_BED) >= beds).sort((a, b) => b.beds - a.beds || b.wool - a.wool)[0];
  if (fromWool) return { bed: fromWool.bed, string: 0 };
  const white = colours.find(c => c.bed === 'white_bed')!;
  const wool = WOOL_PER_BED * (beds - white.beds) - white.wool;
  if (sheep) return { wait: `the sheep pen's wool (${white.wool} white wool carried and stored, ${wool} more for ${beds} beds)` };
  const string = STRING_PER_WOOL * wool;
  const spare = n('string') - STRING_KEEP;
  if (spare >= string) return { bed: 'white_bed', string };
  const short = string - Math.max(0, spare);
  return { short: { string: short }, text: `the beds' wool: ${wool} white wool to make of ${string} string, ${n('string')} there and ${STRING_KEEP} kept for the leads` };
}

/** Carried (main pockets) and in the chests, but what a build job holds there: what the hall can use. */
async function haveNow(ctx: GoalContext): Promise<Record<string, number>> {
  const out = { ...freeChestTotals(ctx.world) };
  for (const i of (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items) if (i.slot < 36) out[i.name] = (out[i.name] ?? 0) + i.count;
  return out;
}

/** The sheep pen holds sheep, as its round last saw it (an empty pen, or none, has no wool to wait for). */
const sheepPenStocked = (world: WorldMemory) => !!world.zones?.['pen:sheep']?.length && (penCount(world, 'sheep')?.adults ?? 0) > 0;

/** The three beds in hand (carried or in the chests): undefined when they are, else why not. */
async function bedsFor(ctx: GoalContext, st: MilestoneState): Promise<StepResult | undefined> {
  const waits = typeof st.data.woolWaits === 'number' ? st.data.woolWaits : 0;
  const plan = bedPlan(await haveNow(ctx), sheepPenStocked(ctx.world) && waits < WOOL_WAITS);
  if ('wait' in plan) {
    st.data.woolWaits = waits + 1;
    return blocked(`waiting for ${plan.wait}: wait ${waits + 1} of ${WOOL_WAITS}, then string`, WOOL_WAIT_MS);
  }
  if ('short' in plan) return shortOf(`${plan.text}: short of ${list(plan.short)}`, plan.short);
  // (the beds from the chests, crafted from the wool there, the wool from string first where it is short: prepare,
  // which leaves the leads' string whatever this plan said)
  const short = await prepare(ctx, plan.bed, HALL_BEDS);
  if (Object.keys(short).length) return shortOf(`${HALL_BEDS} ${plan.bed}: short of ${list(short)}`, short);
  st.data.bed = plan.bed;
  if (plan.string) ctx.progress(`the hall's beds: ${plan.string / STRING_PER_WOOL} white wool made of ${plan.string} string`);
  return undefined;
}

/**
 * The windows' glass in hand, `want` of it carried and in the chests: smelted from the chests' sand at the furnace
 * (prepare); undefined when it is. Short, it names the sand still to fetch, a glass a sand: prepare smelts the sand
 * there is and names the glass still to come, and no stock row fetches glass (with the live 3 sand, Nov 15, it said
 * "short of 1 glass" and nobody went). Sand there and none of it smelted (the furnace busy with ore, the smelt refused)
 * is no trip's: it says so and waits. `glass`: how much is still to be smelted, whatever holds it up (together).
 */
async function glassFor(ctx: GoalContext, want = HALL_GLASS): Promise<(StepResult & { glass?: number }) | undefined> {
  const had = (await haveNow(ctx)).glass ?? 0;
  if (!want || had >= want) return undefined;
  const short = await prepare(ctx, 'glass', want);
  if (!Object.keys(short).length) return undefined;
  // (none smelted when it came back short of the sand or the coal)
  const glass = short.glass ?? want - had;
  if (short.glass) {
    const sand = Math.max(0, short.glass - ((await haveNow(ctx)).sand ?? 0));
    delete short.glass;
    if (sand) short.sand = (short.sand ?? 0) + sand;
    else if (!Object.keys(short).length) return { ...blocked('the windows\' glass: the furnace smelted none of the sand there (busy with something else?)', 10 * MINUTE), glass };
  }
  return { ...shortOf(`the windows' glass: short of ${list(short)}`, short), glass };
}

/**
 * What is still short, as one result: the parts' shortfalls together, written where the stock trips read them
 * (progress.need, as prepareBill and the build step write it; a step's own `need` only times its wait). Not written,
 * nothing ever went for the windows' sand: the hall waited at its glass for good. The glass still to smelt is written
 * there too (no stock row fetches it), not in the step's `need`, so the wait still ends when the sand is in: it is
 * the hall's turn at the furnace between two ore batches (project.ts atFurnace). Only sand or nothing named there,
 * the hall's 4 glass waited behind every batch of ore.
 */
function together(ctx: GoalContext, left: (StepResult & { glass?: number })[]): StepResult {
  const need: Record<string, number> = {};
  for (const r of left) if (r.status === 'blocked') for (const [k, v] of Object.entries(r.need ?? {})) need[k] = (need[k] ?? 0) + v;
  const glass = left.reduce((a, r) => a + (r.glass ?? 0), 0);
  const written = glass ? { ...need, glass } : need;
  progressOf(ctx.world).need = Object.keys(written).length ? written : undefined;
  const text = left.map(r => r.text).join('; ');
  const retryMs = Math.max(...left.map(r => (r.status === 'blocked' ? r.retryMs ?? 0 : 0)));
  return Object.keys(need).length ? { status: 'blocked', text, retryMs, need } : blocked(text, retryMs || 10 * MINUTE);
}

/**
 * The beds and the glass, before the build: the build step makes what its bill names from RECIPES, but neither of
 * these. Its bill check counts the beds' wool as string with no share kept, and glass as nothing to gather at all:
 * "short of 4 glass" for good, with nobody sent for sand. Both looked to in every run, whichever holds the other up;
 * once both are in hand they stay carried for the build (progress.carry, as the build step keeps its bill's).
 */
export const makingsStep: Step = {
  name: 'the beds and the windows\' glass',
  run: async (ctx, st) => {
    const beds = await bedsFor(ctx, st);
    if (ctx.signal.aborted) return going('stopped while making the beds');
    const glass = await glassFor(ctx);
    const left = [beds, glass].filter((r): r is StepResult => !!r);
    if (!left.length) {
      progressOf(ctx.world).carry = [st.data.bed as string, 'glass'];
      return ok(`${HALL_BEDS} ${st.data.bed as string} and ${HALL_GLASS} glass for the hall`);
    }
    return together(ctx, left);
  }
};

// ------------------------------------------------------------------------------------------------ done

/** The hall's own ground: its zone once built, and the site it keeps meanwhile (in hand, or set aside midway). */
function ownGround(world: WorldMemory): KeptSite[] {
  const p = world.progress;
  const kept = [p?.current?.id === ID ? p.current.data?.site : undefined, p?.aside?.[ID]?.data?.site] as unknown[];
  const sites = kept.filter((b): b is KeptSite => !!b && typeof b === 'object' && typeof (b as KeptSite).x === 'number' && typeof (b as KeptSite).z === 'number');
  return [...sites, ...(world.zones?.[ID] ?? [])];
}

/**
 * A villager hall standing in the yard as the last look round home saw it (findLandmarks): a fletching table, and three
 * beds round it (within a 9 x 7 room's reach, on its floor), neither on the hall's own ground. The improvement runs may
 * put one up first (improve-prompt.md says not to build it twice), and that one does. This milestone's own, half built,
 * does not: the build places the beds and the table before the roof, and the look every 10 minutes would end it there.
 */
export function hallStanding(world: WorldMemory): boolean {
  const { fletching, beds } = world.landmarks;
  const yard = world.yard;
  if (!fletching || !beds?.length || !yard || !inYard(fletching, yard)) return false;
  const own = ownGround(world);
  if (own.some(b => inside(fletching, b))) return false;
  const round = beds.filter(b => inYard(b, yard) && !own.some(o => inside(b, o)) &&
    Math.abs(b.x - fletching.x) <= ROOM_REACH && Math.abs(b.z - fletching.z) <= ROOM_REACH && Math.abs(b.y - fletching.y) <= 1);
  return round.length >= HALL_BEDS;
}

/**
 * The bot's own bed among those the look round home found: the nearest home, as before, unless that is one of the
 * hall's (the villagers', on the hall's ground), then the nearest that is not. A villager asleep in it would keep the
 * bot out of it all night, and a bed it slept in would no longer be free for them.
 */
export function homeBed(l: Landmarks, world: WorldMemory): Pos | undefined {
  const own = ownGround(world);
  const ofHall = (p: Pos) => own.some(b => inside(p, b));
  if (!l.bed || !ofHall(l.bed)) return l.bed;
  return (l.beds ?? []).find(p => !ofHall(p));
}

// ------------------------------------------------------------------------------------------------ the milestone

/**
 * The villager hall, after the workshop (the nether portal is no prereq: the villagers do not need it). Done once the
 * world shows it: its zone (the build step puts it down as the build completes, the last step), or a hall standing in
 * the yard already (hallStanding). Its zones: `hall`, and `hall:bed`, `hall:bed-foot`, `hall:lectern`, `hall:fletching`,
 * `hall:gate`, `hall:panel`, `hall:inside`, `hall:torch` (the blueprint's landmarks, where the build put them).
 */
export function hallMilestone(prereqs: string[]): Milestone {
  const build = buildStep(ID, planOf, 'villager hall');
  return {
    id: ID,
    title: 'a villager hall',
    prereqs,
    done: v => !!v.world.zones?.[ID]?.length || hallStanding(v.world),
    steps: [
      hallSiteStep,
      makingsStep,
      {
        ...build,
        run: async (ctx, st) => {
          const site = st.data.site as HallSite | undefined;
          if (site) {
            st.data.gate ??= sideToward(site, ctx.s.home!);
            st.data.panel ??= panelToward(site, ctx.world, ctx.s.home!);
          }
          // (the bed's colour is the makings step's choice; a bed gone since, a death's, is the build's bill to make
          // again, from what is there: prepare leaves the leads' string all the same. Not the beds counted again here:
          // those the build has placed are no longer carried, and three more would be made of string)
          if (!st.data.bed) {
            const beds = await bedsFor(ctx, st);
            if (beds) return beds;
          }
          const r = await build.run(ctx, st);
          // glass gone since the makings step (a trip's stash puts what is carried in the chests, where a build job's
          // panes are made of it): the build's bill check counts it short for good, glass having no recipe and no
          // stock row. Smelted again, as much as the build says it lacks: not the four counted again, as those it has
          // placed are no longer carried
          const lost = r.status === 'blocked' ? r.need?.glass ?? 0 : 0;
          if (r.status !== 'blocked' || !lost) return r;
          const glass = await glassFor(ctx, ((await haveNow(ctx)).glass ?? 0) + lost) ?? going(`smelted ${lost} glass again for the hall's windows`);
          const rest = Object.fromEntries(Object.entries(r.need ?? {}).filter(([k]) => k !== 'glass'));
          if (!Object.keys(rest).length && glass.status !== 'blocked') return glass;
          return together(ctx, [...(Object.keys(rest).length ? [{ ...r, need: rest }] : []), glass]);
        }
      }
    ]
  };
}
