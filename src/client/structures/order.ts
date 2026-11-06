import { parse, type Change } from './diff.js';

/**
 * The order to work the changes in, as packages of a few dozen cells (a package is what one run of the build goal
 * does before it hands back to the brain, which may then stop for something more urgent and come back later):
 * 1. clearing: cells to empty, and blocks in the way of a replacement or the wrong way round, from the top down;
 * 2. placing: bottom layer first, so everything has something under it, in a back-and-forth walking order;
 * 3. attachables last: torches, signs, doors, beds, ladders, buttons, carpets... they hang on or stand on the rest.
 */

export interface Package { phase: 'clear' | 'build' | 'attach'; changes: Change[] }

export const PACKAGE_SIZE = 48;
const ATTACHED = /(^|_)(torch|wall_torch|lantern|sign|wall_sign|hanging_sign|door|bed|ladder|button|lever|carpet|rail|pressure_plate|banner|wall_banner|flower_pot|trapdoor|tripwire_hook|candle|chain|bell|item_frame|skull|head)$/;

export const isAttached = (state: string) => ATTACHED.test(parse(state).id);

/** Serpentine order in a layer: rows along z, every other row walked back along x. */
const walk = (a: Change, b: Change) => a.at.z - b.at.z || (a.at.z % 2 === 0 ? a.at.x - b.at.x : b.at.x - a.at.x);

export function packages(changes: Change[], size = PACKAGE_SIZE): Package[] {
  const todo = changes.filter(c => c.kind !== 'ok' && !c.second);
  const out: Package[] = [];
  const chunk = (phase: Package['phase'], list: Change[]) => {
    for (let i = 0; i < list.length; i += size) out.push({ phase, changes: list.slice(i, i + size) });
  };
  // what's in the way, top down (a block above never ends up unsupported mid-clear: nothing here is placed yet)
  chunk('clear', todo.filter(c => c.kind === 'clear' || c.kind === 'replace' || c.kind === 'restate')
    .sort((a, b) => b.at.y - a.at.y || walk(a, b)));
  const place = todo.filter(c => c.kind !== 'clear');
  // per layer, so a package never mixes a floor with the wall on it
  const byLayer = (list: Change[]) => {
    const ys = [...new Set(list.map(c => c.at.y))].sort((a, b) => a - b);
    for (const y of ys) chunk(list === solid ? 'build' : 'attach', list.filter(c => c.at.y === y).sort(walk));
  };
  const solid = place.filter(c => !isAttached(c.want) && c.kind !== 'sign');
  const attached = place.filter(c => isAttached(c.want) || c.kind === 'sign');
  byLayer(solid);
  byLayer(attached);
  return out;
}
