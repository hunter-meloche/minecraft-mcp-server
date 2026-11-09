import test from 'ava';
import { COOLDOWN_MS, cooldown, isStatusQuery, statusAnswer } from '../../src/client/brain/chatstatus.js';

test('"claudebot status" in any case or punctuation is a question; other chat is not', (t) => {
  for (const m of ['claudebot status', 'Claudebot status?', 'CLAUDEBOT STATUS!', '  claudebot,  status ', '@claudebot status', 'claudebot: status.']) {
    t.true(isStatusQuery(m, 'claudebot'), m);
  }
  for (const m of ['status', 'claudebot', 'claudebot status please do the thing', 'what is claudebot status', 'otherbot status', 'claudebotstatus']) {
    t.false(isStatusQuery(m, 'claudebot'), m);
  }
});

test('the answer: what it does, how it is, what it builds, in one chat line', (t) => {
  const a = statusAnswer({ line: 'Autopilot: project - an enchanting room: mine 4 obsidian', health: 19.6, food: 18, project: 'an enchanting room', done: 11 });
  t.is(a, 'project - an enchanting room: mine 4 obsidian | health 20/20, food 18/20 | building: an enchanting room (11 projects done)');
  t.is(statusAnswer({ line: 'Autopilot: asleep' }), 'asleep');
  t.regex(statusAnswer({ line: 'Autopilot paused: LLM in control (dig-block), back in 4 min' }), /^paused while Claude drives/);
  t.true(statusAnswer({ line: `Autopilot: ${'x'.repeat(400)}` }).length <= 240);
});

test('one answer per cooldown, however many ask', (t) => {
  let now = 0;
  const allowed = cooldown(() => now);
  t.true(allowed());
  t.false(allowed());
  now += COOLDOWN_MS - 1;
  t.false(allowed());
  now += 1;
  t.true(allowed());
});
