import { z } from 'zod';
import type { ToolFactory } from '../../tool-factory.js';
import type { Brain } from './brain.js';
import type { ClientRuntime } from '../tools.js';
import { lightArea, YARD_RADIUS } from './chores.js';

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
}
