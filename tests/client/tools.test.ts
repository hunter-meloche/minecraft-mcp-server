import test from 'ava';
import sinon from 'sinon';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import nbt from 'prismarine-nbt';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolFactory } from '../../src/tool-factory.js';
import { MessageStore } from '../../src/message-store.js';
import { registerClientTools, mineflayerSlot, entityKind } from '../../src/client/tools.js';
import { mineflayerToolDefinitions } from '../../src/tools/register-all.js';
import type { BridgeClient } from '../../src/client/bridge-client.js';

const STATUS = {
  inWorld: true, username: 'Bot', screen: null, position: { x: 10.5, y: 64, z: -3.2 }, block: { x: 10, y: 64, z: -4 },
  health: 18, food: 17, saturation: 2.5, air: 20, underWater: false, inLava: false, dimension: 'overworld', gameMode: 'survival',
  difficulty: 'easy', timeOfDay: 11800, process: null, goal: null
};

function setup(responses: Record<string, unknown | ((p: Record<string, unknown>) => unknown)>) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) };
  const request = sinon.spy(async (method: string, params: Record<string, unknown> = {}) => {
    const r = responses[method];
    if (r === undefined) throw new Error(`unexpected bridge call ${method}`);
    return typeof r === 'function' ? (r as (p: Record<string, unknown>) => unknown)(params) : r;
  });
  const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-client-'));
  const store = new MessageStore();
  registerClientTools(new ToolFactory(server, connection), { request } as unknown as BridgeClient, store, { gameDir });
  const tools = (server.tool as sinon.SinonStub).getCalls();
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await tools.find(c => c.args[0] === name)!.args[3](args);
    return { text: r.content.map((c: { text: string }) => c.text).join('\n'), isError: !!r.isError };
  };
  return { run, request, gameDir, store, tools };
}

test('the client backend offers every mineflayer tool with the same schema, plus its own', (t) => {
  const { tools } = setup({});
  const client = new Map(tools.map(c => [c.args[0] as string, c.args]));
  for (const def of mineflayerToolDefinitions()) {
    const args = client.get(def.name);
    t.truthy(args, `missing ${def.name}`);
    t.is(args![1], def.description);
    t.deepEqual(Object.keys(args![2] as object), Object.keys(def.schema), def.name);
  }
  t.deepEqual([...client.keys()].filter(n => !mineflayerToolDefinitions().some(d => d.name === n)).sort(), ['build-structure', 'mine-blocks', 'stop']);
});

test('read tools answer in the mineflayer wording', async (t) => {
  const { run } = setup({
    status: STATUS,
    inventory: { items: [{ slot: 0, name: 'stone_pickaxe', count: 1 }, { slot: 12, name: 'oak_log', count: 5 }, { slot: 40, name: 'shield', count: 1 }], selectedSlot: 0, held: null },
    'world.findBlocks': { positions: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }] },
    'world.block': { loaded: true, name: 'oak_log', properties: { axis: 'y' } },
    'world.entities': { entities: [{ id: 1, name: 'cow', category: 'creature', position: { x: 1.5, y: 64, z: 2.5 }, distance: 3 }, { id: 2, name: 'zombie', category: 'monster', position: { x: -4.2, y: 64, z: 0 }, distance: 6 }] }
  });
  t.is((await run('get-position')).text, 'Current position: (10, 64, -4)');
  t.regex((await run('get-status')).text, /^Health 18\/20, food 17\/20, saturation 2.5\nTime of day 11800 \(day; night in 1.0 min\)\nDimension overworld, game mode survival, difficulty easy\nBackend: game client with Baritone \(idle\)$/);
  t.is((await run('list-inventory')).text, 'Found 3 items in inventory:\n\n- stone_pickaxe (x1) in slot 36\n- oak_log (x5) in slot 12\n- shield (x1) in slot 45\n');
  t.is((await run('find-item', { nameOrType: 'log' })).text, 'Found 5 oak_log in inventory (slot 12)');
  t.is((await run('find-blocks', { blockType: 'oak_log', count: 5 })).text, 'Found 2 oak_log block(s) within 16 blocks:\n1. (1, 2, 3)\n2. (4, 5, 6)');
  t.is((await run('get-block-info', { x: 1.7, y: 2, z: 3 })).text, 'Found oak_log[axis=y] at position (1, 2, 3)');
  t.is((await run('find-entity', { type: 'hostile' })).text, 'Found zombie at position (-5, 64, 0)');
  t.is((await run('find-entity', { type: 'cow' })).text, 'Found cow at position (1, 64, 2)');
});

test('a bot not yet in the world says so instead of failing oddly', async (t) => {
  const { run } = setup({ status: { inWorld: false, username: 'Bot', screen: 'LevelLoadingScreen' } });
  const r = await run('get-position');
  t.true(r.isError);
  t.regex(r.text, /not in a world yet \(screen: LevelLoadingScreen\)/);
});

test('move-to-position: arrival, and an honest failure with what Baritone said', async (t) => {
  const ok = setup({ goto: { arrived: true, reason: 'done', seconds: 36, baritone: [], at: { x: 9, y: 64, z: 9 }, distance: 0.5 } });
  t.is((await ok.run('move-to-position', { x: 9, y: 64, z: 9 })).text, 'Successfully moved to position near (9, 64, 9)');
  t.like(ok.request.firstCall.args[1], { x: 9, y: 64, z: 9, range: 1 });
  const stuck = setup({ goto: { arrived: false, reason: 'done', seconds: 19, baritone: ['Going to: GoalBlock{x=-677,y=59,z=-297}'], at: { x: -679, y: 61, z: -300 }, distance: 4.1 } });
  const r = await stuck.run('move-to-position', { x: -677, y: 59, z: -297 });
  t.true(r.isError);
  t.regex(r.text, /Could not reach \(-677, 59, -297\): no path found\. Stopped at \(-679, 61, -300\), 4.1 blocks away\. Baritone: Going to/);
});

test('mine-blocks reports what was gained', async (t) => {
  const { run, request } = setup({ mine: { reason: 'done', seconds: 33, baritone: ['Mining [acacia_log]', 'Have 14 valid items'], gained: { acacia_log: 8 } } });
  t.is((await run('mine-blocks', { block: 'acacia_log', count: 14 })).text, 'Mined for 33s: acacia_log x8. Baritone: Mining [acacia_log] | Have 14 valid items');
  t.like(request.firstCall.args[1], { block: 'acacia_log', count: 14 });
});

test('build-structure checks materials, writes the schematic, and builds it', async (t) => {
  const spec = { palette: { L: 'oak_log[axis=y]' }, layers: [['L.L'], ['L.L']] };
  const poor = setup({ status: STATUS, inventory: { items: [{ slot: 1, name: 'oak_log', count: 2 }], selectedSlot: 0, held: null } });
  const refused = await poor.run('build-structure', { x: 0, y: 64, z: 0, spec, name: 'posts' });
  t.true(refused.isError);
  t.regex(refused.text, /Missing: oak_log 2\/4/);

  const rich = setup({
    status: STATUS,
    inventory: { items: [{ slot: 1, name: 'oak_log', count: 9 }], selectedSlot: 0, held: null },
    build: { reason: 'done', seconds: 30, baritone: ['Done building'], used: { oak_log: 4 } }
  });
  const r = await rich.run('build-structure', { x: -706.4, y: 73, z: -336, spec, name: 'posts' });
  t.is(r.text, 'Built posts at (-707, 73, -336) in 30s. Used: oak_log x4. Baritone: Done building');
  const file = path.join(rich.gameDir, 'schematics', 'posts.schem');
  t.like(rich.request.lastCall.args[1], { file, x: -707, y: 73, z: -336 });
  const parsed = nbt.simplify((await nbt.parse(zlib.gunzipSync(fs.readFileSync(file)))).parsed) as Record<string, unknown>;
  t.like(parsed, { Width: 3, Height: 2, Length: 1 });
});

test('tools the client backend does not have yet say so', async (t) => {
  const { run } = setup({});
  const r = await run('dig-block', { x: 0, y: 0, z: 0 });
  t.true(r.isError);
  t.regex(r.text, /not available on the client backend yet/);
});

test('slot and entity helpers', (t) => {
  t.deepEqual([0, 8, 9, 35, 36, 39, 40].map(mineflayerSlot), [36, 44, 9, 35, 8, 5, 45]);
  t.deepEqual(entityKind('zombie'), { type: 'hostile', name: 'zombie' });
  t.deepEqual(entityKind('player'), { type: 'player', name: 'player' });
});
