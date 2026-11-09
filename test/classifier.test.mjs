import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_CONFIG,
  buildLlmPrompt,
  buildTitlePrompt,
  looksLikeProject,
  clip,
  extractJson,
  findWorkspace,
  firstUserMessage,
  heuristicCategory,
  heuristicDecision,
  isTrivial,
  normalizeConfig,
  parseDecision,
  resolveRoute,
  slugify,
  textOfContent,
} from '../lib/classifier.js';

const WORKSPACES = [
  { workspaceId: 'ws-1', title: '编程开发', path: '/tmp/code', sessionCount: 3 },
  { workspaceId: 'ws-2', title: '写作沟通', path: '/tmp/writing', sessionCount: 1 },
];

test('normalizeConfig keeps defaults and clamps numbers', () => {
  const { config, warnings } = normalizeConfig({});
  assert.deepEqual(warnings, []);
  assert.equal(config.enabled, true);
  assert.equal(config.mode, 'llm');
  assert.equal(config.timeoutMs, DEFAULT_CONFIG.timeoutMs);
  assert.equal(config.repairInterrupted, true);

  const { config: tuned } = normalizeConfig({
    mode: 'heuristic',
    timeoutMs: 999999,
    minConfidence: 2,
    maxTitleChars: 1,
    workspaceRoot: ' /tmp/root ',
    dryRun: true,
  });
  assert.equal(tuned.mode, 'heuristic');
  assert.equal(tuned.timeoutMs, 30000);
  assert.equal(tuned.minConfidence, 1);
  assert.equal(tuned.maxTitleChars, 4);
  assert.equal(tuned.workspaceRoot, '/tmp/root');
  assert.equal(tuned.dryRun, true);
});

test('normalizeConfig rejects unusable values with warnings', () => {
  const { config, warnings } = normalizeConfig({
    enabled: 'yes',
    mode: 'magic',
    timeoutMs: 'soon',
    model: { model: '' },
    categories: 'nope',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.mode, 'llm');
  assert.equal(config.timeoutMs, DEFAULT_CONFIG.timeoutMs);
  assert.equal(config.model, null);
  assert.deepEqual(config.categories, []);
  assert.equal(warnings.length, 5);
});

test('normalizeConfig reads onlyFromWorkspaces', () => {
  const { config } = normalizeConfig({ onlyFromWorkspaces: [' default-workspace ', '', 3] });
  assert.deepEqual(config.onlyFromWorkspaces, ['default-workspace']);
  const { warnings } = normalizeConfig({ onlyFromWorkspaces: 'default-workspace' });
  assert.equal(warnings.length, 1);
});

test('normalizeConfig validates model routes', () => {
  const { config } = normalizeConfig({ model: { provider: 'p', model: 'm', reasoningEffort: 'low' } });
  assert.deepEqual(config.model, { provider: 'p', model: 'm', reasoningEffort: 'low' });
  assert.deepEqual(resolveRoute(config, undefined), { provider: 'p', model: 'm', reasoningEffort: 'low' });
  assert.deepEqual(
    resolveRoute(normalizeConfig({}).config, { provider: 'd', model: 'f' }),
    { provider: 'd', model: 'f' },
  );
  assert.equal(resolveRoute(normalizeConfig({}).config, undefined), undefined);
});

test('isTrivial filters greetings and tiny messages', () => {
  assert.equal(isTrivial('', 6), true);
  assert.equal(isTrivial('你好', 6), true);
  assert.equal(isTrivial('谢谢！', 6), true);
  assert.equal(isTrivial('hello', 6), true);
  assert.equal(isTrivial('好', 6), true);
  assert.equal(isTrivial('帮我写一个 Python 爬虫脚本', 6), false);
});

test('slugify produces one safe directory segment', () => {
  assert.equal(slugify('Python 爬虫'), 'Python-爬虫');
  assert.equal(slugify('a/b:c*d?'), 'a-b-c-d');
  assert.equal(slugify('  --  '), 'workspace');
  assert.equal(slugify('前端 / UI 设计'), '前端-UI-设计');
});

test('textOfContent and firstUserMessage read durable content blocks', () => {
  assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'image', attachment: {} }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(textOfContent(undefined), '');
  const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] };
  const injected = { role: 'user', source: { kind: 'time-context' }, content: [] };
  assert.equal(firstUserMessage([injected, user]), user);
  assert.equal(firstUserMessage([injected]), undefined);
  assert.equal(firstUserMessage(undefined), undefined);
});

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('答案是 {"a":1} 谢谢'), { a: 1 });
  assert.equal(extractJson('没有 JSON'), null);
  assert.equal(extractJson(''), null);
});

test('findWorkspace prefers ids, then exact and loose titles', () => {
  assert.equal(findWorkspace(WORKSPACES, { workspaceId: 'ws-2' })?.workspaceId, 'ws-2');
  assert.equal(findWorkspace(WORKSPACES, { title: '编程开发' })?.workspaceId, 'ws-1');
  assert.equal(findWorkspace(WORKSPACES, { title: '编程' })?.workspaceId, 'ws-1');
  assert.equal(findWorkspace(WORKSPACES, { workspaceId: 'missing', title: '写作' })?.workspaceId, 'ws-2');
  assert.equal(findWorkspace(WORKSPACES, { workspaceId: 'missing', title: '不存在' }), undefined);
});

test('parseDecision accepts existing, new, and none', () => {
  const existing = parseDecision(JSON.stringify({
    target: 'existing', workspaceId: 'ws-1', confidence: 0.9, reason: '编程',
  }), { workspaces: WORKSPACES });
  assert.deepEqual(existing, {
    target: 'existing', workspaceId: 'ws-1', title: '编程开发', confidence: 0.9, reason: '编程',
  });

  const byTitle = parseDecision(JSON.stringify({ target: 'existing', title: '写作沟通', confidence: 0.8 }), { workspaces: WORKSPACES });
  assert.equal(byTitle.workspaceId, 'ws-2');

  const created = parseDecision(JSON.stringify({ target: 'new', title: '数据库迁移', confidence: 0.7 }), { workspaces: WORKSPACES });
  assert.equal(created.target, 'new');
  assert.equal(created.title, '数据库迁移');

  const none = parseDecision('{"target":"none","confidence":0.2}', { workspaces: WORKSPACES });
  assert.equal(none.target, 'none');
});

test('parseDecision degrades bad answers to none', () => {
  assert.equal(parseDecision('not json', { workspaces: WORKSPACES }), null);
  assert.equal(parseDecision('{"target":"existing","workspaceId":"nope","confidence":0.9}', { workspaces: WORKSPACES }).target, 'none');
  assert.equal(parseDecision('{"target":"new","title":"低置信度","confidence":0.2}', { workspaces: WORKSPACES }).target, 'none');
  assert.equal(parseDecision('{"target":"new","title":"","confidence":0.9}', { workspaces: WORKSPACES }).target, 'none');
  assert.equal(parseDecision('{"target":"weird","confidence":0.9}', { workspaces: WORKSPACES }).target, 'none');
});

test('parseDecision folds a near-duplicate new title into an existing workspace', () => {
  const merged = parseDecision(JSON.stringify({ target: 'new', title: '编程', confidence: 0.8 }), { workspaces: WORKSPACES });
  assert.equal(merged.target, 'existing');
  assert.equal(merged.workspaceId, 'ws-1');
  assert.equal(merged.title, '编程开发');

  const fresh = parseDecision(JSON.stringify({ target: 'new', title: '京都旅行', confidence: 0.8 }), { workspaces: WORKSPACES });
  assert.equal(fresh.target, 'new');
  assert.equal(fresh.title, '京都旅行');
});

test('parseDecision treats a missing confidence as acceptable', () => {
  const decision = parseDecision('{"target":"new","title":"运维","reason":"部署"}', { workspaces: WORKSPACES });
  assert.equal(decision.target, 'new');
  assert.equal(decision.confidence, 0.6);
});

test('heuristicCategory and heuristicDecision find unambiguous topics', () => {
  const code = heuristicCategory('帮我用 Python 写一个爬虫，顺便加个定时任务');
  assert.equal(code?.title, '编程开发');
  assert.equal(heuristicCategory('今天天气不错'), undefined);

  const decision = heuristicDecision('帮我用 Python 写一个爬虫脚本', { workspaces: WORKSPACES });
  assert.equal(decision.target, 'existing');
  assert.equal(decision.workspaceId, 'ws-1');

  const fresh = heuristicDecision('帮我用 Python 写一个爬虫脚本', { workspaces: [] });
  assert.equal(fresh.target, 'new');
  assert.equal(fresh.title, '编程开发');
  assert.ok(fresh.score >= 3);

  assert.equal(heuristicDecision('你好', { workspaces: WORKSPACES }), null);
  assert.equal(heuristicDecision('随便聊聊', { workspaces: WORKSPACES }), null);
});

test('heuristicDecision accepts extra keyword rules', () => {
  const decision = heuristicDecision('我想整理一下婚礼请柬和宾客名单', {
    workspaces: [],
    extraCategories: [{ title: '婚礼筹备', keywords: [/婚礼|请柬|宾客/] }],
  });
  assert.equal(decision.title, '婚礼筹备');
});

test('buildLlmPrompt lists workspaces and the message', () => {
  const prompt = buildLlmPrompt('帮我写一个爬虫', WORKSPACES, { maxInputChars: 100 });
  assert.match(prompt, /id=ws-1/);
  assert.match(prompt, /编程开发/);
  assert.match(prompt, /帮我写一个爬虫/);
  assert.match(prompt, /"target"/);
  const empty = buildLlmPrompt('hello', []);
  assert.match(empty, /还没有工作区/);
});

test('clip keeps short text and truncates long text', () => {
  assert.equal(clip('abc', 10), 'abc');
  assert.equal(clip('abcdef', 4), 'abc…');
});


test('buildTitlePrompt asks for a short workspace name', () => {
  const prompt = buildTitlePrompt('帮我写一个每天抓价格的爬虫', 100);
  assert.match(prompt, /工作区/);
  assert.match(prompt, /帮我写一个每天抓价格的爬虫/);
});

test('normalizeConfig reads createOnNoMatch and noMatchMinChars', () => {
  assert.equal(normalizeConfig({}).config.createOnNoMatch, true);
  assert.equal(normalizeConfig({}).config.noMatchMinChars, 8);
  assert.equal(normalizeConfig({ createOnNoMatch: false, noMatchMinChars: 20 }).config.noMatchMinChars, 20);
});


test('looksLikeProject separates briefs from chat and questions', () => {
  assert.equal(looksLikeProject('帮我写一个爬虫'), true);
  assert.equal(looksLikeProject('做一个每周自动汇总的报表工具'), true);
  assert.equal(looksLikeProject('这是第987号样本，用于验证自动建仓的兜底逻辑'), true);
  assert.equal(looksLikeProject('今天随便聊聊，没什么主题'), false);
  assert.equal(looksLikeProject('什么是 REST？'), false);
  assert.equal(looksLikeProject('看不太懂这是什么'), false);
});
