import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

const NEIGHBOURS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

/** Is any face of the block at `pos` touching lava? Breaking it would let the lava in. */
export function touchesLava(bot: Pick<mineflayer.Bot, 'blockAt'>, pos: Vec3): boolean {
  return NEIGHBOURS.some(d => bot.blockAt(pos.plus(d))?.name === 'lava');
}

interface SafeMovements {
  maxDropDown: number;
  allowParkour: boolean;
  liquidCost: number;
  exclusionAreasBreak: ((block: { position: Vec3 }) => number)[];
  getBlock: (node: unknown, dx: number, dy: number, dz: number) => { physical: boolean };
  getMoveDiagonal: (node: unknown, dir: { x: number; z: number }, neighbors: unknown[]) => unknown;
}

/**
 * Pathfinder settings that stop it walking the bot into harm, after the cow chase that ended in lava ("unknown"
 * damage x5) and a 9-block fall down a shaft. Same choices as rmalde/minecraft-agent, which runs long survival
 * routes with them:
 * - never break a block that touches lava (cost 100 = never)
 * - drop at most 3 blocks (a 4-block drop already costs a heart)
 * - no parkour jumps over gaps
 * - swimming costs more, so walking routes win
 * - a flat diagonal step needs both sides clear: pathfinder accepts one clear side, and the bot then catches on
 *   the corner and stops
 */
export function applyMovementSafety(bot: Pick<mineflayer.Bot, 'blockAt'>, movements: SafeMovements): void {
  movements.maxDropDown = 3;
  movements.allowParkour = false;
  movements.liquidCost = 5;
  movements.exclusionAreasBreak.push(block => (touchesLava(bot, block.position) ? 100 : 0));

  const diagonal = movements.getMoveDiagonal.bind(movements);
  movements.getMoveDiagonal = (node, dir, neighbors) => {
    const landing = movements.getBlock(node, dir.x, 0, dir.z);
    if (!landing.physical) {
      const sideBlocked = [[dir.x, 0], [0, dir.z]].some(([x, z]) => [0, 1].some(y => movements.getBlock(node, x, y, z).physical));
      if (sideBlocked) return undefined;
    }
    return diagonal(node, dir, neighbors);
  };
}
