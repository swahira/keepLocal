// Chrome DevTools Protocol test runner using Node built-in fetch and WebSocket
const { spawn } = require("child_process");

async function main() {
	const chrome = spawn("google-chrome", [
		"--headless=new",
		"--remote-debugging-port=9225",
		"--no-sandbox",
		"--disable-gpu"
	]);

	await new Promise(r => setTimeout(r, 800));

	let target = null;
	for (let i = 0; i < 20; i++) {
		try {
			const res = await fetch("http://127.0.0.1:9225/json/new?http://localhost:3000/tests/test_runner.html", { method: "PUT" });
			target = await res.json();
			if (target && target.webSocketDebuggerUrl) break;
		} catch (_) {
			await new Promise(r => setTimeout(r, 200));
		}
	}

	if (!target || !target.webSocketDebuggerUrl) {
		chrome.kill();
		console.error("Could not create target in Chrome via DevTools Protocol");
		process.exit(1);
	}

	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});

	let msgId = 1;
	function send(method, params = {}) {
		return new Promise((resolve) => {
			const id = msgId++;
			const onMsg = (event) => {
				const data = JSON.parse(event.data);
				if (data.id === id) {
					ws.removeEventListener("message", onMsg);
					resolve(data.result);
				}
			};
			ws.addEventListener("message", onMsg);
			ws.send(JSON.stringify({ id, method, params }));
		});
	}

	await send("Runtime.enable");

	let results = null;
	for (let i = 0; i < 30; i++) {
		await new Promise(r => setTimeout(r, 300));
		const evalRes = await send("Runtime.evaluate", {
			expression: "JSON.stringify(window.__TEST_RESULTS__ || null)",
			returnByValue: true
		});
		if (evalRes && evalRes.result && evalRes.result.value) {
			results = JSON.parse(evalRes.result.value);
			if (results) break;
		}
	}

	ws.close();
	chrome.kill();

	if (!results) {
		console.error("Tests timed out without results.");
		process.exit(1);
	}

	console.log("\n=== BROWSER INDEXEDDB & STORAGE TEST RESULTS ===");
	if (results.logs) {
		results.logs.forEach(log => {
			const text = log.replace(/<[^>]+>/g, "");
			console.log("  " + text);
		});
	}

	if (results.passed) {
		console.log("\n>>> ALL INDEXEDDB & STORAGE TESTS PASSED IN CHROME! <<<\n");
		process.exit(0);
	} else {
		console.error("\n>>> SOME TESTS FAILED <<<");
		process.exit(1);
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
