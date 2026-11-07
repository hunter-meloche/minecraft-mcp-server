import type { GoalContext } from '../../brain/goals.js';
import type { BuildJob } from '../../brain/memory.js';
import { takeFromChests } from '../../brain/chests.js';
import type { Action } from './actions.js';
import type { Load } from './loads.js';
import type { Station, Toolpath } from './slicer.js';
import { key, same, type P } from './world.js';

/**
 * Terraslicer's executor: one load of the toolpath carried out. It takes the load from the home chests (the job's own
 * reserved materials), then goes from station to station as planned: Baritone only walks there (careful: it breaks
 * and places nothing), the bot centres itself in the cell when it places next to its own feet or climbs, and the
 * station's actions go to the mod as they are (a station's blocks in one batch at the vanilla cadence). It stops
 * between stations when something more urgent comes (the brain's abort); what it placed, dug and failed on is
 * reported for the job's state (protection, scaffold standing, cells to give up on), and the next run slices again
 * from the world as it is, so a stop anywhere picks up where the world says.
 */

export interface LoadResult {
  stations: number;
  placed: number;
  dug: number;
  /** placed and in place: the job protects them */
  built: { at: P; state: string }[];
  /** what it couldn't do, and at which station (the first failure of a station is its cause; the rest follow from it) */
  failed: { at: P; why: string; station: number }[];
  /** scaffold put up and taken down ("x,y,z") */
  scaffoldUp: string[];
  scaffoldDown: string[];
  /** station spots Baritone couldn't walk to ("x,y,z") */
  unreached: string[];
  stopped: boolean;
  text: string;
}

type Inv = { items: { name: string; count: number; slot: number }[] };
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const floorP = (p: { x: number; y: number; z: number }): P => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** Whether the station places in a cell beside its own two (the bot's box must be clear of it) or climbs. */
export function needsCentring(s: Station): boolean {
  return s.actions.some(a => a.op === 'pillar' || ((a.op === 'place' || a.op === 'sign') &&
    Math.abs(a.at.x - s.at.x) <= 1 && Math.abs(a.at.z - s.at.z) <= 1 && (a.at.y === s.at.y || a.at.y === s.at.y + 1)));
}

/** The station's actions in calls: consecutive placements together (one batch), everything else on its own. */
export function callGroups(actions: Action[]): Action[][] {
  const out: Action[][] = [];
  for (const a of actions) {
    const last = out[out.length - 1];
    if (a.op === 'place' && last?.[0].op === 'place') last.push(a); else out.push([a]);
  }
  return out;
}

export async function runLoad(ctx: GoalContext, job: BuildJob, path: Toolpath, load: Load, protect?: (b: { at: P; state: string }[]) => void): Promise<LoadResult> {
  const r: LoadResult = { stations: 0, placed: 0, dug: 0, built: [], failed: [], scaffoldUp: [], scaffoldDown: [], unreached: [], stopped: false, text: '' };
  const stop = () => { r.stopped = true; return r; };
  // the load, from the chests (what's carried already counts)
  const carried = async () => {
    const out: Record<string, number> = {};
    for (const i of (await ctx.call<Inv>('inventory')).items) if (i.slot < 36) out[i.name] = (out[i.name] ?? 0) + i.count;
    return out;
  };
  let have = await carried();
  const short = Object.entries(load.items).filter(([item, n]) => (have[item] ?? 0) < n);
  if (short.length) ctx.progress(`${job.structure}: taking ${short.map(([k, n]) => `${n - (have[k] ?? 0)} ${k}`).join(', ')} from the chests`);
  for (const [item, n] of short) {
    if (ctx.signal.aborted) return stop();
    await takeFromChests(ctx, item, n - (have[item] ?? 0), { forJob: job.id }).catch(() => 0);
  }
  // a tool to work blocks with: any hoe, any shovel
  const tools = new Set(path.stations.slice(load.from, load.to).flatMap(s => s.actions.filter(a => a.op === 'work').map(a => a.item!)));
  have = await carried();
  for (const tool of tools) {
    if (Object.keys(have).some(n => n.endsWith(`_${tool}`))) continue;
    for (const kind of ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']) if (await takeFromChests(ctx, `${kind}_${tool}`, 1).catch(() => 0)) break;
  }
  let station = 0;
  const fail = (a: Action, why: string) => r.failed.push({ at: a.at, why, station });
  let misses = 0;
  let broken = false;
  for (let i = load.from; i < load.to && !broken; i++) {
    if (ctx.signal.aborted) return stop();
    const s = path.stations[i];
    station = i;
    ctx.progress(`${job.structure}: station ${i + 1} of ${path.stations.length} at (${s.at.x}, ${s.at.y}, ${s.at.z}): ${s.actions.length} step(s)`);
    const pos = (await ctx.status()).position;
    if (!pos || !same(floorP(pos), s.at)) {
      const g = await ctx.call<{ arrived: boolean }>('goto', { ...s.at, range: 0, careful: true, timeoutMs: 45_000 }, 60_000).catch(() => ({ arrived: false }));
      if (ctx.signal.aborted) return stop();
      if (!g.arrived) {
        r.unreached.push(key(s.at));
        for (const a of s.actions) fail(a, 'could not walk to the spot to do it from');
        // two stations in a row it can't get to: the plan doesn't match the world; slice again
        if (++misses >= 2) break;
        continue;
      }
    }
    misses = 0;
    if (needsCentring(s)) await ctx.call('steer', { x: s.at.x + 0.5, y: s.at.y, z: s.at.z + 0.5, within: 0.15, sneak: true, timeoutMs: 1500 }, 5000).catch(() => undefined);
    let feet = s.at;
    for (const group of callGroups(s.actions)) {
      if (ctx.signal.aborted) return stop();
      if (broken) break;
      const a = group[0];
      switch (a.op) {
        case 'place': {
          const res = await ctx.call<{ results: { placed: boolean; reason?: string; block?: string }[] }>('place.batch', {
            actions: group.map(x => ({ ...x.at, item: x.item, face: x.ref, ...(x.look ? { facing: x.look } : {}), ...(x.axis ? { axis: x.axis } : {}), ...(x.top ? { top: true } : {}) }))
          }, 8000 + group.length * 600).catch(e => ({ results: group.map(() => ({ placed: false, reason: (e as Error).message, block: undefined as string | undefined })) }));
          group.forEach((x, k) => {
            const got = res.results[k];
            if (!got?.placed) return fail(x, got?.reason ?? 'not placed');
            r.placed++;
            if (x.scaffold) r.scaffoldUp.push(key(x.at)); else r.built.push({ at: x.at, state: x.state ?? got.block ?? '' });
          });
          break;
        }
        case 'dig': {
          const res = await ctx.call<{ dug: boolean; reason?: string }>('dig.here', { ...a.at, timeoutMs: 15_000 }, 25_000).catch(e => ({ dug: false, reason: (e as Error).message }));
          if (res.dug || res.reason === 'air') { r.dug++; if (a.scaffold) r.scaffoldDown.push(key(a.at)); } else fail(a, res.reason ?? 'not dug');
          break;
        }
        case 'work': {
          const inv = (await ctx.call<Inv>('inventory')).items;
          const tool = inv.find(x => x.slot < 36 && x.name.endsWith(`_${a.item}`))?.name;
          if (!tool) { fail(a, `no ${a.item} carried`); break; }
          await ctx.call('item.select', { name: tool });
          const res = await ctx.call<{ changed: boolean }>('useOn', { ...a.at, face: 'up' }).catch(() => ({ changed: false }));
          if (!res.changed) fail(a, `the ${a.item} did nothing`);
          break;
        }
        case 'sign': {
          const res = await ctx.call<{ placed: boolean; reason?: string }>('sign.place', { ...a.at, face: a.ref, lines: a.lines ?? [] }, 15_000).catch(e => ({ placed: false, reason: (e as Error).message }));
          if (res.placed) { r.placed++; r.built.push({ at: a.at, state: a.state ?? '' }); } else fail(a, res.reason ?? 'not placed');
          break;
        }
        case 'pillar': {
          const res = await ctx.call<{ placed: number; reason?: string }>('pillar', { count: a.count ?? 1, item: a.item }, 10_000 + (a.count ?? 1) * 2000).catch(e => ({ placed: 0, reason: (e as Error).message }));
          for (let k = 0; k < res.placed; k++) r.scaffoldUp.push(key({ x: feet.x, y: feet.y + k, z: feet.z }));
          feet = { x: feet.x, y: feet.y + res.placed, z: feet.z };
          // the rest of the plan stood up there: slice again from where it is
          if (res.placed < (a.count ?? 1)) { fail(a, res.reason ?? 'the climb stopped'); broken = true; }
          break;
        }
        case 'descend': {
          // the block underfoot, one at a time: it falls onto the next and digs that
          for (let k = 0; k < (a.count ?? 1); k++) {
            const under = { x: feet.x, y: feet.y - 1, z: feet.z };
            const res = await ctx.call<{ dug: boolean; reason?: string }>('dig.here', { ...under, timeoutMs: 10_000 }, 20_000).catch(e => ({ dug: false, reason: (e as Error).message }));
            if (!res.dug && res.reason !== 'air') { fail(a, res.reason ?? 'not dug'); broken = true; break; }
            r.dug++;
            r.scaffoldDown.push(key(under));
            for (let t = 0; t < 10; t++) { await pause(100); if (((await ctx.status()).position?.y ?? feet.y) < feet.y - 0.5) break; }
            feet = under;
          }
          break;
        }
      }
    }
    r.stations++;
    if (r.built.length) protect?.(r.built);
  }
  r.text = `${r.stations} station(s): placed ${r.placed}, dug ${r.dug}${r.failed.length ? `, ${r.failed.length} failed (${r.failed.slice(0, 2).map(f => `${key(f.at)}: ${f.why}`).join('; ')})` : ''}`;
  return r;
}
