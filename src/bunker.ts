import type mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { isReplaceable } from './build-protection.js';

/** Cheap blocks worth spending on cover, best first. Falling blocks (sand, gravel) are left out. */
const COVER_BLOCKS = [
  'dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'stone',
  'deepslate', 'coarse_dirt', 'rooted_dirt', 'blackstone', 'basalt', 'end_stone', 'mud_bricks', 'packed_mud'
];

export function coverBlocks(items: Item[]): Item[] {
  const rank = (name: string) => {
    const i = COVER_BLOCKS.indexOf(name);
    if (i >= 0) return i;
    return name.endsWith('_planks') ? COVER_BLOCKS.length : -1;
  };
  return items.filter(i => rank(i.name) >= 0).sort((a, b) => rank(a.name) - rank(b.name));
}

export function countCover(items: Item[]): number {
  return coverBlocks(items).reduce((n, i) => n + i.count, 0);
}

const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
// try to place against the block below first, then the sides, then above
const REFERENCE_DIRS = [new Vec3(0, -1, 0), ...SIDES, new Vec3(0, 1, 0)];

/** The cells to fill around a bot standing at `feet`, in an order where each has something to place against. */
export function shelterCells(feet: Vec3): Vec3[] {
  return [
    ...SIDES.map(d => feet.plus(d)), // feet ring: placed against the ground
    ...SIDES.map(d => feet.plus(d).offset(0, 1, 0)), // head ring: placed on the feet ring
    feet.offset(1, 2, 0), // the roof has no neighbour at its own height yet: put one on top of the head ring
    feet.offset(0, 2, 0) // roof: placed against that one
  ];
}

export interface ShelterResult { placed: number; alreadySolid: number; gaps: Vec3[]; at: Vec3 }

/**
 * Close the bot in where it stands: blocks on all four sides at feet and head height, and a roof. Shelters from
 * melee and arrows while health comes back; dig out with dig-block. The blocks are not build-protected, so
 * pathfinder may dig through them later.
 */
export async function wallIn(bot: mineflayer.Bot): Promise<ShelterResult> {
  bot.pathfinder?.setGoal(null);
  bot.clearControlStates?.();
  const feet = bot.entity.position.floored();
  const result: ShelterResult = { placed: 0, alreadySolid: 0, gaps: [], at: feet };
  const solid = (p: Vec3) => { const b = bot.blockAt(p); return !!b && !isReplaceable(b); };

  /** Fill one cell; true when it ends up solid. */
  const fill = async (cell: Vec3): Promise<boolean> => {
    if (solid(cell)) { result.alreadySolid++; return true; }
    const block = coverBlocks(bot.inventory.items())[0];
    if (!block) return false;
    if (bot.heldItem?.name !== block.name) await bot.equip(block, 'hand');
    for (const dir of REFERENCE_DIRS) {
      const ref = bot.blockAt(cell.plus(dir));
      if (!ref || isReplaceable(ref)) continue;
      try {
        await bot.placeBlock(ref, dir.scaled(-1));
        result.placed++;
        return true;
      } catch {
        // a mob standing in the cell, or the server said no: try another face
      }
    }
    return false;
  };

  const rings = shelterCells(feet).slice(0, 8);
  for (const cell of rings) if (!(await fill(cell))) result.gaps.push(cell);

  // the roof needs a neighbour at its own height: put one on top of any side that got filled
  const roof = feet.offset(0, 2, 0);
  if (!solid(roof) && !SIDES.some(d => solid(roof.plus(d)))) {
    for (const d of SIDES) {
      if (solid(feet.plus(d).offset(0, 1, 0)) && await fill(roof.plus(d))) break;
    }
  }
  if (!(await fill(roof))) result.gaps.push(roof);
  return result;
}

export function describeShelter(r: ShelterResult): string {
  const where = `(${r.at.x}, ${r.at.y}, ${r.at.z})`;
  if (r.gaps.length === 0) return `Walled in at ${where} (${r.placed} block(s) placed). Dig out with dig-block when it's safe.`;
  return `Walled in at ${where} with ${r.gaps.length} gap(s) left at ${r.gaps.map(g => `(${g.x}, ${g.y}, ${g.z})`).join(', ')} (${r.placed} placed).`;
}
