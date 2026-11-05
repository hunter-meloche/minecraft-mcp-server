import { z } from 'zod';
import type { ToolFactory } from '../../tool-factory.js';
import type { Brain } from './brain.js';

/** Tools to switch the brain on and off and see what it is doing. They never take control from it. */
export function registerBrainTools(factory: ToolFactory, brain: Brain): void {
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
}
