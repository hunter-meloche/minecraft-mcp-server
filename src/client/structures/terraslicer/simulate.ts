import { sameBlock, type Change } from '../diff.js';
import { after, applyAction, problem } from './actions.js';
import type { Toolpath } from './slicer.js';
import { walkFrom, key, type P, type Voxels } from './world.js';

/**
 * Replay a toolpath on a copy of the world it was sliced from, checking every step the way the mod will meet it: the
 * station walkable from the last, each action's support present and in reach, nothing placed into the bot's own cells.
 * A plan has to pass this before it's kept; the tests run it on everything the slicer makes.
 */

export interface Replay { problems: string[]; world: Voxels; end: P }

export function replay(world: Voxels, path: Toolpath, reach?: number): Replay {
  const w = world.clone();
  let pos = path.start;
  const problems: string[] = [];
  path.stations.forEach((s, n) => {
    const where = `station ${n + 1} at ${key(s.at)}`;
    if (!w.standable(s.at)) problems.push(`${where}: nowhere to stand`);
    else if (!s.hop) {
      const walk = walkFrom(w, pos);
      const i = w.index(s.at);
      if (i < 0 || !Number.isFinite(walk.cost[i])) problems.push(`${where}: can't walk there from ${key(pos)}`);
    }
    let feet = s.at;
    for (const a of s.actions) {
      const why = problem(w, feet, a, reach);
      if (why) problems.push(`${where}: ${why}`);
      applyAction(w, a);
      feet = after(feet, a);
    }
    pos = feet;
  });
  return { problems, world: w, end: pos };
}

/** The changes the replayed world still doesn't match (cells left over, or done wrong). */
export function unmatched(w: Voxels, changes: Change[]): Change[] {
  return changes.filter(c => {
    if (c.kind === 'ok' || c.second) return false;
    const have = w.get(c.at);
    if (have === undefined) return true;
    if (c.want === 'air') return !/^(air|cave_air|void_air)$/.test(have);
    // grass comes as dirt; the rest as asked
    return !(sameBlock(c.want, have) === 'same' || (/^grass_block/.test(c.want) && /^dirt$/.test(have)));
  });
}
