import type { Goal, GoalContext } from '../brain/goals.js';
import type { BuildJob, Pos, WorldMemory } from '../brain/memory.js';
import { compile, type Compiled } from './format.js';
import { pending, type Change } from './diff.js';
import { plan } from './scan.js';
import { baseline, doorways, standSpots, strays, tidyBox, type Box } from './tidy.js';
import { readBox } from '../brain/milestones.js';
import type { StructureStore } from './store.js';
import { Voxels, type P } from './terraslicer/world.js';
import { slice } from './terraslicer/slicer.js';
import { haveFor, provisionStep, release, reserve, toolpathBill, toolsFor } from './terraslicer/provision.js';
import { runLoad } from './terraslicer/executor.js';

/**
 * Build jobs: the LLM asks for a structure (structure-apply) and the brain works on it at priority 3.5, below staying
 * alive, the gear and the food stockpile (so a zombie, nightfall, hunger or a broken pickaxe stops it, and those are
 * seen to first), above home upkeep and the autopilot's own projects. Terraslicer does the work (terraslicer/): the
 * whole bill secured in the chests first, then a toolpath worked out like a 3D printer's slicer, scaffold and all,
 * carried out a load at a time. Every run starts by comparing the structure with the world, cell by cell, and slicing
 * what's left, so a job stopped anywhere picks up exactly where the world says it is: nothing is "remembered" as done
 * that isn't standing.
 */

const MINUTE = 60_000;
export const BUILD_PRIORITY = 44;
const FAILS_ALLOWED = 2;
const DONE = new Set(['done', 'failed', 'cancelled']);
const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

export const jobsOf = (world: WorldMemory) => (world.buildJobs ??= []);
export const activeJob = (world: WorldMemory, now: number) =>
  jobsOf(world).find(j => !DONE.has(j.status) && (j.retryAt ?? 0) <= now);

/** Queue a job for a structure (one going job per structure: asking again restarts it). */
export function queueJob(world: WorldMemory, worldId: string, structure: string, mode: BuildJob['mode'], now: number): BuildJob {
  const jobs = jobsOf(world);
  for (const j of jobs) if (j.structure === structure && !DONE.has(j.status)) { j.status = 'cancelled'; j.note = 'replaced by a new job'; j.updatedAt = now; release(world, j.id); }
  const job: BuildJob = { id: Math.max(0, ...jobs.map(j => j.id)) + 1, world: worldId, structure, mode, status: 'queued', createdAt: now, updatedAt: now };
  jobs.push(job);
  // finished ones beyond the last 20 go
  const old = jobs.filter(j => DONE.has(j.status));
  if (old.length > 20) world.buildJobs = jobs.filter(j => !DONE.has(j.status) || old.indexOf(j) >= old.length - 20);
  return job;
}

export function jobText(j: BuildJob): string {
  const when = new Date(j.updatedAt).toISOString().slice(11, 16);
  const extra = [
    j.need && `gathering ${Object.entries(j.need).map(([k, v]) => `${k} x${v}`).join(', ')}`,
    j.missing && `waiting for someone to put ${Object.entries(j.missing).map(([k, v]) => `${k} x${v}`).join(', ')} in a home chest`,
    j.misses && Object.values(j.misses).some(n => n >= FAILS_ALLOWED) && `${Object.values(j.misses).filter(n => n >= FAILS_ALLOWED).length} cell(s) given up on`
  ].filter(Boolean).join('; ');
  const phase = j.phase && !DONE.has(j.status) ? ` [Terraslicer: ${j.phase}${j.phase === 'building' && j.loadsDone ? `, ${j.loadsDone} load(s) done` : ''}${j.scaffold?.length ? `, ${j.scaffold.length} scaffold block(s) up` : ''}]` : '';
  return `#${j.id} ${j.mode} ${j.structure}: ${j.status}${phase}${j.note ? ` (${j.note})` : ''}${extra ? `; ${extra}` : ''} [${when}]`;
}

/** Scaffold blocks dug in one tidy round, at most. */
const TIDY_BATCH = 48;

/**
 * Dig one block by hand, changing nothing else: from where the bot stands if it's in reach, else from a floor spot in
 * reach (tidy.ts standSpots) walked to carefully (Baritone breaking and placing nothing on the way). Baritone's own
 * dig walked into reach by breaking fences and walls and pillaring up on new scaffold. Returns why not, or ''.
 */
export async function digByHand(ctx: GoalContext, blocks: (string | null)[], box: Box, p: Pos, here: { at: Pos }, gone: Set<string>): Promise<string> {
  type Dug = { dug: boolean; reason?: string };
  const dig = () => ctx.call<Dug>('dig.here', { ...p, timeoutMs: 15_000 }, 25_000).catch(e => ({ dug: false, reason: (e as Error).message }));
  let r = await dig();
  if (r.dug || r.reason === 'air') return '';
  let why = r.reason ?? 'not dug';
  for (const spot of standSpots(blocks, box, p, here.at, gone, 3)) {
    if (ctx.signal.aborted) return 'stopped';
    const g = await ctx.call<{ arrived: boolean; at?: Pos }>('goto', { ...spot, range: 0, careful: true, timeoutMs: 30_000 }, 45_000)
      .catch(() => ({ arrived: false, at: undefined }));
    if (g.at) here.at = g.at;
    if (!g.arrived) { why = 'no way there on foot'; continue; }
    r = await dig();
    if (r.dug || r.reason === 'air') return '';
    why = r.reason ?? 'not dug';
  }
  return why;
}

/** Dig the scaffold round the site (tidy.ts strays), a batch at a time, by hand; what it couldn't dig twice is left. */
async function tidyRound(ctx: GoalContext, job: BuildJob, c: Compiled, keep: Set<string>): Promise<{ dug: number; failed: number; text: string }> {
  ctx.progress(`${job.structure}: looking for scaffold left round the site`);
  const tb = tidyBox(c.box);
  const managed = new Set(c.cells.map(x => key(x.at)));
  const doors = doorways(c.cells);
  // a doorway is dug out even of what stood there before the job: a door has to lead somewhere
  keep = new Set([...keep].filter(k => !doors.has(k)));
  job.tidyFails ??= {};
  const skip = new Set(Object.entries(job.tidyFails).filter(([, n]) => n >= FAILS_ALLOWED).map(([k]) => k));
  const blocks = await readBox(ctx, tb);
  const list = strays(blocks, tb, keep, managed, skip);
  const here = { at: ctx.s.position };
  const gone = new Set<string>();
  let dug = 0, failed = 0;
  const whys = new Map<string, number>();
  for (const p of list.slice(0, TIDY_BATCH)) {
    if (ctx.signal.aborted) break;
    ctx.progress(`${job.structure}: digging scaffold ${dug + failed + 1}/${Math.min(list.length, TIDY_BATCH)} at ${key(p)}`);
    const why = await digByHand(ctx, blocks, tb, p, here, gone);
    if (ctx.signal.aborted) break;
    if (!why) { dug++; gone.add(key(p)); delete job.tidyFails[key(p)]; continue; }
    failed++;
    whys.set(why, (whys.get(why) ?? 0) + 1);
    job.tidyFails[key(p)] = (job.tidyFails[key(p)] ?? 0) + 1;
  }
  // a round counts once its list is worked through: one stopped for the evening, or longer than a batch, goes on next run
  if (!ctx.signal.aborted && list.length <= TIDY_BATCH) job.tidiedAt = job.packages ?? 0;
  const reasons = [...whys].map(([w, n]) => `${n} ${w}`).join(', ');
  const text = list.length ? `tidied ${dug} of ${list.length} scaffold block(s)${failed ? ` (not dug: ${reasons})` : ''}` : 'no scaffold left round the site';
  job.note = text;
  return { dug, failed, text };
}

const parseKey = (k: string): P => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; };
/**
 * What scaffold is made of (the bot's throwaway blocks): a stray one round the site is scaffold to take down. Not dirt:
 * the baseline doesn't record it, and every dirt block of the ground would be "new".
 */
const SCAFFOLDISH = /^(cobblestone|cobbled_deepslate|netherrack|andesite|diorite|granite|tuff)$/;
const floorOf = (p: { x: number; y: number; z: number }): P => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/**
 * A run of a Terraslicer job: slice what's left against the world as it is (from home while provisioning, from where
 * it is while building), then one step of the phase it's in: provisioning secures the whole bill in the chests (no
 * block goes down before it's all there), building carries out the next load, finishing tidies up and calls it done.
 * Every run slices afresh, so an interruption, a broken block or a failed step just shows in the next slice.
 */
async function terraslice(
  ctx: GoalContext, job: BuildJob, c: Compiled, changes: Change[], keep: Set<string>,
  stamp: (note: string, status?: BuildJob['status']) => void, finish: (left: number) => string,
  protect?: (blocks: { at: Pos; state: string }[]) => void, built?: (center: Pos, radius: number) => { at: Pos }[]
): Promise<string> {
  const misses = job.misses ?? {};
  const given = new Set(Object.entries(misses).filter(([, n]) => n >= FAILS_ALLOWED).map(([k]) => k));
  job.phase ??= 'provisioning';
  const box = tidyBox(c.box);
  ctx.progress(`${job.structure}: slicing what's left`);
  const blocks = await readBox(ctx, box);
  const v = new Voxels(box, blocks);
  const from = job.phase === 'provisioning' ? (ctx.s.home ?? ctx.s.position) : ctx.s.position;
  // scaffold to take down: what the job knows it put up, and any throwaway block round the site that neither stood
  // there when the job started nor is the design's (a load stopped mid-batch left two bridge blocks up the tower that
  // the job never heard back about, and the tidy round could only dig from the ground)
  const managed = new Set(c.cells.map(x => key(x.at)));
  // what the bot built (any structure's, protected) is never scaffold
  for (const b of built?.({ x: box.x + box.width / 2, y: box.y + box.height / 2, z: box.z + box.length / 2 }, Math.max(box.width, box.height, box.length)) ?? []) managed.add(key(b.at));
  const standing = new Set(job.scaffold ?? []);
  blocks.forEach((b, i) => {
    if (!b || !SCAFFOLDISH.test(b.replace(/^minecraft:/, ''))) return;
    const k = key(v.at(i));
    if (!keep.has(k) && !managed.has(k)) standing.add(k);
  });
  const path = slice(v, changes.filter(x => !given.has(key(x.at))), floorOf(from), { scaffold: [...standing].map(parseKey), avoid: job.avoid ?? [] });
  job.total ??= path.stats.place + path.stats.dig + path.stats.work + path.stats.sign;
  if (!path.stations.length) {
    // nothing more it can do: the safety net for stray scaffold, then done (what's left reported)
    job.phase = 'finishing';
    stamp('tidying up', 'working');
    const t = await tidyRound(ctx, job, c, keep);
    if (ctx.signal.aborted) return `${job.structure}: stopped tidying (${t.text})`;
    if (t.dug || t.failed) return `${job.structure}: ${t.text}`;
    job.scaffold = undefined;
    // what's still wrong, not what it once gave up on (the tidy round may have put that right)
    return finish(path.stuck.length + path.skipped.length + pending(changes).filter(x => given.has(key(x.at))).length);
  }
  const bill = toolpathBill(path);
  if (job.phase === 'provisioning' || job.phase === 'finishing') {
    job.phase = 'provisioning';
    job.bill = bill;
    const step = await provisionStep(ctx, job, bill, toolsFor(path));
    job.need = step.need;
    job.missing = step.missing;
    if (step.ready) {
      job.phase = 'building';
      job.need = job.missing = undefined;
      stamp(`ready to build: ${step.note}; ${path.stats.stations} station(s) in ${path.stats.loads} load(s), about ${Math.round(path.stats.buildSeconds / 60)} min`, 'working');
      return jobText(job);
    }
    if (step.missing) job.retryAt = ctx.s.now + 10 * MINUTE;
    stamp(step.note, step.missing ? 'waiting' : step.need ? 'gathering' : 'working');
    return jobText(job);
  }
  // building: the bill must still be covered (something took from it, or the world changed): else secure it again
  reserve(ctx.world, job.id, bill);
  const items = (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items;
  const have = haveFor(ctx.world, items, job.id);
  const short = Object.entries(toolpathBill(path, false)).filter(([k, n]) => (have[k] ?? 0) < n);
  if (short.length) {
    job.phase = 'provisioning';
    stamp(`short of ${short.map(([k, n]) => `${n - (have[k] ?? 0)} ${k}`).join(', ')}: securing it again`, 'working');
    return jobText(job);
  }
  const load = path.loads[0];
  job.carry = [...new Set([...Object.keys(load.items), path.scaffoldItem])];
  stamp(`building: ${path.stats.stations} station(s) in ${path.stats.loads} load(s) left, about ${Math.round(path.stats.buildSeconds / 60)} min`, 'working');
  const r = await runLoad(ctx, job, path, load, protect);
  // for the next slice: the scaffold standing, and the cells it failed on (twice and they're left)
  const up = new Set(job.scaffold ?? []);
  for (const k of r.scaffoldUp) up.add(k);
  for (const k of r.scaffoldDown) up.delete(k);
  job.scaffold = up.size ? [...up] : undefined;
  // spots Baritone couldn't walk to: the next slices plan around them (else the same plan, the same failure, round again)
  if (r.unreached.length) job.avoid = [...new Set([...(job.avoid ?? []), ...r.unreached])].slice(-60);
  if (!r.stopped) {
    // a station's first failure is what went wrong there; the rest followed from it (a floor block missing, the wall
    // on it can't go up), and walking that failed is the world's doing: those aren't the cells' fault
    const seen = new Set<number>();
    for (const f of r.failed) {
      if (seen.has(f.station) || /could not walk/.test(f.why)) continue;
      seen.add(f.station);
      misses[key(f.at)] = (misses[key(f.at)] ?? 0) + 1;
    }
    job.misses = Object.keys(misses).length ? misses : undefined;
    job.loadsDone = (job.loadsDone ?? 0) + 1;
  }
  stamp(`${r.stopped ? 'stopped midway' : 'load done'}: ${r.text}`);
  return `${job.structure}: ${r.text}`;
}

/**
 * `protect`: the runtime's protectBuilt. A job protected only what stood of each package when it ran, so most of a
 * redesigned house wasn't the bot's yet, and the wood trip's miner felled the cottage's new corner logs for the oak.
 */
export function structureGoal(store: StructureStore, protect?: (blocks: { at: Pos; state: string }[]) => void,
  built?: (center: Pos, radius: number) => { at: Pos }[]): Goal {
  return {
    name: 'build',
    priority: BUILD_PRIORITY,
    timeoutMs: 10 * MINUTE,
    retryMs: MINUTE,
    wants: (s, world) => {
      // by day only (the user's choice): the shelter brings it home at dusk and the job goes on in the morning
      if (s.activity !== 'work' || s.sleeping || s.dimension !== 'overworld' || s.slotsUsed >= 34) return null;
      const j = activeJob(world, s.now);
      // gathering: the stock trip clears job.need when it's back; until then (10 minutes at most) don't stop it for
      // the two logs it has so far (the job did, a minute into each trip, and built a package of one block)
      if (j?.status === 'gathering' && j.need && Object.keys(j.need).length && s.now - j.updatedAt < 10 * MINUTE) return null;
      return j ? `${j.mode} ${j.structure}${j.note ? `: ${j.note}` : ''}` : null;
    },
    run: async ctx => {
      const job = activeJob(ctx.world, ctx.s.now);
      if (!job) return 'no build job';
      const stamp = (note: string, status: BuildJob['status'] = job.status) => { job.note = note; job.status = status; job.updatedAt = ctx.s.now; };
      const s = store.loadStructure(job.world, job.structure);
      if (!s) { stamp('its structure file is gone', 'failed'); return job.note!; }
      let c: Compiled;
      try { c = compile(store.designOf(s), s.anchor, s.rotation ?? 0); } catch (e) { stamp((e as Error).message, 'failed'); return job.note!; }
      // the ground first, if asked: the footprint levelled to just under the floor (hills cut, holes filled)
      if (s.prepare?.level && !job.prepared) {
        stamp('levelling the site', 'working');
        ctx.progress(`${job.structure}: levelling the site`);
        const r = await ctx.act('level-area', { x1: c.box.x, z1: c.box.z, x2: c.box.x + c.box.width - 1, z2: c.box.z + c.box.length - 1, level: c.box.y - 1, timeoutMs: 8 * MINUTE })
          .catch(e => ({ ok: false, text: (e as Error).message }));
        if (!/Now level|Already level/.test(r.text)) return `${job.structure}: levelling the site: ${r.text.split('\n').pop()?.slice(0, 120)}`;
        job.prepared = true;
      }
      // what scaffold-like blocks stand round the site before the job puts any up: its tidy rounds leave those
      const st0 = store.loadState(job.world, job.structure);
      if (st0.tidy?.job !== job.id || st0.tidy.pending) {
        const tb = tidyBox(c.box);
        const seed = st0.tidy?.job === job.id && st0.tidy.within ? { keep: st0.tidy.keep, within: st0.tidy.within } : undefined;
        st0.tidy = { job: job.id, keep: baseline(await readBox(ctx, tb), tb, seed) };
        store.saveState(job.world, job.structure, st0);
      }
      ctx.progress(`${job.structure}: checking it block by block`);
      let changes = await plan(ctx, c);
      // out of sight (its chunks not loaded: the bot off at the woods) is no answer: go and look, and never call a
      // job complete on cells it can't see (the cottage's first job did, from 160 blocks off, before a block was laid)
      if (changes.some(x => x.unknown)) {
        const mid = { x: c.box.x + Math.floor(c.box.width / 2), y: c.box.y, z: c.box.z + Math.floor(c.box.length / 2) };
        ctx.progress(`${job.structure}: out of sight from here: going to look`);
        await ctx.call('goto', { ...mid, xz: true, range: 8, careful: true, timeoutMs: 120_000 }, 135_000).catch(() => undefined);
        changes = await plan(ctx, c);
        const unseen = changes.filter(x => x.unknown).length;
        if (unseen) return `${job.structure}: ${unseen} cell(s) still out of sight (not loaded): later`;
      }
      // what stands right is the bot's now: Baritone's walks and mining leave it alone (the mod's no-break rule)
      protect?.(changes.filter(x => x.kind === 'ok' && x.want !== 'air' && x.have && !/^(minecraft:)?(air|cave_air)$/.test(x.have))
        .map(x => ({ at: x.at, state: x.have })));
      const finish = (leftCells: number) => {
        const st = store.loadState(job.world, job.structure);
        st.completeAt = ctx.s.now;
        st.verified = Object.fromEntries(changes.map(x => [key(x.at), x.have]));
        st.drift = undefined;
        const left = leftCells ? `, ${leftCells} cell(s) it could not get right` : '';
        st.history.push({ at: ctx.s.now, text: `${job.mode} complete${left}` });
        store.saveState(job.world, job.structure, st);
        job.need = job.missing = job.carry = undefined;
        release(ctx.world, job.id);
        stamp(`complete${left}`, 'done');
        return `${job.structure} complete${left}`;
      };
      return terraslice(ctx, job, c, changes, new Set(st0.tidy!.keep), stamp, finish, protect, built);
    }
  };
}

/**
 * Once a day: compare every placed structure with the world (only what's loaded counts) and note the drift in its
 * state file; a structure with autoRepair gets a repair job (the user's choice: the others are only reported, so a
 * change made by hand can be imported instead of undone).
 */
export function driftGoal(store: StructureStore): Goal {
  return {
    name: 'structures',
    priority: 21,
    timeoutMs: 4 * MINUTE,
    retryMs: 30 * MINUTE,
    wants: (s, world) => {
      if (s.activity !== 'work' || s.sleeping || !world.id || s.dimension !== 'overworld') return null;
      if (s.now - (world.lastDone?.structures ?? 0) < 20 * MINUTE) return null;
      return store.listStructures(world.id).length ? 'daily check: the structures against their files' : null;
    },
    run: async ctx => {
      (ctx.world.lastDone ??= {}).structures = ctx.s.now;
      const w = ctx.world.id!;
      const out: string[] = [];
      for (const name of store.listStructures(w)) {
        if (ctx.signal.aborted) break;
        const s = store.loadStructure(w, name);
        if (!s) continue;
        let c: Compiled;
        try { c = compile(store.designOf(s), s.anchor, s.rotation ?? 0); } catch { continue; }
        const todo = pending(await plan(ctx, c));
        const st = store.loadState(w, name);
        st.drift = { at: ctx.s.now, changes: todo.length, sample: todo.slice(0, 5).map(x => `${x.kind} ${x.want === 'air' ? x.have : x.want} at ${key(x.at)}`) };
        if (todo.length) st.history.push({ at: ctx.s.now, text: `drift: ${todo.length} cell(s) differ` });
        store.saveState(w, name, st);
        const going = jobsOf(ctx.world).some(j => j.structure === name && !DONE.has(j.status));
        if (todo.length && s.autoRepair && !going) {
          const j = queueJob(ctx.world, w, name, 'repair', ctx.s.now);
          out.push(`${name}: ${todo.length} cell(s) differ, repair job #${j.id} queued`);
        } else if (todo.length) out.push(`${name}: ${todo.length} cell(s) differ${going ? ' (a job is on it)' : ' (reported)'}`);
      }
      return out.join('; ') || 'every structure matches its file';
    }
  };
}
