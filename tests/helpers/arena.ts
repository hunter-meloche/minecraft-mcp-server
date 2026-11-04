import sinon from 'sinon';
import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';
import type mineflayer from 'mineflayer';

export interface FakeMob {
  id: number;
  type: string;
  name: string;
  height: number;
  isValid: boolean;
  position: Vec3;
  hp: number;
}

export const item = (name: string, count = 1) => ({ name, count, type: name.length * 31 + count });

let nextId = 100;
export function mob(name: string, x: number, opts: { type?: string; hp?: number; y?: number; z?: number } = {}): FakeMob {
  return { id: nextId++, type: opts.type ?? 'hostile', name, height: 1.9, isValid: true, position: new Vec3(x, opts.y ?? 64, opts.z ?? 0), hp: opts.hp ?? 20 };
}

const DEST_SLOT: Record<string, number> = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };

/**
 * A fake bot standing at (0, 64, 0). attack() lands (emits entityHurt and takes `damage` hp) unless `misses`
 * says otherwise; a mob at 0 hp disappears. Equipping really changes heldItem / armor slots.
 */
export function arena(opts: {
  mobs?: FakeMob[];
  items?: ReturnType<typeof item>[];
  health?: number;
  food?: number;
  damage?: number;
  misses?: (swing: number) => boolean;
  solid?: string[];
  /** cells that are air even below y=64 (mined out) */
  air?: string[];
  /** solid cells with a block name, e.g. { '0,66,1': 'crafting_table' } */
  named?: Record<string, string>;
} = {}) {
  // the world: solid ground below y=64, plus whatever gets placed; everything else is air
  const placed = new Set<string>(opts.solid ?? []);
  const air = new Set<string>(opts.air ?? []);
  const named = opts.named ?? {};
  const k = (p: Vec3) => `${p.x},${p.y},${p.z}`;
  const isSolid = (p: Vec3) => !air.has(k(p)) && (p.y < 64 || placed.has(k(p)) || k(p) in named);
  const entities: Record<number, FakeMob> = {};
  for (const m of opts.mobs ?? []) entities[m.id] = m;
  const items = opts.items ?? [];
  const slots: unknown[] = [];
  let swing = 0;
  const bot = Object.assign(new EventEmitter(), {
    version: '1.21.8',
    username: 'Bot',
    entity: { id: 1, position: new Vec3(0, 64, 0) } as { id: number; position: Vec3 },
    entities: entities as Record<number, unknown>,
    health: opts.health ?? 20,
    food: opts.food ?? 20,
    game: { gameMode: 'survival' },
    heldItem: null as { name: string } | null,
    usingHeldItem: false,
    targetDigBlock: null as unknown,
    inventory: {
      items: () => items,
      slots,
      selectedItem: null,
      firstEmptyInventorySlot: () => 20
    },
    equip: sinon.spy(async (it: { name: string }, dest: string) => {
      if (dest === 'hand') bot.heldItem = it;
      else slots[DEST_SLOT[dest]] = it;
    }),
    lookAt: sinon.spy(async () => {}),
    attack: sinon.spy((target: FakeMob) => {
      swing++;
      if (opts.misses?.(swing)) return;
      bot.emit('entityHurt', target, bot.entity);
      target.hp -= opts.damage ?? 20;
      if (target.hp <= 0) { bot.emit('entityDead', target); target.isValid = false; delete entities[target.id]; }
    }),
    activateItem: sinon.spy((_offHand?: boolean) => { bot.usingHeldItem = true; }),
    deactivateItem: sinon.spy(() => { bot.usingHeldItem = false; }),
    consume: sinon.spy(async () => { bot.food = Math.min(20, bot.food + 4); }),
    waitForTicks: sinon.stub().resolves(),
    clickWindow: sinon.stub().resolves(),
    nearestEntity: (filter: (e: unknown) => boolean) =>
      Object.values(entities).filter(filter).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ?? null,
    pathfinder: { setGoal: sinon.spy(), goto: sinon.stub().resolves() },
    clearControlStates: sinon.spy(),
    blockAt: (p: Vec3) => ({ name: named[k(p.floored())] ?? (isSolid(p.floored()) ? 'stone' : 'air'), position: p.floored() }),
    placeBlock: sinon.spy(async (ref: { position: Vec3; name?: string }, face: Vec3) => {
      const at = ref.position.plus(face);
      if (Object.values(entities).some(e => e.position.floored().equals(at))) throw new Error('entity in the way');
      if (/crafting_table|furnace|chest|door/.test(ref.name ?? '')) throw new Error(`opened ${ref.name} instead of placing`);
      const held = bot.heldItem as { name: string; count: number } | null;
      if (!held || held.count <= 0) throw new Error('nothing in hand');
      held.count--;
      if (held.count === 0) items.splice(items.indexOf(held as ReturnType<typeof item>), 1);
      air.delete(k(at));
      placed.add(k(at));
    })
  });
  return { bot, asBot: bot as unknown as mineflayer.Bot, entities, placed };
}
