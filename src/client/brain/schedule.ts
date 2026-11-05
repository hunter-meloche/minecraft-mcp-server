/**
 * The bot's day, like a villager's schedule: work in daylight, head home before dark, rest through the night.
 * Times are the world's time of day (0 = sunrise, 24000 a full day; monsters spawn from about 13000).
 */
export type Activity = 'work' | 'return' | 'rest';

/** Head home from here (a trip ends in time to walk back before monsters come out). */
export const RETURN_AT = 11_000;
/** Night: stay inside, sleep when the bed allows it (12542 in clear weather). */
export const REST_AT = 12_500;
/** Morning: back to work (beds wake players at 0; the last monsters burn at sunrise). */
export const WORK_AT = 23_500;

export function activityAt(timeOfDay: number, thundering = false): Activity {
  const t = ((timeOfDay % 24_000) + 24_000) % 24_000;
  if (thundering) return 'rest'; // monsters spawn in thunderstorms at any hour, and beds work then
  if (t >= WORK_AT || t < RETURN_AT) return 'work';
  return t < REST_AT ? 'return' : 'rest';
}

/** Ticks of daylight left before the return home should start (0 when it already should have). */
export function daylightLeft(timeOfDay: number): number {
  const t = ((timeOfDay % 24_000) + 24_000) % 24_000;
  if (t >= WORK_AT) return RETURN_AT + 24_000 - t;
  return Math.max(0, RETURN_AT - t);
}
