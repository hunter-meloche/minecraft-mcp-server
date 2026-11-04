import type { BridgeEvent } from './bridge-client.js';

/**
 * The client backend's version of auto-defend's takeAlerts: collects bridge events (hurt, death, respawn, guardian
 * notes) and turns them into the "[!] ..." line tool replies end with. Same wording as the mineflayer backend.
 */

interface Pos { x: number; y: number; z: number }
interface Death { message: string; at?: Pos; respawnedAt?: Pos }

const where = (p?: Pos) => (p ? `(${p.x}, ${p.y}, ${p.z})` : 'an unknown spot');

export class AlertCollector {
  private hurts: { by: string }[] = [];
  private deaths: Death[] = [];
  private notes: string[] = [];
  private health: number | null = null;

  handle(event: BridgeEvent): void {
    switch (event.type) {
      case 'hurt': {
        const cause = String(event.cause ?? 'unknown');
        const source = event.source ? String(event.source) : null;
        this.hurts.push({ by: source ? (cause === 'mob_attack' ? source : `${cause} from ${source}`) : cause });
        if (typeof event.health === 'number') this.health = event.health;
        break;
      }
      case 'death':
        this.deaths.push({ message: String(event.message ?? 'cause unknown'), at: event.at as Pos | undefined });
        break;
      case 'respawn': {
        const last = this.deaths.at(-1);
        if (last && !last.respawnedAt) last.respawnedAt = event.at as Pos | undefined;
        this.health = 20;
        break;
      }
      case 'guardian':
        if (event.note) this.notes.push(String(event.note));
        break;
      default:
        break;
    }
  }

  /** The alert text since the last call, or null when nothing happened. */
  take(): string | null {
    if (!this.hurts.length && !this.deaths.length && !this.notes.length) return null;
    const parts: string[] = this.deaths.map(d =>
      `DIED: ${d.message} at ${where(d.at)}.` + (d.respawnedAt ? ` Respawned at ${where(d.respawnedAt)}.` : '') +
      ' Everything carried was dropped at the death spot; it despawns after 5 minutes (explosions destroy it sooner)');
    parts.push(...this.notes);
    if (this.hurts.length) {
      const by = new Map<string, number>();
      for (const h of this.hurts) by.set(h.by, (by.get(h.by) ?? 0) + 1);
      parts.push(`Took damage ${this.hurts.length}x (${[...by].map(([n, c]) => `${n} x${c}`).join(', ')})` +
        (this.health !== null ? `; health ${this.health}/20` : ''));
    }
    this.hurts = [];
    this.deaths = [];
    this.notes = [];
    return parts.join('; ');
  }
}

/** "<Name> hello" -> { username: Name, message: hello }; system lines -> null. */
export function parsePlayerChat(text: string): { username: string; message: string } | null {
  const m = /^<([^>]{1,32})> (.*)$/s.exec(text);
  return m ? { username: m[1], message: m[2] } : null;
}
