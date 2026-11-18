import test from 'ava';
import sinon from 'sinon';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolFactory } from '../../src/tool-factory.js';
import { MessageStore } from '../../src/message-store.js';
import { brainRun, registerClientTools } from '../../src/client/tools.js';
import type { BridgeClient } from '../../src/client/bridge-client.js';

// The rails home's tools (P5e: lay-rail, take-up-rail, place-minecart) over a fake bridge: what they ask the bridge's
// rail.place / rail.torch / cart.place, the careful walk into reach, and the protection: a laid block is the bot's own
// (with its state, sent to the client mod before the next rail: rail.place turns only the bot's own rails), a block taken
// up is no more, and nothing is taken up that the bot did not lay.

const STATUS = {
  inWorld: true, username: 'Bot', screen: null, position: { x: 0.5, y: 64, z: 3.5 }, block: { x: 0, y: 64, z: 3 },
  health: 20, food: 20, dimension: 'overworld', gameMode: 'survival', timeOfDay: 2000, process: null, goal: null
};

function setup(given: Record<string, unknown | ((p: Record<string, unknown>) => unknown)>) {
  const responses: Record<string, unknown> = { status: STATUS, 'protect.set': {}, ...given };
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) };
  const request = sinon.spy(async (method: string, params: Record<string, unknown> = {}) => {
    const r = responses[method];
    if (r === undefined) throw new Error(`unexpected bridge call ${method}`);
    return typeof r === 'function' ? (r as (p: Record<string, unknown>) => unknown)(params) : r;
  });
  const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rails-'));
  const rt = registerClientTools(new ToolFactory(server, connection), { request } as unknown as BridgeClient, new MessageStore(), { gameDir });
  const tools = (server.tool as sinon.SinonStub).getCalls();
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await tools.find(c => c.args[0] === name)!.args[3](args);
    return { text: r.content.map((c: { text: string }) => c.text).join('\n'), isError: !!r.isError };
  };
  const calls = (m: string) => request.getCalls().filter(c => c.args[0] === m).map(c => c.args[1] as Record<string, unknown>);
  const order = () => request.getCalls().map(c => c.args[0] as string).filter(m => m !== 'status' && m !== 'protect.set');
  return { run, request, rt, calls, order };
}

const railBlock = (shape: string) => ({ loaded: true, name: 'rail', properties: { shape, waterlogged: 'false' } });

test('lay-rail asks rail.place with the plan\'s shape, the rail before and the cell after, and the rail is the bot\'s own from then (state and all, sent to the mod)', async (t) => {
  const { run, rt, calls } = setup({
    'rail.place': { ok: true, placed: true, block: 'rail', shape: 'east_west', predicted: 'east_west', once: 'east_west', turned: [{ x: 0, y: 64, z: 0, from: null, to: 'east_west' }] },
    'world.block': railBlock('east_west')
  });
  const r = await run('lay-rail', { x: 0, y: 64, z: 0, item: 'rail', shape: 'east_west', next: { x: 1, y: 64, z: 0 } });
  t.false(r.isError);
  t.is(r.text, 'Laid rail [east_west] at (0, 64, 0)');
  t.deepEqual(calls('rail.place')[0], { x: 0, y: 64, z: 0, item: 'rail', shape: 'east_west', next: { x: 1, y: 64, z: 0, item: 'rail' } });
  t.deepEqual(rt.builtNear({ x: 0, y: 64, z: 0 }, 1), [{ at: { x: 0, y: 64, z: 0 }, state: 'rail[shape=east_west,waterlogged=false]' }]);
  // the mod has it before the next rail (a status read after the lay sends the new list)
  const sets = calls('protect.set');
  t.deepEqual(sets.at(-1), { positions: [[0, 64, 0]], dimension: 'overworld' });
});

test('the rail before, turned to its curve by the new one, keeps the state it stands in now', async (t) => {
  let shapeAt0 = 'north_south';
  const { run, rt } = setup({
    'rail.place': (p: Record<string, unknown>) => {
      if (p.x === 0) return { ok: true, placed: true, block: 'rail', shape: 'north_south', predicted: 'north_south', once: 'north_east', turned: [{ x: 0, y: 64, z: 0, from: null, to: 'north_south' }] };
      shapeAt0 = 'north_east';
      return { ok: true, placed: true, block: 'rail', shape: 'east_west', predicted: 'east_west', once: 'east_west', turned: [{ x: 1, y: 64, z: 0, from: null, to: 'east_west' }, { x: 0, y: 64, z: 0, from: 'north_south', to: 'north_east' }] };
    },
    'world.block': (p: Record<string, number>) => railBlock(p.x === 0 ? shapeAt0 : 'east_west')
  });
  await run('lay-rail', { x: 0, y: 64, z: 0, item: 'rail', shape: 'north_east', prev: { x: 0, y: 64, z: -1, shape: 'north_south' }, next: { x: 1, y: 64, z: 0 } });
  const r = await run('lay-rail', { x: 1, y: 64, z: 0, item: 'rail', shape: 'east_west', prev: { x: 0, y: 64, z: 0, shape: 'north_east' }, next: { x: 2, y: 64, z: 0 } });
  t.is(r.text, 'Laid rail [east_west] at (1, 64, 0); the rail at (0, 64, 0) now north_east');
  t.deepEqual(rt.builtNear({ x: 0, y: 64, z: 0 }, 1).find(b => b.at.x === 0)?.state, 'rail[shape=north_east,waterlogged=false]');
});

test('lay-rail walks carefully into reach when too far, and protects nothing it did not lay', async (t) => {
  let tries = 0;
  const { run, rt, order, calls } = setup({
    'rail.place': () => (tries++ === 0 ? { ok: false, placed: false, reason: 'too far (6.2)' } : { ok: false, placed: false, reason: 'the rail before at 0, 64, -1 would be north_east, not north_south', predicted: 'east_west' }),
    goto: { arrived: true, reason: 'done', seconds: 2, baritone: [], at: { x: 0, y: 64, z: 2 } }
  });
  const r = await run('lay-rail', { x: 0, y: 64, z: 0, item: 'rail', prev: { x: 0, y: 64, z: -1, shape: 'north_south' } });
  t.true(r.isError);
  t.is(r.text, 'Failed: Not laid: rail at (0, 64, 0): the rail before at 0, 64, -1 would be north_east, not north_south');
  t.deepEqual(order(), ['rail.place', 'goto', 'rail.place']);
  t.like(calls('goto')[0], { x: 0, y: 64, z: 0, range: 2, careful: true });
  t.deepEqual(rt.builtNear({ x: 0, y: 64, z: 0 }, 2), []);
});

test('a rail the server put down otherwise than looked is reported, and still the bot\'s (it is there: the take-up must find it)', async (t) => {
  const { run, rt } = setup({
    'rail.place': { ok: false, placed: true, block: 'rail', shape: 'north_south', predicted: 'east_west', reason: 'it came out north_south, not east_west as looked' },
    'world.block': railBlock('north_south')
  });
  const r = await run('lay-rail', { x: 0, y: 64, z: 0, item: 'rail', shape: 'east_west' });
  t.true(r.isError);
  t.is(r.text, 'Failed: Laid, but not as asked: rail at (0, 64, 0): it came out north_south, not east_west as looked');
  t.is(rt.builtNear({ x: 0, y: 64, z: 0 }, 1).length, 1);
});

test('a dry run only looks: nothing put down, nothing protected', async (t) => {
  const { run, rt, calls } = setup({
    'rail.place': { ok: true, placed: false, dryRun: true, predicted: 'east_west', once: 'ascending_east', turned: [] }
  });
  const r = await run('lay-rail', { x: 0, y: 64, z: 0, item: 'powered_rail', shape: 'ascending_east', next: { x: 1, y: 65, z: 0, item: 'powered_rail' }, dryRun: true });
  t.is(r.text, 'Would lay powered_rail at (0, 64, 0): east_west now, ascending_east once the next rail is down');
  t.like(calls('rail.place')[0], { item: 'powered_rail', dryRun: true, next: { x: 1, y: 65, z: 0, item: 'powered_rail' } });
  t.deepEqual(rt.builtNear({ x: 0, y: 64, z: 0 }, 2), []);
});

test('a torch goes by rail.torch with the rail it lights, and says whether that rail is lit; the stop by place', async (t) => {
  const { run, rt, calls } = setup({
    'rail.torch': { ok: true, placed: true, block: 'redstone_torch', lit: true, lights: { x: 0, y: 64, z: 0, block: 'powered_rail', shape: 'east_west', powered: true } },
    'world.block': { loaded: true, name: 'redstone_torch', properties: { lit: 'true' } },
    'item.select': { held: 0 },
    place: { placed: true, block: 'cobblestone', face: 'down' }
  });
  t.is((await run('lay-rail', { x: 0, y: 64, z: 1, item: 'redstone_torch', lights: { x: 0, y: 64, z: 0 }, inVillage: true })).text, 'Put a redstone torch at (0, 64, 1): the rail at (0, 64, 0) is lit');
  t.deepEqual(calls('rail.torch')[0], { x: 0, y: 64, z: 1, inVillage: true, lights: { x: 0, y: 64, z: 0 } });
  t.is((await run('lay-rail', { x: -1, y: 64, z: 0, item: 'cobblestone' })).text, 'Put the stop (cobblestone) at (-1, 64, 0)');
  t.like(calls('place')[0], { x: -1, y: 64, z: 0, face: 'down' });
  t.is(rt.builtNear({ x: 0, y: 64, z: 0 }, 2).length, 2);
});

test('a torch whose rail stays unlit is no success', async (t) => {
  const { run } = setup({
    'rail.torch': { ok: false, placed: true, block: 'redstone_torch', reason: 'the rail at 0, 64, 0 is not lit', lights: { x: 0, y: 64, z: 0, block: 'powered_rail', powered: false } },
    'world.block': { loaded: true, name: 'redstone_torch', properties: { lit: 'true' } }
  });
  const r = await run('lay-rail', { x: 1, y: 64, z: 1, item: 'redstone_torch', lights: { x: 0, y: 64, z: 0 } });
  t.true(r.isError);
  t.regex(r.text, /not lit/);
});

test('take-up-rail takes up only a block of the line the bot laid, dug from where it stands, and forgets it', async (t) => {
  let there = 'rail';
  let rails = 0;
  const { run, rt, calls, order } = setup({
    'rail.place': { ok: true, placed: true, block: 'rail', shape: 'east_west', turned: [] },
    'world.block': (p: Record<string, number>) => (p.x === 5 ? { loaded: true, name: 'oak_planks', properties: {} } : p.x === 6 ? railBlock('north_south') : there === 'air' ? { loaded: true, name: 'air', properties: {} } : railBlock('east_west')),
    'dig.here': () => { there = 'air'; rails++; return { dug: true, block: 'rail', tool: null }; },
    inventory: () => ({ items: rails ? [{ slot: 3, name: 'rail', count: rails }] : [], selectedSlot: 0, held: null }),
    goto: { arrived: true, reason: 'done', seconds: 1, baritone: [], at: { x: 0, y: 64, z: 0 } }
  });
  await run('lay-rail', { x: 0, y: 64, z: 0, item: 'rail' });
  t.is(rt.builtNear({ x: 0, y: 64, z: 0 }, 1).length, 1);
  // someone's planks, and a rail the bot never laid: left alone
  const planks = await run('take-up-rail', { x: 5, y: 64, z: 0 });
  t.true(planks.isError);
  t.regex(planks.text, /not a block of the line: oak_planks/);
  const theirs = await run('take-up-rail', { x: 6, y: 64, z: 0 });
  t.true(theirs.isError);
  t.regex(theirs.text, /the bot did not put that rail there/);
  t.is(calls('dig.here').length, 0);
  // its own: dug from where it stands, the drop walked onto carefully, protected no more
  const r = await run('take-up-rail', { x: 0, y: 64, z: 0 });
  t.is(r.text, 'Took up the rail at (0, 64, 0)');
  t.deepEqual(calls('dig.here')[0], { x: 0, y: 64, z: 0, timeoutMs: 15_000 });
  t.like(calls('goto').at(-1), { x: 0, y: 64, z: 0, range: 0, careful: true });
  t.deepEqual(rt.builtNear({ x: 0, y: 64, z: 0 }, 1), []);
  t.false(order().includes('dig'));
  // gone already: nothing to dig
  t.is((await run('take-up-rail', { x: 0, y: 64, z: 0 })).text, 'Nothing to take up at (0, 64, 0) (nothing there)');
});

test('take-up-rail steps carefully into reach when the dig cannot see the block', async (t) => {
  let digs = 0;
  const { rt } = setup({
    'rail.place': { ok: true, placed: true, block: 'powered_rail', shape: 'east_west', turned: [] },
    'world.block': () => (digs > 1 ? { loaded: true, name: 'air', properties: {} } : { loaded: true, name: 'powered_rail', properties: { powered: 'false', shape: 'east_west', waterlogged: 'false' } }),
    'dig.here': () => (++digs === 1 ? { dug: false, reason: 'out of reach or out of sight', block: 'powered_rail' } : { dug: true, block: 'powered_rail' }),
    inventory: () => ({ items: digs > 1 ? [{ slot: 3, name: 'powered_rail', count: 1 }] : [], selectedSlot: 0, held: null }),
    goto: { arrived: true, reason: 'done', seconds: 1, baritone: [], at: { x: 0, y: 64, z: 0 } }
  });
  await rt.rails!.lay({ at: { x: 8, y: 64, z: 0 }, item: 'powered_rail' });
  const r = await rt.rails!.takeUp({ x: 8, y: 64, z: 0 });
  t.deepEqual(r, { ok: true, dug: true, block: 'powered_rail', pickedUp: true });
  t.is(digs, 2);
});

test('place-minecart puts the cart on the rail (walking carefully into reach first) and says the cart\'s id and uuid', async (t) => {
  let tries = 0;
  const { run, calls } = setup({
    'cart.place': () => (tries++ === 0 ? { ok: false, reason: 'too far (5.1)' } : { ok: true, id: 412, uuid: 'c0ffee', position: { x: 0.5, y: 64.06, z: 0.5 }, passengers: [], newMovement: false }),
    goto: { arrived: true, reason: 'done', seconds: 1, baritone: [], at: { x: 0, y: 64, z: 2 } }
  });
  const r = await run('place-minecart', { x: 0, y: 64, z: 0, inVillage: true });
  t.is(r.text, 'Put a minecart (412, uuid c0ffee) on the rail at (0, 64, 0)');
  t.deepEqual(calls('cart.place')[1], { x: 0, y: 64, z: 0, inVillage: true });
  t.like(calls('goto')[0], { careful: true, range: 2 });
  const refused = setup({ 'cart.place': { ok: false, newMovement: true, reason: 'the server runs the minecart_improvements experiment: ...' } });
  const n = await refused.run('place-minecart', { x: 0, y: 64, z: 0 });
  t.true(n.isError);
  t.regex(n.text, /minecart_improvements/);
});

test('a lay whose reply was lost (the call timed out) is read: the rail there after all is the bot\'s own, laid as asked when the rail before ends as asked; one not there is not laid', async (t) => {
  let down = false;
  const { rt } = setup({
    'rail.place': () => { down = true; throw new Error('bridge call rail.place timed out'); },
    'world.block': (p: Record<string, number>) => (p.z === -1 ? railBlock('north_south') : down ? railBlock('north_south') : { loaded: true, name: 'air', properties: {} })
  });
  const r = await rt.rails!.lay({ at: { x: 0, y: 64, z: 0 }, item: 'rail', shape: 'north_south', prev: { x: 0, y: 64, z: -1, shape: 'north_south' }, next: { x: 0, y: 64, z: 1 } });
  t.like(r, { ok: true, placed: true, block: 'rail', shape: 'north_south' });
  t.regex(r.reason!, /^the reply was lost \(bridge call rail.place timed out\); read down after$/);
  t.deepEqual(rt.builtNear({ x: 0, y: 64, z: 0 }, 0), [{ at: { x: 0, y: 64, z: 0 }, state: 'rail[shape=north_south,waterlogged=false]' }]);
  // the rail before turned otherwise: down, not as asked
  const turned = setup({
    'rail.place': () => { throw new Error('bridge call rail.place timed out'); },
    'world.block': (p: Record<string, number>) => railBlock(p.z === -1 ? 'north_east' : 'north_south')
  });
  t.like(await turned.rt.rails!.lay({ at: { x: 0, y: 64, z: 0 }, item: 'rail', prev: { x: 0, y: 64, z: -1, shape: 'north_south' }, next: { x: 0, y: 64, z: 1 } }), { ok: false, placed: true });
  // nothing there: not laid, nothing the bot's
  const none = setup({
    'rail.place': () => { throw new Error('bridge call rail.place timed out'); },
    'world.block': { loaded: true, name: 'air', properties: {} }
  });
  t.like(await none.rt.rails!.lay({ at: { x: 0, y: 64, z: 0 }, item: 'rail' }), { ok: false, placed: false, reason: 'bridge call rail.place timed out' });
  t.deepEqual(none.rt.builtNear({ x: 0, y: 64, z: 0 }, 1), []);
});

test('the hand swapped at the use (a calm-time eat under way): one more try after it, not a refusal of the rail', async (t) => {
  let tries = 0;
  const { rt, calls } = setup({
    'rail.place': () => (tries++ === 0 ? { ok: false, placed: false, reason: 'the hand holds bread at the use, not the rail' } : { ok: true, placed: true, block: 'rail', shape: 'north_south', turned: [] }),
    'world.block': railBlock('north_south')
  });
  const r = await rt.rails!.lay({ at: { x: 0, y: 64, z: 0 }, item: 'rail' });
  t.like(r, { ok: true, placed: true });
  t.is(calls('rail.place').length, 2);
});

test('a rail put down as the run is cut short (the answer in, every call after refused) is the bot\'s own all the same: the take-up takes it; one never sent is not', async (t) => {
  const abort = new AbortController();
  let down = false;
  const { rt } = setup({
    'rail.place': () => { down = true; abort.abort(); return { ok: true, placed: true, block: 'rail', shape: 'east_west', turned: [] }; },
    'world.block': () => (down ? railBlock('east_west') : { loaded: true, name: 'air', properties: {} }),
    'dig.here': () => { down = false; return { dug: true, block: 'rail' }; },
    inventory: () => ({ items: down ? [] : [{ slot: 3, name: 'rail', count: 1 }], selectedSlot: 0, held: null }),
    goto: { arrived: true, reason: 'done', seconds: 1, baritone: [], at: { x: 0, y: 64, z: 0 } }
  });
  const at = { x: 0, y: 64, z: 0 };
  const r = await brainRun.run({ signal: abort.signal }, () => rt.rails!.lay({ at, item: 'rail', shape: 'east_west' }));
  t.like(r, { ok: true, placed: true, block: 'rail' });
  t.deepEqual(rt.builtNear(at, 0), [{ at, state: 'rail' }]);
  t.like(await rt.rails!.takeUp(at), { ok: true, dug: true, block: 'rail' });
  t.false(down);
  // a lay asked after the cut: never sent, nothing the bot's there
  const later = await brainRun.run({ signal: abort.signal }, () => rt.rails!.lay({ at: { x: 3, y: 64, z: 0 }, item: 'rail' }));
  t.like(later, { ok: false, placed: false });
  t.deepEqual(rt.builtNear({ x: 3, y: 64, z: 0 }, 1), []);
});
