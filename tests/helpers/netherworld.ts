/**
 * The two dimensions as the bridge and the tools answer for them, for the Nether trips' tests (nethersetup.test.ts,
 * netherramp.test.ts): the live yard with the home portal lit, the Nether round home's scaled point (netherrack, a
 * cliff, a lava pool, the community's stone-brick room round their portal), the server's rule for where a portal
 * leads, chests by their totals, digging, placing and lighting.
 */
import type { InventoryItem } from '../../src/client/tools.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import { SETUP_OBSIDIAN, type Box, type Grid, type NetherZone } from '../../src/client/brain/nethersetup.js';
import { NETHER, OVERWORLD, SEARCH, linkedTo, portalCells, scaled, type PortalShape } from '../../src/client/brain/nether.js';
import { HOME, KEPT, T0, WORN, liveWorld, lookAt, withProject } from './homestead.js';

// ------------------------------------------------------------------------------------------------ the worlds

/**
 * The home portal as the portal milestone builds it on the live yard (as nether.test.ts has it), and the community's
 * pair: in this world their Nether-side portal stands some 16 from home's scaled point (the home portal comes out
 * there, as live), in a small room of stone bricks with a doorway west, and their overworld portal is the one that
 * leads into it (its Nether side known).
 */
export const HOME_PORTAL: PortalShape = { x: -562, y: 63, z: 2191, axis: 'z', width: 2, height: 3 };
export const CZ = 285;
export const COMMUNITY_NETHER: PortalShape = { x: -56, y: 70, z: CZ, axis: 'x', width: 2, height: 3 };
export const COMMUNITY: PortalShape = { x: -445, y: 68, z: 2283, axis: 'x', width: 2, height: 3 };
/** Their room's zone as the bridge's scan makes it: the stone bricks' box and its margin of 4. */
export const ROOM_ZONE: NetherZone = { x1: -63, y1: 67, z1: CZ - 7, x2: -48, y2: 78, z2: CZ + 7, markers: 120, surface: true, sample: 'stone_bricks' };

export const k = (p: Pos) => `${p.x},${p.y},${p.z}`;
export const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;

/** The obsidian frame round a portal (bottom, top, the two sides). */
export function frameOf(p: PortalShape): Pos[] {
  const at = (a: number, u: number) => (p.axis === 'x' ? { x: p.x + a, y: p.y + u, z: p.z } : { x: p.x, y: p.y + u, z: p.z + a });
  return [at(0, -1), at(1, -1), at(0, 3), at(1, 3), ...[0, 1, 2].flatMap(u => [at(-1, u), at(2, u)])];
}

/**
 * The Nether round home's scaled point: netherrack to y 69 (the floor), a ceiling from y 90, a cliff of netherrack
 * west of x -77, a lava pool in the floor at x -66..-63, z 277..281; the community's room (open, or `closed`: no
 * doorway). Bedrock at the bottom and the top.
 */
export function netherGround(closed = false): (p: Pos) => string {
  const room = new Map<string, string>();
  for (let x = -59; x <= -52; x++) for (let z = CZ - 3; z <= CZ + 3; z++) for (let y = 70; y <= 74; y++) {
    const wall = x === -59 || x === -52 || z === CZ - 3 || z === CZ + 3 || y === 74;
    const door = !closed && x === -59 && z === CZ && (y === 70 || y === 71);
    room.set(k({ x, y, z }), wall && !door ? 'stone_bricks' : 'air');
  }
  for (const f of frameOf(COMMUNITY_NETHER)) room.set(k(f), 'obsidian');
  return p => {
    const r = room.get(k(p));
    if (r) return r;
    if (p.y <= 0 || p.y >= 127) return 'bedrock';
    if (p.y <= 69) return p.y === 69 && p.x >= -66 && p.x <= -63 && p.z >= 277 && p.z <= 281 ? 'lava[level=0]' : 'netherrack';
    if (p.y >= 90 || p.x <= -77) return 'netherrack';
    return 'air';
  };
}

/** The overworld round home: grass at 62, dirt under it, air over it, and the frames of the portals that stand there. */
export function overworldGround(portals: PortalShape[]): (p: Pos) => string {
  const frames = new Set(portals.flatMap(frameOf).map(k));
  return p => (frames.has(k(p)) ? 'obsidian' : p.y < 62 ? 'dirt' : p.y === 62 ? 'grass_block' : 'air');
}

/** A grid of a world's blocks (the shape world.region gives). */
export function gridOf(get: (p: Pos) => string, b: Box): Grid {
  const blocks: string[] = [];
  for (let y = b.y1; y <= b.y2; y++) for (let z = b.z1; z <= b.z2; z++) for (let x = b.x1; x <= b.x2; x++) blocks.push(`minecraft:${get({ x, y, z })}`);
  return { x: b.x1, y: b.y1, z: b.z1, width: b.x2 - b.x1 + 1, height: b.y2 - b.y1 + 1, length: b.z2 - b.z1 + 1, blocks };
}

/** The live world with the portal milestone done (the home portal lit), the switch on, the community's overworld portal seen. */
export function setupWorld(): WorldMemory {
  const w = withProject(liveWorld(), false);
  w.progress!.done.push('enchanting', 'workshop', 'nether-portal');
  delete w.progress!.current;
  w.zones!.portal = [{ x: -563, y: 62, z: 2189, width: 3, length: 6 }];
  w.zones!['portal:frame'] = [{ x: HOME_PORTAL.x, y: HOME_PORTAL.y, z: HOME_PORTAL.z }];
  w.zones!['portal:lit'] = [{ x: HOME_PORTAL.x, y: HOME_PORTAL.y, z: HOME_PORTAL.z }];
  w.nether = { trips: true, seen: { [OVERWORLD]: [{ ...COMMUNITY }] } };
  // what the portal milestone left in the chests for the trips: the golden helmet, the second flint and steel, the
  // frame's 10 obsidian
  Object.assign(w.chestItems!['-547,64,2182'], { golden_helmet: 1, flint_and_steel: 1 });
  w.chestItems!['-547,64,2180'].obsidian = SETUP_OBSIDIAN;
  return w;
}

export const KIT: InventoryItem[] = [...KEPT.map(([name, count], slot) => ({ slot, name, count })), ...WORN.map(i => ({ ...i }))];
export const stackSize = (n: string) => (/_(pickaxe|sword|helmet|chestplate|leggings|boots|shovel|axe|hoe)$|^(flint_and_steel|shield)$/.test(n) ? 1 : 64);

// ------------------------------------------------------------------------------------------------ the fake game

export type Dim = typeof OVERWORLD | typeof NETHER;
export interface Lit extends PortalShape { dim: Dim }

/**
 * Both dimensions as the bridge and the tools answer for them: blocks (a world's ground and what was dug or placed
 * over it), the lit portals and the server's rule for where each leads (nether.ts linkedTo: 16 round the scaled point
 * into the Nether, 128 out), the home chests by their stacks, the pockets, the foreign zones and portals the bridge's
 * scan has seen. Everything the bot did, in order, in `did`; every block changed, by dimension, in `changed`.
 */
export function game(world: WorldMemory, opts: {
  closed?: boolean; stranger?: PortalShape; items?: InventoryItem[]; after?: { changed: { dim: Dim; at: Pos; to: string }[]; lit: Lit[] }; now?: number;
  /** the Nether's zones as the bridge's scan has them (default: the community's room) */
  zones?: NetherZone[];
} = {}) {
  const did: string[] = [];
  const said: string[] = [];
  const changed: { dim: Dim; at: Pos; to: string; how: string }[] = [];
  const walks: { dim: Dim; to: Pos; careful: boolean }[] = [];
  const lit: Lit[] = [{ ...HOME_PORTAL, dim: OVERWORLD }, { ...COMMUNITY, dim: OVERWORLD }, { ...COMMUNITY_NETHER, dim: NETHER }];
  if (opts.stranger) lit.push({ ...opts.stranger, dim: OVERWORLD });
  const ground: Record<Dim, (p: Pos) => string> = { [OVERWORLD]: overworldGround(lit.filter(p => p.dim === OVERWORLD)), [NETHER]: netherGround(opts.closed) };
  const over: Record<Dim, Map<string, string>> = { [OVERWORLD]: new Map(), [NETHER]: new Map() };
  // the Nether as an earlier trip left it: what it dug and built there, the portal it lit
  for (const c of opts.after?.changed ?? []) over[c.dim].set(k(c.at), c.to);
  for (const l of opts.after?.lit ?? []) if (l.dim === NETHER && !lit.some(x => x.dim === l.dim && x.x === l.x && x.y === l.y && x.z === l.z)) lit.push({ ...l });
  const state = { dim: OVERWORLD as Dim, pos: { x: HOME.x + 0.5, y: HOME.y, z: HOME.z + 0.5 }, held: 'diamond_sword' };
  const own: { dimension: string; x: number; y: number; z: number }[] = [];
  const inPortal = (dim: Dim, p: Pos) => lit.find(l => l.dim === dim && portalCells(l).some(c => c.x === p.x && c.y === p.y && c.z === p.z));
  const get = (dim: Dim, p: Pos): string => (inPortal(dim, p) ? 'nether_portal' : over[dim].get(k(p)) ?? ground[dim](p));
  const set = (dim: Dim, p: Pos, b: string, how: string) => { over[dim].set(k(p), b); changed.push({ dim, at: { ...p }, to: b, how }); };
  const name = (b: string) => b.replace(/\[.*$/, '');
  const solid = (b: string) => !['air', 'nether_portal', 'lava'].includes(name(b));
  const standing = (dim: Dim, p: Pos) => solid(get(dim, { ...p, y: p.y - 1 })) && name(get(dim, p)) === 'air' && name(get(dim, { ...p, y: p.y + 1 })) === 'air';

  const inv = (opts.items ?? KIT).map(i => ({ ...i }));
  const chests = new Map<string, { name: string; count: number }[]>();
  for (const [key, contents] of Object.entries(world.chestItems ?? {})) chests.set(key, Object.entries(contents).map(([n, c]) => ({ name: n, count: c })));
  const pocket = () => { for (let i = 0; i < 36; i++) if (!inv.some(x => x.slot === i)) return i; return -1; };
  const give = (n: string, c: number) => {
    if (stackSize(n) === 1) { for (let i = 0; i < c; i++) inv.push({ slot: pocket(), name: n, count: 1 }); return; }
    const has = inv.find(x => x.slot < 36 && x.name === n);
    if (has) has.count += c; else inv.push({ slot: pocket(), name: n, count: c });
  };
  const takeOne = (n: string) => {
    const x = inv.find(i => i.slot < 36 && i.name === n);
    if (!x) return false;
    x.count -= 1;
    if (x.count <= 0) inv.splice(inv.indexOf(x), 1);
    return true;
  };
  const holds = (key: string) => `It holds: ${(chests.get(key) ?? []).map(s => `${s.name} x${s.count}`).join(', ') || 'nothing'}; 30/54 slots free.`;
  const feet = () => ({ x: Math.floor(state.pos.x), y: Math.floor(state.pos.y), z: Math.floor(state.pos.z) });
  const eye = () => ({ x: state.pos.x, y: state.pos.y + 1.62, z: state.pos.z });
  const reach = (p: Pos) => Math.hypot(p.x + 0.5 - eye().x, p.y + 0.5 - eye().y, p.z + 0.5 - eye().z);
  const shape = (l: PortalShape) => ({ x: l.x, y: l.y, z: l.z, axis: l.axis, width: 2, height: 3, blocks: 6 });

  /** The server's portal: from the block the bot stands in, the nearest portal round the scaled point; out 2 across its plane. */
  const travel = (cell: Pos, toward?: { x: number; z: number }) => {
    const to: Dim = state.dim === OVERWORLD ? NETHER : OVERWORLD;
    const from = scaled({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, to);
    const won = linkedTo(from, lit.filter(l => l.dim === to), SEARCH[to]);
    if (!won) throw new Error(`the server would build a portal of its own at ${to} ${fmt(from)}`);
    const was = state.dim;
    state.dim = to;
    const p = won.portal;
    const across = p.axis === 'x' ? [{ x: 0, z: 1 }, { x: 0, z: -1 }] : [{ x: 1, z: 0 }, { x: -1, z: 0 }];
    if (toward && (toward.x - won.block.x) * across[0].x + (toward.z - won.block.z) * across[0].z < 0) across.reverse();
    const out = across.map(a => ({ x: won.block.x + 2 * a.x, y: p.y, z: won.block.z + 2 * a.z })).find(c => standing(to, c) && standing(to, { x: (c.x + won.block.x) / 2, y: c.y, z: (c.z + won.block.z) / 2 }));
    state.pos = out ? { x: out.x + 0.5, y: out.y, z: out.z + 0.5 } : { x: won.block.x + 0.5, y: won.block.y, z: won.block.z + 0.5 };
    did.push(`portal ${was} ${fmt(cell)} -> ${to} ${fmt(won.block)}`);
    return { ok: true, from: was, dimension: to, position: { ...state.pos }, block: feet(), portal: { ...won.block }, arrived: shape(p), stepped: !!out };
  };

  /** Flint and steel on obsidian's top: a portal lights in a whole frame there (bottom, top and sides of obsidian, its 2 x 3 inside empty). */
  const light = (at: Pos) => {
    const f = { x: at.x, y: at.y + 1, z: at.z };
    for (const axis of ['x', 'z'] as const) for (const left of [0, -1]) {
      const lo = axis === 'x' ? { ...f, x: f.x + left } : { ...f, z: f.z + left };
      const p: PortalShape = { ...lo, axis, width: 2, height: 3 };
      if (portalCells(p).every(c => name(get(state.dim, c)) === 'air') && frameOf(p).every(c => name(get(state.dim, c)) === 'obsidian')) {
        lit.push({ ...p, dim: state.dim });
        return true;
      }
    }
    return false;
  };

  const ctx = {
    s: lookAt(inv, 1000, { now: opts.now ?? T0 }), world, signal: new AbortController().signal, gain: () => undefined,
    progress: (x: string) => { said.push(x); },
    status: async () => ({ inWorld: true, username: 'claudebot', screen: null, dimension: state.dim, position: { ...state.pos }, health: 20, food: 20, timeOfDay: 1000 }),
    call: async (m: string, p: Record<string, unknown> = {}) => {
      const at = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
      if (m === 'inventory') return { items: inv.map(i => ({ ...i })), held: { name: state.held, count: 1 } };
      if (m === 'item.select') { state.held = String(p.name); return {}; }
      if (m === 'world.region') {
        const blocks: string[] = [];
        for (let y = 0; y < Number(p.height); y++) for (let z = 0; z < Number(p.length); z++) for (let x = 0; x < Number(p.width); x++) blocks.push(`minecraft:${get(state.dim, { x: at.x + x, y: at.y + y, z: at.z + z })}`);
        return { blocks };
      }
      if (m === 'portal.list') {
        const range = Number(p.range ?? 96);
        const here = lit.filter(l => l.dim === state.dim && Math.max(Math.abs(l.x - state.pos.x), Math.abs(l.z - state.pos.z)) <= range);
        return { dimension: state.dim, portals: here.map(l => ({ ...shape(l), own: own.some(o => o.dimension === l.dim && portalCells(l).some(c => Math.abs(c.x - o.x) <= 1 && Math.abs(c.y - o.y) <= 1 && Math.abs(c.z - o.z) <= 1)) || l === lit[0] })) };
      }
      if (m === 'portal.own') { own.push({ dimension: String(p.dimension), x: at.x, y: at.y, z: at.z }); did.push(`portal.own ${p.dimension} ${fmt(at)}`); return { own }; }
      if (m === 'portal.enter') {
        const portal = inPortal(state.dim, at);
        if (!portal) return { ok: false, reason: 'not a portal' };
        return travel(at, p.toward as { x: number; z: number } | undefined);
      }
      if (m === 'foreign.zones') return { dimension: state.dim, zones: state.dim === NETHER ? (opts.zones ?? [ROOM_ZONE]).map(z => ({ ...z })) : [] };
      if (m === 'foreign.portals') {
        const theirs = lit.filter(l => l.dim === state.dim && l !== lit[0] && !own.some(o => o.dimension === l.dim && portalCells(l).some(c => Math.abs(c.x - o.x) <= 1 && Math.abs(c.y - o.y) <= 1 && Math.abs(c.z - o.z) <= 1)));
        return { dimension: state.dim, portals: theirs.map(shape) };
      }
      if (m === 'goto') {
        walks.push({ dim: state.dim, to: at, careful: !!p.careful });
        // (GoalNear: a standing cell within the range will do)
        const r = Math.max(0, Number(p.range ?? 1));
        const near: Pos[] = [];
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) near.push({ x: at.x + dx, y: at.y + dy, z: at.z + dz });
        const to = state.dim === OVERWORLD ? at : near.filter(c => standing(NETHER, c)).sort((a, b) => Math.hypot(a.x - at.x, a.y - at.y, a.z - at.z) - Math.hypot(b.x - at.x, b.y - at.y, b.z - at.z))[0];
        if (!to) return { arrived: false, at: feet() };
        state.pos = { x: to.x + 0.5, y: to.y, z: to.z + 0.5 };
        return { arrived: true, at: to };
      }
      if (m === 'dig.here') {
        const b = get(state.dim, at);
        if (name(b) === 'air') return { dug: false, reason: 'air' };
        if (reach(at) > 5) return { dug: false, reason: 'out of reach or out of sight', block: b };
        set(state.dim, at, 'air', `dug from ${fmt(feet())}`);
        did.push(`dig ${name(b)} ${fmt(at)}`);
        return { dug: true, block: b };
      }
      return {};
    },
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      const at = { x: Number(a.x), y: Number(a.y), z: Number(a.z) };
      if (tool === 'take-from-chest') {
        const key = `${at.x},${at.y},${at.z}`;
        const stacks = chests.get(key) ?? [];
        const st = stacks.find(x => x.name === a.item);
        const n = Math.min(Number(a.count), st?.count ?? 0);
        if (st) st.count -= n;
        chests.set(key, stacks.filter(x => x.count > 0));
        if (n) give(String(a.item), n);
        did.push(`take ${a.item} x${n}`);
        return n ? { ok: true, text: `Took ${n} ${a.item} from the chest at ${fmt(at)}. ${holds(key)}` } : { ok: false, text: `No ${a.item} in the chest at ${fmt(at)}. ${holds(key)}` };
      }
      if (tool === 'store-in-chest') {
        const key = `${at.x},${at.y},${at.z}`;
        let left = a.count === undefined ? Infinity : Number(a.count), n = 0;
        for (const x of inv.filter(i => i.slot < 36 && i.name === a.item)) { const q = Math.min(left, x.count); x.count -= q; left -= q; n += q; }
        for (let i = inv.length - 1; i >= 0; i--) if (inv[i].count <= 0) inv.splice(i, 1);
        const stacks = chests.get(key) ?? [];
        const st = stacks.find(x => x.name === a.item);
        if (st) st.count += n; else stacks.push({ name: String(a.item), count: n });
        chests.set(key, stacks);
        did.push(`store ${a.item} x${n}`);
        return { ok: true, text: `Stored ${n} ${a.item} in the chest at ${fmt(at)}. ${holds(key)}` };
      }
      if (tool === 'place-block') {
        const item = String(a.item);
        if (name(get(state.dim, at)) !== 'air') return { ok: true, text: `There's already a block (${get(state.dim, at)}) at ${fmt(at)}` };
        const sides = [[0, -1, 0], [0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0]].map(([dx, dy, dz]) => get(state.dim, { x: at.x + dx, y: at.y + dy, z: at.z + dz }));
        if (!sides.some(solid)) return { ok: true, text: `Failed to place block at ${fmt(at)}: nothing solid next to it to place against` };
        if (reach(at) > 5.2) return { ok: true, text: `Failed to place block at ${fmt(at)}: too far` };
        if (!takeOne(item)) return { ok: true, text: `No ${item} in inventory to place` };
        set(state.dim, at, item, `placed from ${fmt(feet())} against ${a.faceDirection}`);
        did.push(`place ${item} ${fmt(at)}`);
        return { ok: true, text: `Placed minecraft:${item} at ${fmt(at)} using ${a.faceDirection} face` };
      }
      if (tool === 'use-item-on-block') {
        did.push(`use ${a.item} on ${fmt(at)} face ${a.face} from ${fmt(feet())}`);
        if (a.item === 'flint_and_steel' && a.face === 'up' && name(get(state.dim, at)) === 'obsidian' && reach(at) <= 4.5 && light(at)) {
          return { ok: true, text: `Used flint_and_steel on obsidian at ${fmt(at)}: a portal lit` };
        }
        return { ok: true, text: `Used ${a.item} on ${get(state.dim, at)} at ${fmt(at)}; nothing changed` };
      }
      if (tool === 'eat') return { ok: true, text: 'Not hungry' };
      if (tool === 'go-home') { did.push(`go-home from ${state.dim} ${fmt(feet())}`); if (state.dim === OVERWORLD) state.pos = { x: HOME.x + 0.5, y: HOME.y, z: HOME.z + 0.5 }; return { ok: state.dim === OVERWORLD, text: 'Arrived home' }; }
      did.push(`act ${tool}`);
      return { ok: false, text: `unexpected ${tool}` };
    }
  } as unknown as GoalContext;
  return { ctx, did, said, changed, walks, lit, own, state, get, inv };
}
