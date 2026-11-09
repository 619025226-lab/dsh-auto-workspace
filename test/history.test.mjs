import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCopySeed,
  conversationSignature,
  firstUserText,
  isBalanced,
  lastEvent,
  presetOfEvents,
  titleOfEvents,
} from '../lib/history.js';

const TIME = '2026-11-08T08:00:00.000Z';

const EVENTS = [
  { type: 'turn/start', seq: 0, time: TIME, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 1,
    time: TIME,
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我写一个爬虫' }] },
    surfaceOp: { op: 'append' },
  },
  { type: 'turn/end', seq: 2, time: TIME, data: { turn: 1, reason: { kind: 'completed' } } },
];

test('lastEvent and isBalanced inspect the tail', () => {
  assert.equal(lastEvent(EVENTS)?.type, 'turn/end');
  assert.equal(lastEvent([]), undefined);
  assert.equal(isBalanced(EVENTS), true);
  assert.equal(isBalanced(EVENTS.slice(0, 2)), false);
  assert.equal(isBalanced([]), false);
});

test('firstUserText ignores injected context messages', () => {
  const injected = {
    type: 'user/message',
    seq: 0,
    time: TIME,
    data: { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'time' }] },
  };
  assert.equal(firstUserText([injected, ...EVENTS]), '帮我写一个爬虫');
  assert.equal(firstUserText([injected]), '');
  assert.equal(firstUserText([]), '');
});

test('titleOfEvents folds the last title', () => {
  assert.equal(titleOfEvents([]), undefined);
  assert.equal(titleOfEvents([
    { type: 'session/title', seq: 0, time: TIME, data: { title: '旧标题' } },
    { type: 'session/title', seq: 1, time: TIME, data: { title: '新标题' } },
  ]), '新标题');
});

test('presetOfEvents reports the latest selection', () => {
  assert.equal(presetOfEvents([]), undefined);
  assert.equal(presetOfEvents([
    { type: 'agent-preset/selected', seq: 0, time: TIME, data: { agentPreset: 'coder' } },
  ]), 'coder');
});

test('buildCopySeed copies the log and appends the inherited marker', () => {
  const { seed, inheritedEventCount, boundary } = buildCopySeed(EVENTS);
  assert.equal(boundary, 2);
  assert.equal(inheritedEventCount, 3);
  assert.equal(seed.length, 4);
  assert.deepEqual(seed.slice(0, 3), EVENTS);
  assert.deepEqual(seed[3], {
    type: 'session/end-seed',
    seq: 3,
    time: TIME,
    data: { inherited: true },
  });
});

test('a trailing seed marker counts as balanced', () => {
  const seeded = [
    ...EVENTS,
    { type: 'session/end-seed', seq: 3, time: TIME, data: { inherited: true } },
  ];
  assert.equal(isBalanced(seeded), true);
  const copied = buildCopySeed(seeded);
  assert.equal(copied.inheritedEventCount, 4);
  assert.equal(copied.seed.at(-1).type, 'session/end-seed');
  assert.equal(copied.seed.at(-1).seq, 4);
});

test('buildCopySeed refuses empty and unbalanced logs', () => {
  assert.throws(() => buildCopySeed([]), /empty/);
  assert.throws(() => buildCopySeed(EVENTS.slice(0, 2)), /did not end/);
});


test('conversationSignature matches copies and ignores whitespace', () => {
  assert.equal(conversationSignature('修复ChatGPT问题', '你  帮我修一下'), conversationSignature(' 修复ChatGPT问题 ', '你 帮我修一下'));
  assert.equal(conversationSignature('', ''), undefined);
  assert.notEqual(conversationSignature('A', 'x'), conversationSignature('A', 'y'));
});
