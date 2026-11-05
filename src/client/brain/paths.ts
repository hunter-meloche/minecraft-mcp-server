/**
 * Where the bot actually walks. Counting the cells it passes through shows its routes (to the lake, the woods, the
 * mine) without any map of them; the routes are then worth lighting so the walk home at night isn't through a
 * spawning ground. Pure: no world access, the caller samples positions and answers light questions by callback.
 */

export interface HeatCell { x: number; z: number; heat: number }

export interface HeatOptions {
  /** most a single cell can hold, so a spot the bot stands on all day doesn't drown every route (default 1000) */
  cap?: number;
  /** cells kept at most; the coldest go first (default 4000, small enough for brain.json) */
  maxCells?: number;
}

/** Compact form for brain.json: a flat [x, z, heat, x, z, heat, ...] list, heat rounded to tenths. */
export interface HeatJSON { v: 1; c: number[] }

const key = (x: number, z: number) => `${x},${z}`;

/** Visits per block column (x, z), y ignored. */
export class HeatMap {
  readonly cap: number;
  readonly maxCells: number;
  private cells = new Map<string, number>();
  private last: string | null = null;

  constructor(opts: HeatOptions = {}) {
    this.cap = opts.cap ?? 1000;
    this.maxCells = opts.maxCells ?? 4000;
  }

  /**
   * Count the bot passing through the cell at pos. A sample in the same cell as the previous one is ignored: standing
   * still (waiting, mining, fishing) isn't walking, and would otherwise turn a work spot into a "route".
   */
  visit(pos: { x: number; z: number }, n = 1): void {
    const x = Math.floor(pos.x), z = Math.floor(pos.z);
    const k = key(x, z);
    if (k === this.last) return;
    this.last = k;
    this.cells.set(k, Math.min(this.cap, (this.cells.get(k) ?? 0) + n));
    if (this.cells.size > this.maxCells * 1.25) this.prune(this.maxCells);
  }

  get(x: number, z: number): number { return this.cells.get(key(Math.floor(x), Math.floor(z))) ?? 0; }

  get size(): number { return this.cells.size; }

  /** Fade old routes (e.g. 0.9 a day) so a path the bot stopped using stops being lit; cells below minKeep are dropped. */
  decay(factor: number, minKeep = 0.5): void {
    for (const [k, v] of this.cells) {
      const nv = v * factor;
      if (nv < minKeep) this.cells.delete(k); else this.cells.set(k, nv);
    }
  }

  /** Every cell, hottest first (ties in x, then z order, so results are stable). */
  list(): HeatCell[] {
    const out: HeatCell[] = [];
    for (const [k, heat] of this.cells) { const [x, z] = k.split(',').map(Number); out.push({ x, z, heat }); }
    return out.sort((a, b) => b.heat - a.heat || a.x - b.x || a.z - b.z);
  }

  private prune(keep: number) {
    if (this.cells.size <= keep) return;
    const hot = this.list().slice(0, keep);
    this.cells = new Map(hot.map(c => [key(c.x, c.z), c.heat]));
  }

  toJSON(): HeatJSON {
    const c: number[] = [];
    for (const cell of this.list().slice(0, this.maxCells)) c.push(cell.x, cell.z, Math.round(cell.heat * 10) / 10);
    return { v: 1, c };
  }

  /** Rebuild from toJSON output; anything malformed gives an empty (or partial) map rather than an error. */
  static fromJSON(json: unknown, opts: HeatOptions = {}): HeatMap {
    const m = new HeatMap(opts);
    const c = (json as Partial<HeatJSON> | null)?.c;
    if (!Array.isArray(c)) return m;
    for (let i = 0; i + 2 < c.length; i += 3) {
      const [x, z, h] = [c[i], c[i + 1], c[i + 2]];
      if (![x, z, h].every(v => typeof v === 'number' && Number.isFinite(v)) || h <= 0) continue;
      m.cells.set(key(Math.floor(x), Math.floor(z)), Math.min(m.cap, h));
    }
    m.prune(m.maxCells);
    return m;
  }
}

/** Cells walked at least minVisits times, hottest first: the bot's routes. */
export function routeCells(heat: HeatMap, minVisits: number): HeatCell[] {
  return heat.list().filter(c => c.heat >= minVisits);
}

/**
 * Torch spots along the bot's routes outside the yard (the yard has its own lighting). Candidates are route cells
 * (at least minVisits) that are dark (block light 0 at the ground: mobs can spawn there) and not excluded. Greedy,
 * hottest first: an uncovered cell (no torch within spacing/2) gets a torch on itself, or else on the hottest
 * candidate within spacing/2 of it, provided no torch is then closer than `spacing` to another. Cells that can't be
 * covered without crowding are left for the next pass (the caller re-reads the light after placing). Distances are
 * straight-line. Returns the spots hottest first.
 */
export function pathTorchSpots(heat: HeatMap, isDark: (x: number, z: number) => boolean, spacing = 10,
  exclude: (x: number, z: number) => boolean = () => false, minVisits = 3): HeatCell[] {
  const cands = routeCells(heat, minVisits).filter(c => !exclude(c.x, c.z) && isDark(c.x, c.z));
  const torches: HeatCell[] = [];
  const d = (a: HeatCell, b: HeatCell) => Math.hypot(a.x - b.x, a.z - b.z);
  const reach = spacing / 2;
  const roomy = (c: HeatCell) => torches.every(t => d(t, c) >= spacing);
  for (const c of cands) {
    if (torches.some(t => d(t, c) <= reach)) continue;
    // cands is hottest first, so the first roomy one near c is the hottest
    const spot = roomy(c) ? c : cands.find(o => d(o, c) <= reach && roomy(o));
    if (spot) torches.push(spot);
  }
  return torches.sort((a, b) => b.heat - a.heat || a.x - b.x || a.z - b.z);
}
