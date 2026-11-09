/**
 * dsh-auto-workspace — pure classification helpers.
 *
 * Everything here is deterministic and free of Host dependencies so the Host
 * half and the unit tests can share it:
 *
 *  - config normalization with defensive defaults,
 *  - the trivial-message gate (greetings skip the model call),
 *  - the LLM prompt and the parser for its JSON answer,
 *  - the keyword fallback used when no model is available,
 *  - directory-name generation for new Workspaces.
 *
 * No file here reads the environment, the network, or a Cordis service.
 */

/** Defaults for every tunable; the profile entry may override any field. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch. */
  enabled: true,
  /** `llm` asks the deployment's model; `heuristic` never leaves the machine. */
  mode: 'llm',
  /** `{ provider, model }`; omitted uses the deployment default model. */
  model: null,
  /** Hard ceiling for one classification; the turn proceeds when it expires. */
  timeoutMs: 6000,
  /** Decisions below this confidence leave the conversation where it is. */
  minConfidence: 0.55,
  /** Messages shorter than this skip classification entirely. */
  minChars: 6,
  /** Bytes of the first message handed to the classifier. */
  maxInputChars: 4000,
  /** Ceiling for a generated Workspace title. */
  maxTitleChars: 40,
  /** Root directory for auto-created Workspaces; null derives it at runtime. */
  workspaceRoot: null,
  /** Allow the classifier to create new Workspaces. */
  createWorkspace: true,
  /** When no existing workspace fits, create a new one from the content. */
  createOnNoMatch: true,
  /** Minimum message length before a "no match" becomes a new workspace. */
  noMatchMinChars: 8,
  /** Log the decision without moving the conversation. */
  dryRun: false,
  /** Refuse to create Workspaces beyond this registry size. */
  maxWorkspaces: 400,
  /** Delay before the source conversation is hidden from the sidebar. */
  archiveDelayMs: 2500,
  /** Extra keyword rules appended to the built-in heuristic table. */
  categories: [],
  /** Only classify conversations started in these workspaces (titles or paths). */
  onlyFromWorkspaces: [],
  /** Only act while the browser half is polling (no surprise filings from API use). */
  requireClient: true,
  /** Workspace whose existing conversations the scan reclassifies (title or path). */
  scanWorkspace: 'default-workspace',
  /** Maximum conversations considered by one scan. */
  scanLimit: 40,
  /** Run one scan-and-file pass after startup. */
  scanOnStart: false,
  /** Let an apply close an interrupted last turn before copying it. */
  repairInterrupted: true,
  /** Directory for durable plugin state; null uses `<plugin>/state`. */
  stateDir: null,
  /** Delay before the startup scan, so the page can connect first. */
  scanDelayMs: 15000,
  /** In `llm` mode, skip the model call when a local keyword rule is confident. */
  prefilter: true,
  /** Minimum heuristic keyword score to trust the prefilter instead of the model. */
  prefilterMinScore: 3,
  /** In-memory classification cache lifetime; repeated first messages skip the model. */
  cacheTtlMs: 600000,
  /** Also migrate conversations started under an agent preset (history only). */
  allowPreset: false,
});

/** Short greetings are never worth a classifier call. */
const TRIVIAL_RE = /^(?:你好|您好|嗨|哈喽|哈啰|在吗|在么|早上好|上午好|下午好|晚上好|晚安|谢谢|多谢|感谢|好的|好|行|可以|嗯+|哦|收到|明白(?:了)?|测试|test|hi|hello|hey|yo|thanks|thank you|good morning|good afternoon|good evening|ok(?:ay)?|sure|got it)[\s\p{P}\p{S}]*$/iu;

/** Bilingual keyword table behind `mode: 'heuristic'`. */
export const CATEGORIES = Object.freeze([
  {
    title: '编程开发',
    keywords: [
      /代码|编程|函数|接口|类|模块|重构|单元测试|调试|报错|异常|编译|部署|脚本|爬虫|数据库|后端|前端|全栈|算法/i,
      /\b(?:api|sdk|bug|debug|refactor|function|class|module|unit test|compile|deploy|script|crawler|database|backend|frontend|algorithm|typescript|javascript|python|rust|golang|java|react|vue|node|sql|docker|git)\b/i,
    ],
  },
  {
    title: '写作沟通',
    keywords: [
      /写作|文章|文案|润色|改写|翻译|公众号|邮件|简历|故事|小说|演讲稿|周报|日报|总结报告|措辞|语气/i,
      /\b(?:write|writing|essay|article|copywriting|polish|rewrite|translate|translation|email|resume|story|novel|newsletter)\b/i,
    ],
  },
  {
    title: '研究调研',
    keywords: [
      /研究|调研|文献|综述|论文|学术|课题|资料|报告|论证|假设|实验设计/i,
      /\b(?:research|survey|paper|literature|academic|thesis|study|report|hypothesis)\b/i,
    ],
  },
  {
    title: '数据分析',
    keywords: [
      /数据分析|统计|指标|报表|图表|数据清洗|可视化|excel|表格|透视表|pandas|numpy/i,
      /\b(?:data analysis|analytics|statistics|metric|dashboard|chart|visuali[sz]ation|spreadsheet|sql query)\b/i,
    ],
  },
  {
    title: '设计创意',
    keywords: [
      /设计|配色|字体|排版|海报|logo|图标|界面|视觉|原型|插画|figma/i,
      /\b(?:design|ui|ux|palette|typography|poster|logo|icon|layout|visual|prototype|illustration|figma)\b/i,
    ],
  },
  {
    title: '产品规划',
    keywords: [
      /产品|需求|prd|原型图|用户故事|功能规划|竞品|路线图|用户反馈|增长/i,
      /\b(?:product|requirement|prd|user story|roadmap|competitor|growth|feature planning)\b/i,
    ],
  },
  {
    title: '运维部署',
    keywords: [
      /运维|服务器|监控|告警|日志分析|部署上线|容器|集群|备份|网络|域名|证书/i,
      /\b(?:ops|devops|server|nginx|kubernetes|k8s|monitor|alert|logging|deploy|container|cluster|backup|network|dns|tls)\b/i,
    ],
  },
  {
    title: '学习笔记',
    keywords: [
      /学习|课程|考试|笔记|复习|教程|入门|知识点|读书|背单词/i,
      /\b(?:learn|learning|course|exam|notes|study|tutorial|beginner|reading|vocabulary)\b/i,
    ],
  },
  {
    title: '生活日常',
    keywords: [
      /旅行|旅游|健身|健康|食谱|做饭|购物|理财|保险|租房|装修|宠物|育儿/i,
      /\b(?:travel|trip|fitness|health|recipe|cooking|shopping|finance|insurance|rent|renovation|pet|parenting)\b/i,
    ],
  },
  {
    title: '效率工具',
    keywords: [
      /效率|自动化|工作流|快捷键|模板|日程|待办|提醒|整理|归档/i,
      /\b(?:productivity|automation|workflow|shortcut|template|schedule|todo|reminder|organize)\b/i,
    ],
  },
]);

/** Normalize a label for title comparison. */
export function normalizeLabel(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

/** Truncate text without splitting a surrogate pair. */
export function clip(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/** Whether a message is too short or too generic to classify. */
/** Imperative hints that a message starts a project rather than chats. */
const PROJECT_VERB = /(?:帮我|请|写|做|实现|开发|设计|规划|整理|分析|建|创建|处理|排查|修复|优化|重构|部署|调研|生成|翻译|润色|总结|画|改|加|删|教|学习|准备|安排|调试|配置|搭建|评估|验证|测试)/;

/**
 * Whether a message reads like a piece of work worth its own Workspace, as
 * opposed to a one-off question or chit-chat. The "no match → create" fallback
 * only fires for these.
 */
export function looksLikeProject(text) {
  const value = String(text ?? '').trim();
  if (value.length < 4) return false;
  if (PROJECT_VERB.test(value)) return true;
  return value.length >= 20 && !/[?？]$/.test(value);
}

export function isTrivial(text, minChars = DEFAULT_CONFIG.minChars) {
  const value = String(text ?? '').trim();
  if (value.length === 0) return true;
  if (TRIVIAL_RE.test(value)) return true;
  return [...value].length < minChars;
}

/** Turn a Workspace title into a safe single directory segment. */
export function slugify(title, fallback = 'workspace') {
  const cleaned = String(title ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=~^[\]]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '')
    .slice(0, 48);
  return cleaned.length === 0 ? fallback : cleaned;
}

/** Extract the text of one user message (durable or request-only content blocks). */
export function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/** The first human-authored user message among a claimed batch. */
export function firstUserMessage(messages) {
  if (!Array.isArray(messages)) return undefined;
  return messages.find((message) => message !== null
    && typeof message === 'object'
    && message.role === 'user'
    && message.source !== null
    && typeof message.source === 'object'
    && message.source.kind === 'user');
}

/** One line of the Workspace catalog handed to the model. */
function workspaceLine(workspace) {
  return `- id=${workspace.workspaceId} 标题=${workspace.title} 目录=${workspace.path} 会话数=${workspace.sessionCount ?? 0}`;
}

/**
 * Build the single user message that asks the model for a filing decision.
 * The instruction lives in the user message because auxiliary calls carry no
 * separate system prompt in this deployment.
 * @param {string} text - the first message of the conversation.
 * @param {Array<object>} workspaces - known Workspaces with id, title, path.
 * @param {{maxInputChars?: number}} [options]
 */
export function buildLlmPrompt(text, workspaces, options = {}) {
  const maxInputChars = options.maxInputChars ?? DEFAULT_CONFIG.maxInputChars;
  const catalog = workspaces.length === 0
    ? '（还没有工作区）'
    : workspaces.map(workspaceLine).join('\n');
  const message = clip(text, maxInputChars);
  return [
    '你是 DeepSeek Harness 的工作区归类助手。',
    '用户在「新对话」里发出了第一条消息。工作区是一个项目目录，侧边栏按工作区把对话分组。',
    '请判断这条消息所在的对话应该归入哪个工作区。',
    '',
    '现有工作区：',
    catalog,
    '',
    '规则：',
    '1. 优先归入语义匹配的现有工作区：target=existing，并给出该工作区的 id。',
    '2. 现有工作区都不合适，但消息有一个明确的主题（项目、代码、写作、学习、旅行、数据、设计、生活安排等）时：target=new，title 给出 2~8 个字的简短工作区名，使用消息本身的语言。',
    '   即使这是第一条消息，只要主题具体、后续大概率会继续讨论，就新建工作区。若和某个现有工作区几乎同名（如“编程”和“编程开发”），请归入现有工作区而不是新建。',
    '3. 只有这些情况选 target=none：寒暄闲聊；通用常识提问（如“什么是 REST”“今天几号”）；没有明确主题；信息不足以下判断。',
    '4. 标题要像用户会自己建的工作区名，不要用“技术实现”“问题咨询”这类泛化词。',
    '5. confidence 取 0~1；低于 0.55 就选 none。',
    '6. 不要虚构现有工作区 id。',
    '',
    '示例：',
    '- “下周去京都玩五天，帮我规划每天的行程和预算” → new，title=京都旅行',
    '- “帮我用 Python 写个爬虫，每天抓价格” → new，title=价格监控爬虫',
    '- “帮我润色这封邮件” → none（一次性改写，没有持续主题）',
    '- “什么是向量数据库” → none（通用常识提问）',
    '',
    '只输出一个 JSON 对象，不要 Markdown、不要解释：',
    '{"target":"existing|new|none","workspaceId":"","title":"","confidence":0.0,"reason":"一句话理由"}',
    '',
    '消息：',
    '"""',
    message,
    '"""',
  ].join('\n');
}

/**
 * Ask the model to name a Workspace from one message; used when no existing
 * workspace fits and the plugin must create one anyway.
 */
export function buildTitlePrompt(text, maxInputChars = DEFAULT_CONFIG.maxInputChars) {
  return [
    '你是工作区命名助手。用户的一段对话需要放进一个工作区（项目目录）。',
    '请为它起一个 2~8 个字的标题，要求：',
    '- 概括主题，像用户自己会建的目录名，例如「ChatGPT 问题修复」「京都旅行」「价格爬虫」；',
    '- 优先用具体的产物/项目名（如「周报模板」「价格爬虫」），不要用「效率工具」「编程开发」这类泛化分类词；',
    '- 只概括核心产物，不要用「与」「和」串联多个点：能叫「周报模板」就不要叫「周报模板与提醒」；',
    '- 不要照抄原句，不要以「帮我」「你帮我」「请」开头，不要带标点、引号或解释；',
    '- 使用消息本身的语言。',
    '',
    '消息：',
    "'''",
    clip(text, maxInputChars),
    "'''",
    '',
    '标题：',
  ].join('\n');
}

/** Find the JSON object inside a model answer that may carry fences or prose. */
export function extractJson(text) {
  const value = String(text ?? '').trim();
  if (value.length === 0) return null;
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced === null ? value : fenced[1];
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Match a requested existing Workspace by id first, then by normalized title. */
export function findWorkspace(workspaces, { workspaceId, title } = {}) {
  if (typeof workspaceId === 'string' && workspaceId.length > 0) {
    const byId = workspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (byId !== undefined) return byId;
  }
  if (typeof title === 'string' && title.trim().length > 0) {
    const wanted = normalizeLabel(title);
    const exact = workspaces.find((workspace) => normalizeLabel(workspace.title) === wanted);
    if (exact !== undefined) return exact;
    if (wanted.length >= 2) {
      const loose = workspaces.find((workspace) => {
        const label = normalizeLabel(workspace.title);
        return label.length >= 2 && (label.includes(wanted) || wanted.includes(label));
      });
      if (loose !== undefined) return loose;
    }
  }
  return undefined;
}

/**
 * Parse the model's answer into a decision.
 * @returns {{target: 'existing'|'new'|'none', workspaceId?: string, title?: string, confidence: number, reason: string} | null}
 */
export function parseDecision(raw, { workspaces = [], minConfidence = DEFAULT_CONFIG.minConfidence, maxTitleChars = DEFAULT_CONFIG.maxTitleChars } = {}) {
  const parsed = extractJson(raw);
  if (parsed === null) return null;
  const target = typeof parsed.target === 'string' ? parsed.target.trim().toLowerCase() : 'none';
  const reason = typeof parsed.reason === 'string' ? clip(parsed.reason.trim(), 160) : '';
  const confidence = Number(parsed.confidence);
  const score = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6;

  if (target === 'none') return { target: 'none', confidence: score, reason };

  if (target === 'existing') {
    const workspace = findWorkspace(workspaces, {
      workspaceId: typeof parsed.workspaceId === 'string' ? parsed.workspaceId.trim() : undefined,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
    });
    if (workspace === undefined) return { target: 'none', confidence: score, reason: reason || '未匹配到现有工作区' };
    if (score < minConfidence) return { target: 'none', confidence: score, reason: `置信度 ${score.toFixed(2)} 低于阈值` };
    return { target: 'existing', workspaceId: workspace.workspaceId, title: workspace.title, confidence: score, reason };
  }

  if (target === 'new') {
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    if (title.length === 0) return { target: 'none', confidence: score, reason: reason || '缺少工作区名称' };
    if (score < minConfidence) return { target: 'none', confidence: score, reason: `置信度 ${score.toFixed(2)} 低于阈值` };
    // The model occasionally invents a near-duplicate name for a topic that
    // already has a workspace ("编程" vs "编程开发"). Fold those into the
    // existing workspace instead of creating a second directory.
    const existing = findWorkspace(workspaces, { title });
    if (existing !== undefined) {
      return { target: 'existing', workspaceId: existing.workspaceId, title: existing.title, confidence: score, reason: reason || `并入现有工作区「${existing.title}」` };
    }
    return { target: 'new', title: clip(title, maxTitleChars), confidence: score, reason };
  }

  return { target: 'none', confidence: score, reason: reason || '无法识别的目标' };
}

/** Pick the best keyword category for one message, if any. */
export function heuristicCategory(text, extra = []) {
  const value = String(text ?? '');
  if (value.trim().length === 0) return undefined;
  const table = [...CATEGORIES, ...extra.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.title === 'string' && Array.isArray(entry.keywords))];
  let best;
  let bestScore = 0;
  for (const category of table) {
    let score = 0;
    for (const pattern of category.keywords) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'iu');
      const matches = value.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`));
      if (matches !== null) score += Math.min(3, matches.length);
    }
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }
  if (bestScore < 2) return undefined;
  return { title: best.title, score: bestScore };
}

/**
 * Decide locally when no model is configured (or the model call failed).
 * @returns {{target: 'existing'|'new'|'none', workspaceId?: string, title?: string, confidence: number, reason: string} | null}
 */
export function heuristicDecision(text, { workspaces = [], minChars = DEFAULT_CONFIG.minChars, extraCategories = [] } = {}) {
  if (isTrivial(text, minChars)) return null;
  const category = heuristicCategory(text, extraCategories);
  if (category === undefined) return null;
  const confidence = Math.min(0.9, 0.45 + category.score * 0.1);
  const existing = findWorkspace(workspaces, { title: category.title });
  if (existing !== undefined) {
    return { target: 'existing', workspaceId: existing.workspaceId, title: existing.title, confidence, score: category.score, reason: `关键词命中「${category.title}」` };
  }
  return { target: 'new', title: category.title, confidence, score: category.score, reason: `关键词命中「${category.title}」` };
}

/** Validate and merge one profile entry's config over the defaults. */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...DEFAULT_CONFIG };
  const warnings = [];

  if (typeof input.enabled === 'boolean') out.enabled = input.enabled;
  else if (input.enabled !== undefined) warnings.push('enabled 必须是布尔值，已忽略');

  if (input.mode === 'llm' || input.mode === 'heuristic') out.mode = input.mode;
  else if (input.mode !== undefined) warnings.push('mode 只能是 llm 或 heuristic，已按 llm 处理');

  if (input.model !== undefined && input.model !== null) {
    const model = input.model;
    if (model !== null && typeof model === 'object' && typeof model.model === 'string' && model.model.length > 0
      && (model.provider === undefined || (typeof model.provider === 'string' && model.provider.length > 0))) {
      out.model = {
        model: model.model,
        ...(model.provider === undefined ? {} : { provider: model.provider }),
        ...(typeof model.reasoningEffort === 'string' && model.reasoningEffort.length > 0 ? { reasoningEffort: model.reasoningEffort } : {}),
      };
    } else {
      warnings.push('model 必须是 { provider?, model, reasoningEffort? }，已改用默认模型');
    }
  }

  const numbers = [
    ['timeoutMs', 500, 30000, true],
    ['minConfidence', 0, 1, false],
    ['minChars', 0, 200, true],
    ['maxInputChars', 200, 20000, true],
    ['maxTitleChars', 4, 80, true],
    ['maxWorkspaces', 1, 2000, true],
    ['archiveDelayMs', 0, 60000, true],
    ['scanLimit', 1, 500, true],
    ['scanDelayMs', 1000, 300000, true],
    ['prefilterMinScore', 1, 10, true],
    ['cacheTtlMs', 0, 86400000, true],
    ['noMatchMinChars', 2, 200, true],
  ];
  for (const [key, min, max, integer] of numbers) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      warnings.push(`${key} 必须是数字，已忽略`);
      continue;
    }
    if (integer && !Number.isInteger(value)) {
      warnings.push(`${key} 必须是整数，已忽略`);
      continue;
    }
    out[key] = Math.min(max, Math.max(min, value));
  }

  if (typeof input.workspaceRoot === 'string' && input.workspaceRoot.trim().length > 0) out.workspaceRoot = input.workspaceRoot.trim();
  else if (input.workspaceRoot !== undefined && input.workspaceRoot !== null) warnings.push('workspaceRoot 必须是非空字符串，已忽略');

  if (typeof input.createWorkspace === 'boolean') out.createWorkspace = input.createWorkspace;
  if (typeof input.requireClient === 'boolean') out.requireClient = input.requireClient;
  if (typeof input.createOnNoMatch === 'boolean') out.createOnNoMatch = input.createOnNoMatch;
  if (typeof input.scanOnStart === 'boolean') out.scanOnStart = input.scanOnStart;
  if (typeof input.repairInterrupted === 'boolean') out.repairInterrupted = input.repairInterrupted;
  if (typeof input.stateDir === 'string' && input.stateDir.trim().length > 0) out.stateDir = input.stateDir.trim();
  else if (input.stateDir !== undefined && input.stateDir !== null) warnings.push('stateDir 必须是非空字符串，已忽略');
  if (typeof input.prefilter === 'boolean') out.prefilter = input.prefilter;
  if (typeof input.allowPreset === 'boolean') out.allowPreset = input.allowPreset;
  if (typeof input.scanWorkspace === 'string' && input.scanWorkspace.trim().length > 0) out.scanWorkspace = input.scanWorkspace.trim();
  else if (input.scanWorkspace !== undefined && input.scanWorkspace !== null) warnings.push('scanWorkspace 必须是非空字符串，已忽略');
  if (typeof input.dryRun === 'boolean') out.dryRun = input.dryRun;

  if (Array.isArray(input.onlyFromWorkspaces)) {
    out.onlyFromWorkspaces = input.onlyFromWorkspaces
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
  } else if (input.onlyFromWorkspaces !== undefined) {
    warnings.push('onlyFromWorkspaces 必须是字符串数组，已忽略');
  }

  if (Array.isArray(input.categories)) {
    const extra = [];
    for (const entry of input.categories) {
      if (entry === null || typeof entry !== 'object' || typeof entry.title !== 'string' || !Array.isArray(entry.keywords)) {
        warnings.push('categories 的每一项必须是 { title, keywords[] }，已跳过');
        continue;
      }
      const keywords = entry.keywords.filter((keyword) => keyword instanceof RegExp || typeof keyword === 'string');
      if (keywords.length > 0) extra.push({ title: entry.title, keywords });
    }
    out.categories = extra;
  } else if (input.categories !== undefined) {
    warnings.push('categories 必须是数组，已忽略');
  }

  return { config: out, warnings };
}

/** The resolved classifier route for a deployment, if any. */
export function resolveRoute(config, defaultSelection) {
  if (config.model !== null) {
    return {
      provider: config.model.provider ?? defaultSelection?.provider,
      model: config.model.model,
      ...(config.model.reasoningEffort === undefined ? {} : { reasoningEffort: config.model.reasoningEffort }),
    };
  }
  if (defaultSelection !== null && typeof defaultSelection === 'object'
    && typeof defaultSelection.provider === 'string' && typeof defaultSelection.model === 'string') {
    return { provider: defaultSelection.provider, model: defaultSelection.model };
  }
  return undefined;
}
