import fs from 'fs';
import path from 'path';

/**
 * What the brain remembers about its home, per world (like a villager's memories of its bed and job site): where the
 * bed, chests, furnace and crafting table are, found by looking around home once and kept across restarts.
 */

export interface Pos { x: number; y: number; z: number }

export interface Landmarks {
  bed?: Pos;
  chests: Pos[];
  furnace?: Pos;
  table?: Pos;
  /**
   * an anvil (chipped or damaged too) and a smithing table: the workshop's, or ones the improvement run put up (the
   * workshop milestone counts those as its own: workshop.ts)
   */
  anvil?: Pos;
  smithing?: Pos;
  /** farmland cells near home */
  farmland: Pos[];
  /** when these were looked for (ms) */
  foundAt?: number;
}

/** A declarative build the LLM asked for (structures/job.ts works on it at priority 3.5). */
export interface BuildJob {
  id: number;
  /** the world id its structure file is kept under */
  world: string;
  structure: string;
  mode: 'apply' | 'repair';
  status: 'queued' | 'working' | 'gathering' | 'waiting' | 'done' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  /** the last thing that happened */
  note?: string;
  /** what the stock trips should bring for it (raw materials) */
  need?: Record<string, number>;
  /** what the bot can't get by itself: the job waits until someone puts it in a home chest */
  missing?: Record<string, number>;
  /** items it builds with: the stash leaves them carried */
  carry?: string[];
  /** not before (ms) */
  retryAt?: number;
  /** cells ("x,y,z") a package failed on, and how often: left alone after two */
  fails?: Record<string, number>;
  packages?: number;
  /** the package count at the last tidy round (scaffold dug out round the site) */
  tidiedAt?: number;
  /** scaffold cells a tidy round couldn't dig, and how often: left after two */
  tidyFails?: Record<string, number>;
  /** the given-up cells had their one more go (they get it before the job is called done) */
  secondChance?: boolean;
  /** cells of a block nobody can get (farmland), left till the rest of the job is done */
  parked?: string[];
  /** packages in a row that ran out of a block (its cells don't count failures for that, up to a few) */
  shortRuns?: number;
  /** the last shortfall of things to make (a repeat means the making failed) */
  lastShort?: string;
  /** the footprint was levelled (the structure's prepare.level) */
  prepared?: boolean;
  /** changes still to make when it started */
  total?: number;
  /**
   * Terraslicer's phases: sliced (the toolpath worked out), provisioning (the whole bill being secured in the home
   * chests: nothing is built before it's all there), building (load by load), finishing. Undefined: the old package
   * executor (kept for jobs started before, and as a fallback)
   */
  phase?: 'provisioning' | 'building' | 'finishing';
  /** the bill being secured (what the toolpath places, scaffold at its peak, a spare) */
  bill?: Record<string, number>;
  /** Terraslicer's toolpath progress: loads done */
  loadsDone?: number;
  /** scaffold blocks the job put up and hasn't taken down yet ("x,y,z"): a new slice takes them down */
  scaffold?: string[];
  /** cells the executor failed on, and how often (re-sliced twice, then given up) */
  misses?: Record<string, number>;
  /** station spots Baritone couldn't walk to ("x,y,z"): later slices plan around them */
  avoid?: string[];
}

export interface WorldMemory {
  /** the world's id ("seed:..."), as the brain knows it */
  id?: string;
  landmarks: Landmarks;
  /** how far from home a trip may go */
  leash: number;
  /** what each home chest held when last opened, by "x,y,z" */
  chestItems?: Record<string, Record<string, number>>;
  /**
   * each home chest's stacks by the chest's own slot, as last seen ("x,y,z" -> stacks; chests.ts remember): what
   * tells one of a name from another (an enchanted book's enchantments, a potion's contents), for chest.withdraw's
   * `slot`. A chest a tool's reply said held another count of a name has that name's stacks left out until it is
   * opened again (the reply says how many, not which)
   */
  chestStacks?: Record<string, import('../tools.js').ChestStack[]>;
  /** when (ms) daily chores last ran, by chore */
  lastDone?: Record<string, number>;
  /** dark spots ("x,y,z") no torch of the lights round reached: left out from then on */
  darkIgnore?: string[];
  /** stray blocks the daily tidy couldn't get at ("x,y,z" -> tries): left be after two */
  tidyTries?: Record<string, number>;
  /** the long game: milestones done, the one in hand, its journal */
  progress?: import('./progress.js').ProgressMemory;
  /** places the projects made: storage, plots, pens, tree farm, mine entrance ... (kind -> boxes or points) */
  zones?: Record<string, { x: number; y: number; z: number; width?: number; length?: number }[]>;
  /**
   * cane cells ("x,y,z" of `zones.cane`) the cane round saw with no water beside the ground they stand on, and when:
   * they grow nothing, and the cane patch rung drops them from the patch (cane.ts)
   */
  caneDry?: Record<string, number>;
  /**
   * cane cells ("x,y,z" of `zones.cane`) whose filler (scaffold) the cane round could not dig out, and when: it leaves
   * them be for the rest of that day (UTC), not trying them again each round (cane.ts)
   */
  caneSkip?: Record<string, number>;
  /**
   * the cane patch's planting found its shore full (every cell where cane can stand is the patch's, or a gap beside
   * one) with this many live cells, and when: the patch rung waits till it has fewer, or a day (cane.ts, worktasks.ts)
   */
  caneFull?: { cells: number; at: number };
  /** which home chest ("x,y,z") holds which kind of thing (storage.ts categories) */
  chestAssign?: Record<string, string>;
  /** the label on the sign over each chest ("x,y,z" -> "food1"), as put up or as found */
  chestSigns?: Record<string, string>;
  /** chests the signs round couldn't sign ("x,y,z" -> the label it was to wear, and the tries): left be after two */
  signTries?: Record<string, { label: string; tries: number }>;
  /** kinds of things with no room left in their chests: the storage needs another chest */
  storageFull?: string[];
  /** when the storage house was found full up (six double chests) with a kind still without room */
  storageMaxedAt?: number;
  /** built cells ("x,y,z") the repair round failed to put back, and how often */
  repairFails?: Record<string, number>;
  /** the yard as it grows (x1..x2, z1..z2 at ground y) */
  yard?: { x1: number; z1: number; x2: number; z2: number; y: number };
  /** where the bot walks (paths.ts HeatMap.toJSON): its routes, lit by the lights round */
  heat?: import('./paths.js').HeatJSON;
  /** the yard grew past the fence on this side: the fence moves out (its old side comes down, the ring is rebuilt) */
  /** the yard box (x1,z1,x2,z2) the 2-block band outside the fence was last cleared for */
  fenceClearFor?: string;
  /** the yard (its box) last levelled inside the fence */
  yardLevelFor?: string;
  /** the LLM's declarative builds, oldest first */
  buildJobs?: BuildJob[];
  /**
   * What the build jobs have secured in the home chests (job id -> item -> count): other chores take only what's
   * beyond it (the kit, cooking, fuel, projects), and the stash never throws it away
   */
  reserved?: Record<string, Record<string, number>>;
  /** community chests (shared with other players and bots), the missions for them and what was donated */
  community?: import('./community.js').CommunityMemory;
  /** room asked for by the LLM: the yard grows for it (yardgrow.ts) */
  yardGrow?: import('./yardgrow.js').YardGrowRequest;
  /** the obsidian casting may fetch and pour lava (off until a supervised first run: the first unsafe one killed the bot) */
  lavaCasting?: boolean;
  fenceMove?: { side: 'north' | 'south' | 'west' | 'east'; old: { x1: number; z1: number; x2: number; z2: number; y: number } };
  /** the daytime it was busy, idle and busy to no gain, with the idle time by cause: today and the last week (idlelog.ts) */
  idle?: import('./idlelog.js').IdleMemory;
  /** the work queue's marks: which variants came back dry and when, the deep trips and deaths, the last run (work.ts) */
  work?: import('./work.js').WorkMemory;
  /** the anvil's: the pairs that gave nothing worth taking, an anvil that wore out to put back (anvil.ts) */
  anvil?: import('./anvil.js').AnvilMemory;
}

export const DEFAULT_LEASH = 96;

/** The farm's middle, a block above the farmland. */
export function farmCentre(world: WorldMemory): { x: number; y: number; z: number } | undefined {
  const f = world.landmarks.farmland;
  if (!f.length) return undefined;
  const x = f.reduce((a, p) => a + p.x, 0) / f.length, z = f.reduce((a, p) => a + p.z, 0) / f.length;
  return { x: Math.round(x), y: f[0].y + 1, z: Math.round(z) };
}

export class BrainMemory {
  private data: Record<string, WorldMemory> = {};

  constructor(private file?: string) {
    if (file) {
      try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, WorldMemory>; } catch { /* first run */ }
    }
  }

  world(id: string): WorldMemory {
    this.data[id] ??= { landmarks: { chests: [], farmland: [] }, leash: DEFAULT_LEASH };
    const w = this.data[id];
    w.landmarks.chests ??= [];
    w.landmarks.farmland ??= [];
    w.leash ??= DEFAULT_LEASH;
    return w;
  }

  save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // written beside it and renamed over it: the file is saved every minute now (the idle tally), and a restart or a
    // kill halfway through a write must leave the old brain.json whole, not half a new one (it is all the bot knows).
    // Flushed to the disk before the rename: the filesystem (XFS here) can journal the rename up to half a minute
    // before it writes the new file's data, and a power cut in between left an empty brain.json, read as a first run
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), { flush: true });
    fs.renameSync(tmp, this.file);
  }
}

const id = (b: string | null) => (b ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');

/**
 * Find the landmarks in a box of blocks read with world.region (x fastest, then z, then y). The bed is its head half,
 * chests and furnaces all (the nearest to `home` first).
 */
export function findLandmarks(box: Pos & { width: number; height: number; length: number }, blocks: (string | null)[], home: Pos): Landmarks {
  const found: Landmarks = { chests: [], farmland: [] };
  const beds: Pos[] = [], furnaces: Pos[] = [], tables: Pos[] = [], anvils: Pos[] = [], smithings: Pos[] = [];
  blocks.forEach((b, i) => {
    const name = id(b);
    if (!name) return;
    const at = { x: box.x + i % box.width, y: box.y + Math.floor(i / (box.width * box.length)), z: box.z + Math.floor(i / box.width) % box.length };
    if (/_bed$/.test(name) && /part=head/.test(b ?? '')) beds.push(at);
    // one landmark per container: a double chest's right half is the same inventory as its left (counted twice, and
    // given two categories, its signs said wood1 and food1 over one chest)
    else if ((name === 'chest' || name === 'barrel' || name === 'trapped_chest') && !/type=right/.test(b ?? '')) found.chests.push(at);
    else if (name === 'furnace' || name === 'smoker' || name === 'blast_furnace') furnaces.push(at);
    else if (name === 'crafting_table') tables.push(at);
    else if (name === 'anvil' || name === 'chipped_anvil' || name === 'damaged_anvil') anvils.push(at);
    else if (name === 'smithing_table') smithings.push(at);
    else if (name === 'farmland') found.farmland.push(at);
  });
  const near = (a: Pos, b: Pos) => Math.hypot(a.x - home.x, a.y - home.y, a.z - home.z) - Math.hypot(b.x - home.x, b.y - home.y, b.z - home.z);
  found.chests.sort(near);
  found.bed = beds.sort(near)[0];
  found.furnace = furnaces.sort(near)[0];
  found.table = tables.sort(near)[0];
  // (set only where found: a home without them has the landmarks it had before, key for key)
  const anvil = anvils.sort(near)[0], smithing = smithings.sort(near)[0];
  if (anvil) found.anvil = anvil;
  if (smithing) found.smithing = smithing;
  return found;
}
