/**
 * The two dimensions as the bridge and the tools answer for them, for the Nether trips' tests (nethersetup.test.ts,
 * netherramp.test.ts): the live yard with the home portal lit, the Nether round home's scaled point (netherrack, a
 * cliff, a lava pool, the community's stone-brick room round their portal), the server's rule for where a portal
 * leads, chests by their totals, digging, placing and lighting; and for the barter (netherbarter.test.ts) the mobs down
 * there, the items lying, a toss, a right click, a piglin's admiring and what it throws; and for the quartz
 * (netherquartz.test.ts) what a dug quartz ore drops, where it comes to rest; for the scouting
 * (netherscout.test.ts) the biome the status says at the bot's feet; and for the debris (netherdebris.test.ts) the
 * potions in the chests by their stacks (a withdraw by slot), a potion drunk and the effect it gives, what a dug
 * ancient debris drops and what the bot held to dig it; and for the fortress (netherfortress.test.ts) the bridge's
 * fight (the nearest of the kind killed, a blaze's rod dropped where it died), what a nether wart and a soul sand dug
 * drop, the wither on the bot; and for the tunnelling (nethertunnel.ts) a block put down there as a dig opens the
 * rock (lava come in), and a block placed into lava (the game's: lava is replaceable).
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

/** A mob down there as the bridge's world.entities reports it: where its feet are, and what the barter reads of it (a fireball's motion, blocks a tick). */
export interface Mob {
  id: number; name: string; position: Pos; baby?: boolean; aggressive?: boolean; offhand?: string; mainhand?: string; buildDistance?: number; foreign?: boolean;
  motion?: Pos;
}
/** What a piglin throws for a gold ingot, one barter's (a potion by its contents). */
export interface Loot { name: string; count: number; potion?: string }
/** An item lying down there (`toss`: one the bot threw). */
export interface Drop { id: number; item: string; count: number; potion?: string; position: Pos; from?: 'toss' }

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
  /** the mobs down there (P3a's barter: piglins, hoglins, ghasts) */
  mobs?: Mob[];
  /** what each barter throws, in turn (round again after the last; default 4 soul sand) */
  loot?: Loot[];
  /** the server's mobGriefing: off, no piglin picks up a thrown ingot (a right click still gives one) */
  griefing?: boolean;
  /** the looks (world.entities asked) a piglin admires its gold for (the game's 6 s) */
  admireLooks?: number;
  /** where the loot comes down: halfway to the bot (default), or 2 to the side of the piglin */
  lootAt?: 'between' | 'side';
  /** called at every world.entities before it answers, with how many there were (a test hurts the bot, turns a piglin, brings a hoglin) */
  onLook?: (n: number) => void;
  /** the quartz each nether_quartz_ore dug down there drops (the pickaxe's fortune: 2 by default) */
  quartz?: number;
  /** the biome at a block down there, as the status says it at the bot's feet (P3b's scouting; none said by default) */
  biome?: (p: Pos) => string | undefined;
  /** a potion drunk does not take (the use ends before it is drunk: nothing goes, no effect) */
  drinkFails?: boolean;
  /** the bridge's fight never kills (a blaze that stays out of reach) */
  fightMisses?: boolean;
  /** called after each block dug down there, with a way to put a block in the Nether (a test lets lava in as the rock opens) */
  onDig?: (at: Pos, put: (p: Pos, b: string) => void) => void;
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
  /** `fire`: the fire resistance on the bot, s (a test lowers it); `heldSlot`: the pocket item.select named by slot; `wither`: the wither on it (a test sets it); `food`: as the status says it */
  const state = { dim: OVERWORLD as Dim, pos: { x: HOME.x + 0.5, y: HOME.y, z: HOME.z + 0.5 }, held: 'diamond_sword', health: 20, food: 20, fire: 0, heldSlot: -1, wither: false };
  /** each block dug down there, with what the bot held to dig it */
  const dugWith: string[] = [];
  const own: { dimension: string; x: number; y: number; z: number }[] = [];
  const inPortal = (dim: Dim, p: Pos) => lit.find(l => l.dim === dim && portalCells(l).some(c => c.x === p.x && c.y === p.y && c.z === p.z));
  const get = (dim: Dim, p: Pos): string => (inPortal(dim, p) ? 'nether_portal' : over[dim].get(k(p)) ?? ground[dim](p));
  const set = (dim: Dim, p: Pos, b: string, how: string) => { over[dim].set(k(p), b); changed.push({ dim, at: { ...p }, to: b, how }); };
  const name = (b: string) => b.replace(/\[.*$/, '');
  const solid = (b: string) => !['air', 'nether_portal', 'lava'].includes(name(b));
  const standing = (dim: Dim, p: Pos) => solid(get(dim, { ...p, y: p.y - 1 })) && name(get(dim, p)) === 'air' && name(get(dim, { ...p, y: p.y + 1 })) === 'air';

  const inv = (opts.items ?? KIT).map(i => ({ ...i }));
  // (the potions by their stacks as the memory has them, each with its contents: by their totals they would be none)
  const chests = new Map<string, { name: string; count: number; potion?: string }[]>();
  for (const [key, contents] of Object.entries(world.chestItems ?? {})) {
    const potions = (world.chestStacks?.[key] ?? []).filter(st => st.potion).map(st => ({ name: st.name, count: st.count, potion: st.potion }));
    const named = new Set(potions.map(st => st.name));
    chests.set(key, [...Object.entries(contents).filter(([n]) => !named.has(n)).map(([n, c]) => ({ name: n, count: c })), ...potions]);
  }
  let openChest = '';
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
  // ---- the barter down there: the mobs, the items lying, a piglin's admiring and what it throws, the bot's pickup
  const mobs: Mob[] = (opts.mobs ?? []).map(m => ({ ...m, position: { ...m.position } }));
  const drops: Drop[] = [];
  const admire = new Map<number, number>();
  const lootPlan = opts.loot ?? [{ name: 'soul_sand', count: 4 }];
  let nextId = 5000, looks = 0, barters = 0;
  const flat = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.z - b.z);
  // (the game's pickup box: the player's grown by 1 across and half a block up and down, against the item's 0.25)
  const pickup = () => {
    for (const d of [...drops]) {
      if (state.dim !== NETHER || flat(d.position, state.pos) > 1.3 || d.position.y + 0.25 < state.pos.y - 0.5 || d.position.y > state.pos.y + 2.3) continue;
      drops.splice(drops.indexOf(d), 1);
      if (d.potion) inv.push({ slot: pocket(), name: d.item, count: d.count, potion: d.potion });
      else give(d.item, d.count);
      did.push(`picked up ${d.count} ${d.item}`);
    }
  };
  const tick = () => {
    looks++;
    opts.onLook?.(looks);
    // the admiring runs out: the off hand empty, the loot thrown toward the bot
    for (const [id, n] of [...admire]) {
      const m = mobs.find(x => x.id === id);
      if (!m) { admire.delete(id); continue; }
      if (n > 1) { admire.set(id, n - 1); continue; }
      admire.delete(id);
      delete m.offhand;
      const l = lootPlan[barters++ % lootPlan.length];
      const dx = state.pos.x - m.position.x, dz = state.pos.z - m.position.z, d = Math.hypot(dx, dz) || 1;
      const at = opts.lootAt === 'side' ? { x: m.position.x - dz / d * 2, y: m.position.y, z: m.position.z + dx / d * 2 } : { x: m.position.x + dx / 2, y: m.position.y, z: m.position.z + dz / 2 };
      drops.push({ id: nextId++, item: l.name, count: l.count, ...(l.potion ? { potion: l.potion } : {}), position: at });
      did.push(`piglin #${id} threw ${l.count} ${l.name}${l.potion ? ` of ${l.potion}` : ''}`);
    }
    // a thrown ingot picked up by the piglin nearest it within its reach, holding nothing (a baby keeps it)
    if (opts.griefing !== false) {
      for (const d of drops.filter(x => x.from === 'toss')) {
        const m = mobs.filter(x => x.name === 'piglin' && !x.offhand && flat(x.position, d.position) <= 1.2 && Math.abs(x.position.y - d.position.y) < 1.5)
          .sort((a, b) => flat(a.position, d.position) - flat(b.position, d.position))[0];
        if (!m) continue;
        drops.splice(drops.indexOf(d), 1);
        m.offhand = 'gold_ingot';
        if (!m.baby) admire.set(m.id, opts.admireLooks ?? 3);
        did.push(`piglin #${m.id} took the gold`);
      }
    }
    pickup();
  };
  const seenMob = (m: Mob) => ({
    id: m.id, name: m.name, category: 'monster', position: { ...m.position }, distance: Math.hypot(m.position.x - state.pos.x, m.position.y - state.pos.y, m.position.z - state.pos.z),
    height: 1.95, health: 16, baby: !!m.baby, aggressive: !!m.aggressive,
    ...(m.mainhand ? { mainhand: m.mainhand } : {}), ...(m.offhand ? { offhand: m.offhand } : {}), ...(m.name === 'piglin' ? { admiring: /gold/.test(m.offhand ?? '') } : {}),
    ...(m.foreign ? { foreign: true } : {}), ...(m.buildDistance !== undefined ? { buildDistance: m.buildDistance } : {}),
    ...(m.motion ? { motion: { ...m.motion } } : {})
  });
  const seenDrop = (d: Drop) => ({
    id: d.id, name: 'item', category: 'misc', position: { ...d.position }, distance: Math.hypot(d.position.x - state.pos.x, d.position.y - state.pos.y, d.position.z - state.pos.z),
    height: 0.25, item: d.item, count: d.count
  });
  /** A chest's contents as chest.open answers: its totals, and a stack a slot (the potions with their contents). */
  const reply = (key: string) => {
    const stacks = (chests.get(key) ?? []).filter(x => x.count > 0).map((x, slot) => ({ slot, name: x.name, count: x.count, ...(x.potion ? { potion: x.potion } : {}) }));
    const items: Record<string, number> = {};
    for (const st of stacks) items[st.name] = (items[st.name] ?? 0) + st.count;
    return { items, stacks, free: 54 - stacks.length, slots: 54 };
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
    status: async () => {
      const biome = state.dim === NETHER ? opts.biome?.(feet()) : undefined;
      const list = [...(state.fire > 0 ? [{ name: 'fire_resistance', amplifier: 0, seconds: state.fire }] : []), ...(state.wither ? [{ name: 'wither', amplifier: 0, seconds: 8 }] : [])];
      const effects = list.length ? { effects: list } : {};
      return { inWorld: true, username: 'claudebot', screen: null, dimension: state.dim, position: { ...state.pos }, health: state.health, food: state.food, timeOfDay: 1000, ...(biome ? { biome } : {}), ...effects };
    },
    call: async (m: string, p: Record<string, unknown> = {}) => {
      const at = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
      if (m === 'inventory') return { items: inv.map(i => ({ ...i })), held: { name: state.held, count: 1 } };
      if (m === 'item.select') { state.held = String(p.name); state.heldSlot = p.slot === undefined ? -1 : Number(p.slot); return {}; }
      // a potion of fire resistance drunk (the one selected by its slot, else the first): its effect, 3:00 or 8:00
      if (m === 'use') {
        const potion = inv.find(i => i.slot === state.heldSlot && i.name === state.held) ?? inv.find(i => i.slot < 36 && i.name === state.held);
        if (!potion || potion.name !== 'potion' || opts.drinkFails) return { finished: false };
        potion.count -= 1;
        if (potion.count <= 0) inv.splice(inv.indexOf(potion), 1);
        if (/(^|_)fire_resistance$/.test(potion.potion ?? '')) state.fire = /^long_/.test(potion.potion ?? '') ? 480 : 180;
        did.push(`drink potion of ${potion.potion}`);
        return { finished: true, food: 20, foodBefore: 20, health: state.health, healthBefore: state.health };
      }
      // a look into a home chest (chests.ts peekChest): what it really holds, a stack a slot
      if (m === 'chest.open') {
        const key = k(at);
        openChest = key;
        did.push(`look in ${key}`);
        return reply(key);
      }
      // a withdraw from the chest open, by its slot (the stack there, or the first of the name when it holds another)
      if (m === 'chest.withdraw') {
        const list = (chests.get(openChest) ?? []).filter(x => x.count > 0);
        const st = list[Number(p.slot)]?.name === p.name ? list[Number(p.slot)] : list.find(x => x.name === p.name);
        const n = Math.min(Number(p.count ?? st?.count ?? 0), st?.count ?? 0);
        if (st && n > 0) {
          st.count -= n;
          if (st.potion) for (let i = 0; i < n; i++) inv.push({ slot: pocket(), name: st.name, count: 1, potion: st.potion });
          else give(st.name, n);
        }
        did.push(`withdraw ${p.name}${st?.potion ? ` of ${st.potion}` : ''} x${n}`);
        chests.set(openChest, (chests.get(openChest) ?? []).filter(x => x.count > 0));
        return { ...reply(openChest), moved: n, from: st ? list.indexOf(st) : -1 };
      }
      if (m === 'container.close') return {};
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
      if (m === 'world.entities') {
        tick();
        const range = Number(p.maxDistance ?? 32);
        if (state.dim !== NETHER) return { entities: [] };
        const all = [...mobs.map(seenMob), ...drops.map(seenDrop)].filter(e => e.distance <= range && (p.type === undefined || e.name === p.type));
        return { entities: all.sort((a, b) => a.distance - b.distance) };
      }
      if (m === 'item.toss') {
        const name = String(p.name);
        const to = p.toward as Pos;
        if (!inv.some(i => i.slot < 36 && i.name === name)) throw new Error(`no ${name} in inventory`);
        const off = flat(to, state.pos);
        if (off > 4.25) throw new Error(`no throw rests by the point, ${off.toFixed(2)} blocks off along the ground: the nearest rests 3.75 out (stand 1 to 4 from it)`);
        const c = { x: Math.floor(to.x), y: Math.floor(to.y), z: Math.floor(to.z) };
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const dy of [-1, 0]) {
          const b = get(state.dim, { x: c.x + dx, y: c.y + dy, z: c.z + dz });
          if (/^lava/.test(b)) throw new Error(`the throw might come to rest by lava at (${c.x + dx}, ${c.y + dy}, ${c.z + dz})`);
        }
        takeOne(name);
        drops.push({ id: nextId++, item: name, count: 1, position: { x: to.x, y: to.y, z: to.z }, from: 'toss' });
        did.push(`toss ${name} -> ${fmt(c)} from ${fmt(feet())}`);
        return { tossed: 1, item: name, landed: [{ ...to, fromTarget: 0 }] };
      }
      if (m === 'entity.use') {
        const mob = mobs.find(x => x.id === Number(p.id));
        if (!mob) throw new Error(`no entity with id ${p.id} nearby`);
        const reach = Math.hypot(mob.position.x - state.pos.x, mob.position.y + 1 - (state.pos.y + 1.62), mob.position.z - state.pos.z);
        if (reach > 4.5) throw new Error(`too far: ${reach.toFixed(2)} blocks to the ${mob.name} (max 4.5)`);
        if (p.item) state.held = String(p.item);
        if (mob.name === 'piglin' && !mob.baby && !mob.offhand && p.item === 'gold_ingot' && takeOne('gold_ingot')) {
          mob.offhand = 'gold_ingot';
          admire.set(mob.id, opts.admireLooks ?? 3);
          did.push(`hand gold_ingot to piglin #${mob.id}`);
          return { result: 'Success', success: true, hand: 'main', entity: mob.name, id: mob.id };
        }
        return { result: 'Pass', success: false, hand: null, entity: mob.name, id: mob.id };
      }
      // the bridge's fight: the one named by its id ('#71'), or the nearest of the kind, within its distance killed,
      // where it stood; a blaze drops a rod there. A blaze is never walked after (Nether.noChase): one past the swing's
      // 3.2 (feet to feet) stays out of reach, and the fight ends unreachable
      if (m === 'fight') {
        const target = String(p.target);
        const off = (x: Mob) => Math.hypot(x.position.x - state.pos.x, x.position.y - state.pos.y, x.position.z - state.pos.z);
        const near = mobs.filter(x => off(x) <= Number(p.maxDistance ?? 16));
        const mob = target.startsWith('#') ? near.find(x => x.id === Number(target.slice(1)))
          : near.filter(x => x.name === target).sort((a, b) => Math.hypot(a.position.x - state.pos.x, a.position.z - state.pos.z) - Math.hypot(b.position.x - state.pos.x, b.position.z - state.pos.z))[0];
        const kind = mob?.name ?? target;
        did.push(`fight ${kind}${mob ? ` #${mob.id}` : ''} (min health ${p.minHealth}, retreat ${p.retreat})`);
        if (!mob || opts.fightMisses || (mob.name === 'blaze' && off(mob) > 3.2)) return { outcome: mob ? 'unreachable' : 'none', kills: [], unreachable: mob ? [kind] : [] };
        mobs.splice(mobs.indexOf(mob), 1);
        const at = { x: Math.floor(mob.position.x), y: Math.floor(mob.position.y), z: Math.floor(mob.position.z) };
        let y = at.y;
        while (y > 1 && !solid(get(state.dim, { x: at.x, y: y - 1, z: at.z }))) y--;
        if (kind === 'blaze') drops.push({ id: nextId++, item: 'blaze_rod', count: 1, position: { x: at.x + 0.5, y, z: at.z + 0.5 } });
        return { outcome: 'done', kills: [kind], dropsAt: at, health: state.health };
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
        pickup();
        return { arrived: true, at: to };
      }
      if (m === 'dig.here') {
        const b = get(state.dim, at);
        if (name(b) === 'air') return { dug: false, reason: 'air' };
        if (reach(at) > 5) return { dug: false, reason: 'out of reach or out of sight', block: b };
        set(state.dim, at, 'air', `dug from ${fmt(feet())}`);
        did.push(`dig ${name(b)} ${fmt(at)}`);
        if (state.dim === NETHER) dugWith.push(`${name(b)} ${k(at)} with ${state.held}`);
        if (state.dim === NETHER) opts.onDig?.(at, (q, to) => set(NETHER, q, to, 'test'));
        // a quartz ore's quartz, an ancient debris itself: down through the open cells under it to the first floor, in
        // the middle of its column
        const drop = name(b) === 'nether_quartz_ore' ? { item: 'quartz', count: opts.quartz ?? 2 } : name(b) === 'ancient_debris' ? { item: 'ancient_debris', count: 1 }
          : name(b) === 'nether_wart' ? { item: 'nether_wart', count: 2 } : name(b) === 'soul_sand' ? { item: 'soul_sand', count: 1 } : undefined;
        if (drop && state.dim === NETHER && drop.count > 0) {
          let y = at.y;
          while (y > 1 && !solid(get(state.dim, { x: at.x, y: y - 1, z: at.z }))) y--;
          drops.push({ id: nextId++, item: drop.item, count: drop.count, position: { x: at.x + 0.5, y, z: at.z + 0.5 } });
        }
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
        if (!['air', 'lava'].includes(name(get(state.dim, at)))) return { ok: true, text: `There's already a block (${get(state.dim, at)}) at ${fmt(at)}` };
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
  return { ctx, did, said, changed, walks, lit, own, state, get, inv, mobs, drops, dugWith, chests };
}
