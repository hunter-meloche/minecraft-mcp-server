import type { InventoryItem, Status } from '../tools.js';
import type { Activity } from './schedule.js';
import type { Pos, WorldMemory } from './memory.js';

/** What the brain knows at one moment: read fresh each tick. */
export interface Snapshot {
  /** real time, ms */
  now: number;
  timeOfDay: number;
  activity: Activity;
  health: number;
  food: number;
  position: Pos;
  dimension: string;
  sleeping: boolean;
  raining: boolean;
  thundering: boolean;
  /** the Baritone process running, if any */
  process: string | null;
  items: InventoryItem[];
  counts: Map<string, number>;
  /** main inventory slots in use (of 36) */
  slotsUsed: number;
  home?: Pos & { dimension: string };
  /** other players' builds the mod has seen (zones), and the nearest one's distance */
  /** others' builds the mod has seen: how many, how many on the surface, the nearest on the surface (straight line) */
  foreign?: { zones: number; surface?: number; nearest: number | null };
  /** horizontal distance to home; Infinity with no home or in another dimension */
  distHome: number;
  /** boxed in where it stands (see Status.boxedIn): the wall cells to dig out, if it built them */
  boxedIn?: Pos[];
  /** experience level (enchanting costs up to 30) */
  xpLevel?: number;
}

export interface GoalContext {
  s: Snapshot;
  world: WorldMemory;
  signal: AbortSignal;
  /** run a client tool (the same code the LLM calls) */
  act: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  call: <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  status: () => Promise<Status>;
  /** log a step as it happens (a job stopped midway still shows what it got done) */
  progress: (text: string) => void;
}

/**
 * One behaviour, like a mob AI goal: it says when it wants to run (and why), and how. The brain runs the most
 * urgent one that wants to; a more urgent one can stop it midway.
 */
export interface Goal {
  name: string;
  /** higher runs first and may interrupt lower */
  priority: number;
  /** a priority that changes with the state (a project waiting too long moves up); default: priority */
  urgency?: (s: Snapshot, world: WorldMemory) => number;
  /** why it should run now, or null */
  wants: (s: Snapshot, world: WorldMemory) => string | null;
  /** does the work; returns what it did, throws when it failed */
  run: (ctx: GoalContext) => Promise<string>;
  /** stopped after this long */
  timeoutMs: number;
  /** wait after a failure before trying again */
  retryMs: number;
  /** can a more urgent goal stop it midway (default yes) */
  interruptible?: boolean;
  /** may run while the bot is in bed (everything else waits for morning) */
  whileAsleep?: boolean;
}

/** Close enough to home to count as there. */
export const AT_HOME = 3;
/** Within this of home the bot is in its yard. */
export const IN_YARD = 16;

/** Out of bed in the morning (beds wake everyone at dawn, but not if the bot lay down after the others got up). */
export const wake: Goal = {
  name: 'wake',
  priority: 95,
  timeoutMs: 10_000,
  retryMs: 30_000,
  whileAsleep: true,
  wants: s => (s.sleeping && s.activity === 'work' ? 'morning' : null),
  run: async ctx => {
    await ctx.call('bed.wake');
    return 'got up';
  }
};

/**
 * Out of an emergency wall-in by day. The Guardian walls the bot in when a fight goes badly, and the shelter does at
 * night away from home; in the home zone the dirt it used can't be broken by Baritone (ground there is protected), so
 * every walk failed at once and it sat in its box at 7 health with nothing to eat. Digs the wall it built (all of it,
 * so no stray blocks are left on the lawn); a box it didn't build, it opens on the side toward home.
 */
export const breakOut: Goal = {
  name: 'break out',
  priority: 92,
  timeoutMs: 3 * 60_000,
  retryMs: 20_000,
  wants: s => (s.boxedIn && s.activity === 'work' && !s.sleeping ? 'walled in, and it is day' : null),
  run: async ctx => {
    const { entities } = await ctx.call<{ entities: { name: string; category: string; distance: number }[] }>('world.entities', { maxDistance: 10 });
    const threat = entities.find(e => e.category === 'monster');
    if (threat) throw new Error(`waiting: ${threat.name} ${threat.distance.toFixed(0)} blocks away`);
    const feet = { x: Math.floor(ctx.s.position.x), y: Math.floor(ctx.s.position.y), z: Math.floor(ctx.s.position.z) };
    let cells = [...(ctx.s.boxedIn ?? [])];
    if (!cells.length) {
      const home = ctx.s.home ?? feet;
      const dx = home.x - feet.x, dz = home.z - feet.z;
      const step = Math.abs(dx) >= Math.abs(dz) ? { x: Math.sign(dx) || 1, z: 0 } : { x: 0, z: Math.sign(dz) };
      cells = [1, 0].map(dy => ({ x: feet.x + step.x, y: feet.y + dy, z: feet.z + step.z }));
    }
    // the sides at its height first (the way out), the roof and supports after
    cells.sort((a, b) => Number(a.y < feet.y || a.y > feet.y + 1) - Number(b.y < feet.y || b.y > feet.y + 1));
    let dug = 0;
    for (const c of cells) {
      if (ctx.signal.aborted) break;
      const r = await ctx.act('dig-block', { ...c });
      if (r.ok && /^Dug/.test(r.text)) { dug++; ctx.progress(`dug (${c.x}, ${c.y}, ${c.z})`); }
    }
    if (!dug) throw new Error(`could not dig out of the wall at (${feet.x}, ${feet.y}, ${feet.z})`);
    return `dug out of the wall-in (${dug} of ${cells.length} block(s))`;
  }
};

/**
 * Home before dark, and into bed once it lets the bot sleep (skips phantoms and sets the respawn point). Stuck away
 * from home at night, or home with no bed yet (a new bot's first nights: it stood in the open all night): wall in
 * where it stands and wait for morning (the break-out goal digs it out by day).
 */
export function shelterGoal(): Goal {
  let holedUp = false;
  return {
    name: 'shelter',
    priority: 80,
    timeoutMs: 12 * 60_000,
    retryMs: 20_000,
    interruptible: false,
    wants: (s, world) => {
      if (s.activity === 'work') { holedUp = false; return null; }
      if (holedUp || s.sleeping || s.dimension !== 'overworld' || !s.home) return null;
      // in the evening the fenced, lit yard is home enough (the chests and the furnace are in it: pulled back to the
      // doorstep, the kit and the food goal never got to them); at night, the house
      if (s.activity === 'return') return s.distHome > IN_YARD ? 'evening: head home before dark' : null;
      if (s.distHome > AT_HOME) return 'night: get home';
      if (s.activity === 'rest' && world.landmarks.bed) return 'night: go to bed';
      if (s.activity === 'rest' && !s.boxedIn) return 'night: no bed yet: wall in';
      return null;
    },
    run: async ctx => {
      const did: string[] = [];
      if (ctx.s.distHome > AT_HOME) {
        const r = await ctx.act('go-home', { name: 'home', timeoutMs: 600_000 });
        if (!r.ok) {
          if (ctx.s.activity !== 'rest') throw new Error(r.text);
          const w = await ctx.act('wall-in');
          holedUp = true;
          return `could not get home at night (${r.text}); ${w.text}`;
        }
        did.push('walked home');
      }
      // onto the home cell itself: go-home stops within 2 blocks, which can be the doorway, with the door left open
      // (Baritone opens doors by hand and walks on; crossing the inside pressure plate is what shuts them again)
      const home = ctx.s.home!;
      await ctx.act('move-to-position', { x: home.x, y: home.y, z: home.z, range: 0, timeoutMs: 30_000 });
      const shut = await closeDoors(ctx, home);
      if (shut) did.push(`shut ${shut} door(s)`);
      const bed = ctx.world.landmarks.bed;
      if (ctx.s.activity === 'rest' && bed) {
        const sleep = () => ctx.call<{ sleeping: boolean; reason?: string }>('bed.sleep', { ...bed }, 15_000);
        // from home the bed is usually in reach already (walking right up to it timed out 2.8 blocks away)
        let sl = await sleep().catch(() => undefined);
        if (!sl) {
          const r = await ctx.act('move-to-position', { ...bed, range: 2, timeoutMs: 60_000 });
          if (!r.ok && !/Stopped at .* [0-3](\.\d+)? blocks away/.test(r.text)) throw new Error(`could not reach the bed: ${r.text}`);
          sl = await sleep();
        }
        if (!sl.sleeping) throw new Error(`could not sleep: ${sl.reason ?? 'unknown'}`);
        did.push(`asleep in the bed at (${bed.x}, ${bed.y}, ${bed.z})`);
      } else if (ctx.s.activity === 'rest' && !ctx.s.boxedIn) {
        // no bed yet: the night in a box of its own blocks, not out in the open with the mobs
        const w = await ctx.act('wall-in');
        holedUp = true;
        did.push(`no bed yet: ${w.text}`);
      }
      return did.join(', ') || 'home';
    }
  };
}

/**
 * Shut the doors around home that stand open with nothing holding them open (a pressure plate keeps them powered:
 * those close by themselves). Monsters walk in through an open door; the bot once died to a zombie in its own cabin.
 */
export async function closeDoors(ctx: GoalContext, home: Pos): Promise<number> {
  const box = { x: home.x - 8, y: home.y - 2, z: home.z - 8, width: 17, height: 6, length: 17 };
  const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', box);
  // a door still powered by the plate the bot just stepped off shuts by itself when the plate lets go
  const me = (await ctx.status()).block;
  // toggle only: shut with a water bucket in hand (and the shield on), the click poured the water outside the door
  let shut = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] ?? '';
    // doors (their lower half) and fence gates
    const door = /_door\[/.test(b) && !/iron_door/.test(b) && /half=lower/.test(b);
    if (!(door || /_fence_gate\[/.test(b)) || !/open=true/.test(b) || /powered=true/.test(b)) continue;
    const at = { x: box.x + i % box.width, y: box.y + Math.floor(i / (box.width * box.length)), z: box.z + Math.floor(i / box.width) % box.length };
    if (me && me.x === at.x && me.z === at.z && Math.abs(me.y - at.y) <= 1) continue; // standing in it
    const r = await ctx.act('use-item-on-block', { ...at, face: 'up', toggle: true });
    if (r.ok && /open=false|closed/.test(r.text)) shut++;
  }
  // the gates in the fence and the doors of the other buildings, further out: the fishing trip left a gate open
  const inBox = (p: Pos) => p.x >= box.x && p.x < box.x + box.width && p.z >= box.z && p.z < box.z + box.length && p.y >= box.y && p.y < box.y + box.height;
  const far = Object.entries(ctx.world?.zones ?? {}).filter(([k]) => /:(gate|door)$/.test(k)).flatMap(([, zs]) => zs).filter(p => !inBox(p));
  for (const at of far) {
    if (ctx.signal.aborted) break;
    const { blocks: [b] } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...at, width: 1, height: 1, length: 1 });
    if (!b || !/open=true/.test(b) || /powered=true/.test(b) || /half=upper/.test(b)) continue;
    const r = await ctx.act('use-item-on-block', { ...at, face: 'up', toggle: true });
    if (r.ok && /open=false|closed/.test(r.text)) shut++;
  }
  return shut;
}

/** Wandered off with nothing to do (after an LLM job, say): come back to the yard. */
export const returnIdle: Goal = {
  name: 'idle',
  priority: 1,
  timeoutMs: 10 * 60_000,
  retryMs: 5 * 60_000,
  wants: s => (s.activity === 'work' && s.home && s.distHome > 32 && Number.isFinite(s.distHome) ? 'nothing to do out here: back to the yard' : null),
  run: async ctx => {
    const r = await ctx.act('go-home', { name: 'home', timeoutMs: 600_000 });
    if (!r.ok) throw new Error(r.text);
    return 'back home';
  }
};
