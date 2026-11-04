import type mineflayer from 'mineflayer';

/**
 * Let the server's inventory updates catch up, then put down anything left on the cursor.
 *
 * mineflayer's craft() returns once its clicks are sent, not when the server has applied them. Starting the
 * next craft straight away overlaps the two: clicks go out with a stale state id, the server answers with full
 * resyncs in the middle, and the bot ends up with an ingredient or result on the server-side cursor that its
 * own model shows as empty (seen on 26.3: logs and torches "vanished" until the bot logged out).
 */
export async function settleInventory(bot: mineflayer.Bot, ticks = 4): Promise<void> {
  const wait = (n: number) => typeof bot.waitForTicks === 'function' ? bot.waitForTicks(n) : new Promise<void>(resolve => setTimeout(resolve, n * 50));
  await wait(ticks);
  const cursor = bot.inventory?.selectedItem;
  if (!cursor || typeof bot.inventory.firstEmptyInventorySlot !== 'function') return;
  const slot = bot.inventory.firstEmptyInventorySlot();
  if (slot === null || slot === undefined) return;
  await bot.clickWindow(slot, 0, 0);
  await wait(2);
}
