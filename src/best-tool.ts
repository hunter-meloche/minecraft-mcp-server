import type mineflayer from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Item } from 'prismarine-item';

type ToolBot = Pick<mineflayer.Bot, 'inventory' | 'heldItem' | 'entity'>;

function digTimeWith(bot: ToolBot, block: Block, item: Item | null): number {
  const enchants = (item as unknown as { enchants?: unknown[] } | null)?.enchants ?? [];
  return block.digTime(item ? item.type : null, false, false, false, enchants as never, bot.entity?.effects ?? {});
}

/**
 * The item to hold for digging a block, or null to keep whatever is held.
 *
 * Only an item that digs strictly faster than an empty hand counts as a tool (which also covers blocks
 * that only drop with the right tool, such as stone). On a tie the held item wins. mineflayer-pathfinder's
 * own bestHarvestTool returns the first inventory item when nothing is faster, so walking through dirt
 * swapped an apple (or anything in the first slot) into the hand.
 */
export function bestHarvestTool(bot: ToolBot, block: Block): Item | null {
  const bare = digTimeWith(bot, block, null);
  let best: Item | null = null;
  let fastest = bare;
  const held = bot.heldItem ?? null;
  if (held) {
    const t = digTimeWith(bot, block, held);
    if (t < fastest) { fastest = t; best = held; }
  }
  for (const item of bot.inventory.items()) {
    const t = digTimeWith(bot, block, item);
    if (t < fastest) { fastest = t; best = item; }
  }
  return best;
}

/** Equip the best tool for the block if it isn't already in hand. */
export async function equipBestTool(bot: mineflayer.Bot, block: Block): Promise<Item | null> {
  const tool = bestHarvestTool(bot, block);
  if (tool && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand');
  return tool;
}
