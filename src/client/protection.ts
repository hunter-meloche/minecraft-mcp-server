import type { ProtectionStore } from '../build-protection.js';

interface Pos { x: number; y: number; z: number }

/**
 * Blocks the bot built (build-structure cells, place-block), so mine-blocks won't take them back: Baritone's mine
 * process takes the nearest blocks of a type, and the nearest oak logs are the cabin's walls. Kept per world (by
 * hashed seed) in the same store and key format as the mineflayer backend's build protection.
 *
 * Each position may also carry the block state that stood there when the bot built it ("oak_stairs[facing=east,...]",
 * as world.region gives it), so a later check can tell what went missing and put it back. The keys stay the shared
 * list ("dim:x,y,z"); the states go beside them through the store's optional `loadStates` and the third argument of
 * `save` (jsonFileStore keeps them under the file's "$states" entry), so a file with only keys loads as positions
 * without states, and the mineflayer backend, which saves keys alone, leaves the states as they are.
 */
export class ClientProtection {
  private blocks = new Set<string>();
  private states = new Map<string, string>();
  private world?: string;
  /** bumped on every change, so a copy elsewhere knows when to refresh */
  version = 0;

  constructor(private readonly store?: ProtectionStore) {}

  /** Switch to a world (loads its list once). */
  attach(world: string | undefined): void {
    if (!world || world === this.world) return;
    this.world = world;
    this.blocks = new Set(this.store?.load(world) ?? []);
    const states = this.store?.loadStates?.(world) ?? {};
    // a state for a key no longer listed (the mineflayer backend dropped it) is stale
    this.states = new Map(Object.entries(states).filter(([k, v]) => this.blocks.has(k) && typeof v === 'string'));
    this.version++;
  }

  /** The protected positions in one dimension. */
  positions(dimension: string): Pos[] {
    return this.entries(dimension).map(e => e.at);
  }

  /** The protected positions in one dimension with the block state remembered for each (undefined when none was). */
  entries(dimension: string): { at: Pos; state?: string }[] {
    const out: { at: Pos; state?: string }[] = [];
    for (const k of this.blocks) {
      const [dim, xyz] = k.split(':');
      if (dim !== dimension) continue;
      const [x, y, z] = xyz.split(',').map(Number);
      const state = this.states.get(k);
      out.push(state === undefined ? { at: { x, y, z } } : { at: { x, y, z }, state });
    }
    return out;
  }

  private key(dimension: string, p: Pos): string {
    return `${dimension}:${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  }

  has(dimension: string, p: Pos): boolean {
    return this.blocks.has(this.key(dimension, p));
  }

  /** The block state remembered for a protected position, if one was. */
  stateOf(dimension: string, p: Pos): string | undefined {
    return this.states.get(this.key(dimension, p));
  }

  /**
   * Protect positions; `states[i]`, when given, is the block now standing at `positions[i]` and replaces any state
   * remembered there (undefined keeps the old one).
   */
  add(dimension: string, positions: Pos[], states?: (string | undefined)[]): void {
    let changed = false;
    positions.forEach((p, i) => {
      const k = this.key(dimension, p);
      if (!this.blocks.has(k)) { this.blocks.add(k); changed = true; }
      const st = states?.[i];
      if (st !== undefined && this.states.get(k) !== st) { this.states.set(k, st); changed = true; }
    });
    if (changed) this.save();
  }

  remove(dimension: string, p: Pos): void {
    const k = this.key(dimension, p);
    this.states.delete(k);
    if (this.blocks.delete(k)) this.save();
  }

  get size(): number { return this.blocks.size; }

  private save(): void {
    this.version++;
    if (this.store && this.world) this.store.save(this.world, [...this.blocks], Object.fromEntries(this.states));
  }
}
