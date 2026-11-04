import type mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { Vec3 } from 'vec3';

const { goals } = pathfinderPkg;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Counts = Map<string, number>;

export function inventoryCounts(bot: mineflayer.Bot): Counts {
  const counts: Counts = new Map();
  for (const item of bot.inventory.items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}

/** "cobblestone x2, raw_iron x1" for what was added since `before`. */
export function describeGain(before: Counts, after: Counts): string {
  const gained: string[] = [];
  for (const [name, count] of after) {
    const diff = count - (before.get(name) ?? 0);
    if (diff > 0) gained.push(`${name} x${diff}`);
  }
  return gained.join(', ');
}

/**
 * Walk over the items that dropped from a block just broken at `pos`, so they end up in the inventory.
 * Drops pop out with a little spread and fall, so look in a narrow column at and below the block.
 */
export async function collectDrops(
  bot: mineflayer.Bot,
  pos: Vec3,
  { settleMs = 600, timeoutMs = 6000 }: { settleMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  await sleep(settleMs);
  const center = pos.offset(0.5, 0.5, 0.5);
  const isDrop = (e: { name?: string; position: Vec3; isValid?: boolean }) => {
    if (e.name !== 'item' || e.isValid === false) return false;
    const dy = e.position.y - center.y;
    return Math.hypot(e.position.x - center.x, e.position.z - center.z) <= 2 && dy <= 1 && dy >= -8;
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const drop = Object.values(bot.entities)
      .filter(isDrop)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!drop) return;
    const p = drop.position;
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1)),
        sleep(Math.max(0, deadline - Date.now())).then(() => { throw new Error('timeout'); })
      ]);
    } catch {
      bot.pathfinder.setGoal(null);
      return; // unreachable or out of time: leave it
    }
    await sleep(250); // pickup happens on the server's next ticks
    if (bot.entities[drop.id]) return; // still there although we stood next to it: don't loop on it
  }
}
