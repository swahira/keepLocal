/* ============================================================
   KEEPLOCAL — markdown.js
   Modular Markdown Engine & Editor.js Bridge
   Zero-ReDoS parsing, image optimization, block serialization.
   ============================================================ */

(function (global) {
	"use strict";

	function isMarkdownFile(filename) {
		if (!filename) return false;
		const ext = filename.split(".").pop()?.toLowerCase();
		return ext === "md" || ext === "markdown";
	}

	function escHtml(s) {
		if (!s) return "";
		return s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	function sanitizeUrl(url) {
		if (!url) return "#";
		const trimmed = url.trim();
		// Disallow protocol-relative URLs (e.g. //evil.com)
		if (trimmed.startsWith("//")) {
			return "#";
		}
		// Allow safe web schemes and relative anchors/paths
		if (/^(?:(?:https?|mailto|tel):|\/|\.\/|\.\.\/|#)/i.test(trimmed)) {
			return trimmed;
		}
		// Allow blob URLs
		if (/^blob:(?:https?:\/\/|null\/)/i.test(trimmed) || trimmed.startsWith("blob:")) {
			return trimmed;
		}
		// Allow image data URIs (prefix check to avoid catastrophic regex backtracking on large payloads)
		if (/^data:image\/(?:png|jpeg|jpg|gif|svg\+xml|webp|ico|avif);base64,/i.test(trimmed)) {
			return trimmed;
		}
		// Allow relative paths without scheme (e.g. attachments/image.webp, assets/photo.png)
		// Must not have a URI scheme (like javascript:, vbscript:, data:) and must not start with "//"
		if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith("//")) {
			return trimmed;
		}
		return "#";
	}

	function parseStandaloneImage(str) {
		if (!str) return null;
		const t = str.trim();
		if (!t.startsWith("![") || !t.endsWith(")")) return null;
		const bracketEnd = t.indexOf("](");
		if (bracketEnd === -1) return null;
		const alt = t.slice(2, bracketEnd);
		if (alt.includes("[") || alt.includes("]")) return null;
		const url = t.slice(bracketEnd + 2, -1).trim();
		if (!url) return null;
		return { alt, url };
	}

	function replaceMarkdownLinksAndImages(text, sanitizeUrlFn) {
		if (!text) return "";
		let result = "";
		let i = 0;
		const len = text.length;

		while (i < len) {
			const isImage = (text[i] === "!" && text[i + 1] === "[");
			const isLink = (text[i] === "[");

			if (!isImage && !isLink) {
				result += text[i];
				i++;
				continue;
			}

			const bracketStart = isImage ? i + 1 : i;
			let bracketDepth = 0;
			let bracketEnd = -1;

			for (let k = bracketStart; k < len; k++) {
				if (text[k] === "\n") break;
				if (text[k] === "[") bracketDepth++;
				else if (text[k] === "]") {
					bracketDepth--;
					if (bracketDepth === 0) {
						bracketEnd = k;
						break;
					}
				}
			}

			if (bracketEnd === -1 || bracketEnd + 1 >= len || text[bracketEnd + 1] !== "(") {
				result += text[i];
				i++;
				continue;
			}

			const rawLabel = text.slice(bracketStart + 1, bracketEnd);
			let parenDepth = 1;
			let urlEnd = -1;
			let j = bracketEnd + 2;

			while (j < len) {
				const char = text[j];
				if (char === "\n") break;
				if (char === "(") {
					parenDepth++;
				} else if (char === ")") {
					parenDepth--;
					if (parenDepth === 0) {
						urlEnd = j;
						break;
					}
				}
				j++;
			}

			if (urlEnd === -1) {
				result += text[i];
				i++;
				continue;
			}

			let rawUrl = text.slice(bracketEnd + 2, urlEnd).trim();
			const titleMatch = rawUrl.match(/^<?([^\s>]+)>?(?:\s+["\x27](.*)["\x27])?$/);
			const url = titleMatch ? titleMatch[1] : rawUrl;
			const safeUrl = sanitizeUrlFn ? sanitizeUrlFn(url) : url;

			if (isImage) {
				if (safeUrl === "#") {
					result += rawLabel;
				} else {
					const displayUrl = (typeof window !== "undefined" && typeof window.resolveAttachmentUrl === "function")
						? (window.resolveAttachmentUrl(safeUrl) || safeUrl)
						: safeUrl;
					result += `<img src="${displayUrl}" alt="${rawLabel}" style="max-width:100%; border-radius:6px; margin:4px 0;" />`;
				}
			} else {
				const labelHtml = isImage ? rawLabel : replaceMarkdownLinksAndImages(rawLabel, sanitizeUrlFn);
				if (safeUrl === "#") {
					result += `<a href="#" rel="noopener" onclick="return false;">${labelHtml}</a>`;
				} else {
					result += `<a href="${safeUrl}" target="_blank" rel="noopener">${labelHtml}</a>`;
				}
			}

			i = urlEnd + 1;
		}

		return result;
	}

	async function compressDataUrl(dataUrl, maxWidth = 1200, maxHeight = 1200, quality = 0.78) {
		if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
			return dataUrl;
		}
		if (dataUrl.startsWith("data:image/svg+xml")) return dataUrl;
		if (dataUrl.length < 80 * 1024) return dataUrl;

		if (typeof Image === "undefined" || typeof document === "undefined") {
			return dataUrl; // Non-browser environment
		}

		return new Promise((resolve) => {
			const img = new Image();
			img.onload = () => {
				let { width, height } = img;
				if (width > maxWidth || height > maxHeight) {
					const ratio = Math.min(maxWidth / width, maxHeight / height);
					width = Math.round(width * ratio);
					height = Math.round(height * ratio);
				}
				const canvas = document.createElement("canvas");
				canvas.width = Math.max(1, width);
				canvas.height = Math.max(1, height);
				const ctx = canvas.getContext("2d");
				ctx.drawImage(img, 0, 0, width, height);

				let result = "";
				try {
					result = canvas.toDataURL("image/webp", quality);
					if (!result.startsWith("data:image/webp")) {
						result = canvas.toDataURL("image/jpeg", quality);
					}
				} catch (_) {
					try { result = canvas.toDataURL("image/jpeg", quality); } catch (_) { result = dataUrl; }
				}
				resolve((result && result.length < dataUrl.length) ? result : dataUrl);
			};
			img.onerror = () => resolve(dataUrl);
			img.src = dataUrl;
		});
	}

	async function compressImageFile(file, maxWidth = 1200, maxHeight = 1200, quality = 0.78) {
		if (!file || !file.type.startsWith("image/")) {
			return { url: "", caption: file?.name || "image" };
		}
		if (file.type === "image/svg+xml") {
			if (file.size < 150 * 1024) {
				return new Promise((resolve) => {
					const reader = new FileReader();
					reader.onload = () => resolve({ url: reader.result, caption: file.name || "image" });
					reader.onerror = () => resolve({ url: "", caption: file.name || "image" });
					reader.readAsDataURL(file);
				});
			}
		}
		if (typeof Image === "undefined" || typeof document === "undefined") {
			return { url: "", caption: file.name || "image" };
		}
		return new Promise((resolve) => {
			const img = new Image();
			const url = URL.createObjectURL(file);
			img.onload = () => {
				URL.revokeObjectURL(url);
				let { width, height } = img;
				if (width > maxWidth || height > maxHeight) {
					const ratio = Math.min(maxWidth / width, maxHeight / height);
					width = Math.round(width * ratio);
					height = Math.round(height * ratio);
				}
				const canvas = document.createElement("canvas");
				canvas.width = Math.max(1, width);
				canvas.height = Math.max(1, height);
				const ctx = canvas.getContext("2d");
				ctx.drawImage(img, 0, 0, width, height);

				let dataUrl = "";
				try {
					dataUrl = canvas.toDataURL("image/webp", quality);
					if (!dataUrl.startsWith("data:image/webp")) {
						dataUrl = canvas.toDataURL("image/jpeg", quality);
					}
				} catch (_) {
					try { dataUrl = canvas.toDataURL("image/jpeg", quality); } catch (_) { dataUrl = ""; }
				}
				resolve({ url: dataUrl, caption: file.name || "image" });
			};
			img.onerror = () => {
				URL.revokeObjectURL(url);
				const reader = new FileReader();
				reader.onload = () => resolve({ url: reader.result, caption: file.name || "image" });
				reader.onerror = () => resolve({ url: "", caption: file.name || "image" });
				reader.readAsDataURL(file);
			};
			img.src = url;
		});
	}

	function md2h(s) {
		if (!s) return "";
		let res = escHtml(s);
		res = res.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/gi, '<u class="cdx-underline">$1</u>');
		res = res.replace(/&lt;mark(?: class="cdx-marker")?&gt;(.*?)&lt;\/mark&gt;/gi, '<mark class="cdx-marker">$1</mark>');
		res = res.replace(/==([^=]+)==/g, '<mark class="cdx-marker">$1</mark>');
		res = replaceMarkdownLinksAndImages(res, sanitizeUrl);

		// Mask HTML tags to avoid corrupting attributes
		const tagPlaceholders = [];
		res = res.replace(/<[^>]+>/g, (tag) => {
			const id = "\x00" + tagPlaceholders.length + "\x01";
			tagPlaceholders.push(tag);
			return id;
		});

		// Mask inline code first so asterisks/underscores inside backticks are never parsed as emphasis
		const codePlaceholders = [];
		res = res.replace(/`([^`]+)`/g, (_, code) => {
			const id = "\x02" + codePlaceholders.length + "\x03";
			codePlaceholders.push(`<code>${code}</code>`);
			return id;
		});

		// Apply bold and italics (with non-whitespace boundary guards to prevent parsing math e.g. a * b * c)
		res = res.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>").replace(/__(.*?)__/g, "<b>$1</b>")
			.replace(/(^|[\s.,!?;:()\[\]{}'"])\*(\S(?:.*?\S)?)\*(?=[\s.,!?;:()\[\]{}'"]|$)/g, "$1<i>$2</i>")
			.replace(/(^|[\s.,!?;:()\[\]{}'"])_(\S(?:.*?\S)?)_(?=[\s.,!?;:()\[\]{}'"]|$)/g, "$1<i>$2</i>");

		// Restore inline code
		if (codePlaceholders.length) {
			res = res.replace(/\x02(\d+)\x03/g, (_, idx) => codePlaceholders[Number(idx)]);
		}

		// Restore HTML tags
		if (tagPlaceholders.length) {
			res = res.replace(/\x00(\d+)\x01/g, (_, idx) => tagPlaceholders[Number(idx)]);
		}

		return res;
	}

	function h2md(s) {
		if (!s) return "";
		const cleanImgSrc = (src) => {
			if (src && src.startsWith("blob:") && typeof window !== "undefined" && window.attachmentBlobUrlMap) {
				for (const [key, val] of window.attachmentBlobUrlMap.entries()) {
					if (val === src && key.startsWith("attachments/")) return key;
				}
			}
			return src;
		};
		return s
			.replace(/<img\s+[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, (_, src, alt) => `![${alt}](${cleanImgSrc(src)})`)
			.replace(/<img\s+[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>/gi, (_, alt, src) => `![${alt}](${cleanImgSrc(src)})`)
			.replace(/<img\s+[^>]*src="([^"]*)"[^>]*>/gi, (_, src) => `![](${cleanImgSrc(src)})`)
			.replace(/<a [^>]*href="(.*?)"[^>]*>(.*?)<\/a>/gi, (match, url, text) => {
				if (url === "#") return text;
				return `[${text}](${url})`;
			})
			.replace(/<mark[^>]*>(.*?)<\/mark>/gi, "==$1==")
			.replace(/<u[^>]*>(.*?)<\/u>/gi, "%%%U_OPEN%%%$1%%%U_CLOSE%%%")
			.replace(/<b>(.*?)<\/b>/gi, "**$1**").replace(/<strong>(.*?)<\/strong>/gi, "**$1**")
			.replace(/<i>(.*?)<\/i>/gi, "*$1*").replace(/<em>(.*?)<\/em>/gi, "*$1*")
			.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/&nbsp;/g, " ")
			.replace(/&(?:#39|#039);/g, "'")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/<[^>]+>/g, "")
			.replace(/%%%U_OPEN%%%/g, "<u>").replace(/%%%U_CLOSE%%%/g, "</u>");
	}

	function serializeBlockLines(b) {
		const lines = [];
		switch (b.type) {
			case "header":
				lines.push("#".repeat(b.data?.level || 1) + " " + h2md(b.data?.text || ""));
				break;
			case "paragraph":
				lines.push(h2md(b.data?.text || ""));
				break;
			case "delimiter":
				lines.push("---");
				break;
			case "image": {
				const cap = h2md(b.data?.caption || "").trim();
				lines.push(`![${cap}](${b.data?.url || ""})`);
				break;
			}
			case "warning": {
				const alertType = (b.data?.alertType || "NOTE").toUpperCase();
				const defaultTitle = alertType.charAt(0) + alertType.slice(1).toLowerCase();
				const title = h2md(b.data?.title || "").trim();
				const msg = h2md(b.data?.message || "").trim();
				if (title && title.toLowerCase() !== defaultTitle.toLowerCase() && title.toLowerCase() !== "note") {
					lines.push(`> [!${alertType}] ${title}`);
				} else {
					lines.push(`> [!${alertType}]`);
				}
				if (msg) {
					msg.split("\n").forEach(l => lines.push(`> ${l}`));
				}
				break;
			}
			case "quote": {
				const qt = h2md(b.data?.text || "");
				qt.split("\n").forEach(l => lines.push(`> ${l}`));
				if (b.data?.caption) lines.push(`> — ${h2md(b.data.caption)}`);
				break;
			}
			case "list": {
				const renderItems = (items, level = 0, style = "unordered") => {
					if (!items || !Array.isArray(items)) return;
					const indent = "  ".repeat(level);
					items.forEach((item, index) => {
						const text = typeof item === "string" ? item : (item.content || "");
						const marker = style === "ordered" ? `${index + 1}.` : "-";
						lines.push(`${indent}${marker} ${h2md(text)}`);
						if (item.items && Array.isArray(item.items) && item.items.length > 0) {
							renderItems(item.items, level + 1, style);
						}
					});
				};
				renderItems(b.data?.items, 0, b.data?.style || "unordered");
				break;
			}
			case "checklist": {
				(b.data?.items || []).forEach(it => {
					lines.push(`- [${it.checked ? "x" : " "}] ${h2md(it.text)}`);
				});
				break;
			}
			case "code": {
				const lang = b.data?.language || "";
				lines.push(`\`\`\`${lang}`);
				lines.push(b.data?.code || "");
				lines.push("```");
				break;
			}
			case "table": {
				const content = b.data?.content || [];
				if (content.length) {
					content.forEach((row, idx) => {
						lines.push("| " + row.map(c => h2md(c)).join(" | ") + " |");
						if (idx === 0 && b.data?.withHeadings !== false) {
							lines.push("| " + row.map(() => "---").join(" | ") + " |");
						}
					});
				}
				break;
			}
			default:
				if (b.data?.text) lines.push(h2md(b.data.text));
		}
		return lines;
	}

	function textToBlocks(text) {
		if (!text?.trim()) return [{ type: "paragraph", data: { text: "" } }];
		const lines = text.split("\n");
		const blocks = [];
		let inCode = false, codeBuf = [], tableBuf = [], currentCodeLang = "";
		let listStack = [];
		let blankCount = 0;
		let codeTight = false;
		let tableTight = false;

		const flushCode = () => {
			if (codeBuf.length || inCode) {
				blocks.push({
					type: "code",
					data: {
						code: codeBuf.join("\n"),
						language: currentCodeLang || "",
						tight: codeTight
					}
				});
				codeBuf = [];
				currentCodeLang = "";
				codeTight = false;
			}
		};

		const flushTable = () => {
			if (!tableBuf.length) return;
			const hasHeaderSep = tableBuf.length > 1 && tableBuf[1].split("|").slice(1, -1).every(c => /^:?-+:?$/.test(c.trim()));
			const content = tableBuf
				.map(r => r.split("|").slice(1, -1).map(c => c.trim()))
				.filter(r => r.length && !r.every(c => /^:?-+:?$/.test(c)));
			if (content.length) {
				blocks.push({ type: "table", data: { content, withHeadings: hasHeaderSep, tight: tableTight } });
			}
			tableBuf = [];
			tableTight = false;
		};

		for (const line of lines) {
			if (line.trim().startsWith("```")) {
				listStack = [];
				if (inCode) {
					inCode = false;
					flushCode();
				} else {
					flushTable();
					if (blocks.length > 0 && blankCount > 1) {
						for (let k = 0; k < blankCount - 1; k++) {
							blocks.push({ type: "paragraph", data: { text: "", tight: true } });
						}
					}
					codeTight = (blankCount === 0 && blocks.length > 0);
					blankCount = 0;
					inCode = true;
					currentCodeLang = line.trim().slice(3).trim();
				}
				continue;
			}
			if (inCode) { codeBuf.push(line); continue; }

			if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
				listStack = [];
				if (tableBuf.length === 0) {
					if (blocks.length > 0 && blankCount > 1) {
						for (let k = 0; k < blankCount - 1; k++) {
							blocks.push({ type: "paragraph", data: { text: "", tight: true } });
						}
					}
					tableTight = (blankCount === 0 && blocks.length > 0);
					blankCount = 0;
				}
				tableBuf.push(line.trim());
				continue;
			}
			flushTable();

			const t = line.trim();
			if (!t) {
				listStack = [];
				blankCount++;
				continue;
			}

			if (blocks.length > 0 && blankCount > 1) {
				for (let k = 0; k < blankCount - 1; k++) {
					blocks.push({ type: "paragraph", data: { text: "", tight: true } });
				}
			}

			const isTight = (blankCount === 0 && blocks.length > 0);
			blankCount = 0;

			if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) {
				listStack = [];
				blocks.push({ type: "delimiter", data: { tight: isTight } });
				continue;
			}

			const standaloneImg = parseStandaloneImage(t);
			if (standaloneImg) {
				listStack = [];
				blocks.push({
					type: "image",
					data: {
						url: standaloneImg.url,
						caption: md2h(standaloneImg.alt),
						tight: isTight
					}
				});
				continue;
			}

			if (t.startsWith("###### ")) { listStack = []; blocks.push({ type: "header", data: { text: md2h(t.slice(7)), level: 6, tight: isTight } }); }
			else if (t.startsWith("##### ")) { listStack = []; blocks.push({ type: "header", data: { text: md2h(t.slice(6)), level: 5, tight: isTight } }); }
			else if (t.startsWith("#### ")) { listStack = []; blocks.push({ type: "header", data: { text: md2h(t.slice(5)), level: 4, tight: isTight } }); }
			else if (t.startsWith("### ")) { listStack = []; blocks.push({ type: "header", data: { text: md2h(t.slice(4)), level: 3, tight: isTight } }); }
			else if (t.startsWith("## ")) { listStack = []; blocks.push({ type: "header", data: { text: md2h(t.slice(3)), level: 2, tight: isTight } }); }
			else if (t.startsWith("# ")) { listStack = []; blocks.push({ type: "header", data: { text: md2h(t.slice(2)), level: 1, tight: isTight } }); }
			else if (/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(t)) {
				listStack = [];
				const alertMatch = t.match(/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
				const alertType = alertMatch[1].toUpperCase();
				const alertTitle = alertMatch[2] ? md2h(alertMatch[2]) : (alertType.charAt(0) + alertType.slice(1).toLowerCase());
				blocks.push({
					type: "warning",
					data: {
						title: alertTitle,
						message: "",
						alertType: alertType,
						tight: isTight
					}
				});
			}
			else if (t.startsWith("> ")) {
				listStack = [];
				const quoteText = md2h(t.slice(2));
				const last = blocks[blocks.length - 1];
				if (last?.type === "warning") {
					last.data.message = last.data.message ? (last.data.message + "<br>" + quoteText) : quoteText;
				} else if (last?.type === "quote") {
					last.data.text = last.data.text ? (last.data.text + "<br>" + quoteText) : quoteText;
				} else {
					blocks.push({ type: "quote", data: { text: quoteText, caption: "", tight: isTight } });
				}
			}
			else if (t.startsWith("- [ ] ") || t.startsWith("- [x] ") || t.startsWith("- [X] ")) {
				listStack = [];
				const checked = t.startsWith("- [x] ") || t.startsWith("- [X] ");
				const itemText = md2h(t.slice(6));
				const last = blocks[blocks.length - 1];
				if (last?.type === "checklist") {
					last.data.items.push({ text: itemText, checked });
				} else {
					blocks.push({ type: "checklist", data: { items: [{ text: itemText, checked }], tight: isTight } });
				}
			}
			else if (/^(\s*)([-*+]|\d+\.)\s+(.+)$/.test(line)) {
				const match = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
				const indent = match[1].replace(/\t/g, "  ").length;
				const level = Math.floor(indent / 2);
				const marker = match[2];
				const itemText = md2h(match[3]);
				const isOrdered = /^\d+\./.test(marker);
				const style = isOrdered ? "ordered" : "unordered";

				const newItem = { content: itemText, items: [] };

				const lastBlock = blocks[blocks.length - 1];
				let isRootList = false;

				if (!lastBlock || lastBlock.type !== "list") {
					isRootList = true;
				} else if (lastBlock.data.style !== style && level === 0) {
					isRootList = true;
				}

				if (isRootList) {
					listStack = [];
					const rootList = {
						type: "list",
						data: {
							style: style,
							items: [newItem],
							tight: isTight
						}
					};
					blocks.push(rootList);
					listStack.push({ level: 0, item: newItem, parentItems: rootList.data.items });
				} else {
					while (listStack.length > 0 && listStack[listStack.length - 1].level >= level) {
						listStack.pop();
					}

					if (listStack.length === 0) {
						lastBlock.data.items.push(newItem);
						listStack.push({ level, item: newItem, parentItems: lastBlock.data.items });
					} else {
						const parent = listStack[listStack.length - 1].item;
						if (!parent.items) parent.items = [];
						parent.items.push(newItem);
						listStack.push({ level, item: newItem, parentItems: parent.items });
					}
				}
			} else {
				listStack = [];
				blocks.push({ type: "paragraph", data: { text: md2h(line), tight: isTight } });
			}
		}
		flushCode(); flushTable();
		return blocks.length ? blocks : [{ type: "paragraph", data: { text: "" } }];
	}

	function blocksToText(data) {
		if (!data?.blocks || !data.blocks.length) return "";
		const result = [];
		for (let i = 0; i < data.blocks.length; i++) {
			const b = data.blocks[i];
			const bl = serializeBlockLines(b);
			const blockText = bl.join("\n");

			if (i === 0) {
				result.push(blockText);
			} else {
				if (b.data?.tight) {
					result.push("\n" + blockText);
				} else {
					result.push("\n\n" + blockText);
				}
			}
		}
		return result.join("").replace(/\n+$/, "");
	}

	function resolveSafeZipPath(rawPath) {
		if (!rawPath || typeof rawPath !== "string") return [];
		const normalized = rawPath.replace(/\\/g, "/");
		const rawSegments = normalized.split("/");
		const stack = [];

		for (let seg of rawSegments) {
			seg = seg.trim();
			if (!seg || seg === ".") continue;
			if (seg === "..") {
				if (stack.length > 0) {
					stack.pop();
				}
				continue;
			}
			seg = seg.replace(/[/\\:*?"<>|]/g, "_").trim();
			if (seg && seg !== "." && seg !== "..") {
				stack.push(seg);
			}
		}

		return stack;
	}

	const KeepLocalMarkdown = {
		isMarkdownFile,
		escHtml,
		sanitizeUrl,
		parseStandaloneImage,
		replaceMarkdownLinksAndImages,
		compressDataUrl,
		compressImageFile,
		md2h,
		h2md,
		textToBlocks,
		blocksToText,
		resolveSafeZipPath
	};

	global.KeepLocalMarkdown = KeepLocalMarkdown;
	if (typeof module !== "undefined" && module.exports) {
		module.exports = KeepLocalMarkdown;
	}

})(typeof window !== "undefined" ? window : globalThis);
