import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { findRoot, resolveInRoot, displayPath } from "./project-roots.mjs";

const IGNORED = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".venv", "__pycache__", "vendor", "tmp", "temp"]);
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|7z|rar|exe|dll|so|dylib|epf|erf|cf[eu]|mp[34]|wav|ogg|ttf|woff2?|sqlite3?|db|wal|shm|ndjson)$/i;
const SOURCE_CODE = /\.(?:[cm]?[jt]sx?|bsl|os|py|go|rs|java|kt|kts|cs|cpp|cxx|cc|c|hpp|hxx|hh|h|rb|php|swift|scala|sql|ps1|psm1|sh|bash|zsh|fish|lua|fs|fsx|vb|xml|xsd|html?|css|scss|sass|less|vue|svelte)$/i;
const GENERATED_PATH = /(?:^|\/)(?:generated|dist|build|out|coverage|node_modules)(?:\/|$)/i;

export const RESEARCH_SOURCE_RANKING = Object.freeze({
  selected_files: 8,
  // Keep enough corpus-owned identifiers for a rare phrase such as external-control-plane to survive
  // ordinary changelog and readiness growth without widening the number of files opened or returned.
  expansion: Object.freeze({ maxFiles: 24, proseFiles: 120, identifierTerms: 40 }),
  candidate_multiplier: 2,
  minimum_candidates: 16
});

export function researchSourceRankingOptions(selectedFiles = RESEARCH_SOURCE_RANKING.selected_files) {
  return Object.freeze({
    expansion: RESEARCH_SOURCE_RANKING.expansion,
    search: Object.freeze({ maxFiles: Math.max(selectedFiles * RESEARCH_SOURCE_RANKING.candidate_multiplier, RESEARCH_SOURCE_RANKING.minimum_candidates) })
  });
}

export function isSourceCodePath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  return SOURCE_CODE.test(normalized) && !GENERATED_PATH.test(normalized);
}

// Git pathspec magic `:(glob)` shares this scope's wildcard semantics: `*` stops at a separator and a
// `**` segment crosses them. It does not share character classes or brace expansion, and it rejects a
// `**` mixed into a segment, so a pattern using any of those cannot be pushed down without changing
// what it selects. Pushdown is all-or-nothing: the scope matches when any pattern matches, so sending
// only the representable ones would enumerate less than the scope and lose files silently.
function pathspecRepresentable(pattern) {
  const normalized = String(pattern).replaceAll("\\", "/");
  if (!normalized || normalized === "**") return false;
  if (/[[\]{}]/.test(normalized) || /^[!:^]/.test(normalized)) return false;
  return normalized.split("/").every(segment => !segment.includes("**") || segment === "**");
}

function compilePathspecs(scope) {
  const patterns = scope?.patterns ?? [];
  if (!patterns.length) return { include: [], pushdown: false, reason: "scope_not_narrowed" };
  const unsupported = patterns.find(pattern => !pathspecRepresentable(pattern));
  if (unsupported !== undefined) return { include: [], pushdown: false, reason: `pattern_not_representable:${String(unsupported).slice(0, 60)}` };
  return { include: patterns.map(pattern => `:(glob)${String(pattern).replaceAll("\\", "/")}`), pushdown: true, reason: null };
}

// The ignored directory names stay a filter here rather than becoming exclude pathspecs. Combining an
// include pathspec with an exclusion produced an empty listing for several ordinary names on git
// 2.49 (`dist`, `vendor`, `tmp`), and an exclusion that git reads more broadly than we do would
// enumerate less than the scope — the one direction this must never fail in. The names cost nothing to
// drop after enumeration, so the risk buys nothing.

// git knows which files belong to the project and which are build output or ignored noise, and it
// answers in one call for a whole tree. Walking is the fallback for a root that is not a repository;
// it applies the same exclusions by name, because a node_modules listed file by file would fill the
// budget with nothing a role can use.
//
// The scope is applied before the cap, not after. Applied after, the cap decided which files the scope
// was ever allowed to see: on a 13k-path repository a class at position 8531 was never enumerated even
// though the scope named exactly its directory, and the answer came back "not found" rather than
// "not looked at". Where the scope can be expressed as a pathspec it is also pushed into git, so the
// out-of-scope paths of a 100k-file export are never materialized at all.
export function listFiles(rootPath, { maxFiles = 20_000, scope = null, readDirectory = fs.readdirSync, runGit = execFileSync } = {}) {
  const gitMetadataPresent = fs.existsSync(path.join(rootPath, ".git"));
  const inScope = scope ? file => scope.matches(file) : () => true;
  const specs = compilePathspecs(scope);
  const scopedWalkRequired = Boolean(scope?.narrowed && !specs.pushdown && specs.reason?.startsWith("pattern_not_representable:"));
  try {
    // A pattern Git interprets differently must not be replaced by an unscoped `git ls-files` over the
    // whole corpus. That recreates the 107k-path materialisation the scope pushdown exists to avoid.
    // The bounded filesystem fallback is deliberately non-authoritative: it can find evidence, but it
    // cannot support a corpus-wide negative claim.
    if (scopedWalkRequired) throw Object.assign(new Error("SCOPE_PATHSPEC_NOT_REPRESENTABLE"), { code: "SCOPE_PATHSPEC_NOT_REPRESENTABLE" });
    const top = runGit("git", ["rev-parse", "--show-toplevel"], { cwd: rootPath, encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!sameDirectory(top, rootPath)) throw Object.assign(new Error("GIT_ROOT_MISMATCH"), { code: "GIT_ROOT_MISMATCH" });
    const pathspec = specs.include;
    const git = parameters => runGit("git", pathspec.length ? [...parameters, "--", ...pathspec] : parameters, { cwd: rootPath, encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    // NUL output is not quoted by Git. Without it, a Cyrillic path is returned as a quoted sequence of
    // octal bytes under the default core.quotePath setting; the inventory then names a file that does
    // not exist and source search silently skips the actual 1C module.
    const output = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    // `git ls-files --cached` also reports tracked paths deleted from the current working tree. They
    // are history, not readable corpus evidence; counting them as skipped files makes a complete scan
    // look incomplete and sends the planner searching for content that does not exist at this revision.
    // Asking git for that set costs one call; deciding it per path cost a stat syscall for every file
    // in the repository, which on a full ERP export is over a hundred thousand of them.
    const deleted = new Set(git(["ls-files", "-z", "--deleted"]).split("\0").filter(Boolean));
    const seen = new Set();
    const files = [];
    let matched = 0;
    for (const file of output.split("\0")) {
      // A conflicted path is listed once per stage, so the same file would otherwise be counted and
      // opened several times and would consume the cap several times over.
      if (!file || deleted.has(file) || seen.has(file)) continue;
      seen.add(file);
      if (file.split("/").some(part => IGNORED.has(part)) || !inScope(file)) continue;
      matched += 1;
      if (files.length < maxFiles) files.push(file);
    }
    return {
      files, source: "git", authoritative: true, truncated: matched > maxFiles,
      enumeration_rule: "tracked_plus_untracked_nonignored", matched_files: matched,
      scope_pushdown: specs.pushdown, scope_pushdown_reason: specs.reason
    };
  } catch (gitError) {
    const files = [];
    let matched = 0, visited = 0, readErrors = 0, walkTruncated = false;
    const visitLimit = Math.max(maxFiles + 1, maxFiles * 4);
    const walk = (directory, prefix) => {
      if (walkTruncated) return;
      let entries;
      try { entries = readDirectory(directory, { withFileTypes: true }); } catch { readErrors += 1; return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        if (walkTruncated) break;
        if (IGNORED.has(entry.name)) continue;
        visited += 1;
        if (visited > visitLimit) { walkTruncated = true; break; }
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
        else if (entry.isFile() && inScope(relative)) {
          matched += 1;
          if (files.length < maxFiles) files.push(relative);
        }
      }
    };
    walk(rootPath, "");
    // A plain content tree remains an authoritative filesystem corpus when Git is unavailable.
    // A tree containing .git does not: without Git we cannot reproduce its ignored-file boundary.
    const gitUnavailable = gitError?.code === "ENOENT";
    const notRepository = !gitMetadataPresent && (gitError?.status === 128 || gitUnavailable);
    const authoritative = notRepository && !scopedWalkRequired && readErrors === 0;
    return {
      files, source: scopedWalkRequired ? "walk_scope_fallback" : authoritative ? "walk" : "walk_after_git_error", authoritative,
      truncated: matched > maxFiles || walkTruncated, enumeration_rule: "bounded_filesystem_excluding_platform_ignored_names",
      matched_files: matched, scope_pushdown: false,
      scope_pushdown_reason: specs.pushdown ? "filesystem_walk_cannot_use_pathspec" : specs.reason,
      fallback_reason: authoritative ? "not_a_git_repository" : String(gitError?.code ?? gitError?.message ?? "git_enumeration_failed").slice(0, 120),
      visited_entries: visited, read_errors: readErrors
    };
  }
}

function fileSize(file) { try { return fs.statSync(file).size; } catch { return null; } }
function sameDirectory(left, right) {
  const canonical = value => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
  return canonical(left).localeCompare(canonical(right), "en", { sensitivity: process.platform === "win32" ? "accent" : "variant" }) === 0;
}

function topLevel(file) { return file.includes("/") ? file.slice(0, file.indexOf("/")) : "."; }
function pathDepth(file) { return file.split("/").length; }

// A lexicographic slice of a large repository can be nothing but .claude and .codex. Round-robin by
// top-level area keeps the cap while ensuring that source, documentation and project metadata are all
// represented. Shallow files lead inside each area because they usually explain its structure.
function balancedInventory(files, limit) {
  const groups = new Map();
  for (const file of files) {
    const key = topLevel(file);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  for (const group of groups.values()) group.sort((a, b) => pathDepth(a) - pathDepth(b) || a.localeCompare(b, "en"));
  const keys = [...groups.keys()].sort((a, b) => {
    const rank = value => value === "." ? 0 : value.startsWith(".") ? 2 : 1;
    return rank(a) - rank(b) || a.localeCompare(b, "en");
  });
  const selected = [];
  for (let index = 0; selected.length < limit; index += 1) {
    let found = false;
    for (const key of keys) {
      const file = groups.get(key)[index];
      if (file === undefined) continue;
      selected.push(file); found = true;
      if (selected.length >= limit) break;
    }
    if (!found) break;
  }
  return selected;
}

// Registering the project registered its directory; asking separately for permission to look at that
// directory would be registering it twice. The default scope is what git already answers - the tracked
// and unignored files, which is the project's own statement of what belongs to it - and a workflow that
// declares `sources` narrows that rather than switching it on.
//
// Two things stay out whatever is declared. A credential-shaped or dump-shaped name is refused by name,
// because the cost of collecting one of those is not proportional to the convenience of not having to
// exclude it; this is the shape the release lint already refuses to publish. Everything git ignores is
// absent already, which is where build output and local state live.
const SECRET_NAMES = /(^|\/)(?:auth\.json|secrets?(?:\.[^/]*)?|cookies?(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|\.env(?:\..*)?|[^/]*\.(?:pem|key|p12|pfx|crt|db|sqlite|sqlite3|wal|shm|log|dump|bak))$/i;
// Keep sentinels as source escape sequences rather than literal control bytes. Literal NUL/SOH make
// repository scanners classify this source-boundary implementation as binary and silently skip it.
const GLOB_DIRECTORY_WILDCARD = "\u0000";
const GLOB_ANY_WILDCARD = "\u0001";

function patternToExpression(pattern) {
  const escaped = String(pattern).replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replaceAll("**/", GLOB_DIRECTORY_WILDCARD).replaceAll("**", GLOB_ANY_WILDCARD)
    .replaceAll("*", "[^/]*").replaceAll("?", "[^/]")
    .replaceAll(GLOB_DIRECTORY_WILDCARD, "(?:.*/)?").replaceAll(GLOB_ANY_WILDCARD, ".*");
  return new RegExp(`^${body}$`);
}

export function sourceScope(patterns) {
  const expressions = (patterns ?? []).map(patternToExpression);
  return {
    narrowed: expressions.length > 0,
    patterns: [...(patterns ?? [])],
    matches: value => {
      const candidate = String(value).replaceAll("\\", "/");
      if (SECRET_NAMES.test(candidate)) return false;
      return !expressions.length || expressions.some(expression => expression.test(candidate));
    }
  };
}

// The inventory is what lets a planner name paths whose contents it has not been shown. It is capped
// because a large repository would otherwise spend the whole context budget on a file list, and the cap
// is reported rather than hidden: a planner that cannot see the whole scope has to know that.
export function sourceInventory(roots, scope, { maxFilesPerRoot = 400 } = {}) {
  return roots.map(root => {
    const listing = listFiles(root.path, { maxFiles: 20_000, scope });
    const inScope = listing.files;
    const directories = {};
    for (const file of inScope) directories[topLevel(file)] = (directories[topLevel(file)] ?? 0) + 1;
    return {
      root: root.key, access: root.access, path: root.path, listing_source: listing.source,
      total_files: listing.matched_files ?? inScope.length, enumeration_complete: listing.authoritative && !listing.truncated,
      truncated: listing.truncated || inScope.length > maxFilesPerRoot, directories,
      files: balancedInventory(inScope, maxFilesPerRoot).map(file => ({ path: displayPath(root, file), bytes: fileSize(path.join(root.path, file)) }))
    };
  });
}

// The classifier decides a route, not an implementation, and a full file list would crowd out the parts
// of the snapshot it actually weighs. A count per top-level directory says what kind of project this is
// and what it holds, which is the whole of what that decision needs.
export function inventorySummary(inventory) {
  return (inventory ?? []).map(entry => {
    const directories = entry.directories ?? {};
    return { root: entry.root, access: entry.access, total_files: entry.total_files, truncated: entry.truncated, directories };
  });
}

// An inventory tells a planner what exists, not where the thing it was asked about lives, and in a
// project of a thousand files those are very different questions: choosing paths by name is guessing.
// What a person does first is search for the identifiers the request already contains, and that is
// deterministic, so the platform does it before any model is called.
//
// A term is taken only when it looks like something from the code rather than from the sentence around
// it: a dotted or underscored name, something with an interior capital, or a bare number long enough to
// be an article or an identifier. Ordinary prose words find everything and mean nothing.
const TERM_PATTERN = /[A-Za-zЀ-ӿ_][A-Za-z0-9Ѐ-ӿ_.]{3,63}|\b\d{5,12}\b/g;

// Codex prepends attachment metadata to the actual request. Paths and generated attachment names are
// transport context, not subject vocabulary; letting them lead source search ranks AppData above the
// identifier the person actually asked about.
function requestText(message) {
  const text = String(message ?? "");
  // Codex task coordination wraps the actual request in a delegation envelope. Transport fields such
  // as source_thread_id are code-shaped and used to consume the exact-term limit before the domain
  // identifiers inside <input> were reached. Search the delegated input, not its routing metadata.
  const delegated = text.match(/<codex_delegation\b[^>]*>[\s\S]*?<input>([\s\S]*?)<\/input>[\s\S]*?<\/codex_delegation>/i);
  if (delegated) return delegated[1];
  const marker = text.match(/(?:^|\n)## My request:\s*\n/i);
  return marker ? text.slice((marker.index ?? 0) + marker[0].length) : text;
}

export function searchTerms(message, limit = 12) {
  const seen = new Map();
  for (const match of requestText(message).matchAll(TERM_PATTERN)) {
    const term = match[0].replace(/[.]+$/, "");
    const distinctive = /\d{5,}/.test(term) || term.includes(".") || term.includes("_") || /[a-zа-я][A-ZА-Я]/.test(term);
    if (!distinctive || term.length < 4) continue;
    seen.set(term, (seen.get(term) ?? 0) + 1);
  }
  return [...seen.keys()].slice(0, limit);
}

// The words a request is actually written in are the ones a regular expression throws away, and they
// are the ones that carry the meaning: "себестоимость" says what is wanted, avgCost says where it lives.
// A project pairs the two itself — in labels, comments and query text — so the ordinary words are worth
// searching for, and the identifiers standing beside them are the answer.
const PROSE_PATTERN = /[A-Za-zЀ-ӿ][A-Za-zЀ-ӿ-]{4,31}/g;

export function proseTerms(message, limit = 64) {
  const counted = new Map();
  for (const match of requestText(message).matchAll(PROSE_PATTERN)) {
    const word = match[0].toLowerCase();
    if (/[a-zа-я][A-ZА-Я]/.test(match[0])) continue;
    counted.set(word, (counted.get(word) ?? 0) + 1);
  }
  // This is only the candidate pool. expandTerms measures every candidate against the project corpus
  // and discards high document-frequency language without any language-specific dictionary.
  return [...counted.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word]) => word);
}

// An identifier is harvested from a matching line only where the line itself marks it as one: a value
// behind a key, a member behind a dot, or a name with an interior capital. Taking every word instead
// would return the prose back again, and the second pass would search for what it started from.
// Markdown writes "Слово: значение" on every other line, so a name standing before a colon is only an
// identifier when it is shaped like one — an interior capital or an underscore. A member behind a dot
// needs no such proof: prose does not write .Себестоимость.
const CODE_SHAPED = /[a-zа-яё][A-ZА-ЯЁ]|_/;
const HARVEST = [
  { pattern: /([A-Za-z_Ѐ-ӿ][A-Za-z0-9_Ѐ-ӿ]{2,63})\s*[:=]/g, shaped: true },
  { pattern: /\.([A-Za-z_Ѐ-ӿ][A-Za-z0-9_Ѐ-ӿ]{2,63})/g, shaped: false },
  { pattern: /\b([A-Za-z_Ѐ-ӿ][A-Za-z0-9_Ѐ-ӿ]*[a-zа-я][A-ZА-Я][A-Za-z0-9_Ѐ-ӿ]*)\b/g, shaped: true },
  // A bilingual project document is part of the corpus-owned vocabulary bridge too. On a line that
  // actually matches the non-Latin subject, retain adjacent Latin technical words such as
  // "external control plane". They are not guessed translations: every candidate is read from a
  // subject-bearing project line and still has to pass the corpus-spread filter below.
  { pattern: /\b([A-Za-z][A-Za-z0-9-]{4,63})\b/g, shaped: false, crossLanguage: true }
];

// A name that turns up in most of the files it could turn up in describes the language, not the subject:
// label, name, length, stdout. Rarity is what makes a name worth searching for, and it is measurable —
// no list of forbidden words to keep up to date, and it adapts to whatever the project is written in.
export function harvestIdentifiers(hitsByFile, exclude, limit = 8, subjectTerms = []) {
  const total = new Map(), documents = new Map(), relevance = new Map();
  const excluded = new Set(exclude.map(item => item.toLowerCase()));
  for (const lines of hitsByFile) {
    const here = new Set();
    for (const entry of lines) {
      const line = typeof entry === "string" ? entry : entry.text;
      const crossLanguageAllowed = typeof entry === "string" ? true : entry.cross_language;
      const loweredLine = line.toLowerCase();
      const subjectPositions = subjectTerms.map(term => loweredLine.indexOf(term.toLowerCase())).filter(index => index >= 0);
      for (const { pattern, shaped, crossLanguage } of HARVEST) {
        if (crossLanguage && (!crossLanguageAllowed || !subjectPositions.length || !/[Ѐ-ӿ]/.test(line))) continue;
        for (const match of line.matchAll(pattern)) {
          const name = match[1];
          if (name.length < 5 || excluded.has(name.toLowerCase())) continue;
          if (shaped && !CODE_SHAPED.test(name)) continue;
          total.set(name, (total.get(name) ?? 0) + 1);
          const distance = subjectPositions.length ? Math.min(...subjectPositions.map(index => Math.abs(index - (match.index ?? 0)))) : 1000;
          // A language bridge is useful evidence, not an absolute trump card. Its bounded bonus sits
          // inside ordinary subject relevance so a stray bilingual product name cannot outrank a much
          // closer implementation identifier merely because it came from prose.
          const quality = Math.min(subjectPositions.length, 2) * 1000 + Math.max(0, 1000 - distance) + (crossLanguage ? 400 : 0);
          relevance.set(name, Math.max(relevance.get(name) ?? 0, quality));
          here.add(name);
        }
      }
    }
    for (const name of here) documents.set(name, (documents.get(name) ?? 0) + 1);
  }
  const spread = Math.max(1, Math.ceil(hitsByFile.length * 0.34));
  const specific = [...total.entries()].filter(([name]) => documents.get(name) <= spread);
  // A camelCase/PascalCase/underscored name carries a vocabulary bridge of its own. A bare member such
  // as `.equal()` is valid code, but it should not outrank `avgCost` merely because test helpers repeat
  // it more often on the first-pass lines. Corpus spread remains the first discriminator inside each
  // shape class, then repeated local evidence breaks ties.
  return specific.sort((a, b) => (relevance.get(b[0]) ?? 0) - (relevance.get(a[0]) ?? 0) || Number(CODE_SHAPED.test(b[0])) - Number(CODE_SHAPED.test(a[0])) || (documents.get(a[0]) ?? 0) - (documents.get(b[0]) ?? 0) || b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0], "en")).slice(0, limit).map(([name]) => name);
}

// A word is written one way in the request and another in the code: "себестоимости" in a sentence,
// "Себестоимость" in a query, "avgCost" beside a label. Matching is case-insensitive and prose is
// matched by its stem, because an inflected ending is exactly the difference that would find nothing.
function stem(word) { return word.length > 7 ? word.slice(0, word.length - 3) : word; }

function matchingLines(text, terms, maxPerFile) {
  const found = [], counts = new Map(), firstByTerm = new Map();
  const prepared = terms.map((term, priority) => ({ term, needle: term.toLowerCase(), priority }));
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lowered = line.toLowerCase();
    const hits = prepared.filter(item => lowered.includes(item.needle));
    for (const hit of hits) {
      counts.set(hit.term, (counts.get(hit.term) ?? 0) + 1);
      const candidate = { line: index + 1, term: hit.term, text: line.trim().slice(0, 240), priority: hit.priority };
      if (!firstByTerm.has(hit.term)) firstByTerm.set(hit.term, candidate);
      if (found.length < maxPerFile) { found.push(candidate); continue; }
      // Do not let six generic matches near the top of a large module hide an exact identifier near
      // the bottom. Keep a fixed-size best set over the whole file, ordered by request-derived term
      // priority and then source line for deterministic excerpts.
      let worst = 0;
      for (let cursor = 1; cursor < found.length; cursor += 1) {
        if (found[cursor].priority > found[worst].priority || (found[cursor].priority === found[worst].priority && found[cursor].line > found[worst].line)) worst = cursor;
      }
      if (candidate.priority < found[worst].priority || (candidate.priority === found[worst].priority && candidate.line < found[worst].line)) found[worst] = candidate;
    }
  }
  // Preserve one occurrence for every request-derived term before repeated matches consume the cap.
  // Otherwise a long changelog with many early "check" lines can erase the first "operation" line,
  // which is exactly where bilingual technical vocabulary is often introduced.
  const diverse = [...firstByTerm.values()].sort((left, right) => left.priority - right.priority || left.line - right.line).slice(0, maxPerFile);
  const diverseKeys = new Set(diverse.map(item => `${item.term}\0${item.line}`));
  const remaining = found
    .filter(item => !diverseKeys.has(`${item.term}\0${item.line}`))
    .sort((left, right) => left.priority - right.priority || left.line - right.line)
    .slice(0, Math.max(0, maxPerFile - diverse.length));
  const selected = [...diverse, ...remaining].sort((left, right) => left.priority - right.priority || left.line - right.line);
  return {
    matches: selected.map(({ priority, ...item }) => item),
    counts
  };
}

// The search stays inside the declared scope for the same reason collection does, and it is bounded on
// every axis it could run away on: how many files are opened, how many lines come back from each, and
// how many bytes the whole result may occupy in a prompt.
// How many files may be enumerated and how many may be opened are different budgets. Sharing one made
// the read budget decide the boundary of the search: a scope naming one directory of a large repository
// was still cut at the first 4000 paths in Git order, and everything past them was reported as absent
// rather than as unread.
export function searchSources(roots, scope, terms, { maxFiles = 40, maxMatchesPerFile = 6, maxOpenedFiles = 4000, maxEnumeratedFiles = 20_000, maxFileBytes = 2 * 1024 * 1024, indexedTerms = [], maxIndexedPaths = 200, sourceCodeOnly = false, preferSourceCode = false } = {}) {
  if (!terms.length) return { terms, files: [], searched_files: 0, truncated: false };
  const files = [];
  const termPriority = new Map(terms.map((term, index) => [term, index]));
  const indexed = new Map(indexedTerms.map(term => [term.toLowerCase(), { term, matched_files: 0, matched_lines: 0, paths: [], paths_truncated: false }]));
  const matchedFilesByTerm = new Map();
  let opened = 0, eligible = 0, skippedLarge = 0, readErrors = 0, scanTruncated = false;
  const listings = [];
  for (const root of roots) {
    const listing = listFiles(root.path, { maxFiles: maxEnumeratedFiles, scope });
    listings.push({ root: root.key, source: listing.source, authoritative: listing.authoritative, truncated: listing.truncated, matched_files: listing.matched_files ?? listing.files.length, scope_pushdown: listing.scope_pushdown ?? false });
    if (listing.truncated || !listing.authoritative) scanTruncated = true;
    for (const relative of listing.files) {
      if (BINARY.test(relative)) continue;
      if (sourceCodeOnly && !isSourceCodePath(relative)) continue;
      eligible += 1;
      if (opened >= maxOpenedFiles) { scanTruncated = true; break; }
      const file = path.join(root.path, relative);
      const size = fileSize(file);
      if (size === null || size > maxFileBytes) { skippedLarge += 1; continue; }
      opened += 1;
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch { readErrors += 1; continue; }
      const { matches, counts } = matchingLines(text, terms, maxMatchesPerFile);
      const shownPath = displayPath(root, relative);
      for (const [term, count] of counts) {
        if (count > 0) matchedFilesByTerm.set(term, (matchedFilesByTerm.get(term) ?? 0) + 1);
        const statistic = indexed.get(term.toLowerCase());
        if (!statistic || count <= 0) continue;
        statistic.matched_files += 1;
        statistic.matched_lines += count;
        if (statistic.paths.length < maxIndexedPaths) statistic.paths.push(shownPath);
        else statistic.paths_truncated = true;
      }
      if (matches.length) files.push({ path: displayPath(root, relative), root: root.key, bytes: size, matches });
    }
  }
  // The result cap is applied after the bounded scan. Stopping when the cap first fills makes Git's
  // lexical order an authority: a large .claude directory can prevent a later 1C module from ever being
  // considered. Terms keep their request-derived order, so an exact avgCost match outranks a generic
  // identifier harvested later from project prose.
  const priority = file => Math.min(...file.matches.map(match => termPriority.get(match.term) ?? terms.length));
  const affinityTerms = [...new Set((indexedTerms.length ? indexedTerms : terms).map(term => String(term).toLowerCase()))];
  const pathAffinity = file => {
    if (!preferSourceCode) return 0;
    const basename = path.basename(file.path).toLowerCase();
    const matches = affinityTerms.filter(term => basename.includes(term)).length;
    // One accidental word in a filename is weak evidence. Two independently harvested corpus terms
    // in the same basename form a measurable phrase-level bridge (external + control, state + machine)
    // and may influence ranking without letting a generic name such as approval dominate by itself.
    return matches >= 2 ? matches : 0;
  };
  const implementationAffinity = file => {
    if (!preferSourceCode) return 0;
    const normalized = `/${file.path.toLowerCase().replaceAll("\\", "/")}`;
    if (/(?:^|\/)(?:src|lib|app)(?:\/|$)/.test(normalized)) return 2;
    if (/(?:^|\/)(?:tests?|fixtures|migrations|scripts|hooks|contracts)(?:\/|$)/.test(normalized)) return 0;
    return 1;
  };
  // When prose supplied no explicit identifier, rare corpus-derived terms carry more information than
  // generic words such as status or message. The score is measured from this scan, not maintained as a
  // language-specific stoplist, and only affects the source-preferred research contour.
  const rarity = file => preferSourceCode && !indexedTerms.length
    ? [...new Set(file.matches.map(match => match.term))].reduce((score, term) => score + 1 / Math.max(1, matchedFilesByTerm.get(term) ?? 1), 0)
    : 0;
  files.sort((a, b) => (preferSourceCode ? Number(!isSourceCodePath(a.path)) - Number(!isSourceCodePath(b.path)) : 0)
    || pathAffinity(b) - pathAffinity(a)
    || implementationAffinity(b) - implementationAffinity(a)
    || rarity(b) - rarity(a)
    || priority(a) - priority(b)
    || new Set(b.matches.map(match => match.term)).size - new Set(a.matches.map(match => match.term)).size
    || b.matches.length - a.matches.length
    || a.path.localeCompare(b.path, "en"));
  const resultTruncated = files.length > maxFiles;
  return {
    terms, files: files.slice(0, maxFiles), searched_files: opened,
    truncated: scanTruncated || resultTruncated,
    completeness: { eligible_files: eligible, opened_files: opened, skipped_large_files: skippedLarge, read_errors: readErrors, file_scan_truncated: scanTruncated, result_files_truncated: resultTruncated, enumeration_complete: listings.every(item => item.authoritative && !item.truncated), listings },
    exact_term_index: [...indexed.values()]
  };
}

// Two passes, because the request and the code are written in different vocabularies and the project
// itself holds the translation between them. The first pass searches for the ordinary words of the
// request and finds the places where a person wrote both — a label, a comment, a query. The second pass
// searches for the identifiers standing on those lines. Nothing is guessed: every name searched for in
// the second pass was read out of this project, so it is a name that exists here.
export function expandTerms(roots, scope, message, options = {}) {
  const code = searchTerms(message);
  // Long workflow requests put operational wording before the actual domain question. Eight words was
  // enough for a chat sentence but meant that "repeat the full investigation" displaced "cost" and
  // "dashboard" completely. The corpus rarity filter below is the real bound, so retain enough request
  // vocabulary for the subject at the end of a structured instruction to participate.
  const prose = proseTerms(message, options.proseTerms ?? 64);
  const stems = [...new Set(prose.map(stem))];
  if (!stems.length) return { code, prose, subject: [], harvested: [], terms: code };
  const first = searchSources(roots, scope, stems, { ...options, maxFiles: options.proseFiles ?? 300, maxMatchesPerFile: 12 });
  // The same rarity test picks which of the request's words are worth following. A word from the domain
  // sits in a few files; a word from the sentence around it sits everywhere, and the lines it matched
  // would fill the harvest with the vocabulary of the language rather than of the subject.
  // Rarity is measured against everything that was searched, not against what happened to match. In a
  // project that is mostly prose almost every domain word matches somewhere, so judging a word by its
  // share of the matches called the subject of the request generic and threw it away.
  const filesPerStem = new Map();
  for (const file of first.files) for (const found of new Set(file.matches.map(match => match.term))) filesPerStem.set(found, (filesPerStem.get(found) ?? 0) + 1);
  const spread = Math.max(1, Math.ceil(Math.max(first.searched_files, first.files.length) * 0.34));
  const subject = stems.filter(item => filesPerStem.has(item) && filesPerStem.get(item) <= spread);
  const proseLines = new Map();
  const contextualText = (file, match) => {
    if (isSourceCodePath(file.path)) return match.text;
    try {
      if (!proseLines.has(file.path)) {
        const parsed = parseRootedPath(roots, file.path);
        proseLines.set(file.path, fs.readFileSync(path.join(parsed.root.path, parsed.relative), "utf8").split(/\r?\n/));
      }
      const lines = proseLines.get(file.path), index = match.line - 1;
      return lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).map(line => line.trim().slice(0, 500)).join("\n");
    } catch { return match.text; }
  };
  const hitsByFile = first.files
    .map(file => file.matches.filter(match => subject.includes(match.term)).map(match => ({
      // One neighboring line keeps a bullet/paragraph together. Projects often introduce the human
      // phrase in one line and the exact code term in the next; this remains bounded and file-local.
      text: contextualText(file, match),
      // Bare Latin words bridge human languages only in prose documents. Source files continue to
      // contribute explicit identifiers, but syntax such as const/return cannot become vocabulary.
      cross_language: !isSourceCodePath(file.path)
    })))
    .filter(lines => lines.length);
  const harvested = harvestIdentifiers(hitsByFile, [...prose, ...stems], options.identifierTerms ?? 32, subject);
  return { code, prose, subject, harvested, terms: [...new Set([...code, ...harvested])] };
}

// A bounded source excerpt can prove a local occurrence, but a statement about the whole registered
// corpus needs a different artifact. Scan every eligible text file and retain the complete covered-file
// inventory in run evidence. Reviewer envelopes can then cite the inventory hash and aggregate facts
// without copying hundreds of paths or pretending that a worker summary is primary evidence.
export function scanSourceCorpus(roots, scope, terms, { maxFiles = 20_000, maxFileBytes = 16 * 1024 * 1024, maxLocationsPerTerm = 32 } = {}) {
  const startedAt = process.hrtime.bigint();
  const selectedTerms = [...new Set((terms ?? []).map(String).filter(term => term.length >= 4))].slice(0, 24);
  const occurrences = selectedTerms.map(term => ({ term, count: 0, matched_lines: 0, matched_files: 0, locations: [], locations_truncated: false }));
  const occurrencePartitions = occurrences.map(() => new Map()), partitionBoundary = new Map();
  const files = [], listingEvidence = [];
  let eligibleFiles = 0, scannedFiles = 0, skippedLargeFiles = 0, readErrors = 0, readBytes = 0, fileScanTruncated = false;
  for (const root of roots) {
    const listing = listFiles(root.path, { maxFiles, scope });
    const rootEnumerationComplete = listing.authoritative && !listing.truncated;
    listingEvidence.push({ root: root.key, source: listing.source, authoritative: listing.authoritative, truncated: listing.truncated, enumeration_rule: listing.enumeration_rule, matched_files: listing.matched_files ?? listing.files.length, scope_pushdown: listing.scope_pushdown ?? false, scope_pushdown_reason: listing.scope_pushdown_reason ?? null, fallback_reason: listing.fallback_reason ?? null });
    if (listing.truncated || !listing.authoritative) fileScanTruncated = true;
    for (const relative of listing.files) {
      if (BINARY.test(relative)) continue;
      eligibleFiles += 1;
      const partition = path.extname(relative).toLowerCase() || "<none>", partitionKey = `${root.key}\0${partition}`;
      if (!partitionBoundary.has(partitionKey)) partitionBoundary.set(partitionKey, { root: root.key, partition, enumeration_complete: rootEnumerationComplete, eligible_files: 0, scanned_files: 0, skipped_large_files: 0, read_errors: 0 });
      const partitionStats = partitionBoundary.get(partitionKey); partitionStats.eligible_files += 1;
      if (scannedFiles + skippedLargeFiles + readErrors >= maxFiles) { fileScanTruncated = true; continue; }
      const absolute = path.join(root.path, relative), bytes = fileSize(absolute);
      if (bytes === null) { readErrors += 1; partitionStats.read_errors += 1; continue; }
      if (bytes > maxFileBytes) { skippedLargeFiles += 1; partitionStats.skipped_large_files += 1; continue; }
      let text;
      try { text = fs.readFileSync(absolute, "utf8"); } catch { readErrors += 1; partitionStats.read_errors += 1; continue; }
      const contentHash = crypto.createHash("sha256").update(text).digest("hex");
      const shownPath = displayPath(root, relative);
      files.push({ path: shownPath, root: root.key, bytes, content_hash: contentHash });
      scannedFiles += 1; readBytes += bytes; partitionStats.scanned_files += 1;
      const lines = text.split(/\r?\n/), loweredLines = lines.map(line => line.toLowerCase());
      for (const [occurrenceIndex, occurrence] of occurrences.entries()) {
        const needle = occurrence.term.toLowerCase();
        let fileMatched = false, fileCount = 0, fileMatchedLines = 0;
        for (const [index, line] of lines.entries()) {
          const lowered = loweredLines[index];
          let offset = 0, lineCount = 0;
          while ((offset = lowered.indexOf(needle, offset)) >= 0) { occurrence.count += 1; fileCount += 1; lineCount += 1; offset += Math.max(1, needle.length); }
          if (!lineCount) continue;
          fileMatched = true; fileMatchedLines += 1; occurrence.matched_lines += 1;
          if (occurrence.locations.length < maxLocationsPerTerm) occurrence.locations.push({ path: shownPath, line: index + 1, text: line.trim().slice(0, 200) });
          else occurrence.locations_truncated = true;
        }
        if (fileMatched) occurrence.matched_files += 1;
        const partitions = occurrencePartitions[occurrenceIndex];
        const prior = partitions.get(partitionKey) ?? { count: 0, matched_lines: 0, matched_files: 0 };
        prior.count += fileCount; prior.matched_lines += fileMatchedLines; prior.matched_files += Number(fileMatched);
        partitions.set(partitionKey, prior);
      }
    }
  }
  const partitionEntries = [...partitionBoundary.entries()].sort((left, right) => left[1].root.localeCompare(right[1].root, "en") || left[1].partition.localeCompare(right[1].partition, "en"));
  const partitions = partitionEntries.map(([, item]) => ({ ...item, completeness: item.enumeration_complete && item.scanned_files === item.eligible_files && item.skipped_large_files === 0 && item.read_errors === 0 ? "complete" : "incomplete" }));
  for (const [index, occurrence] of occurrences.entries()) {
    if (occurrence.matched_lines > occurrence.locations.length) occurrence.locations_truncated = true;
    occurrence.by_partition = partitionEntries.map(([key, item]) => ({ root: item.root, partition: item.partition, ...(occurrencePartitions[index].get(key) ?? { count: 0, matched_lines: 0, matched_files: 0 }), completeness: item.enumeration_complete && item.scanned_files === item.eligible_files && item.skipped_large_files === 0 && item.read_errors === 0 ? "complete" : "incomplete" }));
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const inventoryHash = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const completeness = !fileScanTruncated && skippedLargeFiles === 0 && readErrors === 0 && scannedFiles === eligibleFiles ? "complete" : "incomplete";
  const rootsEvidence = roots.map(root => ({ key: root.key, access: root.access, path: root.path }));
  const identityRoots = rootsEvidence.map(root => ({ key: root.key, access: root.access }));
  const identity = { scope: "complete_corpus", match: "literal_case_insensitive", terms: selectedTerms, roots: identityRoots, source_scope_patterns: [...(scope.patterns ?? [])], inventory_hash: inventoryHash };
  return {
    scan_id: `scan_corpus_${crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 20)}`,
    scope: "complete_corpus", match: "literal_case_insensitive", terms: selectedTerms, occurrences,
    completeness, boundary: { authority: "registered_project_source_scope", source_scope_patterns: [...(scope.patterns ?? [])], eligible_files: eligibleFiles, scanned_files: scannedFiles, read_bytes: readBytes, duration_ms: Number(process.hrtime.bigint() - startedAt) / 1_000_000, skipped_large_files: skippedLargeFiles, read_errors: readErrors, file_scan_truncated: fileScanTruncated, enumeration_complete: listingEvidence.every(item => item.authoritative && !item.truncated), listings: listingEvidence, partitions },
    covered_files: files,
    provenance: { method: "deterministic_literal_corpus_scan", version: 1, inventory_hash: inventoryHash, roots: rootsEvidence }
  };
}

// A path a role is given carries its root, so a plan naming one end of an integration cannot be applied
// against the other by accident.
export function parseRootedPath(roots, value) {
  const normalized = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) throw new Error(`SOURCE_PATH_INVALID: ${value}`);
  const separator = normalized.indexOf("/");
  const head = separator === -1 ? "" : normalized.slice(0, separator);
  const named = head ? roots.find(root => root.key === head && !root.primary) : null;
  return named ? { root: named, relative: normalized.slice(head.length + 1) } : { root: findRoot(roots, "primary"), relative: normalized };
}

// A repository snapshot proves the current head, but a request about when one particular source changed
// needs that source's own history. Keep the collection path-bound and small: no diff bodies, no broad
// repository log, and no path outside the same source scope used for file collection.
export function collectGitHistory(roots, plannedPaths, scope, { enabled = true, maxPaths = 8, maxCommits = 12, maxBytes = 8192 } = {}) {
  if (!enabled) return { enabled: false, status: "not_requested", files: [] };
  const files = [];
  let used = 0;
  for (const value of [...new Set(plannedPaths)].slice(0, maxPaths)) {
    let parsed;
    try { parsed = parseRootedPath(roots, value); } catch { continue; }
    if (!scope.matches(parsed.relative)) continue;
    try {
      const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: parsed.root.path, encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (!sameDirectory(top, parsed.root.path)) { files.push({ path: value, status: "root_mismatch", commits: [] }); continue; }
      const output = execFileSync("git", ["log", "--follow", `-${maxCommits}`, "--pretty=format:%H%x09%aI%x09%s", "--", parsed.relative], { cwd: parsed.root.path, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();
      const commits = output.split(/\r?\n/).filter(Boolean);
      const item = { path: value, root: parsed.root.key, status: commits.length ? "available" : "no_history", commits };
      const bytes = Buffer.byteLength(JSON.stringify(item));
      if (used + bytes > maxBytes) break;
      files.push(item); used += bytes;
    } catch (error) {
      files.push({ path: value, root: parsed.root.key, status: "unavailable", category: error.code === "ENOENT" ? "git_not_installed" : "git_not_repository", commits: [] });
    }
  }
  return { enabled: true, status: files.some(file => file.status === "available") ? "available" : "unavailable", files, bytes: used };
}

// The worker reads what the plan allowed, and it reads it from here rather than from the filesystem, so
// the same plan against the same tree produces the same invocation. The scope is checked again on the
// way out: a plan is written by a model, and a path outside what the owner registered is refused here
// rather than trusted because a planner asked for it. The budget is spent in the order the plan listed,
// because that order is the planner's own statement of what matters most.
function utf8Prefix(value, maxBytes) {
  const text = String(value ?? "");
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function requestedLineRanges(query, lineCount) {
  const ranges = [];
  const source = String(query ?? "");
  const months = /январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|january|february|march|april|may|june|july|august|september|october|november|december/i;
  for (const match of source.matchAll(/\b(\d{1,7})\s*[-–—]\s*(\d{1,7})\b/g)) {
    const before = source[(match.index ?? 0) - 1] ?? "", after = source[(match.index ?? 0) + match[0].length] ?? "";
    // Version/date fragments and UUID-like thread identifiers contain adjacent separators. They are not
    // source ranges: `0.4.8-2026-08-26` previously became lines 8-2026, while a task id contributed an
    // arbitrary 7493-8723 range that outranked every avgCost match in a large React file.
    if (/[.:-]/.test(before) || /[.:-]/.test(after)) continue;
    // Dates such as "15–22 August" describe history, not source lines. Treating them as lines spent a
    // scarce excerpt page at the top of every file and displaced the code the request actually named.
    const nearby = source.slice(Math.max(0, (match.index ?? 0) - 16), (match.index ?? 0) + match[0].length + 24);
    if (Number(match[1]) <= 31 && Number(match[2]) <= 31 && months.test(nearby)) continue;
    const start = Math.max(1, Math.min(Number(match[1]), Number(match[2])));
    const end = Math.min(lineCount, Math.max(Number(match[1]), Number(match[2])));
    if (start <= end && !ranges.some(item => item.start === start && item.end === end)) ranges.push({ start, end });
    if (ranges.length >= 8) break;
  }
  return ranges;
}

function excerptTerms(query) {
  const ordinary = proseTerms(query, 20).map(word => word.length > 7 ? word.slice(0, word.length - 3) : word);
  const weighted = new Map();
  for (const term of ordinary) if (term.length >= 4) weighted.set(term.toLowerCase(), 1);
  for (const [index, term] of searchTerms(query).entries()) if (term.length >= 4) weighted.set(term.toLowerCase(), 100 - index);
  return [...weighted.entries()].map(([term, weight]) => ({ term, weight }));
}

function spread(values, limit) {
  if (values.length <= limit) return values;
  const selected = [];
  for (let index = 0; index < limit; index += 1) selected.push(values[Math.round(index * (values.length - 1) / (limit - 1))]);
  return [...new Set(selected)];
}

function calledIdentifiers(text, limit = 16) {
  const found = [], lines = String(text ?? "").split(/\r?\n/);
  // A member call is the strongest cross-file signal: a form commonly invokes an object-module method
  // through `ОбъектОбработки.Метод()`. Put those names before local UI helpers so the bounded follow-up
  // list reaches the implementation file even when the form contains many buttons.
  for (const line of lines) {
    for (const match of line.matchAll(/\.([A-Za-z_Ѐ-ӿ][A-Za-z0-9_Ѐ-ӿ]{3,80})\s*\(/g)) {
      if (!found.includes(match[1])) found.push(match[1]);
      if (found.length >= limit) return found;
    }
  }
  for (const line of lines) {
    if (/^\s*(?:Функция|Процедура|Function|Procedure)\s+/i.test(line)) continue;
    for (const match of line.matchAll(/(?:^|[^A-Za-z0-9Ѐ-ӿ_])([A-Za-z_Ѐ-ӿ][A-Za-z0-9_Ѐ-ӿ]{3,80})\s*\(/g)) {
      if (!found.includes(match[1])) found.push(match[1]);
      if (found.length >= limit) return found;
    }
  }
  return found;
}

// A large source file is useful because of the few regions that prove the current objective, not because
// its first bytes happen to fit. Explicit line ranges lead; otherwise request-derived code and prose terms
// choose bounded windows. Multiple requested ranges are interleaved so the first range cannot consume the
// whole budget before later evidence is represented.
function relevantExcerpt(text, query, maxBytes, supplementalQuery = "", preferredExactQuery = query) {
  const lines = text.split(/\r?\n/), terms = excerptTerms(query), supplementalTerms = excerptTerms(supplementalQuery), preferredExactTerms = excerptTerms(preferredExactQuery);
  const ranges = requestedLineRanges(query, lines.length), supplementalRanges = requestedLineRanges(supplementalQuery, lines.length);
  const scoreAt = (index, selectedTerms) => {
    const line = lines[index].toLowerCase();
    return selectedTerms.reduce((score, item) => line.includes(item.term) ? score + item.weight : score, 0);
  };
  const rangeGroups = (selectedRanges, selectedTerms) => selectedRanges.map(range => {
    const pages = [];
    for (let start = range.start - 1; start < range.end; start += 40) {
      const end = Math.min(range.end - 1, start + 39);
      let score = 0;
      for (let line = start; line <= end; line += 1) score = Math.max(score, scoreAt(line, selectedTerms));
      pages.push({ start, end, score, reason: `requested_lines:${range.start}-${range.end}` });
    }
    const ranked = pages.sort((left, right) => right.score - left.score || left.start - right.start);
    const predecessor = pages.find(page => page.end + 1 === ranked[0]?.start);
    const predecessorIndex = ranked.indexOf(predecessor);
    // A matching JOIN or WHERE page usually depends on the SELECT fields and function header directly
    // before it. Keep that predecessor adjacent to the best page so a worker receives a complete query
    // rather than only the line containing the register name.
    if (predecessor && predecessorIndex > 1) ranked.splice(1, 0, ranked.splice(predecessorIndex, 1)[0]);
    const tail = pages.find(page => page.end === range.end - 1);
    const tailIndex = ranked.indexOf(tail);
    // A formula often concludes a requested range. If that final page itself matches the objective,
    // retain it near the front instead of letting many equally scoring setup pages displace it.
    const tailPosition = predecessor ? 2 : 1;
    if (tail && tailIndex > tailPosition) ranked.splice(tailPosition, 0, ranked.splice(tailIndex, 1)[0]);
    return ranked;
  });
  const objectiveGroup = (selectedTerms, reason) => {
    const hits = [];
    for (let line = 0; line < lines.length; line += 1) { const score = scoreAt(line, selectedTerms); if (score) hits.push({ line, score }); }
    const selected = [];
    for (const hit of hits.sort((a, b) => b.score - a.score || a.line - b.line)) {
      if (selected.some(item => Math.abs(item.line - hit.line) <= 12)) continue;
      selected.push(hit);
      if (selected.length >= 12) break;
    }
    return selected.map(item => ({ center: item.line, reason }));
  };
  const exactAnchorGroup = (selectedTerms, limit = 8) => {
    const groups = selectedTerms.filter(item => item.weight >= 50).map(item => {
      const hits = [];
      for (let line = 0; line < lines.length; line += 1) if (lines[line].toLowerCase().includes(item.term)) hits.push(line);
      return spread(hits, 5).map(center => ({ start: Math.max(0, center - 12), end: Math.min(lines.length - 1, center + 12), reason: `exact_term_anchor:${item.term}` }));
    }).filter(group => group.length);
    const selected = [];
    for (let ordinal = 0; selected.length < limit; ordinal += 1) {
      let found = false;
      for (const group of groups) {
        if (!group[ordinal]) continue;
        const candidate = group[ordinal], center = Math.floor((candidate.start + candidate.end) / 2);
        if (!selected.some(item => Math.abs(Math.floor((item.start + item.end) / 2) - center) <= 24)) selected.push(candidate);
        found = true;
        if (selected.length >= limit) break;
      }
      if (!found) break;
    }
    return selected;
  };
  const definitionGroup = (selectedRanges, selectedTerms) => {
    const calls = new Set();
    for (const range of selectedRanges) {
      const text = lines.slice(range.start - 1, range.end).join("\n");
      for (const match of text.matchAll(/([A-Za-zЀ-ӿ_][A-Za-z0-9Ѐ-ӿ_]{4,63})\s*\(/g)) {
        calls.add(match[1]);
        if (calls.size >= 80) break;
      }
    }
    const found = [];
    for (const name of calls) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const line = lines.findIndex(value => new RegExp(`^\\s*(?:Функция|Процедура|Function|Procedure)\\s+${escaped}\\s*\\(`, "i").test(value));
      if (line < 0) continue;
      const nearby = lines.slice(Math.max(0, line - 1), Math.min(lines.length, line + 14)).join("\n").toLowerCase();
      const score = selectedTerms.reduce((total, item) => {
        const proseStem = item.weight === 1 && item.term.length >= 6 ? item.term.slice(0, Math.max(4, item.term.length - 3)) : null;
        return total + (nearby.includes(item.term) || (proseStem && nearby.includes(proseStem)) ? item.weight : 0);
      }, 0);
      if (score) found.push({ center: line + 5, reason: `referenced_definition:${name}`, score });
    }
    return found.sort((left, right) => right.score - left.score || left.center - right.center);
  };
  const callChainGroup = (selectedTerms, objectiveWindows = [], allowFallback = true) => {
    const definitions = [], byName = new Map();
    for (let line = 0; line < lines.length; line += 1) {
      const bslMatch = lines[line].match(/^\s*(?:Функция|Процедура|Function|Procedure)\s+([A-Za-z_Ѐ-ӿ][A-Za-z0-9_Ѐ-ӿ]{3,80})/i);
      const scriptMatch = lines[line].match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]{3,80})/)
        ?? lines[line].match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]{3,80})\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/);
      const match = bslMatch ?? scriptMatch;
      if (!match) continue;
      let end = line;
      if (/^\s*(?:Функция|Процедура|Function|Procedure)\s+/i.test(lines[line])) {
        while (end < lines.length && !/^\s*(?:КонецФункции|КонецПроцедуры|EndFunction|EndProcedure)/i.test(lines[end])) end += 1;
      } else {
        let depth = 0, opened = false;
        do {
          const sourceLine = lines[end];
          const opens = (sourceLine.match(/{/g) ?? []).length, closes = (sourceLine.match(/}/g) ?? []).length;
          if (opens) opened = true;
          depth += opens - closes;
          end += 1;
        } while (end < lines.length && (!opened || depth > 0));
        end = Math.max(line, end - 1);
      }
      const item = { name: match[1], start: line, end: Math.min(end, lines.length - 1), max_lines: bslMatch ? 105 : 240 };
      definitions.push(item); byName.set(item.name.toLowerCase(), item);
    }
    const exact = selectedTerms.filter(item => item.weight >= 50);
    const objectiveCalls = new Set();
    for (const window of objectiveWindows.slice(0, 4)) {
      const start = Math.max(0, window.center - 6), end = Math.min(lines.length - 1, window.center + 6);
      for (const name of calledIdentifiers(lines.slice(start, end + 1).join("\n"), 12)) objectiveCalls.add(name.toLowerCase());
    }
    const objectiveDefinitions = new Set();
    for (const window of objectiveWindows) {
      const containing = definitions.find(item => window.center >= item.start && window.center <= item.end);
      if (containing) objectiveDefinitions.add(containing.name.toLowerCase());
    }
    const seedCandidates = definitions
      .map(item => {
        const lowered = item.name.toLowerCase();
        const exactScore = Math.max(0, ...exact.filter(term => lowered.includes(term.term) || term.term.includes(lowered)).map(term => term.weight));
        const semanticScore = selectedTerms.reduce((total, term) => total + (lowered.includes(term.term) ? term.weight : 0), 0);
        return { item, exactScore, score: Math.max(objectiveDefinitions.has(lowered) ? 200 : 0, objectiveCalls.has(lowered) ? 150 : 0, semanticScore) };
      });
    const exactSeeds = seedCandidates.filter(item => item.exactScore > 0);
    if (!exactSeeds.length && !allowFallback) return [];
    const queue = (exactSeeds.length ? exactSeeds : seedCandidates.filter(item => item.score > 0))
      .sort((left, right) => (exactSeeds.length ? right.exactScore - left.exactScore : right.score - left.score) || left.item.start - right.item.start)
      .slice(0, exactSeeds.length ? 2 : 4)
      .map(({ item }) => ({ item, depth: 0 }));
    const selected = [], seen = new Set();
    while (queue.length && selected.length < 8) {
      const { item, depth } = queue.shift(), key = item.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push({ start: item.start, end: Math.min(item.end, item.start + item.max_lines - 1), reason: `referenced_call_chain:${item.name}` });
      if (depth >= 3) continue;
      const calls = [];
      for (let line = item.start + 1; line <= item.end; line += 1) {
        for (const match of lines[line].matchAll(/(?:^|[^A-Za-z0-9Ѐ-ӿ_])([A-Za-z_Ѐ-ӿ][A-Za-z0-9_Ѐ-ӿ]{3,80})\s*\(/g)) {
          const target = byName.get(match[1].toLowerCase());
          if (!target || seen.has(target.name.toLowerCase())) continue;
          const lowered = target.name.toLowerCase();
          let sharedPrefix = 0;
          const current = item.name.toLowerCase();
          while (sharedPrefix < current.length && sharedPrefix < lowered.length && current[sharedPrefix] === lowered[sharedPrefix]) sharedPrefix += 1;
          const score = selectedTerms.reduce((total, term) => total + (lowered.includes(term.term) ? term.weight : 0), 0) + (sharedPrefix >= 6 ? sharedPrefix : 0);
          if (score > 0) calls.push({ target, score, line });
        }
      }
      calls.sort((left, right) => right.score - left.score || left.line - right.line);
      for (const call of calls.slice(0, 2)) queue.push({ item: call.target, depth: depth + 1 });
    }
    return selected;
  };
  // The step objective is the closest statement of what this worker needs, so its matches lead even
  // when the original request contains broad ranges for other steps. Global ranges and terms then add
  // evidence that a concise planner objective omitted without displacing the local proof.
  const localObjective = objectiveGroup(terms, "objective_match");
  const explicitGroups = [...rangeGroups(ranges, terms), ...rangeGroups(supplementalRanges, supplementalTerms)];
  const objectiveGroups = localObjective.length ? [localObjective] : [];
  const supplementalObjective = objectiveGroup(supplementalTerms, "supplemental_objective_match");
  if (supplementalObjective.length) objectiveGroups.push(supplementalObjective);
  const localExactAnchors = exactAnchorGroup(preferredExactTerms, 8);
  const exactAnchors = [...localExactAnchors];
  for (const candidate of exactAnchorGroup(supplementalTerms, 4)) {
    const center = Math.floor((candidate.start + candidate.end) / 2);
    if (!exactAnchors.some(item => Math.abs(Math.floor((item.start + item.end) / 2) - center) <= 24)) exactAnchors.push(candidate);
    if (exactAnchors.length >= 8) break;
  }
  const definitions = definitionGroup([...ranges, ...supplementalRanges], [...terms, ...supplementalTerms]);
  const callChain = callChainGroup(terms, localObjective, !ranges.length && !supplementalRanges.length);
  if (!explicitGroups.length && !objectiveGroups.length) objectiveGroups.push([0, lines.length - 1].map(center => ({ center, reason: "head_tail_fallback" })));
  const candidates = [];
  const appendRoundRobin = groups => {
    for (let ordinal = 0; candidates.length < 24; ordinal += 1) {
      let found = false;
      for (const group of groups) if (group[ordinal]) { candidates.push(group[ordinal]); found = true; }
      if (!found) break;
    }
  };
  // Exact ranges are direct owner evidence. Put the best page from every named range into the byte stream
  // before call-chain windows: otherwise a handful of 105-line functions can consume the entire contract
  // and the worker receives none of a later range the owner explicitly identified. After that guaranteed
  // representation, local call chains and definitions lead the remaining range pages, preserving enough
  // execution context for focused steps without turning a broad original request into missing evidence.
  for (const group of explicitGroups) if (group.length) candidates.push(group.shift());
  // The worker's own exact objective is the nearest evidence request. Reserve its strongest window before
  // inferred call chains; otherwise a handful of long but merely related functions can consume the byte
  // budget while the literal register or field named by the step never reaches the prompt.
  if (objectiveGroups[0]?.length) candidates.push(objectiveGroups[0].shift());
  // The original request may carry the exact register or cross-system identifier that a planner
  // legitimately shortens to "trace the source". Reserve several strongest global anchors before a
  // long locally inferred call chain can consume the file allocation.
  if (objectiveGroups[1]?.length) candidates.push(...objectiveGroups[1].splice(0, 3));
  // Exact identifiers can occur at several distant stages inside one generated importer or API module.
  // Preserve a spread of those concrete locations before inferred helper call chains. The complete-file
  // scan proves counts, while these wider windows prove what the separated occurrences actually do.
  if (exactAnchors.length) candidates.push(...exactAnchors);
  if (callChain.length) candidates.push(...callChain);
  if (definitions.length) candidates.push(...definitions.slice(0, 2));
  appendRoundRobin(explicitGroups);
  appendRoundRobin(objectiveGroups);
  const windows = [], covered = [];
  for (const candidate of candidates) {
    const start = candidate.start ?? Math.max(0, candidate.center - 6), end = candidate.end ?? Math.min(lines.length - 1, candidate.center + 6);
    if (covered.some(item => start >= item.start && end <= item.end)) continue;
    covered.push({ start, end });
    windows.push({ start, end, reason: candidate.reason });
  }
  let supplied = "";
  const segments = [];
  for (const window of windows) {
    const header = `--- lines ${window.start + 1}-${window.end + 1} (${window.reason}) ---\n`;
    const block = `${header}${lines.slice(window.start, window.end + 1).join("\n")}\n`;
    const remaining = maxBytes - Buffer.byteLength(supplied);
    if (remaining <= Buffer.byteLength(header)) break;
    const fitted = utf8Prefix(block, remaining);
    supplied += fitted;
    segments.push({ start_line: window.start + 1, end_line: window.end + 1, reason: window.reason, complete: fitted.length === block.length });
    if (fitted.length !== block.length) break;
  }
  return { text: supplied, segments, selection: ranges.length || supplementalRanges.length ? "requested_ranges_and_objective_matches" : terms.length || supplementalTerms.length ? "objective_matches" : "head_tail_fallback" };
}

// Excerpts can prove a hit but cannot prove that an identifier is absent from the omitted part of a
// file. Count only the exact code-shaped terms already supplied by the owner or planner, over the full
// allowed file, and expose the bounded result as metadata. A zero count is then deterministic evidence
// of absence in that source snapshot rather than a reason for a worker to request a larger excerpt.
function exactTermOccurrences(text, query, supplementalQuery, limit = 8, maxLocationsPerTerm = 4, maxEvidenceBytes = 8192) {
  const terms = [...new Set([...searchTerms(query), ...searchTerms(supplementalQuery)])].slice(0, limit);
  const lines = text.split(/\r?\n/);
  let evidenceBytes = 0;
  return terms.map(term => {
    const needle = term.toLowerCase(), locations = [];
    let count = 0, matchedLines = 0;
    for (const [index, line] of lines.entries()) {
      const lowered = line.toLowerCase();
      let lineCount = 0, offset = 0;
      while ((offset = lowered.indexOf(needle, offset)) >= 0) { count += 1; lineCount += 1; offset += Math.max(1, needle.length); }
      if (!lineCount) continue;
      matchedLines += 1;
      if (locations.length >= maxLocationsPerTerm) continue;
      const location = { line: index + 1, text: line.trim().slice(0, 200) };
      const bytes = Buffer.byteLength(JSON.stringify(location));
      if (evidenceBytes + bytes > maxEvidenceBytes) continue;
      locations.push(location); evidenceBytes += bytes;
    }
    return { term, count, matched_lines: matchedLines, locations, locations_truncated: matchedLines > locations.length };
  });
}

// A long allowed-path list is an authority boundary, not a request to divide source bytes equally.
// Give every readable path a bounded representation, then spend most bytes on files whose own contents
// contain the exact identifiers and subject vocabulary of the step. This keeps broad planner inventories
// auditable without reducing the important implementation and test files to equally tiny fragments.
function evidenceAllocations(descriptors, budgetBytes, query, supplementalQuery) {
  if (descriptors.length < 8 || budgetBytes <= 0) return null;
  const exact = [...new Set([...searchTerms(query), ...searchTerms(supplementalQuery)])].map(term => term.toLowerCase());
  const prose = [...new Set([...proseTerms(query, 20), ...proseTerms(supplementalQuery, 20)].map(stem))];
  const ranked = descriptors.map(descriptor => {
    const lowered = descriptor.text.toLowerCase();
    let exactDistinct = 0, exactHits = 0, proseDistinct = 0, proseHits = 0;
    for (const term of exact) {
      const hits = lowered.split(term).length - 1;
      if (hits) { exactDistinct += 1; exactHits += Math.min(hits, 100); }
    }
    for (const term of prose) {
      const hits = lowered.split(term).length - 1;
      if (hits) { proseDistinct += 1; proseHits += Math.min(hits, 40); }
    }
    const sourceCode = isSourceCodePath(descriptor.path) ? 5_000 : 0;
    return { ...descriptor, score: exactDistinct * 100_000 + exactHits * 100 + proseDistinct * 100 + proseHits + sourceCode };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  for (const [rank, descriptor] of ranked.entries()) descriptor.weight = rank < 4 ? 12 : rank < 8 ? 8 : rank < 12 ? 4 : 1;
  const allocations = new Map(), active = [...ranked];
  let remaining = budgetBytes;
  // Weighted water filling returns unused capacity from small complete files before fixing the final
  // quotas, so a short README or schema declaration never strands bytes needed by a larger producer.
  while (active.length && remaining > 0) {
    const totalWeight = active.reduce((total, item) => total + item.weight, 0);
    const saturated = active.filter(item => item.bytes <= Math.floor(remaining * item.weight / totalWeight));
    if (!saturated.length) {
      for (const item of active) {
        const share = Math.floor(remaining * item.weight / totalWeight);
        allocations.set(item.index, share);
      }
      let assigned = [...allocations.values()].reduce((total, value) => total + value, 0);
      for (const item of active) {
        if (assigned >= budgetBytes) break;
        allocations.set(item.index, (allocations.get(item.index) ?? 0) + 1); assigned += 1;
      }
      break;
    }
    for (const item of saturated) {
      allocations.set(item.index, item.bytes); remaining -= item.bytes;
      active.splice(active.indexOf(item), 1);
    }
  }
  return allocations;
}

export function collectSourceFiles(roots, allowedPaths, scope, budgetBytes, options = {}) {
  const collected = [];
  let used = 0;
  const reject = (value, status, extra = {}) => { collected.push({ path: String(value), status, ...extra }); };
  const paths = allowedPaths ?? [];
  // Output artifacts and missing optional inputs are often listed beside real sources. Counting those
  // paths when dividing the budget starves the files that can actually contribute evidence.
  const readable = paths.filter(value => {
    try {
      const target = parseRootedPath(roots, value);
      if (!scope.matches(target.relative)) return false;
      const file = resolveInRoot(target.root, target.relative);
      return fs.existsSync(file) && fs.statSync(file).isFile() && !BINARY.test(file);
    } catch { return false; }
  }).length;
  const allocationDescriptors = [];
  for (const [index, value] of paths.entries()) {
    try {
      const target = parseRootedPath(roots, value);
      if (!scope.matches(target.relative)) continue;
      const file = resolveInRoot(target.root, target.relative);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile() || BINARY.test(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      allocationDescriptors.push({ index, path: target.relative, text, bytes: Buffer.byteLength(text) });
    } catch { /* The main collection loop records the precise rejection status. */ }
  }
  const rankedAllocations = evidenceAllocations(allocationDescriptors, budgetBytes, options.query ?? "", options.supplementalQuery ?? "");
  // Exact counts are deterministic metadata, but location snippets used to receive 8 KiB per file.
  // A planner selecting 23 files could therefore add roughly 184 KiB outside the source-text budget;
  // prompt fitting reacted by reducing sourceBudget to zero and every path became budget_exhausted.
  // Counts remain complete for every file while snippets share one bounded fraction of the package.
  const exactEvidenceBudget = Math.min(8192, Math.floor(Math.max(0, budgetBytes) * 0.2));
  const exactEvidencePerFile = readable ? Math.max(128, Math.floor(exactEvidenceBudget / readable)) : 0;
  let remainingReadable = readable;
  for (const [index, value] of paths.entries()) {
    if (used >= budgetBytes) { reject(value, "budget_exhausted"); continue; }
    let target;
    try { target = parseRootedPath(roots, value); } catch { reject(value, "invalid_path"); continue; }
    if (!scope.matches(target.relative)) { reject(value, "outside_scope"); continue; }
    let file;
    try { file = resolveInRoot(target.root, target.relative); } catch { reject(value, "outside_root"); continue; }
    const shown = displayPath(target.root, target.relative);
    if (!fs.existsSync(file)) { reject(shown, "missing", { root: target.root.key }); continue; }
    if (fs.statSync(file).isDirectory()) { reject(shown, "directory", { root: target.root.key }); continue; }
    if (BINARY.test(file)) { reject(shown, "not_text", { root: target.root.key, bytes: fileSize(file) }); continue; }
    const text = fs.readFileSync(file, "utf8");
    const remaining = budgetBytes - used;
    // Planner path order is priority: the first source is commonly the implementation and a later one
    // only its entry point. A descending triangular share gives the first file 2/3 when two remain and
    // 1/2 when three remain; unused bytes still roll forward, so a small first file costs only its size.
    // Equal division left unused capacity after a small final file while the primary source had already
    // been irreversibly truncated.
    const share = rankedAllocations?.get(index) ?? Math.max(0, Math.floor(remaining * 2 / Math.max(2, remainingReadable + 1)));
    const bytes = Buffer.byteLength(text), truncated = bytes > share;
    const excerpt = truncated ? relevantExcerpt(text, options.query ?? "", share, options.supplementalQuery ?? "") : { text, segments: [{ start_line: 1, end_line: text.split(/\r?\n/).length, reason: "complete_file", complete: true }], selection: "complete_file" };
    const exactLocationsPerTerm = readable <= 4 ? 12 : readable <= 8 ? 8 : 4;
    const exact_term_occurrences = exactTermOccurrences(text, options.query ?? "", options.supplementalQuery ?? "", 8, exactLocationsPerTerm, exactEvidencePerFile);
    collected.push({ path: shown, root: target.root.key, access: target.root.access, bytes, allocated_bytes: share, supplied_bytes: Buffer.byteLength(excerpt.text), truncated, selection: excerpt.selection, segments: excerpt.segments, exact_term_scan: { scope: "complete_file", match: "literal_case_insensitive", occurrences: exact_term_occurrences }, status: "read", text: excerpt.text });
    used += Buffer.byteLength(excerpt.text);
    remainingReadable -= 1;
  }
  // Planner path order expresses source priority, not call direction. A form can therefore appear after
  // the object module it invokes. Recollect each truncated file once with member calls harvested from
  // every other allowed excerpt, preserving its original allocation so this second pass cannot expand
  // the contract. Excluding the target itself keeps local helper noise from outranking the cross-file
  // method that proves the boundary.
  for (const target of collected.filter(file => file.status === "read" && file.truncated)) {
    const linked = [];
    for (const other of collected) {
      if (other === target || other.status !== "read") continue;
      let otherText = other.text;
      try {
        const otherParsed = parseRootedPath(roots, other.path);
        otherText = fs.readFileSync(resolveInRoot(otherParsed.root, otherParsed.relative), "utf8");
      } catch { /* The bounded excerpt remains a safe fallback if the file changed during collection. */ }
      for (const name of calledIdentifiers(otherText)) if (!linked.includes(name)) linked.push(name);
    }
    if (!linked.length) continue;
    let parsed, source;
    try {
      parsed = parseRootedPath(roots, target.path);
      source = fs.readFileSync(resolveInRoot(parsed.root, parsed.relative), "utf8");
    } catch { continue; }
    // Cross-file calls expand the local objective; they must not precede and evict its exact identifiers
    // from the bounded term list. Keeping the planner objective first preserves the requested field and
    // persistence anchors while the remaining slots still seed cross-file function discovery.
    const linkedQuery = `${options.query ?? ""}\n${linked.join("\n")}`;
    const excerpt = relevantExcerpt(source, linkedQuery, target.allocated_bytes, options.supplementalQuery ?? "", options.query ?? "");
    target.text = excerpt.text; target.segments = excerpt.segments; target.selection = excerpt.selection;
    target.supplied_bytes = Buffer.byteLength(excerpt.text);
  }
  used = collected.reduce((total, file) => total + (file.status === "read" ? file.supplied_bytes : 0), 0);
  return { files: collected, bytes: used, budget_bytes: budgetBytes };
}
