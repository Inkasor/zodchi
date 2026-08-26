import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const SOURCE_EXTENSIONS = new Set([".bsl", ".os", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".venv", "__pycache__", "vendor", "tmp", "temp"]);
const BSL_EXTENSIONS = new Set([".bsl", ".os"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function listedFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 20_000,
      maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"]
    }).split("\0").filter(Boolean);
  } catch {
    const files = [];
    const walk = (directory, prefix = "") => {
      let entries;
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
        if (IGNORED.has(entry.name)) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
        else if (entry.isFile()) files.push(relative);
      }
    };
    walk(root);
    return files;
  }
}

function displayed(root, relative) { return root.primary ? relative.replaceAll("\\", "/") : `${root.key}/${relative.replaceAll("\\", "/")}`; }
function lineAt(text, offset) { return text.slice(0, Math.max(0, offset)).split(/\r?\n/).length; }
function normalized(value) { return String(value ?? "").toLowerCase(); }
function identifierParts(value) {
  return [...new Set(String(value ?? "")
    .replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, "$1 $2")
    .replace(/[_./-]+/g, " ")
    .split(/\s+/).map(normalized).filter(item => item.length >= 3))];
}
function addEdge(edges, seen, from, to, type, evidence = null) {
  if (!from || !to || from === to) return;
  const key = `${from}\0${to}\0${type}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({ from, to, type, ...(evidence ? { evidence } : {}) });
}

function collectFiles(roots, scope, limits) {
  const files = [];
  let eligible = 0, skippedLarge = 0, truncated = false;
  for (const root of roots) {
    for (const relative of listedFiles(root.path)) {
      const extension = path.extname(relative).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(extension) || !scope.matches(relative)) continue;
      eligible += 1;
      if (files.length >= limits.maxFiles) { truncated = true; continue; }
      const absolute = path.join(root.path, relative), bytes = (() => { try { return fs.statSync(absolute).size; } catch { return null; } })();
      if (bytes === null || bytes > limits.maxFileBytes) { skippedLarge += 1; continue; }
      let text;
      try { text = fs.readFileSync(absolute, "utf8"); } catch { continue; }
      files.push({ root, relative: relative.replaceAll("\\", "/"), path: displayed(root, relative), absolute, extension, bytes, text });
    }
  }
  return { files, eligible, skippedLarge, truncated };
}

function parseBsl(files) {
  const nodes = [], edges = [], edgeKeys = new Set(), byName = new Map(), pendingCalls = [], metadata = new Map();
  for (const file of files.filter(item => BSL_EXTENSIONS.has(item.extension))) {
    const lines = file.text.split(/\r?\n/), moduleId = `bsl:${file.path}:module`;
    nodes.push({ id: moduleId, language: "bsl", kind: "module", name: path.basename(file.path), path: file.path, start_line: 1, end_line: lines.length });
    let current = moduleId;
    for (let index = 0; index < lines.length; index += 1) {
      const declaration = lines[index].match(/^\s*(?:&[^\r\n]+\s*)*(Функция|Процедура|Function|Procedure)\s+([A-Za-z_Ѐ-ӿ][A-Za-z0-9_Ѐ-ӿ]{2,100})/i);
      if (declaration) {
        const id = `bsl:${file.path}:${index + 1}:${declaration[2]}`;
        current = id;
        const node = { id, language: "bsl", kind: /функция|function/i.test(declaration[1]) ? "function" : "procedure", name: declaration[2], path: file.path, start_line: index + 1, end_line: index + 1 };
        nodes.push(node);
        const key = normalized(node.name);
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(node);
        addEdge(edges, edgeKeys, moduleId, id, "contains");
      }
      if (/^\s*(?:КонецФункции|КонецПроцедуры|EndFunction|EndProcedure)/i.test(lines[index])) {
        const node = nodes.find(item => item.id === current);
        if (node) node.end_line = index + 1;
        current = moduleId;
      }
      for (const call of lines[index].matchAll(/(?:^|[^A-Za-z0-9Ѐ-ӿ_])([A-Za-z_Ѐ-ӿ][A-Za-z0-9_Ѐ-ӿ]{2,100})\s*\(/g)) {
        if (!/^(?:Если|Тогда|ИначеЕсли|Для|Пока|Функция|Процедура|If|For|While|Function|Procedure)$/i.test(call[1])) pendingCalls.push({ from: current, name: call[1], path: file.path, line: index + 1 });
      }
      for (const match of lines[index].matchAll(/(Регистры?Сведений|Регистры?Накопления|Справочники?|Документы?|InformationRegisters?|AccumulationRegisters?|Catalogs?|Documents?)\.([A-Za-z_Ѐ-ӿ][A-Za-z0-9_Ѐ-ӿ]{2,100})/gi)) {
        const key = `${normalized(match[1])}.${normalized(match[2])}`;
        let target = metadata.get(key);
        if (!target) {
          target = { id: `bsl:metadata:${key}`, language: "bsl", kind: "metadata", name: `${match[1]}.${match[2]}`, path: file.path, start_line: index + 1, end_line: index + 1 };
          metadata.set(key, target); nodes.push(target);
        }
        addEdge(edges, edgeKeys, current, target.id, "reads_metadata", { path: file.path, line: index + 1 });
      }
    }
  }
  let ambiguousCalls = 0;
  for (const call of pendingCalls) {
    const targets = byName.get(normalized(call.name)) ?? [];
    if (targets.length !== 1) { if (targets.length > 1) ambiguousCalls += 1; continue; }
    addEdge(edges, edgeKeys, call.from, targets[0].id, "calls", { path: call.path, line: call.line });
  }
  return { adapter: "bsl-structural", nodes, edges, stats: { files: files.filter(item => BSL_EXTENSIONS.has(item.extension)).length, definitions: nodes.filter(item => ["function", "procedure"].includes(item.kind)).length, metadata_nodes: metadata.size, ambiguous_calls: ambiguousCalls } };
}

function loadTypeScript(root) {
  try { return createRequire(path.join(root, "package.json"))("typescript"); } catch { return null; }
}

function tsDeclarationName(ts, node) {
  if (ts.isFunctionDeclaration(node) && node.name) return { name: node.name, kind: "function" };
  if (ts.isClassDeclaration(node) && node.name) return { name: node.name, kind: "class" };
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) return { name: node.name, kind: "method" };
  if (ts.isVariableDeclaration(node) && node.name && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return { name: node.name, kind: "function" };
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isSourceFile(node.parent?.parent?.parent)) return { name: node.name, kind: "variable" };
  if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return { name: node.name, kind: "property" };
  return null;
}

function parseTypeScript(root, files) {
  const selected = files.filter(item => item.root === root && TS_EXTENSIONS.has(item.extension));
  if (!selected.length) return { adapter: "typescript-compiler", nodes: [], edges: [], stats: { files: 0, compiler_available: false } };
  const ts = loadTypeScript(root.path);
  if (!ts) return { adapter: "typescript-unavailable", nodes: [], edges: [], stats: { files: selected.length, compiler_available: false } };
  const fileByAbsolute = new Map(selected.map(file => [path.resolve(file.absolute).toLowerCase(), file]));
  const program = ts.createProgram(selected.map(file => file.absolute), {
    allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX, resolveJsonModule: true
  });
  const checker = program.getTypeChecker(), nodes = [], edges = [], edgeKeys = new Set(), symbolNodes = new Map(), nodeBySyntax = new Map(), modules = new Map();
  const projectSources = program.getSourceFiles().filter(source => fileByAbsolute.has(path.resolve(source.fileName).toLowerCase()));
  const resolveSymbol = symbol => symbol && (symbol.flags & ts.SymbolFlags.Alias) ? (() => { try { return checker.getAliasedSymbol(symbol); } catch { return symbol; } })() : symbol;
  for (const source of projectSources) {
    const file = fileByAbsolute.get(path.resolve(source.fileName).toLowerCase()), moduleId = `ts:${file.path}:module`;
    modules.set(source, moduleId);
    nodes.push({ id: moduleId, language: "typescript", kind: "module", name: path.basename(file.path), path: file.path, start_line: 1, end_line: source.getLineAndCharacterOfPosition(source.end).line + 1 });
    const visit = syntax => {
      const declaration = tsDeclarationName(ts, syntax);
      if (declaration) {
        const name = declaration.name.getText(source), position = source.getLineAndCharacterOfPosition(syntax.getStart(source)), end = source.getLineAndCharacterOfPosition(syntax.end);
        const id = `ts:${file.path}:${syntax.getStart(source)}:${name}`;
        const item = { id, language: "typescript", kind: declaration.kind, name, path: file.path, start_line: position.line + 1, end_line: end.line + 1 };
        let parentUnit = null;
        for (let current = syntax.parent; current && !parentUnit; current = current.parent) parentUnit = nodeBySyntax.get(current) ?? null;
        nodes.push(item); nodeBySyntax.set(syntax, item);
        const symbol = resolveSymbol(checker.getSymbolAtLocation(declaration.name));
        if (symbol) symbolNodes.set(symbol, item);
        addEdge(edges, edgeKeys, parentUnit?.id ?? moduleId, id, "contains");
      }
      ts.forEachChild(syntax, visit);
    };
    visit(source);
  }
  const containingUnit = syntax => {
    for (let current = syntax; current; current = current.parent) if (nodeBySyntax.has(current)) return nodeBySyntax.get(current).id;
    return modules.get(syntax.getSourceFile());
  };
  let resolvedReferences = 0, unresolvedCalls = 0;
  for (const source of projectSources) {
    const file = fileByAbsolute.get(path.resolve(source.fileName).toLowerCase());
    const visit = syntax => {
      if (ts.isCallExpression(syntax) || ts.isNewExpression(syntax)) {
        const expression = syntax.expression, symbol = resolveSymbol(checker.getSymbolAtLocation(expression));
        const target = symbolNodes.get(symbol), from = containingUnit(syntax);
        if (target) {
          const position = source.getLineAndCharacterOfPosition(syntax.getStart(source));
          addEdge(edges, edgeKeys, from, target.id, ts.isNewExpression(syntax) ? "constructs" : "calls", { path: file.path, line: position.line + 1 });
        } else unresolvedCalls += 1;
      } else if (ts.isIdentifier(syntax)) {
        const symbol = resolveSymbol(checker.getSymbolAtLocation(syntax)), target = symbolNodes.get(symbol), from = containingUnit(syntax);
        if (target && from && from !== target.id) {
          addEdge(edges, edgeKeys, from, target.id, "references"); resolvedReferences += 1;
        }
      }
      ts.forEachChild(syntax, visit);
    };
    visit(source);
  }
  return { adapter: "typescript-compiler", nodes, edges, stats: { files: selected.length, compiler_available: true, definitions: symbolNodes.size, resolved_references: resolvedReferences, unresolved_calls: unresolvedCalls, semantic_diagnostics: program.getSemanticDiagnostics().length } };
}

function selectGraph(parts, exactTerms, contextParts, lexical, nodes, edges, limits) {
  const byPath = new Map();
  for (const node of nodes) {
    if (!byPath.has(node.path)) byPath.set(node.path, []);
    byPath.get(node.path).push(node);
  }
  const partDocuments = new Map();
  for (const node of nodes) for (const part of new Set(identifierParts(node.name))) partDocuments.set(part, (partDocuments.get(part) ?? 0) + 1);
  const partWeight = part => Math.max(4, Math.round(Math.log((nodes.length + 1) / ((partDocuments.get(part) ?? 0) + 1)) * 35));
  const scores = new Map(), reasons = new Map();
  const score = (id, value, reason, mode = "add") => {
    scores.set(id, mode === "max" ? Math.max(scores.get(id) ?? 0, value) : (scores.get(id) ?? 0) + value);
    if (!reasons.has(id)) reasons.set(id, new Set());
    reasons.get(id).add(reason);
  };
  for (const [index, file] of (lexical?.files ?? []).entries()) {
    const candidates = byPath.get(file.path) ?? [], matched = new Set();
    for (const hit of file.matches ?? []) {
      const containing = candidates.filter(node => node.kind !== "module" && hit.line >= node.start_line && hit.line <= node.end_line)
        .sort((left, right) => (left.end_line - left.start_line) - (right.end_line - right.start_line))[0];
      if (containing) matched.add(containing.id);
    }
    if (!matched.size) {
      const module = candidates.find(node => node.kind === "module");
      if (module) matched.add(module.id);
    }
    for (const id of matched) score(id, Math.max(30, 160 - index * 2), "lexical_location");
  }
  for (const node of nodes) {
    const words = identifierParts(node.name);
    const matching = parts.filter(part => words.some(word => word.includes(part) || part.includes(word)));
    if (matching.length) score(node.id, matching.map(partWeight).sort((left, right) => right - left).slice(0, 3).reduce((total, value) => total + value, 0), "identifier_match");
    if (exactTerms.has(normalized(node.name))) score(node.id, exactTerms.get(normalized(node.name)) + partWeight(normalized(node.name)), "exact_identifier");
    // Domain wording often names the subsystem rather than a symbol: "выгрузка Dashboard" points at
    // мпВыгрузкаДанныхВДашборд even though avgCost is introduced only downstream. Reward rare request
    // parts found in a source path, but keep this below an exact identifier match and cap the effect.
    const pathWords = identifierParts(node.path);
    const pathMatches = contextParts.filter(part => pathWords.some(word => word.includes(part) || part.includes(word)));
    if (pathMatches.length) score(node.id, Math.min(900, 300 * new Set(pathMatches).size), "request_path_match");
  }
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const adjacency = new Map();
  for (const edge of edges) {
    if (edge.type === "contains" && nodesById.get(edge.from)?.kind === "module") continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from).push({ id: edge.to, edge });
    adjacency.get(edge.to).push({ id: edge.from, edge });
  }
  let frontier = [...scores.keys()].map(id => ({ id, depth: 0 })), expanded = new Set(frontier.map(item => item.id));
  while (frontier.length) {
    const current = frontier.shift();
    if (current.depth >= limits.depth) continue;
    for (const linked of adjacency.get(current.id) ?? []) {
      const base = linked.edge.type === "calls" || linked.edge.type === "constructs" ? 64 : linked.edge.type === "reads_metadata" ? 52 : linked.edge.type === "contains" ? 44 : 18;
      const inherited = Math.round((scores.get(current.id) ?? 0) * (current.depth === 0 ? 0.45 : 0.35));
      score(linked.id, Math.max(6, base >> current.depth, inherited), `graph_${linked.edge.type}`, "max");
      if (!expanded.has(linked.id)) { expanded.add(linked.id); frontier.push({ id: linked.id, depth: current.depth + 1 }); }
    }
  }
  const selected = [], names = new Map(), paths = new Map();
  for (const node of nodes.filter(node => scores.has(node.id)).sort((left, right) => scores.get(right.id) - scores.get(left.id) || left.path.localeCompare(right.path, "en") || left.start_line - right.start_line)) {
    const name = normalized(node.name);
    if ((names.get(name) ?? 0) >= 2 || (paths.get(node.path) ?? 0) >= 10) continue;
    selected.push({ ...node, score: scores.get(node.id), reasons: [...reasons.get(node.id)].sort() });
    names.set(name, (names.get(name) ?? 0) + 1); paths.set(node.path, (paths.get(node.path) ?? 0) + 1);
    if (selected.length >= limits.maxNodes) break;
  }
  const ids = new Set(selected.map(node => node.id));
  const selectedEdges = edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)).slice(0, limits.maxEdges);
  const ranked = new Map();
  for (const node of selected) ranked.set(node.path, Math.max(ranked.get(node.path) ?? 0, node.score));
  return { nodes: selected, edges: selectedEdges, ranked_files: [...ranked.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "en")).slice(0, limits.maxRankedFiles).map(([path, score]) => ({ path, score })) };
}

export function buildCodeIntelligence(roots, scope, terms, lexical = {}, options = {}) {
  const started = performance.now();
  const limits = { maxFiles: options.maxFiles ?? 3000, maxFileBytes: options.maxFileBytes ?? 1024 * 1024, maxNodes: options.maxNodes ?? 40, maxEdges: options.maxEdges ?? 80, maxRankedFiles: options.maxRankedFiles ?? 24, depth: options.depth ?? 2 };
  const collected = collectFiles(roots, scope, limits), adapters = [parseBsl(collected.files)];
  for (const root of roots) adapters.push(parseTypeScript(root, collected.files));
  const allNodes = adapters.flatMap(adapter => adapter.nodes), allEdges = adapters.flatMap(adapter => adapter.edges);
  const parts = [...new Set((terms ?? []).flatMap(identifierParts))];
  const contextParts = [...new Set((options.contextTerms ?? []).flatMap(identifierParts))];
  const primary = new Set((options.primaryTerms ?? []).map(normalized));
  const exactTerms = new Map((terms ?? []).map((term, index) => [normalized(term), primary.size
    ? (primary.has(normalized(term)) ? Math.max(1400, 2200 - index * 120) : Math.max(260, 620 - index * 20))
    : Math.max(520, 2000 - index * 96)]));
  const selected = selectGraph(parts, exactTerms, contextParts, lexical, allNodes, allEdges, limits);
  return {
    schema_version: 1,
    strategy: "lexical_to_language_graph",
    primary_terms: [...primary],
    adapters: adapters.filter(adapter => adapter.stats.files > 0).map(adapter => ({ name: adapter.adapter, ...adapter.stats })),
    completeness: { eligible_files: collected.eligible, parsed_files: collected.files.length, skipped_large_files: collected.skippedLarge, file_scan_truncated: collected.truncated },
    statistics: { terms: terms?.length ?? 0, identifier_parts: parts.length, graph_nodes: allNodes.length, graph_edges: allEdges.length, returned_nodes: selected.nodes.length, returned_edges: selected.edges.length, duration_ms: Math.round(performance.now() - started) },
    ...selected
  };
}

export function mergeGraphMatches(lexical, intelligence, maxFiles = 40) {
  const files = (lexical.files ?? []).map((file, index) => ({ ...file, lexical_rank: index })), byPath = new Map(files.map(file => [file.path, file]));
  for (const ranked of intelligence.ranked_files ?? []) {
    const nodes = intelligence.nodes.filter(node => node.path === ranked.path).slice(0, 6);
    if (byPath.has(ranked.path)) {
      byPath.get(ranked.path).graph = { score: ranked.score, nodes: nodes.map(node => ({ kind: node.kind, name: node.name, line: node.start_line, reasons: node.reasons })) };
      continue;
    }
    const item = { path: ranked.path, root: null, bytes: null, matches: nodes.map(node => ({ line: node.start_line, term: node.name, text: `${node.kind} ${node.name}` })), graph: { score: ranked.score, nodes: nodes.map(node => ({ kind: node.kind, name: node.name, line: node.start_line, reasons: node.reasons })) } };
    files.push(item); byPath.set(item.path, item);
  }
  // A graph expansion is supporting evidence, not permission to bury an exact lexical hit. In 0.4.0
  // an unrelated module with many graph edges displaced the only document containing avgCost. Combine
  // exact request identifiers with graph evidence: this interleaves the prior conclusion document with
  // the implementation paths instead of returning forty prose hits or forty graph nodes exclusively.
  const primaryTerms = new Map((intelligence.primary_terms ?? []).map((term, index) => [normalized(term), index]));
  const primaryHits = file => new Set((file.matches ?? []).map(match => normalized(match.term)).filter(term => primaryTerms.has(term))).size;
  const pathPrimaryHits = file => [...primaryTerms.keys()].filter(term => normalized(file.path).includes(term.replaceAll(".", "-")) || normalized(file.path).includes(term)).length;
  const lexicalAnchors = files.filter(file => primaryHits(file) > 0).sort((left, right) => pathPrimaryHits(right) - pathPrimaryHits(left) || primaryHits(right) - primaryHits(left) || left.lexical_rank - right.lexical_rank || left.path.localeCompare(right.path, "en"));
  const graphAnchors = files.filter(file => file.graph?.score).sort((left, right) => primaryHits(right) - primaryHits(left) || right.graph.score - left.graph.score || left.path.localeCompare(right.path, "en"));
  const lexicalRest = files.filter(file => Number.isInteger(file.lexical_rank)).sort((left, right) => left.lexical_rank - right.lexical_rank || left.path.localeCompare(right.path, "en"));
  const ordered = [], seen = new Set();
  const append = file => { if (file && !seen.has(file.path)) { seen.add(file.path); ordered.push(file); } };
  // Reserve both kinds of proof before filling the rest: exact request identifiers (including a prior
  // analysis document) and the strongest language-graph paths. This diversity survives the later byte
  // fit even when it has room for only six compact records.
  lexicalAnchors.slice(0, 2).forEach(append);
  graphAnchors.slice(0, 4).forEach(append);
  lexicalAnchors.forEach(append);
  graphAnchors.forEach(append);
  lexicalRest.forEach(append);
  files.forEach(append);
  return { ...lexical, files: ordered.slice(0, maxFiles), truncated: lexical.truncated || ordered.length > maxFiles, code_intelligence: intelligence };
}
