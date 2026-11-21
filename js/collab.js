/* ============================================================
   KEEPLOCAL — collab.js
   Peer-to-Peer Live Collaboration Engine (Trystero + Yjs)
   100% Serverless, Zero-Backend, End-to-End Encrypted
   ============================================================ */

(function (global) {
	"use strict";

	// Default peer color palette (vibrant, accessible, high contrast)
	const PEER_COLORS = [
		"#10B981", // Emerald
		"#3B82F6", // Blue
		"#8B5CF6", // Purple
		"#F59E0B", // Amber
		"#EC4899", // Pink
		"#06B6D4", // Cyan
		"#F97316", // Orange
		"#14B8A6"  // Teal
	];

	function hexToRgba(hex, alpha = 0.25) {
		if (!hex || typeof hex !== "string") return `rgba(16, 185, 129, ${alpha})`;
		let clean = hex.replace("#", "");
		if (clean.length === 3) {
			clean = clean.split("").map(c => c + c).join("");
		}
		const num = parseInt(clean, 16);
		if (isNaN(num)) return `rgba(16, 185, 129, ${alpha})`;
		const r = (num >> 16) & 255;
		const g = (num >> 8) & 255;
		const b = num & 255;
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}

	/**
	 * Computes pixel coordinates of caret in a textarea for live cursor tracking.
	 */
	function getTextareaCaretCoordinates(element, position) {
		if (typeof window === "undefined" || !document || !element) {
			return { top: 0, left: 0, height: 20 };
		}

		let mirror = document.getElementById("textareaCaretMirror");
		if (!mirror) {
			mirror = document.createElement("div");
			mirror.id = "textareaCaretMirror";
			mirror.style.position = "absolute";
			mirror.style.visibility = "hidden";
			mirror.style.whiteSpace = "pre-wrap";
			mirror.style.wordWrap = "break-word";
			mirror.style.overflow = "hidden";
			mirror.style.top = "0";
			mirror.style.left = "-9999px";
			document.body.appendChild(mirror);
		}

		const style = window.getComputedStyle(element);
		const properties = [
			"direction", "boxSizing", "width", "height", "overflowX", "overflowY",
			"borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
			"paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
			"fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize",
			"fontSizeAdjust", "lineHeight", "fontFamily", "textAlign", "textTransform",
			"textIndent", "textDecoration", "letterSpacing", "wordSpacing", "tabSize"
		];

		properties.forEach(p => {
			mirror.style[p] = style[p];
		});

		const text = element.value.substring(0, position);
		mirror.textContent = text;

		const span = document.createElement("span");
		span.textContent = element.value.substring(position) || ".";
		mirror.appendChild(span);

		const coordinates = {
			top: span.offsetTop + parseInt(style.borderTopWidth || "0", 10),
			left: span.offsetLeft + parseInt(style.borderLeftWidth || "0", 10),
			height: parseInt(style.lineHeight || style.fontSize || "20", 10) || 20
		};

		return coordinates;
	}

	/**
	 * Fast prefix/suffix diff algorithm to synchronize a string to a Y.Text instance.
	 * Dispatches minimal deletion and insertion operations in a single local transaction.
	 */
	function syncStringToYText(ytext, newStr) {
		if (!ytext) return;
		const oldStr = ytext.toString();
		if (oldStr === newStr) return;

		let start = 0;
		const oldLen = oldStr.length;
		const newLen = newStr.length;

		// Common prefix
		while (start < oldLen && start < newLen && oldStr[start] === newStr[start]) {
			start++;
		}

		// Common suffix
		let oldEnd = oldLen;
		let newEnd = newLen;
		while (oldEnd > start && newEnd > start && oldStr[oldEnd - 1] === newStr[newEnd - 1]) {
			oldEnd--;
			newEnd--;
		}

		const deleteCount = oldEnd - start;
		const insertText = newStr.slice(start, newEnd);

		if (deleteCount === 0 && insertText.length === 0) return;

		ytext.doc.transact(() => {
			if (deleteCount > 0) {
				ytext.delete(start, deleteCount);
			}
			if (insertText.length > 0) {
				ytext.insert(start, insertText);
			}
		}, "local");
	}

	/**
	 * Adjusts a local cursor position according to incoming Yjs delta operations.
	 */
	function adjustCursorPosition(pos, delta) {
		if (!Array.isArray(delta)) return pos;
		let newPos = pos;
		let curr = 0;
		for (const op of delta) {
			if (op.retain) {
				curr += op.retain;
			} else if (op.insert) {
				const len = typeof op.insert === "string" ? op.insert.length : 1;
				if (curr <= pos) {
					newPos += len;
				}
				curr += len;
			} else if (op.delete) {
				if (curr < pos) {
					newPos -= Math.min(op.delete, pos - curr);
				}
			}
		}
		return Math.max(0, newPos);
	}

	/**
	 * Adapts Trystero's makeAction to provide a consistent send(data, targetPeerId)
	 * and on(callback) interface across both modern (object) and legacy (array) Trystero versions.
	 */
	function createActionBridge(room, actionName) {
		if (!room || typeof room.makeAction !== "function") {
			console.error(`[KeepLocalCollab] room.makeAction is not available for ${actionName}`);
			return { send: () => Promise.resolve(), on: () => () => {} };
		}

		const raw = room.makeAction(actionName);

		// Legacy array form: [send, on]
		if (Array.isArray(raw)) {
			const [rawSend, rawOn] = raw;
			return {
				send: (data, targetPeerId) => {
					if (targetPeerId) {
						rawSend(data, targetPeerId);
					} else {
						rawSend(data);
					}
					return Promise.resolve();
				},
				on: (callback) => {
					rawOn((data, peerId) => callback(data, peerId));
				}
			};
		}

		// Modern object form (Trystero 0.27+): { send, onMessage }
		if (raw && typeof raw === "object") {
			return {
				send: (data, targetPeerId) => {
					const opts = targetPeerId ? { target: targetPeerId } : undefined;
					return raw.send(data, opts).catch((err) => {
						console.warn(`[KeepLocalCollab] Action ${actionName} send error:`, err);
					});
				},
				on: (callback) => {
					if (typeof raw.onMessage === "function") {
						raw.onMessage((data, context) => {
							const peerId = typeof context === "string" ? context : (context?.peerId || "");
							callback(data, peerId);
						});
					}
				}
			};
		}

		return { send: () => Promise.resolve(), on: () => () => {} };
	}

	// ============================================================
	// TRYSTERO + YJS PROVIDER
	// ============================================================

	class KeepLocalTrysteroProvider {
		constructor(roomId, ydoc, options = {}) {
			this.roomId = roomId;
			this.ydoc = ydoc;
			this.strategy = options.strategy || "torrent";
			this.appId = options.appId || "keeplocal-p2p";
			this.password = options.password || undefined;
			this.userMeta = options.userMeta || { name: "Peer", color: PEER_COLORS[0], isHost: false };

			this.peers = new Map(); // peerId -> { peerId, name, color, cursor, isHost, lastSeen }
			this.isDestroyed = false;

			// Callbacks
			this.onPeersChange = options.onPeersChange || null;
			this.onStatusChange = options.onStatusChange || null;
			this.onSyncComplete = options.onSyncComplete || null;

			this._initRoom();
		}

		_initRoom() {
			const collabLib = global.KeepLocalCollab;
			if (!collabLib) {
				console.error("[KeepLocalCollab] Collab bundle not loaded.");
				return;
			}

			const joinFn = (this.strategy === "nostr" && typeof collabLib.joinRoomNostr === "function")
				? collabLib.joinRoomNostr
				: collabLib.joinRoomTorrent;

			if (typeof joinFn !== "function") {
				console.error("[KeepLocalCollab] No valid joinRoom strategy found.");
				return;
			}

			const roomConfig = { appId: this.appId };
			if (this.password && this.password.trim().length > 0) {
				roomConfig.password = this.password.trim();
			}

			try {
				this.room = joinFn(roomConfig, this.roomId);
			} catch (err) {
				console.error("[KeepLocalCollab] Failed to join room:", err);
				if (this.onStatusChange) this.onStatusChange("error", err.message);
				return;
			}

			// Register actions via bridge (supporting Trystero 0.27+ and legacy)
			const syncAction = createActionBridge(this.room, "y-sync");
			const awarenessAction = createActionBridge(this.room, "y-awareness");

			this._sendSync = (data, targetPeerId) => syncAction.send(data, targetPeerId);
			this._sendAwareness = (data, targetPeerId) => awarenessAction.send(data, targetPeerId);

			// When peer joins:
			if (typeof this.room.onPeerJoin === "function") {
				this.room.onPeerJoin((context) => {
					const peerId = typeof context === "string" ? context : (context?.peerId || "");
					if (!peerId) return;
					console.log(`[KeepLocalCollab] Peer connected: ${peerId}`);
					// Step 1: Send local state vector to peer
					const sv = collabLib.Y.encodeStateVector(this.ydoc);
					this._sendSync({ type: "sync-step-1", sv: Array.from(sv) }, peerId);

					// Broadcast awareness to newly connected peer
					this.broadcastAwareness();

					if (this.onPeersChange) this.onPeersChange(this.getPeersList());
					if (this.onStatusChange) this.onStatusChange("connected", this.getPeerCount());
				});
			}

			// When peer leaves:
			if (typeof this.room.onPeerLeave === "function") {
				this.room.onPeerLeave((context) => {
					const peerId = typeof context === "string" ? context : (context?.peerId || "");
					if (!peerId) return;
					console.log(`[KeepLocalCollab] Peer disconnected: ${peerId}`);
					this.peers.delete(peerId);
					if (this.onPeersChange) this.onPeersChange(this.getPeersList());
					if (this.onStatusChange) this.onStatusChange("connected", this.getPeerCount());
				});
			}

			// Listen for room level errors
			if (typeof this.room.onError === "function") {
				this.room.onError((err) => {
					console.warn("[KeepLocalCollab] Room status/warning:", err?.message || err);
				});
			}

			// Handle incoming sync messages
			syncAction.on((msg, peerId) => {
				if (this.isDestroyed || !msg) return;

				if (msg.type === "sync-step-1") {
					// Peer sent their state vector; compute missing updates and send back step-2
					const peerSv = new Uint8Array(msg.sv);
					const missingUpdate = collabLib.Y.encodeStateAsUpdate(this.ydoc, peerSv);
					if (missingUpdate.length > 0) {
						this._sendSync({ type: "sync-step-2", update: Array.from(missingUpdate) }, peerId);
					}
					// Also reply with our state vector if peer hasn't seen it
					const mySv = collabLib.Y.encodeStateVector(this.ydoc);
					this._sendSync({ type: "sync-step-1-reply", sv: Array.from(mySv) }, peerId);
				} else if (msg.type === "sync-step-1-reply") {
					const peerSv = new Uint8Array(msg.sv);
					const missingUpdate = collabLib.Y.encodeStateAsUpdate(this.ydoc, peerSv);
					if (missingUpdate.length > 0) {
						this._sendSync({ type: "sync-step-2", update: Array.from(missingUpdate) }, peerId);
					}
				} else if (msg.type === "sync-step-2" || msg.type === "sync-update") {
					// Apply remote update to local Y.Doc with origin "remote"
					if (msg.update && msg.update.length > 0) {
						collabLib.Y.applyUpdate(this.ydoc, new Uint8Array(msg.update), "remote");
					}
					if (this.onSyncComplete && msg.type === "sync-step-2") {
						this.onSyncComplete();
					}
				}
			});

			// Handle incoming awareness (presence & live cursors)
			awarenessAction.on((data, peerId) => {
				if (this.isDestroyed || !data) return;
				this.peers.set(peerId, {
					peerId,
					name: data.name || "Peer",
					color: data.color || PEER_COLORS[0],
					cursor: data.cursor || null,
					isHost: !!data.isHost,
					lastSeen: Date.now()
				});
				if (this.onPeersChange) this.onPeersChange(this.getPeersList());
			});

			// Broadcast local doc mutations to peers
			this._docUpdateHandler = (update, origin) => {
				if (origin !== "remote" && !this.isDestroyed) {
					this._sendSync({ type: "sync-update", update: Array.from(update) });
				}
			};
			this.ydoc.on("update", this._docUpdateHandler);

			// Initial status notification
			if (this.onStatusChange) this.onStatusChange("connecting", 0);
		}

		broadcastAwareness(extra = {}) {
			if (this.isDestroyed || !this._sendAwareness) return;
			const payload = {
				name: this.userMeta.name,
				color: this.userMeta.color,
				isHost: !!this.userMeta.isHost,
				...extra
			};
			this._sendAwareness(payload);
		}

		getPeerCount() {
			if (!this.room || typeof this.room.getPeers !== "function") return 0;
			try {
				const peers = this.room.getPeers();
				return peers ? Object.keys(peers).length : 0;
			} catch (_) {
				return 0;
			}
		}

		getPeersList() {
			return Array.from(this.peers.values());
		}

		destroy() {
			this.isDestroyed = true;
			if (this.ydoc && this._docUpdateHandler) {
				this.ydoc.off("update", this._docUpdateHandler);
			}
			if (this.room) {
				try {
					if (typeof this.room.leave === "function") {
						this.room.leave().catch(() => {});
					}
				} catch (_) { }
				this.room = null;
			}
			this.peers.clear();
			if (this.onStatusChange) this.onStatusChange("disconnected", 0);
			if (this.onPeersChange) this.onPeersChange([]);
		}
	}

	// ============================================================
	// COLLABORATION MANAGER (KeepLocal Integration)
	// ============================================================

	class KeepLocalCollabManager {
		constructor() {
			this.provider = null;
			this.ydoc = null;
			this.yText = null;
			this.activeRoomId = null;
			this.activeFileId = null;
			this.activeScope = "note"; // "note" | "workspace"
			this.isHost = false;
			this.isApplyingRemote = false;
			this.activeStrategy = "torrent";

			// Local user profile
			this.userMeta = this._loadUserMeta();

			// Debounce timers
			this._saveDebounceTimer = null;
			this._remoteApplyCooldownTimer = null;
			this._cursorTrackingInitialized = false;

			this._initCursorTracking();
		}

		_loadUserMeta() {
			let saved = null;
			try {
				const raw = localStorage.getItem("keeplocal_collab_user");
				if (raw) saved = JSON.parse(raw);
			} catch (_) { }

			if (saved && saved.name && saved.color) {
				return saved;
			}

			const randomColor = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
			const randomNum = Math.floor(1000 + Math.random() * 9000);
			const defaultMeta = {
				name: `Writer #${randomNum}`,
				color: randomColor
			};
			this.saveUserMeta(defaultMeta);
			return defaultMeta;
		}

		saveUserMeta(meta) {
			this.userMeta = { ...this.userMeta, ...meta };
			try {
				localStorage.setItem("keeplocal_collab_user", JSON.stringify(this.userMeta));
			} catch (_) { }
			if (this.provider) {
				this.provider.userMeta = { ...this.userMeta, isHost: this.isHost };
				this.provider.broadcastAwareness();
			}
		}

		setScope(scope) {
			this.activeScope = (scope === "workspace") ? "workspace" : "note";
		}

		getScope() {
			return this.activeScope;
		}

		isActive() {
			return !!(this.provider && this.activeRoomId);
		}

		getActiveRoomId() {
			return this.activeRoomId;
		}

		/**
		 * Start hosting a live collaboration session (Note or Entire Workspace)
		 */
		async startHostSession(roomId, password = "", strategy = "torrent", scope = "note") {
			const isLanIp = typeof window !== "undefined" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";
			const isSecure = (typeof window !== "undefined" && window.isSecureContext) || (typeof crypto !== "undefined" && !!crypto?.subtle);
			if (!isSecure && isLanIp && typeof alert === "function") {
				const portStr = window.location.port ? `:${window.location.port}` : "";
				alert(`Insecure Context Warning:\n\nWebRTC cryptographic security requires a Secure Context (localhost or HTTPS).\n\nPlease open KeepLocal at http://localhost${portStr} on this computer, or access via HTTPS.`);
			}

			const api = global.KeepLocalAPI;
			if (api && typeof api.ensureActiveWorkspace === "function") {
				await api.ensureActiveWorkspace();
			}

			this.leaveSession();

			this.activeRoomId = roomId.trim();
			this.isHost = true;
			this.activeStrategy = strategy;
			this.activeScope = scope || "note";

			const collabLib = global.KeepLocalCollab;
			this.ydoc = new collabLib.Y.Doc();

			const metaMap = this.ydoc.getMap("meta");
			metaMap.set("scope", this.activeScope);

			if (this.activeScope === "workspace") {
				// Workspace scope: sync file tree structure & active workspace name
				const activeWs = api?.getActiveWorkspace();
				const wsName = activeWs ? activeWs.name : "My Notes";
				metaMap.set("workspaceName", wsName);

				const filesMap = this.ydoc.getMap("files");
				const currentFiles = api?.getFiles() || [];
				filesMap.set("tree", JSON.stringify(currentFiles));

				// For current active note:
				const file = api?.getActiveFile();
				if (file) {
					this.activeFileId = file.id;
					this.yText = this.ydoc.getText(`content_${file.id}`);
					const initialContent = file.content || "";
					if (initialContent.length > 0) {
						this.yText.insert(0, initialContent);
					}
				}
			} else {
				// Note scope: sync single active document
				let file = api?.getActiveFile();
				if (!file || file.type !== "file") {
					if (typeof api?.addFileWithContent === "function") {
						file = await api.addFileWithContent("Shared_Notes.md", "");
					}
				}
				this.activeFileId = file ? file.id : null;
				this.yText = this.ydoc.getText("content");
				const initialContent = file ? (file.content || "") : "";
				if (initialContent.length > 0) {
					this.yText.insert(0, initialContent);
				}
			}

			this._setupProvider(password, strategy);
			this._bindYTextObserver();
			this._bindWorkspaceObserver();
			this._updateUIState();
			this._updateUrlHash();

			console.log(`[KeepLocalCollab] Host session started on room: ${roomId} (scope: ${this.activeScope})`);
			return true;
		}

		/**
		 * Join an existing live collaboration session (Note or Entire Workspace)
		 */
		async joinSession(roomId, password = "", strategy = "torrent", scope = "note", wsName = "") {
			if (!roomId || !roomId.trim()) return false;
			this.leaveSession();

			const cleanRoomId = roomId.trim();
			this.activeRoomId = cleanRoomId;
			this.isHost = false;
			this.activeStrategy = strategy;
			this.activeScope = scope || "note";

			const api = global.KeepLocalAPI;
			const collabLib = global.KeepLocalCollab;
			this.ydoc = new collabLib.Y.Doc();

			if (this.activeScope === "workspace") {
				// Workspace scope: ensure dedicated collaborative workspace card on Welcome screen
				if (api && typeof api.ensureCollabWorkspace === "function") {
					await api.ensureCollabWorkspace(wsName || "Shared Workspace", cleanRoomId);
				} else if (api && typeof api.ensureActiveWorkspace === "function") {
					await api.ensureActiveWorkspace();
				}
			} else {
				// Note scope: ensure active workspace and dedicated collaborative note
				if (api && typeof api.ensureActiveWorkspace === "function") {
					await api.ensureActiveWorkspace();
				}

				const expectedFileName = `Collab_${cleanRoomId}.md`;
				const allFiles = (typeof api?.getFiles === "function") ? api.getFiles() : [];
				const existingCollabFile = allFiles.find(f => f.type === "file" && f.name === expectedFileName);

				let targetFile = null;
				if (existingCollabFile) {
					if (typeof api?.openFileById === "function") {
						await api.openFileById(existingCollabFile.id);
					}
					targetFile = existingCollabFile;
				} else if (typeof api?.addFileWithContent === "function") {
					targetFile = await api.addFileWithContent(expectedFileName, "");
				} else {
					targetFile = api?.getActiveFile();
				}

				this.activeFileId = targetFile?.id || null;
				this.yText = this.ydoc.getText("content");
			}

			this._setupProvider(password, strategy);
			this._bindYTextObserver();
			this._bindWorkspaceObserver();
			this._updateUIState();
			this._updateUrlHash();

			console.log(`[KeepLocalCollab] Joined session on room: ${cleanRoomId} (scope: ${this.activeScope})`);
			return true;
		}

		_setupProvider(password, strategy) {
			this.provider = new KeepLocalTrysteroProvider(this.activeRoomId, this.ydoc, {
				strategy,
				password,
				userMeta: { ...this.userMeta, isHost: this.isHost },
				onPeersChange: (peers) => {
					this._renderPeers(peers);
					this._renderRemoteCursors(peers);
				},
				onStatusChange: (status, detail) => this._renderStatus(status, detail),
				onSyncComplete: () => {
					console.log("[KeepLocalCollab] Initial sync completed.");
				}
			});
		}

		_bindYTextObserver() {
			if (!this.yText) return;

			this.yText.observe((event, transaction) => {
				// Never re-apply if the transaction originated from local typing
				if (transaction.origin === "local" || this.isApplyingRemote) {
					return;
				}
				this._applyRemoteUpdate(event);
			});
		}

		_bindWorkspaceObserver() {
			if (!this.ydoc) return;
			const filesMap = this.ydoc.getMap("files");
			filesMap.observe((event) => {
				if (this.isHost || this.activeScope !== "workspace") return;
				const treeJson = filesMap.get("tree");
				if (!treeJson) return;
				try {
					const remoteFiles = JSON.parse(treeJson);
					const api = global.KeepLocalAPI;
					if (api && typeof api.setFileTree === "function") {
						api.setFileTree(remoteFiles);
					}
				} catch (_) { }
			});
		}

		/**
		 * Called by local editor (textarea input or Editor.js debounced save)
		 */
		handleLocalInput(newContent) {
			if (!this.isActive() || this.isApplyingRemote || !this.yText) return;
			if (this.yText.toString() === newContent) return;

			syncStringToYText(this.yText, newContent);

			// If workspace mode and host, also mirror to workspace files map
			if (this.isHost && this.activeScope === "workspace") {
				const api = global.KeepLocalAPI;
				const filesMap = this.ydoc.getMap("files");
				const currentFiles = api?.getFiles() || [];
				filesMap.set("tree", JSON.stringify(currentFiles));
			}
		}

		/**
		 * Apply incoming remote CRDT update to the current KeepLocal editor view & file
		 */
		async _applyRemoteUpdate(event) {
			const api = global.KeepLocalAPI;
			if (!api || !this.yText) return;

			// Cooldown guard to prevent Editor.js debounced onChange from re-diffing programmatic renders
			this.isApplyingRemote = true;
			clearTimeout(this._remoteApplyCooldownTimer);

			try {
				const remoteContent = this.yText.toString();
				const targetFile = api.findNode(this.activeFileId) || api.getActiveFile();
				if (targetFile && targetFile.type === "file") {
					targetFile.content = remoteContent;
				}

				const editorMode = api.getEditorMode ? api.getEditorMode() : "block";
				const textarea = api.getEditorTextarea ? api.getEditorTextarea() : document.getElementById("editor");
				const editorInstance = api.getEditorInstance ? api.getEditorInstance() : window.editorInstance;

				if (editorMode === "plain" && textarea) {
					const oldPos = textarea.selectionStart;
					const newPos = adjustCursorPosition(oldPos, event ? event.delta : []);

					if (textarea.value !== remoteContent) {
						textarea.value = remoteContent;
						textarea.setSelectionRange(newPos, newPos);
						if (typeof api.updateLineNumbers === "function") api.updateLineNumbers();
						if (typeof api.updateCodeHighlighting === "function") api.updateCodeHighlighting();
					}
				} else if (editorMode === "block" && editorInstance) {
					// Smooth surgical block patcher (ZERO FULL RE-RENDER FLICKER!)
					if (global.KeepLocalMarkdown && typeof global.KeepLocalMarkdown.textToBlocks === "function") {
						const newBlocks = global.KeepLocalMarkdown.textToBlocks(remoteContent);
						await this._patchEditorJsBlocks(editorInstance, newBlocks);
					}
				} else {
					if (typeof api.loadFile === "function") {
						await api.loadFile();
					}
				}

				// Debounced local persistence to IndexedDB & physical disk
				clearTimeout(this._saveDebounceTimer);
				this._saveDebounceTimer = setTimeout(() => {
					if (typeof api.persistCurrent === "function") api.persistCurrent();
					if (typeof api.syncWorkspace === "function") api.syncWorkspace(false);
				}, 500);
			} finally {
				// Keep guard active for 450ms so all Editor.js microtasks and onChange settle without echo
				this._remoteApplyCooldownTimer = setTimeout(() => {
					this.isApplyingRemote = false;
				}, 450);
			}
		}

		/**
		 * Surgically patches Editor.js DOM in place without calling render() on every keystroke.
		 * Prevents text from disappearing, reloading, or flickering.
		 */
		async _patchEditorJsBlocks(editorInstance, newBlocks) {
			if (!editorInstance || !Array.isArray(newBlocks)) return;
			try {
				await editorInstance.isReady;
			} catch (_) {
				return;
			}

			const domBlocks = document.querySelectorAll("#editorjs .ce-block");

			// If block count is identical, update block text in place without destroying DOM elements!
			if (domBlocks.length === newBlocks.length && domBlocks.length > 0) {
				for (let i = 0; i < newBlocks.length; i++) {
					const blockEl = domBlocks[i];
					const newBlock = newBlocks[i];
					const editable = blockEl.querySelector('[contenteditable="true"]');
					const codeArea = blockEl.querySelector(".ce-code__textarea");

					if (editable) {
						const newText = newBlock.data?.text || "";
						const currentText = editable.innerHTML.replace(/<br\s*[\/]?>$/i, "").trim();
						const incomingText = newText.replace(/<br\s*[\/]?>$/i, "").trim();
						if (currentText !== incomingText) {
							const isUserEditing = document.activeElement && blockEl.contains(document.activeElement);
							if (!isUserEditing) {
								editable.innerHTML = newText;
							} else {
								// Local user is typing in this block: preserve caret position
								const savedOffset = this._getCaretCharOffset(editable);
								editable.innerHTML = newText;
								this._setCaretCharOffset(editable, savedOffset);
							}
						}
					} else if (codeArea) {
						const newCode = newBlock.data?.code || "";
						if (codeArea.value !== newCode) {
							codeArea.value = newCode;
						}
					}
				}
				// Re-position collaborator cursors after in-place text update
				if (this.provider) {
					this._renderRemoteCursors(this.provider.getPeersList());
				}
				return;
			}

			// Block count changed (Enter pressed or block deleted): render structural change
			try {
				await editorInstance.render({ blocks: newBlocks });
				if (this.provider) {
					setTimeout(() => {
						this._renderRemoteCursors(this.provider.getPeersList());
					}, 50);
				}
			} catch (err) {
				console.warn("[KeepLocalCollab] EditorJS render error:", err);
			}
		}

		// ============================================================
		// LIVE CURSORS & HIGHLIGHTS
		// ============================================================

		_getCaretCharOffset(element) {
			let caretOffset = 0;
			if (!element) return 0;
			const doc = element.ownerDocument || element.document || document;
			const win = doc.defaultView || window;
			const sel = win.getSelection();
			if (sel && sel.rangeCount > 0) {
				try {
					const range = sel.getRangeAt(0);
					const preCaretRange = range.cloneRange();
					preCaretRange.selectNodeContents(element);
					preCaretRange.setEnd(range.startContainer, range.startOffset);
					caretOffset = preCaretRange.toString().length;
				} catch (_) { }
			}
			return caretOffset;
		}

		_createCharSpanRange(element, startChar, endChar) {
			if (!element) return null;
			let currentOffset = 0;
			const range = document.createRange();
			let startSet = false;
			let endSet = false;

			function traverse(node) {
				if (endSet) return;
				if (node.nodeType === Node.TEXT_NODE) {
					const len = node.nodeValue.length;
					if (!startSet && currentOffset + len >= startChar) {
						range.setStart(node, Math.max(0, startChar - currentOffset));
						startSet = true;
					}
					if (startSet && currentOffset + len >= endChar) {
						range.setEnd(node, Math.min(len, endChar - currentOffset));
						endSet = true;
						return;
					}
					currentOffset += len;
				} else {
					for (let i = 0; i < node.childNodes.length; i++) {
						traverse(node.childNodes[i]);
						if (endSet) return;
					}
				}
			}

			traverse(element);
			return (startSet && endSet) ? range : null;
		}

		_createRangeAtOffset(element, targetOffset) {
			if (!element) return null;
			let currentOffset = 0;
			let found = false;
			const range = document.createRange();

			function traverse(node) {
				if (found) return;
				if (node.nodeType === Node.TEXT_NODE) {
					const len = node.nodeValue.length;
					if (currentOffset + len >= targetOffset) {
						const offsetInNode = Math.min(len, Math.max(0, targetOffset - currentOffset));
						range.setStart(node, offsetInNode);
						range.setEnd(node, offsetInNode);
						found = true;
						return;
					}
					currentOffset += len;
				} else {
					for (let i = 0; i < node.childNodes.length; i++) {
						traverse(node.childNodes[i]);
						if (found) return;
					}
				}
			}

			traverse(element);

			if (!found) {
				try {
					range.selectNodeContents(element);
					range.collapse(false);
				} catch (_) {
					return null;
				}
			}
			return range;
		}

		_getCaretCoordinates(editable, targetOffset, overlayRect) {
			if (!editable || !overlayRect) return { x: 0, y: 0, h: 22 };
			const totalText = editable.textContent || "";
			const totalLen = totalText.length;
			const editRect = editable.getBoundingClientRect();
			const cs = window.getComputedStyle(editable);
			const defaultHeight = Math.max(18, parseInt(cs.lineHeight || cs.fontSize || "22", 10) || 22);

			// If block has no text:
			if (totalLen === 0) {
				return {
					x: editRect.left - overlayRect.left,
					y: editRect.top - overlayRect.top + 2,
					h: defaultHeight
				};
			}

			// If targetOffset > 0, measure the glyph immediately preceding the caret
			if (targetOffset > 0) {
				const charIndex = Math.min(targetOffset - 1, totalLen - 1);
				const range = this._createCharSpanRange(editable, charIndex, charIndex + 1);
				if (range) {
					const rect = range.getBoundingClientRect();
					if (rect && (rect.width > 0 || rect.height > 0)) {
						return {
							x: rect.right - overlayRect.left,
							y: rect.top - overlayRect.top,
							h: Math.max(16, rect.height)
						};
					}
				}
			}

			// Fallback: measure the first character
			const firstRange = this._createCharSpanRange(editable, 0, 1);
			if (firstRange) {
				const rect = firstRange.getBoundingClientRect();
				if (rect && (rect.width > 0 || rect.height > 0)) {
					return {
						x: rect.left - overlayRect.left,
						y: rect.top - overlayRect.top,
						h: Math.max(16, rect.height)
					};
				}
			}

			return {
				x: editRect.left - overlayRect.left,
				y: editRect.top - overlayRect.top + 2,
				h: defaultHeight
			};
		}

		_blockToPlainOffset(blockIndex, charOffset) {
			if (typeof document === "undefined") return charOffset;
			const allBlocks = document.querySelectorAll("#editorjs .ce-block");
			let offset = 0;
			for (let i = 0; i < blockIndex && i < allBlocks.length; i++) {
				const b = allBlocks[i];
				const text = b.textContent || "";
				offset += text.length + 2; // account for paragraph \n\n
			}
			return offset + charOffset;
		}

		_plainToBlockOffset(plainOffset) {
			if (typeof document === "undefined") return { blockIndex: 0, charOffset: plainOffset };
			const allBlocks = document.querySelectorAll("#editorjs .ce-block");
			if (allBlocks.length === 0) return { blockIndex: 0, charOffset: 0 };
			let accumulated = 0;
			for (let i = 0; i < allBlocks.length; i++) {
				const b = allBlocks[i];
				const len = (b.textContent || "").length;
				if (accumulated + len >= plainOffset) {
					return {
						blockIndex: i,
						charOffset: Math.max(0, plainOffset - accumulated)
					};
				}
				accumulated += len + 2; // account for \n\n
			}
			return {
				blockIndex: Math.max(0, allBlocks.length - 1),
				charOffset: (allBlocks[allBlocks.length - 1].textContent || "").length
			};
		}

		_setCaretCharOffset(element, targetOffset) {
			const range = this._createRangeAtOffset(element, targetOffset);
			if (range) {
				const sel = window.getSelection();
				if (sel) {
					sel.removeAllRanges();
					sel.addRange(range);
				}
			}
		}

		_initCursorTracking() {
			if (typeof document === "undefined" || this._cursorTrackingInitialized) return;
			this._cursorTrackingInitialized = true;

			let throttleTimer = null;
			const handleSelection = () => {
				if (!this.isActive() || !this.provider) return;
				if (throttleTimer) return;
				throttleTimer = setTimeout(() => {
					throttleTimer = null;
					this._captureAndBroadcastCursor();
				}, 40);
			};

			document.addEventListener("selectionchange", handleSelection);
			document.addEventListener("keyup", handleSelection);
			document.addEventListener("mouseup", handleSelection);
			document.addEventListener("input", handleSelection);
			window.addEventListener("focus", handleSelection);

			// Synchronize cursor overlay with editor scrolling & window resizing
			const editorWrapper = document.getElementById("editorjs");
			if (editorWrapper) {
				editorWrapper.addEventListener("scroll", () => {
					if (this.isActive() && this.provider) {
						this._renderRemoteCursors(this.provider.getPeersList());
					}
				});
			}

			const editorTextarea = document.getElementById("editor");
			if (editorTextarea) {
				editorTextarea.addEventListener("scroll", () => {
					if (this.isActive() && this.provider) {
						this._renderRemoteCursors(this.provider.getPeersList());
					}
				});
			}

			if (typeof ResizeObserver !== "undefined") {
				const container = document.querySelector(".editor-container");
				if (container) {
					new ResizeObserver(() => {
						if (this.isActive() && this.provider) {
							this._renderRemoteCursors(this.provider.getPeersList());
						}
					}).observe(container);
				}
			}

			window.addEventListener("resize", () => {
				if (this.isActive() && this.provider) {
					this._renderRemoteCursors(this.provider.getPeersList());
				}
			});
		}

		_captureAndBroadcastCursor() {
			if (!this.isActive() || !this.provider) return;
			const api = global.KeepLocalAPI;
			if (!api) return;

			const editorMode = api.getEditorMode ? api.getEditorMode() : "block";
			const activeFile = api.getActiveFile ? api.getActiveFile() : null;

			if (editorMode === "plain") {
				const textarea = api.getEditorTextarea ? api.getEditorTextarea() : document.getElementById("editor");
				if (!textarea || document.activeElement !== textarea) return;

				const selStart = textarea.selectionStart;
				const selEnd = textarea.selectionEnd;

				this.provider.broadcastAwareness({
					cursor: {
						mode: "plain",
						charOffset: selStart,
						selLength: Math.max(0, selEnd - selStart),
						fileName: activeFile ? activeFile.name : "",
						updatedAt: Date.now()
					}
				});
			} else {
				// Block Mode (Editor.js)
				const sel = window.getSelection();
				if (!sel || sel.rangeCount === 0) return;
				const editorEl = document.getElementById("editorjs");
				if (!editorEl || !editorEl.contains(sel.anchorNode)) return;

				const activeBlock = (sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode.closest(".ce-block") : sel.anchorNode.parentElement?.closest(".ce-block")) : null)
					|| document.activeElement?.closest(".ce-block");
				if (!activeBlock) return;

				const allBlocks = Array.from(document.querySelectorAll("#editorjs .ce-block"));
				const blockIndex = allBlocks.indexOf(activeBlock);
				const editable = activeBlock.querySelector('[contenteditable="true"]') || activeBlock;
				const charOffset = this._getCaretCharOffset(editable);

				const selLength = sel.isCollapsed ? 0 : (sel.toString() ? sel.toString().length : 0);

				this.provider.broadcastAwareness({
					cursor: {
						mode: "block",
						blockIndex: blockIndex >= 0 ? blockIndex : 0,
						charOffset,
						selLength,
						fileName: activeFile ? activeFile.name : "",
						updatedAt: Date.now()
					}
				});
			}
		}

		_renderRemoteCursors(peers) {
			const api = global.KeepLocalAPI;
			const overlay = document.getElementById("collabCursorOverlay");
			if (!overlay) return;

			overlay.innerHTML = "";
			const editorMode = api?.getEditorMode ? api.getEditorMode() : "block";
			const activeFile = api?.getActiveFile ? api.getActiveFile() : null;

			document.querySelectorAll(".ce-block.collab-peer-active").forEach(el => {
				el.classList.remove("collab-peer-active");
				el.style.removeProperty("--peer-color");
			});

			const now = Date.now();
			const overlayRect = overlay.getBoundingClientRect();

			for (const peer of peers) {
				const cur = peer.cursor;
				// Filter stale cursors (> 45s)
				if (!cur || (now - (cur.updatedAt || 0) > 45000)) continue;

				// In workspace mode, ensure peer is on the same file
				if (this.activeScope === "workspace" && cur.fileName && activeFile && cur.fileName !== activeFile.name) {
					continue;
				}

				if (editorMode === "block") {
					const allBlocks = document.querySelectorAll("#editorjs .ce-block");
					if (allBlocks.length === 0) continue;

					let blockIdx = cur.blockIndex || 0;
					let charOff = cur.charOffset || 0;

					if (cur.mode === "plain") {
						const mapped = this._plainToBlockOffset(cur.charOffset || 0);
						blockIdx = mapped.blockIndex;
						charOff = mapped.charOffset;
					}

					const targetIdx = Math.min(Math.max(0, blockIdx), allBlocks.length - 1);
					const targetBlock = allBlocks[targetIdx];
					if (!targetBlock) continue;

					targetBlock.classList.add("collab-peer-active");
					targetBlock.style.setProperty("--peer-color", peer.color);

					const editable = targetBlock.querySelector('[contenteditable="true"]') || targetBlock;
					const coords = this._getCaretCoordinates(editable, charOff, overlayRect);

					// Render selection highlight if any
					if (cur.selLength > 0) {
						const selStart = charOff;
						const selEnd = charOff + cur.selLength;
						const selRange = this._createCharSpanRange(editable, selStart, selEnd);
						if (selRange) {
							const rects = selRange.getClientRects();
							for (let i = 0; i < rects.length; i++) {
								const r = rects[i];
								if (r.width > 0 && r.height > 0) {
									const selBox = document.createElement("div");
									selBox.className = "collab-remote-selection";
									selBox.style.left = `${r.left - overlayRect.left}px`;
									selBox.style.top = `${r.top - overlayRect.top}px`;
									selBox.style.width = `${r.width}px`;
									selBox.style.height = `${r.height}px`;
									selBox.style.setProperty("--peer-color-translucent", hexToRgba(peer.color, 0.28));
									overlay.appendChild(selBox);
								}
							}
						}
					}

					this._renderCaretElement(overlay, coords.x, coords.y, coords.h, peer);

				} else if (editorMode === "plain") {
					const textarea = api?.getEditorTextarea ? api.getEditorTextarea() : document.getElementById("editor");
					if (!textarea) continue;

					let plainCharOff = cur.charOffset || 0;
					if (cur.mode === "block") {
						plainCharOff = this._blockToPlainOffset(cur.blockIndex || 0, cur.charOffset || 0);
					}

					const coords = getTextareaCaretCoordinates(textarea, plainCharOff);
					const taRect = textarea.getBoundingClientRect();
					const x = (taRect.left - overlayRect.left) + coords.left - textarea.scrollLeft;
					const y = (taRect.top - overlayRect.top) + coords.top - textarea.scrollTop;
					const h = coords.height || 20;

					this._renderCaretElement(overlay, x, y, h, peer);
				}
			}
		}

		_renderCaretElement(overlay, x, y, h, peer) {
			const caretEl = document.createElement("div");
			caretEl.className = "collab-remote-cursor";
			if (y < 26) {
				caretEl.classList.add("flag-down");
			}
			caretEl.style.left = `${x}px`;
			caretEl.style.top = `${y}px`;
			caretEl.style.height = `${h}px`;
			caretEl.style.setProperty("--peer-color", peer.color);

			const flagEl = document.createElement("div");
			flagEl.className = "collab-remote-flag";
			flagEl.style.setProperty("--peer-color", peer.color);

			const initial = (peer.name || "P").charAt(0).toUpperCase();
			flagEl.innerHTML = `<span class="collab-remote-avatar">${initial}</span><span>${peer.name || "Peer"}</span>`;

			caretEl.appendChild(flagEl);
			overlay.appendChild(caretEl);
		}

		/**
		 * Leave current collaboration room
		 */
		leaveSession() {
			if (this.provider) {
				this.provider.destroy();
				this.provider = null;
			}
			this.ydoc = null;
			this.yText = null;
			this.activeRoomId = null;
			this.activeFileId = null;
			this.isHost = false;

			const overlay = document.getElementById("collabCursorOverlay");
			if (overlay) overlay.innerHTML = "";

			document.querySelectorAll(".ce-block.collab-peer-active").forEach(el => {
				el.classList.remove("collab-peer-active");
				el.style.removeProperty("--peer-color");
			});

			this._updateUIState();
			this._cleanUrlHash();
			console.log("[KeepLocalCollab] Session closed.");
		}

		// ============================================================
		// UI & PRESENCE INTEGRATION
		// ============================================================

		_updateUIState() {
			const badge = document.getElementById("collabActiveBadge");
			const statusBadge = document.getElementById("collabStatusBadge");
			const collabBtn = document.getElementById("collabBtn");

			if (this.isActive()) {
				if (badge) badge.classList.remove("hidden");
				if (statusBadge) {
					statusBadge.classList.remove("hidden");
					statusBadge.textContent = `P2P: 0 peers`;
				}
				if (collabBtn) collabBtn.classList.add("active");
			} else {
				if (badge) badge.classList.add("hidden");
				if (statusBadge) statusBadge.classList.add("hidden");
				if (collabBtn) collabBtn.classList.remove("active");
			}
		}

		_renderStatus(status, detail) {
			const statusBadge = document.getElementById("collabStatusBadge");
			const peerCountSpan = document.getElementById("collabPeerCount");

			if (!statusBadge || !this.isActive()) return;

			if (status === "connecting") {
				statusBadge.textContent = "Connecting P2P…";
				statusBadge.style.color = "var(--text-muted)";
			} else if (status === "connected") {
				const count = typeof detail === "number" ? detail : this.provider?.getPeerCount() || 0;
				statusBadge.textContent = `P2P: ${count} peer${count === 1 ? "" : "s"}`;
				statusBadge.style.color = count > 0 ? "var(--accent-color)" : "var(--text-muted)";
				if (peerCountSpan) {
					peerCountSpan.textContent = `${count + 1} online`;
				}
			} else if (status === "error") {
				statusBadge.textContent = "P2P Error";
				statusBadge.style.color = "var(--danger)";
			} else {
				statusBadge.textContent = "P2P Off";
			}
		}

		_renderPeers(peers) {
			const peersListEl = document.getElementById("collabPeersList");
			const peerAvatarsEl = document.getElementById("collabPeerAvatars");

			if (peersListEl) {
				peersListEl.innerHTML = "";
				// Add self
				const selfItem = document.createElement("div");
				selfItem.className = "collab-peer-item";
				selfItem.innerHTML = `
					<span class="collab-peer-dot" style="background:${this.userMeta.color}"></span>
					<span class="collab-peer-name">${this.userMeta.name} <b>(You)</b></span>
					${this.isHost ? '<span class="collab-peer-role">Host</span>' : ""}
				`;
				peersListEl.appendChild(selfItem);

				// Add peers
				peers.forEach((p) => {
					const item = document.createElement("div");
					item.className = "collab-peer-item";
					item.innerHTML = `
						<span class="collab-peer-dot" style="background:${p.color}"></span>
						<span class="collab-peer-name">${p.name || "Anonymous Peer"}</span>
						${p.isHost ? '<span class="collab-peer-role">Host</span>' : ""}
					`;
					peersListEl.appendChild(item);
				});
			}

			if (peerAvatarsEl) {
				peerAvatarsEl.innerHTML = "";
				// Render avatar bubbles in top bar
				peers.slice(0, 4).forEach((p) => {
					const dot = document.createElement("div");
					dot.className = "collab-avatar-bubble";
					dot.style.borderColor = p.color;
					dot.title = p.name;
					dot.textContent = (p.name || "P").charAt(0).toUpperCase();
					peerAvatarsEl.appendChild(dot);
				});
			}

			this._renderStatus("connected", peers.length);
		}

		_updateUrlHash() {
			if (!this.activeRoomId) return;
			const hash = `#/collab/${this.activeScope}/${encodeURIComponent(this.activeRoomId)}`;
			if (window.location.hash !== hash) {
				window.history.replaceState(null, "", hash);
			}
		}

		_cleanUrlHash() {
			if (window.location.hash.startsWith("#/collab/")) {
				window.history.replaceState(null, "", window.location.pathname + window.location.search);
			}
		}

		/**
		 * Parse room information from URL on app launch
		 */
		checkUrlForSession() {
			const hash = window.location.hash;
			const search = window.location.search;

			let roomId = null;
			let scope = "note";
			let password = "";
			let wsName = "";

			if (hash.startsWith("#/collab/")) {
				const afterHash = hash.replace("#/collab/", "").trim();
				let queryPart = "";
				let pathPart = afterHash;

				if (afterHash.includes("?")) {
					const parts = afterHash.split("?");
					pathPart = parts[0];
					queryPart = parts[1];
				}

				if (pathPart.startsWith("workspace/")) {
					scope = "workspace";
					roomId = decodeURIComponent(pathPart.replace("workspace/", ""));
				} else if (pathPart.startsWith("note/")) {
					scope = "note";
					roomId = decodeURIComponent(pathPart.replace("note/", ""));
				} else {
					roomId = decodeURIComponent(pathPart);
				}

				if (queryPart) {
					const params = new URLSearchParams(queryPart);
					if (params.get("key")) password = params.get("key");
					if (params.get("name")) wsName = params.get("name");
					if (params.get("scope")) scope = params.get("scope");
				}
			} else if (search.includes("collab=")) {
				const params = new URLSearchParams(search);
				roomId = params.get("collab");
				password = params.get("key") || "";
				scope = params.get("scope") || "note";
				wsName = params.get("name") || "";
			}

			if (roomId) {
				setTimeout(() => {
					this.openModal({ initialRoomId: roomId, initialPassword: password, scope, wsName });
				}, 400);
			}
		}

		// ============================================================
		// MODAL CONTROLS
		// ============================================================

		openModal(preset = {}) {
			const modal = document.getElementById("collabModalOverlay");
			if (!modal) return;

			const insecureBanner = document.getElementById("collabInsecureBanner");
			const localhostLink = document.getElementById("collabLocalhostLink");
			if (insecureBanner) {
				const isLanIp = typeof window !== "undefined" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";
				const isSecure = (typeof window !== "undefined" && window.isSecureContext) || (typeof crypto !== "undefined" && !!crypto?.subtle);
				if (!isSecure && isLanIp) {
					insecureBanner.classList.remove("hidden");
					if (localhostLink) {
						localhostLink.href = `http://localhost:${window.location.port || 8000}${window.location.pathname}${window.location.search}${window.location.hash}`;
					}
				} else {
					insecureBanner.classList.add("hidden");
				}
			}

			const hostTab = document.getElementById("collabTabHost");
			const joinTab = document.getElementById("collabTabJoin");
			const hostSection = document.getElementById("collabHostSection");
			const joinSection = document.getElementById("collabJoinSection");
			const activeSection = document.getElementById("collabActiveSection");

			const hostRoomInput = document.getElementById("collabHostRoomId");
			const joinRoomInput = document.getElementById("collabJoinRoomId");
			const joinPassInput = document.getElementById("collabJoinPassword");
			const nameInput = document.getElementById("collabUserNameInput");

			// Update scope description labels dynamically
			const api = global.KeepLocalAPI;
			const activeFile = api?.getActiveFile();
			const activeWs = api?.getActiveWorkspace ? api.getActiveWorkspace() : null;
			const noteDesc = document.getElementById("collabScopeNoteDesc");
			const wsDesc = document.getElementById("collabScopeWorkspaceDesc");

			if (noteDesc) {
				noteDesc.textContent = activeFile ? `Collaborate on: ${activeFile.name}` : "Collaborate on open document";
			}
			if (wsDesc) {
				wsDesc.textContent = activeWs ? `Sync all notes in "${activeWs.name}"` : "Sync all notes & folders";
			}

			if (nameInput) nameInput.value = this.userMeta.name;

			if (this.isActive()) {
				// Show Active Session details
				if (hostTab) hostTab.classList.add("hidden");
				if (joinTab) joinTab.classList.add("hidden");
				if (hostSection) hostSection.classList.add("hidden");
				if (joinSection) joinSection.classList.add("hidden");
				if (activeSection) activeSection.classList.remove("hidden");

				const activeRoomSpan = document.getElementById("collabActiveRoomText");
				if (activeRoomSpan) activeRoomSpan.textContent = `${this.activeRoomId} (${this.activeScope})`;
				this._renderPeers(this.provider ? this.provider.getPeersList() : []);
			} else {
				if (hostTab) hostTab.classList.remove("hidden");
				if (joinTab) joinTab.classList.remove("hidden");
				if (activeSection) activeSection.classList.add("hidden");

				if (preset.initialRoomId || preset.tab === "join") {
					// Switch to join tab
					if (hostTab) hostTab.classList.remove("active");
					if (joinTab) joinTab.classList.add("active");
					if (hostSection) hostSection.classList.add("hidden");
					if (joinSection) joinSection.classList.remove("hidden");
					if (joinRoomInput && preset.initialRoomId) joinRoomInput.value = preset.initialRoomId;
					if (joinPassInput && preset.initialPassword) joinPassInput.value = preset.initialPassword;
				} else {
					// Switch to host tab by default with generated room ID
					if (hostTab) hostTab.classList.add("active");
					if (joinTab) joinTab.classList.remove("active");
					if (hostSection) hostSection.classList.remove("hidden");
					if (joinSection) joinSection.classList.add("hidden");

					const randomSlug = "room-" + Math.random().toString(36).slice(2, 8);
					if (hostRoomInput) hostRoomInput.value = randomSlug;
				}
			}

			modal.classList.add("active");
			if (window.lucide) window.lucide.createIcons();
		}

		closeModal() {
			const modal = document.getElementById("collabModalOverlay");
			if (modal) modal.classList.remove("active");
		}
	}

	// ============================================================
	// GLOBAL UI ACTIONS (Window Handlers)
	// ============================================================

	global.switchCollabTab = function (tab) {
		const hostTab = document.getElementById("collabTabHost");
		const joinTab = document.getElementById("collabTabJoin");
		const hostSection = document.getElementById("collabHostSection");
		const joinSection = document.getElementById("collabJoinSection");

		if (tab === "host") {
			if (hostTab) hostTab.classList.add("active");
			if (joinTab) joinTab.classList.remove("active");
			if (hostSection) hostSection.classList.remove("hidden");
			if (joinSection) joinSection.classList.add("hidden");
		} else {
			if (hostTab) hostTab.classList.remove("active");
			if (joinTab) joinTab.classList.add("active");
			if (hostSection) hostSection.classList.add("hidden");
			if (joinSection) joinSection.classList.remove("hidden");
		}
	};

	global.generateNewRoomCode = function () {
		const hostRoomInput = document.getElementById("collabHostRoomId");
		if (hostRoomInput) {
			hostRoomInput.value = "room-" + Math.random().toString(36).slice(2, 8);
		}
	};

	global.startHostCollabFromModal = async function () {
		const nameInput = document.getElementById("collabUserNameInput");
		const roomInput = document.getElementById("collabHostRoomId");
		const passInput = document.getElementById("collabHostPassword");
		const stratInput = document.getElementById("collabHostStrategy");

		if (nameInput && nameInput.value.trim()) {
			global.KeepLocalCollabManager.saveUserMeta({ name: nameInput.value.trim() });
		}

		const roomId = roomInput?.value.trim() || ("room-" + Math.random().toString(36).slice(2, 8));
		const password = passInput?.value.trim() || "";
		const strategy = stratInput?.value || "torrent";
		const scope = global.KeepLocalCollabManager.getScope() || "note";

		const success = await global.KeepLocalCollabManager.startHostSession(roomId, password, strategy, scope);
		if (success) {
			const api = global.KeepLocalAPI;
			const ws = api?.getActiveWorkspace ? api.getActiveWorkspace() : null;
			const wsParam = (scope === "workspace" && ws) ? `?name=${encodeURIComponent(ws.name)}` : "";
			const passParam = password ? `${wsParam ? "&" : "?"}key=${encodeURIComponent(password)}` : "";

			const link = `${window.location.origin}${window.location.pathname}#/collab/${scope}/${encodeURIComponent(roomId)}${wsParam}${passParam}`;
			const linkInput = document.getElementById("collabShareLinkInput");
			if (linkInput) linkInput.value = link;

			// Switch view to active
			const hostTab = document.getElementById("collabTabHost");
			const joinTab = document.getElementById("collabTabJoin");
			const hostSection = document.getElementById("collabHostSection");
			const joinSection = document.getElementById("collabJoinSection");
			const activeSection = document.getElementById("collabActiveSection");
			if (hostTab) hostTab.classList.add("hidden");
			if (joinTab) joinTab.classList.add("hidden");
			if (hostSection) hostSection.classList.add("hidden");
			if (joinSection) joinSection.classList.add("hidden");
			if (activeSection) activeSection.classList.remove("hidden");

			const activeRoomSpan = document.getElementById("collabActiveRoomText");
			if (activeRoomSpan) activeRoomSpan.textContent = `${roomId} (${scope})`;
			if (window.lucide) window.lucide.createIcons();
		}
	};

	global.joinCollabFromModal = async function () {
		const nameInput = document.getElementById("collabUserNameInput");
		const roomInput = document.getElementById("collabJoinRoomId");
		const passInput = document.getElementById("collabJoinPassword");
		const stratInput = document.getElementById("collabJoinStrategy");

		if (nameInput && nameInput.value.trim()) {
			global.KeepLocalCollabManager.saveUserMeta({ name: nameInput.value.trim() });
		}

		let raw = roomInput?.value.trim() || "";
		if (!raw) {
			alert("Please enter a Room ID or paste an invite link.");
			return;
		}

		let roomId = raw;
		let scope = "note";
		let password = passInput?.value.trim() || "";
		let wsName = "";

		// If user pasted a full URL
		if (raw.includes("#/collab/")) {
			const parts = raw.split("#/collab/");
			const afterHash = parts[1];
			let pathPart = afterHash;
			let queryPart = "";

			if (afterHash.includes("?")) {
				const splitQuery = afterHash.split("?");
				pathPart = splitQuery[0];
				queryPart = splitQuery[1];
			}

			if (pathPart.startsWith("workspace/")) {
				scope = "workspace";
				roomId = decodeURIComponent(pathPart.replace("workspace/", ""));
			} else if (pathPart.startsWith("note/")) {
				scope = "note";
				roomId = decodeURIComponent(pathPart.replace("note/", ""));
			} else {
				roomId = decodeURIComponent(pathPart);
			}

			if (queryPart) {
				const params = new URLSearchParams(queryPart);
				if (params.get("key")) password = params.get("key");
				if (params.get("name")) wsName = params.get("name");
				if (params.get("scope")) scope = params.get("scope");
			}
		}

		const strategy = stratInput?.value || "torrent";
		const success = await global.KeepLocalCollabManager.joinSession(roomId, password, strategy, scope, wsName);
		if (success) {
			const link = `${window.location.origin}${window.location.pathname}#/collab/${scope}/${encodeURIComponent(roomId)}${password ? "?key=" + encodeURIComponent(password) : ""}`;
			const linkInput = document.getElementById("collabShareLinkInput");
			if (linkInput) linkInput.value = link;

			// Close modal immediately so the user can interact directly with the collaborative canvas
			global.KeepLocalCollabManager.closeModal();
		}
	};

	global.copyCollabInviteLink = function () {
		const linkInput = document.getElementById("collabShareLinkInput");
		const copyBtn = document.getElementById("collabCopyLinkBtn");
		if (!linkInput) return;

		const showSuccess = () => {
			if (copyBtn) {
				const originalHtml = copyBtn.innerHTML;
				copyBtn.innerHTML = '<i data-lucide="check" size="13"></i> <span>Copied!</span>';
				if (window.lucide) window.lucide.createIcons();
				setTimeout(() => {
					copyBtn.innerHTML = originalHtml;
					if (window.lucide) window.lucide.createIcons();
				}, 2000);
			}
		};

		linkInput.focus();
		linkInput.select();

		if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
			navigator.clipboard.writeText(linkInput.value).then(showSuccess).catch(() => {
				fallbackExecCommand();
			});
		} else {
			fallbackExecCommand();
		}

		function fallbackExecCommand() {
			try {
				const success = document.execCommand("copy");
				if (success) {
					showSuccess();
				} else {
					prompt("Copy link:", linkInput.value);
				}
			} catch (_) {
				prompt("Copy link:", linkInput.value);
			}
		}
	};

	global.leaveCollabFromModal = function () {
		global.KeepLocalCollabManager.leaveSession();
		global.KeepLocalCollabManager.closeModal();
	};

	// Attach to global scope
	global.KeepLocalCollab = global.KeepLocalCollab || {};
	global.KeepLocalCollab.Provider = KeepLocalTrysteroProvider;
	global.KeepLocalCollab.Manager = KeepLocalCollabManager;
	global.KeepLocalCollabManager = new KeepLocalCollabManager();

	// Initialize after DOM ready
	if (typeof document !== "undefined") {
		document.addEventListener("DOMContentLoaded", () => {
			global.KeepLocalCollabManager.checkUrlForSession();
		});
	}

})(typeof window !== "undefined" ? window : globalThis);
