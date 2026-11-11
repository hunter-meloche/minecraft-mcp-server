import test from 'ava';
import { freeLid, peekChest } from '../../src/client/brain/chests.js';
import type { GoalContext } from '../../src/client/brain/goals.js';

test('freeLid digs throwaway blocks off a chest and its other half, and nothing else', async (t) => {
  const world: Record<string, { name: string; properties?: Record<string, string> }> = {
    '0,64,0': { name: 'chest', properties: { type: 'left', facing: 'west' } },
    '0,64,1': { name: 'chest', properties: { type: 'right', facing: 'west' } },
    '1,64,0': { name: 'furnace' },
    '0,65,1': { name: 'cobblestone' }, // on the other half's lid
    '0,65,0': { name: 'air' }
  };
  const dug: string[] = [];
  const call = (async (m: string, p: { x: number; y: number; z: number }) => {
    const k = `${p.x},${p.y},${p.z}`;
    if (m === 'world.block') return world[k] ?? { name: 'air' };
    if (m === 'dig') { dug.push(k); world[k] = { name: 'air' }; return { dug: true }; }
    throw new Error(m);
  }) as Parameters<typeof freeLid>[0];
  t.deepEqual(await freeLid(call, { x: 0, y: 64, z: 0 }), [{ x: 0, y: 65, z: 1 }]);
  world['0,65,0'] = { name: 'oak_planks' }; // someone's building on top: stays
  t.deepEqual(await freeLid(call, { x: 0, y: 64, z: 0 }), []);
  t.deepEqual(dug, ['0,65,1']);
});

/** A chest two layers up: `opens` says for each try whether it opens, is too far, or has its lid held down. */
function peek(opens: ('ok' | 'far' | 'lid')[], lidBlock = 'cobblestone') {
  const chest = { x: 1, y: 65, z: 0 };
  const calls: { m: string; p: Record<string, unknown> }[] = [];
  const acts: { tool: string; args: Record<string, unknown> }[] = [];
  let n = 0;
  let lid = lidBlock;
  const ctx = {
    world: {},
    call: async (m: string, p: Record<string, unknown> = {}) => {
      calls.push({ m, p });
      if (m === 'chest.open') {
        const o = lid === 'air' ? 'ok' : opens[Math.min(n++, opens.length - 1)];
        if (o === 'far') throw new Error('chest too far to open');
        if (o === 'lid') throw new Error('the chest did not open (blocked lid, or not a chest)');
        return { items: { iron_ingot: 5 } };
      }
      if (m === 'goto') return { arrived: true };
      if (m === 'world.block') return p.y === 66 && p.x === 1 && p.z === 0 ? { name: lid } : p.y === 65 && p.x === 1 && p.z === 0 ? { name: 'chest', properties: { type: 'single' } } : { name: 'air' };
      if (m === 'dig') { lid = 'air'; return { dug: true }; }
      if (m === 'container.close') return { ok: true };
      throw new Error(`unexpected ${m}`);
    },
    act: async (tool: string, args: Record<string, unknown>) => { acts.push({ tool, args }); return { ok: true, text: 'there' }; }
  };
  return { chest, calls, acts, ctx: ctx as unknown as GoalContext, of: (m: string) => calls.filter(c => c.m === m).map(c => c.p) };
}

test('peekChest walks up on foot only at first, to within 3: the floor reaches a chest two layers up', async (t) => {
  const near = peek(['far', 'ok']);
  t.deepEqual(await peekChest(near.ctx, near.chest), { iron_ingot: 5 });
  t.is(near.of('goto').length, 1);
  t.like(near.of('goto')[0], { ...near.chest, range: 3, careful: true });
  t.deepEqual(near.acts, []);   // the walk that may dig or pillar is not taken
  t.deepEqual((near.ctx.world as { chestItems?: unknown }).chestItems, { '1,65,0': { iron_ingot: 5 } });
});

test('peekChest falls back on the walk as before for a chest the careful walk does not reach', async (t) => {
  const far = peek(['far', 'far', 'ok']);
  t.deepEqual(await peekChest(far.ctx, far.chest), { iron_ingot: 5 });
  t.is(far.of('goto').length, 1);
  t.deepEqual(far.acts.map(a => a.tool), ['move-to-position']);
  t.like(far.acts[0].args, { ...far.chest, range: 2 });
});

test('peekChest frees a held-down lid without the walk that pillars; someone else\'s block on it stays', async (t) => {
  const held = peek(['far', 'lid']);
  t.deepEqual(await peekChest(held.ctx, held.chest), { iron_ingot: 5 });
  t.deepEqual(held.acts, []);
  t.deepEqual(held.of('dig').map(p => ({ x: p.x, y: p.y, z: p.z })), [{ x: 1, y: 66, z: 0 }]);
  const built = peek(['lid'], 'oak_planks');
  await t.throwsAsync(peekChest(built.ctx, built.chest), { message: /did not open/ });
  t.deepEqual(built.acts, []);
  t.deepEqual(built.of('dig'), []);
  t.is(built.of('container.close').length, 1);
});
