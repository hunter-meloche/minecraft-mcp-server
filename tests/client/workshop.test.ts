import test from 'ava';
import type { StructureSpec } from '../../src/client/schematic.js';
import { enchantRoom, workshop, type Side } from '../../src/client/brain/blueprints.js';
import { rawShort, type MilestoneState } from '../../src/client/brain/progress.js';
import { findLandmarks, type Pos, type WorldMemory } from '../../src/client/brain/memory.js';
import { fillWaterStep, workshopAnvil, workshopCell, workshopMilestone, workshopStanding } from '../../src/client/brain/workshop.js';
import { TREE } from '../../src/client/brain/tree.js';
import { projectGoal } from '../../src/client/brain/project.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { InventoryItem } from '../../src/client/tools.js';
import { HOME, liveWorld, lookAt, pocketsOf, withProject } from '../helpers/homestead.js';

/** The spec character at a cell ('.' past a short row, as layoutSpec pads). */
const cell = (spec: StructureSpec, p: Pos) => spec.layers[p.y]?.[p.z]?.[p.x] ?? '.';
const stateAt = (spec: StructureSpec, p: Pos) => spec.palette[cell(spec, p)];
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const SIDES: Side[] = ['south', 'west', 'north', 'east'];
/** One step in from a door on each side. */
const IN: Record<Side, { x: number; z: number }> = { south: { x: 0, z: -1 }, north: { x: 0, z: 1 }, east: { x: -1, z: 0 }, west: { x: 1, z: 0 } };

// ------------------------------------------------------------------------------------------------ the blueprint

test('workshop: 7 x 5 x 7 in the enchanting room\'s shell; crafting table, anvil and smithing table on the back wall, the stand and the water cell kept clear, no chest', (t) => {
  const w = workshop();
  t.is(w.name, 'workshop');
  t.deepEqual(w.size, { width: 7, height: 5, length: 7 });
  t.is(w.groundOffset, 1);
  const at = (kind: string) => w.landmarks.filter(l => l.kind === kind).map(l => l.at);
  t.deepEqual(at('table'), [{ x: 1, y: 0, z: 1 }]);
  t.deepEqual(at('anvil'), [{ x: 3, y: 0, z: 1 }]);
  t.deepEqual(at('smithing'), [{ x: 5, y: 0, z: 1 }]);
  t.deepEqual(at('stand'), [{ x: 1, y: 0, z: 3 }]);
  t.deepEqual(at('water'), [{ x: 1, y: -1, z: 4 }]);
  t.deepEqual(at('torch'), [{ x: 1, y: 0, z: 5 }, { x: 5, y: 0, z: 5 }]);
  t.deepEqual(at('door'), [{ x: 3, y: 0, z: 6 }]);
  t.is(w.landmarks.length, 8);
  t.is(stateAt(w.spec, { x: 1, y: 0, z: 1 }), 'crafting_table');
  // no facing named: the placer's look decides an anvil's, and the check compares only what a spec names
  t.is(stateAt(w.spec, { x: 3, y: 0, z: 1 }), 'anvil');
  t.is(stateAt(w.spec, { x: 5, y: 0, z: 1 }), 'smithing_table');
  for (const p of at('torch')) t.is(stateAt(w.spec, p), 'torch');
  // cleared: the stand's cell (P4 puts the brewing stand there), the cell over the water, the way in, the middle
  for (const p of [{ x: 1, y: 0, z: 3 }, { x: 1, y: 0, z: 4 }, { x: 3, y: 0, z: 5 }, { x: 3, y: 0, z: 3 }]) t.is(cell(w.spec, p), '.', fmt(p));
  // nothing that findLandmarks would take for home storage
  t.false(Object.values(w.spec.palette).some(s => /chest|barrel|shulker/.test(s)));
  t.deepEqual(w.entrances, [{ x: 3, y: 0, z: 6, facing: 'south' }]);
  // the enchanting room's walls, roof and door, cell for cell: only the inside differs
  const room = enchantRoom();
  for (let y = 0; y < 5; y++) for (let z = 0; z < 7; z++) for (let x = 0; x < 7; x++) {
    if (y < 4 && x > 0 && x < 6 && z > 0 && z < 6) continue;
    t.is(stateAt(w.spec, { x, y, z }), stateAt(room.spec, { x, y, z }), `shell ${x},${y},${z}`);
  }
});

test('workshop bill: an anvil (31 iron), a smithing table, a crafting table, the shell\'s 16 logs and 127 planks, a door and 2 torches; no bucket (the water is the next step\'s)', (t) => {
  const w = workshop();
  t.deepEqual(w.bill, { oak_log: 16, oak_planks: 127, oak_door: 1, torch: 2, crafting_table: 1, anvil: 1, smithing_table: 1 });
  t.deepEqual(rawShort({ anvil: w.bill.anvil }, {}), { iron_ingot: 31 });
  // and 2 more for the smithing table
  t.is(rawShort(w.bill, {}).iron_ingot, 33);
  // the live stores (Nov 14: 119 ingots, 3261 oak logs, 124 coal) cover it all
  t.deepEqual(rawShort(w.bill, { iron_ingot: 119, oak_log: 3261, coal: 124 }), {});
});

test('workshop turns with its door: each landmark keeps its block, the water stays in the ground beside the stand, the stand and the way in stay clear', (t) => {
  for (const side of SIDES) {
    const w = workshop({ doorSide: side });
    const at = (kind: string) => w.landmarks.find(l => l.kind === kind)!.at;
    const door = at('door');
    t.deepEqual(w.entrances, [{ ...door, facing: side }], side);
    t.is(stateAt(w.spec, door), `oak_door[facing=${side},half=lower]`, side);
    t.is(stateAt(w.spec, at('anvil')), 'anvil', side);
    t.is(stateAt(w.spec, at('smithing')), 'smithing_table', side);
    t.is(stateAt(w.spec, at('table')), 'crafting_table', side);
    for (const l of w.landmarks.filter(m => m.kind === 'torch')) t.is(stateAt(w.spec, l.at), 'torch', side);
    t.is(cell(w.spec, at('stand')), '.', side);
    const water = at('water');
    t.is(water.y, -1, side);
    t.is(cell(w.spec, { ...water, y: 0 }), '.', side);
    t.is(Math.abs(water.x - at('stand').x) + Math.abs(water.z - at('stand').z), 1, `${side}: the water beside the stand`);
    t.is(cell(w.spec, { x: door.x + IN[side].x, y: 0, z: door.z + IN[side].z }), '.', `${side}: the way in`);
    for (const l of w.landmarks.filter(m => m.kind !== 'door')) t.true(l.at.x >= 1 && l.at.x <= 5 && l.at.z >= 1 && l.at.z <= 5, `${side}: ${l.kind} inside the walls`);
  }
});

// ------------------------------------------------------------------------------------------------ a fake world

const GROUND = 62;
/** Blocks by position: dirt under the yard's ground, grass on it, air above; what is placed or dug over that. */
function fakeWorld() {
  const placed = new Map<string, string>();
  const k = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const get = (x: number, y: number, z: number) =>
    placed.get(k(x, y, z)) ?? (y < GROUND ? 'minecraft:dirt' : y === GROUND ? 'minecraft:grass_block[snowy=false]' : 'minecraft:air');
  return {
    get, set: (p: Pos, b: string) => placed.set(k(p.x, p.y, p.z), b),
    /** world.region: x fastest, then z, then y */
    region: (b: { x: number; y: number; z: number; width?: number; height?: number; length?: number }) => {
      const blocks: string[] = [];
      for (let y = 0; y < (b.height ?? 1); y++) for (let z = 0; z < (b.length ?? 1); z++) for (let x = 0; x < (b.width ?? 1); x++) blocks.push(get(b.x + x, b.y + y, b.z + z));
      return { blocks };
    },
    /** build-structure: the spec's cells at the origin ('.' clears, ' ' leaves) */
    build: (o: Pos, spec: StructureSpec) => spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => {
      if (ch !== ' ') placed.set(k(o.x + x, o.y + y, o.z + z), ch === '.' ? 'minecraft:air' : `minecraft:${spec.palette[ch]}`);
    })))
  };
}
type FakeWorld = ReturnType<typeof fakeWorld>;
type Vec = { x: number; y: number; z: number };

/** The point the bridge's useOn looks at for a click: the centre of the face clicked (Interact.faceCenter). */
const faceCenter = (b: Pos, face: string): Vec => {
  const n: Record<string, Vec> = { up: { x: 0, y: 1, z: 0 }, down: { x: 0, y: -1, z: 0 }, east: { x: 1, y: 0, z: 0 }, west: { x: -1, y: 0, z: 0 }, south: { x: 0, y: 0, z: 1 }, north: { x: 0, y: 0, z: -1 } };
  const d = n[face];
  return { x: b.x + 0.5 + d.x / 2, y: b.y + 0.5 + d.y / 2, z: b.z + 0.5 + d.z / 2 };
};

/**
 * Where a full bucket's water goes, as 26.3's BucketItem.use has it (it has no use on a block: the bridge's click falls
 * back to "use"): along the look from the eye toward the point the bridge aimed at, fluids passed by
 * (ClipContext.Fluid.NONE), as far as the reach of 4.5; the water goes beside the first block the line meets, on the
 * face it met. Every block but air and water is a whole cube here (the room's are; no line passes its torches).
 */
function pourTrace(fw: FakeWorld, eye: Vec, toward: Vec): Pos | undefined {
  const axes = ['x', 'y', 'z'] as const;
  const d = { x: toward.x - eye.x, y: toward.y - eye.y, z: toward.z - eye.z };
  const reach = 4.5 / Math.hypot(d.x, d.y, d.z);
  const v = { x: Math.floor(eye.x), y: Math.floor(eye.y), z: Math.floor(eye.z) };
  const step = { x: Math.sign(d.x), y: Math.sign(d.y), z: Math.sign(d.z) };
  const tMax = { x: Infinity, y: Infinity, z: Infinity }, tDelta = { x: Infinity, y: Infinity, z: Infinity };
  for (const a of axes) {
    if (!d[a]) continue;
    tDelta[a] = Math.abs(1 / d[a]);
    tMax[a] = ((d[a] > 0 ? v[a] + 1 : v[a]) - eye[a]) / d[a];
  }
  for (;;) {
    const a = axes.reduce((m, k) => (tMax[k] < tMax[m] ? k : m));
    if (tMax[a] > reach) return undefined;
    v[a] += step[a];
    tMax[a] += tDelta[a];
    if (!/^minecraft:(air|cave_air|water)/.test(fw.get(v.x, v.y, v.z))) return { ...v, [a]: v[a] - step[a] };
  }
}

/**
 * A run's context over the fake world: the pockets `inv` (a water bucket poured turns into a bucket), the bot `at`
 * (go-home takes it home, a careful walk where it went, or to `stop`: where a GoalNear walk ends, short of its target),
 * and what it did, in order, in `did`. A pour goes where pourTrace says from the bot's eye (`eye`: its spot in the
 * cell, and its height: 1.27 sneaking, which the bridge does with the shield in the off-hand and a bucket, else 1.62).
 * `serverH`: the height of the eye the server traces from, along the look the bridge aimed from `eye` (live, Nov 14:
 * the server's was the standing one as the bridge crouched for the use, 0.35 higher than the aim's).
 */
function runCtx(world: WorldMemory, s: Snapshot, fw: FakeWorld, opts: {
  inv: InventoryItem[]; at?: Pos; arrive?: boolean; dig?: { dug: boolean; reason?: string }; pours?: boolean; stop?: Pos; eye?: { dx: number; dz: number; h?: number }; serverH?: number;
  /** where a pour's water goes, whatever the look (a stray pour) */
  pourAt?: Pos;
}) {
  const did: string[] = [];
  let at: Pos = opts.at ?? s.position;
  const inv = opts.inv;
  const ctx = {
    s, world, signal: new AbortController().signal, progress: () => undefined, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'claudebot', screen: null, position: at, dimension: 'overworld' }),
    call: async (m: string, p: Record<string, unknown> = {}) => {
      const pos = { x: p.x as number, y: p.y as number, z: p.z as number };
      if (m === 'world.region') return fw.region(p as never);
      if (m === 'inventory') return { items: inv };
      if (m === 'status') return { position: at, dimension: 'overworld' };
      if (m === 'goto') {
        did.push(`goto ${fmt(pos)} range ${p.range}${p.careful ? ' careful' : ''}`);
        if (opts.arrive === false) return { arrived: false };
        at = opts.stop ?? pos;
        return { arrived: true, at };
      }
      if (m === 'dig.here') {
        did.push(`dig.here ${fmt(pos)}`);
        const r = opts.dig ?? { dug: true };
        if (r.dug) fw.set(pos, 'minecraft:air');
        return r;
      }
      did.push(`call ${m}`);
      return {};
    },
    act: async (tool: string, a: Record<string, unknown>) => {
      const pos = { x: a.x as number, y: a.y as number, z: a.z as number };
      if (tool === 'go-home') { did.push('go-home'); at = { ...HOME }; return { ok: true, text: 'Arrived at home' }; }
      if (tool === 'build-structure') {
        did.push(`build-structure ${a.name} at ${fmt(pos)}`);
        fw.build(pos, a.spec as StructureSpec);
        return { ok: true, text: `Built ${a.name} at ${fmt(pos)} in 41s: all 214 blocks in place. Used: oak_planks x127, oak_log x16, anvil x1.` };
      }
      if (tool === 'use-item-on-block') {
        did.push(`use-item-on-block ${a.item} on ${fmt(pos)} face ${a.face}`);
        const was = fw.get(pos.x, pos.y, pos.z).replace(/^minecraft:/, '');
        const shield = inv.some(i => i.slot === 40 && i.name === 'shield');
        const e = opts.eye ?? { dx: 0, dz: 0 };
        const eye = { x: at.x + 0.5 + e.dx, y: at.y + (e.h ?? (shield ? 1.27 : 1.62)), z: at.z + 0.5 + e.dz };
        const hit = faceCenter(pos, a.face as string);
        if (Math.hypot(hit.x - eye.x, hit.y - eye.y, hit.z - eye.z) > 4.5) { did.push('too far'); return { ok: false, text: `Could not use ${a.item} on ${fmt(pos)}: too far` }; }
        const from = opts.serverH === undefined ? eye : { ...eye, y: at.y + opts.serverH };
        const into = a.item === 'water_bucket' && opts.pours !== false
          ? opts.pourAt ?? pourTrace(fw, from, { x: from.x + hit.x - eye.x, y: from.y + hit.y - eye.y, z: from.z + hit.z - eye.z }) : undefined;
        if (into && /^minecraft:(air|cave_air|water)/.test(fw.get(into.x, into.y, into.z))) {
          fw.set(into, 'minecraft:water[level=0]');
          const b = inv.find(i => i.name === 'water_bucket');
          if (b) b.name = 'bucket';
          return { ok: true, text: `Used water_bucket on ${was} at ${fmt(pos)}: it became ${fw.get(pos.x, pos.y, pos.z).replace(/^minecraft:/, '')}` };
        }
        return { ok: true, text: `Used ${a.item} on ${was} at ${fmt(pos)}; nothing changed, it is ${was}` };
      }
      if (tool === 'place-block') {
        did.push(`place-block ${a.item} at ${fmt(pos)}`);
        fw.set(pos, `minecraft:${a.item as string}`);
        return { ok: true, text: `Placed ${a.item as string} at ${fmt(pos)} using down face` };
      }
      if (tool === 'dig-block') {
        did.push(`dig-block ${fmt(pos)}`);
        const was = fw.get(pos.x, pos.y, pos.z).replace(/^minecraft:/, '');
        fw.set(pos, 'minecraft:air');
        return { ok: true, text: `Dug ${was} at ${fmt(pos)}` };
      }
      did.push(`act ${tool}`);
      return { ok: false, text: `unexpected ${tool}` };
    }
  } as unknown as GoalContext;
  return { ctx, did };
}

const slot = (items: [string, number][], from: number): InventoryItem[] => items.map(([name, count], i) => ({ slot: from + i, name, count }));

// ------------------------------------------------------------------------------------------------ the milestone

/** The live homestead (liveWorld) with the enchanting room done and built where it stands, nothing in hand. */
function afterEnchanting(): WorldMemory {
  const w = withProject(liveWorld(), false);
  const p = w.progress!;
  p.done.push('enchanting');
  p.current = undefined;
  p.journal = [];
  w.zones!.enchanting = [{ x: -547, y: 62, z: 2206, width: 7, length: 7 }];
  return w;
}

test('the workshop is the tree\'s last milestone, after the enchanting room: its site, its build, its water; with the room done it is next', (t) => {
  const m = TREE.at(-1)!;
  t.is(m.id, 'workshop');
  t.is(m.title, 'a workshop');
  t.deepEqual(m.prereqs, ['enchanting']);
  t.deepEqual(m.steps.map(s => s.name), ['find room for the workshop', 'build the workshop', 'fill the water cell']);
  t.is(TREE.filter(x => x.id === 'workshop').length, 1);
  const s = lookAt(pocketsOf(10, true, 'kept things only'), 1000);
  t.is(projectGoal(TREE).wants(s, afterEnchanting()), 'a workshop: find room for the workshop');
  // not before the room: the room in hand, the workshop waits for it
  t.is(projectGoal(TREE).wants(s, withProject(liveWorld(), false)), 'an enchanting room: build the enchanting room');
});

test('the live homestead: a site in the yard, the build with its door toward home, the water poured; "a workshop complete", every landmark\'s zone on its block', async (t) => {
  const world = afterEnchanting();
  const fw = fakeWorld();
  // the kit, the bill made already (the anvil crafted from 31 iron: the build step's own making is project.ts's), and
  // the water bucket the stash keeps
  const items = [...pocketsOf(10, true, 'kept things only').filter(i => i.slot < 36), ...slot([
    ['anvil', 1], ['smithing_table', 1], ['crafting_table', 1], ['oak_door', 1], ['oak_log', 16], ['oak_planks', 64], ['oak_planks', 64], ['water_bucket', 1]
  ], 10)];
  const s = lookAt(items, 1000);
  const goal = projectGoal(TREE);
  const { ctx, did } = runCtx(world, s, fw, { inv: items });
  const m = TREE.at(-1)!;
  const view = () => ({ s, world, have: () => 0 });

  t.regex(await goal.run(ctx), /^a workshop - find room for the workshop: workshop goes at \(-?\d+, 62, \d+\)$/);
  const site = world.progress!.current!.data.site as { x: number; y: number; z: number; width: number; length: number };
  t.like(site, { y: 62, width: 7, length: 7 });
  const yard = world.yard!;
  t.true(site.x >= yard.x1 && site.x + 7 - 1 <= yard.x2 && site.z >= yard.z1 && site.z + 7 - 1 <= yard.z2);
  // two blocks clear of every build and farm (the fence is the ring round them all)
  for (const [kind, zs] of Object.entries(world.zones!)) for (const z of zs.filter(b => b.width && b.length && kind !== 'fence')) {
    const apart = site.x + 7 + 2 <= z.x || z.x + z.width! + 2 <= site.x || site.z + 7 + 2 <= z.z || z.z + z.length! + 2 <= site.z;
    t.true(apart, `clear of ${kind}`);
  }

  t.regex(await goal.run(ctx), /^a workshop - build the workshop: workshop built at /);
  const door = world.progress!.current!.data.door as Side;
  // toward home: home is beyond the door's wall, on the axis home is furthest along
  const cx = site.x + 3.5, cz = site.z + 3.5;
  const toward: Side = Math.abs(HOME.x - cx) > Math.abs(HOME.z - cz) ? (HOME.x < cx ? 'west' : 'east') : (HOME.z < cz ? 'north' : 'south');
  t.is(door, toward);
  t.true(did.includes(`build-structure workshop at (${site.x}, 63, ${site.z})`), 'a block over the ground');
  t.deepEqual(world.zones!.workshop, [{ x: site.x, y: 62, z: site.z, width: 7, length: 7 }]);
  // the zone is down a step before the water: not done on it yet
  t.false(m.done!(view()));
  t.is(goal.wants(s, world), 'a workshop: fill the water cell');

  t.is(await goal.run(ctx), 'a workshop complete');
  t.true(m.done!(view()));
  t.true(world.progress!.done.includes('workshop'));
  t.is(world.progress!.current, undefined);
  t.true(world.progress!.journal.some(j => j.text === 'done: a workshop'));
  // every landmark's zone holds what the blueprint put there, which way the door faces whatever
  const z = world.zones!;
  const block = (p: Pos) => fw.get(p.x, p.y, p.z).replace(/^minecraft:/, '');
  t.is(block(z['workshop:anvil'][0]), 'anvil');
  t.is(block(z['workshop:smithing'][0]), 'smithing_table');
  t.is(block(z['workshop:table'][0]), 'crafting_table');
  t.is(z['workshop:torch'].length, 2);
  for (const p of z['workshop:torch']) t.is(block(p), 'torch');
  t.is(block(z['workshop:door'][0]), `oak_door[facing=${door},half=lower]`);
  t.is(block(z['workshop:stand'][0]), 'air');
  t.is(z['workshop:water'][0].y, 62, 'in the floor');
  t.is(block(z['workshop:water'][0]), 'water[level=0]');
  t.false(Object.keys(z).some(k => /^workshop:chest/.test(k)));
  // into the room on foot to the cell beside the hole, the floor block dug from there, the water poured at the inner
  // face of the floor block across it
  const water = z['workshop:water'][0];
  const [walk, dig, pour] = did.slice(-3);
  const at = /^goto \((-?\d+), 63, (-?\d+)\) range 0 careful$/.exec(walk);
  t.truthy(at, walk);
  t.is(Math.abs(Number(at![1]) - water.x) + Math.abs(Number(at![2]) - water.z), 1, 'beside the hole');
  const bx = Number(at![1]), bz = Number(at![2]);
  const far = { x: 2 * water.x - bx, y: water.y, z: 2 * water.z - bz };
  const face = bx < water.x ? 'west' : bx > water.x ? 'east' : bz < water.z ? 'north' : 'south';
  t.deepEqual([dig, pour], [`dig.here ${fmt(water)}`, `use-item-on-block water_bucket on ${fmt(far)} face ${face}`]);
  // and nothing left in the tree
  t.is(goal.wants(s, world), null);
  t.like(goal.declines!(s, world), { cause: 'unneeded', text: `all ${TREE.length} milestone(s) done` });
});

test('the build puts each landmark\'s zone on its block whichever way the door faces, and the water step finds its cell where the build put it', async (t) => {
  const m = workshopMilestone(['enchanting']);
  for (const side of SIDES) {
    const world = afterEnchanting();
    const fw = fakeWorld();
    const items = slot([['anvil', 1], ['smithing_table', 1], ['crafting_table', 1], ['oak_door', 1], ['oak_log', 16], ['oak_planks', 64], ['oak_planks', 64], ['torch', 8]], 0);
    const s = lookAt(items, 1000);
    const st: MilestoneState = { step: 1, data: { site: { x: -560, y: 62, z: 2130, width: 7, length: 7, rotated: false }, door: side } };
    const { ctx } = runCtx(world, s, fw, { inv: items });
    t.like(await m.steps[1].run(ctx, st), { status: 'done' }, side);
    const z = world.zones!;
    const block = (p: Pos) => fw.get(p.x, p.y, p.z).replace(/^minecraft:/, '');
    t.is(block(z['workshop:anvil'][0]), 'anvil', side);
    t.is(block(z['workshop:smithing'][0]), 'smithing_table', side);
    t.is(block(z['workshop:door'][0]), `oak_door[facing=${side},half=lower]`, side);
    t.is(block(z['workshop:stand'][0]), 'air', side);
    t.is(block({ ...z['workshop:water'][0], y: 63 }), 'air', `${side}: the cell over the water`);
    t.is(block(z['workshop:water'][0]), 'grass_block[snowy=false]', `${side}: the floor, to dig out`);
    t.deepEqual(workshopCell(st, 'water'), z['workshop:water'][0], side);
    t.deepEqual(workshopCell(st, 'anvil'), z['workshop:anvil'][0], side);
  }
});

// ------------------------------------------------------------------------------------------------ done

const yardWorld = (over: Partial<WorldMemory> = {}): WorldMemory =>
  ({ landmarks: { chests: [], farmland: [] }, leash: 96, yard: { x1: 0, z1: 0, x2: 30, z2: 30, y: GROUND }, zones: {}, progress: { done: [], journal: [] }, ...over }) as WorldMemory;
/** The landmarks round home as the look finds them in a box at the floor's height. */
const looked = (blocks: [Pos, string][]) => {
  const box = { x: -10, y: GROUND + 1, z: -10, width: 60, height: 1, length: 60 };
  const cells: (string | null)[] = new Array(box.width * box.length).fill('minecraft:air');
  for (const [p, b] of blocks) cells[(p.x - box.x) + (p.z - box.z) * box.width] = b;
  return findLandmarks(box, cells, { x: 15, y: GROUND + 1, z: 15 });
};
const doneIn = (world: WorldMemory) => workshopMilestone(['enchanting']).done!({ s: lookAt([], 1000), world, have: () => 0 });
const A = { x: 4, y: GROUND + 1, z: 4 }, S = { x: 6, y: GROUND + 1, z: 4 };

test('done: an anvil and a smithing table the improvement run put up in the yard count, chipped or not; one alone, one outside the yard, or this milestone\'s own mid-build do not', (t) => {
  t.false(doneIn(yardWorld()));
  t.true(doneIn(yardWorld({ landmarks: looked([[A, 'minecraft:anvil[facing=north]'], [S, 'minecraft:smithing_table']]) })));
  t.true(doneIn(yardWorld({ landmarks: looked([[A, 'minecraft:chipped_anvil[facing=east]'], [S, 'minecraft:smithing_table']]) })));
  t.true(doneIn(yardWorld({ landmarks: looked([[A, 'minecraft:damaged_anvil[facing=east]'], [S, 'minecraft:smithing_table']]) })));
  t.false(doneIn(yardWorld({ landmarks: looked([[A, 'minecraft:anvil[facing=north]']]) })), 'an anvil alone');
  t.false(doneIn(yardWorld({ landmarks: looked([[S, 'minecraft:smithing_table']]) })), 'a smithing table alone');
  t.false(doneIn(yardWorld({ landmarks: looked([[{ ...A, x: 40 }, 'minecraft:anvil'], [S, 'minecraft:smithing_table']]) })), 'the anvil outside the yard');
  // its own, placed before the walls were done: the look every 10 minutes must not end the milestone half built
  const own = { x: 2, y: GROUND, z: 2, width: 7, length: 7, rotated: false };
  const both = looked([[A, 'minecraft:anvil'], [S, 'minecraft:smithing_table']]);
  t.false(doneIn(yardWorld({ landmarks: both, progress: { done: [], journal: [], current: { id: 'workshop', step: 1, data: { site: own } } } })), 'its own, in hand');
  t.false(doneIn(yardWorld({ landmarks: both, progress: { done: [], journal: [], aside: { workshop: { step: 1, data: { site: own } } } } })), 'its own, set aside');
  t.false(doneIn(yardWorld({ landmarks: both, zones: { workshop: [own] }, progress: { done: [], journal: [], current: { id: 'workshop', step: 2, data: { site: own } } } })), 'its own, the water still to pour');
  // another milestone's site there is no reason: those are someone else's workshop
  t.true(doneIn(yardWorld({ landmarks: both, progress: { done: [], journal: [], current: { id: 'nether-portal', step: 1, data: { site: own } } } })));
});

test('done: the zone, once the water is in: not while the milestone is at the water (in hand or set aside), done again after a restart that kept the zone', (t) => {
  const zone = { workshop: [{ x: 2, y: GROUND, z: 2, width: 7, length: 7 }] };
  t.false(doneIn(yardWorld({ zones: zone, progress: { done: [], journal: [], current: { id: 'workshop', step: 2, data: {} } } })));
  t.false(doneIn(yardWorld({ zones: zone, progress: { done: [], journal: [], aside: { workshop: { step: 2, data: {} } } } })));
  t.true(doneIn(yardWorld({ zones: zone })));
  t.true(doneIn(yardWorld({ zones: zone, progress: { done: [], journal: [], current: { id: 'hall', step: 1, data: {} } } })));
  // the gate only looks: nothing written
  const w = yardWorld({ zones: zone, progress: { done: [], journal: [], current: { id: 'workshop', step: 2, data: {} } } });
  const before = JSON.stringify(w);
  doneIn(w);
  t.is(JSON.stringify(w), before);
});

test('findLandmarks: the nearest anvil (any of the three) and smithing table; none, and the landmarks are as they were, key for key', (t) => {
  const l = looked([[{ x: 30, y: GROUND + 1, z: 30 }, 'minecraft:anvil[facing=north]'], [{ x: 14, y: GROUND + 1, z: 15 }, 'minecraft:damaged_anvil[facing=west]'], [S, 'minecraft:smithing_table']]);
  t.deepEqual(l.anvil, { x: 14, y: GROUND + 1, z: 15 });
  t.deepEqual(l.smithing, S);
  t.deepEqual(looked([[{ x: 1, y: GROUND + 1, z: 1 }, 'minecraft:crafting_table']]), { chests: [], farmland: [], bed: undefined, furnace: undefined, table: { x: 1, y: GROUND + 1, z: 1 } });
});

test('workshopAnvil: the workshop\'s anvil cell, whatever stands there; else an anvil standing in the yard; else none', (t) => {
  const cellA = { x: 5, y: GROUND + 1, z: 3 };
  t.deepEqual(workshopAnvil(yardWorld({ zones: { 'workshop:anvil': [cellA] }, landmarks: looked([[A, 'minecraft:anvil']]) })), cellA);
  t.deepEqual(workshopAnvil(yardWorld({ landmarks: looked([[A, 'minecraft:chipped_anvil']]) })), A);
  t.is(workshopAnvil(yardWorld({ landmarks: looked([[{ ...A, x: 40 }, 'minecraft:anvil']]) })), undefined);
  t.is(workshopAnvil(yardWorld()), undefined);
  t.true(workshopStanding(yardWorld({ landmarks: looked([[A, 'minecraft:anvil'], [S, 'minecraft:smithing_table']]) })));
});

// ------------------------------------------------------------------------------------------------ the water

/** The fill step on a workshop at (-560, 62, 2130), door south: its water cell is (-559, 62, 2134), its middle (-557, 63, 2133). */
const SITE_ST = (): MilestoneState => ({ step: 2, data: { site: { x: -560, y: 62, z: 2130, width: 7, length: 7, rotated: false }, door: 'south', wood: 'oak' } });
const WATER = { x: -559, y: 62, z: 2134 };
const bare = (): WorldMemory => ({ landmarks: { chests: [], farmland: [] }, leash: 96, yard: { x1: -565, z1: 2119, x2: -533, z2: 2215, y: GROUND } }) as WorldMemory;

test('the water: in the yard, a pickaxe in hand for the walk, on foot to the cell beside the hole, the floor block dug from there, the water poured at the far side\'s inner face', async (t) => {
  const fw = fakeWorld();
  t.deepEqual(workshopCell(SITE_ST(), 'water'), WATER);
  const inv = slot([['water_bucket', 1], ['diamond_pickaxe', 1]], 0);
  const { ctx, did } = runCtx(bare(), lookAt(inv, 1000), fw, { inv, serverH: 1.62 });
  t.deepEqual(await fillWaterStep.run(ctx, SITE_ST()), { status: 'done', text: 'water in the workshop\'s floor at (-559, 62, 2134)' });
  // the cell beside the hole nearest the middle (-557, 63, 2133)
  // aimed at the inner face of the floor block across the hole
  t.deepEqual(did, ['call item.select', 'goto (-558, 63, 2134) range 0 careful', 'dig.here (-559, 62, 2134)', 'use-item-on-block water_bucket on (-560, 62, 2134) face east']);
  t.is(fw.get(WATER.x, WATER.y, WATER.z), 'minecraft:water[level=0]');
  // and once it is in, the step is done with nothing walked or poured
  const again = runCtx(bare(), lookAt(inv, 1000), fw, { inv });
  t.deepEqual(await fillWaterStep.run(again.ctx, SITE_ST()), { status: 'done', text: 'the water is in at (-559, 62, 2134)' });
  t.deepEqual(again.did, []);
});

test('the water goes into the cell from beside the hole, whichever way the door faces, anywhere in the cell, aimed from either eye and traced by the server from its own; from the middle at the opening the server\'s higher look put it on the floor over the hole (live)', async (t) => {
  for (const side of SIDES) {
    const st = (): MilestoneState => ({ ...SITE_ST(), data: { ...SITE_ST().data, door: side } });
    const site = st().data.site as Pos;
    const water = workshopCell(st(), 'water')!;
    const middle = { x: site.x + 3, y: 63, z: site.z + 3 };
    for (const dx of [-0.3, 0, 0.3]) for (const dz of [-0.3, 0, 0.3]) for (const [h, serverH] of [[1.27, 1.62], [1.27, 1.27], [1.62, 1.62]]) {
      const fw = fakeWorld();
      fw.build({ x: site.x, y: 63, z: site.z }, workshop({ doorSide: side }).spec);
      const inv = slot([['water_bucket', 1]], 0);
      const { ctx, did } = runCtx(bare(), lookAt(inv, 1000), fw, { inv, eye: { dx, dz, h }, serverH });
      const r = await fillWaterStep.run(ctx, st());
      const where = `${side} door, +${dx},${dz}, aimed at ${h}, traced at ${serverH}`;
      t.like(r, { status: 'done' }, where);
      t.is(fw.get(water.x, water.y, water.z), 'minecraft:water[level=0]', where);
      t.is(fw.get(water.x, water.y + 1, water.z), 'minecraft:air', `${where}: nothing on the floor over it`);
      t.false(did.includes('too far'), where);
      t.true(did.some(d => /range 0 careful$/.test(d)), `${where}: beside the hole`);
    }
    // the old aim, at the hole's opening from the middle, crouched; the server's look from the standing eye along it
    // went over the hole: the water stood on the floor over it (live, Nov 14, the workshop at (-546, 62, 2152))
    const fw = fakeWorld();
    fw.build({ x: site.x, y: 63, z: site.z }, workshop({ doorSide: side }).spec);
    fw.set(water, 'minecraft:air');
    const aimEye = { x: middle.x + 0.5, y: 63 + 1.27, z: middle.z + 0.5 };
    const hit = faceCenter(water, 'up');
    const from = { ...aimEye, y: 63 + 1.62 };
    const into = pourTrace(fw, from, { x: from.x + hit.x - aimEye.x, y: from.y + hit.y - aimEye.y, z: from.z + hit.z - aimEye.z });
    t.notDeepEqual(into, water, `${side}: the old aim from the middle`);
  }
});

test('the water: no cell beside the hole free, from the middle at the opening as before; a pour that stood on the floor over the hole is plugged and dug out, and the step waits', async (t) => {
  const fw = fakeWorld();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) fw.set({ x: WATER.x + dx, y: 63, z: WATER.z + dz }, 'minecraft:stone');
  const inv = slot([['water_bucket', 1], ['cobblestone', 12]], 0);
  const over = { ...WATER, y: WATER.y + 1 };
  const { ctx, did } = runCtx(bare(), lookAt(inv, 1000), fw, { inv, pourAt: over });
  const r = await fillWaterStep.run(ctx, SITE_ST());
  t.deepEqual(did, [
    'goto (-557, 63, 2133) range 1 careful', 'dig.here (-559, 62, 2134)', 'use-item-on-block water_bucket on (-559, 62, 2134) face up',
    // the water stood on the floor over the hole: plugged and dug out again, the floor clear
    'place-block cobblestone at (-559, 63, 2134)', 'dig-block (-559, 63, 2134)'
  ]);
  t.is(fw.get(over.x, over.y, over.z), 'minecraft:air');
  t.like(r, { status: 'blocked', retryMs: 10 * 60_000 });
  // nothing to plug it with: said, and still a wait
  const fw2 = fakeWorld();
  const bare2 = slot([['water_bucket', 1]], 0);
  const lines: string[] = [];
  const two = runCtx(bare(), lookAt(bare2, 1000), fw2, { inv: bare2, pourAt: over });
  two.ctx.progress = (l: string) => { lines.push(l); };
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) fw2.set({ x: WATER.x + dx, y: 63, z: WATER.z + dz }, 'minecraft:stone');
  t.like(await fillWaterStep.run(two.ctx, SITE_ST()), { status: 'blocked' });
  t.false(two.did.some(d => /^place-block/.test(d)));
  t.true(lines.some(l => /not plugged \(no block to plug it with\)/.test(l)), lines.join(' | '));
});

test('the water: the bucket filled at the lake outside the fence, home by go-home first (in by a gate), then on foot', async (t) => {
  const fw = fakeWorld();
  const inv = slot([['water_bucket', 1]], 0);
  const { ctx, did } = runCtx(bare(), lookAt(inv, 1000), fw, { inv, at: { x: -520, y: 62, z: 2230 } });
  t.like(await fillWaterStep.run(ctx, SITE_ST()), { status: 'done' });
  t.deepEqual(did.slice(0, 2), ['go-home', 'goto (-558, 63, 2134) range 0 careful']);
});

test('the water: no bucket anywhere, it waits for the iron for one as the crop plot\'s does; no way in on foot, it waits and digs nothing; a pour that did not take waits', async (t) => {
  const fw = fakeWorld();
  // no bucket carried or stored, no ingot, no furnace: the crop plot's bucket step says what it is short of
  const none = runCtx(bare(), lookAt([], 1000), fw, { inv: [] });
  t.like(await fillWaterStep.run(none.ctx, SITE_ST()), { status: 'blocked', text: 'gathering for a bucket: short of 3 iron_ingot', need: { iron_ingot: 3 } });
  t.false(none.did.some(d => /goto|dig|use-item/.test(d)));

  const inv = () => slot([['water_bucket', 1]], 0);
  const shut = runCtx(bare(), lookAt(inv(), 1000), fw, { inv: inv(), arrive: false });
  t.like(await fillWaterStep.run(shut.ctx, SITE_ST()), { status: 'blocked', text: 'no way on foot into the workshop to pour its water at (-559, 62, 2134)', retryMs: 10 * 60_000 });
  t.deepEqual(shut.did, ['goto (-558, 63, 2134) range 0 careful']);

  const hard = runCtx(bare(), lookAt(inv(), 1000), fw, { inv: inv(), dig: { dug: false, reason: 'out of reach or out of sight' } });
  t.like(await fillWaterStep.run(hard.ctx, SITE_ST()), { status: 'blocked', text: 'could not dig out the grass_block[snowy=false] for the water at (-559, 62, 2134): out of reach or out of sight' });
  t.false(hard.did.some(d => /use-item/.test(d)));

  const dry = runCtx(bare(), lookAt(inv(), 1000), fw, { inv: inv(), pours: false });
  t.like(await fillWaterStep.run(dry.ctx, SITE_ST()), { status: 'blocked', retryMs: 10 * 60_000 });
  t.regex((await fillWaterStep.run(dry.ctx, SITE_ST()) as { text: string }).text, /^pouring the water at \(-559, 62, 2134\): Used water_bucket/);
});
