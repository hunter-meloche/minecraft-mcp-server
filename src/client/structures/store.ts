import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateDesign, type Design, type Structure } from './format.js';

/**
 * Where designs and structures live (the user's choice): reusable designs, without coordinates, in
 * ~/.minecraft-mcp-server/designs/<name>.json, so a design can be placed again elsewhere; placed structures per world in
 * ~/.minecraft-mcp-server/worlds/<world>/structures/<name>.json, with <name>.state.json beside each (written by the
 * system only: what was last verified, and the history).
 */

export interface StructureState {
  /** when the structure was last found complete */
  completeAt?: number;
  /** the cells' blocks then ("x,y,z" -> state), for drift reports */
  verified?: Record<string, string>;
  /** the last drift check: when, and how many cells differed */
  drift?: { at: number; changes: number; sample: string[] };
  history: { at: number; text: string }[];
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
const safe = (s: string) => s.replace(/[^a-z0-9_-]/gi, '_');

export class StructureStore {
  constructor(readonly root = path.join(os.homedir(), '.minecraft-mcp-server')) { }

  private designFile(name: string) { return path.join(this.root, 'designs', `${name}.json`); }
  private worldDir(world: string) { return path.join(this.root, 'worlds', safe(world), 'structures'); }
  private structureFile(world: string, name: string) { return path.join(this.worldDir(world), `${name}.json`); }
  private stateFile(world: string, name: string) { return path.join(this.worldDir(world), `${name}.state.json`); }

  private static check(name: string, what: string) {
    if (!NAME.test(name)) throw new Error(`${what} name "${name}" must be letters, digits, - and _ (up to 48)`);
  }

  private static write(file: string, data: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  private static read<T>(file: string): T | undefined {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; }
  }

  saveDesign(d: Design): string {
    const problems = validateDesign(d);
    if (problems.length) throw new Error(`the design has problems: ${problems.join('; ')}`);
    const file = this.designFile(d.name);
    StructureStore.write(file, d);
    return file;
  }

  loadDesign(name: string): Design | undefined {
    StructureStore.check(name, 'design');
    return StructureStore.read<Design>(this.designFile(name));
  }

  listDesigns(): string[] {
    try { return fs.readdirSync(path.join(this.root, 'designs')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort(); } catch { return []; }
  }

  saveStructure(world: string, s: Structure): string {
    StructureStore.check(s.name, 'structure');
    const file = this.structureFile(world, s.name);
    StructureStore.write(file, s);
    return file;
  }

  loadStructure(world: string, name: string): Structure | undefined {
    StructureStore.check(name, 'structure');
    return StructureStore.read<Structure>(this.structureFile(world, name));
  }

  listStructures(world: string): string[] {
    try { return fs.readdirSync(this.worldDir(world)).filter(f => f.endsWith('.json') && !f.endsWith('.state.json')).map(f => f.slice(0, -5)).sort(); } catch { return []; }
  }

  removeStructure(world: string, name: string): boolean {
    StructureStore.check(name, 'structure');
    let gone = false;
    for (const f of [this.structureFile(world, name), this.stateFile(world, name)]) {
      try { fs.unlinkSync(f); gone = true; } catch { /* not there */ }
    }
    return gone;
  }

  /** The design a structure builds: its own, or the saved one it names. */
  designOf(s: Structure): Design {
    if (typeof s.design !== 'string') return s.design;
    const d = this.loadDesign(s.design);
    if (!d) throw new Error(`no design called "${s.design}" (save it with structure-design first)`);
    return d;
  }

  loadState(world: string, name: string): StructureState {
    return StructureStore.read<StructureState>(this.stateFile(world, name)) ?? { history: [] };
  }

  saveState(world: string, name: string, st: StructureState): void {
    if (st.history.length > 50) st.history.splice(0, st.history.length - 50);
    StructureStore.write(this.stateFile(world, name), st);
  }
}
