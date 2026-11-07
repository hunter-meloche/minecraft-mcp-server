import type { Change } from '../diff.js';
import { placeRule, WORKED, type PlaceRule } from './rules.js';
import { LIQUID, REPLACEABLE, classOf, idOf, type P } from './world.js';

/**
 * What the diff asks for, as the bot's own steps: dig a block out, place one, work one with a tool (farmland is dirt
 * tilled with a hoe: no item places it), place a sign with its text. A replacement is a dig, then a place, in that
 * order; a flower in the way is dug first (a block doesn't go into a flower's cell).
 */

export type TaskKind = 'dig' | 'place' | 'work' | 'sign';

export interface Task {
  id: number;
  kind: TaskKind;
  at: P;
  /** dig: the block there; place and sign: the state to place; work: the state the tool makes (farmland) */
  state: string;
  /** place and sign: the item; work: the tool (hoe, shovel) */
  item?: string;
  rule?: PlaceRule;
  lines?: string[];
  /** done first: the dig before the place in the same cell, the dirt before the tilling */
  needs: number[];
  /** done or given up first: a scaffold block's removal waits for what it was put up for */
  after?: number[];
  /** hangs on or stands on something (torches, doors, beds...): weighed lower, done after the block it rests on */
  attached?: boolean;
  /** a temporary block (scaffold), or its removal */
  scaffold?: boolean;
}

/** A cell the bot can't do anything about by itself, and why. */
export interface Skipped { at: P; want: string; why: string }

export function tasksFor(changes: Change[], firstId = 0): { tasks: Task[]; skipped: Skipped[] } {
  const tasks: Task[] = [];
  const skipped: Skipped[] = [];
  let id = firstId;
  const add = (t: Omit<Task, 'id'>) => { const task = { ...t, id: id++ }; tasks.push(task); return task; };
  for (const c of changes) {
    if (c.kind === 'ok' || c.second) continue;
    const have = idOf(c.have);
    const hc = classOf(c.have || 'air');
    // something in the cell a placed block doesn't go into (a flower, a wrong block)
    const inTheWay = !(hc & REPLACEABLE);
    const dig = () => add({ kind: 'dig', at: c.at, state: c.have, needs: [] });
    if (c.want === 'air') {
      if (hc & LIQUID) skipped.push({ at: c.at, want: c.want, why: `${have} there: the bot can't empty it` });
      else if (have) dig();
      continue;
    }
    const want = idOf(c.want);
    const worked = WORKED[want];
    if (worked) {
      // farmland and paths: the bot makes them from dirt with its hoe or shovel
      if (worked.from.test(have)) { add({ kind: 'work', at: c.at, state: c.want, item: worked.tool, needs: [] }); continue; }
      const first = inTheWay ? [dig().id] : [];
      const dirt = add({ kind: 'place', at: c.at, state: 'dirt', item: 'dirt', rule: placeRule('dirt'), needs: first });
      add({ kind: 'work', at: c.at, state: c.want, item: worked.tool, needs: [dirt.id] });
      continue;
    }
    // grass doesn't come as an item: dirt (the grass grows over it; the diff takes dirt for grass)
    const state = want === 'grass_block' ? 'dirt' : c.want;
    const rule = placeRule(state);
    if (rule.unsupported) { skipped.push({ at: c.at, want: c.want, why: rule.unsupported }); continue; }
    const sign = !!c.sign || /_sign$/.test(want);
    const first = inTheWay || c.kind === 'replace' || c.kind === 'restate' || c.kind === 'sign' ? [dig().id] : [];
    add({
      kind: sign ? 'sign' : 'place', at: c.at, state, item: rule.item, rule, needs: first,
      ...(sign ? { lines: c.sign ?? [] } : {}), ...(rule.attached ? { attached: true } : {})
    });
  }
  return { tasks, skipped };
}
