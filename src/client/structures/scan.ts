import { readBox } from '../brain/milestones.js';
import { diff, type Change } from './diff.js';
import type { Compiled } from './format.js';

type Io = { call: <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T> };

/**
 * The world at a structure's cells: the block at each (in the cells' order; null where the chunk isn't loaded) and
 * the text of the signs it has where it wants signs.
 */
export async function scan(io: Io, c: Compiled): Promise<{ world: (string | null)[]; signs: Record<string, string[]> }> {
  const { box } = c;
  const blocks = await readBox(io, box);
  const at = (x: number, y: number, z: number) => blocks[(x - box.x) + (z - box.z) * box.width + (y - box.y) * box.width * box.length] ?? null;
  const world = c.cells.map(cell => at(cell.at.x, cell.at.y, cell.at.z));
  const signs: Record<string, string[]> = {};
  for (let i = 0; i < c.cells.length; i++) {
    const cell = c.cells[i];
    if (!cell.sign || !/_sign/.test(world[i] ?? '')) continue;
    const r = await io.call<{ sign: boolean; lines?: string[] }>('sign.read', { ...cell.at }).catch(() => ({ sign: false, lines: [] }));
    if (r.sign) signs[`${cell.at.x},${cell.at.y},${cell.at.z}`] = r.lines ?? [];
  }
  return { world, signs };
}

/** Scan and diff in one. */
export async function plan(io: Io, c: Compiled): Promise<Change[]> {
  const { world, signs } = await scan(io, c);
  return diff(c.cells, world, signs);
}
