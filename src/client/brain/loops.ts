/**
 * Loop watch: the autopilot going round in circles instead of getting anywhere. Seen so far:
 * - two goals taking turns, one stopping the other before it gets anywhere (food walking to the chests and retreat
 *   pulling it back to the doorstep; kit or stash and the evening walk home), every few seconds;
 * - one goal starting over and over with nothing to show (the kit taking the same worn pickaxe out of the chest).
 * Pure: the brain feeds it each run as it starts and ends; it reports a loop once, with the runs that make it, so it
 * can be logged for a person (or an LLM) to fix, and the brain can back the losing goal off meanwhile.
 */

export type Outcome = 'done' | 'failed' | 'stopped';
export interface Run {
  goal: string; reason: string; at: number; ms?: number; outcome?: Outcome; text?: string;
  /** what the run brought in, as the goal reported it (kept when it was stopped midway); not set: it reported none */
  gain?: number;
}
export interface Loop {
  kind: 'ping-pong' | 'spinning';
  goals: string[];
  /** the goal to back off: the one that keeps losing (stopped or failed), or the spinning one */
  victim: string;
  cycles: number;
  summary: string;
  runs: Run[];
}

const WINDOW = 15 * 60_000;
const QUICK = 20_000;
const SHORT = 60_000;

/** Same text but for numbers (counts, coordinates, seconds). */
const shape = (t?: string) => (t ?? '').replace(/-?\d+(\.\d+)?/g, '#').slice(0, 120);

/** The loop the most recent finished runs show, if any. */
export function findLoop(runs: Run[], now: number): Loop | undefined {
  const recent = runs.filter(r => r.outcome && now - r.at <= WINDOW);
  if (recent.length < 4) return undefined;
  const tail = recent.slice().reverse(); // newest first

  // two goals taking turns
  const [a, b] = [tail[0].goal, tail[1]?.goal];
  if (b && a !== b) {
    let n = 0;
    while (n < tail.length && tail[n].goal === (n % 2 === 0 ? a : b)) n++;
    const seq = tail.slice(0, n - (n % 2)).reverse();
    const cycles = seq.length / 2;
    if (cycles >= 3) {
      const pairs = Array.from({ length: cycles }, (_, i) => seq.slice(2 * i, 2 * i + 2));
      const losing = pairs.every(p => p.some(r => r.outcome !== 'done'));
      const quick = pairs.every(p => p.every(r => (r.ms ?? 0) < QUICK));
      if (losing || quick) {
        const lost = (g: string) => seq.filter(r => r.goal === g && r.outcome !== 'done').length;
        const victim = lost(a) >= lost(b) ? a : b;
        return {
          kind: 'ping-pong', goals: [b, a], victim, cycles, runs: seq,
          summary: `${b} and ${a} took turns ${cycles} times in ${Math.round((seq.at(-1)!.at - seq[0].at) / 1000)}s` +
            ` (${victim} ${losing ? 'never got anywhere' : 'kept stopping quickly'}): ` +
            seq.slice(-4).map(r => `${r.goal} ${r.outcome} after ${Math.round((r.ms ?? 0) / 1000)}s${r.text ? ` (${r.text.slice(0, 60)})` : ''}`).join('; ')
        };
      }
    }
  }

  // one goal over and over with the same result
  let k = 0;
  while (k < tail.length && tail[k].goal === a && (tail[k].ms ?? 0) < SHORT && shape(tail[k].text) === shape(tail[0].text)) k++;
  if (k >= 4) {
    const seq = tail.slice(0, k).reverse();
    return {
      kind: 'spinning', goals: [a], victim: a, cycles: k, runs: seq,
      summary: `${a} ran ${k} times in ${Math.round((seq.at(-1)!.at - seq[0].at) / 1000)}s with the same result: ${seq.at(-1)!.outcome} (${(seq.at(-1)!.text ?? '').slice(0, 100)})`
    };
  }
  return undefined;
}

/** The runs, and loops already reported (each kind of loop once per half hour). */
export class LoopWatch {
  readonly runs: Run[] = [];
  readonly found: { at: number; loop: Loop }[] = [];
  private reported = new Map<string, number>();
  /** The loop the last run showed again, already reported within the half hour (still worth backing off). */
  repeat: Loop | undefined;

  begin(goal: string, reason: string, at: number): Run {
    const r: Run = { goal, reason, at };
    this.runs.push(r);
    if (this.runs.length > 60) this.runs.splice(0, this.runs.length - 60);
    return r;
  }

  /** Finish a run; returns a loop the first time it shows. */
  end(run: Run, outcome: Outcome, text: string, now: number): Loop | undefined {
    run.outcome = outcome;
    run.ms = now - run.at;
    run.text = text;
    this.repeat = undefined;
    const loop = findLoop(this.runs, now);
    if (!loop) return undefined;
    const sig = `${loop.kind}:${[...loop.goals].sort().join('+')}`;
    if (now - (this.reported.get(sig) ?? -Infinity) < 30 * 60_000) { this.repeat = loop; return undefined; }
    this.reported.set(sig, now);
    this.found.push({ at: now, loop });
    if (this.found.length > 20) this.found.shift();
    return loop;
  }
}
