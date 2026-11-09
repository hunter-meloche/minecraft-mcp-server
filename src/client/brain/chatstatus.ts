/**
 * "claudebot status" in the server chat: anyone may ask what the bot is doing, and it answers in one line. The only
 * thing it ever says on its own account in a shared world, and only when asked: at most one answer per COOLDOWN (a
 * crowd asking at once gets one line, not a spam of them), never to itself.
 */

/** Seconds between answers. */
export const COOLDOWN_MS = 20_000;
/** A chat line holds 256 characters. */
const MAX = 240;

/** Is this a status question for the bot named `bot` ("claudebot status", "Claudebot, status?", "@claudebot status")? */
export function isStatusQuery(message: string, bot: string): boolean {
  const name = bot.replace(/[^a-z0-9_]/gi, '').toLowerCase();
  const m = message.trim().toLowerCase().replace(/^@/, '');
  return new RegExp(`^${name}[\\s,:]+status[\\s!?.]*$`).test(m);
}

export interface StatusFacts {
  /** the brain's one-line status ("Autopilot: project - an enchanting room: mine 4 obsidian") */
  line: string;
  health?: number;
  food?: number;
  /** the milestone in hand ("an enchanting room") and how many are done */
  project?: string;
  done?: number;
}

/** The answer, one chat line. */
export function statusAnswer(f: StatusFacts): string {
  const doing = f.line.replace(/^Autopilot:\s*/, '').replace(/^Autopilot paused: LLM in control/, 'paused while Claude drives');
  const vitals = f.health !== undefined ? ` | health ${Math.round(f.health)}/20, food ${Math.round(f.food ?? 0)}/20` : '';
  const proj = f.project ? ` | building: ${f.project}${f.done !== undefined ? ` (${f.done} projects done)` : ''}` : '';
  const out = `${doing}${vitals}${proj}`;
  return out.length > MAX ? `${out.slice(0, MAX - 1)}…` : out;
}

/** The rate limit: true when an answer may go now (and counts it). */
export function cooldown(now: () => number = Date.now): () => boolean {
  let last = -Infinity;
  return () => {
    if (now() - last < COOLDOWN_MS) return false;
    last = now();
    return true;
  };
}
