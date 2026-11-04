import type mineflayer from 'mineflayer';
import type { Vec3 } from 'vec3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Blocks the game lets you place a block into (it replaces them).
const REPLACEABLE = new Set([
  'air', 'cave_air', 'void_air', 'water', 'lava', 'fire', 'soul_fire', 'light', 'structure_void',
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'short_dry_grass', 'tall_dry_grass', 'bush',
  'seagrass', 'tall_seagrass', 'vine', 'glow_lichen', 'hanging_roots', 'leaf_litter',
  'crimson_roots', 'warped_roots', 'nether_sprouts', 'bubble_column'
]);

export function isReplaceable(block: { name: string; getProperties?: () => Record<string, unknown> } | null | undefined): boolean {
  if (!block) return true;
  if (REPLACEABLE.has(block.name)) return true;
  if (block.name === 'snow') return Number(block.getProperties?.().layers ?? 1) === 1; // a single snow layer
  return false;
}

// Right-clicking these uses them (opens a crafting table, toggles a door) instead of placing against them.
const ACTIVATABLE = /^(crafting_table|crafter|(blast_)?furnace|smoker|(trapped_)?chest|ender_chest|barrel|.*shulker_box|hopper|dispenser|dropper|brewing_stand|enchanting_table|(chipped_|damaged_)?anvil|grindstone|stonecutter|loom|cartography_table|smithing_table|fletching_table|lectern|beacon|bell|note_block|jukebox|lever|respawn_anchor|.*_(door|trapdoor|fence_gate|bed|button|sign|hanging_sign))$/;

/** Can a block be placed against `block`? Solid and not something right-clicking would use instead. */
export function canPlaceAgainst<T extends { name: string; getProperties?: () => Record<string, unknown> }>(block: T | null | undefined): block is T {
  return !!block && !isReplaceable(block) && !ACTIVATABLE.test(block.name);
}

type BreakRule = (block: { position: Vec3 }) => number;
interface MovementsWithExclusions { exclusionAreasBreak: BreakRule[] }

/** Where the placed-block list survives MCP restarts: one list of block keys per world. */
export interface ProtectionStore {
  load(world: string): string[];
  save(world: string, keys: string[]): void;
}

export const DEFAULT_PROTECTION_FILE = path.join(os.homedir(), '.minecraft-mcp-server', 'placed-blocks.json');

export function jsonFileStore(file = DEFAULT_PROTECTION_FILE): ProtectionStore {
  const readAll = (): Record<string, string[]> => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string[]>;
    } catch {
      return {}; // missing or unreadable file: start empty
    }
  };
  return {
    load: (world) => readAll()[world] ?? [],
    save: (world, keys) => {
      const all = readAll();
      all[world] = keys;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all, null, 1));
    }
  };
}

/** Identify a world across sessions by its hashed seed (sent in the login packet); LAN ports change every time. */
export function worldIdFromSeed(hashedSeed: unknown): string | undefined {
  return hashedSeed === undefined || hashedSeed === null ? undefined : `seed:${String(hashedSeed)}`;
}

interface ProtectionState { blocks: Set<string>; world?: string; store?: ProtectionStore }
const states = new WeakMap<mineflayer.Bot, ProtectionState>();

function stateOf(bot: mineflayer.Bot): ProtectionState {
  let state = states.get(bot);
  if (!state) { state = { blocks: new Set() }; states.set(bot, state); }
  return state;
}

const key = (bot: mineflayer.Bot, p: Vec3) =>
  `${bot.game?.dimension ?? 'overworld'}:${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function persist(state: ProtectionState): void {
  if (state.store && state.world) state.store.save(state.world, [...state.blocks]);
}

/** Remember a block the bot placed so pathfinding won't dig through it. */
export function protectPlacedBlock(bot: mineflayer.Bot, pos: Vec3): void {
  const state = stateOf(bot);
  const k = key(bot, pos);
  if (state.blocks.has(k)) return;
  state.blocks.add(k);
  persist(state);
}

export function isProtected(bot: mineflayer.Bot, pos: Vec3): boolean {
  return states.get(bot)?.blocks.has(key(bot, pos)) ?? false;
}

/** Forget a block (it was dug or otherwise removed). */
export function unprotectBlock(bot: mineflayer.Bot, pos: Vec3): void {
  const state = states.get(bot);
  if (state?.blocks.delete(key(bot, pos))) persist(state);
}

/**
 * Make pathfinder treat blocks placed with place-block as unbreakable (cost 100 = can't break). Without this,
 * walking into a freshly built hut dug a hole through its wall.
 *
 * With a store and world id the list is loaded now and saved on every change, so a restart of the MCP keeps
 * protecting what was built before it. A protected block that the bot sees turn into air (or anything
 * replaceable) is dropped from the list, whoever removed it.
 */
export function installBuildProtection(
  bot: mineflayer.Bot,
  movements: MovementsWithExclusions,
  options: { store?: ProtectionStore; world?: string } = {}
): void {
  const state = stateOf(bot);
  if (options.store && options.world) {
    state.store = options.store;
    state.world = options.world;
    for (const k of options.store.load(options.world)) state.blocks.add(k);
  }
  movements.exclusionAreasBreak.push((block) => (isProtected(bot, block.position) ? 100 : 0));
  bot.on?.('blockUpdate', (_old, now) => {
    if (now && isReplaceable(now)) unprotectBlock(bot, now.position);
  });
}
