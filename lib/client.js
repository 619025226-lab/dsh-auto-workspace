/**
 * dsh-auto-workspace — browser half.
 *
 * The Host files a new conversation before its first model step. This half
 * keeps the page honest about that:
 *
 *  - it polls the Host's filing events;
 *  - when the conversation on screen was just filed, it reopens the target
 *    Session through the Workspace service, so the user keeps typing in the
 *    right place;
 *  - it shows a short toast and a sidebar status control with a small panel
 *    describing the latest decisions.
 *
 * Polling (rather than a socket) keeps the plugin independent of the Gateway
 * stream protocol; one request every ~1.2s while the page is visible.
 */

window.__ModuleLoader__.load({
	id: "dsh-auto-workspace",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const BASE = "/plugin/dsh-auto-workspace";
		// Must match BUILD in lib/index.js. Every poll reports it so /status can
		// show which client bundle this page is running.
		const BUILD = "0.6.1";
		const INTENT = "1";
		const INTENT_HEADER = "x-dsh-auto-workspace";
		const POLL_MS = 1200;
		const HIDDEN_POLL_MS = 5000;
		const REQUEST_TIMEOUT_MS = 4000;
		const TOAST_MS = 6500;
		const FIRST_POLL_WINDOW_MS = 8000;

		const LANG = String(
			(typeof navigator !== "undefined" && navigator.language) || "zh-CN",
		).toLowerCase().startsWith("zh") ? "zh" : "en";

		const STRINGS = {
			zh: {
				title: "自动归类",
				subtitle: "按对话内容自动归入工作区",
				enabled: "已启用",
				disabled: "已停用",
				modeLlm: "智能分类",
				modeHeuristic: "关键词分类",
				dryRun: "演练模式",
				recent: "最近归类",
				empty: "还没有自动归类记录。新建对话并发出第一条消息后，这里会出现结果。",
				open: "打开",
				close: "关闭",
				toastTitle: "已自动归类",
				toastDetail: "这个对话已移入「{name}」工作区",
				toastOpen: "打开",
				filed: "已归类",
				stay: "留在原工作区",
				skipped: "未归类",
				dry: "演练",
				error: "失败",
				stats: "已归类 {filed} 个对话 · 新建 {created} 个工作区",
				root: "新工作区目录",
				hint: "在 profile 的 cordis.patch.yml 里配置 auto-workspace 行可以关闭或调整。",
				refresh: "刷新",
				loading: "读取中…",
				unavailable: "Host 还没有响应，稍后自动重试。",
				versionLine: "界面 v{client} · Host v{host}",
				staleTitle: "前后端版本不一致",
				staleClientOlder: "页面仍在运行 v{client}，Host 已是 v{host}。重新载入页面即可使用新功能。",
				staleHostOlder: "界面已是 v{client}，Host 仍是 v{host}。Host 需要重启才能加载新功能：退出并重新打开 DeepSeek Harness（或用侧边栏的「重启」）。",
				reload: "重新载入页面",
				skippedHeading: "未移动（{n}）",
				skippedMore: "另有 {n} 个",
				repairNote: "其中 {n} 个对话的最后一个回合未结束，归类时会自动收尾（不丢历史）。",
				repairTag: "先收尾",
				untouchedHint: "「最后一个回合尚未结束」的对话，打开一次让它收尾（或发一条消息）后再扫描即可。",
				existing: "现有对话",
				existingHint: "把「{name}」里已有的对话按内容归入各工作区。历史会完整复制到新工作区，原对话归档。",
				scan: "扫描现有对话",
				scanAndApply: "扫描并归类",
				newChat: "新建对话",
				scanning: "扫描中，正在逐个判断…",
				rescan: "重新扫描",
				apply: "开始归类（{n}）",
				applying: "正在归类，请不要关闭页面…",
				scanSummary: "将移动 {move} 个 · 留在原工作区 {stay} 个 · 跳过 {skip} 个",
				scanDone: "已归类 {moved} 个 · 失败 {failed} 个 · 跳过 {skipped} 个",
				scanFailed: "扫描失败：{error}",
				applyFailed: "归类失败：{error}",
				moreMoves: "另有 {n} 个",
				noMoves: "没有需要移动的对话。",
				target: "→ {name}",
				skippedList: "跳过的对话",
				moveTo: "移到",
				move: "移动",
				moving: "移动中…",
				moveOk: "已移动",
				moveFailed: "移动失败：{error}",
				undoTitle: "最近搬迁（可撤销）",
				undoEmpty: "还没有可撤销的搬迁。",
				undo: "撤销",
				undoing: "撤销中…",
				undoFailed: "撤销失败：{error}",
			},
			en: {
				title: "Auto workspace",
				subtitle: "Files each new conversation into a workspace",
				enabled: "On",
				disabled: "Off",
				modeLlm: "Model classified",
				modeHeuristic: "Keyword classified",
				dryRun: "Dry run",
				recent: "Recent filings",
				empty: "No filings yet. Start a new conversation and send its first message.",
				open: "Open",
				close: "Close",
				toastTitle: "Filed automatically",
				toastDetail: "This conversation now lives in “{name}”",
				toastOpen: "Open",
				filed: "Filed",
				stay: "Stayed",
				skipped: "Skipped",
				dry: "Dry run",
				error: "Failed",
				stats: "{filed} conversations filed · {created} workspaces created",
				root: "New workspace directory",
				hint: "Turn it off or tune it through the auto-workspace row in the profile's cordis.patch.yml.",
				refresh: "Refresh",
				loading: "Loading…",
				unavailable: "The Host has not answered yet; retrying.",
				versionLine: "UI v{client} · Host v{host}",
				staleTitle: "Client and Host versions differ",
				staleClientOlder: "This page runs v{client} while the Host is on v{host}. Reload the page to pick up the new features.",
				staleHostOlder: "The UI is v{client} but the Host still runs v{host}. Restart DeepSeek Harness to load the new Host build.",
				reload: "Reload page",
				skippedHeading: "Not moved ({n})",
				skippedMore: "{n} more",
				repairNote: "{n} of them end in an interrupted turn; filing closes that turn first (no history is lost).",
				repairTag: "close first",
				untouchedHint: "Conversations whose last turn was interrupted become eligible once you open them (or send one message) so the turn closes.",
				existing: "Existing conversations",
				existingHint: "Classify the conversations already in “{name}” into their topic workspaces. History is copied in full and the source conversation is archived.",
				scan: "Scan conversations",
				scanAndApply: "Scan and file",
				newChat: "New conversation",
				scanning: "Scanning each conversation…",
				rescan: "Scan again",
				apply: "File {n} conversation(s)",
				applying: "Filing, keep this page open…",
				scanSummary: "{move} to move · {stay} already fine · {skip} skipped",
				scanDone: "Filed {moved} · failed {failed} · skipped {skipped}",
				scanFailed: "Scan failed: {error}",
				applyFailed: "Filing failed: {error}",
				moreMoves: "{n} more",
				noMoves: "Nothing needs moving.",
				target: "→ {name}",
				skippedList: "Skipped conversations",
				moveTo: "Move to",
				move: "Move",
				moving: "Moving…",
				moveOk: "Moved",
				moveFailed: "Move failed: {error}",
				undoTitle: "Recent moves (undo)",
				undoEmpty: "Nothing to undo.",
				undo: "Undo",
				undoing: "Undoing…",
				undoFailed: "Undo failed: {error}",
			},
		};

		/** Translate one key, filling `{name}` placeholders. */
		function t(key, vars) {
			let text = STRINGS[LANG][key] ?? STRINGS.zh[key] ?? key;
			for (const [name, value] of Object.entries(vars ?? {})) {
				text = text.split(`{${name}}`).join(String(value));
			}
			return text;
		}

		/** Subscribe one component to a snapshot controller. */
		function useSnapshot(controller) {
			return React.useSyncExternalStore(
				React.useCallback((listener) => controller.subscribe(listener), [controller]),
				React.useCallback(() => controller.getSnapshot(), [controller]),
				React.useCallback(() => controller.getSnapshot(), [controller]),
			);
		}

		/** Request one Host endpoint with the plugin's same-origin header. */
		async function request(path, body, timeoutMs = 8000) {
			const init = {
				method: body === undefined ? "GET" : "POST",
				credentials: "same-origin",
				headers: { [INTENT_HEADER]: INTENT },
				cache: "no-store",
			};
			if (body !== undefined) {
				init.headers["content-type"] = "application/json";
				init.body = JSON.stringify(body);
			}
			let timer;
			const timeout = new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
			});
			try {
				const response = await Promise.race([fetch(`${BASE}${path}`, init), timeout]);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return await response.json();
			} finally {
				clearTimeout(timer);
			}
		}

		/** Compare dotted numeric versions; a non-version marker sorts below. */
		function compareBuild(a, b) {
			const parse = (value) => String(value ?? "").split(".").map((part) => Number.parseInt(part, 10));
			const left = parse(a);
			const right = parse(b);
			if (left.some((part) => Number.isNaN(part)) || right.some((part) => Number.isNaN(part))) return 0;
			for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
				const diff = (left[index] ?? 0) - (right[index] ?? 0);
				if (diff !== 0) return diff;
			}
			return 0;
		}

		/** Format one ISO timestamp as a short local time. */
		function clock(iso) {
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return "";
			return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
		}

		/** Polling state for filings, status, toast, and the panel. */
		class AutoWorkspaceController {
			constructor(ctx) {
				this.ctx = ctx;
				this.listeners = new Set();
				this.timer = null;
				this.toastTimer = null;
				this.toastSeq = 0;
				this.disposed = false;
				this.visibleHandler = () => this.reschedule();
				this.state = {
					cursor: null,
					lastSeq: 0,
					hostBuild: null,
					enabled: true,
					mode: "llm",
					dryRun: false,
					events: [],
					status: null,
					statusError: null,
					toast: null,
					panel: false,
					error: null,
					scan: { phase: "idle", items: [], counts: null, error: null, result: null, workspace: null, movingId: null },
					undoingId: null,
				};
			}

			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}

			getSnapshot() {
				return this.state;
			}

			set(patch) {
				this.state = { ...this.state, ...patch };
				for (const listener of this.listeners) listener();
			}

			start() {
				if (this.disposed) return;
				document.addEventListener("visibilitychange", this.visibleHandler);
				this.schedule(0);
			}

			dispose() {
				this.disposed = true;
				document.removeEventListener("visibilitychange", this.visibleHandler);
				if (this.timer !== null) clearTimeout(this.timer);
				if (this.toastTimer !== null) clearTimeout(this.toastTimer);
				this.timer = null;
				this.toastTimer = null;
				this.listeners.clear();
			}

			/** Delay that respects a hidden page. */
			reschedule() {
				if (this.timer !== null) clearTimeout(this.timer);
				this.schedule(this.interval());
			}

			interval() {
				return typeof document !== "undefined" && document.visibilityState === "hidden"
					? HIDDEN_POLL_MS
					: POLL_MS;
			}

			schedule(delay) {
				if (this.disposed) return;
				if (this.timer !== null) clearTimeout(this.timer);
				this.timer = setTimeout(() => {
					this.timer = null;
					this.poll();
				}, delay);
			}

			async poll() {
				if (this.disposed) return;
				try {
					const after = this.state.cursor === null ? -1 : this.state.cursor;
					const data = await request(`/events?after=${after}&b=${encodeURIComponent(BUILD)}`);
					if (this.disposed) return;
					if (data === null || typeof data !== "object" || data.ok !== true) throw new Error("bad response");
					const first = this.state.cursor === null;
					const incoming = Array.isArray(data.events) ? data.events : [];
					const cutoff = Date.now() - FIRST_POLL_WINDOW_MS;
					const actionable = first
						? incoming.filter((event) => Date.parse(event.at) >= cutoff)
						: incoming;
					this.set({
						cursor: typeof data.lastSeq === "number" ? data.lastSeq : this.state.lastSeq,
						lastSeq: typeof data.lastSeq === "number" ? data.lastSeq : this.state.lastSeq,
						hostBuild: typeof data.build === "string" ? data.build : this.state.hostBuild,
						enabled: data.enabled !== false,
						mode: data.mode === "heuristic" ? "heuristic" : "llm",
						dryRun: data.dryRun === true,
						error: null,
					});
					for (const event of actionable) this.handleEvent(event);
				} catch (error) {
					if (!this.disposed) this.set({ error: error instanceof Error ? error.message : String(error) });
				} finally {
					this.schedule(this.interval());
				}
			}

			/** Navigate to the filed Session when the user is still looking at the source. */
			handleEvent(event) {
				if (event === null || typeof event !== "object") return;
				const current = this.currentSessionId();
				const related = current !== undefined
					&& (event.fromSessionId === current || event.toSessionId === current);
				if (current !== undefined && event.fromSessionId === current) {
					this.openSession(event.toSessionId);
				}
				// A filing in another window (or a background conversation) must
				// not steal attention here.
				if (related) this.showToast(event);
			}

			/** The Session the main view currently retains, if any. */
			currentSessionId() {
				const sessions = this.ctx.get("sessions");
				const snapshot = sessions?.list?.getSnapshot?.();
				if (snapshot === null || typeof snapshot !== "object" || snapshot.byId === null || typeof snapshot.byId !== "object") return undefined;
				const ids = Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(snapshot.byId);
				for (const id of ids) {
					const row = snapshot.byId[id];
					if (row !== null && typeof row === "object" && (row.retainedBy?.mainView ?? 0) > 0) return id;
				}
				return undefined;
			}

			/** Open one Session through the Workspace service when it is composed. */
			openSession(sessionId) {
				if (typeof sessionId !== "string" || sessionId.length === 0) return false;
				const uiWorkspace = this.ctx.get("uiWorkspace");
				if (uiWorkspace === undefined || typeof uiWorkspace.openSession !== "function") return false;
				try {
					uiWorkspace.openSession(sessionId);
					return true;
				} catch (error) {
					console.warn("[auto-workspace] could not open the filed session:", error);
					return false;
				}
			}

			/** Show the filing toast, replacing an earlier one. */
			showToast(event) {
				if (this.toastTimer !== null) clearTimeout(this.toastTimer);
				const id = ++this.toastSeq;
				this.set({ toast: { id, event } });
				this.toastTimer = setTimeout(() => {
					this.toastTimer = null;
					if (this.state.toast?.id === id) this.set({ toast: null });
				}, TOAST_MS);
			}

			dismissToast() {
				if (this.toastTimer !== null) clearTimeout(this.toastTimer);
				this.toastTimer = null;
				this.set({ toast: null });
			}

			/** Load the detailed status and open the panel. */
			async openPanel() {
				this.set({ panel: true, statusError: null });
				await this.loadStatus();
			}

			/** Refresh the detailed status without touching the panel visibility. */
			async loadStatus() {
				try {
					const status = await request("/status");
					if (this.disposed) return;
					this.set({
						status,
						enabled: status.enabled !== false,
						mode: status.mode === "heuristic" ? "heuristic" : "llm",
						dryRun: status.dryRun === true,
					});
				} catch (error) {
					if (!this.disposed) this.set({ statusError: error instanceof Error ? error.message : String(error) });
				}
			}

			/** Preview the filing plan for the conversations already in the scan workspace. */
			async scan() {
				const phase = this.state.scan.phase;
				if (phase === "scanning" || phase === "applying") return;
				this.set({ scan: { ...this.state.scan, phase: "scanning", error: null, result: null } });
				try {
					const data = await request("/scan", {}, 120000);
					if (this.disposed) return;
					if (data === null || typeof data !== "object" || data.ok !== true) throw new Error(data?.message ?? "scan failed");
					this.set({
						scan: {
							phase: "ready",
							items: Array.isArray(data.items) ? data.items : [],
							counts: data.counts ?? null,
							workspace: data.workspace ?? null,
							error: null,
							result: null,
						},
					});
				} catch (error) {
					if (!this.disposed) this.set({ scan: { ...this.state.scan, phase: "error", error: error instanceof Error ? error.message : String(error) } });
				}
			}

			/** File every conversation the preview marked as movable. */
			async applyScan() {
				const scan = this.state.scan;
				if (scan.phase !== "ready") return;
				const moves = scan.items.filter((item) => item.action === "move" || item.action === "repairable");
				if (moves.length === 0) return;
				this.set({ scan: { ...scan, phase: "applying", error: null } });
				try {
					const data = await request("/apply", { sessionIds: moves.map((item) => item.sessionId) }, 180000);
					if (this.disposed) return;
					if (data === null || typeof data !== "object" || data.ok !== true) throw new Error(data?.message ?? "apply failed");
					this.set({
						scan: {
							...this.state.scan,
							phase: "done",
							result: {
								moved: Array.isArray(data.moved) ? data.moved.length : 0,
								failed: Array.isArray(data.failed) ? data.failed.length : 0,
								skipped: Array.isArray(data.skipped) ? data.skipped.length : 0,
							},
						},
					});
					await this.loadStatus();
				} catch (error) {
					if (!this.disposed) this.set({ scan: { ...this.state.scan, phase: "ready", error: error instanceof Error ? error.message : String(error) } });
				}
			}

			/** One click: scan the existing conversations and file what it found. */
			async scanAndApply() {
				const phase = this.state.scan.phase;
				if (phase === "scanning" || phase === "applying") return;
				await this.scan();
				if (this.disposed || this.state.scan.phase !== "ready") return;
				const moves = this.state.scan.items.filter((item) => item.action === "move" || item.action === "repairable");
				if (moves.length === 0) return;
				await this.applyScan();
			}

			/** Create a conversation via the Host, then hand off to the client shell. */
			async newConversation() {
				const data = await request("/new", {}, 30000);
				if (data === null || typeof data !== "object" || data.ok !== true || typeof data.sessionId !== "string") {
					throw new Error(data?.message ?? "new conversation failed");
				}
				const ui = this.ctx.get?.("uiWorkspace");
				if (ui !== undefined && typeof ui.openSession === "function") ui.openSession(data.sessionId);
				await this.loadStatus();
				return data;
			}

			closePanel() {
				this.set({ panel: false });
			}

			/** Move one conversation into a chosen workspace (no classification). */
			async moveSession(sessionId, workspaceId) {
				const scan = this.state.scan;
				if (scan.movingId !== null || typeof workspaceId !== "string" || workspaceId.length === 0) return;
				this.set({ scan: { ...scan, movingId: sessionId, error: null } });
				try {
					const data = await request("/move", { sessionId, workspaceId }, 60000);
					if (this.disposed) return;
					if (data === null || typeof data !== "object" || data.ok !== true) throw new Error(data?.message ?? "move failed");
					this.set({
						scan: {
							...this.state.scan,
							items: this.state.scan.items.filter((item) => item.sessionId !== sessionId),
							phase: "ready",
							movingId: null,
						},
					});
					await this.loadStatus();
				} catch (error) {
					if (!this.disposed) this.set({ scan: { ...this.state.scan, movingId: null, error: error instanceof Error ? error.message : String(error) } });
				}
			}

			/** Undo one previous move by restoring the archived source. */
			async restoreMove(sessionId) {
				if (this.state.undoingId !== null) return;
				this.set({ undoingId: sessionId });
				try {
					const data = await request("/restore", { sessionId }, 60000);
					if (this.disposed) return;
					if (data === null || typeof data !== "object" || data.ok !== true) throw new Error(data?.message ?? "restore failed");
					await this.loadStatus();
				} catch (error) {
					if (!this.disposed) this.set({ statusError: error instanceof Error ? error.message : String(error) });
				} finally {
					if (!this.disposed) this.set({ undoingId: null });
				}
			}

			/** Session title from the live list, for the toast and panel. */
			titleOf(sessionId) {
				const sessions = this.ctx.get("sessions");
				const row = sessions?.list?.getSnapshot?.()?.byId?.[sessionId];
				return typeof row?.title === "string" && row.title.length > 0 ? row.title : undefined;
			}
		}

		/** Tag glyph shared by the footer control and the panel header. */
		function TagIcon({ size = 16 }) {
			return h("svg", {
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				fill: "none",
				"aria-hidden": "true",
				style: { display: "block", flex: "none" },
			}, [
				h("path", {
					key: "body",
					d: "M2.2 2.9c0-.4.3-.7.7-.7h4.2c.2 0 .4.1.6.2l6 6c.3.3.3.8 0 1.1l-3.1 3.1c-.3.3-.8.3-1.1 0l-6-6a.8.8 0 0 1-.2-.6V2.9Z",
					stroke: "currentColor",
					strokeWidth: 1.3,
					strokeLinejoin: "round",
				}),
				h("circle", { key: "hole", cx: 5.1, cy: 5.1, r: 1.05, fill: "currentColor" }),
			]);
		}

		/** Sidebar footer control; the shell passes `wide` for the full row. */
		function FooterControl({ wide, controller }) {
			const snapshot = useSnapshot(controller);
			const active = snapshot.enabled && snapshot.error === null;
			return h("button", {
				type: "button",
				className: `dsh-aw-footer${wide ? "" : " dsh-aw-footer-rail"}`,
				title: t("subtitle"),
				"aria-label": t("title"),
				onClick: () => {
					controller.openPanel().catch(() => {});
				},
			}, [
				h("span", { key: "icon", className: "dsh-aw-footer-icon" }, h(TagIcon, { size: wide ? 16 : 18 })),
				wide ? h("span", { key: "label", className: "dsh-aw-footer-label" }, t("title")) : null,
				h("span", {
					key: "dot",
					className: `dsh-aw-dot${active ? " dsh-aw-dot-on" : ""}`,
					"aria-hidden": "true",
				}),
			]);
		}

		/** Toast shown after the Host files the conversation on screen. */
		function FilingToast({ controller }) {
			const snapshot = useSnapshot(controller);
			const toast = snapshot.toast;
			if (toast === null) return null;
			const event = toast.event;
			const title = typeof event.workspaceTitle === "string" ? event.workspaceTitle : "";
			return h("div", {
				className: "dsh-aw-toast",
				role: "status",
				"data-dsh-auto-workspace-toast": true,
			}, [
				h("span", { key: "icon", className: "dsh-aw-toast-icon" }, h(TagIcon, { size: 16 })),
				h("div", { key: "text", className: "dsh-aw-toast-text" }, [
					h("div", { key: "title", className: "dsh-aw-toast-title" }, t("toastTitle")),
					h("div", { key: "detail", className: "dsh-aw-toast-detail" }, t("toastDetail", { name: title })),
				]),
				h("button", {
					key: "open",
					type: "button",
					className: "dsh-aw-button dsh-aw-button-ghost",
					onClick: () => {
						controller.openSession(event.toSessionId);
						controller.dismissToast();
					},
				}, t("toastOpen")),
				h("button", {
					key: "close",
					type: "button",
					className: "dsh-aw-close",
					"aria-label": t("close"),
					onClick: () => controller.dismissToast(),
				}, "×"),
			]);
		}

		/** One skipped/stayed conversation with a manual target picker. */
		function MoveRow({ item, workspaces, controller, movingId }) {
			const candidates = (Array.isArray(workspaces) ? workspaces : []).filter((workspace) => workspace.workspaceId !== item.currentWorkspaceId);
			const [target, setTarget] = React.useState(candidates[0]?.workspaceId ?? "");
			const busy = movingId === item.sessionId;
			return h("div", { className: "dsh-aw-skip" }, [
				h("div", { key: "line", className: "dsh-aw-skip-line" }, [
					h("span", { key: "title", className: "dsh-aw-move-title" }, item.title ?? item.sessionId),
					h("span", { key: "reason", className: "dsh-aw-move-preview" }, item.reason ?? ""),
				]),
				h("div", { key: "actions", className: "dsh-aw-skip-actions" }, [
					h("select", {
						key: "select",
						className: "dsh-aw-select",
						value: target,
						disabled: busy || candidates.length === 0,
						onChange: (event) => setTarget(event.target.value),
					}, [
						h("option", { key: "none", value: "" }, `${t("moveTo")}…`),
						...candidates.map((workspace) => h("option", {
							key: workspace.workspaceId,
							value: workspace.workspaceId,
						}, workspace.title)),
					]),
					h("button", {
						key: "move",
						type: "button",
						className: "dsh-aw-button",
						disabled: busy || target === "" || candidates.length === 0,
						onClick: () => {
							controller.moveSession(item.sessionId, target).catch(() => {});
						},
					}, busy ? t("moving") : t("move")),
				]),
			]);
		}

		/** Existing-conversation scan section inside the status panel. */
		function ScanSection({ controller, scan, status }) {
			const workspaceName = scan.workspace?.title ?? status?.scanWorkspace?.title ?? "default-workspace";
			const items = Array.isArray(scan.items) ? scan.items : [];
			const moves = items.filter((item) => item.action === "move" || item.action === "repairable");
			const counts = scan.counts ?? { move: moves.length, stay: 0, skip: 0 };
			const visible = moves.slice(0, 6);
			const children = [
				h("div", { key: "heading", className: "dsh-aw-card-heading" }, t("existing")),
				h("div", { key: "hint", className: "dsh-aw-card-note" }, t("existingHint", { name: workspaceName })),
			];

			if (scan.phase === "scanning") {
				children.push(h("div", { key: "progress", className: "dsh-aw-card-note" }, t("scanning")));
			} else if (scan.phase === "applying") {
				children.push(h("div", { key: "progress", className: "dsh-aw-card-note" }, t("applying")));
			} else if (scan.phase === "error") {
				children.push(h("div", { key: "error", className: "dsh-aw-card-error" }, t("scanFailed", { error: scan.error ?? "" })));
			} else if (scan.phase === "done" && scan.result !== null) {
				children.push(h("div", { key: "done", className: "dsh-aw-card-note" }, t("scanDone", scan.result)));
			} else if (scan.phase === "ready") {
				if (scan.error !== null) {
					children.push(h("div", { key: "apply-error", className: "dsh-aw-card-error" }, t("applyFailed", { error: scan.error })));
				}
				children.push(h("div", { key: "summary", className: "dsh-aw-card-note" }, t("scanSummary", counts)));
				if (typeof counts.repair === "number" && counts.repair > 0) {
					children.push(h("div", { key: "repair-note", className: "dsh-aw-card-note" }, t("repairNote", { n: counts.repair })));
				}
				const untouched = items.filter((item) => item.action === "skip" || item.action === "stay");
				if (moves.length === 0) {
					children.push(h("div", { key: "none", className: "dsh-aw-card-note" }, t("noMoves")));
				} else {
					children.push(h("div", { key: "moves", className: "dsh-aw-moves" }, [
						...visible.map((item) => h("div", { key: item.sessionId, className: "dsh-aw-move" }, [
							h("div", { key: "line", className: "dsh-aw-move-line" }, [
								h("span", { key: "title", className: "dsh-aw-move-title" }, item.title ?? item.sessionId),
								h("span", { key: "target", className: "dsh-aw-move-target" }, item.action === "repairable"
									? `${t("target", { name: item.targetTitle ?? "" })} · ${t("repairTag")}`
									: t("target", { name: item.targetTitle ?? "" })),
							]),
							item.preview === undefined ? null : h("div", { key: "preview", className: "dsh-aw-move-preview" }, item.preview),
						])),
						moves.length > visible.length
							? h("div", { key: "more", className: "dsh-aw-move-preview" }, t("moreMoves", { n: moves.length - visible.length }))
							: null,
					]));
				}
				if (untouched.length > 0) {
					const visibleUntouched = untouched.slice(0, 12);
					children.push(h("div", { key: "untouched-heading", className: "dsh-aw-card-heading" }, t("skippedHeading", { n: untouched.length })));
					children.push(h("div", { key: "untouched", className: "dsh-aw-skips" }, [
						...visibleUntouched.map((item) => h(MoveRow, {
							key: item.sessionId,
							item,
							workspaces: status?.workspaces,
							controller,
							movingId: scan.movingId,
						})),
						untouched.length > visibleUntouched.length
							? h("div", { key: "more", className: "dsh-aw-move-preview" }, t("skippedMore", { n: untouched.length - visibleUntouched.length }))
							: null,
					]));
					if (untouched.some((item) => String(item.reason ?? "").includes("回合"))) {
						children.push(h("div", { key: "untouched-hint", className: "dsh-aw-card-note" }, t("untouchedHint")));
					}
				}
			}

			const busy = scan.phase === "scanning" || scan.phase === "applying";
			const canApplyPlan = scan.phase === "ready" && moves.length > 0;
			const actions = [];
			if (canApplyPlan) {
				actions.push(h("button", {
					key: "apply",
					type: "button",
					className: "dsh-aw-button dsh-aw-button-primary",
					onClick: () => {
						controller.applyScan().catch(() => {});
					},
				}, t("apply", { n: moves.length })));
			}
			// One click scans and files; always available so it never disappears
			// behind a previous preview state.
			actions.push(h("button", {
				key: "scan-apply",
				type: "button",
				className: `dsh-aw-button${canApplyPlan ? "" : " dsh-aw-button-primary"}`,
				disabled: busy,
				onClick: () => {
					controller.scanAndApply().catch(() => {});
				},
			}, t("scanAndApply")));
			actions.unshift(h("button", {
				key: "newchat",
				type: "button",
				className: "dsh-aw-button dsh-aw-button-primary",
				disabled: busy,
				onClick: () => {
					controller.newConversation().catch(() => {});
				},
			}, t("newChat")));
			if (!canApplyPlan) {
				actions.push(h("button", {
					key: "scan",
					type: "button",
					className: "dsh-aw-button",
					disabled: busy,
					onClick: () => {
						controller.scan().catch(() => {});
					},
				}, scan.phase === "done" || scan.phase === "error" ? t("rescan")
					: scan.phase === "ready" ? t("scan")
						: t("scan")));
			}
			children.push(h("div", { key: "actions", className: "dsh-aw-actions" }, actions));
			return h("div", { className: "dsh-aw-section" }, children);
		}

		/** Status panel opened from the footer control. */
		function StatusPanel({ controller }) {
			const snapshot = useSnapshot(controller);
			React.useEffect(() => {
				if (!snapshot.panel) return undefined;
				const onKey = (event) => {
					if (event.key === "Escape") controller.closePanel();
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [controller, snapshot.panel]);
			if (!snapshot.panel) return null;
			const status = snapshot.status;
			const counts = status?.counts ?? {};
			const events = Array.isArray(status?.events) ? status.events : [];
			const moves = Array.isArray(status?.moves) ? status.moves : [];
			const mode = snapshot.mode === "heuristic" ? t("modeHeuristic") : t("modeLlm");
			const hostBuild = typeof status?.build === "string" ? status.build : snapshot.hostBuild;
			const stale = hostBuild !== null && hostBuild !== BUILD;
			const hostOlder = stale && (hostBuild === "unknown" || compareBuild(hostBuild, BUILD) < 0);
			return h("div", {
				className: "dsh-aw-overlay",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": t("title"),
				onClick: (event) => {
					if (event.target === event.currentTarget) controller.closePanel();
				},
			}, h("div", { className: "dsh-aw-card" }, [
				h("div", { key: "head", className: "dsh-aw-card-head" }, [
					h("span", { key: "icon", className: "dsh-aw-card-icon" }, h(TagIcon, { size: 18 })),
					h("div", { key: "titles", className: "dsh-aw-card-titles" }, [
						h("div", { key: "title", className: "dsh-aw-card-title" }, t("title")),
						h("div", { key: "subtitle", className: "dsh-aw-card-subtitle" }, t("subtitle")),
					]),
					h("button", {
						key: "close",
						type: "button",
						className: "dsh-aw-close",
						"aria-label": t("close"),
						onClick: () => controller.closePanel(),
					}, "×"),
				]),
				h("div", { key: "status", className: "dsh-aw-card-status" }, [
					h("span", {
						key: "state",
						className: `dsh-aw-badge${snapshot.enabled ? " dsh-aw-badge-on" : ""}`,
					}, snapshot.enabled ? t("enabled") : t("disabled")),
					h("span", { key: "mode", className: "dsh-aw-badge" }, snapshot.dryRun ? `${mode} · ${t("dryRun")}` : mode),
				]),
				stale
					? h("div", { key: "stale", className: "dsh-aw-stale" }, [
						h("div", { key: "title", className: "dsh-aw-stale-title" }, t("staleTitle")),
						h("div", { key: "detail", className: "dsh-aw-card-note" }, hostOlder
							? t("staleHostOlder", { host: hostBuild, client: BUILD })
							: t("staleClientOlder", { host: hostBuild, client: BUILD })),
						hostOlder
							? null
							: h("button", {
								key: "reload",
								type: "button",
								className: "dsh-aw-button dsh-aw-button-primary",
								onClick: () => location.reload(),
							}, t("reload")),
					])
					: h("div", { key: "version", className: "dsh-aw-version" }, t("versionLine", {
						client: BUILD,
						host: hostBuild ?? "?",
					})),
				snapshot.statusError !== null
					? h("div", { key: "error", className: "dsh-aw-card-note" }, t("unavailable"))
					: null,
				status === null
					? h("div", { key: "loading", className: "dsh-aw-card-note" }, t("loading"))
					: h("div", { key: "stats", className: "dsh-aw-card-note" }, t("stats", {
						// Auto-filed first prompts plus scan/manual moves; the recent
						// list shows both, so the counter must agree with it.
						filed: (counts.filed ?? 0) + (counts.movedExisting ?? 0),
						created: counts.createdWorkspaces ?? 0,
					})),
				h("div", { key: "heading", className: "dsh-aw-card-heading" }, t("recent")),
				events.length === 0
					? h("div", { key: "empty", className: "dsh-aw-card-empty" }, t("empty"))
					: h("div", { key: "list", className: "dsh-aw-list" }, events.map((event, index) => h("button", {
						key: `${event.seq ?? index}`,
						type: "button",
						className: "dsh-aw-row",
						onClick: () => {
							controller.openSession(event.toSessionId);
							controller.closePanel();
						},
					}, [
						h("span", { key: "time", className: "dsh-aw-row-time" }, clock(event.at)),
						h("span", { key: "name", className: "dsh-aw-row-name" }, event.workspaceTitle ?? ""),
						h("span", { key: "reason", className: "dsh-aw-row-reason" }, event.reason ?? ""),
					]))),
				h("div", { key: "undo-heading", className: "dsh-aw-card-heading" }, t("undoTitle")),
				moves.length === 0
					? h("div", { key: "undo-empty", className: "dsh-aw-card-empty" }, t("undoEmpty"))
					: h("div", { key: "undo-list", className: "dsh-aw-list" }, moves.slice(0, 8).map((move) => h("div", {
						key: move.toSessionId ?? move.fromSessionId,
						className: "dsh-aw-undo-row",
					}, [
						h("span", { key: "time", className: "dsh-aw-row-time" }, clock(move.at)),
						h("span", { key: "name", className: "dsh-aw-row-name" }, move.workspaceTitle ?? move.workspaceId ?? ""),
						h("button", {
							key: "undo",
							type: "button",
							className: "dsh-aw-button",
							disabled: snapshot.undoingId !== null,
							onClick: () => {
								controller.restoreMove(move.toSessionId).catch(() => {});
							},
						}, snapshot.undoingId === move.toSessionId ? t("undoing") : t("undo")),
					]))),
				h(ScanSection, { key: "scan", controller, scan: snapshot.scan, status }),
				h("div", { key: "root", className: "dsh-aw-card-foot" }, [
					status?.workspaceRoot === undefined
						? null
						: h("div", { key: "root", className: "dsh-aw-card-foot-line" }, `${t("root")}: ${status.workspaceRoot}`),
					h("div", { key: "hint", className: "dsh-aw-card-foot-line" }, t("hint")),
				]),
			]));
		}

		const CSS = `
.dsh-aw-footer{appearance:none;display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;margin:0;border:0;border-radius:9px;padding:7px 10px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6368);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.dsh-aw-footer:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#111)}
.dsh-aw-footer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}
.dsh-aw-footer-rail{justify-content:center;width:32px;height:32px;margin:0 auto;padding:0;border-radius:10px}
.dsh-aw-footer-icon{display:inline-flex;align-items:center;justify-content:center;flex:none}
.dsh-aw-footer-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.dsh-aw-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#b8b8b8);margin-left:auto;opacity:.75}
.dsh-aw-footer-rail .dsh-aw-dot{display:none}
.dsh-aw-dot-on{background:var(--dsw-alias-success-primary,#1a9b52)}
.dsh-aw-toast{position:fixed;right:24px;bottom:72px;z-index:1001;display:flex;align-items:center;gap:10px;max-width:min(460px,calc(100vw - 48px));box-sizing:border-box;padding:10px 12px 10px 14px;border:1px solid var(--dsw-alias-border-l2,#e8e8e8);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 12px 34px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary,#111);animation:dsh-aw-rise .18s ease-out}
.dsh-aw-toast-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 12%,transparent);color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-aw-toast-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dsh-aw-toast-title{font-size:13px;font-weight:600;line-height:18px}
.dsh-aw-toast-detail{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#5f6368);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-aw-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32));backdrop-filter:blur(1px)}
.dsh-aw-card{display:flex;flex-direction:column;gap:10px;width:min(470px,100%);max-height:min(640px,calc(100vh - 48px));box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#e8e8e8);border-radius:16px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 24px 64px rgba(0,0,0,.24);padding:18px 20px 16px;color:var(--dsw-alias-label-primary,#111);overflow:auto}
.dsh-aw-card-head{display:flex;align-items:flex-start;gap:10px}
.dsh-aw-card-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 12%,transparent);color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-aw-card-titles{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dsh-aw-card-title{font-size:15px;line-height:22px;font-weight:600}
.dsh-aw-card-subtitle{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#5f6368)}
.dsh-aw-card-status{display:flex;gap:8px;flex-wrap:wrap}
.dsh-aw-badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 9px;font-size:11.5px;line-height:16px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#5f6368)}
.dsh-aw-badge-on{background:color-mix(in srgb,var(--dsw-alias-success-primary,#1a9b52) 14%,transparent);color:var(--dsw-alias-success-primary,#1a9b52)}
.dsh-aw-card-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#5f6368)}
.dsh-aw-card-heading{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary,#5f6368);margin-top:2px}
.dsh-aw-list{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l2,#eee);border-radius:12px;overflow:hidden}
.dsh-aw-row{appearance:none;display:grid;grid-template-columns:44px minmax(0,1fr);grid-auto-rows:auto;column-gap:8px;text-align:left;border:0;border-bottom:1px solid var(--dsw-alias-border-l2,#eee);background:transparent;color:inherit;font:inherit;padding:8px 10px;cursor:pointer}
.dsh-aw-row:last-child{border-bottom:0}
.dsh-aw-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dsh-aw-row-time{grid-row:1 / span 2;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums;padding-top:1px}
.dsh-aw-row-name{font-size:12.5px;line-height:17px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-aw-row-reason{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#5f6368);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-aw-card-empty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#5f6368);padding:10px 2px}
.dsh-aw-card-error{font-size:12px;line-height:18px;color:var(--dsw-alias-error-primary,#c62828)}
.dsh-aw-version{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums}
.dsh-aw-stale{display:flex;flex-direction:column;gap:8px;align-items:flex-start;border:1px solid color-mix(in srgb,var(--dsw-alias-warning-primary,#b26a00) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-warning-primary,#b26a00) 8%,transparent);border-radius:12px;padding:10px 12px}
.dsh-aw-stale-title{font-size:12.5px;line-height:18px;font-weight:600;color:var(--dsw-alias-warning-primary,#b26a00)}
.dsh-aw-section{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l2,#eee);padding-top:12px;margin-top:2px}
.dsh-aw-actions{display:flex;gap:8px;flex-wrap:wrap}
.dsh-aw-button.dsh-aw-button-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}
.dsh-aw-button:disabled{opacity:.55;cursor:default}
.dsh-aw-moves{display:flex;flex-direction:column;gap:7px;border:1px solid var(--dsw-alias-border-l2,#eee);border-radius:12px;padding:8px 10px;max-height:190px;overflow:auto}
.dsh-aw-move{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-aw-move-line{display:flex;align-items:flex-start;gap:8px;min-width:0}
.dsh-aw-move-title{font-size:12.5px;line-height:18px;font-weight:600;overflow-wrap:anywhere;flex:1;min-width:0}
.dsh-aw-move-target{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-brand-primary,#4d6bfe);white-space:nowrap}
.dsh-aw-move-preview{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#5f6368);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-aw-skips{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2,#eee);border-radius:12px;padding:8px 10px;max-height:240px;overflow:auto}
.dsh-aw-skip{display:flex;flex-direction:column;gap:4px;min-width:0;border-bottom:1px solid var(--dsw-alias-border-l2,#f2f2f2);padding-bottom:8px}
.dsh-aw-skip:last-child{border-bottom:0;padding-bottom:0}
.dsh-aw-skip-line{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-aw-skip-line .dsh-aw-move-title{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;line-height:18px}
.dsh-aw-skip-line .dsh-aw-move-preview{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;line-height:17px}
.dsh-aw-skip-actions{display:flex;gap:6px;align-items:center;min-width:0}
.dsh-aw-select{appearance:auto;flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l2,#e8e8e8);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font:inherit;font-size:12px;line-height:17px;padding:4px 6px}
.dsh-aw-undo-row{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#eee)}
.dsh-aw-undo-row:last-child{border-bottom:0}
.dsh-aw-card-foot{display:flex;flex-direction:column;gap:4px;margin-top:2px;border-top:1px solid var(--dsw-alias-border-l2,#eee);padding-top:10px}
.dsh-aw-card-foot-line{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a);word-break:break-all}
.dsh-aw-close{appearance:none;flex:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5f6368);font-size:18px;line-height:20px;width:26px;height:26px;border-radius:8px;cursor:pointer}
.dsh-aw-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}
.dsh-aw-button{appearance:none;border:0;border-radius:9px;padding:6px 12px;font:inherit;font-size:12.5px;line-height:17px;cursor:pointer;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111);flex:none}
.dsh-aw-button:hover{filter:brightness(.96)}
@keyframes dsh-aw-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){.dsh-aw-toast{animation:none}.dsh-aw-footer{transition:none}}
`;

		const inject = ["slots", "sessions"];

		function apply(ctx) {
			const controller = new AutoWorkspaceController(ctx);

			ctx.effect(() => {
				const style = document.createElement("style");
				style.id = "dsh-auto-workspace-styles";
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => style.remove();
			}, "auto-workspace: styles");

			ctx.effect(() => {
				controller.start();
				return () => controller.dispose();
			}, "auto-workspace: polling");

			ctx.effect(() => ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "auto-workspace",
				inject: () => ({ controller }),
			}, FooterControl)), "auto-workspace: sidebar footer");

			ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "auto-workspace.toast",
				inject: () => ({ controller }),
			}, FilingToast)), "auto-workspace: toast");

			ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "auto-workspace.panel",
				inject: () => ({ controller }),
			}, StatusPanel)), "auto-workspace: panel");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
