import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import { readBrowserSentinelEvidence, startBrowserSentinel } from "./browser-sentinel.mjs";
import { BROWSER_PROOF_VIEWPORT, screenshotEvidence } from "./browser-proof.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const compact = value => String(value ?? "").slice(0, 4000);

function stdio(command, args, cwd, timeoutSeconds) {
  return new Promise(resolve => execFile(command, args, { cwd, shell: false, windowsHide: true, timeout: timeoutSeconds * 1000 }, (error, stdout, stderr) => {
    if (error) return resolve({ status: error.killed ? "timed_out" : error.code === "ENOENT" ? "unavailable" : "failed", failure: compact(stderr || error.message) });
    resolve({ status: "passed", output: String(stdout) });
  }));
}

function versionMatches(payload, pinned) {
  if (!pinned) return false;
  const actual = payload?.version ?? payload?.serverInfo?.version ?? null;
  return actual === pinned;
}

export async function runRegisteredExternalCheck(check, context) {
  const tool = check.external_tool;
  if (!tool) return { status: "unavailable", failure: "registered external tool is unavailable" };
  if (!tool.pinned_version) return { status: "unavailable", failure: "external tool has no pinned version" };
  if (tool.transport === "http") {
    let response;
    try {
      const endpoint = new URL(check.config.path ?? "", tool.endpoint).href;
      response = await fetch(endpoint, { method: check.config.method ?? "GET", signal: AbortSignal.timeout(check.timeout_seconds * 1000) });
    } catch (error) { return { status: "unavailable", failure: `external endpoint unavailable: ${compact(error.message)}` }; }
    if (!response.ok) return { status: "unavailable", failure: `external endpoint returned HTTP ${response.status}` };
    const text = await response.text();
    let payload; try { payload = JSON.parse(text); } catch { return { status: "unavailable", failure: "external endpoint returned non-JSON evidence" }; }
    if (!versionMatches(payload, tool.pinned_version)) return { status: "unavailable", failure: `external endpoint version mismatch: expected ${tool.pinned_version}` };
    return { status: payload.status === "passed" ? "passed" : payload.status === "failed" ? "failed" : "unavailable", failure: payload.status === "passed" ? null : compact(payload.failure ?? "external check did not pass"), evidence: { response_sha256: hash(text), version: tool.pinned_version } };
  }
  if (tool.transport === "stdio") {
    const result = await stdio(tool.endpoint, check.config.args ?? [], context.project, check.timeout_seconds);
    if (result.status !== "passed") return result;
    let payload; try { payload = JSON.parse(result.output); } catch { return { status: "unavailable", failure: "stdio checker returned non-JSON evidence" }; }
    if (!versionMatches(payload, tool.pinned_version)) return { status: "unavailable", failure: `stdio checker version mismatch: expected ${tool.pinned_version}` };
    return { status: payload.status === "passed" ? "passed" : payload.status === "failed" ? "failed" : "unavailable", failure: payload.status === "passed" ? null : compact(payload.failure ?? "stdio check did not pass"), evidence: { response_sha256: hash(result.output), version: tool.pinned_version } };
  }
  return { status: "unavailable", failure: `unsupported external tool transport: ${tool.transport}` };
}

export function runSqliteCheck(check) {
  const file = check.sqlite_database;
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return { status: "unavailable", failure: "registered SQLite database is unavailable" };
  const sql = String(check.config.sql ?? "").trim();
  if (!/^(?:SELECT|PRAGMA)\b/iu.test(sql) || /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM)\b/iu.test(sql)) return { status: "unavailable", failure: "SQLite check is not read-only" };
  let db;
  try {
    db = new DatabaseSync(path.resolve(file), { readOnly: true });
    db.exec("PRAGMA query_only=ON");
    const rows = db.prepare(sql).all();
    const serialized = JSON.stringify(rows);
    const expected = check.config.expected;
    const passed = expected === undefined || rows.some(row => Object.values(row).some(value => value === expected));
    return { status: passed ? "passed" : "failed", failure: passed ? null : "SQLite invariant did not match", evidence: { rows: rows.length, result_sha256: hash(serialized), database_sha256: hash(fs.readFileSync(file)) } };
  } catch (error) { return { status: "unavailable", failure: compact(error.message) }; }
  finally { try { db?.close(); } catch {} }
}

export async function runBrowserSentinelCheck(check, context) {
  const tool = check.external_tool;
  if (!tool || tool.transport !== "stdio" || !tool.pinned_version) return { status: "unavailable", failure: "registered Playwright CLI is unavailable or unpinned" };
  const version = await stdio(tool.endpoint, ["--version"], context.project, 30);
  if (version.status !== "passed" || !version.output.includes(tool.pinned_version)) return { status: "unavailable", failure: `Playwright version mismatch: expected ${tool.pinned_version}` };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-browser-gate-")), requestLog = path.join(root, "requests.jsonl"), screenshot = path.join(root, "proof.png");
  const token = crypto.randomUUID(), route = `/proof-${crypto.randomUUID()}`;
  let sentinel;
  try {
    sentinel = await startBrowserSentinel({ route, title: `Zodchi ${crypto.randomUUID()}`, body: `Proof ${crypto.randomUUID()}`, requestLog, resourceToken: token });
    const run = await stdio(tool.endpoint, ["screenshot", "--viewport-size", `${BROWSER_PROOF_VIEWPORT.width}, ${BROWSER_PROOF_VIEWPORT.height}`, "--wait-for-timeout", "500", sentinel.url, screenshot], context.project, check.timeout_seconds);
    if (run.status !== "passed") return { status: run.status === "failed" ? "failed" : "unavailable", failure: run.failure };
    const browser = readBrowserSentinelEvidence(requestLog, sentinel.routes), image = screenshotEvidence(screenshot, sentinel.screenshotMarker, "browser-proof.png");
    const passed = browser.confirmed && image.status === "available";
    return { status: passed ? "passed" : "unavailable", failure: passed ? null : "browser sentinel or screenshot marker was not confirmed", evidence: { browser, screenshot: image.artifact, version: tool.pinned_version } };
  } catch (error) { return { status: "unavailable", failure: compact(error.message) }; }
  finally {
    try { sentinel?.child?.kill(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}
