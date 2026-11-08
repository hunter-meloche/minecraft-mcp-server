import { z } from 'zod';
import type { ToolFactory } from '../../tool-factory.js';
import type { Brain } from './brain.js';
import type { ClientRuntime } from '../tools.js';
import { lightArea, YARD_RADIUS } from './chores.js';
import { requestYardGrowth, yardGrowStatus } from './yardgrow.js';
import { fillAt, sourcesInSight } from './fluidpick.js';
import { activeMissions, community, communityStatus, left, owed, sourceOf, syncReserve } from './community.js';

/** Tools to switch the brain on and off and see what it is doing. They never take control from it. */
export function registerBrainTools(factory: ToolFactory, brain: Brain, rt: ClientRuntime): void {
  factory.registerTool(
    'set-autonomy',
    "Let the bot look after itself between tool calls (or stop it): home before dark and into bed, out of bed in the morning, back to the yard when it wandered off; more chores as they are added. It steps back whenever you run a tool that does more than look, and resumes after 10 quiet minutes. Its reflexes (fighting, eating, hazards) run either way.",
    {
      enabled: z.boolean().describe('On or off'),
      leash: z.coerce.number().int().min(16).max(1000).optional().describe('How far from home its own trips may go (default: 96)')
    },
    async ({ enabled, leash }: { enabled: boolean; leash?: number }) => {
      brain.setEnabled(enabled);
      if (leash !== undefined) {
        try { brain.setLeash(leash); } catch (e) { return factory.createErrorResponse(`Autonomy ${enabled ? 'on' : 'off'}, but the leash was not set: ${(e as Error).message}`); }
      }
      await brain.tick();
      return factory.createResponse(brain.status());
    }
  );

  factory.registerTool(
    'brain-status',
    "What the bot's own brain is doing: on or off, the time-of-day activity (work, return, rest), the goal it is running and why, the home landmarks it found (bed, chests, furnace, table, farmland) and its recent decisions.",
    {},
    async () => factory.createResponse(brain.status())
  );

  factory.registerTool(
    'light-area',
    "Find the dark spots around home (or a point) where monsters can spawn: block light 0 on ground a mob can stand on (since 1.18 that is the only rule for light). With place, put torches there from the inventory, as few as do any good: each one is checked against the real light and taken back up if it lit nothing dark.",
    {
      x: z.coerce.number().optional().describe('X of the centre (default: home, else the bot)'),
      z: z.coerce.number().optional().describe('Z of the centre'),
      radius: z.coerce.number().int().min(4).max(32).optional().describe(`How far around the centre (default: ${YARD_RADIUS})`),
      place: z.boolean().optional().describe('Put torches on them (default: just list them)')
    },
    async ({ x, z: zz, radius = YARD_RADIUS, place = false }: { x?: number; z?: number; radius?: number; place?: boolean }) => {
      const s = await rt.status();
      const home = rt.home(s);
      const base = home && home.dimension === s.dimension ? home : s.block!;
      const centre = { x: Math.floor(x ?? base.x), y: base.y, z: Math.floor(zz ?? base.z) };
      if (place) await brain.manual('light-area');
      const inv = await rt.call<{ items: { name: string; count: number }[] }>('inventory');
      const torches = inv.items.filter(i => i.name === 'torch').reduce((a, i) => a + i.count, 0);
      if (place && !torches) return factory.createErrorResponse('No torches in the inventory (1 coal + 1 stick make 4)');
      const io = {
        call: rt.call,
        act: async (tool: string, args: Record<string, unknown> = {}) => {
          const r = await rt.actions[tool](args);
          return { ok: !r.isError, text: r.content.map(c => (c as { text?: string }).text ?? '').join(' ') };
        }
      };
      const r = await lightArea(io, centre, radius, { place, max: torches, ignore: new Set() });
      const at = (p: { x: number; y: number; z: number }) => `(${p.x}, ${p.y}, ${p.z})`;
      const list = (ps: { x: number; y: number; z: number }[]) => ps.slice(0, 15).map(at).join(', ') + (ps.length > 15 ? `, ... (${ps.length - 15} more)` : '');
      const head = `Around ${at(centre)} within ${radius}: ${r.dark.length} dark spot(s) where monsters can spawn${r.dark.length ? `: ${list(r.dark)}` : ''}.`;
      if (!place) return factory.createResponse(head);
      return factory.createResponse(`${head}
Placed ${r.placed.length} torch(es)${r.placed.length ? ` at ${list(r.placed)}` : ''}` +
        `${r.undone.length ? `; took back ${r.undone.length} that lit nothing dark (${list(r.undone)})` : ''}. ` +
        `${r.left.length} dark spot(s) left${r.left.length ? `: ${list(r.left)} (no torch spot within reach of them, or walled off)` : ''}.`);
    }
  );

  factory.registerTool(
    'lava-sources',
    "Look over the lava (or water) the bot can see, without moving: for each source, nearest first, whether it would bucket it and from where, or why not (a flow, under ground, not open to the sky, no safe spot to stand at). The bot only ever fills a bucket at a still source open to the sky near the ground, standing on solid ground at least 2 blocks from it with no lava round its feet.",
    { fluid: z.enum(['lava', 'water']).optional().describe('Which (default lava)') },
    async ({ fluid = 'lava' }: { fluid?: 'lava' | 'water' }) => {
      const s = await rt.status();
      const ground = s.block ? s.block.y - 1 : undefined;
      const io = { call: rt.call, s: { position: s.block ?? { x: 0, y: 0, z: 0 } } } as unknown as Parameters<typeof sourcesInSight>[0];
      const all = await sourcesInSight(io, fluid, fluid === 'lava' ? ground : undefined, 4);
      if (!all.length) return factory.createResponse(`No ${fluid} in sight.`);
      const list = [...all.filter(v => !v.why), ...all.filter(v => v.why).slice(0, 8)];
      const at = (p: { x: number; y: number; z: number }) => `(${p.x}, ${p.y}, ${p.z})`;
      return factory.createResponse(list.map(v => `- ${at(v.at)}: ${v.why ? `no: ${v.why}` : `yes, from ${v.spots.slice(0, 3).map(at).join(' or ')}`}`).join('\n'));
    }
  );

  factory.registerTool(
    'fill-bucket',
    "Fill an empty bucket the safe way (as the obsidian casting does): at the nearest still source open to the sky (lava: near the ground too), walking carefully to a spot on solid ground beside it (lava: 2 or more away, no lava round its feet) and using the bucket from there, never walking closer. Says why not, if it won't.",
    { fluid: z.enum(['lava', 'water']).describe('Which') },
    async ({ fluid }: { fluid: 'lava' | 'water' }) => {
      await brain.manual('fill-bucket');
      const s = await rt.status();
      const ground = s.block ? s.block.y - 1 : undefined;
      const ctx = { call: rt.call, s: { position: s.block ?? { x: 0, y: 0, z: 0 } }, signal: new AbortController().signal, progress: () => undefined } as unknown as Parameters<typeof fillAt>[0];
      const list = (await sourcesInSight(ctx, fluid, fluid === 'lava' ? ground : undefined, 3)).filter(v => !v.why);
      if (!list.length) return factory.createErrorResponse(`No ${fluid} source in sight that's safe to fill a bucket at (lava-sources says why for each)`);
      const lines: string[] = [];
      for (const v of list.slice(0, 3)) {
        const r = await fillAt(ctx, v, fluid);
        if (r.ok) return factory.createResponse(r.text);
        lines.push(r.text);
      }
      return factory.createErrorResponse(`Not filled: ${lines.join(' | ')}`);
    }
  );

  factory.registerTool(
    'lava-casting',
    "Turn the obsidian casting on or off: with it on, the enchanting room's obsidian step may fill lava buckets (still sources open to the sky near the ground only, from a safe spot 2 or more away) and cast obsidian at home in a sealed pit. Off by default: the first, unsafe version walked the bot into a cave and it burned. Nothing given: says which.",
    { enabled: z.boolean().optional().describe('On or off') },
    async ({ enabled }: { enabled?: boolean }) => {
      const world = brain.worldMemory();
      if (!world) return factory.createErrorResponse('Not in a world yet');
      if (enabled !== undefined) { world.lavaCasting = enabled; brain.saveMemory(); }
      return factory.createResponse(`Obsidian casting from lava is ${world.lavaCasting ? 'on' : 'off'}.`);
    }
  );

  factory.registerTool(
    'grow-yard',
    "Ask the bot to grow its yard (its fenced territory) to make room for something that doesn't fit: it grows by a strip along its cheapest dry side, never toward someone else's build (16 from a build on the surface), levels the strip and moves the fence out to the new edge, by itself at its own pace (just after community missions). Check structure-site with where: 'inside' first: only ask when nothing fits. One request at a time; cancel: true drops it. Nothing given: shows the yard and any request.",
    {
      width: z.coerce.number().int().min(3).max(48).optional().describe('The footprint it needs room for, east-west (2 blocks clear round it are added)'),
      length: z.coerce.number().int().min(3).max(48).optional().describe('North-south'),
      why: z.string().max(80).optional().describe('What for, e.g. "a wheat farm"'),
      cancel: z.boolean().optional().describe('Drop the request')
    },
    async ({ width, length, why, cancel }: { width?: number; length?: number; why?: string; cancel?: boolean }) => {
      const world = brain.worldMemory();
      if (!world) return factory.createErrorResponse('Not in a world yet');
      const y = world.yard;
      const yardLine = y ? `Yard: x ${y.x1}..${y.x2}, z ${y.z1}..${y.z2} (${y.x2 - y.x1 + 1}x${y.z2 - y.z1 + 1}), ground y ${y.y}.` : 'No yard yet.';
      if (cancel) {
        if (!world.yardGrow) return factory.createErrorResponse('No yard growth asked for');
        delete world.yardGrow;
        brain.saveMemory();
        return factory.createResponse(`Dropped the request. ${yardLine}`);
      }
      if (!width || !length) return factory.createResponse([yardLine, ...yardGrowStatus(world)].join('\n'));
      if (world.yardGrow) return factory.createErrorResponse(`A request is already waiting: ${yardGrowStatus(world).join(' ')} (cancel it first)`);
      requestYardGrowth(world, { width, length, why: why ?? 'a new build' });
      brain.saveMemory();
      const off = brain.enabled ? '' : " The bot's autonomy is off: it starts once set-autonomy turns it on.";
      return factory.createResponse(`Asked: the yard grows for ${width}x${length} (${why ?? 'a new build'}). ${yardLine} The bot picks the side, levels the strip and moves the fence; brain-status shows how it goes.${off}`);
    }
  );

  factory.registerTool(
    'community-chest',
    "The community chests: chests on a shared server where players and bots leave surplus for each other. The bot only ever puts things in them, never takes, and they are never its own storage. Now and then it gives its precious surplus there (diamonds once its diamond kit is done and beyond 8, emeralds, gold beyond 16, iron beyond 48). Give name with x, y, z to add one (or move it), name with remove to forget it, nothing to list them.",
    {
      name: z.string().regex(/^[a-z0-9_-]{1,32}$/i).optional().describe('Its label, e.g. "community1"'),
      x: z.coerce.number().optional().describe('X of the chest'),
      y: z.coerce.number().optional().describe('Y of the chest'),
      z: z.coerce.number().optional().describe('Z of the chest'),
      remove: z.boolean().optional().describe('Forget it')
    },
    async ({ name, x, y, z: zz, remove }: { name?: string; x?: number; y?: number; z?: number; remove?: boolean }) => {
      const world = brain.worldMemory();
      if (!world) return factory.createErrorResponse('Not in a world yet');
      const c = community(world);
      if (name && remove) {
        if (!c.chests[name]) return factory.createErrorResponse(`No community chest called ${name}`);
        if (activeMissions(world).some(m => m.chest === name)) return factory.createErrorResponse(`Missions are still going for ${name}: cancel them first (community-mission cancel)`);
        delete c.chests[name];
        brain.saveMemory();
        return factory.createResponse(`Forgot the community chest ${name}.`);
      }
      if (name && x !== undefined && y !== undefined && zz !== undefined) {
        const at = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(zz) };
        if (world.landmarks.chests.some(h => h.x === at.x && h.y === at.y && h.z === at.z)) return factory.createErrorResponse(`(${at.x}, ${at.y}, ${at.z}) is one of the bot's home chests`);
        const found = await findLabelledChest(rt, at, name);
        if (found.error) return factory.createErrorResponse(found.error);
        const p = found.at ?? at;
        c.chests[name] = p;
        brain.saveMemory();
        return factory.createResponse(`Community chest ${name} at (${p.x}, ${p.y}, ${p.z}) (${found.seen}).`);
      }
      if (name || x !== undefined) return factory.createErrorResponse('Give name with x, y and z to add one, or name with remove: true');
      return factory.createResponse(communityStatus(world).join('\n') || 'No community chests yet.');
    }
  );

  factory.registerTool(
    'community-mission',
    "Gather something for a community chest, only when the user says it's for the community (\"gather 64 diamond for the community1 chest\"); otherwise what the bot gathers stays its own. The bot works on it by itself (ranked just under the build jobs: after staying alive, its gear and its food), trip by trip, and carries each load over. What it gathers for a mission is held apart from its own things until delivered. Item is what the chest gets: ores come from trips under ground (iron_ingot and gold_ingot are mined raw and smelted), blocks like oak_log, sand or cobblestone from runs on the surface. Give cancel with an id to stop one; nothing to list them.",
    {
      item: z.string().optional().describe("What the chest gets, e.g. 'diamond', 'iron_ingot', 'oak_log'"),
      count: z.coerce.number().int().min(1).max(2304).optional().describe('How many'),
      chest: z.string().optional().describe('The community chest (default: the only one)'),
      cancel: z.coerce.number().int().optional().describe('A mission id to cancel')
    },
    async ({ item, count, chest, cancel }: { item?: string; count?: number; chest?: string; cancel?: number }) => {
      const world = brain.worldMemory();
      if (!world) return factory.createErrorResponse('Not in a world yet');
      const c = community(world);
      if (cancel !== undefined) {
        const m = c.missions.find(x => x.id === cancel && x.status === 'active');
        if (!m) return factory.createErrorResponse(`No active mission #${cancel}`);
        m.status = 'cancelled';
        m.note = `cancelled with ${m.delivered} delivered${owed(m) ? `; ${owed(m)} gathered for it are the bot's again` : ''}`;
        m.updatedAt = Date.now();
        syncReserve(world);
        brain.saveMemory();
        return factory.createResponse(`Cancelled mission #${m.id} (${m.note}).`);
      }
      if (!item || !count) return factory.createResponse(communityStatus(world).join('\n') || 'No community chests or missions yet.');
      const names = Object.keys(c.chests);
      const to = chest ?? (names.length === 1 ? names[0] : undefined);
      if (!to) return factory.createErrorResponse(names.length ? `Which chest? ${names.join(', ')}` : 'No community chest yet: add one with community-chest');
      if (!c.chests[to]) return factory.createErrorResponse(`No community chest called ${to} (there are: ${names.join(', ') || 'none'})`);
      const name = item.replace(/^minecraft:/, '').trim();
      const src = sourceOf(name);
      if ('error' in src) return factory.createErrorResponse(`Can't take that on: ${src.error}`);
      const m = { id: c.nextId++, item: name, count, chest: to, gathered: 0, delivered: 0, status: 'active' as const, createdAt: Date.now(), updatedAt: Date.now() };
      c.missions.push(m);
      brain.saveMemory();
      const queue = activeMissions(world);
      const ahead = queue.length > 1 ? ` ${queue.length - 1} mission(s) ahead of it.` : '';
      const how = src.underground ? `trips under ground for ${src.mine.split(',')[0]} (by day, kitted out like a deep trip, up to 16 a trip${src.gives !== name ? `, smelted into ${name}` : ''})` : `runs for ${src.mine}`;
      const off = brain.enabled ? '' : " The bot's autonomy is off: it starts once set-autonomy turns it on.";
      return factory.createResponse(`Mission #${m.id}: ${count} ${name} for the ${to} chest, by ${how}; each load is carried over as it comes (${left(m)} to go).${ahead}${off}`);
    }
  );
}

type P = { x: number; y: number; z: number };

/**
 * The chest meant by a point someone read off their screen: the point itself when a chest is there, else the chest
 * within 2 blocks whose sign (over it, or on a side of it) reads the name, else the only chest within 2 (the F3
 * screen shows where the player stands, a block off the chest). Out of sight, the point is taken as given.
 */
async function findLabelledChest(rt: ClientRuntime, at: P, name: string): Promise<{ at?: P; seen: string; error?: string }> {
  const block = (p: P) => rt.call<{ name?: string }>('world.block', { ...p }).then(b => b.name ?? '').catch(() => '');
  const isChest = (n: string) => /(^|:)(chest|trapped_chest|barrel)$/.test(n.replace(/\[.*$/, ''));
  const here = await block(at);
  if (!here) return { seen: 'not in sight from here: checked on the first trip' };
  const signOf = async (p: P): Promise<string[]> => {
    const out: string[] = [];
    for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 1], [0, 1, -1], [1, 1, 0], [-1, 1, 0]]) {
      const r = await rt.call<{ sign: boolean; lines?: string[] }>('sign.read', { x: p.x + dx, y: p.y + dy, z: p.z + dz }).catch(() => ({ sign: false }));
      if (r.sign && 'lines' in r && r.lines) out.push(r.lines.join(' ').trim());
    }
    return out;
  };
  const label = (lines: string[]) => lines.some(l => l.toLowerCase().replace(/\s+/g, '').includes(name.toLowerCase()));
  if (isChest(here)) return { at, seen: label(await signOf(at)) ? `a chest labelled ${name} is there` : 'a chest is there' };
  const chests: P[] = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const p = { x: at.x + dx, y: at.y + dy, z: at.z + dz };
    if (isChest(await block(p))) chests.push(p);
  }
  for (const p of chests) if (label(await signOf(p))) return { at: p, seen: `the chest labelled ${name}, ${Math.round(Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z))} block(s) from the point given` };
  if (chests.length === 1) return { at: chests[0], seen: `the one chest by the point given (no sign reading ${name} found)` };
  return { seen: "", error: `No chest at (${at.x}, ${at.y}, ${at.z}) (${here.replace(/\[.*$/, '')} there)${chests.length ? `, and ${chests.length} chests near it with no sign reading ${name}: give the chest's own position` : ', nor within 2 blocks'}` };
}
