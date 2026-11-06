import type { Goal, GoalContext } from '../brain/goals.js';
import type { BuildJob, WorldMemory } from '../brain/memory.js';
import { prepareBill } from '../brain/project.js';
import { compile, type Cell, type Compiled } from './format.js';
import { pending, type Change } from './diff.js';
import { packages, type Package } from './order.js';
import { billFor, sourceBill } from './bill.js';
import { plan } from './scan.js';
import type { StructureStore } from './store.js';

/**
 * Build jobs: the LLM asks for a structure (structure-apply) and the brain works on it at priority 3.5, one package at
 * a time: below staying alive, the gear and the food stockpile (so a zombie, nightfall, hunger or a broken pickaxe
 * stops it, and those are seen to first), above home upkeep and the autopilot's own projects. Every run starts by
 * comparing the structure with the world, cell by cell, so a job stopped anywhere picks up exactly where the world
 * says it is: nothing is "remembered" as done that isn't standing.
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
  for (const j of jobs) if (j.structure === structure && !DONE.has(j.status)) { j.status = 'cancelled'; j.note = 'replaced by a new job'; j.updatedAt = now; }
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
    j.fails && Object.keys(j.fails).length && `${Object.values(j.fails).filter(n => n >= FAILS_ALLOWED).length} cell(s) given up on`
  ].filter(Boolean).join('; ');
  return `#${j.id} ${j.mode} ${j.structure}: ${j.status}${j.packages ? `, ${j.packages} package(s) done` : ''}${j.note ? ` (${j.note})` : ''}${extra ? `; ${extra}` : ''} [${when}]`;
}

/** A spec for some cells, for build-structure: palette letters for their blocks, ' ' (left as it is) everywhere else. */
export function specFor(cells: Cell[] | Change[]): { origin: { x: number; y: number; z: number }; spec: { palette: Record<string, string>; layers: string[][] } } {
  const ats = cells.map(c => c.at);
  const min = { x: Math.min(...ats.map(a => a.x)), y: Math.min(...ats.map(a => a.y)), z: Math.min(...ats.map(a => a.z)) };
  const max = { x: Math.max(...ats.map(a => a.x)), y: Math.max(...ats.map(a => a.y)), z: Math.max(...ats.map(a => a.z)) };
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&*+-=?@^_~';
  const palette: Record<string, string> = {};
  const letterOf = new Map<string, string>();
  const grid = new Map<string, string>();
  for (const c of cells) {
    if (!letterOf.has(c.want)) {
      const l = letters[letterOf.size];
      if (!l) throw new Error('too many kinds of block in one package');
      letterOf.set(c.want, l);
      palette[l] = c.want;
    }
    grid.set(key(c.at), letterOf.get(c.want)!);
  }
  const layers: string[][] = [];
  for (let y = min.y; y <= max.y; y++) {
    const rows: string[] = [];
    for (let z = min.z; z <= max.z; z++) {
      let row = '';
      for (let x = min.x; x <= max.x; x++) row += grid.get(key({ x, y, z })) ?? ' ';
      rows.push(row);
    }
    layers.push(rows);
  }
  return { origin: min, spec: { palette, layers } };
}

const isSign = (c: Change) => /_sign\[/.test(c.want) || !!c.sign;
/** The side of a sign's cell its support is on: behind a wall sign, under a standing one. */
const supportSide = (want: string) => (!/_wall_sign/.test(want) ? 'down'
  : ({ north: 'south', south: 'north', east: 'west', west: 'east' } as Record<string, string>)[/facing=(north|south|east|west)/.exec(want)?.[1] ?? 'north']);

async function near(ctx: GoalContext, at: { x: number; y: number; z: number }, range = 3) {
  await ctx.act('move-to-position', { ...at, range, timeoutMs: 90_000 }).catch(() => undefined);
}

/** Do one package; returns what it did. */
async function work(ctx: GoalContext, job: BuildJob, p: Package): Promise<string> {
  if (p.phase === 'clear') {
    let dug = 0;
    for (const c of p.changes) {
      if (ctx.signal.aborted) break;
      const r = await ctx.act('dig-block', { ...c.at, collect: true }).catch(e => ({ ok: false, text: (e as Error).message }));
      if (r.ok && /^Dug/.test(r.text)) dug++;
    }
    return `cleared ${dug} of ${p.changes.length}`;
  }
  const blocks = p.changes.filter(c => !isSign(c));
  const signs = p.changes.filter(isSign);
  const done: string[] = [];
  if (blocks.length) {
    const { origin, spec } = specFor(blocks);
    const r = await ctx.act('build-structure', { ...origin, spec, name: `job-${job.structure}`, timeoutMs: 5 * MINUTE }).catch(e => ({ ok: false, text: (e as Error).message }));
    done.push(r.text.split('\n')[0].slice(0, 120));
  }
  for (const c of signs) {
    if (ctx.signal.aborted) break;
    await near(ctx, c.at, 2);
    if (c.kind === 'sign' || /_sign/.test(c.have)) await ctx.act('dig-block', { ...c.at, collect: true }).catch(() => undefined);
    const r = await ctx.call<{ placed: boolean; reason?: string }>('sign.place', { ...c.at, face: supportSide(c.want), lines: c.sign ?? [] }, 15_000)
      .catch(e => ({ placed: false, reason: (e as Error).message }));
    done.push(r.placed ? `sign at ${key(c.at)}` : `sign at ${key(c.at)}: ${r.reason}`);
  }
  return done.join('; ');
}

/** After a package: the cells still not right count a failure each; two and they're left (and reported). */
function countFails(job: BuildJob, before: Change[], after: Change[]) {
  const still = new Set(pending(after).map(c => key(c.at)));
  job.fails ??= {};
  for (const c of before) {
    const k = key(c.at);
    if (still.has(k)) job.fails[k] = (job.fails[k] ?? 0) + 1;
    else delete job.fails[k];
  }
}

export function structureGoal(store: StructureStore): Goal {
  return {
    name: 'build',
    priority: BUILD_PRIORITY,
    timeoutMs: 10 * MINUTE,
    retryMs: MINUTE,
    wants: (s, world) => {
      // by day only (the user's choice): the shelter brings it home at dusk and the job goes on in the morning
      if (s.activity !== 'work' || s.sleeping || s.dimension !== 'overworld' || s.slotsUsed >= 34) return null;
      const j = activeJob(world, s.now);
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
      const centre = { x: c.box.x + Math.floor(c.box.width / 2), y: c.box.y, z: c.box.z + Math.floor(c.box.length / 2) };
      if (Math.hypot(ctx.s.position.x - centre.x, ctx.s.position.z - centre.z) > 24) {
        ctx.progress(`${job.structure}: walking to the site`);
        await near(ctx, centre, 6);
      }
      // the ground first, if asked: the footprint levelled to just under the floor (hills cut, holes filled)
      if (s.prepare?.level && !job.prepared) {
        stamp('levelling the site', 'working');
        ctx.progress(`${job.structure}: levelling the site`);
        const r = await ctx.act('level-area', { x1: c.box.x, z1: c.box.z, x2: c.box.x + c.box.width - 1, z2: c.box.z + c.box.length - 1, level: c.box.y - 1, timeoutMs: 8 * MINUTE })
          .catch(e => ({ ok: false, text: (e as Error).message }));
        if (!/Now level|Already level/.test(r.text)) return `${job.structure}: levelling the site: ${r.text.split('\n').pop()?.slice(0, 120)}`;
        job.prepared = true;
      }
      ctx.progress(`${job.structure}: checking it block by block`);
      const changes = await plan(ctx, c);
      const given = new Set(Object.entries(job.fails ?? {}).filter(([, n]) => n >= FAILS_ALLOWED).map(([k]) => k));
      const todo = pending(changes).filter(x => !given.has(key(x.at)));
      if (!todo.length) {
        const st = store.loadState(job.world, job.structure);
        st.completeAt = ctx.s.now;
        st.verified = Object.fromEntries(changes.map(x => [key(x.at), x.have]));
        st.drift = undefined;
        const left = given.size ? `, ${given.size} cell(s) it could not get right` : '';
        st.history.push({ at: ctx.s.now, text: `${job.mode} complete${left}` });
        store.saveState(job.world, job.structure, st);
        job.need = job.missing = job.carry = undefined;
        stamp(`complete${left}`, 'done');
        return `${job.structure} complete${left}`;
      }
      job.total ??= todo.length;
      const p = packages(changes.filter(x => !given.has(key(x.at))))[0];
      // materials for this package: from the chests, crafted, smelted; what's short goes to the stock trips, and what
      // nobody can make waits for someone to put it in a chest
      if (p.phase !== 'clear') {
        const bill = billFor(p.changes);
        job.carry = [...Object.keys(bill), 'stick', ...Object.keys(bill).filter(i => /_planks$/.test(i)).map(i => i.replace(/_planks$/, '_log'))];
        ctx.progress(`${job.structure}: getting ${Object.entries(bill).map(([k, v]) => `${v} ${k}`).join(', ')} ready`);
        const short = await prepareBill(ctx, bill, { record: false });
        if (Object.keys(short).length) {
          const src = sourceBill(short, {});
          job.need = Object.keys(src.gather).length ? src.gather : undefined;
          job.missing = Object.keys(src.missing).length ? src.missing : undefined;
          job.retryAt = ctx.s.now + (job.missing ? 10 : 3) * MINUTE;
          stamp(job.missing ? 'waiting for materials it cannot get' : 'gathering materials', job.missing ? 'waiting' : 'gathering');
          return jobText(job);
        }
        job.need = job.missing = undefined;
      }
      stamp(`${p.phase}: ${p.changes.length} cell(s) at y ${p.changes[0].at.y}`, 'working');
      ctx.progress(`${job.structure}: ${p.phase} ${p.changes.length} cell(s), ${todo.length} to go`);
      const did = await work(ctx, job, p);
      if (ctx.signal.aborted) return `${job.structure}: stopped midway (${did})`;
      countFails(job, p.changes, await plan(ctx, c));
      job.packages = (job.packages ?? 0) + 1;
      stamp(`${p.phase} package done: ${did.slice(0, 120)}`);
      return `${job.structure}: ${did}`;
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
