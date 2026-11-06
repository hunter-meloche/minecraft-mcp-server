import test from 'ava';
import { findLoop, LoopWatch, type Run } from '../../src/client/brain/loops.js';

const S = 1000;
const run = (goal: string, at: number, ms: number, outcome: Run['outcome'], text = ''): Run => ({ goal, reason: '', at, ms, outcome, text });

test('ping-pong: food stopped by retreat over and over (the doorstep loop)', (t) => {
  const runs: Run[] = [];
  for (let i = 0; i < 4; i++) {
    runs.push(run('retreat', i * 15 * S, 3 * S, 'done', 'home to heal'));
    runs.push(run('food', i * 15 * S + 5 * S, 5 * S, 'stopped', 'retreat is more urgent'));
  }
  const loop = findLoop(runs, 70 * S)!;
  t.is(loop.kind, 'ping-pong');
  t.is(loop.victim, 'food');
  t.is(loop.cycles, 4);
});

test('no loop: stock and stash taking turns, each getting its work done', (t) => {
  const runs: Run[] = [];
  for (let i = 0; i < 4; i++) {
    runs.push(run('stock', i * 400 * S, 300 * S, 'done', 'mined 40 cobblestone'));
    runs.push(run('stash', i * 400 * S + 310 * S, 30 * S, 'done', 'put 40 item(s) in the chests'));
  }
  t.is(findLoop(runs, 1700 * S), undefined);
});

test('spinning: the kit taking the same thing over and over', (t) => {
  const runs = [0, 1, 2, 3].map(i => run('kit', i * 40 * S, 25 * S, 'done', `took 1 diamond_pickaxe`));
  const loop = findLoop(runs, 200 * S)!;
  t.is(loop.kind, 'spinning');
  t.is(loop.victim, 'kit');
});

test('no loop: a goal repeating with different results, or long runs', (t) => {
  t.is(findLoop([0, 1, 2, 3].map(i => run('lights', i * 40 * S, 25 * S, 'done', ['placed 3', 'the yard is lit', 'placed 1 x', 'took back'][i])), 200 * S), undefined);
  t.is(findLoop([0, 1, 2, 3].map(i => run('project', i * 200 * S, 180 * S, 'done', 'leveling')), 900 * S), undefined);
});

test('LoopWatch reports a loop once per half hour', (t) => {
  const w = new LoopWatch();
  let found = 0;
  for (let i = 0; i < 10; i++) {
    const a = w.begin('retreat', '', i * 10 * S);
    if (w.end(a, 'done', 'home', i * 10 * S + 3 * S)) found++;
    const b = w.begin('food', '', i * 10 * S + 4 * S);
    if (w.end(b, 'stopped', 'retreat is more urgent', i * 10 * S + 9 * S)) found++;
  }
  t.is(found, 1);
});
