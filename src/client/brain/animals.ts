/**
 * The animal pens: keep each pen stocked (lure strays in), breed it up to a herd, cull the surplus for food, and
 * shear the sheep. Pure decision helpers: the brain does the walking, feeding and hitting.
 */

export type PenKind = 'cow' | 'sheep' | 'chicken' | 'pig';
/** A pen's fence corners (block coordinates, inclusive) and the animal it keeps. */
export interface Pen { x1: number; z1: number; x2: number; z2: number; kind: PenKind }
export interface Animal {
  id: number; name: string; position: { x: number; y: number; z: number }; distance: number;
  baby?: boolean; inLove?: boolean;
  /** Only when the client could tell; sheep with no wool state are never sheared on a guess. */
  sheared?: boolean;
}

/** Breeding (and luring) food per animal, the usual one first; any of them works. */
export const PEN_FOOD: Readonly<Record<PenKind, readonly string[]>> = {
  cow: ['wheat'], sheep: ['wheat'],
  chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds'],
  pig: ['carrot', 'potato', 'beetroot']
};
/** How far to look for strays to lure (animals follow held food from about 10 blocks; the bot walks to the rest). */
export const LURE_RANGE = 32;

const bare = (name: string) => name.replace(/^minecraft:/, '');

/** Inside the fence: entity positions are fractional, so a block column x covers [x, x + 1). */
export function inPen(pen: Pen, p: { x: number; z: number }): boolean {
  return p.x >= Math.min(pen.x1, pen.x2) && p.x < Math.max(pen.x1, pen.x2) + 1
    && p.z >= Math.min(pen.z1, pen.z2) && p.z < Math.max(pen.z1, pen.z2) + 1;
}

export interface PenState {
  inside: { adults: number; babies: number };
  adults: Animal[];
  babies: Animal[];
  /** Adults of the pen's kind outside it within LURE_RANGE, nearest first. */
  outsideNear: Animal[];
}

export function penState(pen: Pen, entities: Animal[]): PenState {
  const mine = entities.filter(e => bare(e.name) === pen.kind);
  const inside = mine.filter(e => inPen(pen, e.position));
  const adults = inside.filter(e => !e.baby);
  const babies = inside.filter(e => e.baby);
  const outsideNear = mine.filter(e => !e.baby && !inPen(pen, e.position) && e.distance <= LURE_RANGE)
    .sort((a, b) => a.distance - b.distance);
  return { inside: { adults: adults.length, babies: babies.length }, adults, babies, outsideNear };
}

export type AnimalAction =
  | { kind: 'lure'; target: number; food: string }
  | { kind: 'breed'; ids: [number, number]; food: string }
  | { kind: 'cull'; id: number }
  | { kind: 'shear'; id: number }
  | { kind: 'wait'; why: string };

export interface AnimalOpts {
  minAdults?: number;
  maxAdults?: number;
  /** False for an animal fed less than 5 minutes ago (it can't breed again yet; the client can't see that). */
  breedCooldownOk?: (id: number) => boolean;
}

/** The carried food for a pen with the most of it. */
function foodFor(kind: PenKind, counts: Map<string, number> | Record<string, number>): { food: string; n: number } {
  const get = (n: string) => (counts instanceof Map ? counts.get(n) : counts[n]) ?? 0;
  return PEN_FOOD[kind].map(food => ({ food, n: get(food) })).reduce((a, b) => (b.n > a.n ? b : a));
}

/**
 * The one thing to do next at a pen, in order: lure strays in while there are too few adults to breed from, cull
 * the surplus beyond `maxAdults` (never below `minAdults`), shear woolly sheep, breed while the herd (babies counted:
 * they grow up and would only be culled) is below `maxAdults`, else wait. A lure that can't happen (no strays, no
 * food) falls through to the rest, so a pen that already has two adults still breeds.
 */
export function nextAnimalAction(pen: Pen, entities: Animal[], counts: Map<string, number> | Record<string, number>, opts: AnimalOpts = {}): AnimalAction {
  const minAdults = opts.minAdults ?? 2;
  const maxAdults = Math.max(minAdults, opts.maxAdults ?? 8);
  const cooldownOk = opts.breedCooldownOk ?? (() => true);
  const s = penState(pen, entities);
  const { food, n } = foodFor(pen.kind, counts);
  const has = (item: string) => ((counts instanceof Map ? counts.get(item) : counts[item]) ?? 0) > 0;
  const why: string[] = [];

  if (s.inside.adults < minAdults) {
    if (!s.outsideNear.length) why.push(`${s.inside.adults} ${pen.kind} in the pen and none within ${LURE_RANGE} to lure`);
    else if (n < 1) why.push(`no ${PEN_FOOD[pen.kind][0]} to lure a ${pen.kind} with`);
    else return { kind: 'lure', target: s.outsideNear[0].id, food };
  }
  if (s.inside.adults > maxAdults) {
    // not one that's in love: it was just fed to breed
    const victim = [...s.adults].sort((a, b) => Number(!!a.inLove) - Number(!!b.inLove) || a.distance - b.distance)[0];
    return { kind: 'cull', id: victim.id };
  }
  if (pen.kind === 'sheep' && has('shears')) {
    const woolly = s.adults.filter(e => e.sheared === false).sort((a, b) => a.distance - b.distance)[0];
    if (woolly) return { kind: 'shear', id: woolly.id };
  }
  if (s.inside.adults + s.inside.babies < maxAdults) {
    const ready = s.adults.filter(e => !e.inLove && cooldownOk(e.id)).sort((a, b) => a.distance - b.distance);
    if (ready.length < 2) why.push(`${ready.length} ${pen.kind} ready to breed`);
    else if (n < 2) why.push(`need 2 ${PEN_FOOD[pen.kind][0]} to breed (have ${n})`);
    else return { kind: 'breed', ids: [ready[0].id, ready[1].id], food };
  } else why.push(`the pen is full (${s.inside.adults} adults, ${s.inside.babies} babies)`);
  return { kind: 'wait', why: why.join('; ') };
}
