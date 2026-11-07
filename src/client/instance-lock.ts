import fs from 'fs';
import path from 'path';

/**
 * One client-backend server at a time per data folder. Every Claude session that lists the server starts its own
 * copy; two copies each launched a game client, both joined as the same player, and the server kicked one ("logged
 * in from another location"), while their two brains took turns writing the same brain.json. The first copy takes
 * the lock; the others don't launch a client or run a brain until it's free (a lock whose process is gone is stale).
 */
export interface InstanceLock {
  /** take it; null when taken, else the pid of the live process holding it */
  acquire(): number | null;
  release(): void;
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === 'EPERM'; }
};

export function fileLock(dir: string, pid = process.pid, isAlive: (pid: number) => boolean = alive): InstanceLock {
  const file = path.join(dir, 'client-backend.lock');
  let mine = false;
  return {
    acquire() {
      if (mine) return null;
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 2; i++) {
        try {
          fs.writeFileSync(file, JSON.stringify({ pid, since: new Date().toISOString() }), { flag: 'wx' });
          mine = true;
          return null;
        } catch (e) {
          if ((e as { code?: string }).code !== 'EEXIST') throw e;
        }
        let owner = NaN;
        try { owner = Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid); } catch { /* half-written or garbage: stale */ }
        if (owner === pid) { mine = true; return null; }
        if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) return owner;
        fs.rmSync(file, { force: true }); // stale: its process is gone
      }
      return Number.NaN;
    },
    release() {
      if (!mine) return;
      mine = false;
      try { if (Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid) === pid) fs.rmSync(file, { force: true }); } catch { /* gone already */ }
    }
  };
}
