import { z } from 'zod';
import type { ToolFactory } from '../../tool-factory.js';
import type { ClientRuntime } from '../tools.js';
import type { Brain } from '../brain/brain.js';
import { worldIdFromSeed } from '../../build-protection.js';
import { chestTotals } from '../brain/chests.js';
import { compile, type Compiled, type Design, type Rotation, type Structure } from './format.js';
import { summary, type Change } from './diff.js';
import { packages } from './order.js';
import { billFor, sourceBill, type SourcedBill } from './bill.js';
import { plan } from './scan.js';
import { StructureStore } from './store.js';
import { jobsOf, jobText, queueJob } from './job.js';

/**
 * The declarative build tools: the LLM writes a design (the shape), places it as a named structure (anchor, rotation)
 * and asks for a plan (what differs from the world, cell by cell, and the materials) before applying it. These never
 * take control from the bot's brain: they read, or queue work it does at its own pace (see job.ts).
 */

const FORMAT = `A design is JSON: { version: 1, name, palette: { P: "oak_planks", ... }, parts: [...], signs?: [...] }.
Parts, applied in order (later ones overwrite): { fill: { from: [x,y,z], to: [x,y,z], block } } a solid box;
{ walls: { from, to, block, corners? } } hollow sides; { box: { from, to, block, corners? } } hollow with floor and roof;
{ clear: { from, to } } kept as air; { set: { at, block } } one cell; { layers: { at?, rows: [[row along +z of characters
along +x, ...] per layer bottom-up] } } with '.' air and ' ' unmanaged. A block is a palette key or a block state
("stone_bricks", "oak_stairs[facing=east]"). signs: [{ at, facing, lines: [up to 4] }] are wall signs whose text faces
\`facing\`. Local coordinates: x east, y up, z south. Cells no part touches are left as they are. A door's top and a bed's
head come with their other half.`;

const pos = z.object({ x: z.coerce.number(), y: z.coerce.number(), z: z.coerce.number() });
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const fmt = (p: { x: number; y: number; z: number }) => `(${p.x}, ${p.y}, ${p.z})`;

export interface StructureContext { store: StructureStore; world: () => Promise<string> }

/** What a set of changes needs, sourced from what the bot carries and its chests hold. */
export async function sourced(rt: ClientRuntime, brain: Brain | undefined, changes: Change[]): Promise<SourcedBill> {
  const inv = await rt.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
  const have: Record<string, number> = {};
  for (const i of inv.items) if (i.slot < 36) have[i.name] = (have[i.name] ?? 0) + i.count;
  const world = brain?.worldMemory();
  if (world) for (const [n, k] of Object.entries(chestTotals(world))) have[n] = (have[n] ?? 0) + k;
  return sourceBill(billFor(changes), have);
}

/** A plan as the LLM reads it. */
export function planText(title: string, c: Compiled, changes: Change[], bill: SourcedBill): string {
  const s = summary(changes);
  const managed = changes.filter(x => !x.second).length;
  const lines = [`${title}: box ${fmt(c.box)} ${c.box.width}x${c.box.height}x${c.box.length}, ${managed} managed cells.`];
  const todo = s.place + s.replace + s.restate + s.clear + s.sign;
  if (!todo) {
    lines.push('Up to date: every managed cell holds what it should.');
    return lines.join('\n');
  }
  lines.push(`Changes: ${s.place} to place, ${s.replace} to replace, ${s.restate} to turn round, ${s.clear} to clear, ${s.sign} sign(s) to rewrite; ${s.ok} ok.`);
  const sample = (kind: Change['kind'], label: string) => {
    const xs = changes.filter(x => x.kind === kind && !x.second).slice(0, 4);
    if (xs.length) lines.push(`  ${label}: ${xs.map(x => `${x.want === 'air' ? x.have : x.want} at ${fmt(x.at)}${x.kind === 'replace' || x.kind === 'restate' ? ` (now ${x.have})` : ''}`).join('; ')}${s[kind] > xs.length ? '; ...' : ''}`);
  };
  sample('place', 'place'); sample('replace', 'replace'); sample('restate', 'turn'); sample('clear', 'clear'); sample('sign', 'sign');
  if (bill.lines.length) {
    lines.push('Materials:');
    for (const l of bill.lines.sort((a, b) => b.need - a.need)) {
      const how = l.source === 'have' ? 'have it' : l.source === 'craft' ? 'craft it' : l.source === 'smelt' ? 'smelt it'
        : l.source === 'gather' ? 'the bot gathers what it takes' : 'the bot cannot get it by itself';
      lines.push(`  ${l.item} x${l.need} (have ${l.have}; ${how})`);
    }
    if (Object.keys(bill.gather).length) lines.push(`To gather: ${Object.entries(bill.gather).map(([k, v]) => `${k} x${v}`).join(', ')}.`);
    if (Object.keys(bill.missing).length) lines.push(`Missing (put these in a home chest, or change the design): ${Object.entries(bill.missing).map(([k, v]) => `${k} x${v}`).join(', ')}.`);
  }
  const ps = packages(changes);
  lines.push(`Work: ${ps.length} package(s) (${ps.filter(p => p.phase === 'clear').length} clearing, ${ps.filter(p => p.phase === 'build').length} building, ${ps.filter(p => p.phase === 'attach').length} attaching).`);
  return lines.join('\n');
}

/** An ASCII drawing of a structure, layer by layer, in the design's own palette letters ('.' air, ' ' unmanaged). */
export function render(d: Design, c: Compiled, maxLayers = 24): string {
  const letter = new Map<string, string>();
  for (const [k, v] of Object.entries(d.palette ?? {})) letter.set(v.replace(/^minecraft:/, ''), k);
  const extra = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let next = 0;
  const legend: string[] = [];
  const ch = (state: string) => {
    if (state === 'air') return '.';
    if (!letter.has(state)) { const l = extra[next++ % extra.length]; letter.set(state, l); legend.push(`${l} ${state}`); }
    return letter.get(state)!;
  };
  const { box } = c;
  const grid = new Map(c.cells.map(cell => [`${cell.at.x},${cell.at.y},${cell.at.z}`, ch(cell.want)]));
  const out: string[] = [];
  for (let y = 0; y < Math.min(box.height, maxLayers); y++) {
    out.push(`y ${box.y + y}:`);
    for (let zz = 0; zz < box.length; zz++) {
      let row = '';
      for (let x = 0; x < box.width; x++) row += grid.get(`${box.x + x},${box.y + y},${box.z + zz}`) ?? ' ';
      out.push(`  ${row}`);
    }
  }
  if (legend.length) out.push(`Other blocks: ${legend.join(', ')}`);
  return out.join('\n');
}

export function registerStructureTools(factory: ToolFactory, rt: ClientRuntime, brain?: Brain, store = new StructureStore()): StructureContext {
  const world = async () => {
    const s = await rt.status();
    const id = worldIdFromSeed(s.hashedSeed ?? undefined);
    if (!id) throw new Error('not in a world yet');
    return id;
  };
  const designOf = (d: string | Design): Design => {
    if (typeof d !== 'string') return d;
    const found = store.loadDesign(d);
    if (!found) throw new Error(`no design called "${d}" (saved designs: ${store.listDesigns().join(', ') || 'none'})`);
    return found;
  };

  factory.registerTool(
    'structure-design',
    `Check a design and save it for placing with structure-plan / structure-apply (a design has no coordinates: it can be placed many times). ${FORMAT} Returns its size, the blocks it takes, or what's wrong with it.`,
    {
      design: z.any().describe('The design (JSON object as described)'),
      save: z.boolean().optional().describe('Save it under its name (default: true)')
    },
    async ({ design, save = true }: { design: Design; save?: boolean }) => {
      let c: Compiled;
      try { c = compile(design, { x: 0, y: 0, z: 0 }); } catch (e) { return factory.createErrorResponse((e as Error).message); }
      const counts = Object.entries(c.counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join(', ');
      const file = save ? store.saveDesign(design) : undefined;
      return factory.createResponse(`Design "${design.name}": ${c.box.width} wide (x), ${c.box.height} high, ${c.box.length} long (z), ` +
        `${c.cells.filter(x => !x.second).length} managed cells. Blocks: ${counts || 'none (it only clears)'}.${file ? ` Saved to ${file}.` : ''}`);
    }
  );

  factory.registerTool(
    'structure-plan',
    'What building or repairing a structure would take, without doing anything: the cells to place, replace, turn round, clear or re-sign (compared with the world block by block), the materials (and where the bot gets each), and how the work splits up. Give `name` for a placed structure, or `design` + `anchor` (+ `rotation`) to try a placement.',
    {
      name: z.string().optional().describe('A placed structure (from structure-apply)'),
      design: z.any().optional().describe('A saved design\'s name, or a design object'),
      anchor: pos.optional().describe('Where the design\'s minimum corner goes'),
      rotation: rotation.optional().describe('Clockwise from above: 0, 90, 180 or 270 (default 0)')
    },
    async ({ name, design, anchor, rotation: rot = 0 }: { name?: string; design?: string | Design; anchor?: { x: number; y: number; z: number }; rotation?: Rotation }) => {
      try {
        let d: Design, a: { x: number; y: number; z: number }, r: Rotation = rot, title: string;
        if (name && !design) {
          const s = store.loadStructure(await world(), name);
          if (!s) return factory.createErrorResponse(`No structure called "${name}" in this world (${store.listStructures(await world()).join(', ') || 'none yet'})`);
          d = designOf(s.design); a = s.anchor; r = s.rotation ?? 0; title = `Plan for "${name}" (design ${d.name}, rotation ${r})`;
        } else {
          if (!design || !anchor) return factory.createErrorResponse('Give name, or design and anchor');
          d = designOf(design); a = anchor; title = `Plan for design ${d.name} at ${fmt(a)}, rotation ${r}`;
        }
        const c = compile(d, a, r);
        const changes = await plan(rt, c);
        return factory.createResponse(planText(title, c, changes, await sourced(rt, brain, changes)));
      } catch (e) {
        return factory.createErrorResponse((e as Error).message);
      }
    }
  );

  factory.registerTool(
    'structure-apply',
    `Build (or repair) a structure: place a design under a name (design + anchor + rotation; saved as this world's structure file) or name one placed before, and the bot works on it at its own pace (priority 3.5: after staying alive, its gear and its food stock; before its chores and projects). It gathers and crafts the materials it can, fights or shelters when it must, and picks up where the world says it got to, block by block, until every cell matches. By day only. Returns the plan and the job; follow it with structure-status. A design can be a saved design's name or the design itself (see structure-design).`,
    {
      name: z.string().describe("The structure's name in this world (letters, digits, - and _)"),
      design: z.any().optional().describe("A saved design's name, or a design object (saved under its own name)"),
      anchor: pos.optional().describe("Where the design's minimum corner goes (needed with design)"),
      rotation: rotation.optional().describe('Clockwise from above: 0, 90, 180 or 270 (default 0)'),
      autoRepair: z.boolean().optional().describe('Put it back automatically when the daily check finds it changed (default: only report)'),
      notes: z.string().optional().describe('What it is for (kept in the file)')
    },
    async ({ name, design, anchor, rotation: rot, autoRepair, notes }: { name: string; design?: string | Design; anchor?: { x: number; y: number; z: number }; rotation?: Rotation; autoRepair?: boolean; notes?: string }) => {
      try {
        if (!brain) return factory.createErrorResponse("Build jobs need the bot's brain (the client backend)");
        const w = await world();
        let s = store.loadStructure(w, name);
        if (design !== undefined) {
          if (!anchor && !s) return factory.createErrorResponse("A new structure needs an anchor (where the design's minimum corner goes)");
          const d = designOf(design);
          if (typeof design !== 'string') store.saveDesign(d);
          s = { version: 1, name, design: d.name, anchor: anchor ?? s!.anchor, rotation: rot ?? s?.rotation ?? 0,
            ...(autoRepair !== undefined || s?.autoRepair !== undefined ? { autoRepair: autoRepair ?? s?.autoRepair } : {}),
            ...(notes ?? s?.notes ? { notes: notes ?? s?.notes } : {}) };
        } else if (!s) {
          return factory.createErrorResponse(`No structure called "${name}" in this world: give design and anchor to place one`);
        } else {
          if (anchor) s.anchor = anchor;
          if (rot !== undefined) s.rotation = rot;
          if (autoRepair !== undefined) s.autoRepair = autoRepair;
          if (notes !== undefined) s.notes = notes;
        }
        const d = designOf(s.design);
        const c = compile(d, s.anchor, s.rotation ?? 0);
        store.saveStructure(w, s);
        const changes = await plan(rt, c);
        const text = planText(`Plan for "${name}" (design ${d.name}, rotation ${s.rotation ?? 0})`, c, changes, await sourced(rt, brain, changes));
        const mem = brain.worldMemory();
        if (!mem) return factory.createErrorResponse(`${text}\nThe brain doesn't know this world yet: try again in a few seconds.`);
        const st = store.loadState(w, name);
        const job = queueJob(mem, w, name, st.completeAt ? 'repair' : 'apply', Date.now());
        st.history.push({ at: Date.now(), text: `job #${job.id} (${job.mode}) queued` });
        store.saveState(w, name, st);
        brain.saveMemory();
        const off = brain.enabled ? '' : " The bot's autonomy is off: the job starts once set-autonomy turns it on.";
        return factory.createResponse(`${text}\nQueued job #${job.id} (${job.mode}).${off} Follow it with structure-status.`);
      } catch (e) {
        return factory.createErrorResponse((e as Error).message);
      }
    }
  );

  factory.registerTool(
    'structure-status',
    'The build jobs (going and recent: what each is doing, what it waits for) and the placed structures with their last check.',
    {},
    async () => {
      const mem = brain?.worldMemory();
      const jobs = mem ? jobsOf(mem) : [];
      const going = jobs.filter(j => !['done', 'failed', 'cancelled'].includes(j.status));
      const recent = jobs.filter(j => !going.includes(j)).slice(-5);
      const lines = [going.length ? `Jobs:\n${going.map(j => `- ${jobText(j)}`).join('\n')}` : 'No build jobs going.'];
      if (recent.length) lines.push(`Recent:\n${recent.map(j => `- ${jobText(j)}`).join('\n')}`);
      if (brain && /^Autopilot: build/.test(brain.statusLine())) lines.push(`Working on it now: ${brain.statusLine()}`);
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    'structure-cancel',
    'Stop the build job for a structure (what stands stays; the structure file is kept, so structure-apply can start it again).',
    { name: z.string().describe('The structure') },
    async ({ name }: { name: string }) => {
      const mem = brain?.worldMemory();
      const jobs = mem ? jobsOf(mem).filter(j => j.structure === name && !['done', 'failed', 'cancelled'].includes(j.status)) : [];
      if (!jobs.length) return factory.createErrorResponse(`No job going for "${name}"`);
      for (const j of jobs) { j.status = 'cancelled'; j.note = 'cancelled'; j.updatedAt = Date.now(); j.need = j.missing = j.carry = undefined; }
      brain!.saveMemory();
      return factory.createResponse(`Cancelled ${jobs.map(j => `#${j.id}`).join(', ')} for ${name}.`);
    }
  );

  factory.registerTool(
    'structure-list',
    'The saved designs, and the structures placed in this world with their state (complete, drift found, jobs).',
    {},
    async () => {
      const w = await world();
      const lines = [`Designs: ${store.listDesigns().join(', ') || 'none'}.`];
      const names = store.listStructures(w);
      if (!names.length) lines.push('No structures placed in this world yet.');
      for (const n of names) {
        const s = store.loadStructure(w, n)!;
        const st = store.loadState(w, n);
        const d = typeof s.design === 'string' ? s.design : s.design.name;
        const state = st.drift?.changes ? `${st.drift.changes} cell(s) differ (checked ${new Date(st.drift.at).toISOString().slice(0, 16)})`
          : st.completeAt ? `complete (${new Date(st.completeAt).toISOString().slice(0, 16)})` : 'not built yet';
        lines.push(`- ${n}: design ${d} at ${fmt(s.anchor)}, rotation ${s.rotation ?? 0}${s.autoRepair ? ', auto-repair' : ''}; ${state}`);
      }
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    'structure-show',
    'One structure or design: its file, and a drawing of it layer by layer in its palette letters (\'.\' air, blank unmanaged).',
    {
      name: z.string().optional().describe('A placed structure'),
      design: z.string().optional().describe('Or a saved design')
    },
    async ({ name, design }: { name?: string; design?: string }) => {
      try {
        if (name) {
          const w = await world();
          const s: Structure | undefined = store.loadStructure(w, name);
          if (!s) return factory.createErrorResponse(`No structure called "${name}"`);
          const d = designOf(s.design);
          const c = compile(d, s.anchor, s.rotation ?? 0);
          const st = store.loadState(w, name);
          const hist = st.history.slice(-5).map(h => `  ${new Date(h.at).toISOString().slice(0, 16)} ${h.text}`).join('\n');
          return factory.createResponse(`${JSON.stringify({ ...s, design: typeof s.design === 'string' ? s.design : '(inline)' }, null, 1)}\n${render(d, c)}${hist ? `\nHistory:\n${hist}` : ''}`);
        }
        if (design) {
          const d = designOf(design);
          return factory.createResponse(`${JSON.stringify(d)}\n${render(d, compile(d, { x: 0, y: 0, z: 0 }))}`);
        }
        return factory.createErrorResponse('Give name or design');
      } catch (e) {
        return factory.createErrorResponse((e as Error).message);
      }
    }
  );

  return { store, world };
}
