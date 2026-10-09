// Unit tests for KeepLocalMarkdown
const assert = require("assert");
const KeepLocalMarkdown = require("../js/markdown.js");

console.log("Running KeepLocalMarkdown unit tests...");

// 1. isMarkdownFile
assert.strictEqual(KeepLocalMarkdown.isMarkdownFile("notes.md"), true);
assert.strictEqual(KeepLocalMarkdown.isMarkdownFile("guide.MARKDOWN"), true);
assert.strictEqual(KeepLocalMarkdown.isMarkdownFile("script.js"), false);
assert.strictEqual(KeepLocalMarkdown.isMarkdownFile("image.png"), false);
assert.strictEqual(KeepLocalMarkdown.isMarkdownFile(""), false);
assert.strictEqual(KeepLocalMarkdown.isMarkdownFile(null), false);
console.log("✓ isMarkdownFile tests passed");

// 2. escHtml
assert.strictEqual(KeepLocalMarkdown.escHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
assert.strictEqual(KeepLocalMarkdown.escHtml('Hello & "World"'), "Hello &amp; &quot;World&quot;");
console.log("✓ escHtml tests passed");

// 3. sanitizeUrl
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("https://example.com"), "https://example.com");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("http://localhost:3000"), "http://localhost:3000");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("mailto:user@test.com"), "mailto:user@test.com");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("./relative/path.md"), "./relative/path.md");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("../parent/path.md"), "../parent/path.md");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("/root/path.md"), "/root/path.md");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("#anchor"), "#anchor");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("javascript:alert(1)"), "#");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("vbscript:test"), "#");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("data:text/html,<script>"), "#");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="), "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==");
console.log("✓ sanitizeUrl tests passed");

// 4. parseStandaloneImage
const img1 = KeepLocalMarkdown.parseStandaloneImage("![My Image](https://example.com/pic.png)");
assert.deepStrictEqual(img1, { alt: "My Image", url: "https://example.com/pic.png" });

const img2 = KeepLocalMarkdown.parseStandaloneImage("Not an image");
assert.strictEqual(img2, null);

const img3 = KeepLocalMarkdown.parseStandaloneImage("![caption](data:image/jpeg;base64,12345)");
assert.deepStrictEqual(img3, { alt: "caption", url: "data:image/jpeg;base64,12345" });
console.log("✓ parseStandaloneImage tests passed");

// 5. replaceMarkdownLinksAndImages
const linkHtml = KeepLocalMarkdown.replaceMarkdownLinksAndImages("[Click here](https://example.com)", KeepLocalMarkdown.sanitizeUrl);
assert.strictEqual(linkHtml, '<a href="https://example.com" target="_blank" rel="noopener">Click here</a>');

const xssLink = KeepLocalMarkdown.replaceMarkdownLinksAndImages("[Evil](javascript:alert(1))", KeepLocalMarkdown.sanitizeUrl);
assert.strictEqual(xssLink, '<a href="#" rel="noopener" onclick="return false;">Evil</a>');

const inlineImg = KeepLocalMarkdown.replaceMarkdownLinksAndImages("![Alt text](https://example.com/img.png)", KeepLocalMarkdown.sanitizeUrl);
assert.ok(inlineImg.includes('<img src="https://example.com/img.png"'));
console.log("✓ replaceMarkdownLinksAndImages tests passed");

// 6. textToBlocks
// Headings
const h1Blocks = KeepLocalMarkdown.textToBlocks("# Heading 1");
assert.strictEqual(h1Blocks.length, 1);
assert.strictEqual(h1Blocks[0].type, "header");
assert.strictEqual(h1Blocks[0].data.level, 1);
assert.strictEqual(h1Blocks[0].data.text, "Heading 1");

const h3Blocks = KeepLocalMarkdown.textToBlocks("### Subheading");
assert.strictEqual(h3Blocks[0].data.level, 3);
assert.strictEqual(h3Blocks[0].data.text, "Subheading");

// Delimiter
const delimBlocks = KeepLocalMarkdown.textToBlocks("---");
assert.strictEqual(delimBlocks[0].type, "delimiter");

// Image
const imgBlocks = KeepLocalMarkdown.textToBlocks("![Test](https://example.com/img.png)");
assert.strictEqual(imgBlocks[0].type, "image");
assert.strictEqual(imgBlocks[0].data.url, "https://example.com/img.png");
assert.strictEqual(imgBlocks[0].data.caption, "Test");

// Alert
const alertBlocks = KeepLocalMarkdown.textToBlocks("> [!WARNING] Danger Ahead\n> Be careful!");
assert.strictEqual(alertBlocks[0].type, "warning");
assert.ok(alertBlocks[0].data.title.includes("Danger Ahead"));
assert.ok(alertBlocks[0].data.message.includes("Be careful!"));

// Checklist
const checkBlocks = KeepLocalMarkdown.textToBlocks("- [ ] Todo item\n- [x] Done item");
assert.strictEqual(checkBlocks[0].type, "checklist");
assert.strictEqual(checkBlocks[0].data.items[0].checked, false);
assert.strictEqual(checkBlocks[0].data.items[0].text, "Todo item");
assert.strictEqual(checkBlocks[0].data.items[1].checked, true);
assert.strictEqual(checkBlocks[0].data.items[1].text, "Done item");

// Code block
const codeBlocks = KeepLocalMarkdown.textToBlocks("```javascript\nconst x = 42;\n```");
assert.strictEqual(codeBlocks[0].type, "code");
assert.strictEqual(codeBlocks[0].data.language, "javascript");
assert.strictEqual(codeBlocks[0].data.code, "const x = 42;");

// Table
const tableBlocks = KeepLocalMarkdown.textToBlocks("| Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |");
assert.strictEqual(tableBlocks[0].type, "table");
assert.strictEqual(tableBlocks[0].data.withHeadings, true);
assert.deepStrictEqual(tableBlocks[0].data.content, [["Header 1", "Header 2"], ["Cell 1", "Cell 2"]]);

console.log("✓ textToBlocks tests passed");

// 7. blocksToText roundtrip
const roundtripMd = KeepLocalMarkdown.blocksToText({
	blocks: [
		{ type: "header", data: { level: 2, text: "Section 2" } },
		{ type: "paragraph", data: { text: "Some normal text with <b>bold</b> and <i>italic</i>" } },
		{ type: "delimiter", data: {} },
		{ type: "checklist", data: { items: [{ text: "Buy milk", checked: false }, { text: "Walk dog", checked: true }] } },
		{ type: "code", data: { language: "py", code: "print('hello')" } }
	]
});

assert.ok(roundtripMd.includes("## Section 2"));
assert.ok(roundtripMd.includes("Some normal text with **bold** and *italic*"));
assert.ok(roundtripMd.includes("---"));
assert.ok(roundtripMd.includes("- [ ] Buy milk"));
assert.ok(roundtripMd.includes("- [x] Walk dog"));
assert.ok(roundtripMd.includes("```py\nprint('hello')\n```"));
console.log("✓ blocksToText roundtrip tests passed");

console.log("All KeepLocalMarkdown unit tests passed successfully!");
