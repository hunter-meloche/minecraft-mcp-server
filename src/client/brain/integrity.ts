import { isReplaceable } from '../../build-protection.js';
import { placerFacing, secondHalf } from '../schematic.js';
import type { Pos } from './memory.js';

/**
 * Home integrity: compare what the bot built (its protected positions with the block state each had when built)
 * with what stands there now, and plan putting back what went missing (creepers, Baritone passing through, endermen).
 * Pure: the repair goal reads the world and does the placing.
 */

/** A block the bot built, with the state it had then (positions protected before states were kept have none). */
export interface BuiltBlock { at: Pos; state?: string }
/** A block to put back: `item` placed at `at`, the bot looking `facing` while it places (for placeFacing). */
export interface Restore { at: Pos; state: string; item: string; facing?: string }
/** A missing block that isn't put back on its own, and why. */
export interface Lost { at: Pos; state: string; why: string }
export interface IntegrityPlan {
  /** what to place, lowest first (a block's support goes back before it) */
  restore: Restore[];
  /** missing, but left for someone to see to (a chest's contents, a door, a sign's text) */
  lost: Lost[];
  /** missing cells that hold some other block now (left alone) */
  occupied: number;
}

const idOf = (state: string) => state.replace(/^minecraft:/, '').replace(/\[.*$/, '');
const propsOf = (state: string): Record<string, string> =>
  Object.fromEntries((/\[(.*)\]$/.exec(state)?.[1] ?? '').split(',').filter(Boolean).map(kv => kv.split('=') as [string, string]));

/** Blocks that go back as another item. */
const ITEM_FOR: Record<string, string> = {
  wall_torch: 'torch', soul_wall_torch: 'soul_torch', redstone_wall_torch: 'redstone_torch', copper_wall_torch: 'copper_torch',
  grass_block: 'dirt', dirt_path: 'dirt', farmland: 'dirt', podzol: 'dirt', mycelium: 'dirt',
  redstone_wire: 'redstone', tripwire: 'string'
};
/** Ground: any of these standing where another was counts as in place (grass spreads, farmland gets trampled). */
const GROUND = /^(dirt|grass_block|dirt_path|farmland|podzol|mycelium|coarse_dirt|rooted_dirt)$/;
/** Missing, but not put back by the bot: why. */
const NOT_RESTORED: [RegExp, string][] = [
  [/^(chest|trapped_chest|barrel|.*shulker_box)$/, 'a container (what it held is gone)'],
  [/_door$|_bed$/, 'doors and beds go back by hand'],
  [/_sign$|_banner$/, "its text or pattern can't be put back"]
];
/** Gone without needing the bot: crops (the farm replants), fluids, fire, piston parts, the upper half of tall plants. */
const IGNORED = /^(wheat|carrots|potatoes|beetroots|.*_stem|sweet_berry_bush|torchflower_crop|pitcher_crop|nether_wart|water|lava|fire|soul_fire|.*portal|piston_head|moving_piston|frosted_ice)$/;
const HORIZONTAL = new Set(['north', 'south', 'east', 'west']);

/**
 * What of `expected` is missing now. `current[i]` is the block at `expected[i].at` as world.region gives it
 * ("name[props]", null where the chunk isn't loaded). A cell counts as missing when it is empty or holds something
 * replaceable (grass, water, snow...); one that holds a different solid block is counted in `occupied` and left alone,
 * an unloaded one or one built without a known state is skipped. The bot can't choose a placed log's axis or a slab's
 * half, so those go back as placing gives them.
 */
export function missingBuilt(expected: BuiltBlock[], current: (string | null)[]): IntegrityPlan {
  const restore: Restore[] = [];
  const lost: Lost[] = [];
  let occupied = 0;
  expected.forEach(({ at, state }, i) => {
    const now = current[i];
    if (!state || now === null || now === undefined) return;
    const id = idOf(state);
    const nowId = idOf(now);
    if (nowId === id || (GROUND.test(id) && GROUND.test(nowId))) return;
    if (IGNORED.test(id) || isReplaceable({ name: id, getProperties: () => propsOf(state) })) return;
    // a door's top and a bed's head come with the other half (half=upper is otherwise only a tall plant's top)
    if (secondHalf(state) || propsOf(state).half === 'upper') return;
    if (!isReplaceable({ name: nowId, getProperties: () => propsOf(now) })) { occupied++; return; }
    const why = NOT_RESTORED.find(([re]) => re.test(id))?.[1];
    if (why) { lost.push({ at, state, why }); return; }
    const facing = propsOf(state).facing;
    restore.push({ at, state, item: ITEM_FOR[id] ?? id, ...(facing && HORIZONTAL.has(facing) ? { facing: placerFacing(id, facing) } : {}) });
  });
  restore.sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x || a.at.z - b.at.z);
  return { restore, lost, occupied };
}
