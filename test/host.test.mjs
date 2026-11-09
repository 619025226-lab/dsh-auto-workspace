import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply } from '../lib/index.js';
import { clip, slugify } from '../lib/classifier.js';

/** Normalize the plugin's async work before assertions. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function userMessage(text, extra = []) {
  return {
    role: 'user',
    source: { kind: 'user', rpcId: 'rpc-1' },
    content: [{ type: 'text', text }, ...extra],
  };
}

function fakeContext({ workspaces = [], observations = {}, activity = [] } = {}) {
  const stateDir = join(tmpdir(), `dsh-auto-workspace-state-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const listeners = new Map();
  const routes = new Map();
  const effects = [];
  const archived = [];
  const unarchived = [];
  const created = [];
  const prompts = [];
  const agentCreates = [];
  const resumed = [];
  const attached = [];
  const observationsSeen = [];

  const makeEntity = (workspace) => ({
    sessionIds: [],
    async attachSession(sessionId) {
      this.sessionIds.push(sessionId);
      attached.push({ workspaceId: this.id, sessionId });
    },
    ...workspace,
  });
  const entities = workspaces.map(makeEntity);

  const registry = {
    list: () => entities,
    async create(dir, title) {
      const workspace = makeEntity({ id: `ws-${entities.length + 1}`, title, path: dir });
      entities.push(workspace);
      return workspace;
    },
    async archiveSession(sessionId) {
      archived.push(sessionId);
    },
    async unarchiveSession(sessionId) {
      unarchived.push(sessionId);
      const index = archived.indexOf(sessionId);
      if (index >= 0) archived.splice(index, 1);
    },
    get archivedSessionIds() {
      return archived;
    },
  };

  const agents = {
    async create(options) {
      agentCreates.push(options);
    },
    async resume(options) {
      resumed.push(options);
      const observation = observations[options.resumeSessionId];
      if (observation !== undefined && Array.isArray(observation.events)) {
        // Mimic the loop's interrupted-turn closers so the re-read is balanced.
        observation.events = [...observation.events, {
          type: 'turn/end',
          seq: observation.events.length,
          time: '2026-11-08T08:00:00.000Z',
          data: { turn: 1, reason: { kind: 'interrupted' } },
        }];
      }
    },
  };

  const sessionQuery = {
    async observeSession(sessionId) {
      const observation = observations[sessionId];
      if (observation === undefined) throw new Error(`no observation for ${sessionId}`);
      observationsSeen.push(sessionId);
      return {
        header: observation.header ?? { id: sessionId, cwd: '/tmp', origin: 'user' },
        events: observation.events ?? [],
        [Symbol.dispose]() {
          observation.disposed = true;
        },
      };
    },
  };

  const sessionController = {
    async create(request) {
      created.push(request);
      return { sessionId: `session-new-${created.length}` };
    },
    async prompt(request) {
      prompts.push(request);
      if (request.sessionId === 'session-failing') throw new Error('prompt refused');
    },
  };

  const server = {
    protocol: 'http:',
    port: 1234,
    register(route) {
      assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };

  const ctx = {
    workspaceRegistry: registry,
    sessionController,
    agents,
    sessionQuery,
    async waterfall(_name, payload, fallback) {
      if (typeof activity === 'function') {
        const result = activity(payload);
        if (Array.isArray(result) && result.length > 0) return result;
        return await fallback();
      }
      return activity.length > 0 ? activity : await fallback();
    },
    get(name) {
      return name === 'agentPresets' || name === 'llm' || name === 'agentDefaultModel' ? undefined : undefined;
    },
    on(name, listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => {};
    },
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      return () => {};
    },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer']);
      callback({ webServer: server, effect: ctx.effect });
      return () => {};
    },
    webServer: server,
  };
  return { ctx, listeners, routes, effects, archived, unarchived, created, prompts, entities, agentCreates, resumed, attached, observationsSeen, stateDir };
}

function fakeAgent(sessionId, cwd, priorMessages = []) {
  return {
    id: sessionId,
    session: {
      header: { id: sessionId, cwd, origin: 'user' },
      deriveMessages: () => priorMessages,
    },
  };
}

function preStep(routes, payload) {
  const listener = routes.listeners.get('agent/pre-step')[0];
  assert.equal(typeof listener, 'function');
  return listener(payload, async () => ({ kind: 'enter', messages: payload.messages }));
}

/** Let the fake browser half poll once, which arms filing. */
function pollClient(suite) {
  callRoute(suite, '/plugin/dsh-auto-workspace/events');
}

/** Call one registered HTTP route with fake Node request/response objects. */
function callRoute(routes, path, { method = 'GET', headers = {}, body, query = '' } = {}) {
  const route = routes.routes.get(path);
  assert.equal(route !== undefined, true, `route ${path} is registered`);
  const req = {
    method,
    url: `${path}${query}`,
    headers: { 'x-dsh-auto-workspace': '1', ...headers },
    on(event, handler) {
      if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body)));
      if (event === 'end') handler();
      return req;
    },
  };
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      res.status = status;
      res.headers = headers;
      return res;
    },
    end(text = '') {
      res.body = text;
      return res;
    },
  };
  route.handler(req, res);
  return res;
}

/** Call one asynchronous POST route and wait for its JSON reply. */
function callRouteAsync(suite, path, { method = 'POST', headers = {}, body } = {}) {
  const route = suite.routes.get(path);
  assert.equal(route !== undefined, true, `route ${path} is registered`);
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url: path,
      headers: { 'x-dsh-auto-workspace': '1', ...headers },
      destroy() {},
      on(event, handler) {
        if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body)));
        if (event === 'end') handler();
        return req;
      },
    };
    const res = {
      status: 0,
      writeHead(status) {
        res.status = status;
      },
      end(text) {
        try {
          resolve({ status: res.status, body: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      },
    };
    try {
      route.handler(req, res);
    } catch (error) {
      reject(error);
    }
  });
}

/** A balanced conversation the scan can copy. */
function conversationEvents(text, { preset, balanced = true } = {}) {
  const time = '2026-11-08T08:00:00.000Z';
  const events = [
    { type: 'turn/start', seq: 0, time, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time,
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    },
    ...(preset === undefined ? [] : [{ type: 'agent-preset/selected', seq: 2, time, data: { agentPreset: preset } }]),
    { type: 'turn/end', seq: preset === undefined ? 2 : 3, time, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  return balanced ? events : events.slice(0, -1);
}

test('files the first prompt into a new workspace and rejects the source step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-'));
  try {
    const suite = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir }],
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, archiveDelayMs: 20 });
    pollClient(suite);

    const agent = fakeAgent('session-old', oldDir);
    const message = userMessage('帮我用 Python 写一个爬虫脚本，再加个定时任务');
    const decision = await preStep(suite, { agent, step: 1, signal: new AbortController().signal, messages: [message] });

    assert.deepEqual(decision, { kind: 'reject' });
    assert.equal(suite.entities.length, 2);
    const created = suite.entities[1];
    assert.equal(created.title, '编程开发');
    assert.equal(created.path, join(root, '编程开发'));
    assert.deepEqual(suite.created, [{ workspaceId: created.id }]);
    assert.equal(suite.prompts.length, 1);
    assert.equal(suite.prompts[0].sessionId, 'session-new-1');
    assert.deepEqual(suite.prompts[0].content, message.content);

    await sleep(60);
    assert.deepEqual(suite.archived, ['session-old']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('stays put when the conversation is already in the matching workspace', async () => {
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const suite = fakeContext({
      workspaces: [{ id: 'ws-code', title: '编程开发', path: oldDir }],
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: tmpdir(), archiveDelayMs: 0 });
    pollClient(suite);

    const agent = fakeAgent('session-old', oldDir);
    const decision = await preStep(suite, {
      agent,
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage('帮我用 Python 写一个爬虫脚本')],
    });

    assert.equal(decision.kind, 'enter');
    assert.equal(suite.created.length, 0);
    assert.equal(suite.prompts.length, 0);
  } finally {
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('an unclassifiable message keeps the original decision', async () => {
  const oldDir = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-'));
  try {
    const suite = fakeContext({ workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir }] });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: tmpdir(), archiveDelayMs: 0 });
    pollClient(suite);

    const decision = await preStep(suite, {
      agent: fakeAgent('session-old', oldDir),
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage('今天随便聊聊，没什么主题')],
    });

    assert.equal(decision.kind, 'enter');
    assert.equal(suite.created.length, 0);
  } finally {
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('a failure while forwarding never swallows the prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-'));
  try {
    const suite = fakeContext({ workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir }] });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, archiveDelayMs: 0 });
    pollClient(suite);
    suite.ctx.sessionController.create = async (request) => {
      suite.created.push(request);
      return { sessionId: 'session-failing' };
    };

    const decision = await preStep(suite, {
      agent: fakeAgent('session-old', oldDir),
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage('帮我用 Python 写一个爬虫脚本')],
    });

    assert.equal(decision.kind, 'enter');
    assert.deepEqual(suite.archived, ['session-failing']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('conversations with prior human history are never filed', async () => {
  const oldDir = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-'));
  try {
    const suite = fakeContext({ workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir }] });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: tmpdir(), archiveDelayMs: 0 });
    pollClient(suite);

    const agent = fakeAgent('session-old', oldDir, [userMessage('earlier prompt')]);
    const decision = await preStep(suite, {
      agent,
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage('帮我用 Python 写一个爬虫脚本')],
    });

    assert.equal(decision.kind, 'enter');
    assert.equal(suite.created.length, 0);
  } finally {
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('onlyFromWorkspaces limits which workspaces are classified', async () => {
  const oldDir = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-'));
  try {
    const suite = fakeContext({ workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir }] });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', onlyFromWorkspaces: ['另一个工作区'], workspaceRoot: tmpdir(), archiveDelayMs: 0 });
    pollClient(suite);

    const decision = await preStep(suite, {
      agent: fakeAgent('session-old', oldDir),
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage('帮我用 Python 写一个爬虫脚本')],
    });

    assert.equal(decision.kind, 'enter');
    assert.equal(suite.created.length, 0);
  } finally {
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('dry run reports the decision without creating anything', async () => {
  const oldDir = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-'));
  try {
    const suite = fakeContext({ workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir }] });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', dryRun: true, workspaceRoot: tmpdir(), archiveDelayMs: 0 });
    pollClient(suite);

    const decision = await preStep(suite, {
      agent: fakeAgent('session-old', oldDir),
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage('帮我用 Python 写一个爬虫脚本')],
    });

    assert.equal(decision.kind, 'enter');
    assert.equal(suite.entities.length, 1);
    assert.equal(suite.created.length, 0);
  } finally {
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('a forwarded session is not classified again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-'));
  try {
    const suite = fakeContext({ workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir }] });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, archiveDelayMs: 0 });
    pollClient(suite);

    const first = await preStep(suite, {
      agent: fakeAgent('session-old', oldDir),
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage('帮我用 Python 写一个爬虫脚本')],
    });
    assert.equal(first.kind, 'reject');

    const targetDir = suite.entities[1].path;
    const second = await preStep(suite, {
      agent: fakeAgent('session-new-1', targetDir),
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage('帮我用 Python 写一个爬虫脚本')],
    });
    assert.equal(second.kind, 'enter');
    assert.equal(suite.prompts.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('filing waits for a live browser poll', async () => {
  const oldDir = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-'));
  try {
    const suite = fakeContext({ workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir }] });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: tmpdir(), archiveDelayMs: 0 });

    const decision = await preStep(suite, {
      agent: fakeAgent('session-old', oldDir),
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage('帮我用 Python 写一个爬虫脚本')],
    });

    assert.equal(decision.kind, 'enter');
    assert.equal(suite.created.length, 0);
  } finally {
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('the events and status endpoints expose filing history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-'));
  try {
    const suite = fakeContext({ workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir }] });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, archiveDelayMs: 0 });
    pollClient(suite);
    await preStep(suite, {
      agent: fakeAgent('session-old', oldDir),
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage('帮我用 Python 写一个爬虫脚本')],
    });

    const events = callRoute(suite, '/plugin/dsh-auto-workspace/events');
    assert.equal(events.status, 200);
    const payload = JSON.parse(events.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.lastSeq, 1);
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].fromSessionId, 'session-old');
    assert.equal(payload.events[0].toSessionId, 'session-new-1');

    const filtered = callRoute(suite, '/plugin/dsh-auto-workspace/events', { query: '?after=1' });
    assert.equal(JSON.parse(filtered.body).events.length, 0);

    const forbidden = callRoute(suite, '/plugin/dsh-auto-workspace/status', { headers: { 'x-dsh-auto-workspace': '0' } });
    assert.equal(forbidden.status, 403);

    const status = callRoute(suite, '/plugin/dsh-auto-workspace/status');
    const summary = JSON.parse(status.body);
    assert.equal(summary.enabled, true);
    assert.equal(summary.mode, 'heuristic');
    assert.equal(summary.counts.filed, 1);
    assert.equal(summary.workspaces.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('the classify endpoint answers without touching state', async () => {
  const suite = fakeContext({ workspaces: [{ id: 'ws-code', title: '编程开发', path: '/tmp/code' }] });
  apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic' });

  const response = await new Promise((resolve) => {
    const route = suite.routes.get('/plugin/dsh-auto-workspace/classify');
    const req = {
      method: 'POST',
      url: '/plugin/dsh-auto-workspace/classify',
      headers: { 'x-dsh-auto-workspace': '1' },
      on(event, handler) {
        if (event === 'data') handler(Buffer.from(JSON.stringify({ text: '帮我用 Python 写一个爬虫脚本' })));
        if (event === 'end') handler();
        return req;
      },
    };
    const res = {
      status: 0,
      writeHead(status) {
        res.status = status;
      },
      end(text) {
        resolve({ status: res.status, body: JSON.parse(text) });
      },
    };
    route.handler(req, res);
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.decision.target, 'existing');
  assert.equal(response.body.decision.workspaceId, 'ws-code');
  assert.equal(suite.created.length, 0);
});


test('scan previews existing conversations and apply copies them into a workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const events = conversationEvents('帮我用 Python 写一个爬虫脚本，定时抓取价格');
    const suite = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir, sessionIds: ['session-old'] }],
      observations: { 'session-old': { header: { id: 'session-old', cwd: oldDir, origin: 'user' }, events } },
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, scanLimit: 10 });
    pollClient(suite);

    const scan = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/scan', { body: {} });
    assert.equal(scan.status, 200);
    assert.equal(scan.body.ok, true);
    assert.equal(scan.body.counts.move, 1);
    const move = scan.body.items.find((item) => item.action === 'move');
    assert.equal(move.title, '帮我用 Python 写一个爬虫脚本，定时抓取价格');
    assert.equal(move.targetTitle, '编程开发');

    const applied = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/apply', {
      body: { sessionIds: [move.sessionId] },
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.moved.length, 1);
    assert.equal(applied.body.failed.length, 0);

    const created = suite.agentCreates[0];
    assert.equal(created.meta.cwd, join(root, '编程开发'));
    assert.equal(created.meta.isSeeded, true);
    assert.equal(created.inheritedEventCount, events.length);
    assert.equal(created.seed.length, events.length + 1);
    assert.equal(created.seed.at(-1).type, 'session/end-seed');
    assert.equal(created.seed.at(-1).data.inherited, true);
    assert.deepEqual(suite.archived, ['session-old']);
    assert.equal(suite.attached.length, 1);
    assert.equal(suite.attached[0].workspaceId, applied.body.moved[0].workspaceId);

    const eventsResponse = JSON.parse(callRoute(suite, '/plugin/dsh-auto-workspace/events').body);
    assert.equal(eventsResponse.events[0].reason, '现有对话重新归类');
    assert.equal(eventsResponse.events[0].fromSessionId, 'session-old');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('scan skips running, preset, and unfinished conversations', async () => {
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const suite = fakeContext({
      workspaces: [{
        id: 'ws-default',
        title: 'default-workspace',
        path: oldDir,
        sessionIds: ['session-running', 'session-preset', 'session-unfinished'],
      }],
      observations: {
        'session-running': { header: { id: 'session-running', cwd: oldDir, origin: 'user' }, events: conversationEvents('帮我写一个爬虫') },
        'session-preset': {
          header: { id: 'session-preset', cwd: oldDir, origin: 'user' },
          events: conversationEvents('帮我写一个爬虫', { preset: 'coder' }),
        },
        'session-unfinished': {
          header: { id: 'session-unfinished', cwd: oldDir, origin: 'user' },
          events: conversationEvents('帮我用 Python 写一个爬虫脚本', { balanced: false }),
        },
      },
      activity: (payload) => (payload.sessionId === 'session-running' ? [{ kind: 'turn', items: [] }] : []),
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: tmpdir(), scanLimit: 10 });
    pollClient(suite);

    const scan = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/scan', { body: {} });
    const byId = new Map(scan.body.items.map((item) => [item.sessionId, item]));
    assert.equal(byId.get('session-running').reason, '会话正在运行');
    assert.equal(byId.get('session-running').title, '帮我写一个爬虫');
    assert.match(byId.get('session-preset').reason, /agent preset/);
    assert.equal(byId.get('session-preset').title, '帮我写一个爬虫');
    assert.equal(byId.get('session-unfinished').action, 'repairable');
    assert.equal(byId.get('session-unfinished').reason, '最后一个回合未结束，归类时会先收尾');
    assert.equal(byId.get('session-unfinished').title, '帮我用 Python 写一个爬虫脚本');
    assert.equal(scan.body.counts.move, 1);
    assert.equal(scan.body.counts.repair, 1);

    const applied = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/apply', { body: { sessionIds: ['session-running'] } });
    assert.equal(applied.body.skipped.length, 1);
    assert.equal(suite.agentCreates.length, 0);
  } finally {
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('apply refuses when dryRun is on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const events = conversationEvents('帮我用 Python 写一个爬虫脚本');
    const suite = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir, sessionIds: ['session-old'] }],
      observations: { 'session-old': { header: { id: 'session-old', cwd: oldDir, origin: 'user' }, events } },
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', dryRun: true, workspaceRoot: root, scanLimit: 10 });
    pollClient(suite);
    const scan = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/scan', { body: {} });
    const move = scan.body.items.find((item) => item.action === 'move');
    const applied = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/apply', { body: { sessionIds: [move.sessionId] } });
    assert.equal(applied.status, 500);
    assert.match(applied.body.message, /dryRun/);
    assert.equal(suite.agentCreates.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});


test('manual move moves one conversation and restore undoes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  const targetDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-target-')));
  try {
    const events = conversationEvents('帮我写一个 Python 爬虫');
    const suite = fakeContext({
      workspaces: [
        { id: 'ws-default', title: 'default-workspace', path: oldDir, sessionIds: ['session-old'] },
        { id: 'ws-code', title: '编程开发', path: targetDir, sessionIds: [] },
      ],
      observations: { 'session-old': { header: { id: 'session-old', cwd: oldDir, origin: 'user' }, events } },
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, scanLimit: 10 });
    pollClient(suite);

    const moved = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/move', {
      body: { sessionId: 'session-old', workspaceId: 'ws-code' },
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.ok, true);
    assert.equal(moved.body.moved.fromSessionId, 'session-old');
    assert.equal(suite.archived.includes('session-old'), true);
    assert.equal(suite.agentCreates.length, 1);
    assert.equal(suite.agentCreates[0].meta.cwd, targetDir);

    const toId = moved.body.moved.toSessionId;
    const status = JSON.parse(callRoute(suite, '/plugin/dsh-auto-workspace/status').body);
    assert.equal(status.moves.length, 1);
    assert.equal(status.moves[0].toSessionId, toId);

    const restored = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/restore', {
      body: { sessionId: toId },
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.ok, true);
    assert.equal(suite.unarchived.includes('session-old'), true);
    assert.equal(suite.archived.includes(toId), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test('allowPreset lets the scan move agent-preset conversations', async () => {
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const events = conversationEvents('帮我写一个 Python 爬虫', { preset: 'coder' });
    const suite = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir, sessionIds: ['session-preset'] }],
      observations: { 'session-preset': { header: { id: 'session-preset', cwd: oldDir, origin: 'user' }, events } },
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: tmpdir(), scanLimit: 10, allowPreset: true });
    pollClient(suite);

    const scan = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/scan', { body: {} });
    const item = scan.body.items.find((entry) => entry.sessionId === 'session-preset');
    assert.equal(item.action, 'move');
    assert.equal(item.targetTitle, '编程开发');
  } finally {
    await rm(oldDir, { recursive: true, force: true });
  }
});
test('the events endpoint reports which client build is polling', async () => {
  const suite = fakeContext({ workspaces: [] });
  apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic' });

  const fresh = callRoute(suite, '/plugin/dsh-auto-workspace/events', { query: '?after=0&b=0.6.1' });
  assert.equal(JSON.parse(fresh.body).build, '0.6.1');
  let status = JSON.parse(callRoute(suite, '/plugin/dsh-auto-workspace/status').body);
  assert.equal(status.build, '0.6.1');
  assert.equal(status.clientBuild, '0.6.1');
  assert.equal(status.clientStale, false);
  assert.equal(typeof status.clientBuildAt, 'string');

  callRoute(suite, '/plugin/dsh-auto-workspace/events', { query: '?after=0' });
  status = JSON.parse(callRoute(suite, '/plugin/dsh-auto-workspace/status').body);
  assert.equal(status.clientBuild, 'unknown');
  assert.equal(status.clientStale, true);

  callRoute(suite, '/plugin/dsh-auto-workspace/events', { query: '?after=0&b=0.1.0' });
  status = JSON.parse(callRoute(suite, '/plugin/dsh-auto-workspace/status').body);
  assert.equal(status.clientBuild, '0.1.0');
  assert.equal(status.clientStale, true);
});


test('apply closes an interrupted turn before copying it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const events = conversationEvents('帮我用 Python 写一个爬虫脚本', { balanced: false });
    const suite = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir, sessionIds: ['session-old'] }],
      observations: { 'session-old': { header: { id: 'session-old', cwd: oldDir, origin: 'user' }, events } },
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, scanLimit: 10 });
    pollClient(suite);

    const scan = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/scan', { body: {} });
    const item = scan.body.items.find((entry) => entry.action === 'repairable');
    assert.equal(item.sessionId, 'session-old');

    const applied = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/apply', { body: { sessionIds: [item.sessionId] } });
    assert.equal(applied.body.moved.length, 1, JSON.stringify(applied.body));
    assert.equal(applied.body.failed.length, 0, JSON.stringify(applied.body));
    assert.equal(suite.resumed.length, 1);
    assert.equal(suite.resumed[0].resumeSessionId, 'session-old');
    const created = suite.agentCreates[0];
    assert.equal(created.inheritedEventCount, events.length + 1);
    assert.equal(created.seed.at(-2).type, 'turn/end');
    assert.equal(created.seed.at(-1).type, 'session/end-seed');
    assert.deepEqual(suite.archived, ['session-old']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('applying the same conversation twice never copies it twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const events = conversationEvents('帮我用 Python 写一个爬虫脚本');
    const suite = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir, sessionIds: ['session-old'] }],
      observations: { 'session-old': { header: { id: 'session-old', cwd: oldDir, origin: 'user' }, events } },
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, scanLimit: 10 });
    pollClient(suite);
    await callRouteAsync(suite, '/plugin/dsh-auto-workspace/scan', { body: {} });

    const first = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/apply', { body: { sessionIds: ['session-old'] } });
    assert.equal(first.body.moved.length, 1);
    const second = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/apply', { body: { sessionIds: ['session-old'] } });
    assert.equal(second.body.moved.length, 0);
    assert.equal(second.body.skipped[0].reason, '已经归档');
    assert.equal(suite.agentCreates.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});


test('manual move can create a workspace from a title', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const events = conversationEvents('帮我用 Python 写一个爬虫脚本');
    const suite = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir, sessionIds: ['session-old'] }],
      observations: { 'session-old': { header: { id: 'session-old', cwd: oldDir, origin: 'user' }, events } },
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, scanLimit: 10 });
    pollClient(suite);

    const moved = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/move', {
      body: { sessionId: 'session-old', workspaceTitle: 'Harness桌面版' },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.moved.workspaceTitle, 'Harness桌面版');
    const created = suite.entities.find((entity) => entity.title === 'Harness桌面版');
    assert.equal(created.path, join(root, 'Harness桌面版'));
    assert.deepEqual(suite.archived, ['session-old']);
    assert.equal(suite.agentCreates[0].meta.cwd, created.path);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});


test('the move ring survives a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const events = conversationEvents('帮我用 Python 写一个爬虫脚本');
    const first = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir, sessionIds: ['session-old'] }],
      observations: { 'session-old': { header: { id: 'session-old', cwd: oldDir, origin: 'user' }, events } },
    });
    apply(first.ctx, { stateDir: first.stateDir, mode: 'heuristic', workspaceRoot: root, scanLimit: 10 });
    pollClient(first);
    const moved = await callRouteAsync(first, '/plugin/dsh-auto-workspace/move', {
      body: { sessionId: 'session-old', workspaceTitle: 'Harness桌面版' },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const toSessionId = moved.body.moved.toSessionId;

    const stateFile = join(first.stateDir, 'state.json');
    for (let attempt = 0; attempt < 40 && !existsSync(stateFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(stateFile), true, 'state.json was written');

    // A fresh plugin instance (a restart) sees the persisted record.
    const second = fakeContext();
    apply(second.ctx, { stateDir: first.stateDir, mode: 'heuristic', workspaceRoot: root, scanLimit: 10 });
    const status = JSON.parse(callRoute(second, '/plugin/dsh-auto-workspace/status').body);
    assert.equal(status.moves.length, 1);
    assert.equal(status.moves[0].toSessionId, toSessionId);
    assert.equal(status.moves[0].workspaceTitle, 'Harness桌面版');
    assert.ok(Array.isArray(status.events) && status.events.length >= 1, 'events persisted');
    assert.equal(status.counts.movedExisting, 1, 'move counter persisted');
    assert.ok(status.counts.createdWorkspaces >= 1, 'workspace counter persisted');

    const restored = await callRouteAsync(second, '/plugin/dsh-auto-workspace/restore', { body: { sessionId: toSessionId } });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(second.archived, [toSessionId]);
    assert.deepEqual(second.unarchived, ['session-old']);
    const after = JSON.parse(callRoute(second, '/plugin/dsh-auto-workspace/status').body);
    assert.equal(after.moves.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});


test('a legacy moves.json is migrated into the durable state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const suite = fakeContext();
    await mkdir(suite.stateDir, { recursive: true });
    await writeFile(join(suite.stateDir, 'moves.json'), JSON.stringify({
      version: 1,
      moves: [{ fromSessionId: 'session-a', toSessionId: 'session-b', workspaceTitle: '旧工作区', kind: 'manual' }],
    }));
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, scanLimit: 10 });
    const status = JSON.parse(callRoute(suite, '/plugin/dsh-auto-workspace/status').body);
    assert.equal(status.moves.length, 1);
    assert.equal(status.moves[0].workspaceTitle, '旧工作区');
    for (let attempt = 0; attempt < 40 && !existsSync(join(suite.stateDir, 'state.json')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(join(suite.stateDir, 'state.json')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});


test('no matching workspace turns a substantive message into a new workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const suite = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir }],
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, scanLimit: 10, archiveDelayMs: 20 });
    pollClient(suite);

    const text = '这是第987号样本，用于验证自动建仓的兜底逻辑';
    const decision = await preStep(suite, {
      agent: fakeAgent('session-old', oldDir),
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage(text)],
    });
    assert.equal(decision.kind, 'reject');
    const created = suite.entities.find((entity) => entity.title !== 'default-workspace');
    assert.equal(created.title, clip(text, 20));
    assert.equal(created.path, join(root, slugify(clip(text, 20))));
    await sleep(60);
    assert.deepEqual(suite.archived, ['session-old']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('createOnNoMatch false keeps a no-match message where it is', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const suite = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir }],
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', createOnNoMatch: false, workspaceRoot: root, scanLimit: 10 });
    pollClient(suite);

    const decision = await preStep(suite, {
      agent: fakeAgent('session-old', oldDir),
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage('这是第987号样本，用于验证自动建仓的兜底逻辑')],
    });
    assert.equal(decision.kind, 'enter');
    assert.equal(suite.entities.length, 1);
    assert.equal(suite.created.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('a 7-character project message is below the noMatch threshold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const suite = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir }],
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, scanLimit: 10 });
    pollClient(suite);

    const decision = await preStep(suite, {
      agent: fakeAgent('session-old', oldDir),
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage('帮我弄一下这个')],
    });
    assert.equal(decision.kind, 'enter');
    assert.equal(suite.entities.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('an 8-character project message auto-creates a workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const suite = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir }],
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, scanLimit: 10, archiveDelayMs: 20 });
    pollClient(suite);

    const text = '帮我弄一下这个啊';
    const decision = await preStep(suite, {
      agent: fakeAgent('session-old', oldDir),
      step: 1,
      signal: new AbortController().signal,
      messages: [userMessage(text)],
    });
    assert.equal(decision.kind, 'reject');
    const created = suite.entities.find((entity) => entity.title !== 'default-workspace');
    assert.equal(created.title, clip(text, 20));
    assert.equal(created.path, join(root, slugify(clip(text, 20))));
    await sleep(60);
    assert.deepEqual(suite.archived, ['session-old']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});


test('scan creates a new workspace when no existing workspace fits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-root-'));
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const text = '帮我弄一下这个流程吧';
    const suite = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir, sessionIds: ['session-old'] }],
      observations: { 'session-old': { header: { id: 'session-old', cwd: oldDir, origin: 'user' }, events: conversationEvents(text) } },
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: root, scanLimit: 10 });
    pollClient(suite);

    const scan = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/scan', { body: {} });
    const item = scan.body.items.find((entry) => entry.sessionId === 'session-old');
    assert.equal(item.action, 'move');
    assert.equal(item.targetTitle, text);
    assert.equal(scan.body.counts.move, 1);

    const applied = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/apply', { body: { sessionIds: ['session-old'] } });
    assert.equal(applied.body.moved.length, 1, JSON.stringify(applied.body));
    const created = suite.entities.find((entity) => entity.title === text);
    assert.equal(created.path, join(root, slugify(text)));
    assert.deepEqual(suite.archived, ['session-old']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('scan keeps a vague chit-chat conversation as stay', async () => {
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  try {
    const suite = fakeContext({
      workspaces: [{ id: 'ws-default', title: 'default-workspace', path: oldDir, sessionIds: ['session-old'] }],
      observations: {
        'session-old': {
          header: { id: 'session-old', cwd: oldDir, origin: 'user' },
          events: conversationEvents('今天随便聊聊，没什么主题'),
        },
      },
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: tmpdir(), scanLimit: 10 });
    pollClient(suite);

    const scan = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/scan', { body: {} });
    assert.ok(Array.isArray(scan.body.items), JSON.stringify(scan.body));
    const item = scan.body.items.find((entry) => entry.sessionId === 'session-old');
    assert.equal(item.action, 'stay');
  } finally {
    await rm(oldDir, { recursive: true, force: true });
  }
});


test('the unarchive endpoint restores the scan workspace archives', async () => {
  const suite = fakeContext({
    workspaces: [{
      id: 'ws-default',
      title: 'default-workspace',
      path: '/tmp/code',
      sessionIds: ['session-a', 'session-b'],
    }],
  });
  apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic' });
  await suite.ctx.workspaceRegistry.archiveSession('session-a');
  await suite.ctx.workspaceRegistry.archiveSession('session-b');

  const restored = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/unarchive', { body: {} });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual(restored.body.restored.sort(), ['session-a', 'session-b']);
  assert.deepEqual(suite.unarchived.sort(), ['session-a', 'session-b']);
  assert.deepEqual(suite.archived, []);
});


test('scan skips a conversation whose copy already exists in the target workspace', async () => {
  const oldDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-old-')));
  const targetDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-workspace-target-')));
  try {
    const text = '帮我用 Python 写一个爬虫脚本';
    const suite = fakeContext({
      workspaces: [
        { id: 'ws-default', title: 'default-workspace', path: oldDir, sessionIds: ['session-old'] },
        { id: 'ws-code', title: '编程开发', path: targetDir, sessionIds: ['session-copy'] },
      ],
      observations: {
        'session-old': { header: { id: 'session-old', cwd: oldDir, origin: 'user' }, events: conversationEvents(text) },
        'session-copy': { header: { id: 'session-copy', cwd: targetDir, origin: 'user' }, events: conversationEvents(text) },
      },
    });
    apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic', workspaceRoot: tmpdir(), scanLimit: 10 });
    pollClient(suite);

    const scan = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/scan', { body: {} });
    assert.ok(Array.isArray(scan.body.items), JSON.stringify(scan.body));
    const item = scan.body.items.find((entry) => entry.sessionId === 'session-old');
    assert.equal(item.action, 'stay');
    assert.equal(item.reason, '目标工作区已有相同对话（副本）');
  } finally {
    await rm(oldDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});


test('the archive endpoint hides visible sessions of the scan workspace', async () => {
  const suite = fakeContext({
    workspaces: [{
      id: 'ws-default',
      title: 'default-workspace',
      path: '/tmp/code',
      sessionIds: ['session-a', 'session-b'],
    }],
  });
  apply(suite.ctx, { stateDir: suite.stateDir, mode: 'heuristic' });

  const archived = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/archive', { body: { sessionIds: ['session-a'] } });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.archived, ['session-a']);
  assert.deepEqual(suite.archived, ['session-a']);

  const all = await callRouteAsync(suite, '/plugin/dsh-auto-workspace/archive', { body: {} });
  assert.deepEqual(all.body.archived, ['session-b']);
  assert.deepEqual(suite.archived.sort(), ['session-a', 'session-b']);
});
