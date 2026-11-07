import type { Toolpath } from './slicer.js';

/** A slice as the LLM (and the user) reads it: what it does, how long it takes, what it can't do. */

const fmt = (p: { x: number; y: number; z: number }) => `(${p.x}, ${p.y}, ${p.z})`;
const mins = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

export function sliceText(path: Toolpath, maxListed = 4): string {
  const s = path.stats;
  const did = [
    s.place && `${s.place} to place`, s.dig && `${s.dig} to dig`, s.work && `${s.work} to till`, s.sign && `${s.sign} sign(s)`,
    s.scaffold && `${s.scaffold} scaffold block(s)${s.scaffoldLeft ? ` (${s.scaffoldLeft} it can't take down again)` : ', all taken down again'}`
  ].filter(Boolean).join(', ');
  const lines = [`Terraslicer: ${s.objects} object(s), ${s.stations} station(s)${did ? `: ${did}` : ''}; ${s.loads} load(s) from the chests; walking about ${mins(s.walkSeconds)}, the build about ${mins(s.buildSeconds)} once its materials are in.`];
  if (s.hops) lines.push(`  ${s.hops} walk(s) between objects by a way the slicer can't see (Baritone finds it).`);
  if (path.stuck.length) {
    lines.push(`  Left: ${path.stuck.length} cell(s) it found no way to do: ${path.stuck.slice(0, maxListed).map(x => `${x.want} at ${fmt(x.at)} (${x.why})`).join('; ')}${path.stuck.length > maxListed ? '; ...' : ''}`);
  }
  if (path.skipped.length) {
    lines.push(`  Can't do: ${path.skipped.slice(0, maxListed).map(x => `${x.want} at ${fmt(x.at)} (${x.why})`).join('; ')}${path.skipped.length > maxListed ? '; ...' : ''}`);
  }
  return lines.join('\n');
}

/**
 * A top view of one object's stations: its cells as '#', the stations numbered in order (1-9, then a-z, then '*'),
 * the start as '@'. For checking a slice by eye.
 */
export function stationMap(path: Toolpath, object: number): string {
  const o = path.objects.find(x => x.id === object);
  if (!o) return '';
  const stations = path.stations.filter(s => s.object === object);
  const cells = new Set<string>();
  for (const s of stations) for (const a of s.actions) cells.add(`${a.at.x},${a.at.z}`);
  const all = [...stations.map(s => s.at), o.box, { x: o.box.x + o.box.width - 1, y: 0, z: o.box.z + o.box.length - 1 }];
  const x0 = Math.min(...all.map(p => p.x)), x1 = Math.max(...all.map(p => p.x));
  const z0 = Math.min(...all.map(p => p.z)), z1 = Math.max(...all.map(p => p.z));
  const mark = new Map<string, string>();
  const sym = '123456789abcdefghijklmnopqrstuvwxyz';
  stations.forEach((s, i) => mark.set(`${s.at.x},${s.at.z}`, sym[i] ?? '*'));
  const rows: string[] = [];
  for (let z = z0; z <= z1; z++) {
    let row = '';
    for (let x = x0; x <= x1; x++) row += mark.get(`${x},${z}`) ?? (cells.has(`${x},${z}`) ? '#' : '.');
    rows.push(row);
  }
  return rows.join('\n');
}

/** The first stations of a toolpath, one line each: where it stands and what it does there (its G-code, readable). */
export function stationsText(path: Toolpath, max = 20): string {
  const short = (s?: string) => (s ?? '').replace(/\[scaffold=true\]/, ' (scaffold)').replace(/\[.*\]/, '');
  const act = (a: Toolpath['stations'][number]['actions'][number]) => {
    const at = `${a.at.x},${a.at.y},${a.at.z}`;
    switch (a.op) {
      case 'place': return `place ${short(a.state)} ${at}${a.ref ? ` on its ${a.ref} side` : ''}`;
      case 'dig': return `dig ${short(a.state)} ${at}`;
      case 'work': return `${a.item === 'hoe' ? 'till' : 'shovel'} ${at}`;
      case 'sign': return `sign ${at}`;
      case 'pillar': return `pillar up ${a.count}`;
      case 'descend': return `dig down ${a.count}`;
    }
  };
  const lines: string[] = [];
  let load = 0;
  path.stations.slice(0, max).forEach((s, i) => {
    if (path.loads[load] && path.loads[load].from === i) {
      const l = path.loads[load++];
      lines.push(`  [load ${load}: ${Object.entries(l.items).map(([k, v]) => `${k} x${v}`).join(', ')}]`);
    }
    lines.push(`  ${i + 1}. stand at ${fmt(s.at)}${s.hop ? ' (Baritone finds the way)' : ''}: ${s.actions.map(act).join('; ')}`);
  });
  if (path.stations.length > max) lines.push(`  ... ${path.stations.length - max} more`);
  return lines.join('\n');
}
