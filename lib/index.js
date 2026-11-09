/**
 * dsh-auto-workspace — Host half.
 *
 * Files each new conversation into a Workspace on the first prompt:
 *
 *  1. The first human message of a conversation is claimed for step 1.
 *  2. The classifier (the deployment model, or a local keyword table) picks an
 *     existing Workspace, a new one, or "stay".
 *  3. Because a Session's directory is fixed at creation, filing means
 *     creating the target Workspace's directory if needed, creating a fresh
 *     Session there, forwarding the exact user content, hiding the source
 *     Session and telling the browser half to reopen the target.
 *  4. The original step is rejected, so the model never runs twice.
 *
 * Nothing is moved when classification fails, when the target is the current
 * Workspace, or when the conversation already has human history. Those paths
 * fall through to the untouched decision, so a classifier outage can never
 * swallow a prompt.
 *
 * The module has no runtime dependencies beyond Node built-ins; it is loaded
 * from `$DSH_HOME/plugins` by the profile.
 */

import { readFileSync } from 'node:fs';
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  buildCopySeed,
  conversationSignature,
  firstUserText,
  isBalanced,
  presetOfEvents,
  titleOfEvents,
} from './history.js';
import {
  DEFAULT_CONFIG,
  buildLlmPrompt,
  buildTitlePrompt,
  clip,
  firstUserMessage,
  heuristicCategory,
  heuristicDecision,
  isTrivial,
  looksLikeProject,
  normalizeConfig,
  parseDecision,
  resolveRoute,
  slugify,
  textOfContent,
} from './classifier.js';

/** Cordis plugin name. */
export const name = 'auto-workspace';

/** Services required before the router can do anything. */
export const inject = ['agents', 'sessionController', 'sessionQuery', 'workspaceRegistry'];

/** Endpoint prefix owned by this plugin. */
const PREFIX = '/plugin/dsh-auto-workspace';

/**
 * Build marker shared with lib/client.js. The browser half sends it on every
 * poll, so `/status` can prove which client bundle a page is actually running:
 * a stale page reports "unknown" (no marker) or an older value.
 */
const BUILD = '0.6.1';

/** Header proving a same-origin request from the plugin's own browser half. */
const INTENT_HEADER = 'x-dsh-auto-workspace';

/** Ring sizes for the debugging surfaces. */
const MAX_EVENTS = 50;
const MAX_DECISIONS = 40;

const LOG = '[auto-workspace]';

/** One identity per Host boot, so a reconnected page can tell it restarted. */
const bootId = randomUUID();

/**
 * Combine cancellation sources without depending on AbortSignal.any.
 * @param {AbortSignal[]} signals
 */
function anySignal(signals) {
  const usable = signals.filter((signal) => signal !== undefined && signal !== null);
  if (usable.length === 0) return undefined;
  if (usable.length === 1) return usable[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(usable);
  const controller = new AbortController();
  for (const signal of usable) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** Resolve a path through symlinks; undefined when it does not exist. */
async function canonical(path) {
  if (typeof path !== 'string' || path.length === 0) return undefined;
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** Write one JSON response. */
function sendJSON(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Read a small JSON request body; resolves to {} for an empty body. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        const value = JSON.parse(text);
        resolve(value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch {
        reject(new Error('request body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Admit only the page this Host serves (same-origin, plugin header set). */
function admitted(req, ctx) {
  if (req.headers[INTENT_HEADER] !== '1') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const host = req.headers.host;
  if (host === undefined) return false;
  return origin === `${ctx.webServer.protocol}//${host}`;
}

/** Collect the text of one model stream answer. */
async function collectAnswer(stream) {
  let text = '';
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
    } else if (chunk.type === 'finish') {
      const reason = chunk.reason ?? {};
      if (reason.kind === 'error') {
        const failure = reason.failure ?? {};
        throw new Error(`${failure.code ?? 'LLM_ERROR'}: ${failure.message ?? 'model call failed'}`);
      }
      if (reason.kind === 'aborted') throw new Error('LLM_ABORTED: model call was aborted');
    }
  }
  return text;
}

/**
 * Register the plugin.
 * @param {object} ctx - Cordis context carrying workspaceRegistry and sessionController.
 * @param {object} [rawConfig] - the profile entry's config.
 */
export function apply(ctx, rawConfig = {}) {
  const { config, warnings } = normalizeConfig(rawConfig);
  for (const warning of warnings) console.warn(`${LOG} 配置：${warning}`);

  const workspaceRegistry = ctx.workspaceRegistry;
  const sessionController = ctx.sessionController;

  /** Ring of filing events the browser half polls. */
  const events = [];
  /** Ring of classification decisions (including skips) for /status. */
  const decisions = [];
  /** Ring of (from → to) move pairs for one-step undo, persisted below. */
  const moves = [];
  /** Durable location for plugin state; survives restarts and reinstalls. */
  const stateDir = config.stateDir ?? fileURLToPath(new URL('../state', import.meta.url));
  const stateFile = join(stateDir, 'state.json');
  const legacyMovesFile = join(stateDir, 'moves.json');
  const counts = { classified: 0, filed: 0, createdWorkspaces: 0, failed: 0, skipped: 0, scanned: 0, movedExisting: 0 };
  let seq = 0;
  /** Serialize durable writes so overlapping changes cannot interleave. */
  let persistChain = Promise.resolve();
  loadPersistedState();
  /** Sessions whose first prompt was already considered. */
  const handled = new Set();
  /** Sessions this plugin created and seeded; never classify them again. */
  const forwarded = new Set();
  /** Timers scheduled for archiving source conversations. */
  const timers = new Set();
  /** In-memory classification cache: text + workspace catalog → decision. */
  const classifyCache = new Map();

  /** Latest scan plan; applies must follow a recent scan. */
  let scanPlan = null;
  /** One apply at a time, even from two windows. */
  let applying = false;
  const PLAN_TTL_MS = 10 * 60 * 1000;
  let disposed = false;
  /** Last time the browser half polled; filing waits for a live page. */
  let lastClientPoll = 0;
  /** Build marker reported by the last polling page. */
  let lastClientBuild = null;
  let lastClientBuildAt = 0;
  let warnedStaleClient = false;
  const CLIENT_WINDOW_MS = 15000;

  ctx.effect(() => () => {
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }, 'auto-workspace: timers');

  /** Append one bounded record to a ring. */
  function push(ring, value, max) {
    ring.push(value);
    if (ring.length > max) ring.splice(0, ring.length - max);
  }

  /** Record one decision for /status. */
  function recordDecision(entry) {
    push(decisions, { at: new Date().toISOString(), ...entry }, MAX_DECISIONS);
  }

  /** Record one successful filing for the browser half. */
  function recordEvent(entry) {
    push(events, { seq: ++seq, at: new Date().toISOString(), ...entry }, MAX_EVENTS);
    persistState();
  }

  /** Record one (from → to) move pair the panel can undo. */
  function recordMove(entry) {
    push(moves, { at: new Date().toISOString(), ...entry }, 60);
    persistState();
  }

  /** Load durable state; legacy moves.json is migrated in place. */
  function loadPersistedState() {
    let parsed;
    let migrated = false;
    try {
      parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn(`${LOG} 读取状态失败：${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const legacy = JSON.parse(readFileSync(legacyMovesFile, 'utf8'));
        parsed = { moves: Array.isArray(legacy) ? legacy : legacy?.moves };
        migrated = true;
      } catch (legacyError) {
        if (legacyError?.code !== 'ENOENT') {
          console.warn(`${LOG} 读取旧搬迁记录失败：${legacyError instanceof Error ? legacyError.message : String(legacyError)}`);
        }
      }
    }
    if (parsed === undefined) return;
    const moveList = Array.isArray(parsed) ? parsed : parsed?.moves;
    if (Array.isArray(moveList)) {
      for (const entry of moveList) {
        if (entry === null || typeof entry !== 'object') continue;
        if (typeof entry.fromSessionId !== 'string' || typeof entry.toSessionId !== 'string') continue;
        moves.push(entry);
      }
      if (moves.length > 60) moves.splice(0, moves.length - 60);
    }
    if (Array.isArray(parsed?.events)) {
      for (const entry of parsed.events) {
        if (entry === null || typeof entry !== 'object') continue;
        if (typeof entry.fromSessionId !== 'string' || typeof entry.toSessionId !== 'string') continue;
        if (!Number.isInteger(entry.seq)) continue;
        events.push(entry);
        if (entry.seq > seq) seq = entry.seq;
      }
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    }
    if (parsed?.counts !== null && typeof parsed?.counts === 'object') {
      for (const key of Object.keys(counts)) {
        const value = parsed.counts[key];
        if (Number.isFinite(value) && value >= 0) counts[key] = value;
      }
    }
    if (Number.isInteger(parsed?.seq) && parsed.seq >= 0) seq = Math.max(seq, parsed.seq);
    if (moves.length > 0 || events.length > 0 || Object.values(counts).some((value) => value > 0)) {
      console.log(`${LOG} 已载入状态：${events.length} 条归类、${moves.length} 条搬迁`);
    }
    if (migrated) persistState();
  }

  /** Atomically write moves, recent filings, counters, and the event cursor. */
  function persistState() {
    const snapshot = {
      version: 2,
      seq,
      counts: { ...counts },
      events: events.map((entry) => ({ ...entry })),
      moves: moves.map((entry) => ({ ...entry })),
    };
    persistChain = persistChain.then(async () => {
      await mkdir(stateDir, { recursive: true });
      const temp = `${stateFile}.tmp`;
      await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await rename(temp, stateFile);
    }).catch((error) => {
      console.warn(`${LOG} 保存状态失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** The registered Workspaces in display order. */
  function workspaceSnapshot() {
    return workspaceRegistry.list().map((workspace) => ({
      workspaceId: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessionCount: workspace.sessionIds.length,
    }));
  }

  /** The Workspace a Session's recorded directory belongs to, if any. */
  async function currentWorkspaceOf(session) {
    const cwd = session?.header?.cwd;
    const resolved = await canonical(cwd);
    if (resolved === undefined) return undefined;
    return workspaceRegistry.list().find((workspace) => workspace.path === resolved);
  }

  /** Derive the directory that owns auto-created Workspaces. */
  function defaultWorkspaceRoot() {
    const list = workspaceRegistry.list();
    const fallback = list.find((workspace) => workspace.title === 'default-workspace'
      || basename(workspace.path) === 'default-workspace');
    if (fallback !== undefined) return dirname(fallback.path);
    return join(homedir(), 'Documents', 'deepseek-harness');
  }

  /** Allocate a fresh directory for a new Workspace. */
  async function allocateDirectory(root, title) {
    await mkdir(root, { recursive: true });
    const base = slugify(title);
    for (let index = 0; index < 100; index += 1) {
      const dir = join(root, index === 0 ? base : `${base}-${index + 1}`);
      try {
        await mkdir(dir);
        return dir;
      } catch (error) {
        // A taken name — a directory, a file, or a symlink — moves to the next
        // candidate; only unexpected filesystem failures propagate.
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    throw new Error(`cannot allocate a directory for workspace "${title}" under ${root}`);
  }

  /**
   * Resolve the target entity for one decision.
   * @param {object} decision - classifier answer.
   * @param {Array<object>} entities - live Workspace entities in display order.
   */
  async function resolveTargetWorkspace(decision, entities) {
    if (decision.target === 'existing') {
      return entities.find((workspace) => workspace.id === decision.workspaceId);
    }
    if (decision.target !== 'new') return undefined;
    if (!config.createWorkspace) return undefined;
    if (entities.length >= config.maxWorkspaces) {
      recordDecision({ action: 'skipped', reason: `工作区数量已达上限 ${config.maxWorkspaces}` });
      return undefined;
    }
    const existing = entities.find((workspace) => workspace.title.trim() === decision.title.trim());
    if (existing !== undefined) return existing;

    const root = config.workspaceRoot ?? defaultWorkspaceRoot();
    const dir = await allocateDirectory(root, decision.title);
    const workspace = await workspaceRegistry.create(dir, decision.title);
    counts.createdWorkspaces += 1;
    console.log(`${LOG} 新建工作区「${workspace.title}」→ ${workspace.path}`);
    return workspace;
  }

  /** A short workspace name derived from one message, when no workspace fits. */
  async function titleForNewWorkspace(text, signal) {
    // The model gives a specific name ("周报模板"); the keyword category
    // ("效率工具") is only a fallback.
    const llm = ctx.get('llm');
    if (config.mode === 'llm' && llm !== undefined && typeof llm.stream === 'function') {
      const defaultSelection = ctx.get('agentDefaultModel')?.currentSelection?.();
      const route = resolveRoute(config, defaultSelection);
      if (route !== undefined && route.provider !== undefined) {
        try {
          const answer = await collectAnswer(llm.stream({
            provider: route.provider,
            model: route.model,
            messages: [{ role: 'user', content: [{ type: 'text', text: buildTitlePrompt(text, config.maxInputChars) }] }],
            maxTokens: 2000,
            signal: anySignal([signal, AbortSignal.timeout(config.timeoutMs)]),
            ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
          }));
          const title = answer.trim().replace(/[\u201c\u201d\u2018\u2019"']/g, '').trim();
          if (title.length > 0) return clip(title, config.maxTitleChars);
        } catch (error) {
          console.warn(`${LOG} 生成工作区名失败，使用关键词/消息片段：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const category = heuristicCategory(text, config.categories);
    if (category !== undefined && category.title.length > 0) {
      return clip(category.title, config.maxTitleChars);
    }
    const snippet = text.replace(/\s+/g, ' ').trim();
    return clip(snippet, 20) || '未命名';
  }

  /** Ask the deployment model; returns undefined when it cannot answer. */
  async function classifyWithLlm(text, list, signal) {
    const llm = ctx.get('llm');
    if (llm === undefined || typeof llm.stream !== 'function') return undefined;
    const defaultSelection = ctx.get('agentDefaultModel')?.currentSelection?.();
    const route = resolveRoute(config, defaultSelection);
    if (route === undefined || route.provider === undefined) return undefined;
    const prompt = buildLlmPrompt(text, list, { maxInputChars: config.maxInputChars });
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const combined = anySignal([signal, timeout]);
    let answer = '';
    try {
      answer = await collectAnswer(llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 400,
        signal: combined,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      }));
    } catch (error) {
      if (signal?.aborted === true) throw error;
      console.warn(`${LOG} 模型分类失败，改用关键词：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    const parsed = parseDecision(answer, {
      workspaces: list,
      minConfidence: config.minConfidence,
      maxTitleChars: config.maxTitleChars,
    });
    if (parsed === null) {
      console.warn(`${LOG} 模型返回无法解析：${clip(answer, 200)}`);
      return undefined;
    }
    return { ...parsed, classifier: 'llm', route: `${route.provider}/${route.model}` };
  }

  /** Cache key: the first ~240 chars plus the current Workspace catalog. */
  function cacheKey(text, list) {
    const signature = list.map((workspace) => `${workspace.workspaceId}:${workspace.title}`).join('|');
    return `${clip(text, 240)}\u0000${signature}`;
  }

  /** Read one cached decision, evicting it once the TTL passes. */
  function cacheGet(key) {
    const entry = classifyCache.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.at > config.cacheTtlMs) {
      classifyCache.delete(key);
      return undefined;
    }
    return entry.decision;
  }

  /** Store one decision (including `null` for "no clear topic"). */
  function cacheSet(key, decision) {
    if (classifyCache.size >= 300) classifyCache.delete(classifyCache.keys().next().value);
    classifyCache.set(key, { at: Date.now(), decision });
  }

  /** Classify one message with the configured strategy. */
  async function classify(text, list, signal) {
    const key = cacheKey(text, list);
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;

    let result;
    if (config.mode === 'llm') {
      // A confident local keyword hit answers immediately, saving the model
      // call and its latency for the common, unambiguous cases.
      if (config.prefilter) {
        const local = heuristicDecision(text, {
          workspaces: list,
          minChars: config.minChars,
          extraCategories: config.categories,
        });
        if (local !== null && (local.score ?? 0) >= config.prefilterMinScore) {
          result = { ...local, classifier: 'heuristic' };
        }
      }
      if (result === undefined) {
        const answer = await classifyWithLlm(text, list, signal);
        if (answer !== undefined) result = answer;
      }
    }

    if (result === undefined) {
      const local = heuristicDecision(text, {
        workspaces: list,
        minChars: config.minChars,
        extraCategories: config.categories,
      });
      result = local === null ? null : { ...local, classifier: 'heuristic' };
    }

    cacheSet(key, result);
    return result;
  }

  /** Create the target Session and forward the exact user content. */
  async function forward(sourceAgent, workspace, message) {
    const presets = ctx.get('agentPresets');
    const preset = presets?.presetForSession?.(sourceAgent.session);
    let created;
    try {
      created = await sessionController.create({
        workspaceId: workspace.id,
        ...(preset === undefined || preset === null ? {} : { agentPreset: preset }),
      });
    } catch (error) {
      if (preset === undefined || preset === null) throw error;
      // A preset that is no longer active must not block filing.
      created = await sessionController.create({ workspaceId: workspace.id });
    }
    const sessionId = created.sessionId;
    if (forwarded.size > 500) forwarded.clear();
    forwarded.add(sessionId);
    try {
      await sessionController.prompt(
        {
          sessionId,
          content: message.content,
          // The Remote path always names the request; a Host-side caller must
          // do the same or the durable user source carries an undefined rpcId.
          requestId: `auto-workspace-${randomUUID()}`,
        },
        AbortSignal.timeout(30000),
      );
    } catch (error) {
      forwarded.delete(sessionId);
      await workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch(() => {});
      throw error;
    }
    return sessionId;
  }

  /** Hide the source conversation shortly after the target started. */
  function scheduleArchive(sessionId) {
    if (config.archiveDelayMs <= 0) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (disposed) return;
      workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).then(() => {
        console.log(`${LOG} 已隐藏原会话 ${sessionId}`);
      }, (error) => {
        console.warn(`${LOG} 隐藏原会话失败 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, config.archiveDelayMs);
    timer.unref?.();
    timers.add(timer);
  }

  /**
   * Decide and file one first prompt.
   * @returns {boolean} true when the caller must reject the original step.
   */
  async function fileFirstPrompt(agent, message, signal) {
    const text = textOfContent(message.content);
    const entities = workspaceRegistry.list();
    const list = entities.map((workspace) => ({
      workspaceId: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessionCount: workspace.sessionIds.length,
    }));
    if (config.requireClient && Date.now() - lastClientPoll > CLIENT_WINDOW_MS) {
      counts.skipped += 1;
      recordDecision({
        sessionId: agent.id,
        text: clip(text, 120),
        action: 'skipped',
        reason: '浏览器端未连接，暂不自动归档',
      });
      return false;
    }

    const current = await currentWorkspaceOf(agent.session);
    const base = {
      sessionId: agent.id,
      text: clip(text, 120),
      currentWorkspaceId: current?.id,
      currentWorkspaceTitle: current?.title,
    };

    if (config.onlyFromWorkspaces.length > 0) {
      const allowed = config.onlyFromWorkspaces.some((entry) => current !== undefined
        && (entry === current.title || entry === current.path || entry === basename(current.path)));
      if (!allowed) {
        counts.skipped += 1;
        recordDecision({ ...base, action: 'skipped', reason: '来源工作区不在 onlyFromWorkspaces 白名单内' });
        return false;
      }
    }

    if (text.length === 0 || isTrivial(text, config.minChars)) {
      counts.skipped += 1;
      recordDecision({ ...base, action: 'skipped', reason: '消息过短或属于寒暄' });
      return false;
    }

    counts.classified += 1;
    let decision = await classify(text, list, signal);
    if (signal?.aborted === true || disposed) return false;
    if (decision === null || decision.target === 'none') {
      // "No existing workspace fits" — turn it into a new workspace rather
      // than leaving the conversation where it started.
      if (config.createOnNoMatch && text.length >= config.noMatchMinChars && looksLikeProject(text)) {
        const title = await titleForNewWorkspace(text, signal);
        decision = {
          target: 'new',
          title,
          confidence: 0.45,
          reason: '没有匹配的现有工作区，自动新建',
          classifier: decision?.classifier ?? 'fallback',
        };
      } else {
        counts.skipped += 1;
        recordDecision({ ...base, action: 'skipped', reason: decision?.reason ?? '没有明确主题', decision });
        return false;
      }
    }

    if (decision !== null && decision.target === 'new' && decision.classifier === 'heuristic') {
      // A keyword category ("效率工具") is too broad for a directory name;
      // ask the model for the concrete one ("周报模板").
      const specific = await titleForNewWorkspace(text, signal);
      if (specific !== undefined && specific.length > 0) decision = { ...decision, title: specific };
    }

    if (config.dryRun) {
      const preview = decision.target === 'existing'
        ? entities.find((workspace) => workspace.id === decision.workspaceId)?.title
        : decision.title;
      recordDecision({ ...base, action: 'dry-run', reason: decision.reason, decision, workspaceTitle: preview });
      console.log(`${LOG} [dry-run] 将归档到「${preview ?? decision.title ?? '?'}」：${clip(text, 80)}`);
      return false;
    }

    const target = await resolveTargetWorkspace(decision, entities);
    if (target === undefined) {
      counts.skipped += 1;
      recordDecision({ ...base, action: 'skipped', reason: '目标工作区不可用', decision });
      return false;
    }
    if (current !== undefined && current.id === target.id) {
      counts.skipped += 1;
      recordDecision({ ...base, action: 'stay', reason: '已位于目标工作区', decision, workspaceTitle: target.title });
      return false;
    }

    const targetSessionId = await forward(agent, target, message);
    counts.filed += 1;
    recordDecision({ ...base, action: 'filed', reason: decision.reason, decision, workspaceId: target.id, workspaceTitle: target.title, targetSessionId });
    recordEvent({
      fromSessionId: agent.id,
      toSessionId: targetSessionId,
      workspaceId: target.id,
      workspaceTitle: target.title,
      workspacePath: target.path,
      classifier: decision.classifier,
      confidence: decision.confidence,
      reason: decision.reason,
      text: clip(text, 80),
    });
    scheduleArchive(agent.id);
    console.log(`${LOG} 已把 ${agent.id} 归档到「${target.title}」→ ${targetSessionId}`);
    return true;
  }

  /** Whether the conversation has no human prompt in its durable log yet. */
  function isFirstHumanPrompt(session) {
    try {
      const messages = session.deriveMessages();
      return !messages.some((message) => message !== null
        && typeof message === 'object'
        && message.role === 'user'
        && message.source !== null
        && typeof message.source === 'object'
        && message.source.kind === 'user');
    } catch {
      return false;
    }
  }

  /** The Workspace whose existing conversations a scan reclassifies. */
  function scanWorkspaceEntity() {
    const wanted = config.scanWorkspace.trim();
    const list = workspaceRegistry.list();
    return list.find((workspace) => workspace.title === wanted
      || workspace.path === wanted
      || basename(workspace.path) === wanted)
      ?? list.find((workspace) => workspace.title === 'default-workspace'
        || basename(workspace.path) === 'default-workspace');
  }

  /** Whether the platform reports running work for one conversation. */
  async function sessionHasActivity(sessionId) {
    try {
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
      return Array.isArray(activity) && activity.length > 0;
    } catch {
      return true;
    }
  }

  /** The live Session when one is attached, without activating a cold one. */
  function liveSessionOf(sessionId) {
    try {
      return ctx.get('sessions')?.get?.(sessionId);
    } catch {
      return undefined;
    }
  }

  /** Read one Session log, preferring the live instance over persisted bytes. */
  async function readConversation(sessionId) {
    const live = liveSessionOf(sessionId);
    if (live !== undefined) {
      return {
        header: live.header,
        events: live.snapshotEvents(),
        live: true,
        dispose() {},
      };
    }
    const observation = await ctx.sessionQuery.observeSession(sessionId);
    let released = false;
    return {
      header: observation.header,
      events: observation.events,
      live: false,
      dispose() {
        if (released) return;
        released = true;
        observation[Symbol.dispose]?.();
      },
    };
  }

  /** Signature of one Session, cached for the lifetime of a scan. */
  async function signatureOf(sessionId, cache) {
    if (cache.has(sessionId)) return cache.get(sessionId);
    let signature;
    try {
      const conversation = await readConversation(sessionId);
      try {
        signature = conversationSignature(titleOfEvents(conversation.events) ?? '', firstUserText(conversation.events));
      } finally {
        conversation.dispose();
      }
    } catch {
      signature = undefined;
    }
    cache.set(sessionId, signature);
    return signature;
  }

  /** Whether a Workspace already holds a conversation with this signature. */
  async function hasDuplicate(target, signature, excludeSessionId, cache) {
    if (signature === undefined) return false;
    for (const id of target.sessionIds) {
      if (id === excludeSessionId) continue;
      if (await signatureOf(id, cache) === signature) return true;
    }
    return false;
  }

  /** Classify one existing conversation by its first human message. */
  async function planExisting(sessionId, workspace, list, signal, signatureCache) {
    let conversation;
    try {
      conversation = await readConversation(sessionId);
    } catch (error) {
      return { sessionId, action: 'skip', reason: `读取会话失败：${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      const { header, events } = conversation;
      const live = conversation.live === true;
      const text = firstUserText(events);
      const title = titleOfEvents(events) || clip(text, 60) || sessionId;
      if (await sessionHasActivity(sessionId)) return { sessionId, action: 'skip', title, preview: clip(text, 100), reason: '会话正在运行' };
      if (header.origin === 'subagent') return { sessionId, action: 'skip', title, reason: '不是普通用户会话' };
      const preset = presetOfEvents(events);
      if (preset !== undefined && !config.allowPreset) return { sessionId, action: 'skip', title, preview: clip(text, 100), reason: `使用了 agent preset「${preset}」，暂不搬迁（可设 allowPreset: true 强制搬迁）` };
      if (text.length === 0) return { sessionId, action: 'skip', title, reason: '没有可供分类的人类消息' };
      if (signal?.aborted === true) return { sessionId, action: 'skip', title, reason: '扫描已取消' };

      let decision = await classify(text, list, signal);
      if (decision === null || decision.target === 'none') {
        // Scanning must also file a conversation when nothing fits: create a
        // new workspace for project-like content instead of leaving it behind.
        if (config.createOnNoMatch && text.length >= config.noMatchMinChars && looksLikeProject(text)) {
          const newTitle = await titleForNewWorkspace(text, signal);
          decision = {
            target: 'new',
            title: newTitle,
            confidence: 0.45,
            reason: '没有匹配的现有工作区，自动新建',
            classifier: decision?.classifier ?? 'fallback',
          };
        }
      }
      if (decision !== null && decision.target === 'new' && decision.classifier === 'heuristic') {
        const specific = await titleForNewWorkspace(text, signal);
        if (specific !== undefined && specific.length > 0) decision = { ...decision, title: specific };
      }
      const base = { sessionId, title, preview: clip(text, 100), decision, live };
      if (decision === null || decision.target === 'none') {
        return { ...base, action: 'stay', reason: decision?.reason ?? '没有明确主题' };
      }
      if (decision.target === 'existing' && decision.workspaceId === workspace.id) {
        return { ...base, action: 'stay', reason: '已属于当前工作区' };
      }
      const target = decision.target === 'existing'
        ? list.find((entry) => entry.workspaceId === decision.workspaceId)
        : undefined;
      const targetTitle = target?.title ?? decision.title;
      // Skip a conversation whose copy already sits in the target Workspace.
      const targetEntity = target === undefined
        ? workspaceRegistry.list().find((entry) => entry.title.trim() === decision.title.trim())
        : workspaceRegistry.list().find((entry) => entry.id === target.workspaceId);
      if (targetEntity !== undefined) {
        const signature = conversationSignature(titleOfEvents(events) ?? '', text);
        if (await hasDuplicate(targetEntity, signature, sessionId, signatureCache)) {
          return { ...base, action: 'stay', reason: '目标工作区已有相同对话（副本）', targetTitle };
        }
      }
      if (!isBalanced(events)) {
        return {
          ...base,
          action: config.repairInterrupted ? 'repairable' : 'skip',
          reason: config.repairInterrupted ? '最后一个回合未结束，归类时会先收尾' : '最后一个回合尚未结束',
          targetTitle,
        };
      }
      return {
        ...base,
        action: 'move',
        currentWorkspaceId: workspace.id,
        currentWorkspaceTitle: workspace.title,
        targetTitle,
      };
    } finally {
      conversation.dispose();
    }
  }

  /** Classify every candidate conversation in the scan Workspace. */
  async function collectScan(signal) {
    const workspace = scanWorkspaceEntity();
    if (workspace === undefined) throw new Error(`找不到工作区「${config.scanWorkspace}」`);
    const archived = new Set(workspaceRegistry.archivedSessionIds);
    const ids = workspace.sessionIds.filter((id) => !archived.has(id)).slice(0, config.scanLimit);
    const list = workspaceSnapshot();
    const signatureCache = new Map();
    const items = [];
    for (const sessionId of ids) {
      if (signal?.aborted === true) break;
      items.push(await planExisting(sessionId, { id: workspace.id, title: workspace.title }, list, signal, signatureCache));
    }
    const summary = {
      total: items.length,
      move: items.filter((item) => item.action === 'move' || item.action === 'repairable').length,
      repair: items.filter((item) => item.action === 'repairable').length,
      stay: items.filter((item) => item.action === 'stay').length,
      skip: items.filter((item) => item.action === 'skip').length,
    };
    counts.scanned += items.length;
    persistState();
    scanPlan = {
      at: Date.now(),
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      items,
    };
    return { workspace: { workspaceId: workspace.id, title: workspace.title }, items, counts: summary };
  }

  /** Close an interrupted last turn the same way opening the conversation does. */
  async function repairSession(sessionId) {
    if (liveSessionOf(sessionId) !== undefined) {
      throw new Error('会话仍被一个活跃的写入句柄占用；请先在界面里关闭该对话或重启应用后再试');
    }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
    await ctx.agents.resume({
      resumeSessionId: sessionId,
      ...(selection === undefined ? {} : { agentOptions: selection }),
    });
  }

  /** Create the target Session in the target directory with the source log. */
  async function copyConversation(events, target) {
    const { seed, inheritedEventCount } = buildCopySeed(events);
    const sessionId = `session-${randomUUID()}`;
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
    await ctx.agents.create({
      sessionId,
      seed,
      inheritedEventCount,
      meta: { cwd: target.path, isSeeded: true },
      ...(selection === undefined ? {} : { agentOptions: selection }),
    });
    try {
      await target.attachSession(sessionId);
    } catch (error) {
      await workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch(() => {});
      throw error;
    }
    return sessionId;
  }

  /** Move one idle, balanced conversation into an explicit target Workspace. */
  async function moveToWorkspace(sessionId, workspaceId) {
    if (config.dryRun) throw new Error('dryRun 已开启，不会真正移动对话');
    if (await sessionHasActivity(sessionId)) throw new Error('会话正在运行，稍后再试');
    const conversation = await readConversation(sessionId);
    try {
      const { header, events } = conversation;
      if (header.origin === 'subagent') throw new Error('不是普通用户会话');
      if (!isBalanced(events)) throw new Error('最后一个回合尚未结束');
      const target = workspaceRegistry.list().find((workspace) => workspace.id === workspaceId);
      if (target === undefined) throw new Error('找不到目标工作区');
      const source = workspaceRegistry.list().find((workspace) => workspace.sessionIds.includes(sessionId));
      if (source !== undefined && source.id === target.id) throw new Error('已属于目标工作区');
      const toSessionId = await copyConversation(events, target);
      await workspaceRegistry.archiveSession(sessionId, { stopActivity: true });
      counts.movedExisting += 1;
      recordMove({ fromSessionId: sessionId, toSessionId, workspaceId: target.id, workspaceTitle: target.title, kind: 'manual' });
      recordEvent({
        fromSessionId: sessionId,
        toSessionId,
        workspaceId: target.id,
        workspaceTitle: target.title,
        workspacePath: target.path,
        classifier: 'manual',
        confidence: 1,
        reason: '手动搬迁',
        text: clip(firstUserText(events), 80),
      });
      return { fromSessionId: sessionId, toSessionId, workspaceId: target.id, workspaceTitle: target.title };
    } finally {
      conversation.dispose();
    }
  }

  /** Undo one move by archiving the copy and restoring the source. */
  async function restoreMove(sessionId) {
    const move = moves.find((entry) => entry.toSessionId === sessionId || entry.fromSessionId === sessionId);
    if (move === undefined) throw new Error('找不到可撤销的搬迁记录');
    await workspaceRegistry.archiveSession(move.toSessionId, { stopActivity: true }).catch(() => {});
    await workspaceRegistry.unarchiveSession(move.fromSessionId);
    const index = moves.indexOf(move);
    if (index >= 0) moves.splice(index, 1);
    persistState();
    console.log(`${LOG} 已撤销搬迁：${move.fromSessionId} ← ${move.toSessionId}`);
    return move;
  }

  /** File the conversations a recent scan marked as movable. */
  async function applyScan(sessionIds) {
    const plan = scanPlan;
    if (plan === null || Date.now() - plan.at > PLAN_TTL_MS) throw new Error('扫描结果已过期，请重新扫描');
    if (config.dryRun) throw new Error('dryRun 已开启，不会真正移动对话');
    if (applying) throw new Error('另一个归类任务正在执行，请稍候');
    applying = true;
    const results = { moved: [], skipped: [], failed: [] };
    try {
      return await runApplyPlan(plan, sessionIds, results);
    } finally {
      applying = false;
      persistState();
    }
  }

  /** The serialized apply body. */
  async function runApplyPlan(plan, sessionIds, results) {
    const archived = new Set(workspaceRegistry.archivedSessionIds);
    for (const sessionId of sessionIds) {
      if (disposed) break;
      const item = plan.items.find((entry) => entry.sessionId === sessionId);
      if (item === undefined || (item.action !== 'move' && item.action !== 'repairable')) {
        results.skipped.push({ sessionId, reason: '不在这次扫描的搬迁列表里' });
        continue;
      }
      if (archived.has(sessionId)) {
        // A stale plan (or a second window) must never copy the same
        // conversation twice.
        results.skipped.push({ sessionId, reason: '已经归档' });
        continue;
      }
      try {
        if (await sessionHasActivity(sessionId)) {
          results.skipped.push({ sessionId, reason: '会话正在运行' });
          continue;
        }
        let conversation = await readConversation(sessionId);
        try {
          if (!isBalanced(conversation.events)) {
            if (item.action !== 'repairable' || !config.repairInterrupted) {
              results.skipped.push({ sessionId, reason: '最后一个回合尚未结束' });
              continue;
            }
            try {
              await repairSession(sessionId);
            } catch (error) {
              results.failed.push({ sessionId, reason: `收尾失败：${error instanceof Error ? error.message : String(error)}` });
              continue;
            }
            conversation.dispose();
            conversation = await readConversation(sessionId);
            if (!isBalanced(conversation.events)) {
              results.skipped.push({ sessionId, reason: '收尾后仍未结束' });
              continue;
            }
          }
          const target = await resolveTargetWorkspace(item.decision, workspaceRegistry.list());
          if (target === undefined) {
            results.failed.push({ sessionId, reason: '目标工作区不可用' });
            continue;
          }
          if (target.id === item.currentWorkspaceId) {
            results.skipped.push({ sessionId, reason: '已属于目标工作区' });
            continue;
          }
          const signature = conversationSignature(titleOfEvents(conversation.events) ?? '', firstUserText(conversation.events));
          if (await hasDuplicate(target, signature, sessionId, new Map())) {
            results.skipped.push({ sessionId, reason: '目标工作区已有相同对话（副本）' });
            continue;
          }
          const toSessionId = await copyConversation(conversation.events, target);
          await workspaceRegistry.archiveSession(sessionId, { stopActivity: true });
          archived.add(sessionId);
          counts.movedExisting += 1;
          recordMove({ fromSessionId: sessionId, toSessionId, workspaceId: target.id, workspaceTitle: target.title, kind: 'existing' });
          recordEvent({
            fromSessionId: sessionId,
            toSessionId,
            workspaceId: target.id,
            workspaceTitle: target.title,
            workspacePath: target.path,
            classifier: item.decision.classifier,
            confidence: item.decision.confidence,
            reason: '现有对话重新归类',
            text: item.preview,
          });
          results.moved.push({ fromSessionId: sessionId, toSessionId, workspaceId: target.id, workspaceTitle: target.title });
          console.log(`${LOG} 现有对话 ${sessionId} → 「${target.title}」${toSessionId}`);
        } finally {
          conversation.dispose();
        }
      } catch (error) {
        results.failed.push({ sessionId, reason: error instanceof Error ? error.message : String(error) });
        counts.failed += 1;
        console.warn(`${LOG} 搬迁 ${sessionId} 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
    }
    return results;
  }

  /** One optional startup pass over the scan Workspace. */
  function scheduleStartupScan(delay, attempt = 0) {
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (disposed || !config.enabled) return;
      if (config.requireClient && Date.now() - lastClientPoll > CLIENT_WINDOW_MS) {
        if (attempt < 20) scheduleStartupScan(30000, attempt + 1);
        return;
      }
      try {
        const scan = await collectScan(AbortSignal.timeout(120000));
        const ids = scan.items.filter((item) => item.action === 'move').map((item) => item.sessionId);
        if (ids.length === 0) {
          console.log(`${LOG} 启动扫描：没有需要归类的现有对话`);
          return;
        }
        const result = await applyScan(ids);
        console.log(`${LOG} 启动扫描：归类 ${result.moved.length} 个，跳过 ${result.skipped.length} 个，失败 ${result.failed.length} 个`);
      } catch (error) {
        console.warn(`${LOG} 启动扫描失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }, delay);
    timer.unref?.();
    timers.add(timer);
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (disposed || !config.enabled || decision?.kind !== 'enter') return decision;
    const agent = payload.agent;
    if (agent === undefined || payload.step !== 1 || payload.signal?.aborted === true) return decision;
    if (agent.session?.header?.origin === 'subagent') return decision;
    if (handled.has(agent.id) || forwarded.has(agent.id)) return decision;
    const message = firstUserMessage(decision.messages);
    if (message === undefined) return decision;
    // A batch with several human messages (queued sends) is not a clean
    // one-conversation start; filing would strand the others.
    if (decision.messages.filter((item) => item?.role === 'user' && item?.source?.kind === 'user').length > 1) return decision;
    if (!isFirstHumanPrompt(agent.session)) return decision;

    if (handled.size > 500) handled.clear();
    handled.add(agent.id);
    try {
      const filed = await fileFirstPrompt(agent, message, payload.signal);
      return filed ? { kind: 'reject' } : decision;
    } catch (error) {
      counts.failed += 1;
      recordDecision({
        sessionId: agent.id,
        action: 'error',
        reason: error instanceof Error ? error.message : String(error),
      });
      console.warn(`${LOG} 归档失败，保留原对话：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      return decision;
    } finally {
      persistState();
    }
  });

  // The browser half polls for filing events and status. The routes live
  // outside /api: they carry no Session data beyond ids the page already sees.
  ctx.inject(['webServer'], (scope) => {
    const server = scope.webServer;
    const route = (path, handler) => scope.effect(
      () => server.register({ kind: 'exact', path: `${PREFIX}${path}`, handler }),
      `auto-workspace: ${path}`,
    );

    route('/events', (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      if (!admitted(req, scope)) {
        sendJSON(res, 403, { ok: false, code: 'forbidden' });
        return;
      }
      lastClientPoll = Date.now();
      const url = new URL(req.url ?? '/', 'http://localhost');
      const after = Number(url.searchParams.get('after') ?? '0');
      const cursor = Number.isFinite(after) ? after : 0;
      const reported = url.searchParams.get('b');
      const build = reported === null || reported.length === 0 ? 'unknown' : reported.slice(0, 40);
      if (build !== lastClientBuild) {
        lastClientBuild = build;
        lastClientBuildAt = Date.now();
        if (build !== BUILD && !warnedStaleClient) {
          warnedStaleClient = true;
          console.warn(`${LOG} 前端版本 ${build} 与 Host 版本 ${BUILD} 不一致；如果侧边栏缺少新功能，请按 Cmd+R 重新载入页面`);
        }
      }
      sendJSON(res, 200, {
        ok: true,
        build: BUILD,
        bootId,
        enabled: config.enabled,
        mode: config.mode,
        dryRun: config.dryRun,
        lastSeq: seq,
        events: events.filter((event) => event.seq > cursor),
      });
    });

    route('/status', (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      if (!admitted(req, scope)) {
        sendJSON(res, 403, { ok: false, code: 'forbidden' });
        return;
      }
      const defaultSelection = ctx.get('agentDefaultModel')?.currentSelection?.();
      sendJSON(res, 200, {
        ok: true,
        version: BUILD,
        build: BUILD,
        bootId,
        clientBuild: lastClientBuild,
        clientBuildAt: lastClientBuildAt === 0 ? null : new Date(lastClientBuildAt).toISOString(),
        clientStale: lastClientBuild !== null && lastClientBuild !== BUILD,
        enabled: config.enabled,
        dryRun: config.dryRun,
        mode: config.mode,
        prefilter: config.prefilter,
        allowPreset: config.allowPreset,
        clientConnected: Date.now() - lastClientPoll <= CLIENT_WINDOW_MS,
        model: resolveRoute(config, defaultSelection) ?? null,
        workspaceRoot: config.workspaceRoot ?? defaultWorkspaceRoot(),
        counts,
        scanWorkspace: (() => {
          const workspace = scanWorkspaceEntity();
          return workspace === undefined ? null : { workspaceId: workspace.id, title: workspace.title };
        })(),
        lastScan: scanPlan === null ? null : {
          at: new Date(scanPlan.at).toISOString(),
          workspaceTitle: scanPlan.workspaceTitle,
          total: scanPlan.items.length,
          move: scanPlan.items.filter((item) => item.action === 'move').length,
        },
        workspaces: workspaceSnapshot(),
        moves: [...moves].reverse().slice(0, 10),
        events: [...events].reverse().slice(0, 10),
        decisions: [...decisions].reverse().slice(0, 10),
      });
    });

    // Preview and apply one pass over the existing conversations of the scan
    // Workspace. The preview always runs classification; apply re-checks the
    // log and the running-work seam before copying anything.
    route('/scan', (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      if (!admitted(req, scope)) {
        sendJSON(res, 403, { ok: false, code: 'forbidden' });
        return;
      }
      collectScan(AbortSignal.timeout(120000)).then((scan) => {
        sendJSON(res, 200, { ok: true, ...scan });
      }, (error) => {
        sendJSON(res, 500, { ok: false, code: 'scan-failed', message: error instanceof Error ? error.message : String(error) });
      });
    });

    route('/apply', (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      if (!admitted(req, scope)) {
        sendJSON(res, 403, { ok: false, code: 'forbidden' });
        return;
      }
      readJsonBody(req).then(async (body) => {
        const sessionIds = Array.isArray(body.sessionIds)
          ? body.sessionIds.filter((id) => typeof id === 'string' && id.length > 0)
          : [];
        if (sessionIds.length === 0) {
          sendJSON(res, 400, { ok: false, code: 'bad-request', message: 'sessionIds 不能为空' });
          return;
        }
        const results = await applyScan(sessionIds);
        sendJSON(res, 200, { ok: true, ...results });
      }).catch((error) => {
        sendJSON(res, 500, { ok: false, code: 'apply-failed', message: error instanceof Error ? error.message : String(error) });
      });
    });

    // Move one conversation into a chosen workspace, no classification.
    route('/move', (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      if (!admitted(req, scope)) {
        sendJSON(res, 403, { ok: false, code: 'forbidden' });
        return;
      }
      readJsonBody(req).then(async (body) => {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
        const workspaceTitle = typeof body.workspaceTitle === 'string' ? body.workspaceTitle.trim() : '';
        if (sessionId.length === 0 || (workspaceId.length === 0 && workspaceTitle.length === 0)) {
          sendJSON(res, 400, { ok: false, code: 'bad-request', message: 'sessionId 和 workspaceId 或 workspaceTitle 不能为空' });
          return;
        }
        let targetId = workspaceId;
        if (targetId.length === 0) {
          // A manual move may name a new workspace; create or reuse it by title.
          const target = await resolveTargetWorkspace({ target: 'new', title: workspaceTitle }, workspaceRegistry.list());
          if (target === undefined) throw new Error('无法创建目标工作区');
          targetId = target.id;
        }
        const moved = await moveToWorkspace(sessionId, targetId);
        sendJSON(res, 200, { ok: true, moved });
      }).catch((error) => {
        sendJSON(res, 500, { ok: false, code: 'move-failed', message: error instanceof Error ? error.message : String(error) });
      });
    });

    // Undo one move: re-hide the copy and restore the original conversation.
    route('/restore', (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      if (!admitted(req, scope)) {
        sendJSON(res, 403, { ok: false, code: 'forbidden' });
        return;
      }
      readJsonBody(req).then(async (body) => {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (sessionId.length === 0) {
          sendJSON(res, 400, { ok: false, code: 'bad-request', message: 'sessionId 不能为空' });
          return;
        }
        const restored = await restoreMove(sessionId);
        sendJSON(res, 200, { ok: true, restored });
      }).catch((error) => {
        sendJSON(res, 500, { ok: false, code: 'restore-failed', message: error instanceof Error ? error.message : String(error) });
      });
    });

    // Restore archived conversations without undoing their moves (the copies
    // stay where they are).
    route('/unarchive', (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      if (!admitted(req, scope)) {
        sendJSON(res, 403, { ok: false, code: 'forbidden' });
        return;
      }
      readJsonBody(req).then(async (body) => {
        const requested = Array.isArray(body.sessionIds)
          ? body.sessionIds.filter((id) => typeof id === 'string' && id.length > 0)
          : [];
        const archived = new Set(workspaceRegistry.archivedSessionIds);
        let ids = requested;
        if (ids.length === 0) {
          const workspace = scanWorkspaceEntity();
          if (workspace === undefined) throw new Error(`找不到工作区「${config.scanWorkspace}」`);
          ids = workspace.sessionIds.filter((id) => archived.has(id));
        }
        const restored = [];
        for (const id of ids) {
          if (!archived.has(id)) continue;
          await workspaceRegistry.unarchiveSession(id);
          restored.push(id);
        }
        persistState();
        sendJSON(res, 200, { ok: true, restored });
      }).catch((error) => {
        sendJSON(res, 500, { ok: false, code: 'unarchive-failed', message: error instanceof Error ? error.message : String(error) });
      });
    });

    // Hide conversations from the sidebar without touching their copies.
    route('/archive', (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      if (!admitted(req, scope)) {
        sendJSON(res, 403, { ok: false, code: 'forbidden' });
        return;
      }
      readJsonBody(req).then(async (body) => {
        const requested = Array.isArray(body.sessionIds)
          ? body.sessionIds.filter((id) => typeof id === 'string' && id.length > 0)
          : [];
        const archivedSet = new Set(workspaceRegistry.archivedSessionIds);
        let ids = requested;
        if (ids.length === 0) {
          const workspace = scanWorkspaceEntity();
          if (workspace === undefined) throw new Error(`找不到工作区「${config.scanWorkspace}」`);
          ids = workspace.sessionIds.filter((id) => !archivedSet.has(id));
        }
        const archived = [];
        for (const id of ids) {
          if (archivedSet.has(id)) continue;
          await workspaceRegistry.archiveSession(id, { stopActivity: true });
          archived.push(id);
        }
        persistState();
        sendJSON(res, 200, { ok: true, archived });
      }).catch((error) => {
        sendJSON(res, 500, { ok: false, code: 'archive-failed', message: error instanceof Error ? error.message : String(error) });
      });
    });

    // Create a conversation through the Host so the client can navigate to it.
    // Useful when the app shell's own new-chat control fails to create a Session.
    route('/new', (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      if (!admitted(req, scope)) {
        sendJSON(res, 403, { ok: false, code: 'forbidden' });
        return;
      }
      readJsonBody(req).then(async (body) => {
        const controller = ctx.get('sessionController');
        if (controller === undefined || typeof controller.create !== 'function') throw new Error('sessionController 不可用');
        const entities = workspaceRegistry.list();
        const requested = typeof body.workspaceId === 'string' && body.workspaceId.length > 0 ? body.workspaceId : undefined;
        let target = requested === undefined ? undefined : entities.find((workspace) => workspace.id === requested);
        if (target === undefined) {
          try {
            target = scanWorkspaceEntity();
          } catch {
            target = undefined;
          }
        }
        if (target === undefined) target = entities.find((workspace) => (workspace.sessionIds?.length ?? 0) > 0) ?? entities[0];
        if (target === undefined) throw new Error('没有可用工作区');
        const created = await controller.create({ workspaceId: target.id });
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        let prompted = false;
        if (text.length > 0) {
          await controller.prompt(
            { sessionId: created.sessionId, content: [{ type: 'text', text }], requestId: `new-${Date.now()}` },
            AbortSignal.timeout(15000),
          );
          prompted = true;
        }
        sendJSON(res, 200, { ok: true, sessionId: created.sessionId, workspaceId: target.id, workspaceTitle: target.title, prompted });
      }).catch((error) => {
        sendJSON(res, 500, { ok: false, code: 'new-failed', message: error instanceof Error ? error.message : String(error) });
      });
    });

    // Manual classification for diagnostics and for the README's smoke test.
    route('/classify', (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      if (!admitted(req, scope)) {
        sendJSON(res, 403, { ok: false, code: 'forbidden' });
        return;
      }
      const chunks = [];
      req.on('data', (chunk) => {
        chunks.push(chunk);
        if (chunks.reduce((size, item) => size + item.length, 0) > 64 * 1024) req.destroy();
      });
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const text = typeof body.text === 'string' ? body.text : '';
          if (isTrivial(text, config.minChars)) {
            sendJSON(res, 200, { ok: true, decision: null, reason: '消息过短或属于寒暄' });
            return;
          }
          const list = workspaceSnapshot();
          const decision = await classify(text, list, AbortSignal.timeout(config.timeoutMs + 1000));
          sendJSON(res, 200, { ok: true, decision, workspaces: list });
        } catch (error) {
          sendJSON(res, 500, { ok: false, code: 'classify-failed', message: error instanceof Error ? error.message : String(error) });
        }
      });
    });
  });

  if (config.scanOnStart && config.enabled) scheduleStartupScan(config.scanDelayMs);

  console.log(`${LOG} 已加载（mode=${config.mode}${config.enabled ? '' : '，已停用'}${config.dryRun ? '，dry-run' : ''}${config.scanOnStart ? '，启动扫描' : ''}）`);
}

/** Test surface: pure pieces plus the config defaults. */
export const __test = {
  DEFAULT_CONFIG,
  anySignal,
  collectAnswer,
  admitted,
};
