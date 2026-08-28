if (process.argv.includes("--version")) { process.stdout.write("fake-csharp-ls 1.0.0\n"); process.exit(0); }

let buffer = Buffer.alloc(0), documentUri = null;
function send(message) { const body = JSON.stringify(message); process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`); }
function handle(message) {
  if (message.method === "textDocument/didOpen") { documentUri = message.params.textDocument.uri; return; }
  if (message.method === "initialized" || message.method === "exit") { if (message.method === "exit") process.exit(0); return; }
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "fake-csharp-ls", version: "1.0.0" }, capabilities: { definitionProvider: true, referencesProvider: true, callHierarchyProvider: true } } });
  if (message.method === "shutdown") return send({ jsonrpc: "2.0", id: message.id, result: null });
  if (message.method === "textDocument/definition") return send({ jsonrpc: "2.0", id: message.id, result: [{ uri: documentUri, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } } }] });
  if (message.method === "textDocument/references") return send({ jsonrpc: "2.0", id: message.id, result: [] });
  if (message.method === "textDocument/prepareCallHierarchy") return send({ jsonrpc: "2.0", id: message.id, result: [{ name: "Value", kind: 6, uri: documentUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } }, selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } } }] });
  if (message.method === "callHierarchy/incomingCalls") return send({ jsonrpc: "2.0", id: message.id, result: null });
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: null });
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n"); if (headerEnd < 0) return;
    const match = buffer.subarray(0, headerEnd).toString("ascii").match(/Content-Length:\s*(\d+)/i); if (!match) process.exit(2);
    const length = Number(match[1]), start = headerEnd + 4; if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8")); buffer = buffer.subarray(start + length); handle(message);
  }
});
