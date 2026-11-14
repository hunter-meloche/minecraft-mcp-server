import type { GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { haveFn, progressOf, reservedSites, type KeptSite, type Milestone, type MilestoneState, type Step, type StepResult } from './progress.js';
import { buildStep, readBox, yardOf } from './milestones.js';
import { findSite, occupancy, type Grid, type Rect } from './site.js';
import { portal } from './blueprints.js';
import { layoutSpec } from '../schematic.js';
import { prepare } from './project.js';
import { obsidianStep } from './cast.js';
import { key, spareHeld, storedStacks, storeStackAt, takeFromChests, type SparePiece } from './chests.js';
import { bookChests } from './enchant.js';
import { carriedKit, gearKind, type GearKind } from './kit.js';
import { holdHarmless } from './fluidpick.js';
import type { InventoryItem } from '../tools.js';

/**
 * A nether portal at home (P2a of the progression plan): 20 obsidian (10 for the frame here, 10 for the bot's own
 * Nether-side portal in P2b), two flint and steel, a spare plain diamond set and a golden helmet put by for the trips,
 * a site well away from the pens, the frame, and last the lighting, which waits for the nether-trips switch: with it
 * off (as it ships) the frame stands unlit and nothing goes through. Everything that crosses over is nether.ts's.
 */

const MINUTE = 60_000;
const ID = 'nether-portal';
/** The zone the frame's build puts down (and `portal:frame`, the inside's lowest corner; `portal:lit`, once lit). */
export const ZONE = 'portal';
/** Obsidian gathered: 10 for the frame at home, 10 for the bot's own portal on the Nether side (P2b). */
export const PORTAL_OBSIDIAN = 20;
/** A cast's lava buckets don't stack: the obsidian comes a run's batch at a time (the enchanting room's whole 4). */
export const OBSIDIAN_BATCH = 4;
/** One to light the frame here, one for the Nether-side portal. */
export const FLINT_AND_STEEL = 2;
/** The portal's footprint (the plinth's 6 along the frame, a row each side of it to step out onto). */
export const FOOTPRINT = { width: 6, length: 3 };
/**
 * Blocks from the pens' rings to the portal's footprint at least: zombified piglins come out of a lit portal now and
 * then and wander, and kept off the herd, nothing fights one among the cows and sheep (a swing's sweep hits them)
 */
export const FROM_PENS = 16;
/** Blocks from every other build and zone of the yard (the fence apart: it rings them all). */
export const FROM_BUILDS = 8;
/** findSite's own clearance round the footprint (nothing built, farmed or wet within it). */
const CLEARANCE = 2;
/** Plain cobblestone carried for the frame's build: its plinth and corners are 10, and a few over. */
const FRAME_COBBLESTONE = 16;
/** The light step's line with the switch off, as the lead watches for it. */
export const LIGHT_OFF = 'light the portal blocked (nether trips are off)';

/** The spare set: a plain piece of each, crafted from diamonds (and sticks): 29 diamonds in all. */
export const SPARE_SET: readonly { name: string; diamonds: number; sticks: number }[] = [
  { name: 'diamond_helmet', diamonds: 5, sticks: 0 }, { name: 'diamond_chestplate', diamonds: 8, sticks: 0 },
  { name: 'diamond_leggings', diamonds: 7, sticks: 0 }, { name: 'diamond_boots', diamonds: 4, sticks: 0 },
  { name: 'diamond_pickaxe', diamonds: 3, sticks: 2 }, { name: 'diamond_sword', diamonds: 2, sticks: 1 }
];
const ARMOUR = new Set<GearKind>(['helmet', 'chestplate', 'leggings', 'boots']);

const ok = (text: string): StepResult => ({ status: 'done', text });
const going = (text: string): StepResult => ({ status: 'progress', text });
const blocked = (text: string, retryMs = 10 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });
/** Short of materials: the project waits longer each time the step comes back so (project.ts backoffMs). */
const shortOf = (text: string, need: Record<string, number>): StepResult => ({ status: 'blocked', text, retryMs: 3 * MINUTE, need });
const list = (short: Record<string, number>) => Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ');
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;

/** The nether-trips switch: anything that goes through waits for it to be on (nether.ts turns it, the lead says when). */
export const tripsOn = (world: WorldMemory): boolean => world.nether?.trips === true;

type Axis = 'x' | 'z';
type PortalSite = { x: number; y: number; z: number; width: number; length: number; rotated: boolean };

const inYard = (p: { x: number; z: number }, y: NonNullable<WorldMemory['yard']>) => p.x >= y.x1 && p.x <= y.x2 && p.z >= y.z1 && p.z <= y.z2;

// ------------------------------------------------------------------------------------------------ its own portal

/**
 * The home portal: the one the light step lit (`portal:lit`, the inside's lowest corner), else a lit portal standing
 * in the yard as the last look round home saw it (findLandmarks: the improvement run's, or a player's), which counts
 * as the bot's own.
 */
export function homePortal(world: WorldMemory): Pos | undefined {
  const lit = world.zones?.[`${ZONE}:lit`]?.[0];
  if (lit) return { x: lit.x, y: lit.y, z: lit.z };
  return portalStanding(world) ? { ...world.landmarks.portal! } : undefined;
}

/**
 * The portals the brain tells the bridge are its own (portal.own's list, which nothing then counts as someone else's
 * build): the home portal here. The Nether-side one (P2b) is nether.ts's to add; the protection sync sends the list
 * whenever the bridge's status says it has none (a client restart).
 */
export function ownPortals(world: WorldMemory): { dimension: string; x: number; y: number; z: number }[] {
  const home = homePortal(world);
  return home ? [{ dimension: 'overworld', ...home }] : [];
}

// ------------------------------------------------------------------------------------------------ the site

/** The axis of a site's frame: along its 6 (x for a site 6 wide, z for one 6 long). */
export const axisOf = (site: { width: number; length: number }): Axis => (site.width >= site.length ? 'x' : 'z');

/**
 * Whether a site's frame faces home: home lies across its plane (the way the bot steps out of it) more than along it,
 * so the bot that comes back through it steps out toward home.
 */
export function facesHome(site: Rect, home: { x: number; z: number }): boolean {
  const cx = site.x + site.width / 2, cz = site.z + site.length / 2;
  const across = axisOf(site) === 'x' ? Math.abs(home.z - cz) : Math.abs(home.x - cx);
  const along = axisOf(site) === 'x' ? Math.abs(home.x - cx) : Math.abs(home.z - cz);
  return across >= along;
}

/**
 * The rectangles a portal site keeps off, padded so that findSite's own clearance round the site plus the padding is
 * the distance asked: every zone of the yard (but the fence's ring, its gates and torches, and the portal's own), the
 * pens' rings FROM_PENS off (their gates and torches with them), the rest FROM_BUILDS; points as a block each. And
 * the sites other milestones keep for themselves, and the boxes of the structures placed (`builds`: the improvement
 * runs' cottage, lookout, lamp walk... keep no zone), FROM_BUILDS off. A box counts whole: the lamp walk's (posts and a
 * path, the storage house inside it) as much as a cottage's, which puts the live site north of the pens, not by the
 * lookout.
 */
export function portalAvoid(zones: WorldMemory['zones'], reserved: KeptSite[], builds: Rect[] = []): Rect[] {
  const pad = (b: { x: number; z: number; width?: number; length?: number }, by: number): Rect =>
    ({ x: b.x - by, z: b.z - by, width: (b.width ?? 1) + 2 * by, length: (b.length ?? 1) + 2 * by });
  const out: Rect[] = [];
  for (const [kind, boxes] of Object.entries(zones ?? {})) {
    if (kind === 'fence' || kind.startsWith('fence:') || kind === ZONE || kind.startsWith(`${ZONE}:`)) continue;
    const by = (/^pen:/.test(kind) ? FROM_PENS : FROM_BUILDS) - CLEARANCE;
    for (const b of boxes) if (b && typeof b.x === 'number' && typeof b.z === 'number') out.push(pad(b, by));
  }
  for (const r of [...reserved, ...builds]) out.push(pad(r, FROM_BUILDS - CLEARANCE));
  return out;
}

/**
 * Where the portal goes, pure: a FOOTPRINT patch of plain yard ground (findSite: 2 clear of anything built, farmed or
 * wet), off the rectangles of portalAvoid, nearest home; of the two ways round, one whose plane faces home first
 * (facesHome), else the nearer. Its axis is along the footprint's 6.
 */
export function portalSite(grid: Grid, avoid: Rect[], home: { x: number; z: number }): (Rect & { rotated: boolean; axis: Axis }) | null {
  const near = (r: Rect) => Math.hypot(r.x + r.width / 2 - home.x, r.z + r.length / 2 - home.z);
  const ways = [[FOOTPRINT.width, FOOTPRINT.length, false], [FOOTPRINT.length, FOOTPRINT.width, true]] as const;
  const found = ways.map(([w, l, rotated]) => {
    const s = findSite(grid, w, l, { near: home, clearance: CLEARANCE, avoidRect: avoid, turn: false });
    return s ? { x: s.x, z: s.z, width: s.width, length: s.length, rotated, axis: axisOf(s) } : null;
  }).filter((s): s is Rect & { rotated: boolean; axis: Axis } => !!s);
  const facing = found.filter(s => facesHome(s, home));
  return [...(facing.length ? facing : found)].sort((a, b) => near(a) - near(b))[0] ?? null;
}

/**
 * The site: portalSite over the yard as it stands, kept in the milestone's data (`site`, reserved as every milestone's
 * is, and `axis`). No room: it waits and says why; the yard is not grown for it (a growth picks its side by the
 * levelling it costs, and knows nothing of the pens).
 */
export const siteForPortal: Step = {
  name: 'find room for the portal',
  run: async (ctx, st) => {
    if (st.data.site) return ok('site chosen');
    const yard = await yardOf(ctx);
    const box = { x: yard.x1, y: yard.y - 1, z: yard.z1, width: yard.x2 - yard.x1 + 1, height: 7, length: yard.z2 - yard.z1 + 1 };
    const grid = occupancy(box, await readBox(ctx, box), yard.y);
    const site = portalSite(grid, portalAvoid(ctx.world.zones, reservedSites(progressOf(ctx.world)), ctx.builds?.() ?? []), ctx.s.home!);
    if (!site) {
      return blocked(`no room in the yard for the portal (${FOOTPRINT.width} x ${FOOTPRINT.length} on plain ground, ${FROM_PENS} from the pens, ` +
        `${FROM_BUILDS} from every other build)`, 60 * MINUTE);
    }
    st.data.site = { x: site.x, z: site.z, width: site.width, length: site.length, rotated: site.rotated, y: yard.y };
    st.data.axis = site.axis;
    return ok(`the portal goes at (${site.x}, ${yard.y}, ${site.z}), its plane along ${site.axis} facing home`);
  }
};

// ------------------------------------------------------------------------------------------------ the frame

/** The frame of a milestone's data: its axis as the site step chose it. */
const planOf = (st: MilestoneState) => portal({ axis: (st.data.axis as Axis | undefined) ?? 'x' });

/** The inside's lowest corner in the world: the build's landmark, else worked out from the site (groundOffset 0). */
export function frameCell(world: WorldMemory, st: MilestoneState): Pos | undefined {
  const z = world.zones?.[`${ZONE}:frame`]?.[0];
  if (z) return { x: z.x, y: z.y, z: z.z };
  const site = st.data.site as PortalSite | undefined;
  const l = planOf(st).landmarks.find(m => m.kind === 'frame');
  return site && l ? { x: site.x + l.at.x, y: site.y + l.at.y, z: site.z + l.at.z } : undefined;
}

/**
 * What keeps the frame from lighting, as the world stands (a region read over the blueprint at the site): obsidian
 * missing from it, something in its inside but air (a lit portal there is no fault). Undefined when it is whole. The
 * corners are left out: a portal lights without them.
 */
async function frameFault(ctx: GoalContext, st: MilestoneState): Promise<string | undefined> {
  const site = st.data.site as PortalSite | undefined;
  if (!site) return 'no site chosen';
  const bp = planOf(st);
  const { width, height, length } = layoutSpec(bp.spec);
  const blocks = await readBox(ctx, { x: site.x, y: site.y, z: site.z, width, height, length });
  const missing: Pos[] = [], inWay: string[] = [];
  bp.spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => {
    const p = { x: site.x + x, y: site.y + y, z: site.z + z };
    const b = (blocks[x + z * width + y * width * length] ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
    if (ch === 'O' && b !== 'obsidian') missing.push(p);
    if (ch === '.' && !/^(air|cave_air|nether_portal)$/.test(b)) inWay.push(`${b || 'unloaded'} at ${fmt(p)}`);
  })));
  const why = [
    missing.length ? `${missing.length} obsidian missing (${missing.slice(0, 3).map(fmt).join(', ')})` : '',
    inWay.length ? `in the way: ${inWay.slice(0, 3).join(', ')}` : ''
  ].filter(Boolean);
  return why.length ? why.join('; ') : undefined;
}

/**
 * buildStep's own frame build, made at its first use, not as this module loads: the work queue's modules reach this
 * one (the nether rung, nether.ts), and they load while milestones.ts is still loading (a call into it then fails:
 * `__name is not a function`). Nothing else here calls into another module as it loads.
 */
let frameMade: Step | undefined;
const frameBuild = (): Step => (frameMade ??= buildStep(ZONE, planOf, 'portal frame'));

/**
 * The frame's build (buildStep: the plinth, the corners and 10 obsidian, the zone `portal` and its landmark
 * `portal:frame`), with plain cobblestone carried first. The bill counts deepslate as cobblestone (progress.ts GROUPS:
 * any of them does for a recipe), and build-structure places only what the spec names: with deepslate carried the
 * build would come back "not enough blocks" as progress, and be run again at once.
 */
export const buildFrameStep: Step = {
  // (buildStep's name for it, and its bill)
  name: 'build the portal frame',
  bill: view => frameBuild().bill?.(view) ?? {},
  run: async (ctx, st) => {
    const plain = await carriedCount(ctx, 'cobblestone');
    if (plain < FRAME_COBBLESTONE) {
      const got = plain + await takeFromChests(ctx, 'cobblestone', FRAME_COBBLESTONE - plain);
      if (got < 10) return blocked(`the portal frame: ${got} plain cobblestone carried and none more in the chests (it needs 10; deepslate won't do)`);
    }
    return frameBuild().run(ctx, st);
  }
};

/** Where the bot stands to light it: on the ground a step out of the frame's plane toward home, before the inside. */
export function lightingSpot(st: MilestoneState, frame: Pos, home: { x: number; z: number }): Pos {
  const site = st.data.site as PortalSite;
  const axis = (st.data.axis as Axis | undefined) ?? 'x';
  if (axis === 'x') return { x: frame.x, y: site.y + 1, z: home.z > frame.z ? frame.z + 1 : frame.z - 1 };
  return { x: home.x > frame.x ? frame.x + 1 : frame.x - 1, y: site.y + 1, z: frame.z };
}

type Listed = { x: number; y: number; z: number; axis: string; width: number; height: number; blocks: number; own?: boolean };

/** The lit portal in the frame (its lowest corner at the frame's inside), as the bridge's portal.list sees it. */
async function litAt(ctx: GoalContext, frame: Pos): Promise<Listed | undefined> {
  const r = await ctx.call<{ portals?: Listed[] }>('portal.list', { range: 96 }).catch(() => ({ portals: [] as Listed[] }));
  return (r.portals ?? []).find(p => p.x === frame.x && p.y === frame.y && p.z === frame.z);
}

const carriedCount = async (ctx: GoalContext, item: string) =>
  (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items
    .filter(i => i.slot < 36 && i.name === item).reduce((a, i) => a + i.count, 0);

/**
 * Light the frame: only with nether trips on (the switch; off, it says so and waits half an hour, and the project
 * stops nothing for it: `waits`). Then the frame looked over (whole, its inside clear), a flint and steel carried, the
 * walk on foot to the spot a step out of the plane toward home (A11), and the flint and steel used on the inside's
 * bottom obsidian, its top face, through use-item-on-block (the bridge arms that one use: F1's guard refuses any
 * other). Lit when portal.list shows a portal in the frame; registered with the bridge as its own (portal.own) and
 * remembered (`portal:lit`). A frame that does not light says why, and waits.
 */
export const lightStep: Step = {
  name: 'light the portal',
  waits: v => (tripsOn(v.world) ? undefined : 'nether trips are off'),
  run: async (ctx, st) => {
    if (!tripsOn(ctx.world)) {
      ctx.progress(LIGHT_OFF);
      return blocked('nether trips are off', 30 * MINUTE);
    }
    const frame = frameCell(ctx.world, st);
    if (!frame || !st.data.site) return blocked('no frame built', MINUTE);
    // lit already (a player, or a run stopped after the click): registered as it is
    let lit = await litAt(ctx, frame);
    if (!lit) {
      const fault = await frameFault(ctx, st);
      if (fault) return blocked(`the frame at ${fmt(frame)} would not light: ${fault}`, 30 * MINUTE);
      if (!(await carriedCount(ctx, 'flint_and_steel'))) {
        const short = await prepare(ctx, 'flint_and_steel', 1);
        await holdHarmless(ctx);
        if (Object.keys(short).length) return shortOf(`no flint and steel to light the portal: short of ${list(short)}`, short);
      }
      // the walk with a harmless hand (a fire starter's right click at a door on the way would be a fire)
      await holdHarmless(ctx);
      const spot = lightingSpot(st, frame, ctx.s.home!);
      const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...spot, range: 0, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
      if (walk?.arrived === false) return blocked(`no way on foot to the portal's frame at ${fmt(frame)}`);
      const r = await ctx.act('use-item-on-block', { x: frame.x, y: frame.y - 1, z: frame.z, item: 'flint_and_steel', face: 'up' });
      await holdHarmless(ctx);
      lit = await litAt(ctx, frame);
      if (!lit) return blocked(`the frame at ${fmt(frame)} did not light: ${r.text.replace(/\s+/g, ' ').slice(0, 140)}`, 30 * MINUTE);
    }
    const own = await ctx.call('portal.own', { dimension: 'overworld', ...frame }).then(() => true, () => false);
    (ctx.world.zones ??= {})[`${ZONE}:lit`] = [{ ...frame }];
    return ok(`the portal is lit at ${fmt(frame)} (${lit.width} x ${lit.height}, along ${lit.axis})${own ? ', its own' : ''}`);
  }
};

// ------------------------------------------------------------------------------------------------ the kit for trips

/**
 * Two flint and steel, carried or in the chests (prepare: from the chests, else crafted from an iron ingot and a flint
 * the chests hold), the hand off them after.
 */
export const flintStep: Step = {
  name: `craft ${FLINT_AND_STEEL} flint and steel`,
  run: async ctx => {
    const have = haveFn(ctx.s, ctx.world)('flint_and_steel');
    if (have >= FLINT_AND_STEEL) return ok(`${have} flint and steel`);
    const short = await prepare(ctx, 'flint_and_steel', FLINT_AND_STEEL);
    await holdHarmless(ctx);
    if (Object.keys(short).length) return shortOf(`flint and steel: short of ${list(short)}`, short);
    return ok(`${FLINT_AND_STEEL} flint and steel`);
  }
};

/**
 * A golden helmet for the trips (piglins leave a player wearing gold alone; the Guardian wears it in the Nether): one
 * carried or in the chests, else crafted from five gold ingots (smelted from the raw gold). It goes in the chests
 * between trips, as any spare gear does; the Nether trips' kit takes it.
 */
export const goldenHelmetStep: Step = {
  name: 'a golden helmet',
  run: async ctx => {
    if (haveFn(ctx.s, ctx.world)('golden_helmet') >= 1) return ok('a golden helmet for the Nether');
    const short = await prepare(ctx, 'golden_helmet', 1);
    if (Object.keys(short).length) return shortOf(`a golden helmet: short of ${list(short)}`, short);
    return ok('crafted a golden helmet for the Nether');
  }
};

/**
 * A piece fit for the spare set: plain (no enchantments) and unused. The regear after a death wants whole gear: a
 * spare pickaxe at 5% beside the enchanted one, or old boots the Guardian took off, is no spare (no wear said, an
 * older jar's, counts as new).
 */
const spareFit = (i: { name: string; enchanted?: boolean; enchantments?: unknown[]; damage?: number }, name: string) =>
  i.name === name && !i.enchanted && !i.enchantments?.length && (i.damage ?? 0) === 0;

/**
 * The carried piece of a spare-set kind that can go into the chest as the spare one: fit (spareFit: plain, unused),
 * in the pockets (not worn), and not the kit's best tool of its kind (a tool in use: its sword, its pickaxe).
 */
export function spareCandidate(items: InventoryItem[], name: string): InventoryItem | undefined {
  const kind = gearKind(name);
  const best = kind ? carriedKit(items).best[kind] : undefined;
  const inUse = (i: InventoryItem) => !(kind && ARMOUR.has(kind)) && i === best;
  return items.find(i => i.slot >= 0 && i.slot < 36 && spareFit(i, name) && !inUse(i));
}

/**
 * A fit piece already in a home chest as last seen, not the set's yet, by its chest and slot: the one a run cut short
 * between the craft and the store left to the stash (it cut in at 35/36 slots and put the new helmet away as plain
 * gear), to makeRoom or to a timeout. Taken into the set where it lies, so it is never crafted twice.
 */
export function spareStored(world: WorldMemory, name: string): SparePiece | undefined {
  const held = new Set(spareHeld(world).map(p => `${key(p.chest)}|${p.slot}`));
  const found = storedStacks(world, st => spareFit(st, name) && typeof st.slot === 'number')
    .find(({ chest, stack }) => !held.has(`${key(chest)}|${stack.slot}`));
  return found ? { name, chest: { ...found.chest }, slot: found.stack.slot } : undefined;
}

/**
 * The spare set: a plain diamond helmet, chestplate, leggings, boots, pickaxe and sword in a home chest, for the
 * regear after a death in the Nether (P2b). A piece at a time: a plain one carried that the kit is not using
 * (spareCandidate: one a run stopped midway left in the pockets), else one already lying in a home chest (spareStored:
 * the stash put it away; taken into the set where it lies), else crafted from diamonds and sticks, and stored
 * by its pocket slot (storeStackAt) in the gear's chests, where the sort leaves gear alone. Each is remembered by its
 * chest and the chest's slot (`world.spareSet`): reserved there (chests.ts reservedCount) so the kit, the trip kit,
 * the donations and every take by name leave it, and the sort moves none of it. The anvil and the enchant chore work
 * on what is carried and worn only. Never crafted twice: what the chests' memory still shows is the set's.
 */
export const spareSetStep: Step = {
  name: 'the spare diamond set',
  run: async ctx => {
    const missing = () => SPARE_SET.filter(piece => !spareHeld(ctx.world).some(p => p.name === piece.name));
    const kept = () => SPARE_SET.length - missing().length;
    if (!missing().length) return ok(`the spare diamond set is in the chests (${SPARE_SET.length} pieces)`);
    const made: string[] = [];
    for (const piece of missing()) {
      if (ctx.signal.aborted) return going(`${kept()}/${SPARE_SET.length} spare pieces stored`);
      const inv = async () => (await ctx.call<{ items: InventoryItem[] }>('inventory')).items;
      let one = spareCandidate(await inv(), piece.name);
      const lying = one ? undefined : spareStored(ctx.world, piece.name);
      if (lying) {
        ctx.world.spareSet = { pieces: [...spareHeld(ctx.world), lying], at: ctx.s.now };
        made.push(`${piece.name} (slot ${lying.slot}, already in the chest at ${fmt(lying.chest)})`);
        continue;
      }
      if (!one) {
        const short: Record<string, number> = { ...(await prepare(ctx, 'diamond', piece.diamonds)) };
        if (piece.sticks) for (const [k, v] of Object.entries(await prepare(ctx, 'stick', piece.sticks))) short[k] = (short[k] ?? 0) + v;
        if (Object.keys(short).length) return shortOf(`the spare ${piece.name}: short of ${list(short)}`, short);
        const c = await ctx.act('craft-item', { outputItem: piece.name, amount: 1 });
        if (!c.ok) return blocked(`could not craft the spare ${piece.name}: ${c.text.replace(/\s+/g, ' ').slice(0, 120)}`);
        one = spareCandidate(await inv(), piece.name);
        // the new one is the kit's best now (the old one nearly worn out): it keeps it, and the next run makes another
        if (!one) return going(`crafted a ${piece.name}, which the kit uses now; the spare one next`);
      }
      const at = await storeStackAt(ctx, piece.name, one.slot, bookChests(ctx.world), ctx.world.landmarks.chests.length);
      if (!at) return blocked(`the spare ${piece.name}: no home chest took it`);
      if (at.slot === undefined) return blocked(`the spare ${piece.name} went into the chest at ${fmt(at.chest)}, but this jar says no slot: not kept as the spare`);
      const stored: SparePiece = { name: piece.name, chest: { ...at.chest }, slot: at.slot };
      // (what the chests' memory no longer shows is let go: it is made again)
      ctx.world.spareSet = { pieces: [...spareHeld(ctx.world), stored], at: ctx.s.now };
      made.push(`${piece.name} (slot ${at.slot})`);
    }
    const left = missing();
    const line = `stored ${made.join(', ')} as the spare set`;
    return left.length ? going(`${line}; ${left.map(p => p.name).join(', ')} still to come`) : ok(`${line}: all ${SPARE_SET.length} pieces in the chests`);
  }
};

// ------------------------------------------------------------------------------------------------ the milestone

/** A lit portal standing in the yard as the last look round home saw it (findLandmarks): the bot's own, whoever lit it. */
export function portalStanding(world: WorldMemory): boolean {
  const seen = world.landmarks.portal;
  return !!seen && !!world.yard && inYard(seen, world.yard);
}

/**
 * The portal milestone, after the workshop. Done once the world shows it: the frame's zone with a lit portal of its own
 * in it (`portal:lit`), or a lit portal already standing in the yard (portalStanding), which is then its own
 * (homePortal, ownPortals: the bridge counts one in the home zone as its own anyway).
 */
export function netherPortalMilestone(prereqs: string[]): Milestone {
  return {
    id: ID,
    title: 'a nether portal',
    prereqs,
    done: v => (!!v.world.zones?.[ZONE]?.length && !!v.world.zones?.[`${ZONE}:lit`]?.length) || portalStanding(v.world),
    steps: [
      obsidianStep(ID, PORTAL_OBSIDIAN, { name: `gather ${PORTAL_OBSIDIAN} obsidian`, batch: OBSIDIAN_BATCH }),
      flintStep,
      spareSetStep,
      goldenHelmetStep,
      siteForPortal,
      buildFrameStep,
      lightStep
    ]
  };
}
