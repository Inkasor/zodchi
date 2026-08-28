import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const normalizedPath = value => path.resolve(value).replaceAll("\\", "/");
const inside = (root, target) => { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };

function listedCSharp(repoRoot) {
  try {
    const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "Assets/*.cs", "Assets/**/*.cs", "Packages/*.cs", "Packages/**/*.cs"], { cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    return { files: output.split("\0").filter(Boolean).map(item => normalizedPath(path.join(repoRoot, item))).filter(fs.existsSync), authoritative: true, source: "git", truncated: false };
  } catch (error) {
    const files = []; let truncated = false;
    const walk = directory => {
      let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (files.length >= 20_000) { truncated = true; return; }
        if ([".git", "Library", "Temp", "Logs", "obj", "bin"].includes(entry.name)) continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target); else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cs")) files.push(normalizedPath(target));
      }
    };
    for (const key of ["Assets", "Packages"]) { const directory = path.join(repoRoot, key); if (fs.existsSync(directory)) walk(directory); }
    return { files, authoritative: false, source: "walk_after_git_error", truncated, fallback_reason: error.message };
  }
}

function solutionProjects(solutionFile) {
  const directory = path.dirname(solutionFile), source = fs.readFileSync(solutionFile, "utf8"), projects = [];
  for (const match of source.matchAll(/^Project\([^\r\n]+?\)\s*=\s*"[^"]+",\s*"([^"]+\.csproj)"/gmi)) {
    const projectFile = path.resolve(directory, match[1].replaceAll("\\", path.sep));
    if (!projects.includes(projectFile)) projects.push(projectFile);
  }
  return projects.sort((left, right) => left.localeCompare(right, "en"));
}

function expandCompileInclude(directory, include) {
  const platformValue = include.replaceAll("\\", path.sep), absolutePattern = normalizedPath(path.isAbsolute(platformValue) ? platformValue : path.resolve(directory, platformValue));
  if (!/[?*]/.test(absolutePattern)) return [absolutePattern];
  const wildcard = absolutePattern.search(/[?*]/), base = absolutePattern.slice(0, wildcard).replace(/\/$/, "").replace(/\/[^/]*$/, "") || path.parse(absolutePattern).root;
  if (!fs.existsSync(base)) return [];
  const expression = new RegExp(`^${absolutePattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("?", "[^/]").replaceAll("\u0000", ".*")}$`, process.platform === "win32" ? "i" : "");
  const files = [], walk = target => { for (const entry of fs.readdirSync(target, { withFileTypes: true })) { const item = path.join(target, entry.name); if (entry.isDirectory()) walk(item); else if (entry.isFile()) { const normalized = normalizedPath(item); if (expression.test(normalized)) files.push(normalized); } } };
  walk(base); return files;
}

function projectBoundary(projectFile) {
  const source = fs.readFileSync(projectFile, "utf8"), directory = path.dirname(projectFile), compile = [];
  for (const match of source.matchAll(/<Compile\s+[^>]*Include\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/gi)) {
    compile.push(...expandCompileInclude(directory, match[1]));
  }
  const defaultItemsDisabled = /<EnableDefaultCompileItems>\s*false\s*<\/EnableDefaultCompileItems>/i.test(source);
  if (!compile.length && !defaultItemsDisabled) {
    const walk = target => { for (const entry of fs.readdirSync(target, { withFileTypes: true })) { if (["bin", "obj"].includes(entry.name)) continue; const item = path.join(target, entry.name); if (entry.isDirectory()) walk(item); else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cs")) compile.push(normalizedPath(item)); } };
    walk(directory);
  }
  const references = [];
  for (const match of source.matchAll(/<Reference\s+[^>]*Include\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/Reference>/gi)) {
    const hintPath = match[2].match(/<HintPath>\s*([^<]+?)\s*<\/HintPath>/i)?.[1] ?? null, absolute = hintPath ? path.resolve(directory, hintPath.replaceAll("\\", path.sep)) : null;
    const stat = absolute && fs.existsSync(absolute) ? fs.statSync(absolute) : null;
    references.push({ include: match[1], hint_path: hintPath, file_identity: stat ? `sha256:${sha256(JSON.stringify([normalizedPath(absolute), stat.size, stat.mtimeMs]))}` : null });
  }
  return { path: normalizedPath(projectFile), sha256: sha256(source), compile: [...new Set(compile)].sort(), references };
}

export function attestCSharpBuild(options) {
  const solution = normalizedPath(options.solutionFile), command = options.command?.[0], args = [...(options.command?.slice(1) ?? []), ...(options.args ?? ["build", solution, "--no-restore", "--nologo"])];
  if (!command || !fs.existsSync(solution)) return { authority: "zodchi_process", status: "unavailable", solution_hash: fs.existsSync(solution) ? `sha256:${sha256(fs.readFileSync(solution))}` : null, reason: command ? "solution_missing" : "build_command_missing" };
  const started = Date.now(), result = spawnSync(command, args, { cwd: path.dirname(solution), encoding: "utf8", windowsHide: true, env: { ...process.env, ...(options.env ?? {}) }, timeout: options.timeoutMs ?? 180_000, maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { authority: "zodchi_process", status: result.status === 0 ? "passed" : result.error?.code === "ETIMEDOUT" ? "timeout" : "failed", exit_code: result.status, duration_ms: Date.now() - started, solution_hash: `sha256:${sha256(fs.readFileSync(solution))}`, output_hash: `sha256:${sha256(output)}`, output_tail: output.slice(-4000) };
}

export function inspectUnityCSharpBoundary(options) {
  const repoRoot = normalizedPath(options.repoRoot), solution = normalizedPath(options.solutionFile);
  if (!fs.existsSync(solution)) return { status: "unavailable", completeness: "unknown", reason: "unity_solution_missing", repo_root: repoRoot, solution };
  let projects;
  try { projects = solutionProjects(solution); } catch (error) { return { status: "unavailable", completeness: "error", reason: "unity_solution_unreadable", error: error.message, repo_root: repoRoot, solution }; }
  if (!projects.length || projects.some(item => !fs.existsSync(item))) return { status: "unavailable", completeness: "unknown", reason: "unity_projects_missing", repo_root: repoRoot, solution, project_files: projects.map(normalizedPath) };
  const projectRecords = projects.map(projectBoundary), enumeration = listedCSharp(repoRoot);
  const compiled = [...new Set(projectRecords.flatMap(item => item.compile).filter(item => inside(repoRoot, item) && fs.existsSync(item)))].sort();
  const eligible = [...new Set(enumeration.files)].sort(), compiledSet = new Set(compiled);
  const missing = eligible.filter(item => !compiledSet.has(item));
  const sourceManifest = compiled.map(file => ({ path: path.relative(repoRoot, file).replaceAll("\\", "/"), bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) }));
  const authoritative = enumeration.authoritative && !enumeration.truncated && inside(repoRoot, solution), structuralCompleteness = authoritative && missing.length === 0 ? "complete" : "partial";
  const expectedSolutionHash = `sha256:${sha256(fs.readFileSync(solution))}`, build = options.buildEvidence?.authority === "zodchi_process" && options.buildEvidence.solution_hash === expectedSolutionHash ? options.buildEvidence : { authority: "zodchi_process", status: "unknown", solution_hash: expectedSolutionHash, reason: "build_not_attested" };
  const completeness = structuralCompleteness === "complete" && build.status === "passed" ? "complete" : "partial";
  const identity = { solution: path.relative(repoRoot, solution).replaceAll("\\", "/"), solution_sha256: sha256(fs.readFileSync(solution)), projects: projectRecords.map(item => ({ path: inside(repoRoot, item.path) ? path.relative(repoRoot, item.path).replaceAll("\\", "/") : item.path, sha256: item.sha256 })), sources: sourceManifest };
  return {
    status: "available", completeness, structural_completeness: structuralCompleteness, reason: completeness === "complete" ? "built_authoritative_solution_covers_registered_csharp_scope" : !inside(repoRoot, solution) ? "solution_outside_registered_project" : !enumeration.authoritative ? "source_enumeration_not_authoritative" : missing.length ? "solution_does_not_cover_registered_csharp_scope" : build.status !== "passed" ? "solution_build_not_attested" : "boundary_partial",
    repo_root: repoRoot, solution, solution_hash: expectedSolutionHash, boundary_hash: `sha256:${sha256(JSON.stringify(identity))}`, build,
    enumeration: { source: enumeration.source, authoritative: enumeration.authoritative, truncated: enumeration.truncated, eligible_files: eligible.length },
    compiled_files: compiled.length, missing_files: missing.map(item => path.relative(repoRoot, item).replaceAll("\\", "/")), projects: projectRecords.map(item => ({ path: item.path, sha256: `sha256:${item.sha256}`, compiled_files: item.compile.length, references: item.references }))
  };
}

class LspSession {
  constructor(command, args, options) { this.command = command; this.args = args; this.options = options; this.buffer = Buffer.alloc(0); this.pending = new Map(); this.nextId = 1; this.stderr = []; }
  start() {
    this.child = spawn(this.command, this.args, { cwd: this.options.cwd, env: this.options.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.pump(); });
    this.child.stderr.on("data", chunk => this.stderr.push(chunk.toString("utf8")));
    this.child.on("error", error => this.rejectAll(error)); this.child.on("exit", code => { if (code && this.pending.size) this.rejectAll(new Error(`csharp provider exited with ${code}`)); });
  }
  rejectAll(error) { for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error); } this.pending.clear(); }
  pump() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n"); if (headerEnd < 0) return;
      const match = this.buffer.subarray(0, headerEnd).toString("ascii").match(/Content-Length:\s*(\d+)/i); if (!match) { this.rejectAll(new Error("invalid LSP header")); return; }
      const length = Number(match[1]), start = headerEnd + 4; if (this.buffer.length < start + length) return;
      const message = JSON.parse(this.buffer.subarray(start, start + length).toString("utf8")); this.buffer = this.buffer.subarray(start + length);
      if (message.method && message.id !== undefined) { this.send({ jsonrpc: "2.0", id: message.id, result: null }); continue; }
      const pending = this.pending.get(message.id); if (!pending) continue; this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
    }
  }
  send(message) { const body = JSON.stringify(message); this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`); }
  notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }
  request(method, params, timeoutMs = 90_000) { const id = this.nextId++; this.send({ jsonrpc: "2.0", id, method, params }); return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timeout`)); }, timeoutMs); this.pending.set(id, { resolve, reject, timer }); }); }
  async close() { try { await this.request("shutdown", null, 10_000); this.notify("exit", null); } catch {} await new Promise(resolve => { const timer = setTimeout(resolve, 2_000); this.child.once("exit", () => { clearTimeout(timer); resolve(); }); }); if (this.child.exitCode === null) this.child.kill(); }
}

function providerVersion(command, args, env) { const result = spawnSync(command, [...args, "--version"], { encoding: "utf8", windowsHide: true, env, timeout: 15_000 }); return result.status === 0 ? `${result.stdout}${result.stderr}`.trim() : null; }
function positionRequest(request, repoRoot) { const document = normalizedPath(path.resolve(repoRoot, request.document)); if (!inside(repoRoot, document) || !fs.existsSync(document)) throw new Error("CSHARP_REQUEST_DOCUMENT_OUTSIDE_BOUNDARY"); return { document, params: { textDocument: { uri: pathToFileURL(document).href }, position: { line: Number(request.line), character: Number(request.character) } } }; }
function locations(value, repoRoot) { return (Array.isArray(value) ? value : value ? [value] : []).map(item => { const target = item.targetUri ? { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange } : item; const absolute = target.uri?.startsWith("file:") ? normalizedPath(fileURLToPath(target.uri)) : null; return { path: absolute && inside(repoRoot, absolute) ? path.relative(repoRoot, absolute).replaceAll("\\", "/") : target.uri ?? null, line: target.range?.start?.line === undefined ? null : target.range.start.line + 1, character: target.range?.start?.character === undefined ? null : target.range.start.character + 1 }; }); }

export async function runCSharpProvider(options) {
  const initial = inspectUnityCSharpBoundary(options), buildEvidence = options.buildCommand && initial.status === "available" ? attestCSharpBuild({ solutionFile: initial.solution, command: options.buildCommand, env: options.dotnetRoot ? { DOTNET_ROOT: options.dotnetRoot, DOTNET_ROOT_X64: options.dotnetRoot } : options.env, timeoutMs: options.buildTimeoutMs }) : options.buildEvidence;
  const boundary = inspectUnityCSharpBoundary({ ...options, buildEvidence });
  if (options.request.type === "completeness") return { schema_version: 1, provider: "csharp-ls", request: options.request, status: boundary.status === "available" ? "observed" : "unavailable", boundary };
  if (boundary.status !== "available") return { schema_version: 1, provider: "csharp-ls", request: options.request, status: "unavailable", boundary };
  const command = options.providerCommand?.[0] ?? options.providerExecutable, args = [...(options.providerCommand?.slice(1) ?? []), "--solution", boundary.solution, "--loglevel", "error"];
  if (!command) return { schema_version: 1, provider: "csharp-ls", request: options.request, status: "unavailable", boundary, reason: "provider_command_missing" };
  const env = { ...process.env, ...(options.dotnetRoot ? { DOTNET_ROOT: options.dotnetRoot, DOTNET_ROOT_X64: options.dotnetRoot } : {}), ...(options.env ?? {}) };
  const session = new LspSession(command, args, { cwd: path.dirname(boundary.solution), env }); session.start();
  try {
    const initialized = await session.request("initialize", { processId: process.pid, clientInfo: { name: "zodchi-csharp-provider", version: "1.0.0" }, rootUri: pathToFileURL(boundary.repo_root).href, workspaceFolders: [{ uri: pathToFileURL(boundary.repo_root).href, name: path.basename(boundary.repo_root) }], capabilities: { textDocument: { definition: {}, references: {}, callHierarchy: {}, synchronization: { didOpen: true } } } });
    session.notify("initialized", {});
    const positioned = positionRequest(options.request, boundary.repo_root), text = fs.readFileSync(positioned.document, "utf8");
    session.notify("textDocument/didOpen", { textDocument: { uri: positioned.params.textDocument.uri, languageId: "csharp", version: 1, text } });
    let result, anchors = [], status = "unknown", reason = null;
    if (options.request.type === "definitions") { result = await session.request("textDocument/definition", positioned.params); anchors = locations(result, boundary.repo_root); status = anchors.length ? "observed" : boundary.completeness === "complete" ? "missing" : "unknown"; }
    else if (options.request.type === "references") { result = await session.request("textDocument/references", { ...positioned.params, context: { includeDeclaration: Boolean(options.request.include_declaration) } }); anchors = locations(result, boundary.repo_root); status = anchors.length ? "observed" : boundary.completeness === "complete" ? "missing" : "unknown"; }
    else if (options.request.type === "callers") {
      const prepared = await session.request("textDocument/prepareCallHierarchy", positioned.params), item = Array.isArray(prepared) ? prepared[0] : null;
      const calls = item ? await session.request("callHierarchy/incomingCalls", { item }) : null;
      anchors = Array.isArray(calls) ? calls.map(call => locations({ uri: call.from?.uri, range: call.from?.selectionRange }, boundary.repo_root)[0]).filter(Boolean) : [];
      status = anchors.length ? "observed" : "unknown"; reason = anchors.length ? null : "caller_completeness_not_proven";
    } else throw new Error(`CSHARP_REQUEST_TYPE_INVALID: ${options.request.type}`);
    return { schema_version: 1, provider: "csharp-ls", provider_version: providerVersion(command, options.providerCommand?.slice(1) ?? [], env) ?? initialized?.serverInfo?.version ?? null, request: options.request, status, ...(reason ? { reason } : {}), anchors, boundary, provenance: { provider_command_hash: `sha256:${sha256(JSON.stringify([command, args]))}`, solution_hash: boundary.solution_hash, boundary_hash: boundary.boundary_hash } };
  } catch (error) { return { schema_version: 1, provider: "csharp-ls", request: options.request, status: "error", error: error.message, boundary, stderr: session.stderr.join("").slice(-4000) }; }
  finally { await session.close(); }
}
