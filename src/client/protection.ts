import type { ProtectionStore } from '../build-protection.js';

interface Pos { x: number; y: number; z: number }

/**
 * Blocks the bot built (build-structure cells, place-block), so mine-blocks won't take them back: Baritone's mine
 * process takes the nearest blocks of a type, and the nearest oak logs are the cabin's walls. Kept per world (by
 * hashed seed) in the same store and key format as the mineflayer backend's build protection.
 */
export class ClientProtection {
  private blocks = new Set<string>();
  private world?: string;
  /** bumped on every change, so a copy elsewhere knows when to refresh */
  version = 0;

  constructor(private readonly store?: ProtectionStore) {}

  /** Switch to a world (loads its list once). */
  attach(world: string | undefined): void {
    if (!world || world === this.world) return;
    this.world = world;
    this.blocks = new Set(this.store?.load(world) ?? []);
    this.version++;
  }

  /** The protected positions in one dimension. */
  positions(dimension: string): Pos[] {
    const out: Pos[] = [];
    for (const k of this.blocks) {
      const [dim, xyz] = k.split(':');
      if (dim !== dimension) continue;
      const [x, y, z] = xyz.split(',').map(Number);
      out.push({ x, y, z });
    }
    return out;
  }

  private key(dimension: string, p: Pos): string {
    return `${dimension}:${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  }

  has(dimension: string, p: Pos): boolean {
    return this.blocks.has(this.key(dimension, p));
  }

  add(dimension: string, positions: Pos[]): void {
    let changed = false;
    for (const p of positions) {
      const k = this.key(dimension, p);
      if (!this.blocks.has(k)) { this.blocks.add(k); changed = true; }
    }
    if (changed) this.save();
  }

  remove(dimension: string, p: Pos): void {
    if (this.blocks.delete(this.key(dimension, p))) this.save();
  }

  get size(): number { return this.blocks.size; }

  private save(): void {
    this.version++;
    if (this.store && this.world) this.store.save(this.world, [...this.blocks]);
  }
}
