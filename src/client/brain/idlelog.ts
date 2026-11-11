import type { Decline, Goal, Snapshot } from './goals.js';
import type { WorldMemory } from './memory.js';

/**
 * The idle log: why the bot stands about by day, and what that costs. It stood idle for a third of its daytime and
 * nothing said why: a goal that does not want to run just answers null. Here every "no" has a cause; the time is
 * counted in real milliseconds under the cause that leads (ticks miscount: one that starts a goal and one that finds
 * nothing weighed the same), and each day's sums are kept in brain.json for a week. It measures only: nothing here
 * decides what the bot does. Pure and synchronous, and nothing in it throws (the brain's tick must not fail on its
 * own book-keeping).
 */

/**
 * Why nothing runs: `away` no home, or beyond the leash; `health` too hurt or hungry; `hold` a goal held back after a
 * failure, a stuck stop or a loop; `pockets` no room to carry; `late` too little day left; `kit` not equipped for it;
 * `project` the project waits for something; `dry` the places it knows gave nothing lately; `stocked` enough in the
 * chests; `unneeded` nothing to do there; `nothing` no goal gave a reason at all (a gap in the goals: a bug).
 */
export type IdleCause = 'away' | 'health' | 'hold' | 'pockets' | 'late' | 'kit' | 'project' | 'dry' | 'stocked' | 'unneeded' | 'nothing';

/** The causes, the leading one first: with several reasons at once the time goes to the first of them in this order. */
export const CAUSES: readonly IdleCause[] = ['away', 'health', 'hold', 'pockets', 'late', 'kit', 'project', 'dry', 'stocked', 'unneeded', 'nothing'];

/** One game day's counted daytime in real ms: awake by day with a home, the autopilot in charge. */
export interface IdleDay {
  /** counts up by one each morning (the game's own day number isn't in the status) */
  day: number;
  /** all of it: busy, idle and empty together */
  workMs: number;
  /** nothing running, and the walk back to the yard from nowhere */
  idleMs: number;
  /** busy to no gain: runs of a `gains` goal that brought nothing in */
  emptyMs: number;
  /** idleMs by its lead cause */
  by: Partial<Record<IdleCause, number>>;
}

/** Kept in brain.json per world. `days`: the days before today, the newest first, at most 7. */
export interface IdleMemory { today: IdleDay; days: IdleDay[] }

const KEEP_DAYS = 7;

const isCause = (c: unknown): c is IdleCause => CAUSES.includes(c as IdleCause);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** a count of ms as it must be: a number, not negative (anything else is 0) */
const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const rank = (c: IdleCause) => { const i = CAUSES.indexOf(c); return i < 0 ? CAUSES.length : i; };
const secs = (t: number) => Math.round(t / 1000);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round(100 * part / whole) : 0);
/** HH:MM, UTC like the log's own times; a time that is no time reads `?` (a Date out of range throws) */
export const clock = (t: number) => (Number.isFinite(t) && Math.abs(t) < 8.64e15 ? new Date(t).toISOString().slice(11, 16) : '?');

/** A day as it must be, whatever the file held: the same object where there was one, so a caller's hold on it stays good. */
function mend(v: unknown): IdleDay {
  const d: Record<string, unknown> = isObj(v) ? v : {};
  const by: Record<string, unknown> = isObj(d.by) ? d.by : {};
  for (const k of Object.keys(by)) if (!isCause(k) || !ms(by[k])) delete by[k];
  d.day = Math.floor(ms(d.day));
  d.workMs = ms(d.workMs);
  d.idleMs = ms(d.idleMs);
  d.emptyMs = ms(d.emptyMs);
  d.by = by;
  return d as unknown as IdleDay;
}

/**
 * The world's idle tally, made when it isn't there and put right when it is not sound: a brain.json from before this,
 * or one a hand or a half-written save left with something else under `idle`, must not stop the counting.
 */
export function idleOf(world: WorldMemory): IdleMemory {
  try {
    const m = (isObj(world.idle) ? world.idle : {}) as unknown as IdleMemory;
    m.today = mend(m.today);
    m.days = (Array.isArray(m.days) ? m.days : []).filter(isObj).slice(0, KEEP_DAYS).map(mend);
    world.idle = m;
    return m;
  } catch {
    world.idle = { today: mend(undefined), days: [] };
    return world.idle;
  }
}

/** What a goal says to "why not", when it can say and what it says is sound; one whose declines() throws says nothing. */
function declineOf(g: Goal, s: Snapshot, world: WorldMemory): Decline | undefined {
  if (!g.declines) return undefined;
  try {
    const d = g.declines(s, world);
    return d && isCause(d.cause) && typeof d.text === 'string' ? d : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why nothing runs right now, the lead cause first ([0]): what holds for every goal (away, health), then each goal
 * held back (why, and until when), then what each goal that can say why it doesn't want to run says, in the goals'
 * order. A held goal that would decline anyway is listed by that decline, not as held: its hold keeps nothing from
 * running, and `hold` must not lead the idle time for it (a goal that cannot say why is listed as held). When nobody
 * says anything it is `nothing`: no goal wants to run and none explains itself, which is the gap to close. A goal
 * whose declines() throws is left out; the others still explain the time.
 */
export function explainIdle(s: Snapshot, world: WorldMemory, goals: Goal[], retryAt: Map<string, number>, holdWhy: Map<string, string>): Decline[] {
  const out: Decline[] = [];
  const said = new Map<Goal, Decline>();
  for (const g of goals) {
    const d = declineOf(g, s, world);
    if (d) said.set(g, d);
  }
  try {
    if (!s.home) out.push({ cause: 'away', text: 'no home set' });
    else if (!Number.isFinite(s.distHome)) out.push({ cause: 'away', text: 'in another dimension' });
    else if (s.distHome > world.leash) out.push({ cause: 'away', text: `${Math.round(s.distHome)} blocks from home, leash ${world.leash}` });
    if (s.health < 12 || s.food < 10) out.push({ cause: 'health', text: `health ${Math.round(s.health)}, food ${Math.round(s.food)}` });
    // only the goals the brain chooses from: a hold on anything else keeps nothing from running
    for (const g of goals) {
      const until = retryAt.get(g.name) ?? 0;
      if (!(until > s.now) || said.has(g)) continue;
      const why = holdWhy.get(g.name);
      out.push({ cause: 'hold', text: `${g.name} held until ${clock(until)}${why ? ` (${why})` : ''}`, until });
    }
  } catch { /* what could be told so far is told */ }
  for (const g of goals) {
    const d = said.get(g);
    if (d) out.push(d);
  }
  if (!out.length) return [{ cause: 'nothing', text: 'no goal wants to run, and none says why' }];
  return out.sort((a, b) => rank(a.cause) - rank(b.cause));
}

/** Book counted daytime: `busy` a run, `idle` nothing running (under its lead cause), `empty` a run that gained nothing. */
export function tally(world: WorldMemory, kind: 'busy' | 'idle' | 'empty', time: number, cause?: IdleCause): void {
  try {
    const dt = ms(time);
    if (!dt) return;
    const t = idleOf(world).today;
    t.workMs += dt;
    if (kind === 'idle') {
      const c = isCause(cause) ? cause : 'nothing';
      t.idleMs += dt;
      t.by[c] = (t.by[c] ?? 0) + dt;
    } else if (kind === 'empty') t.emptyMs += dt;
  } catch { /* a count lost, not a tick */ }
}

/** `late 100s, dry 25s`: the causes by their time, the longest first (under half a second: left out). */
function bySecs(by: IdleDay['by']): string {
  return CAUSES.filter(c => secs(by[c] ?? 0) > 0).sort((a, b) => (by[b] ?? 0) - (by[a] ?? 0)).map(c => `${c} ${secs(by[c] ?? 0)}s`).join(', ');
}

/**
 * The morning: close the day that ended and start the next. Returns the `day:` line for the log, '' when no daytime
 * was counted (the LLM had the bot all day, or it was off): such a day is not kept either, it would read as 0% idle.
 */
export function tallyRoll(world: WorldMemory): string {
  try {
    const m = idleOf(world);
    const d = m.today;
    if (!d.workMs) return '';
    m.days = [d, ...m.days].slice(0, KEEP_DAYS);
    m.today = mend({ day: d.day + 1 });
    const causes = bySecs(d.by);
    return `day: idle ${pct(d.idleMs, d.workMs)}% (${secs(d.idleMs)}s), empty ${pct(d.emptyMs, d.workMs)}% (${secs(d.emptyMs)}s) of ${secs(d.workMs)}s${causes ? `: ${causes}` : ''}`;
  } catch {
    return '';
  }
}

/**
 * The log line of an idle streak under way: how long, and why, in up to three causes (the first reason of each, the
 * lead first). One cause's reasons can be many (every held goal is one), and three of a kind would hide the others.
 */
export function idleLine(time: number, now: Decline[]): string {
  const said: string[] = [];
  const seen = new Set<IdleCause>();
  for (const d of now) {
    if (seen.has(d.cause) || said.length >= 3) continue;
    seen.add(d.cause);
    said.push(`${d.cause}: ${d.text}`);
  }
  return `idle ${secs(time)}s: ${said.join(' | ')}`;
}

/** The log line that closes a streak: how long it was, and how long under each lead cause. */
export function idleOverLine(time: number, by: IdleDay['by']): string {
  const causes = bySecs(by);
  return `idle over after ${secs(time)}s${causes ? `: ${causes}` : ''}`;
}

/** brain-status, by day with nothing running: the lead cause and what it says (in place of "nothing to do"). */
export function idleNow(now: Decline[]): string | undefined {
  const d = now[0];
  return d ? `Now: idle (${d.cause}): ${d.text.replace(/\.$/, '')}.` : undefined;
}

/**
 * brain-status: `Today: idle 8% of daytime, 4% busy to no gain (yesterday 31%, 12%).`, from the tally: how much of
 * the counted daytime nothing ran, and how much went into runs that brought nothing in. Yesterday's pair only when a
 * day before today is kept; no line before any daytime was counted today. It only reads: a world with no tally yet
 * (a brain.json from before it) gets none made here, and whatever else it finds under `idle` it reads as nothing.
 */
export function todayLine(world: WorldMemory): string | undefined {
  try {
    const m: unknown = world.idle;
    if (!isObj(m) || !isObj(m.today)) return undefined;
    const whole = ms(m.today.workMs);
    if (!whole) return undefined;
    const pair = (d: Record<string, unknown>) => `${pct(ms(d.idleMs), ms(d.workMs))}%, ${pct(ms(d.emptyMs), ms(d.workMs))}%`;
    const last: unknown = Array.isArray(m.days) ? m.days[0] : undefined;
    const yesterday = isObj(last) && ms(last.workMs) ? ` (yesterday ${pair(last)})` : '';
    return `Today: idle ${pct(ms(m.today.idleMs), whole)}% of daytime, ${pct(ms(m.today.emptyMs), whole)}% busy to no gain${yesterday}.`;
  } catch {
    return undefined;
  }
}

/**
 * brain-status: today's idle time by cause (in % of the counted daytime; under half a percent left out), and what is
 * blocked: the project's shortfall (as the project says it in `now`, with the try and the next one's time), and every
 * goal held back with why and until when (the `hold` reasons in `now`).
 */
export function idleReport(world: WorldMemory, now: Decline[]): string[] {
  const lines: string[] = [];
  try {
    const t = idleOf(world).today;
    const share = (c: IdleCause) => pct(t.by[c] ?? 0, t.workMs);
    const by = CAUSES.filter(c => share(c) > 0).sort((a, b) => (t.by[b] ?? 0) - (t.by[a] ?? 0)).map(c => `${c} ${share(c)}%`);
    if (by.length) lines.push(`Idle by cause today: ${by.join(', ')}.`);
    const blocked: string[] = [];
    // the project's own words where it says what it is short of (they carry the try and the time of the next one: a
    // step short of materials waits longer each time); else the shortfall the stock trips were given
    const said = now.find(d => d.cause === 'project' && /^short of /.test(d.text));
    const short = Object.entries(world.progress?.need ?? {}).filter(([, n]) => n > 0);
    if (said) blocked.push(`project - ${said.text}`);
    else if (short.length) blocked.push(`project - short of ${short.map(([k, n]) => `${n} ${k}`).join(', ')}`);
    for (const d of now) if (d.cause === 'hold') blocked.push(d.text);
    if (blocked.length) lines.push(`Blocked: ${blocked.join(' | ')}`);
  } catch { /* the status goes without these lines */ }
  return lines;
}
