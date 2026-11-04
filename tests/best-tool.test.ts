import test from 'ava';
import sinon from 'sinon';
import { bestHarvestTool, equipBestTool } from '../src/best-tool.js';

// digTime by item type: null = bare hand
function fakeBlock (times: Record<string, number>) {
  return { name: 'test_block', digTime: (type: number | null) => times[String(type)] ?? times.null } as never;
}
const item = (type: number, name: string) => ({ type, name }) as never;

function fakeBot (items: unknown[], held: unknown = null) {
  return { inventory: { items: () => items }, heldItem: held, entity: { effects: {} }, equip: sinon.stub().resolves() } as never;
}

test('picks the tool that digs faster than a bare hand', (t) => {
  const pickaxe = item(2, 'wooden_pickaxe');
  const bot = fakeBot([item(1, 'apple'), pickaxe]);
  t.is(bestHarvestTool(bot, fakeBlock({ null: 7.5, 1: 7.5, 2: 1.15 })), pickaxe);
});

test('returns null when nothing beats a bare hand (no random item swap)', (t) => {
  const bot = fakeBot([item(1, 'apple'), item(3, 'dirt')]);
  t.is(bestHarvestTool(bot, fakeBlock({ null: 0.75 })), null);
});

test('keeps the held item on a tie', (t) => {
  const heldPick = item(2, 'wooden_pickaxe');
  const bot = fakeBot([item(5, 'stone_pickaxe_same_speed'), heldPick], heldPick);
  t.is(bestHarvestTool(bot, fakeBlock({ null: 7.5, 2: 1.15, 5: 1.15 })), heldPick);
});

test('equipBestTool equips only when the tool is not already held', async (t) => {
  const pickaxe = item(2, 'wooden_pickaxe');
  const block = fakeBlock({ null: 7.5, 2: 1.15 });
  const notHeld = fakeBot([pickaxe]) as unknown as { equip: sinon.SinonStub };
  await equipBestTool(notHeld as never, block);
  t.true(notHeld.equip.calledOnceWith(pickaxe, 'hand'));
  const held = fakeBot([pickaxe], pickaxe) as unknown as { equip: sinon.SinonStub };
  await equipBestTool(held as never, block);
  t.false(held.equip.called);
});
