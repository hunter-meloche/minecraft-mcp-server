import test from 'ava';
import type { StructureSpec } from '../../src/client/schematic.js';
import { billOf, portal } from '../../src/client/brain/blueprints.js';
import { RECIPES, rawShort, recipeFor, type MilestoneState } from '../../src/client/brain/progress.js';
import { TREE } from '../../src/client/brain/tree.js';
import { projectGoal } from '../../src/client/brain/project.js';
import { CAST_TIMING, OBSIDIAN_MILESTONES, obsidianStep, obsidianTargets } from '../../src/client/brain/cast.js';
import { enchantingMilestone, enchantPick } from '../../src/client/brain/enchant.js';
import { castingAhead, stashKeep } from '../../src/client/brain/chores.js';
import { chestTotals, freeChestTotals, key, remember, reservedCount, SPARE, spareHeld, takeFromChests, withoutSpare } from '../../src/client/brain/chests.js';
import { kitNeeds, stashPlan } from '../../src/client/brain/kit.js';
import { misplaced, stackSize } from '../../src/client/brain/storage.js';
import { planFor } from '../../src/client/brain/anvil.js';
import {
  FROM_BUILDS, FROM_PENS, LIGHT_OFF, SPARE_SET, facesHome, homePortal, lightingSpot, netherPortalMilestone, ownPortals, portalAvoid, portalSite, portalStanding,
  ringHoles, ringOf, siteForPortal, spareCandidate, spareSetStep
} from '../../src/client/brain/portal.js';
import { occupancy } from '../../src/client/brain/site.js';
import { findLandmarks, type Pos, type WorldMemory } from '../../src/client/brain/memory.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import type { ChestContents, ChestStack, InventoryItem } from '../../src/client/tools.js';
import { HOME, MINUTE, T0, liveWorld, lookAt } from '../helpers/homestead.js';

Object.assign(CAST_TIMING, { settle: 0, float: 0, floatTries: 3, drain: 0 });

const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const cell = (spec: StructureSpec, p: Pos) => spec.layers[p.y]?.[p.z]?.[p.x] ?? '.';
/** The portal milestone in the tree (the last but the villager hall, P5b). */
const PORTAL = () => TREE.find(m => m.id === 'nether-portal')!;

// ------------------------------------------------------------------------------------------------ the recipes

/** The two recipes as the 26.3 client jar has them (versions/26.3/26.3.jar, data/minecraft/recipe/*.json), as they are. */
const JAR = {
  flint_and_steel: { type: 'minecraft:crafting_shapeless', category: 'equipment', ingredients: ['minecraft:iron_ingot', 'minecraft:flint'], result: { id: 'minecraft:flint_and_steel' } },
  golden_helmet: { type: 'minecraft:crafting_shaped', category: 'equipment', key: { X: 'minecraft:gold_ingot' }, pattern: ['XXX', 'X X'], result: { id: 'minecraft:golden_helmet' } }
};

test('the portal\'s recipes are the 26.3 jar\'s: flint and steel of an ingot and a flint (shapeless), a golden helmet of five gold ingots', (t) => {
  const shapeless = JAR.flint_and_steel;
  const from: Record<string, number> = {};
  for (const id of shapeless.ingredients) from[id.replace(/^minecraft:/, '')] = (from[id.replace(/^minecraft:/, '')] ?? 0) + 1;
  t.deepEqual(RECIPES.flint_and_steel, { makes: 1, from });
  const helmet = JAR.golden_helmet;
  const counted: Record<string, number> = {};
  for (const ch of helmet.pattern.join('')) {
    if (ch === ' ') continue;
    const id = helmet.key[ch as 'X'].replace(/^minecraft:/, '');
    counted[id] = (counted[id] ?? 0) + 1;
  }
  t.deepEqual(RECIPES.golden_helmet, { makes: 1, from: counted });
  for (const item of ['flint_and_steel', 'golden_helmet']) t.deepEqual(recipeFor(item), RECIPES[item], item);
  // two flint and steel from the chests' iron and flint; the helmet's ingots stay ingots (SMELTED makes them from raw gold)
  t.deepEqual(rawShort({ flint_and_steel: 2 }, {}), { iron_ingot: 2, flint: 2 });
  t.deepEqual(rawShort({ golden_helmet: 1 }, {}), { gold_ingot: 5 });
  // the live stores (Nov 14: 134 ingots, 121 flint, 57 gold ingots): nothing to gather
  t.deepEqual(rawShort({ flint_and_steel: 2, golden_helmet: 1 }, { iron_ingot: 134, flint: 121, gold_ingot: 57 }), {});
});

// ------------------------------------------------------------------------------------------------ the blueprint

test('the portal frame: 6 x 6 x 3 on the ground layer, a 6 x 1 cobblestone plinth, 10 obsidian round a 2 x 3 inside left clear, the corners cobblestone', (t) => {
  const bp = portal();
  t.is(bp.name, 'nether-portal');
  t.deepEqual(bp.size, { width: 6, height: 6, length: 3 });
  t.is(bp.groundOffset, 0, 'the plinth is the ground layer itself');
  t.deepEqual(bp.bill, { cobblestone: 10, obsidian: 10 });
  t.deepEqual(billOf(bp.spec), bp.bill);
  // the plinth: the whole row in the ground layer
  for (let x = 0; x < 6; x++) t.is(bp.spec.palette[cell(bp.spec, { x, y: 0, z: 1 })], 'cobblestone', `plinth ${x}`);
  // the standard frame: 2 along the bottom and the top, 3 up each side
  const obsidian: string[] = [];
  bp.spec.layers.forEach((l, y) => l.forEach((row, z) => [...row].forEach((ch, x) => { if (ch === 'O') obsidian.push(`${x},${y},${z}`); })));
  t.deepEqual(obsidian.sort(), ['1,2,1', '1,3,1', '1,4,1', '2,1,1', '2,5,1', '3,1,1', '3,5,1', '4,2,1', '4,3,1', '4,4,1']);
  for (const [x, y] of [[1, 1], [4, 1], [1, 5], [4, 5]]) t.is(bp.spec.palette[cell(bp.spec, { x, y, z: 1 })], 'cobblestone', `corner ${x},${y}`);
  // the inside cleared, 2 wide and 3 high
  for (let y = 2; y <= 4; y++) for (const x of [2, 3]) t.is(cell(bp.spec, { x, y, z: 1 }), '.', `inside ${x},${y}`);
  // the rows either side left as they are: the ground stepped out onto
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) for (const z of [0, 2]) t.is(cell(bp.spec, { x, y, z }), ' ', `${x},${y},${z}`);
  t.deepEqual(bp.landmarks, [{ kind: 'frame', at: { x: 2, y: 2, z: 1 } }]);
});

test('the portal frame along z: turned a quarter, the landmark still the inside\'s lowest corner, the same 10 obsidian', (t) => {
  const bp = portal({ axis: 'z' });
  t.deepEqual(bp.size, { width: 3, height: 6, length: 6 });
  t.deepEqual(bp.bill, { cobblestone: 10, obsidian: 10 });
  t.deepEqual(bp.landmarks, [{ kind: 'frame', at: { x: 1, y: 2, z: 2 } }]);
  for (let y = 2; y <= 4; y++) for (const z of [2, 3]) t.is(cell(bp.spec, { x: 1, y, z }), '.', `inside ${y},${z}`);
  for (const z of [2, 3]) for (const y of [1, 5]) t.is(bp.spec.palette[cell(bp.spec, { x: 1, y, z })], 'obsidian');
  for (const z of [1, 4]) for (const y of [2, 3, 4]) t.is(bp.spec.palette[cell(bp.spec, { x: 1, y, z })], 'obsidian');
  t.throws(() => portal({ axis: 'y' as never }));
});

// ------------------------------------------------------------------------------------------------ the tree

test('the portal milestone comes after the workshop, the last of the tree but the villager hall (P5b) and the brewing and the wart farm (P4), its steps in order', (t) => {
  const m = PORTAL();
  t.is(m.id, 'nether-portal');
  t.is(m.title, 'a nether portal');
  t.deepEqual(m.prereqs, ['workshop']);
  t.is(TREE.findIndex(x => x.id === 'workshop'), TREE.indexOf(m) - 1);
  t.deepEqual(TREE.slice(TREE.indexOf(m) + 1).map(x => x.id), ['hall', 'brewing', 'wart-farm']);
  t.deepEqual(m.steps.map(s => s.name), [
    'gather 20 obsidian', 'craft 2 flint and steel', 'the spare diamond set', 'a golden helmet', 'find room for the portal', 'build the portal frame', 'light the portal'
  ]);
  t.deepEqual(netherPortalMilestone(['workshop']).steps.map(s => s.name), m.steps.map(s => s.name));
});

test('every obsidian step in the tree is on the casting\'s list at its place, and waits for what its milestone waits for', (t) => {
  const inTree = TREE.flatMap(m => m.steps.map((s, i) => ({ m, s, i })).filter(({ s }) => /obsidian$/.test(s.name)).map(({ m, i }) => ({ milestone: m.id, step: i })));
  t.deepEqual(inTree, OBSIDIAN_MILESTONES.map(o => ({ milestone: o.milestone, step: o.step })));
  const portal = OBSIDIAN_MILESTONES.find(o => o.milestone === 'nether-portal')!;
  t.deepEqual(portal.after, TREE.find(m => m.id === 'nether-portal')!.prereqs);
  // one the list does not know is refused where the tree is made
  t.throws(() => obsidianStep('a-castle', 8), { message: /OBSIDIAN_MILESTONES/ });
  // the enchanting room's own step is the shared one, its name as it was
  t.is(enchantingMilestone([]).steps[0].name, 'mine 4 obsidian');
});

// ------------------------------------------------------------------------------------------------ the casting's buckets

/** The live homestead with the workshop done: the enchanting room and the workshop built, nothing in hand. */
function afterWorkshop(): WorldMemory {
  const w = liveWorld();
  const p = w.progress!;
  p.done.push('enchanting', 'workshop');
  p.current = undefined;
  p.blocked = undefined;
  p.need = undefined;
  p.blockedUntil = {};
  p.journal = [];
  w.zones!.enchanting = [{ x: -547, y: 62, z: 2206, width: 7, length: 7 }];
  w.zones!['enchanting:table'] = [{ x: -544, y: 63, z: 2209 }];
  w.zones!.workshop = [{ x: -546, y: 62, z: 2152, width: 7, length: 7 }];
  w.zones!['workshop:anvil'] = [{ x: -543, y: 63, z: 2153 }];
  return w;
}

test('the casting\'s buckets stay carried while the portal\'s obsidian step is ahead (the workshop done), not before nor once past it', (t) => {
  const w = afterWorkshop();
  t.true(castingAhead(w), 'the portal next, its obsidian not gathered');
  w.progress!.current = { id: 'nether-portal', step: 0, data: {} };
  t.true(castingAhead(w), 'at its obsidian step');
  w.progress!.current.step = 1;
  t.false(castingAhead(w), 'past it (the flint and steel)');
  // set aside past it, or back at it
  w.progress!.current = { id: 'fence-clear', step: 0, data: {} };
  w.progress!.aside = { 'nether-portal': { step: 5, data: {} } };
  t.false(castingAhead(w));
  w.progress!.aside = { 'nether-portal': { step: 0, data: {} } };
  t.true(castingAhead(w));
  // the frame built, or the milestone done (a portal found standing in the yard)
  const built = afterWorkshop();
  built.zones!.portal = [{ x: -560, y: 62, z: 2190, width: 3, length: 6 }];
  t.false(castingAhead(built));
  const done = afterWorkshop();
  done.progress!.done.push('nether-portal');
  t.false(castingAhead(done));
  // two milestones off (the workshop not done yet): no buckets kept for it; the casting off: none ever
  const early = afterWorkshop();
  early.progress!.done = early.progress!.done.filter(id => id !== 'workshop');
  t.false(castingAhead(early));
  t.false(castingAhead({ ...afterWorkshop(), lavaCasting: false }));
  // what the stash keeps of it: the lava and water buckets, and 5 empty ones
  const keep = stashKeep(afterWorkshop());
  t.true(['lava_bucket', 'water_bucket', 'bucket'].every(n => keep.keep?.has(n)));
  t.is(keep.cap?.bucket, 5);
  t.false(stashKeep(built).keep?.has('lava_bucket'));
});

// ------------------------------------------------------------------------------------------------ the obsidian step

test('obsidian targets keep off the bot\'s own frame standing unlit, as off a lit portal\'s', (t) => {
  const own = { x: 10, y: 62, z: 0, width: 6, length: 3 };
  const frame = [{ x: 12, y: 63, z: 1 }, { x: 11, y: 64, z: 1 }, { x: 14, y: 67, z: 1 }];
  const wild = [{ x: 0, y: -40, z: -30 }, { x: 40, y: 20, z: 0 }];
  t.deepEqual(obsidianTargets([...frame, ...wild], [], { x: 0, y: 64, z: 0 }, [own]), [wild[1], wild[0]]);
  t.deepEqual(obsidianTargets([...frame, ...wild], [], { x: 0, y: 64, z: 0 }).length, 5, 'without it, the frame is fair game');
});

/** A run's context for the obsidian step: `carried` obsidian, `wild` blocks of it in sight near home, nothing else. */
function obsidianCtx(carried: number, wild: Pos[], stored = 0) {
  const calls: string[] = [];
  let obsidian = carried;
  let inChest = stored;
  const dug = new Set<string>();
  const chest = { x: 3, y: 64, z: 0 };
  const world: WorldMemory = { landmarks: { chests: [chest], farmland: [] }, leash: 96, yard: { x1: -16, z1: -16, x2: 16, z2: 16, y: 63 }, chestItems: { [key(chest)]: stored ? { obsidian: stored } : {} } };
  const items = (): InventoryItem[] => [{ slot: 0, name: 'diamond_pickaxe', count: 1 }, ...(obsidian ? [{ slot: 5, name: 'obsidian', count: obsidian }] : [])];
  const s = lookAt(items(), 1000, { position: { x: 0, y: 64, z: 0 }, home: { x: 0, y: 64, z: 0, dimension: 'overworld' } });
  const ctx = {
    s, world, signal: new AbortController().signal, progress: () => undefined, gain: () => undefined, status: async () => ({}) as never,
    call: async <T>(m: string, p: Record<string, unknown> = {}): Promise<T> => {
      calls.push(m);
      if (m === 'inventory') return { items: items() } as T;
      if (m === 'status') return { position: { x: 0, y: 64, z: 0 } } as T;
      if (m === 'world.findBlocks') return { positions: p.block === 'obsidian' ? wild.filter(q => !dug.has(fmt(q))) : [] } as T;
      throw new Error(`unexpected ${m}`);
    },
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      calls.push(tool);
      if (tool === 'dig-block') { dug.add(fmt(a as unknown as Pos)); obsidian++; return { ok: true, text: 'Dug obsidian' }; }
      if (tool === 'take-from-chest') {
        const n = Math.min(Number(a.count), inChest);
        inChest -= n; obsidian += n;
        return { ok: true, text: `Took ${n} obsidian from the chest at ${fmt(chest)}. It holds: ${inChest ? `obsidian x${inChest}` : 'nothing'}; 27/27 slots free.` };
      }
      return { ok: false, text: `unexpected ${tool}` };
    }
  } as unknown as GoalContext;
  return { ctx, calls, world, dug, have: () => obsidian };
}

test('the portal\'s 20 obsidian: four more a run where they come one at a time, progress till all 20 are carried; marked carried for the stash', async (t) => {
  const step = PORTAL().steps[0];
  const wild = Array.from({ length: 20 }, (_, i) => ({ x: i - 10, y: 12, z: 30 }));
  const o = obsidianCtx(6, wild);
  const st: MilestoneState = { step: 0, data: {} };
  t.deepEqual(await step.run(o.ctx, st), { status: 'progress', text: '10/20 obsidian (near home)' });
  t.is(o.have(), 10);
  t.true(o.world.progress?.carry?.includes('obsidian'));
  t.deepEqual(await step.run(o.ctx, st), { status: 'progress', text: '14/20 obsidian (near home)' });
  await step.run(o.ctx, st);
  t.deepEqual(await step.run(o.ctx, st), { status: 'done', text: '20 obsidian (near home)' });
  t.is(o.have(), 20);
  // what the chests hold comes out first, all of it at once
  const stored = obsidianCtx(0, [], 20);
  t.deepEqual(await step.run(stored.ctx, { step: 0, data: {} }), { status: 'done', text: '20 obsidian' });
  t.false(stored.calls.includes('dig-block'));
});

test('the obsidian runs keep off the frame of a portal of others seen lit before and gone out since (a blast): only in its own dimension', async (t) => {
  const step = PORTAL().steps[0];
  // someone's 2 x 3 portal along x at (20..21, 64..66, 30), out now: its 10-block frame left standing
  const gone = { x: 20, y: 64, z: 30, axis: 'x', width: 2, height: 3 };
  const frame: Pos[] = [
    ...[19, 20, 21, 22].flatMap(x => [{ x, y: 63, z: 30 }, { x, y: 67, z: 30 }]),
    ...[64, 65, 66].flatMap(y => [{ x: 19, y, z: 30 }, { x: 22, y, z: 30 }])
  ].filter(p => !((p.x === 19 || p.x === 22) && (p.y === 63 || p.y === 67)));
  const wild = Array.from({ length: 4 }, (_, i) => ({ x: -40 - i, y: 12, z: -40 }));
  const o = obsidianCtx(6, [...frame, ...wild]);
  o.world.nether = { seen: { overworld: [gone] } };
  t.deepEqual(await step.run(o.ctx, { step: 0, data: {} }), { status: 'progress', text: '10/20 obsidian (near home)' });
  t.deepEqual([...o.dug].sort(), wild.map(fmt).sort(), 'only the wild obsidian, though the frame is nearer');
  // remembered in the Nether, it is no frame here: the same blocks are fair game
  const other = obsidianCtx(6, [...frame, ...wild]);
  other.world.nether = { seen: { the_nether: [gone] } };
  await step.run(other.ctx, { step: 0, data: {} });
  t.true([...other.dug].some(d => frame.map(fmt).includes(d)));
});

test('the portal\'s obsidian cast at home a batch at a time: 6 lava buckets carried, 4 cast this run (the rest the next), as the room\'s 4 were', async (t) => {
  // a lawn 20 x 20, its ground at 62 (grass over dirt), the cast site kept from before; the cast as cast.test's fake has it
  const blocks = new Map<string, string>();
  for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) for (const [y, b] of [[60, 'dirt'], [61, 'dirt'], [62, 'grass_block']] as const) blocks.set(fmt({ x, y, z }), `minecraft:${b}`);
  const get = (p: Pos) => (blocks.get(fmt(p)) ?? 'minecraft:air').replace('minecraft:', '');
  const set = (p: Pos, b: string) => blocks.set(fmt(p), `minecraft:${b}`);
  const inv = new Map<string, number>([['lava_bucket', 6], ['water_bucket', 1], ['bucket', 0], ['diamond_pickaxe', 1], ['diamond_sword', 1], ['dirt', 30]]);
  let held = 'diamond_sword';
  const turn = (from: string, to: string) => { inv.set(from, inv.get(from)! - 1); inv.set(to, (inv.get(to) ?? 0) + 1); held = to; };
  const world: WorldMemory = { landmarks: { chests: [], farmland: [] }, leash: 96, yard: { x1: 0, z1: 0, x2: 19, z2: 19, y: 62 }, zones: { 'obsidian:cast': [{ x: 4, y: 62, z: 4 }] }, lavaCasting: true };
  const items = () => [...inv].filter(([, n]) => n > 0).map(([name, count], slot) => ({ name, count, slot }));
  const ctx = {
    s: lookAt(items(), 1000, { position: { x: 10, y: 63, z: 10 }, home: { x: 10, y: 63, z: 10, dimension: 'overworld' } }), world,
    signal: new AbortController().signal, progress: () => undefined, gain: () => undefined, status: async () => ({}) as never,
    call: async <T>(m: string, p: Record<string, unknown> = {}): Promise<T> => {
      const q = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
      if (m === 'inventory') return { items: items(), held: { name: held, count: 1 } } as T;
      if (m === 'status') return { position: { x: 10, y: 63, z: 10 } } as T;
      if (m === 'world.findBlocks') return { positions: [] } as T;
      if (m === 'world.region') {
        const out: string[] = [];
        for (let y = 0; y < Number(p.height); y++) for (let z = 0; z < Number(p.length); z++) for (let x = 0; x < Number(p.width); x++) out.push(`minecraft:${get({ x: q.x + x, y: q.y + y, z: q.z + z })}`);
        return { blocks: out } as T;
      }
      if (m === 'goto') return { arrived: true } as T;
      if (m === 'item.select') { held = String(p.name); return {} as T; }
      if (m === 'dig.here') { if (get(q) === 'obsidian') inv.set('obsidian', (inv.get('obsidian') ?? 0) + 1); set(q, 'air'); return { dug: true } as T; }
      throw new Error(`unexpected ${m}`);
    },
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      if (tool !== 'use-item-on-block') return { ok: true, text: 'ok' };
      held = String(a.item);
      const q = { x: Number(a.x), y: Number(a.y), z: Number(a.z) };
      const into = a.face === 'west' ? { ...q, x: q.x - 1 } : q;
      if (held === 'lava_bucket') { set(into, 'lava[level=0]'); turn('lava_bucket', 'bucket'); }
      else if (held === 'water_bucket') { set(into, 'water[level=0]'); turn('water_bucket', 'bucket'); if (/^lava/.test(get({ ...into, y: into.y - 1 }))) set({ ...into, y: into.y - 1 }, 'obsidian'); }
      else if (held === 'bucket' && /^(water|lava)/.test(get(q))) { const f = get(q).startsWith('water') ? 'water_bucket' : 'lava_bucket'; set(q, 'air'); turn('bucket', f); }
      else if (held === 'dirt') { set(into, 'dirt'); inv.set('dirt', inv.get('dirt')! - 1); }
      return { ok: true, text: 'Used' };
    }
  } as unknown as GoalContext;
  const r = await PORTAL().steps[0].run(ctx, { step: 0, data: {} });
  t.deepEqual(r, { status: 'progress', text: '4/20 obsidian, cast at home' });
  t.is(inv.get('obsidian'), 4);
  t.is(inv.get('lava_bucket'), 2, 'the other two for the next run');
  t.false(/_bucket$/.test(held), 'a harmless hand after');
});

// ------------------------------------------------------------------------------------------------ the site

/** The live yard (33 x 97 at y 62) read as plain grass from y 61 to 67: what occupancy makes of it, every column free. */
function freeYard(world: WorldMemory, built: (x: number, z: number) => boolean = () => false) {
  const y = world.yard!;
  const box = { x: y.x1, y: y.y - 1, z: y.z1, width: y.x2 - y.x1 + 1, height: 7, length: y.z2 - y.z1 + 1 };
  const blocks: string[] = [];
  for (let dy = 0; dy < box.height; dy++) for (let dz = 0; dz < box.length; dz++) for (let dx = 0; dx < box.width; dx++) {
    const [x, z, at] = [box.x + dx, box.z + dz, box.y + dy];
    blocks.push(at < y.y ? 'minecraft:dirt' : at === y.y ? 'minecraft:grass_block' : at === y.y + 1 && built(x, z) ? 'minecraft:chest' : 'minecraft:air');
  }
  return occupancy(box, blocks, y.y);
}

/** Cells strictly between two footprints, along the axis they are apart on (the more of the two). */
const gap = (a: { x: number; z: number; width: number; length: number }, b: { x: number; z: number; width?: number; length?: number }) => Math.max(
  b.x - (a.x + a.width), a.x - (b.x + (b.width ?? 1)), b.z - (a.z + a.length), a.z - (b.z + (b.length ?? 1)));

test('the live yard: a site 16 from both pens, 8 from every other build and zone, 2 in from the fence, its plane facing home', (t) => {
  const w = afterWorkshop();
  const site = portalSite(freeYard(w), portalAvoid(w.zones, []), HOME)!;
  t.truthy(site);
  t.is(site.width * site.length, 18);
  t.is(site.axis, site.width === 6 ? 'x' : 'z');
  const y = w.yard!;
  t.true(site.x >= y.x1 + 2 && site.x + site.width - 1 <= y.x2 - 2 && site.z >= y.z1 + 2 && site.z + site.length - 1 <= y.z2 - 2, JSON.stringify(site));
  for (const pen of ['pen:cow', 'pen:sheep']) t.true(gap(site, w.zones![pen][0]) >= FROM_PENS, `${pen}: ${gap(site, w.zones![pen][0])}`);
  for (const [kind, zs] of Object.entries(w.zones!)) {
    if (kind === 'fence' || kind.startsWith('fence:') || kind.startsWith('pen:')) continue;
    for (const z of zs) t.true(gap(site, z) >= FROM_BUILDS, `${kind} at ${fmt(z)}: ${gap(site, z)}`);
  }
  t.true(facesHome(site, HOME));
  // near home all the same: the storage house's west side, past the pens' 16
  t.true(Math.hypot(site.x + site.width / 2 - HOME.x, site.z + site.length / 2 - HOME.z) < 20, JSON.stringify(site));
});

/** The structures the improvement runs placed in the live yard, as their compiled boxes (the structure store, Nov 14): no zones. */
const LIVE_BUILDS = [
  { x: -547, z: 2185, width: 13, length: 11 }, // cottage
  { x: -560, z: 2163, width: 11, length: 11 }, // cow-barn
  { x: -564, z: 2182, width: 31, length: 17 }, // lamp-walk (posts and a path: its box whole)
  { x: -558, z: 2200, width: 7, length: 7 }, // lookout
  { x: -544, z: 2171, width: 9, length: 8 } // windmill
];

test('the site keeps 8 from the structures the improvement runs built too (they keep no zone): their boxes given, the site moves off them', (t) => {
  const w = afterWorkshop();
  const zonesOnly = portalSite(freeYard(w), portalAvoid(w.zones, []), HOME)!;
  t.true(LIVE_BUILDS.some(b => gap(zonesOnly, b) < FROM_BUILDS), 'on the zones alone it is by the lookout and in the lamp walk\'s box');
  const site = portalSite(freeYard(w), portalAvoid(w.zones, [], LIVE_BUILDS), HOME)!;
  t.truthy(site);
  for (const b of LIVE_BUILDS) t.true(gap(site, b) >= FROM_BUILDS, `${fmt({ ...b, y: 0 })}: ${gap(site, b)}`);
  for (const pen of ['pen:cow', 'pen:sheep']) t.true(gap(site, w.zones![pen][0]) >= FROM_PENS, pen);
  // the step reads them from its context (the brain's structure store)
  t.deepEqual(portalAvoid(w.zones, [], LIVE_BUILDS).slice(-LIVE_BUILDS.length), LIVE_BUILDS.map(b => ({ x: b.x - 6, z: b.z - 6, width: b.width + 12, length: b.length + 12 })));
});

test('the site step asks its context for the builds: the site it keeps is 8 off them', async (t) => {
  const world = afterWorkshop();
  const h = home(world, kit());
  const st: MilestoneState = { step: 4, data: {} };
  const r = await siteForPortal.run({ ...h.ctx, builds: () => LIVE_BUILDS }, st);
  t.like(r, { status: 'done' });
  const site = st.data.site as { x: number; z: number; width: number; length: number };
  for (const b of LIVE_BUILDS) t.true(gap(site, b) >= FROM_BUILDS, `${fmt({ ...b, y: 0 })}: ${gap(site, b)} (${JSON.stringify(site)})`);
});

test('the site: never within 16 of a pen, whatever is nearer home; the other way round only when none faces home', (t) => {
  const w = afterWorkshop();
  // a pen right by home: everything within 16 of it is out
  w.zones!['pen:cow'] = [{ x: -552, y: 62, z: 2170, width: 7, length: 7 }];
  const site = portalSite(freeYard(w), portalAvoid(w.zones, []), HOME)!;
  t.true(gap(site, w.zones!['pen:cow'][0]) >= 16, JSON.stringify(site));
  // a strip 3 wide along z, all else built over: only the site along z fits, and its plane faces east-west
  const narrow = afterWorkshop();
  narrow.zones = {};
  const strip = (x: number, z: number) => !(x >= -563 && x <= -555 && z >= 2150 && z <= 2170);
  const along = portalSite(freeYard(narrow, strip), [], HOME)!;
  t.like(along, { width: 3, length: 6, axis: 'z', rotated: true });
  // the kept sites of other milestones too, 8 off
  const kept = afterWorkshop();
  const first = portalSite(freeYard(kept), portalAvoid(kept.zones, []), HOME)!;
  const other = portalSite(freeYard(kept), portalAvoid(kept.zones, [{ x: first.x, z: first.z, width: 7, length: 7 }]), HOME)!;
  t.true(gap(other, { x: first.x, z: first.z, width: 7, length: 7 }) >= 8, JSON.stringify({ first, other }));
});

// ------------------------------------------------------------------------------------------------ a fake home

const GROUND = 62;
const ORES = '-547,63,2180', GEAR2 = '-547,64,2182';
const MAX: Record<string, number> = { diamond_helmet: 363, diamond_chestplate: 528, diamond_leggings: 495, diamond_boots: 429, diamond_pickaxe: 1561, diamond_sword: 1561, golden_helmet: 77, flint_and_steel: 64 };
/** What the fake's craft-item takes for one (the game's recipes; sticks for the tools). */
const CRAFTS: Record<string, Record<string, number>> = {
  diamond_helmet: { diamond: 5 }, diamond_chestplate: { diamond: 8 }, diamond_leggings: { diamond: 7 }, diamond_boots: { diamond: 4 },
  diamond_pickaxe: { diamond: 3, stick: 2 }, diamond_sword: { diamond: 2, stick: 1 }, flint_and_steel: { iron_ingot: 1, flint: 1 }, golden_helmet: { gold_ingot: 5 }
};
const ENCH = (name: string, level = 3) => ({ enchanted: true, enchantments: [{ name, level }] });

/** The bot's kit as it is (Nov 14): enchanted diamond tools and armour, the helmet plain, a stack of cobblestone. */
const kit = (): InventoryItem[] => [
  { slot: 0, name: 'diamond_pickaxe', count: 1, damage: 200, maxDamage: 1561, ...ENCH('fortune') },
  { slot: 1, name: 'diamond_sword', count: 1, damage: 90, maxDamage: 1561, ...ENCH('sharpness') },
  { slot: 2, name: 'iron_pickaxe', count: 1, damage: 0, maxDamage: 250 },
  { slot: 3, name: 'torch', count: 32 }, { slot: 4, name: 'cobblestone', count: 40 }, { slot: 5, name: 'bread', count: 32 },
  { slot: 36, name: 'diamond_boots', count: 1, damage: 10, maxDamage: 429, ...ENCH('feather_falling') },
  { slot: 37, name: 'diamond_leggings', count: 1, damage: 10, maxDamage: 495, ...ENCH('protection') },
  { slot: 38, name: 'diamond_chestplate', count: 1, damage: 10, maxDamage: 528, ...ENCH('protection') },
  { slot: 39, name: 'diamond_helmet', count: 1, damage: 30, maxDamage: 363 },
  { slot: 40, name: 'shield', count: 1 }
];

/**
 * The homestead as the bridge and the tools answer: the chests by their stacks (the world's chestItems, split into
 * stacks), the pockets, the ground (grass at 62, dirt under, air over; what is built or dug over that), and a portal
 * that lights in a whole frame (`lights` false: none does). What it did, in order, in `did`.
 */
function home(world: WorldMemory, items: InventoryItem[], opts: { lights?: boolean } = {}) {
  const did: string[] = [];
  const inv = items.map(i => ({ ...i }));
  const chests = new Map<string, ChestStack[]>();
  for (const [k, contents] of Object.entries(world.chestItems ?? {})) {
    const stacks: ChestStack[] = [];
    for (const [name, n] of Object.entries(contents)) for (let left = n; left > 0; left -= stackSize(name)) stacks.push({ slot: stacks.length, name, count: Math.min(left, stackSize(name)) });
    chests.set(k, stacks);
  }
  const placed = new Map<string, string>();
  const get = (p: Pos) => placed.get(fmt(p)) ?? (p.y < GROUND ? 'minecraft:dirt' : p.y === GROUND ? 'minecraft:grass_block' : 'minecraft:air');
  let open = '';
  let held = 'diamond_sword';
  let at: Pos = { ...HOME };
  let lit: Record<string, unknown> | undefined;
  const free = (k: string) => 54 - (chests.get(k) ?? []).length;
  const reply = (k: string): ChestContents => {
    const stacks = chests.get(k) ?? [];
    const totals: Record<string, number> = {};
    for (const st of stacks) totals[st.name] = (totals[st.name] ?? 0) + st.count;
    return { slots: 54, free: free(k), items: totals, stacks: stacks.map(st => ({ ...st })) };
  };
  const pocket = () => { for (let i = 0; i < 36; i++) if (!inv.some(x => x.slot === i)) return i; return -1; };
  const give = (name: string, n: number, extra: Partial<InventoryItem> = {}) => {
    if (MAX[name] || stackSize(name) === 1) { inv.push({ slot: pocket(), name, count: 1, damage: 0, ...(MAX[name] ? { maxDamage: MAX[name] } : {}), ...extra }); return; }
    const has = inv.find(x => x.slot < 36 && x.name === name);
    if (has) has.count += n; else inv.push({ slot: pocket(), name, count: n });
  };
  const take = (name: string, n: number) => {
    let left = n;
    for (const x of inv.filter(i => i.slot < 36 && i.name === name)) { const k = Math.min(left, x.count); x.count -= k; left -= k; }
    for (let i = inv.length - 1; i >= 0; i--) if (inv[i].count <= 0) inv.splice(i, 1);
  };
  const carried = (name: string) => inv.filter(i => i.slot < 36 && i.name === name).reduce((a, i) => a + i.count, 0);
  const holds = (k: string) => {
    const r = reply(k);
    return `It holds: ${Object.entries(r.items).map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing'}; ${r.free}/54 slots free.`;
  };
  const ctx = {
    s: lookAt(inv, 1000, { xpLevel: 40 }), world, signal: new AbortController().signal, progress: (text: string) => { did.push(`progress ${text}`); }, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'claudebot', screen: null, position: at, dimension: 'overworld' }),
    call: async (m: string, p: Record<string, unknown> = {}) => {
      const pos = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
      if (m === 'inventory') return { items: inv.map(i => ({ ...i })), held: { name: held, count: 1 } };
      if (m === 'status') return { position: at, dimension: 'overworld' };
      if (m === 'world.region') {
        const blocks: string[] = [];
        for (let y = 0; y < Number(p.height ?? 1); y++) for (let z = 0; z < Number(p.length ?? 1); z++) for (let x = 0; x < Number(p.width ?? 1); x++) blocks.push(get({ x: pos.x + x, y: pos.y + y, z: pos.z + z }));
        return { blocks };
      }
      if (m === 'world.findBlocks') return { positions: [] };
      if (m === 'foreign.zones') return { zones: [] };
      if (m === 'item.select') { held = String(p.name); return {}; }
      if (m === 'goto') { did.push(`goto ${fmt(pos)} range ${p.range}${p.careful ? ' careful' : ''}`); at = pos; return { arrived: true, at }; }
      if (m === 'chest.open') { open = fmt(pos).replace(/[() ]/g, ''); did.push(`chest.open ${open}`); return reply(open); }
      if (m === 'chest.deposit') {
        const from = inv.find(i => i.slot === p.slot && i.name === p.name);
        if (!from || !free(open)) return { ...reply(open), moved: 0 };
        const stacks = chests.get(open)!;
        let slot = 0;
        while (stacks.some(st => st.slot === slot)) slot++;
        stacks.push({ ...from, slot, count: 1 });
        from.count -= 1;
        if (from.count <= 0) inv.splice(inv.indexOf(from), 1);
        did.push(`chest.deposit ${p.name} from pocket ${p.slot} into ${open} slot ${slot}`);
        return { ...reply(open), moved: 1 };
      }
      if (m === 'chest.withdraw') {
        const stacks = chests.get(open)!;
        const st = stacks.find(x => x.slot === p.slot && x.name === p.name) ?? stacks.find(x => x.name === p.name);
        if (!st) return { ...reply(open), moved: 0 };
        const n = Math.min(Number(p.count ?? st.count), st.count);
        st.count -= n;
        chests.set(open, stacks.filter(x => x.count > 0));
        give(st.name, n, { damage: st.damage ?? 0 });
        did.push(`chest.withdraw ${p.name} slot ${st.slot} from ${open}`);
        return { ...reply(open), moved: n };
      }
      if (m === 'container.close') return {};
      if (m === 'portal.list') return { dimension: 'overworld', portals: lit ? [lit] : [] };
      if (m === 'portal.own') { did.push(`portal.own ${JSON.stringify(p)}`); return { own: [p] }; }
      did.push(`call ${m}`);
      return {};
    },
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      const pos = { x: Number(a.x), y: Number(a.y), z: Number(a.z) };
      if (tool === 'take-from-chest') {
        const k = fmt(pos).replace(/[() ]/g, '');
        const stacks = chests.get(k) ?? [];
        let left = Number(a.count), n = 0;
        for (const st of stacks.filter(x => x.name === a.item)) { const q = Math.min(left, st.count); st.count -= q; left -= q; n += q; }
        chests.set(k, stacks.filter(x => x.count > 0));
        if (n) give(String(a.item), n);
        did.push(`take-from-chest ${a.item} x${n} from ${k}`);
        return n ? { ok: true, text: `Took ${n} ${a.item} from the chest at ${fmt(pos)}. ${holds(k)}` } : { ok: false, text: `No ${a.item} in the chest at ${fmt(pos)}. ${holds(k)}` };
      }
      if (tool === 'craft-item') {
        const out = String(a.outputItem), times = Number(a.amount ?? 1);
        const need = CRAFTS[out];
        if (!need || Object.entries(need).some(([n, k]) => carried(n) < k * times)) { did.push(`craft-item ${out} failed`); return { ok: false, text: `missing ingredients for ${out}` }; }
        for (const [n, k] of Object.entries(need)) take(n, k * times);
        for (let i = 0; i < times; i++) give(out, 1);
        did.push(`craft-item ${out} x${times}`);
        return { ok: true, text: `Crafted ${times} ${out}` };
      }
      if (tool === 'build-structure') {
        const spec = a.spec as StructureSpec;
        for (const [n, k] of Object.entries(billOf(spec))) { if (carried(n) < k) return { ok: false, text: `Failed: Not enough blocks to build it. Missing: ${n} ${carried(n)}/${k}` }; take(n, k); }
        spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => {
          if (ch !== ' ') placed.set(fmt({ x: pos.x + x, y: pos.y + y, z: pos.z + z }), ch === '.' ? 'minecraft:air' : `minecraft:${spec.palette[ch]}`);
        })));
        did.push(`build-structure ${a.name} at ${fmt(pos)}`);
        return { ok: true, text: `Built ${a.name} at ${fmt(pos)} in 30s: all 20 blocks in place. Used: obsidian x10, cobblestone x10.` };
      }
      if (tool === 'use-item-on-block') {
        did.push(`use-item-on-block ${a.item} on ${fmt(pos)} face ${a.face} from ${fmt(at)}`);
        const reach = Math.hypot(pos.x + 0.5 - (at.x + 0.5), pos.y + 1 - (at.y + 1.62), pos.z + 0.5 - (at.z + 0.5));
        if (reach > 4.5) return { ok: false, text: 'too far' };
        const inside = (dx: number, dz: number) => [0, 1, 2].map(dy => ({ x: pos.x + dx, y: pos.y + 1 + dy, z: pos.z + dz }));
        const alongX = get({ x: pos.x + 1, y: pos.y, z: pos.z }).endsWith('obsidian');
        const cells = alongX ? [...inside(0, 0), ...inside(1, 0)] : [...inside(0, 0), ...inside(0, 1)];
        const whole = get(pos).endsWith('obsidian') && cells.every(c => get(c) === 'minecraft:air');
        if (a.item === 'flint_and_steel' && opts.lights !== false && whole) {
          for (const c of cells) placed.set(fmt(c), `minecraft:nether_portal[axis=${alongX ? 'x' : 'z'}]`);
          lit = { x: pos.x, y: pos.y + 1, z: pos.z, axis: alongX ? 'x' : 'z', width: 2, height: 3, blocks: 6, own: true };
          return { ok: true, text: `Used flint_and_steel on obsidian at ${fmt(pos)}: it is now obsidian` };
        }
        return { ok: true, text: `Used ${a.item} on ${get(pos).replace(/^minecraft:/, '')} at ${fmt(pos)}; nothing changed` };
      }
      if (tool === 'go-home' || tool === 'move-to-position') return { ok: true, text: 'Arrived' };
      did.push(`act ${tool}`);
      return { ok: false, text: `unexpected ${tool}` };
    }
  } as unknown as GoalContext;
  return { ctx, did, inv, chests, get, set: (p: Pos, b: string) => placed.set(fmt(p), b), lit: () => lit };
}

/** afterWorkshop with what the portal's steps take stored: 20 obsidian, diamonds, gold ingots (the live chests hold them). */
function stocked(): WorldMemory {
  const w = afterWorkshop();
  Object.assign(w.chestItems![ORES], { diamond: 64, gold_ingot: 41 });
  w.chestItems!['-547,64,2180'].obsidian = 20;
  return w;
}

// ------------------------------------------------------------------------------------------------ the whole milestone

test('the portal from the workshop on: obsidian, flint and steel, the spare set, the helmet, a site, the frame; the light blocked with trips off, stopping nothing', async (t) => {
  const world = stocked();
  const h = home(world, kit());
  const goal = projectGoal(TREE);
  const run = async () => goal.run({ ...h.ctx, s: lookAt(h.inv, 1000, { xpLevel: 40 }) });
  const s = () => lookAt(h.inv, 1000, { xpLevel: 40 });
  t.is(goal.wants(s(), world), 'a nether portal: gather 20 obsidian');
  t.is(await run(), 'a nether portal - gather 20 obsidian: 20 obsidian');
  t.is(await run(), 'a nether portal - craft 2 flint and steel: 2 flint and steel');
  t.true(h.did.includes('craft-item flint_and_steel x2'));
  t.regex(await run(), /^a nether portal - the spare diamond set: stored diamond_helmet \(slot \d+\), .*: all 6 pieces in the chests$/);
  t.is(await run(), 'a nether portal - a golden helmet: crafted a golden helmet for the Nether');
  t.regex(await run(), /^a nether portal - find room for the portal: the portal goes at \(-?\d+, 62, \d+\), its plane along [xz] facing home$/);
  const st = world.progress!.current!;
  const site = st.data.site as { x: number; y: number; z: number; width: number; length: number };
  t.regex(await run(), /^a nether portal - build the portal frame: portal frame built at /);
  t.true(h.did.includes(`build-structure nether-portal at (${site.x}, 62, ${site.z})`), 'on the ground layer');
  t.deepEqual(world.zones!.portal, [{ x: site.x, y: 62, z: site.z, width: site.width, length: site.length }]);
  const frame = world.zones!['portal:frame'][0];
  t.is(frame.y, 64, 'the inside starts two up: the plinth in the ground, the frame\'s bottom on it');
  t.is(h.get({ ...frame, y: 63 }), 'minecraft:obsidian');
  t.is(h.get(frame), 'minecraft:air');
  t.false(PORTAL().done!({ s: s(), world, have: () => 0 }), 'built, not lit: not done');

  // the light: trips off (as it ships). It says so, in the line the lead watches for, and waits 30 min
  const before = h.did.length;
  t.is(goal.wants(s(), world), 'a nether portal: light the portal');
  t.false(goal.cuts!(s(), world), 'stops nothing for a step that only says it is off');
  t.is(await run(), 'a nether portal - light the portal: nether trips are off');
  t.deepEqual(h.did.slice(before).filter(d => !/^progress a nether portal - /.test(d)), [`progress ${LIGHT_OFF}`]);
  t.is(world.progress!.journal.at(-1)!.text, `a nether portal: ${LIGHT_OFF}`);
  t.is(world.progress!.blockedUntil!['nether-portal'], T0 + 30 * MINUTE);
  // meanwhile the project goes on with the villager hall (P5b: after the workshop, the portal no prereq of it); with
  // that done too, nothing is left but the light, which waits for the switch
  t.is(goal.wants(s(), world), 'a villager hall: find room for the hall');
  const hallDone = structuredClone(world);
  hallDone.progress!.done.push('hall');
  t.is(goal.wants(s(), hallDone), null);
  t.deepEqual(goal.declines!(s(), hallDone), { cause: 'unneeded', text: 'a nether portal: light the portal waits (nether trips are off)', until: T0 + 30 * MINUTE });
  // the half hour over: it wants again, still stopping nothing; never once through a portal, never the flint and steel
  const later = lookAt(h.inv, 1000, { xpLevel: 40, now: T0 + 31 * MINUTE });
  t.is(goal.wants(later, world), 'a nether portal: light the portal');
  t.false(goal.cuts!(later, world));
  t.false(h.did.some(d => /portal\.enter|use-item-on-block flint_and_steel|portal\.own/.test(d)), h.did.join(' | '));
  t.is(h.lit(), undefined);

  // switched on: lit from a step out of the plane toward home, the flint and steel on the bottom obsidian's top face
  world.nether = { trips: true };
  t.true(goal.cuts!(later, world));
  t.is(await goal.run({ ...h.ctx, s: later }), 'a nether portal complete');
  const axis = st.data.axis as string;
  const spot = axis === 'x' ? { x: frame.x, y: 63, z: HOME.z > frame.z ? frame.z + 1 : frame.z - 1 } : { x: HOME.x > frame.x ? frame.x + 1 : frame.x - 1, y: 63, z: frame.z };
  t.true(h.did.includes(`goto ${fmt(spot)} range 0 careful`), h.did.slice(-6).join(' | '));
  t.true(h.did.includes(`use-item-on-block flint_and_steel on ${fmt({ ...frame, y: 63 })} face up from ${fmt(spot)}`));
  t.true(h.did.includes(`portal.own ${JSON.stringify({ dimension: 'overworld', x: frame.x, y: frame.y, z: frame.z })}`));
  t.deepEqual(world.zones!['portal:lit'], [{ x: frame.x, y: frame.y, z: frame.z }]);
  t.true(world.progress!.done.includes('nether-portal'));
  t.true(world.progress!.journal.some(j => /^a nether portal: light the portal done \(the portal is lit at /.test(j.text)));
  t.deepEqual(homePortal(world), { x: frame.x, y: frame.y, z: frame.z });
  t.deepEqual(ownPortals(world), [{ dimension: 'overworld', x: frame.x, y: frame.y, z: frame.z }]);
  // the tree goes on with the villager hall (P5b): the last milestone after the workshop
  t.is(goal.wants(later, world), 'a villager hall: find room for the hall');
  t.true(PORTAL().done!({ s: later, world, have: () => 0 }));
});

/** The world with the frame built at (-562, 62, 2188) along z (as the build step leaves it), at the light step. */
function atTheLight(lights = true) {
  const world = stocked();
  world.nether = { trips: true };
  const site = { x: -562, y: 62, z: 2188, width: 3, length: 6, rotated: true };
  world.progress!.current = { id: 'nether-portal', step: 6, data: { site, axis: 'z', wood: 'oak' } };
  const h = home(world, [...kit(), { slot: 6, name: 'flint_and_steel', count: 1, damage: 0, maxDamage: 64 }], { lights });
  const bp = portal({ axis: 'z' });
  bp.spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => {
    if (ch !== ' ') h.set({ x: site.x + x, y: site.y + y, z: site.z + z }, ch === '.' ? 'minecraft:air' : `minecraft:${bp.spec.palette[ch]}`);
  })));
  world.zones!.portal = [{ x: site.x, y: 62, z: site.z, width: 3, length: 6 }];
  world.zones!['portal:frame'] = [{ x: site.x + 1, y: 64, z: site.z + 2 }];
  return { world, h, frame: { x: site.x + 1, y: 64, z: site.z + 2 }, step: PORTAL().steps[6], st: world.progress!.current };
}

test('the light: a frame short of obsidian, or with something in its inside, is not lit, and says why; one that does not take says so and waits', async (t) => {
  const a = atTheLight();
  a.h.set({ x: a.frame.x, y: 63, z: a.frame.z + 1 }, 'minecraft:air');
  a.h.set({ x: a.frame.x, y: 65, z: a.frame.z }, 'minecraft:cobblestone');
  const r = await a.step.run(a.h.ctx, a.st);
  t.like(r, { status: 'blocked', retryMs: 30 * MINUTE });
  t.is(r.text, `the frame at ${fmt(a.frame)} would not light: 1 obsidian missing ((${a.frame.x}, 63, ${a.frame.z + 1})); in the way: cobblestone at (${a.frame.x}, 65, ${a.frame.z})`);
  t.false(a.h.did.some(d => /^use-item-on-block|^goto/.test(d)));
  const b = atTheLight(false);
  const n = await b.step.run(b.h.ctx, b.st);
  t.like(n, { status: 'blocked', retryMs: 30 * MINUTE });
  t.regex(n.text, /^the frame at \(-561, 64, 2190\) did not light: Used flint_and_steel on obsidian at \(-561, 63, 2190\); nothing changed/);
  t.false(b.h.did.some(d => d.startsWith('portal.own')));
  t.false('portal:lit' in b.world.zones!);
  // the frame along z, home to the east of it: the spot a step east of the plane
  const c = atTheLight();
  t.like(await c.step.run(c.h.ctx, c.st), { status: 'done' });
  t.true(c.h.did.includes(`goto (${c.frame.x + 1}, 63, ${c.frame.z}) range 0 careful`), c.h.did.join(' | '));
});

test('F3: the light from the other side of the plane where the side toward home has no floor (live: a hole the frame\'s build left there); neither side will do: why, and no walk', async (t) => {
  // the frame along z, home to the east: the spot a step east of the plane is over a hole, the one a step west is not
  const a = atTheLight();
  a.h.set({ x: a.frame.x + 1, y: 62, z: a.frame.z }, 'minecraft:air');
  t.like(await a.step.run(a.h.ctx, a.st), { status: 'done' });
  t.true(a.h.did.includes(`goto (${a.frame.x - 1}, 63, ${a.frame.z}) range 0 careful`), a.h.did.join(' | '));
  t.false(a.h.did.some(d => d.startsWith(`goto (${a.frame.x + 1}, 63,`)), 'never toward the hole');
  t.true(a.h.did.includes(`use-item-on-block flint_and_steel on (${a.frame.x}, 63, ${a.frame.z}) face up from (${a.frame.x - 1}, 63, ${a.frame.z})`));
  t.truthy(a.h.lit());
  // water is no floor, a block where the feet go no room: neither side, so it says why and walks nowhere
  const b = atTheLight();
  b.h.set({ x: b.frame.x + 1, y: 62, z: b.frame.z }, 'minecraft:water[level=0]');
  b.h.set({ x: b.frame.x - 1, y: 63, z: b.frame.z }, 'minecraft:cobblestone');
  const r = await b.step.run(b.h.ctx, b.st);
  t.like(r, { status: 'blocked' });
  t.is(r.text, `nowhere to stand to light the portal's frame at ${fmt(b.frame)}: no floor under (${b.frame.x + 1}, 63, ${b.frame.z}) (water); ` +
    `no room to stand at (${b.frame.x - 1}, 63, ${b.frame.z}) (cobblestone)`);
  t.false(b.h.did.some(d => /^goto|^use-item-on-block/.test(d)), b.h.did.join(' | '));
  t.is(b.h.lit(), undefined);
  // the pure rule along x, as live: home to the south, the hole at z 2148 under the spot: the north side, z 2146
  const live = { step: 6, data: { site: { x: -562, y: 62, z: 2146, width: 6, length: 3, rotated: false }, axis: 'x' } };
  const frame = { x: -560, y: 64, z: 2147 };
  const ground = (holes: Pos[]) => (p: Pos) => (holes.some(q => fmt(q) === fmt(p)) ? 'air' : p.y <= 62 ? 'grass_block' : 'air');
  t.deepEqual(lightingSpot(live, frame, HOME, ground([])), { x: -560, y: 63, z: 2148 });
  t.deepEqual(lightingSpot(live, frame, HOME, ground([{ x: -560, y: 62, z: 2148 }])), { x: -560, y: 63, z: 2146 });
  t.deepEqual(lightingSpot(live, frame, HOME, ground([{ x: -560, y: 62, z: 2148 }, { x: -560, y: 62, z: 2146 }])),
    { why: 'no floor under (-560, 63, 2148) (air); no floor under (-560, 63, 2146) (air)' });
});

test('F3: the light: a flower, a bush or a torch where the bot stands to light the frame is walked through, not taken for a wall; a berry bush is no place to stand', async (t) => {
  const live = { step: 6, data: { site: { x: -562, y: 62, z: 2146, width: 6, length: 3, rotated: false }, axis: 'x' } };
  const frame = { x: -560, y: 64, z: 2147 };
  const toward = { x: -560, y: 63, z: 2148 };
  const standIn = (feet: string, head = 'air') => (p: Pos) => (fmt(p) === fmt(toward) ? feet : fmt(p) === fmt({ ...toward, y: 64 }) ? head : p.y <= 62 ? 'grass_block' : 'air');
  for (const plant of ['oxeye_daisy', 'red_tulip', 'azure_bluet', 'cornflower', 'lily_of_the_valley', 'bush', 'firefly_bush', 'short_dry_grass', 'brown_mushroom', 'torch']) {
    t.deepEqual(lightingSpot(live, frame, HOME, standIn(plant)), toward, plant);
  }
  t.deepEqual(lightingSpot(live, frame, HOME, standIn('air', 'lilac')), toward, 'a tall flower\'s top at the head');
  // the berry bush harms: the other side
  t.deepEqual(lightingSpot(live, frame, HOME, standIn('sweet_berry_bush')), { x: -560, y: 63, z: 2146 });
  // the step as a whole, with an oxeye daisy toward home: it walks there and lights
  const a = atTheLight();
  a.h.set({ x: a.frame.x + 1, y: 63, z: a.frame.z }, 'minecraft:oxeye_daisy');
  t.like(await a.step.run(a.h.ctx, a.st), { status: 'done' });
  t.true(a.h.did.includes(`goto (${a.frame.x + 1}, 63, ${a.frame.z}) range 0 careful`), a.h.did.join(' | '));
});

/**
 * The frame's build at the build step as atTheLight's site has it (along z, home to the east), Baritone digging the
 * row toward home out as it builds (the live build left 5 such holes), and level-area as the tool levels: its dry run
 * says the fill, then it fills each hole with dirt.
 */
function atTheBuild(items: InventoryItem[], fills = true) {
  const world = stocked();
  const site = { x: -562, y: 62, z: 2188, width: 3, length: 6, rotated: true };
  world.progress!.current = { id: 'nether-portal', step: 5, data: { site, axis: 'z', wood: 'oak' } };
  const h = home(world, [...kit(), { slot: 6, name: 'obsidian', count: 10 }, ...items]);
  const dug = [0, 1, 2, 3, 4].map(i => ({ x: site.x + 2, y: 62, z: site.z + i }));
  const levels: Record<string, unknown>[] = [];
  const act = h.ctx.act;
  (h.ctx as { act: GoalContext['act'] }).act = (async (tool: string, a: Record<string, unknown> = {}) => {
    if (tool === 'level-area') {
      levels.push(a);
      const holes: Pos[] = [];
      for (let x = Number(a.x1); x <= Number(a.x2); x++) for (let z = Number(a.z1); z <= Number(a.z2); z++) {
        if (/^minecraft:(air|water)/.test(h.get({ x, y: Number(a.level), z }))) holes.push({ x, y: Number(a.level), z });
      }
      if (a.dryRun) return { ok: true, text: `Level (${a.x1}, ${a.z1})..(${a.x2}, ${a.z2}) to ground y ${a.level}: cut 0 block(s), fill ${holes.length} dirt + 0 cobblestone; left alone: 0 water column(s), 3 column(s) with builds, crops or furniture.` };
      if (!fills) return { ok: true, text: 'Leveled 1 tile(s)\nNow level.' };
      const dirt = h.inv.find(i => i.name === 'dirt');
      for (const p of holes) if (dirt && dirt.count-- > 0) h.set(p, 'minecraft:dirt');
      return { ok: true, text: 'Leveled 1 tile(s)\nNow level.' };
    }
    const r = await act(tool, a);
    if (tool === 'build-structure') for (const p of dug) h.set(p, 'minecraft:air');
    return r;
  }) as GoalContext['act'];
  return { world, h, site, dug, levels, step: PORTAL().steps[5], st: world.progress!.current };
}

test('F3: after the frame\'s build the ground round its plinth is the yard\'s ground again: the holes Baritone dug as it built filled with dirt, as a site step levels', async (t) => {
  const b = atTheBuild([{ slot: 7, name: 'dirt', count: 20 }]);
  const r = await b.step.run(b.h.ctx, b.st);
  t.like(r, { status: 'done' });
  t.regex(r.text, /^portal frame built at /);
  t.true(b.h.did.includes(`build-structure nether-portal at (${b.site.x}, 62, ${b.site.z})`));
  // no hole left round the plinth: the row toward home where the light step stands, and every other cell of the ring
  t.deepEqual(b.dug.map(p => b.h.get(p)), b.dug.map(() => 'minecraft:dirt'));
  const ground = (p: Pos) => b.h.get(p).replace(/^minecraft:/, '').replace(/\[.*$/, '');
  t.deepEqual(ringHoles({ ...b.site }, 'z', ground), []);
  // levelled as a growing yard's strip is: the ring round the plinth (a cell past each end of it), to the site's ground
  t.deepEqual(b.levels.map(l => `${l.dryRun ? 'dry ' : ''}${l.x1},${l.z1}..${l.x2},${l.z2} to ${l.level}`), [`dry -562,2187..-560,2194 to 62`, `-562,2187..-560,2194 to 62`]);
  t.deepEqual(ringOf(b.site, 'z'), { x1: -562, z1: 2187, x2: -560, z2: 2194 });
  t.like(b.levels[1], { fillWater: true });
  // a build that left the ground whole: nothing levelled
  const whole = atTheBuild([{ slot: 7, name: 'dirt', count: 20 }]);
  whole.dug.splice(0);
  t.like(await whole.step.run(whole.h.ctx, whole.st), { status: 'done' });
  t.deepEqual(whole.levels, []);
  // a levelling that fills none of them: said, and on to the light all the same (it stands on the side with a floor),
  // not held at the build for good
  const stuck = atTheBuild([{ slot: 7, name: 'dirt', count: 20 }], false);
  const s = await stuck.step.run(stuck.h.ctx, stuck.st);
  t.like(s, { status: 'done' });
  t.regex(s.text, /^portal frame built at .*; the ground round the portal's plinth: 5 hole\(s\) left \(\(-560, 62, 2188\), /);
  t.is(stuck.st!.data.ringLeft, undefined);
});

test('F3: the ground round the plinth short of dirt to fill it: the step waits for the fill (not done, the stock trips told), and goes on with the ring alone, never building again', async (t) => {
  const b = atTheBuild([]);
  for (const c of Object.values(b.world.chestItems ?? {})) delete c.dirt;
  const r = await b.step.run(b.h.ctx, b.st);
  t.like(r, { status: 'blocked', need: { dirt: 5 } });
  t.is(r.text, 'the ground round the portal\'s plinth: 5 hole(s) to fill, short of 5 dirt');
  t.true(b.dug.every(p => b.h.get(p) === 'minecraft:air'));
  // the dirt fetched since: the next run levels the ring and builds nothing
  b.h.inv.push({ slot: 7, name: 'dirt', count: 8 });
  const builds = b.h.did.filter(d => d.startsWith('build-structure')).length;
  const again = await b.step.run(b.h.ctx, b.st);
  t.like(again, { status: 'done', text: 'portal frame built, the ground round its plinth level' });
  t.is(b.h.did.filter(d => d.startsWith('build-structure')).length, builds);
  t.true(b.dug.every(p => b.h.get(p) === 'minecraft:dirt'));
  t.is(b.st!.data.ringLeft, undefined);
});

test('done with a lit portal already standing in the yard (it is then its own); not with one outside it', (t) => {
  const w = afterWorkshop();
  const m = PORTAL();
  const view = { s: lookAt([], 1000), world: w, have: () => 0 };
  t.false(m.done!(view));
  t.deepEqual(ownPortals(w), []);
  // the look round home found one (findLandmarks) by the storage house
  const box = { x: -560, y: 62, z: 2190, width: 2, height: 3, length: 1 };
  const blocks = Array.from({ length: 6 }, () => 'minecraft:nether_portal[axis=x]');
  const found = findLandmarks(box, blocks, HOME);
  // (a block of it, the nearest home: portal.own takes any)
  t.deepEqual(found.portal, { x: -559, y: 63, z: 2190 });
  w.landmarks = { ...w.landmarks, portal: found.portal };
  t.true(portalStanding(w));
  t.true(m.done!(view));
  t.deepEqual(homePortal(w), { x: -559, y: 63, z: 2190 });
  t.deepEqual(ownPortals(w), [{ dimension: 'overworld', x: -559, y: 63, z: 2190 }]);
  // the community's, by the community chest: not the yard's, not its own
  w.landmarks.portal = { x: -437, y: 66, z: 2134 };
  t.false(m.done!(view));
  t.is(homePortal(w), undefined);
});

// ------------------------------------------------------------------------------------------------ the spare set

/** The spare set made with the fake home: the world, and the chest and slot of each piece. */
async function withSpareSet() {
  const world = stocked();
  const h = home(world, kit());
  const r = await spareSetStep.run(h.ctx, { step: 2, data: {} });
  return { world, h, r };
}

test('the spare set: a plain piece of each crafted from 29 diamonds, stored by its pocket slot in a gear chest, remembered by chest and slot', async (t) => {
  const { world, h, r } = await withSpareSet();
  t.like(r, { status: 'done' });
  const pieces = world.spareSet!.pieces;
  t.deepEqual(pieces.map(p => p.name), SPARE_SET.map(p => p.name));
  t.true(pieces.every(p => key(p.chest) === GEAR2), 'in the emptier gear chest (the books\' chests are the gear\'s)');
  const stacks = h.chests.get(GEAR2)!;
  for (const p of pieces) t.like(stacks.find(st => st.slot === p.slot), { name: p.name, count: 1 }, p.name);
  t.true(pieces.every(p => !stacks.find(st => st.slot === p.slot)!.enchantments), 'plain');
  t.is(64 - (chestTotals(world).diamond ?? 0) - h.inv.filter(i => i.name === 'diamond').reduce((a, i) => a + i.count, 0), 29);
  // nothing of the bot's own kit went in: the enchanted pickaxe and sword are still carried
  t.true(h.inv.some(i => i.name === 'diamond_pickaxe' && i.enchanted) && h.inv.some(i => i.name === 'diamond_sword' && i.enchanted));
  t.is(spareHeld(world).length, 6);
  // made: the next run makes nothing
  const again = await spareSetStep.run(h.ctx, { step: 2, data: {} });
  t.deepEqual(again, { status: 'done', text: 'the spare diamond set is in the chests (6 pieces)' });
});

test('the spare set is kept out of the kit, the trip kit and every take by name: reserved, and the other stacks taken by their slots', async (t) => {
  const { world, h } = await withSpareSet();
  const helmet = world.spareSet!.pieces.find(p => p.name === 'diamond_helmet')!;
  t.is(reservedCount(world, 'diamond_helmet'), 1);
  t.is(reservedCount(world, 'diamond_helmet', SPARE), 0, 'the regear\'s own takes count it');
  t.is(chestTotals(world).diamond_helmet, 1);
  t.false('diamond_helmet' in freeChestTotals(world));
  // the helmet worn out and gone: the kit crafts one, it takes none out of the chests
  const bare = kit().filter(i => i.slot !== 39);
  const need = kitNeeds(bare, freeChestTotals(world)).find(n => n.kind === 'helmet')!;
  t.like(need.plan[0], { craft: 'diamond_helmet' });
  t.like(kitNeeds(bare, chestTotals(world)).find(n => n.kind === 'helmet')!.plan[0], { take: 'diamond_helmet' }, 'counted as free, it would have been taken');
  // nothing to take by name while the spare is all there is
  t.is(await takeFromChests(h.ctx, 'diamond_helmet', 1), 0);
  // a worn one put in after it, in a slot after the spare's: taken by its own slot, never the spare's
  h.chests.get(GEAR2)!.push({ slot: 50, name: 'diamond_helmet', count: 1, damage: 200, maxDamage: 363 });
  remember(world, { x: -547, y: 64, z: 2182 }, { ...world.chestItems![GEAR2], diamond_helmet: 2 });
  t.is(await takeFromChests(h.ctx, 'diamond_helmet', 1), 1);
  t.true(h.did.includes(`chest.withdraw diamond_helmet slot 50 from ${GEAR2}`), h.did.slice(-4).join(' | '));
  t.like(h.chests.get(GEAR2)!.find(st => st.slot === helmet.slot), { name: 'diamond_helmet' });
  t.is(spareHeld(world).length, 6);
});

test('the spare set is kept out of the sort, the stash, the anvil and the enchant chore', async (t) => {
  const { world } = await withSpareSet();
  // the sort: in a chest of another kind (the gear chests were full), the pieces stay where the set says
  const misc = '-551,65,2179';
  const moved = structuredClone(world);
  moved.spareSet = { pieces: moved.spareSet!.pieces.map((p, i) => ({ ...p, chest: { x: -551, y: 65, z: 2179 }, slot: 30 + i })) };
  for (const p of moved.spareSet.pieces) { delete moved.chestItems![GEAR2][p.name]; moved.chestItems![misc][p.name] = 1; }
  delete moved.chestStacks;
  t.true(misplaced(moved.chestAssign!, moved.chestItems!).some(m => m.from === misc && m.name === 'diamond_helmet'), 'counted plainly, the sort would move it');
  t.false(misplaced(moved.chestAssign!, withoutSpare(moved)).some(m => /^diamond_/.test(m.name)));
  // the stash, the anvil and the enchant chore look at what is carried and worn only: the set stored changes nothing
  const s = lookAt(kit(), 1000, { xpLevel: 40 });
  const without = structuredClone(world);
  delete without.spareSet;
  for (const p of SPARE_SET) delete without.chestItems![GEAR2][p.name];
  delete without.chestStacks;
  t.deepEqual(stashPlan(kit(), stashKeep(world)), stashPlan(kit(), stashKeep(without)));
  t.deepEqual(planFor(s, world), planFor(s, without));
  t.is(enchantPick(kit(), 5)?.slot, 39, 'the worn plain helmet, never a stored spare');
});

test('a spare piece is a fresh one: a worn plain pickaxe beside the enchanted one in use, or old plain boots in the pockets, is none (the regear wants whole gear)', (t) => {
  const items = kit();
  t.is(spareCandidate([...items, { slot: 7, name: 'diamond_pickaxe', count: 1, damage: 1480, maxDamage: 1561 }], 'diamond_pickaxe'), undefined, 'a pickaxe at 5%');
  t.is(spareCandidate([...items, { slot: 8, name: 'diamond_boots', count: 1, damage: 400, maxDamage: 429 }], 'diamond_boots'), undefined, 'boots at 7%');
  // no wear said (an older jar): as new
  const told = { slot: 9, name: 'diamond_boots', count: 1 };
  t.is(spareCandidate([...items, told], 'diamond_boots'), told);
});

test('the spare set takes a fresh plain piece already lying in a home chest where it lies (the stash put away the one a cut-short run crafted): never crafted twice; a worn one there is no spare', async (t) => {
  const world = stocked();
  // the helmet crafted last run, put away by the stash before it was stored as the spare; old plain boots beside it
  Object.assign(world.chestItems![GEAR2], { diamond_helmet: 1, diamond_boots: 1 });
  const h = home(world, kit());
  const gear2 = { x: -547, y: 64, z: 2182 };
  const stacks = h.chests.get(GEAR2)!;
  stacks.find(st => st.name === 'diamond_boots')!.damage = 400;
  remember(world, gear2, { ...world.chestItems![GEAR2] }, stacks.map(st => ({ ...st })));
  const helmetSlot = stacks.find(st => st.name === 'diamond_helmet')!.slot;
  const r = await spareSetStep.run(h.ctx, { step: 2, data: {} });
  t.like(r, { status: 'done' });
  t.regex(r.text, new RegExp(`diamond_helmet \\(slot ${helmetSlot}, already in the chest at \\(-547, 64, 2182\\)\\)`));
  t.false(h.did.includes('craft-item diamond_helmet x1'), 'not crafted again');
  t.true(h.did.includes('craft-item diamond_boots x1'), 'the worn boots are no spare: fresh ones made');
  t.deepEqual(world.spareSet!.pieces.find(p => p.name === 'diamond_helmet'), { name: 'diamond_helmet', chest: gear2, slot: helmetSlot });
  const boots = world.spareSet!.pieces.find(p => p.name === 'diamond_boots')!;
  t.not(h.chests.get(key(boots.chest))!.find(st => st.slot === boots.slot)!.damage, 400);
  t.is(spareHeld(world).length, 6);
  t.is(64 - (chestTotals(world).diamond ?? 0) - h.inv.filter(i => i.name === 'diamond').reduce((a, i) => a + i.count, 0), 24, '29 less the helmet\'s 5');
});

test('a spare piece: a plain one carried that the kit is not using (armour never worn, a tool not the best), the most use left first', (t) => {
  const items = kit();
  t.is(spareCandidate(items, 'diamond_pickaxe'), undefined, 'the one pickaxe is enchanted');
  // a plain diamond pickaxe carried beside the enchanted one: the spare; the plain worn helmet is not (it is worn)
  const plainPick = { slot: 7, name: 'diamond_pickaxe', count: 1, damage: 0, maxDamage: 1561 };
  t.is(spareCandidate([...items, plainPick], 'diamond_pickaxe'), plainPick);
  t.is(spareCandidate(items, 'diamond_helmet'), undefined);
  // the pickaxe in use nearly worn out: a new plain one is the kit's now, not a spare
  const worn = items.map(i => (i.slot === 0 ? { ...i, damage: 1500 } : i));
  t.is(spareCandidate([...worn, plainPick], 'diamond_pickaxe'), undefined);
  // two plain helmets carried: the one with the most use left
  const h1 = { slot: 8, name: 'diamond_helmet', count: 1, damage: 100, maxDamage: 363 }, h2 = { slot: 9, name: 'diamond_helmet', count: 1, damage: 0, maxDamage: 363 };
  t.is(spareCandidate([...items, h1, h2], 'diamond_helmet'), h2);
});
