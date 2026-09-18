// Dev tool. Evaluates a JavaScript expression in the PAGE world of the
// openfront.io tab of a Chrome started with --remote-debugging-port, and prints
// the JSON result. Usage: CDP_PORT=9339 node tools/cdp-eval.mjs "<expression>"
const PORT = Number(process.env.CDP_PORT ?? 9339);
const EXPR = process.argv[2];

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("openfront.io"));
if (!page) {
  console.log("no openfront page");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const res = await new Promise((resolve) => {
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === 1) resolve(msg);
  });
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: EXPR, awaitPromise: true, returnByValue: true },
    }),
  );
});
ws.close();
if (res.error) console.log("cdp error:", res.error.message);
else if (res.result?.exceptionDetails) {
  console.log("threw:", res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
} else console.log(JSON.stringify(res.result?.result?.value, null, 1));
