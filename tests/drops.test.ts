import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { collectDrops, describeGain, inventoryCounts } from '../src/drops.js';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';

type Drop = { id: number; name: string; position: Vec3; isValid: boolean };

// A bot whose pathfinder "walks" by teleporting next to the goal; a drop within 1.3 blocks is picked up.
function fakeBot (drops: Drop[], items: { name: string; count: number }[]) {
  const entities: Record<number, Drop> = Object.fromEntries(drops.map(d => [d.id, d]));
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities,
    inventory: { items: () => items },
    pathfinder: {
      setGoal: sinon.stub(),
      goto: sinon.stub().callsFake(async (goal: { x: number; y: number; z: number }) => {
        bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        for (const d of Object.values(entities)) {
          if (d.position.distanceTo(bot.entity.position) <= 1.3) {
            d.isValid = false;
            delete entities[d.id];
            const stack = items.find(i => i.name === 'cobblestone');
            if (stack) stack.count++; else items.push({ name: 'cobblestone', count: 1 });
          }
        }
      })
    }
  };
  return bot;
}

test('collectDrops walks to drops at and below the broken block and ignores others', async (t) => {
  const bot = fakeBot([
    { id: 1, name: 'item', position: new Vec3(5.4, 61, 5.6), isValid: true }, // fell 3 blocks
    { id: 2, name: 'item', position: new Vec3(20, 64, 20), isValid: true }, // someone else's
    { id: 3, name: 'zombie', position: new Vec3(5.5, 64, 5.5), isValid: true }
  ], []);
  await collectDrops(bot as unknown as mineflayer.Bot, new Vec3(5, 64, 5), { settleMs: 0, timeoutMs: 1000 });
  t.is(bot.pathfinder.goto.callCount, 1);
  t.truthy(bot.entities[2]);
  t.deepEqual(bot.inventory.items(), [{ name: 'cobblestone', count: 1 }]);
});

test('collectDrops gives up on an unreachable drop', async (t) => {
  const bot = fakeBot([{ id: 1, name: 'item', position: new Vec3(5.5, 64, 5.5), isValid: true }], []);
  bot.pathfinder.goto = sinon.stub().rejects(new Error('No path to the goal!'));
  await collectDrops(bot as unknown as mineflayer.Bot, new Vec3(5, 64, 5), { settleMs: 0, timeoutMs: 1000 });
  t.true(bot.pathfinder.setGoal.calledWith(null));
});

test('describeGain lists only what increased', (t) => {
  const before = new Map([['dirt', 3], ['stick', 2]]);
  const after = new Map([['dirt', 3], ['stick', 1], ['cobblestone', 2]]);
  t.is(describeGain(before, after), 'cobblestone x2');
  t.deepEqual([...inventoryCounts({ inventory: { items: () => [{ name: 'a', count: 2 }, { name: 'a', count: 3 }] } } as unknown as mineflayer.Bot)], [['a', 5]]);
});

test('dig-block reports what it picked up, and collect:false skips walking', async (t) => {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const items: { name: string; count: number }[] = [];
  const bot = {
    version: '1.21.8',
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    heldItem: null,
    inventory: { items: () => items },
    blockAt: () => ({ name: 'stone', position: new Vec3(1, 64, 0), harvestTools: undefined, digTime: () => 100 }),
    canDigBlock: () => true,
    canSeeBlock: () => true,
    equip: sinon.stub().resolves(),
    dig: sinon.stub().callsFake(async () => { items.push({ name: 'cobblestone', count: 1 }); }), // picked up by itself
    pathfinder: { goto: sinon.stub().resolves(), setGoal: sinon.stub() }
  };
  registerBlockTools(new ToolFactory(server, connection), () => bot as unknown as mineflayer.Bot);
  const dig = (server.tool as sinon.SinonStub).getCalls().find(c => c.args[0] === 'dig-block')!.args[3];
  t.regex((await dig({ x: 1, y: 64, z: 0 })).content[0].text, /Dug stone at \(1, 64, 0\).*\. Picked up cobblestone x1$/);
  items.length = 0;
  bot.dig = sinon.stub().resolves();
  t.regex((await dig({ x: 1, y: 64, z: 0, collect: false })).content[0].text, /Dug stone at \(1, 64, 0\)[^.]*$/);
});
