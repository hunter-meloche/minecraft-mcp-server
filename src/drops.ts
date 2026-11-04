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

/** Longest walk (pathfinder cost, roughly blocks) worth taking for a drop. */
const MAX_COLLECT_COST = 24;

type PathPlan = { status: string; cost: number };
type Pathfinder = {
  movements?: { exclusionAreasPlace?: ((b: { position: Vec3 }) => number)[] };
  getPathTo?: (movements: unknown, goal: unknown, timeout?: number) => PathPlan;
};

/**
 * Walk over the items that dropped from a block just broken at `pos`, so they end up in the inventory.
 * Drops pop out with a little spread and fall, so look in a narrow column at and below the block.
 *
 * Only walks a complete, short path: following pathfinder's partial paths toward a drop that fell into a hole dug
 * out the blocks above it and dropped the bot 9 blocks down the shaft.
 */
export async function collectDrops(
  bot: mineflayer.Bot,
  pos: Vec3,
  { settleMs = 600, timeoutMs = 6000 }: { settleMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  await sleep(settleMs);
  const center = pos.offset(0.5, 0.5, 0.5);
  const skipped = new Set<number>();
  const isDrop = (e: { id: number; name?: string; position: Vec3; isValid?: boolean }) => {
    if (e.name !== 'item' || e.isValid === false || skipped.has(e.id)) return false;
    const dy = e.position.y - center.y;
    return Math.hypot(e.position.x - center.x, e.position.z - center.z) <= 2 && dy <= 1 && dy >= -6;
  };
  const pf = bot.pathfinder as unknown as Pathfinder;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const drop = Object.values(bot.entities)
      .filter(isDrop)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!drop) return;

    // let it finish falling before deciding where to go
    for (let i = 0, last = drop.position.clone(); i < 8; i++) {
      await sleep(150);
      if (drop.position.distanceTo(last) < 0.05) break;
      last = drop.position.clone();
    }
    const cell = drop.position.floored();
    // Walk into the drop's own cell: standing next to a hole doesn't pick up what lies in it (the pickup box only
    // reaches half a block down), and with a "near" goal pathfinder filled the hole with scaffolding to stand on,
    // burying the drop. So the goal is the cell itself, and nothing may be placed there meanwhile.
    const goal = new goals.GoalBlock(cell.x, cell.y, cell.z);
    const noPlacing = (b: { position: Vec3 }) => (b.position.equals(cell) ? 100 : 0);
    const rules = pf.movements?.exclusionAreasPlace;
    rules?.push(noPlacing);
    try {
      if (typeof pf.getPathTo === 'function') {
        const plan = pf.getPathTo(pf.movements, goal, 500);
        if (plan.status !== 'success' || plan.cost > MAX_COLLECT_COST) { skipped.add(drop.id); continue; }
      }
      await Promise.race([
        bot.pathfinder.goto(goal),
        sleep(Math.max(0, deadline - Date.now())).then(() => { throw new Error('timeout'); })
      ]);
    } catch {
      bot.pathfinder.setGoal(null);
      return; // unreachable or out of time: leave it
    } finally {
      if (rules?.includes(noPlacing)) rules.splice(rules.indexOf(noPlacing), 1);
    }
    await sleep(250); // pickup happens on the server's next ticks
    if (bot.entities[drop.id]) skipped.add(drop.id); // stood on it and it's still there: don't loop on it
  }
}
