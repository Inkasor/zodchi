import assert from "node:assert/strict";
import test from "node:test";
import { inspectCapabilityRequirements, profileCapabilities } from "../src/profile-capabilities.mjs";

const provider = (name, profile = {}, providerConfig = {}) => profileCapabilities(name, providerConfig, profile, { platform: "win32" });

test("provider capability reports distinguish technical, declarative and unknown guarantees", () => {
  const codexReadOnly = provider("codex", { readOnly: true });
  assert.deepEqual([codexReadOnly.project_write.status, codexReadOnly.project_write.enforcement], ["unavailable", "technical"]);
  assert.deepEqual([codexReadOnly.process_execution.status, codexReadOnly.process_execution.enforcement], ["unavailable", "technical"]);
  assert.equal(codexReadOnly.browser_automation.source, "codex:browser-plugin-allowlist");

  const codexWriter = provider("codex", { readOnly: false });
  assert.deepEqual([codexWriter.project_write.status, codexWriter.project_write.enforcement], ["available", "technical"]);
  const codexBrowser = provider("codex", { readOnly: false, allowedPlugins: ["browser@openai-bundled"], allowedMcpServers: ["node_repl"] });
  assert.equal(codexBrowser.browser_automation.status, "unknown");
  assert.equal(codexBrowser.screen_capture.status, "unknown");
  assert.equal(inspectCapabilityRequirements(codexBrowser, { required: ["browser_automation", "screen_capture"], forbidden: [] }).mismatches.length, 2);

  const claude = provider("claude", { readOnly: true, allowedTools: ["Read", "Glob", "Grep"], disallowedTools: ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"] });
  assert.equal(claude.project_read.status, "available");
  assert.equal(claude.process_execution.status, "unavailable");
  assert.equal(claude.project_write.status, "unavailable");
  assert.equal(provider("claude", { allowedMcpServers: [] }).mcp.status, "unavailable");

  const openCode = provider("opencode", { readOnly: true, allowShell: false, allowWeb: false });
  assert.equal(openCode.project_read.status, "available");
  assert.equal(openCode.language_server.status, "available");
  assert.equal(openCode.process_execution.status, "unavailable");
  assert.equal(openCode.network.status, "unavailable");

  const kimi = provider("kimi", { readOnly: true });
  assert.deepEqual([kimi.project_write.status, kimi.project_write.enforcement], ["available", "declarative"]);
  const kimiInspection = inspectCapabilityRequirements(kimi, { required: ["context_input"], forbidden: ["project_write"] });
  assert.deepEqual(kimiInspection.mismatches.map(item => [item.capability, item.expectation]), [["project_write", "forbidden"]]);

  const reviewerException = [{ capability: "project_write", roles: ["evidence_reviewer", "strategy_reviewer"], reason: "Owner accepted Kimi's declarative boundary for reviewer roles." }];
  const acceptedReviewer = inspectCapabilityRequirements(kimi, { required: ["context_input"], forbidden: ["project_write"] }, { role: "evidence_reviewer", acceptedDeclarativeBoundaries: reviewerException });
  assert.equal(acceptedReviewer.mismatches.length, 0);
  assert.deepEqual(acceptedReviewer.accepted_declarative.map(item => [item.status, item.capability, item.role, item.reason]), [["accepted_declarative", "project_write", "evidence_reviewer", reviewerException[0].reason]]);
  assert.equal(inspectCapabilityRequirements(kimi, { required: ["context_input"], forbidden: ["project_write"] }, { role: "worker", acceptedDeclarativeBoundaries: reviewerException }).mismatches.length, 1);
  assert.equal(inspectCapabilityRequirements(kimi, { required: ["project_write"], forbidden: [] }, { role: "evidence_reviewer", acceptedDeclarativeBoundaries: reviewerException }).mismatches.length, 1);
  assert.throws(() => provider("kimi", { acceptedDeclarativeBoundaries: [{ capability: "project_write", roles: ["evidence_reviewer"], reason: "" }] }), /PROFILE_DECLARATIVE_BOUNDARY_EXCEPTION_REASON_REQUIRED/);

  const cursor = provider("cursor", { readOnly: true });
  assert.equal(cursor.project_write.status, "unknown");
  assert.equal(inspectCapabilityRequirements(cursor, { required: ["context_input"], forbidden: ["project_write"] }).mismatches.length, 1);
});

test("an explicit profile capability can record a separately verified technical boundary", () => {
  const capabilities = provider("cursor", {
    readOnly: true,
    capabilities: { project_write: { status: "unavailable", enforcement: "technical", access: "none", evidenceRef: "receipt:cursor-readonly-smoke" } }
  });
  assert.equal(capabilities.project_write.source, "profile:explicit");
  assert.equal(capabilities.project_write.evidence_ref, "receipt:cursor-readonly-smoke");
  assert.equal(inspectCapabilityRequirements(capabilities, { required: ["context_input"], forbidden: ["project_write"] }).mismatches.length, 0);

  const browserCapabilities = provider("codex", {
    readOnly: false, allowedPlugins: ["browser@openai-bundled"], allowedMcpServers: ["node_repl"],
    capabilities: {
      browser_automation: { status: "available", enforcement: "technical", access: "direct", evidenceRef: "receipt:browser-smoke" },
      screen_capture: { status: "available", enforcement: "technical", access: "direct", evidenceRef: "receipt:browser-capture-smoke" }
    }
  });
  assert.equal(inspectCapabilityRequirements(browserCapabilities, { required: ["browser_automation", "screen_capture"], forbidden: [] }).mismatches.length, 0);

  for (const name of ["codex", "claude", "opencode"]) {
    const mcpBrowser = provider(name, {
      readOnly: false,
      allowedMcpServers: ["playwright"],
      browserMcpServer: "playwright",
      capabilities: { browser_automation: { status: "available", enforcement: "technical", access: "direct", evidenceRef: `receipt:${name}-playwright-smoke` } }
    });
    assert.equal(mcpBrowser.browser_automation.status, "available", name);
    assert.equal(mcpBrowser.browser_automation.evidence_ref, `receipt:${name}-playwright-smoke`, name);
    assert.equal(mcpBrowser.mcp.status, "available", name);
  }
  assert.throws(() => provider("codex", { readOnly: false, capabilities: { browser_automation: { status: "available", enforcement: "technical", access: "direct", evidenceRef: "receipt:browser-smoke" } } }), /PROFILE_CAPABILITY_PREREQUISITE_MISSING/);
  assert.throws(() => provider("codex", { allowedMcpServers: ["other"], browserMcpServer: "playwright" }), /PROFILE_BROWSER_MCP_NOT_ALLOWED/);
  assert.throws(() => provider("kimi", { allowedMcpServers: ["playwright"], browserMcpServer: "playwright" }), /PROFILE_BROWSER_MCP_PROVIDER_UNSUPPORTED/);
  assert.throws(() => provider("cursor", { capabilities: { project_write: { status: "unavailable", enforcement: "technical", access: "none" } } }), /PROFILE_CAPABILITY_EVIDENCE_REQUIRED/);
});

test("compatible APIs receive embedded context without filesystem or process authority", () => {
  const capabilities = provider("openrouter", {}, { type: "openai-compatible" });
  assert.equal(capabilities.context_input.status, "available");
  for (const name of ["project_read", "process_execution", "project_write", "browser_automation", "screen_capture"]) assert.equal(capabilities[name].status, "unavailable");
});
