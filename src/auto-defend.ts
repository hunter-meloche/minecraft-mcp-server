import type mineflayer from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { bestWeapon, describe, eatSomething, equipBestArmor, fighting, FIST_COOLDOWN_MS, hostilesNear, matchesTarget } from './combat.js';
import { countCover, describeShelter, wallIn } from './bunker.js';

/**
 * A reflex that runs beside whatever tool is active: hit any hostile within reach (and anything that just hurt the
 * bot), on the weapon's cooldown, without moving. Also keeps a log of damage taken so tool replies can mention it.
 */

const REACH = 3.2;
const ATTACKER_MEMORY_MS = 10000;
/** How far away a mob that shot us may be for the shield guard to face it. */
const GUARD_RANGE = 24;
const SHOT_MEMORY_MS = 6000;
/** At or below this health, still being hurt, and with blocks to spare: wall in. */
const EMERGENCY_HEALTH = 6;

interface DefendState {
  enabled: boolean;
  busy: boolean;
  lastSwing: number;
  attackers: Map<number, number>; // entity id -> when it last hurt the bot
  hurts: { by: string; at: number }[]; // since the last alert was taken
  hitsByReflex: Map<string, number>; // since the last alert was taken
  lastHurtAt: number;
  shelteredAt: string | null; // feet cell of the last emergency shelter, so it isn't rebuilt every tick
  notes: string[]; // since the last alert was taken
  shieldUp: boolean; // raised by the shield guard
  seenDamageEvents: boolean; // the server sends damage_event (1.19.4+): take hurts from there, with their cause
  escaping: 'water' | 'lava' | null; // holding jump to get out of it
}

/** Damage type names by id, from the server's registry (sent while logging in). */
const damageTypes = new WeakMap<mineflayer.Bot, string[]>();

/** Keep the damage type names from a registry_data packet, so hurts can say 'lava' or 'fall' instead of 'unknown'. */
export function rememberRegistry(bot: mineflayer.Bot, packet: { id?: string; entries?: { key: string }[] }): void {
  if (packet.id?.replace('minecraft:', '') === 'damage_type' && Array.isArray(packet.entries)) {
    damageTypes.set(bot, packet.entries.map(e => e.key.replace('minecraft:', '')));
  }
}

const states = new WeakMap<mineflayer.Bot, DefendState>();

function stateOf(bot: mineflayer.Bot): DefendState {
  let s = states.get(bot);
  if (!s) {
    s = { enabled: true, busy: false, lastSwing: 0, attackers: new Map(), hurts: [], hitsByReflex: new Map(), lastHurtAt: 0, shelteredAt: null, notes: [], shieldUp: false, seenDamageEvents: false, escaping: null };
    states.set(bot, s);
  }
  return s;
}

export function setAutoDefend(bot: mineflayer.Bot, enabled: boolean): void {
  stateOf(bot).enabled = enabled;
}

export function autoDefendEnabled(bot: mineflayer.Bot): boolean {
  return stateOf(bot).enabled;
}

/** Record who or what hurt the bot. `cause` is the damage type ('lava', 'fall', 'arrow', ...) when known. */
export function noteHurt(bot: mineflayer.Bot, entity: Entity | undefined, source: Entity | undefined, cause?: string): void {
  if (!entity || entity !== bot.entity) return;
  const s = stateOf(bot);
  const by = source ? (cause && cause !== 'mob_attack' ? `${cause} from ${describe(source)}` : describe(source)) : cause ?? 'unknown';
  s.hurts.push({ by, at: Date.now() });
  s.lastHurtAt = Date.now();
  if (source) s.attackers.set(source.id, Date.now());
}

/** The entity the reflex should hit now, if any. */
export function reflexTarget(bot: mineflayer.Bot, now = Date.now()): Entity | null {
  const s = stateOf(bot);
  const me = bot.entity.position;
  const recentAttacker = (e: Entity) => (s.attackers.get(e.id) ?? 0) > now - ATTACKER_MEMORY_MS;
  const inReach = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.isValid !== false && e.position.distanceTo(me) <= REACH)
    .filter(e => matchesTarget(e, 'hostile') || (recentAttacker(e) && e.type !== 'player'))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  return inReach[0] ?? null;
}

/** One reflex step; returns what it hit. Exported for tests; installAutoDefend runs it every 100 ms. */
export async function defendTick(bot: mineflayer.Bot, now = Date.now()): Promise<string | null> {
  const s = stateOf(bot);
  if (!s.enabled || s.busy || fighting.has(bot) || !bot.entity) return null;
  if (bot.game?.gameMode === 'creative' || bot.game?.gameMode === 'spectator') return null;
  if (bot.usingHeldItem && !s.shieldUp) return null; // eating: swinging would cancel it
  const weapon = bestWeapon(bot.inventory.items());
  if (now - s.lastSwing < (weapon?.cooldownMs ?? FIST_COOLDOWN_MS)) return null;
  const target = reflexTarget(bot, now);
  if (!target) return null;

  s.busy = true;
  try {
    if (s.shieldUp) { bot.deactivateItem(); s.shieldUp = false; }
    // don't swap tools in the middle of digging; otherwise take the weapon
    if (!bot.targetDigBlock && weapon && bot.heldItem?.name !== weapon.item.name) {
      const stack = bot.inventory.items().find(i => i.name === weapon.item.name);
      if (stack) await bot.equip(stack, 'hand');
    }
    await bot.lookAt(target.position.offset(0, (target.height ?? 1) * 0.8, 0), true);
    bot.attack(target);
    s.lastSwing = Date.now();
    const name = describe(target);
    s.hitsByReflex.set(name, (s.hitsByReflex.get(name) ?? 0) + 1);
    return name;
  } finally {
    s.busy = false;
  }
}

/**
 * Shield guard while the bot is idle (not walking or digging): face the nearest threat and hold the shield up. The
 * threat is a hostile in reach, or failing that whoever shot us in the last few seconds from up to 24 blocks (a
 * skeleton at 10+ blocks). Between melee swings the shield stays up; it comes down only when a swing is ready (the
 * reflex then swings) or when there is no threat or the bot gets busy. Exported for tests; installAutoDefend runs it
 * before the reflex.
 */
export async function shieldTick(bot: mineflayer.Bot, now = Date.now()): Promise<'up' | 'down' | null> {
  const s = stateOf(bot);
  if (s.busy || !bot.entity) return null;
  const lower = () => { bot.deactivateItem(); s.shieldUp = false; return 'down' as const; };
  if (!s.enabled || fighting.has(bot)) return s.shieldUp ? lower() : null;
  if (bot.usingHeldItem && !s.shieldUp) return null; // eating
  const hasShield = bot.inventory.slots?.[45]?.name === 'shield';
  const pf = bot.pathfinder as unknown as { isMoving?: () => boolean } | undefined;
  const idle = !pf?.isMoving?.() && !bot.targetDigBlock;
  const me = bot.entity.position;
  const melee = reflexTarget(bot, now);
  const shooter = Object.values(bot.entities)
    .filter(e => (s.attackers.get(e.id) ?? 0) > now - SHOT_MEMORY_MS && e.isValid !== false)
    .filter(e => { const d = e.position.distanceTo(me); return d > REACH && d <= GUARD_RANGE; })
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
  const threat = melee ?? shooter;
  if (!hasShield || !idle || !threat) return s.shieldUp ? lower() : null;
  const cooldown = bestWeapon(bot.inventory.items())?.cooldownMs ?? FIST_COOLDOWN_MS;
  if (melee && now - s.lastSwing >= cooldown) return null; // the reflex swings next and lowers it

  s.busy = true;
  try {
    await bot.lookAt(threat.position.offset(0, (threat.height ?? 1) * 0.8, 0), true);
    if (s.shieldUp) return null;
    bot.activateItem(true);
    s.shieldUp = true;
    const note = `raised shield against ${describe(threat)}`;
    if (!s.notes.includes(note)) s.notes.push(note);
    return 'up';
  } finally {
    s.busy = false;
  }
}

/** Air at or below this (of 20) with the head under water: swim up. */
const LOW_AIR = 12;

/**
 * Environmental hazards: under water and running out of air, swim up (hold jump); standing in lava, jump to get
 * out of it. The bot drowned standing in a flooded crater at night while nothing else was going on.
 * Exported for tests; installAutoDefend runs it before the other reflexes.
 */
export function hazardTick(bot: mineflayer.Bot): 'water' | 'lava' | null {
  const s = stateOf(bot);
  if (!s.enabled || !bot.entity || typeof bot.setControlState !== 'function') return null;
  if (bot.game?.gameMode === 'creative' || bot.game?.gameMode === 'spectator') return null;
  const p = bot.entity.position;
  const isWater = (name?: string) => name === 'water' || name === 'bubble_column';
  const head = bot.blockAt(p.offset(0, 1.62, 0));
  const feet = bot.blockAt(p);
  const air = (bot as unknown as { oxygenLevel?: number }).oxygenLevel ?? 20;
  let hazard: 'water' | 'lava' | null = null;
  if (feet?.name === 'lava' || head?.name === 'lava') hazard = 'lava';
  else if (isWater(head?.name) && air <= LOW_AIR) hazard = 'water';
  else if (s.escaping === 'water' && isWater(head?.name) && air < 20) hazard = 'water'; // keep going till we breathe

  if (hazard && s.escaping !== hazard) {
    bot.setControlState('jump', true);
    s.notes.push(hazard === 'water' ? `out of air under water (${air}/20): swimming up` : 'in lava: jumping out');
  } else if (!hazard && s.escaping) {
    bot.setControlState('jump', false);
  }
  s.escaping = hazard;
  return hazard;
}

/**
 * Low health and still taking damage, while no fight of ours is running (e.g. shot while idle or walking): wall in
 * and eat. Exported for tests; installAutoDefend runs it with the reflex.
 */
export async function emergencyTick(bot: mineflayer.Bot, now = Date.now()): Promise<string | null> {
  const s = stateOf(bot);
  if (!s.enabled || s.busy || fighting.has(bot) || !bot.entity) return null;
  if (bot.game?.gameMode === 'creative' || bot.game?.gameMode === 'spectator') return null;
  if (bot.health > EMERGENCY_HEALTH || now - s.lastHurtAt > 3000) return null;
  const feet = bot.entity.position.floored().toString();
  if (s.shelteredAt === feet || countCover(bot.inventory.items()) < 5) return null;

  s.busy = true;
  try {
    const shelter = await wallIn(bot);
    s.shelteredAt = feet;
    const eaten = await eatSomething(bot);
    const note = `health ${Math.round(bot.health * 10) / 10} and under attack: ${describeShelter(shelter)}${eaten ? ` Then ${eaten}.` : ''}`;
    s.notes.push(note);
    return note;
  } finally {
    s.busy = false;
  }
}

/**
 * Wear the best armor carried and keep a shield in an empty off-hand, so the bot isn't caught unarmored between
 * fights. Exported for tests; installAutoDefend runs it every 2 s.
 */
export async function gearTick(bot: mineflayer.Bot): Promise<string[]> {
  const s = stateOf(bot);
  if (!s.enabled || s.busy || fighting.has(bot) || !bot.entity || bot.usingHeldItem) return [];
  if (bot.game?.gameMode === 'creative' || bot.game?.gameMode === 'spectator') return [];
  s.busy = true;
  try {
    const put = await equipBestArmor(bot);
    const shield = bot.inventory.items().find(i => i.name === 'shield');
    if (shield && !bot.inventory.slots[45]) {
      await bot.equip(shield, 'off-hand');
      put.push('shield');
    }
    if (put.length) s.notes.push(`put on ${put.join(', ')}`);
    return put;
  } finally {
    s.busy = false;
  }
}

export function installAutoDefend(bot: mineflayer.Bot, onError?: (err: unknown) => void): void {
  stateOf(bot);
  // 1.19.4+: damage_event says what kind of damage it was; before that only entity_status (no cause, no source)
  bot._client?.on('damage_event', (p: { entityId: number; sourceTypeId: number; sourceCauseId: number }) => {
    const s = stateOf(bot);
    s.seenDamageEvents = true;
    if (p.entityId !== bot.entity?.id) return;
    const source = p.sourceCauseId > 0 ? bot.entities[p.sourceCauseId - 1] : undefined;
    noteHurt(bot, bot.entity, source, damageTypes.get(bot)?.[p.sourceTypeId]);
  });
  bot.on('entityHurt', (entity, source) => {
    if (!stateOf(bot).seenDamageEvents) noteHurt(bot, entity, source as Entity | undefined);
  });
  let ticks = 0;
  const timer = setInterval(() => {
    try { hazardTick(bot); } catch (err) { onError?.(err); }
    if (++ticks % 20 === 0) { gearTick(bot).catch(err => onError?.(err)); return; }
    emergencyTick(bot)
      .then(sheltered => (sheltered ? null : shieldTick(bot)))
      .then(() => defendTick(bot))
      .catch(err => onError?.(err));
  }, 100);
  bot.once('end', () => clearInterval(timer));
}

/**
 * What happened to the bot since the last call: damage taken, and what auto-defend hit. Tool replies append this so
 * the caller notices an attack it didn't ask about.
 */
export function takeAlerts(bot: mineflayer.Bot): string | null {
  const s = states.get(bot);
  if (!s || (s.hurts.length === 0 && s.hitsByReflex.size === 0 && s.notes.length === 0)) return null;
  const parts: string[] = [...s.notes];
  if (s.hurts.length) {
    const by = new Map<string, number>();
    for (const h of s.hurts) by.set(h.by, (by.get(h.by) ?? 0) + 1);
    parts.push(`Took damage ${s.hurts.length}x (${[...by].map(([n, c]) => `${n} x${c}`).join(', ')}); health ${Math.round(bot.health * 10) / 10}/20`);
  }
  if (s.hitsByReflex.size) {
    parts.push(`auto-defend hit ${[...s.hitsByReflex].map(([n, c]) => `${n} x${c}`).join(', ')}`);
  }
  const near = hostilesNear(bot, 12).map(e => `${describe(e)} ${e.position.distanceTo(bot.entity.position).toFixed(0)}m`);
  if (near.length) parts.push(`hostiles near: ${near.join(', ')}`);
  s.hurts = [];
  s.hitsByReflex = new Map();
  s.notes = [];
  return parts.join('; ');
}
