import type mineflayer from 'mineflayer';
import type { Vec3 } from 'vec3';

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

type BreakRule = (block: { position: Vec3 }) => number;
interface MovementsWithExclusions { exclusionAreasBreak: BreakRule[] }

const placedByBot = new WeakMap<mineflayer.Bot, Set<string>>();
const key = (p: Vec3) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

/** Remember a block the bot placed so pathfinding won't dig through it. */
export function protectPlacedBlock(bot: mineflayer.Bot, pos: Vec3): void {
  let set = placedByBot.get(bot);
  if (!set) { set = new Set(); placedByBot.set(bot, set); }
  set.add(key(pos));
}

export function isProtected(bot: mineflayer.Bot, pos: Vec3): boolean {
  return placedByBot.get(bot)?.has(key(pos)) ?? false;
}

/**
 * Make pathfinder treat blocks placed with place-block as unbreakable (cost 100 = can't break). Without this,
 * walking into a freshly built hut dug a hole through its wall.
 */
export function installBuildProtection(bot: mineflayer.Bot, movements: MovementsWithExclusions): void {
  movements.exclusionAreasBreak.push((block) => (isProtected(bot, block.position) ? 100 : 0));
}
