import { sameBlock } from '../diff.js';
import { REACH, digFrom, diggable, placeFrom, placeRule, placeable, signHit, toward, workFrom, workable, type Dir } from './rules.js';
import type { Task } from './tasks.js';
import { AIR, FLOOR, PASSABLE, idOf, type P, type Voxels } from './world.js';

/**
 * The toolpath's instructions (Terraslicer's G-code), what each needs and what each does to the world. The slicer
 * plans with these on a copy of the world, the simulator replays a plan with them, the executor sends them to the mod.
 */
export interface Action {
  op: 'place' | 'dig' | 'work' | 'sign' | 'pillar' | 'descend';
  /** the cell acted on (pillar: the first block, under the feet; descend: the first block dug, under the feet) */
  at: P;
  /** the task it does */
  task?: number;
  /** place and sign: the item; work: the tool (hoe, shovel); pillar: the block it climbs on */
  item?: string;
  /** place and sign: the state it makes; dig: the block that was there; work: what the tool makes */
  state?: string;
  /** place and sign: the side of the target clicked against (the block there is the reference) */
  ref?: Dir;
  /** the yaw to place with (directional blocks) */
  look?: string;
  axis?: 'x' | 'y' | 'z';
  /** click a side face high (a top half) */
  top?: boolean;
  lines?: string[];
  /** pillar and descend: how many blocks */
  count?: number;
  /** a temporary block, or taking one away */
  scaffold?: boolean;
}

/** Order within a station: digs top down, then blocks bottom up, then tools on blocks, attached things, signs. */
export function priority(t: Task): number {
  if (t.kind === 'dig') return 1000 - t.at.y;
  if (t.kind === 'place' && !t.attached) return 1e6 + t.at.y;
  if (t.kind === 'work') return 2e6 + t.at.y;
  if (t.kind === 'place') return 3e6 + t.at.y;
  return 4e6 + t.at.y;
}

/** The task's result is already there (nothing to do: dug out by someone, built by hand). */
export function satisfied(w: Voxels, t: Task): boolean {
  const have = w.get(t.at) ?? 'unknown';
  if (t.kind === 'dig') return w.is(t.at, AIR);
  if (have === 'unknown') return false;
  return sameBlock(t.state, have) === 'same';
}

/** Whether the task can be done now from some spot: what it needs is there (the spot is doable's question). */
export function ready(w: Voxels, t: Task): boolean {
  if (t.kind === 'dig') return diggable(w, t.at);
  if (t.kind === 'work') return workable(w, t.at, t.state);
  return placeable(w, t.at, t.rule ?? placeRule(t.state));
}

/** The action that does the task from `feet`, or undefined when it can't from there. */
export function doable(w: Voxels, feet: P, t: Task, reach = REACH): Action | undefined {
  if (t.kind === 'dig') return digFrom(w, feet, t.at, reach) ? { op: 'dig', at: t.at, task: t.id, state: t.state, ...(t.scaffold ? { scaffold: true } : {}) } : undefined;
  if (t.kind === 'work') {
    if (feet.x === t.at.x && feet.z === t.at.z && feet.y <= t.at.y) return undefined;
    return workFrom(feet, t.at, reach) ? { op: 'work', at: t.at, task: t.id, item: t.item, state: t.state } : undefined;
  }
  const rule = t.rule ?? placeRule(t.state);
  const ref = placeFrom(w, feet, t.at, rule, reach, t.kind === 'sign' ? signHit : undefined);
  if (!ref) return undefined;
  if (t.kind === 'sign') return { op: 'sign', at: t.at, task: t.id, item: rule.item, state: t.state, ref, lines: t.lines ?? [] };
  return {
    op: 'place', at: t.at, task: t.id, item: t.item ?? rule.item, state: t.state, ref,
    ...(rule.look ? { look: rule.look } : {}), ...(rule.axis ? { axis: rule.axis } : {}), ...(rule.top ? { top: true } : {}),
    ...(t.scaffold ? { scaffold: true } : {})
  };
}

/** The other half of a door or a bed, where it goes. */
function otherHalf(at: P, state: string): { at: P; state: string } | undefined {
  const facing = /facing=(north|south|east|west)/.exec(state)?.[1] as Dir | undefined;
  if (/_door\[/.test(state)) {
    return /half=upper/.test(state) ? { at: toward(at, 'down'), state: state.replace('half=upper', 'half=lower') }
      : { at: toward(at, 'up'), state: state.includes('half=') ? state.replace('half=lower', 'half=upper') : state };
  }
  if (/_bed\[/.test(state) && facing) {
    return /part=head/.test(state) ? { at: toward(at, OPPOSITE[facing]), state: state.replace('part=head', 'part=foot') }
      : { at: toward(at, facing), state: state.includes('part=') ? state.replace('part=foot', 'part=head') : state };
  }
  return undefined;
}
const OPPOSITE: Record<string, Dir> = { north: 'south', south: 'north', east: 'west', west: 'east' };

/** What the action does to the world (the bot's own position aside: see `after`). */
export function applyAction(w: Voxels, a: Action): void {
  switch (a.op) {
    case 'dig': {
      const there = w.get(a.at) ?? '';
      w.set(a.at, 'air');
      const o = otherHalf(a.at, there);
      if (o && idOf(w.get(o.at)) === idOf(there)) w.set(o.at, 'air');
      break;
    }
    case 'place': case 'sign': case 'work': {
      w.set(a.at, a.state!);
      if (a.op !== 'work') { const o = otherHalf(a.at, a.state!); if (o) w.set(o.at, o.state); }
      break;
    }
    case 'pillar':
      for (let k = 0; k < (a.count ?? 1); k++) w.set({ x: a.at.x, y: a.at.y + k, z: a.at.z }, a.state ?? a.item!);
      break;
    case 'descend':
      for (let k = 0; k < (a.count ?? 1); k++) w.set({ x: a.at.x, y: a.at.y - k, z: a.at.z }, 'air');
      break;
  }
}

/** Where the bot stands after the action, if it moves it (a pillar lifts it, a descent lowers it). */
export function after(feet: P, a: Action): P {
  if (a.op === 'pillar') return { x: feet.x, y: feet.y + (a.count ?? 1), z: feet.z };
  if (a.op === 'descend') return { x: feet.x, y: feet.y - (a.count ?? 1), z: feet.z };
  return feet;
}

/** Why the bot standing at `feet` can't do the action in the world as it is (the simulator's check), or undefined. */
export function problem(w: Voxels, feet: P, a: Action, reach = REACH): string | undefined {
  const at = `${a.op} at ${a.at.x},${a.at.y},${a.at.z}`;
  switch (a.op) {
    case 'dig':
      return digFrom(w, feet, a.at, reach) ? undefined : `${at}: not in reach or in sight from ${feet.x},${feet.y},${feet.z}`;
    case 'work':
      if (!workable(w, a.at, a.state!)) return `${at}: ${w.get(a.at)} can't be worked into ${a.state}`;
      return workFrom(feet, a.at, reach) ? undefined : `${at}: out of reach`;
    case 'place': case 'sign': {
      const rule = placeRule(a.state!);
      if (!placeable(w, a.at, rule)) return `${at}: can't take ${a.state} now (cell ${w.get(a.at)}, or nothing to place it against)`;
      if (!a.ref || !rule.refs.includes(a.ref)) return `${at}: ${a.ref} isn't a side ${a.state} goes against`;
      const ref = placeFrom(w, feet, a.at, { ...rule, refs: [a.ref] }, reach, a.op === 'sign' ? signHit : undefined);
      return ref ? undefined : `${at}: the ${a.ref} side isn't solid, or out of reach from ${feet.x},${feet.y},${feet.z}`;
    }
    case 'pillar': {
      if (a.at.x !== feet.x || a.at.z !== feet.z || a.at.y !== feet.y) return `${at}: a pillar starts under the feet`;
      for (let k = 0; k < (a.count ?? 1); k++) {
        if (!w.is({ x: feet.x, y: feet.y + k + 2, z: feet.z }, PASSABLE)) return `${at}: no head room to climb`;
      }
      return undefined;
    }
    case 'descend': {
      if (a.at.x !== feet.x || a.at.z !== feet.z || a.at.y !== feet.y - 1) return `${at}: a descent digs under the feet`;
      for (let k = 0; k < (a.count ?? 1); k++) if (w.is({ x: feet.x, y: feet.y - 1 - k, z: feet.z }, AIR)) return `${at}: nothing to dig ${k + 1} under the feet`;
      if (!w.is({ x: feet.x, y: feet.y - 1 - (a.count ?? 1), z: feet.z }, FLOOR)) return `${at}: no floor at the bottom`;
      return undefined;
    }
  }
  return undefined;
}

