# dsh-auto-workspace

> 仓库：<https://github.com/619025226-lab/dsh-auto-workspace>

让 DeepSeek Harness **按对话内容自动把新对话归入工作区**：第一条消息发出去后，插件判断它属于哪个工作区——已有工作区就直接归入，没有合适的就新建一个工作区并归入。

侧边栏底部会出现一个「自动归类」入口：显示最近的归类记录，并且可以把**默认工作区里已经存在的旧对话**批量重新归类。每次归档还会弹出一条提示，并自动把界面切到归档后的对话。

## 它解决什么问题

DeepSeek Harness 的工作区（侧边栏里的项目分组）本质上是一个**目录**：对话在创建时绑定目录，之后不能改目录，所以原生并没有「把一个对话挪到另一个工作区」的能力。

这个插件用「**归类后在新工作区里继续同一个对话**」的方式实现归档：

1. 新对话的第一条消息到达、模型开始回答**之前**，插件先读取消息内容做分类；
2. 如果目标就是当前工作区，什么也不做；
3. 如果需要归档：在目标工作区目录里新建一个会话，把用户这条消息原样转发过去（文字、图片、附件都保留），然后
   - 让原对话这一步直接结束（**不会重复调用模型**，因此不会产生双倍费用）；
   - 2.5 秒后把原对话从侧边栏隐藏（归档，不删除记录）；
   - 通过浏览器端把界面切到新会话。

如果分类失败、超时、目标工作区不可用或转发失败，插件会**放弃归档并让原对话照常继续**——任何异常都不会吞掉你的消息。

## 安装

```sh
cd ~/Documents/deepseek-harness/default-workspace/dsh-auto-workspace
./install.sh
```

然后**完全退出并重新打开 DeepSeek Harness**（关闭窗口会同时停掉本地服务；Host 端的插件需要重启才会加载）。侧边栏底部出现「自动归类」即安装成功。

如果只想先更新界面而不重启：刷新页面（Cmd/Ctrl+R）也能让浏览器端生效；Host 端已经是新代码时才建议这样做。

脚本默认装到当前 profile：在 DSH 会话里运行时自动识别（`DSH_PROFILE` / `DSH_PROFILE_DIR`），否则装到 `~/.dsh/profiles/desktop`。要装到别的 profile：

```sh
DSH_PROFILE=web ./install.sh
```

## 使用

### 新对话

正常新建对话、发第一条消息即可，不需要任何额外操作。

- 已有工作区能对上 → 归入该工作区；
- 没有合适的现有工作区、但消息是在做一件具体的事（例如「帮我写…」「做一个…」）→ **自动新建一个工作区并命名**，把对话放进去；
- 寒暄、一次性提问、闲聊 → 保持不动（`createOnNoMatch` 打开时也只对「像任务」的消息新建，`noMatchMinChars` 控制最短长度）。

- 对话属于已有工作区 → 归入该工作区；
- 属于新主题 → 在 `<新工作区目录>/<主题名>/` 新建工作区并归入；
- 寒暄、一次性提问、主题不明确 → **保持不动**，不会制造一堆「你好」工作区。

点侧边栏底部的「自动归类」可以查看：启用状态、当前分类方式、最近 10 次归类、新工作区根目录。

「最近归类」「最近搬迁（可撤销）」和「已归类 / 新建工作区」计数都会持久化到 `<插件目录>/state/state.json`，重启、更新插件后仍然保留，撤销按钮也不会因为重启而消失。旧版的 `moves.json` 会自动迁移。

### 归类默认工作区的旧对话

插件安装前就存在的对话不会自己移动。打开侧边栏底部的「自动归类」，在「现有对话」一栏点**扫描现有对话**：

1. 插件逐个读取 `default-workspace` 里每个对话的第一条消息并分类，列出「哪个对话 → 哪个工作区」的预览；
2. 确认后点**开始归类**：插件在目标工作区里新建会话，把原对话的完整历史（标题、消息、工具调用、附件的引用）复制过去，原对话归档；
3. 归类完成后原来的对话从侧边栏消失，新的对话出现在目标工作区，标题和历史保持不变。

扫描只处理「最后一个回合已经结束」的空闲对话；最后一个回合被中断的对话会在归类时自动收尾（`repairInterrupted`），正在运行或使用 agent preset 的会跳过并给出原因。没有匹配的现有工作区、但内容像在做一个具体的事的对话，扫描会直接把它标成可移动，并用 `createOnNoMatch`/`noMatchMinChars` 的规则自动命名一个新工作区（例如「ChatGPT 问题修复」），点「开始归类」即可。整个操作不会删除任何会话日志。

想在扫描预览里手动把某个被跳过的对话移到指定工作区：展开「未移动」列表，选目标工作区点「移动」。最近一次搬迁也会出现在面板的「最近搬迁」里，点「撤销」会归档复制出来的新会话、并把原会话恢复回侧边栏。

想让它在每次启动后自动做一遍，把 `scanOnStart` 设为 `true`（默认 `false`，避免未经确认就批量移动）。

## 配置

在 profile 的 `cordis.patch.yml` 里给 `auto-workspace` 行加 `config`（改完重启生效）：

```yaml
- insert:
    - id: auto-workspace
      name: dsh-auto-workspace
      config:
        enabled: true
        mode: llm
        model: { provider: deepseek-account, model: deepseek-flash }
        workspaceRoot: /Users/you/Documents/deepseek-harness
        minConfidence: 0.55
        timeoutMs: 6000
        dryRun: false
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后只记录、不归档 |
| `mode` | `llm` | `llm` 用模型分类；`heuristic` 用本地关键词表，不联网 |
| `model` | 部署默认模型 | 分类用的模型；默认就是 `agentDefaultModel`（通常是 flash，一次几百 token） |
| `timeoutMs` | `6000` | 单次分类超时；超时后对话照常继续，不归档 |
| `minConfidence` | `0.55` | 低于该置信度不归档 |
| `minChars` | `6` | 短于此长度的消息直接跳过（寒暄、单字） |
| `maxInputChars` | `4000` | 交给分类器的消息长度上限 |
| `maxTitleChars` | `40` | 分类器生成的工作区名长度上限 |
| `workspaceRoot` | `default-workspace` 的同级目录 | 新工作区建在这个目录下；默认 `/Users/you/Documents/deepseek-harness` |
| `createWorkspace` | `true` | 是否允许自动新建工作区 |
| `maxWorkspaces` | `400` | 工作区数量上限，超过后只归入已有工作区 |
| `dryRun` | `false` | 演练模式：只记录判断结果，不真正归档 |
| `archiveDelayMs` | `2500` | 归档原对话前等待的时间；给界面留出切换时间 |
| `categories` | `[]` | 追加关键词分类规则，例如 `[{ title: 婚礼筹备, keywords: [婚礼, 请柬] }]` |
| `onlyFromWorkspaces` | `[]` | 只对从这些工作区（标题或目录）新建的对话做归类；空数组表示所有工作区。例如只想归类 `default-workspace` 里的新对话时设为 `["default-workspace"]` |
| `requireClient` | `true` | 只有浏览器端在轮询（页面打开）时才归档，避免纯 API/脚本使用同一 profile 时对话被莫名移走 |
| `scanWorkspace` | `default-workspace` | 「扫描现有对话」默认处理哪个工作区（标题或目录） |
| `scanLimit` | `40` | 一次扫描最多处理多少个对话 |
| `scanOnStart` | `false` | 启动后自动扫描并归类现有对话 |
| `repairInterrupted` | `true` | 归类时先给「最后一个回合未结束」的对话补上收尾事件 |
| `createOnNoMatch` | `true` | 没有匹配的现有工作区时，根据内容自动新建一个工作区 |
| `noMatchMinChars` | `8` | 「无匹配→新建」要求首条消息至少这么多字 |
| `stateDir` | `<插件目录>/state` | 持久化状态的存放目录（状态文件 `state.json`） |
| `scanDelayMs` | `15000` | 启动扫描延迟多久执行（给页面留出连接时间） |
| `prefilter` | `true` | `llm` 模式下先用本地关键词预筛，命中高置信度就直接用，不再调模型 |
| `prefilterMinScore` | `3` | 关键词命中达到多少分才信任预筛结果（跳过模型调用） |
| `cacheTtlMs` | `600000` | 分类结果内存缓存时长；相同的第一条消息不重复调用模型 |
| `allowPreset` | `false` | 是否允许搬迁「使用了 agent preset」的对话（只复制历史，不保证 preset 的工具仍生效） |

只想让它「先看看效果」时，设 `dryRun: true`，侧边栏面板里会显示它本来打算归到哪个工作区。

## 工作原理（给维护者）

- **Host 半**（`lib/index.js`）：监听 `agent/pre-step`。第一次满足「会话里还没有人类消息 + 当前步骤是第 1 步」时，先 `await next()` 拿到完整决策，再分类；需要归档时用 `ctx.sessionController.create({ workspaceId })` 建会话、`prompt()` 转发原始内容，然后返回 `{ kind: 'reject' }` 结束原步骤。原会话在 `archiveDelayMs` 后调用 `workspaceRegistry.archiveSession(id, { stopActivity: true })` 隐藏。
- **分类器**（`lib/classifier.js`）：`llm` 模式给模型一段严格 JSON 的提示词，解析 `{ target, workspaceId, title, confidence }`；模型不可用或返回不合法时回退到本地关键词表。所有解析都有容错，最差结果是「不归档」。
- **不重复分类**：插件自己转发出来的会话 id 记在内存里；有历史消息的会话、子代理会话、一次领取多条消息的批次都直接跳过。
- **浏览器半**（`lib/client.js`）：每 1.2 秒轮询 `/plugin/dsh-auto-workspace/events`（页面隐藏时降到 5 秒），发现「当前正在看的会话刚被归档」就调用 `uiWorkspace.openSession(...)` 切过去，同时显示提示。侧边栏入口和面板都在 `sidebar.footer.action` / `shell.overlay` 里。
- **旧对话搬迁**：扫描时用 `ctx.sessionQuery.observeSession()` 读日志并分类；执行时用 `ctx.agents.create({ seed, inheritedEventCount, meta: { cwd, isSeeded: true } })` 把原日志（含 `session/end-seed` 标记）作为新会话的前缀写到目标目录，再 `attachSession`、归档原会话。复制的是同一条日志，不会重新请求模型，所以不产生额外费用。
- **接口**：`GET /plugin/dsh-auto-workspace/events`、`GET /status`、`POST /classify`（调试用，`{"text":"..."}`）、`POST /scan`（预览现有对话的归类计划）、`POST /apply`（执行计划，`{"sessionIds":[...]}`）、`POST /move`（手动把单个对话移到指定工作区，`{"sessionId","workspaceId"}`）、`POST /restore`（撤销一次搬迁，`{"sessionId"}`）。都要求同源页面 + `x-dsh-auto-workspace: 1` 头。

## 安全与边界

- 只处理**顶层普通会话**的第一条人类消息；子代理、fork 出来的会话、定时任务的消息都不会被移动。
- 原对话只是「归档隐藏」，会话日志和文件都保留，随时可以在侧边栏的已归档列表里恢复。
- 分类会把第一条消息发给模型（`llm` 模式）；如果不想让内容离开本机，用 `mode: heuristic`。
- 工作区是**目录**：自动新建的工作区会在磁盘上创建目录，对话里的文件操作都发生在这个目录里。之后想改目录，需要在侧边栏里手动新建/选择工作区。
- 一次只处理一条消息：如果同时排了好几条消息，插件会跳过归档，避免把后面的消息留在旧对话里。

## 验证

```sh
# 单元测试（分类器 + Host 编排）
node --test test/*.test.mjs

# 运行时自检（应用启动后）
curl -s -H 'x-dsh-auto-workspace: 1' http://127.0.0.1:<端口>/plugin/dsh-auto-workspace/status | jq
curl -s -H 'x-dsh-auto-workspace: 1' -H 'content-type: application/json' \
  -d '{"text":"帮我用 Python 写一个爬虫，定时抓取价格"}' \
  http://127.0.0.1:<端口>/plugin/dsh-auto-workspace/classify | jq
```

### 版本握手 / 排查前端缓存

`/status` 里新增了三个字段：

| 字段 | 含义 |
| --- | --- |
| `build` | Host 的构建标记（当前 `0.5.9`） |
| `clientBuild` | 最近一次轮询页面的构建标记；页面没带标记时是 `unknown` |
| `clientStale` | 两者不一致时为 `true` |

如果侧边栏缺少新功能，先看 `clientBuild`：`unknown` 或旧值说明 Host 已经更新、但页面还在跑旧的客户端 JS。按 **Cmd+R**（菜单「显示 → 重新载入」）即可；新版面板里也会直接出现「插件已更新」的提示和一个「重新载入」按钮。

```sh
curl -s -H 'x-dsh-auto-workspace: 1' http://127.0.0.1:<端口>/plugin/dsh-auto-workspace/status \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['build'], d['clientBuild'], d['clientStale'])"
```

## 卸载

```sh
./uninstall.sh
```

已创建的工作区和归档的会话都会保留；重启应用后插件消失。

## 安装后第一次使用

`requireClient` 默认开启：页面没有加载这个插件的浏览器端时，它不会归档任何对话。所以安装后请刷新一次页面（或重启应用）；侧边栏出现「自动归类」后，新对话才会开始被归类。

## 已知限制

- 归档依赖「新建会话 + 转发消息」，所以原会话会多出一条被结束的步骤记录（已归档，侧边栏里看不到）。
- 图片/附件会通过附件存储引用转发；个别不支持图片的模型组合会在转发时失败，此时会自动回退为不归档。
- 新会话使用部署默认模型；原会话里手动选过的模型不会跟过去（避免改掉全局默认模型）。
- 浏览器端靠轮询同步，切到新会话最多有约 1.2 秒延迟。
- 旧对话搬迁只处理日志完整（最后一个 `turn/end` 已落盘）、没有 agent preset、且当前没有运行任务的会话；不满足条件的会跳过并显示原因。
- 搬迁后的会话在内部是一个「带种子的会话」（`isSeeded`），标题和历史都保留，但它不是原会话本身；原会话只归档，不删除。
