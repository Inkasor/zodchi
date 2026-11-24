// The comparison core of the differential oracle (docs/rewrite-with-oracle.md): pure functions, no I/O and no import. It compares the
// step views of an old and a new engine exactly (response and declared effects), binds opaque values such as ids at DECLARED locations
// only, approves a difference only through an executable expectation of one step, one path, one old value and one new value (presence
// included), keeps the verdict independent of the display, and refuses a request aimed outside the engine's own loopback address.

const MALFORMED = "effects malformed";
const NAME_RE = /^[a-z][A-Za-z0-9]{0,29}$/;
const PLACEHOLDER_RE = /\{\{([a-z][A-Za-z0-9]{0,29})\}\}/g;
const VALUE = "{value}";

/** A normalized opaque value: a reference to the value an engine bound under NAME, seen through a template. Private on purpose. */
class Bound {
  constructor(name, template) {
    this.name = name;
    this.template = template;
  }
  /** The display text only; no comparison ever reads it. */
  toJSON() {
    return this.template === VALUE ? `<bound:${this.name}>` : `<bound:${this.name}:${this.template}>`;
  }
}

export function isBound(value) {
  return value instanceof Bound;
}

const isPlain = (v) => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Code-point order of two strings (not the UTF-16 order of the default sort). */
function compareText(a, b) {
  if (a === b) return 0;
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** A deep copy of JSON data. A Bound is immutable and is shared. An own "__proto__" key stays an own property. */
function copyData(v) {
  if (Array.isArray(v)) return v.map(copyData);
  if (isPlain(v)) {
    const out = {};
    for (const k of Object.keys(v)) Object.defineProperty(out, k, { value: copyData(v[k]), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------------------------------------------- paths

const INDEX_RE = /^(0|[1-9][0-9]*)$/;
const escapeKey = (key) => key.replace(/[.[\]\\]/g, "\\$&");

/**
 * Text to typed segments { key } | { index } | { any: true }. Grammar: pieces joined by ".", a piece is a key then any number of [n] or
 * [*] suffixes; only the first piece may be suffixes alone. In a key a backslash escapes the next character, and "." "[" "]" and the
 * backslash itself must be escaped. The empty text is the root. A key can not be empty (it has no text).
 */
export function parsePath(text) {
  if (typeof text !== "string") throw new Error(`compare: a path is text, got ${typeof text}`);
  const bad = (why) => new Error(`compare: bad path ${JSON.stringify(text)}: ${why}`);
  const segments = [];
  const n = text.length;
  if (n === 0) return segments;
  let i = 0;
  for (;;) {
    const pieceStart = i;
    let key = "";
    let hasKey = false;
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        if (i + 1 >= n) throw bad("a backslash at the end");
        key += text[i + 1];
        i += 2;
        hasKey = true;
      } else if (c === "." || c === "[") {
        break;
      } else if (c === "]") {
        throw bad("an unescaped closing bracket in a key");
      } else {
        key += c;
        i++;
        hasKey = true;
      }
    }
    if (hasKey) segments.push({ key });
    else if (!(pieceStart === 0 && text[i] === "[")) throw bad("an empty key");
    while (i < n && text[i] === "[") {
      const close = text.indexOf("]", i);
      if (close < 0) throw bad("an opening bracket without a closing one");
      const inner = text.slice(i + 1, close);
      if (inner === "*") segments.push({ any: true });
      else if (INDEX_RE.test(inner) && Number.isSafeInteger(Number(inner))) segments.push({ index: Number(inner) });
      else throw bad(`[${inner}] is neither [*] nor an index written as a canonical decimal`);
      i = close + 1;
    }
    if (i >= n) break;
    if (text[i] !== ".") throw bad(`unexpected ${JSON.stringify(text[i])} after a suffix`);
    i++;
    if (i >= n) throw bad("a dot at the end");
  }
  return segments;
}

/** Typed segments to the one canonical text; two different segment lists never give the same text. */
export function formatPath(segments) {
  if (!Array.isArray(segments)) throw new Error("compare: formatPath takes an array of typed segments");
  let out = "";
  for (const seg of segments) {
    const kinds = seg && typeof seg === "object" ? ["key", "index", "any"].filter((k) => k in seg) : [];
    if (kinds.length !== 1) throw new Error(`compare: a typed segment has exactly one of key, index, any: ${JSON.stringify(seg)}`);
    if (kinds[0] === "key") {
      if (typeof seg.key !== "string" || seg.key === "") throw new Error("compare: a key segment is a non-empty string (the empty key has no path text)");
      out += (out === "" ? "" : ".") + escapeKey(seg.key);
    } else if (kinds[0] === "index") {
      if (!Number.isSafeInteger(seg.index) || seg.index < 0) throw new Error(`compare: an index segment is a non-negative integer: ${String(seg.index)}`);
      out += `[${seg.index}]`;
    } else {
      if (seg.any !== true) throw new Error("compare: an any segment is { any: true }");
      out += "[*]";
    }
  }
  return out;
}

const toSegments = (path) => (typeof path === "string" ? parsePath(path) : (formatPath(path), path));

/** Every node a path reaches, with the container to write into. A key reads only an own property of a plain object, an index only an array element. */
function walk(root, segments) {
  let current = [{ value: root, segs: [], parent: null, key: null }];
  for (const seg of segments) {
    const next = [];
    for (const c of current) {
      const v = c.value;
      if (typeof seg.key === "string") {
        if (isPlain(v) && Object.hasOwn(v, seg.key)) next.push({ value: v[seg.key], segs: [...c.segs, seg], parent: v, key: seg.key });
      } else if (Number.isInteger(seg.index)) {
        if (Array.isArray(v) && seg.index < v.length) next.push({ value: v[seg.index], segs: [...c.segs, seg], parent: v, key: seg.index });
      } else if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) next.push({ value: v[i], segs: [...c.segs, { index: i }], parent: v, key: i });
      }
    }
    current = next;
  }
  return current;
}

/** [{ path, value }] for a path text or typed segments; [*] is expanded to concrete indices; a path that does not exist gives nothing. */
export function readPaths(view, path) {
  return walk(view, toSegments(path)).map((h) => ({ path: formatPath(h.segs), value: h.value }));
}

// --------------------------------------------------------------------------------------------------------------- binding

/** One state per engine per sequence: bound maps a name to the string this engine produced, persisted keeps the refs that repeat. */
export function newState() {
  return { bound: {}, persisted: [] };
}

function concretePath(text, what) {
  const segments = parsePath(text);
  if (segments.some((s) => s.any === true)) throw new Error(`compare: ${what}: "at" is a concrete path, [*] is not allowed: ${JSON.stringify(text)}`);
  return segments;
}

const templateOk = (template) => typeof template === "string" && template.split(VALUE).length === 2;

/**
 * Replace the declared locations of a step view with Bound references. step.bind is { NAME: { at, pattern, unique? } }, step.refs is
 * [{ at, to, template?, persist? }]. Works on a deep copy and mutates only state. A violation is { kind, name, at }; a location whose
 * check fails keeps its raw value and stores nothing. Nothing at an undeclared location is ever rewritten.
 */
export function normalizeView(view, step, state) {
  const out = copyData(view);
  const violations = [];
  const bind = step && step.bind ? step.bind : {};
  for (const name of Object.keys(bind)) {
    if (!NAME_RE.test(name)) throw new Error(`compare: bind name ${JSON.stringify(name)} is not ${NAME_RE}`);
    const spec = bind[name];
    if (!spec || typeof spec.pattern !== "string") throw new Error(`compare: bind ${name} needs a string pattern`);
    const segments = concretePath(spec.at, `bind ${name}`);
    if (segments.length === 0 || (segments[0].key !== "response" && segments[0].key !== "effects")) {
      throw new Error(`compare: bind ${name}: "at" starts with response or effects: ${JSON.stringify(spec.at)}`);
    }
    const re = new RegExp(`^(?:${spec.pattern})$`);
    const at = formatPath(segments);
    const hit = walk(out, segments)[0];
    if (!hit || typeof hit.value !== "string") { violations.push({ kind: "bind-missing", name, at }); continue; }
    if (!re.test(hit.value)) { violations.push({ kind: "bind-pattern", name, at }); continue; }
    if (Object.hasOwn(state.bound, name)) { violations.push({ kind: "bind-rebound", name, at }); continue; }
    if (spec.unique !== false && Object.values(state.bound).includes(hit.value)) { violations.push({ kind: "bind-not-unique", name, at }); continue; }
    state.bound[name] = hit.value;
    hit.parent[hit.key] = new Bound(name, VALUE);
  }

  const runRef = (ref) => {
    const segments = parsePath(ref.at);
    if (segments.length === 0) throw new Error("compare: a ref \"at\" is not the root");
    const at = formatPath(segments);
    const to = ref.to;
    const name = String(to);
    const template = ref.template === undefined ? VALUE : ref.template;
    if (!templateOk(template)) { violations.push({ kind: "ref-template", name, at }); return; }
    if (typeof to !== "string" || !Object.hasOwn(state.bound, to)) { violations.push({ kind: "ref-unbound", name, at }); return; }
    const hits = walk(out, segments);
    if (hits.length === 0) { violations.push({ kind: "ref-missing", name, at }); return; }
    const expected = template.replace(VALUE, () => state.bound[to]);
    for (const hit of hits) {
      if (typeof hit.value === "string" && hit.value === expected) hit.parent[hit.key] = new Bound(to, template);
      else violations.push({ kind: "ref-mismatch", name, at: formatPath(hit.segs) });
    }
  };
  const sameRef = (a, b) => a.at === b.at && a.to === b.to && a.template === b.template;
  for (const ref of state.persisted) runRef(ref);
  for (const ref of Array.isArray(step && step.refs) ? step.refs : []) {
    const canon = { at: formatPath(parsePath(ref.at)), to: ref.to, template: ref.template === undefined ? VALUE : ref.template, persist: true };
    if (state.persisted.some((p) => sameRef(p, canon))) continue; // already applied above, in this step
    runRef(ref);
    if (ref.persist === true && templateOk(canon.template)) state.persisted.push(canon);
  }
  return { view: out, violations };
}

// ----------------------------------------------------------------------------------------------------------- the request

function substituteIn(value, bound) {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER_RE, (_, name) => {
      if (!Object.hasOwn(bound, name) || typeof bound[name] !== "string") throw new Error(`compare: {{${name}}} is not bound`);
      return bound[name];
    });
  }
  if (Array.isArray(value)) return value.map((v) => substituteIn(v, bound));
  if (isPlain(value)) {
    const out = {};
    for (const k of Object.keys(value)) Object.defineProperty(out, k, { value: substituteIn(value[k], bound), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return value;
}

/** A new request with {{NAME}} replaced in the path, every header value and every string of the body (not in keys); an unbound name throws. */
export function substitute(request, bound) {
  const out = copyData(request);
  if (typeof out.path === "string") out.path = substituteIn(out.path, bound);
  if (isPlain(out.headers)) for (const k of Object.keys(out.headers)) out.headers[k] = substituteIn(out.headers[k], bound);
  if ("body" in out) out.body = substituteIn(out.body, bound);
  return out;
}

/** The URL to fetch: the base must be a literal http loopback origin, the path one "/" and not "//", and the result keeps the base's origin. */
export function targetUrl(baseUrl, path) {
  const m = typeof baseUrl === "string" ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(baseUrl) : null;
  if (!m || Number(m[1]) > 65535) throw new Error("compare: the base URL is an origin written as http://127.0.0.1:<port> (port 1 to 65535), nothing else");
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new Error("compare: the path is text that starts with one slash");
  const base = new URL(baseUrl);
  const url = new URL(path, base);
  const sameOrigin = url.protocol === base.protocol && url.host === base.host && url.port === base.port && url.username === "" && url.password === "";
  if (!sameOrigin || !url.href.startsWith(`${base.origin}/`)) throw new Error(`compare: the path ${JSON.stringify(path)} leaves the engine's own origin`);
  return url.href;
}

// ------------------------------------------------------------------------------------------------------------ differences

const kindOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : v instanceof Bound ? "bound" : isPlain(v) ? "object" : typeof v);
const sameScalar = (a, b) => a === b || (a !== a && b !== b);

/** Exact deep equality of JSON data with Bound (equal by name and template); key order never matters, array order does. */
function deepEqual(a, b) {
  const ka = kindOf(a);
  if (ka !== kindOf(b)) return false;
  if (ka === "array") return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (ka === "object") {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  if (ka === "bound") return a.name === b.name && a.template === b.template;
  return sameScalar(a, b);
}

/** The differences of two views as [{ path, old, new, oldAbsent, newAbsent }] in a fixed order (keys in code-point order, indices ascending). */
export function diffViews(oldView, newView) {
  const diffs = [];
  const emit = (segs, o, n, oldAbsent, newAbsent) =>
    diffs.push({ path: formatPath(segs), old: oldAbsent ? null : copyData(o), new: newAbsent ? null : copyData(n), oldAbsent, newAbsent });
  const rec = (segs, o, n) => {
    const ko = kindOf(o);
    const kn = kindOf(n);
    if (ko === "object" && kn === "object") {
      const keys = [...new Set([...Object.keys(o), ...Object.keys(n)])].sort(compareText);
      for (const k of keys) {
        const inOld = Object.hasOwn(o, k);
        const inNew = Object.hasOwn(n, k);
        if (inOld && inNew) rec([...segs, { key: k }], o[k], n[k]);
        else emit([...segs, { key: k }], inOld ? o[k] : null, inNew ? n[k] : null, !inOld, !inNew);
      }
    } else if (ko === "array" && kn === "array") {
      if (o.length !== n.length) emit(segs, o, n, false, false);
      else for (let i = 0; i < o.length; i++) rec([...segs, { index: i }], o[i], n[i]);
    } else if (!deepEqual(o, n)) {
      emit(segs, o, n, false, false);
    }
  };
  rec([], oldView, newView);
  return diffs;
}

// ---------------------------------------------------------------------------------------------------------- expectations

/**
 * The executable expectations of one scenario sequence. apply(diffs, step) is called once per step with ALL its diffs and returns them with
 * step and approved (an expectation id or null); unused() lists the ids that approved nothing. An expectation approves one diff of one step:
 * same scenario, step, canonical path, presence flags, old value and new value. Nothing here reads a display.
 */
export function createTracker(expectations, scenario) {
  const list = Array.isArray(expectations) ? expectations : [];
  const ids = new Set();
  const own = [];
  for (const e of list) {
    if (!e || typeof e !== "object" || typeof e.id !== "string" || e.id === "") throw new Error("compare: an expectation has a non-empty string id");
    if (ids.has(e.id)) throw new Error(`compare: duplicate expectation id ${JSON.stringify(e.id)}`);
    ids.add(e.id);
    const segments = parsePath(e.at);
    if (segments.some((s) => s.any === true)) throw new Error(`compare: expectation ${e.id}: "at" is a concrete path, [*] is not allowed`);
    if (e.scenario !== scenario) continue;
    own.push({
      id: e.id,
      step: e.step,
      at: formatPath(segments),
      oldAbsent: e.oldAbsent === true,
      newAbsent: e.newAbsent === true,
      old: e.oldAbsent === true && e.old === undefined ? null : e.old,
      new: e.newAbsent === true && e.new === undefined ? null : e.new,
      used: false,
    });
  }
  const applied = new Set();
  return {
    apply(diffs, step) {
      if (applied.has(step)) throw new Error(`compare: step ${JSON.stringify(step)} was already applied to this tracker`);
      applied.add(step);
      return diffs.map((d) => {
        let path = d.path;
        try { path = formatPath(parsePath(d.path)); } catch { /* compared as given */ }
        const hit = own.find(
          (e) => !e.used && e.step === step && e.at === path && e.oldAbsent === (d.oldAbsent === true) && e.newAbsent === (d.newAbsent === true) && deepEqual(e.old, d.old) && deepEqual(e.new, d.new),
        );
        if (hit) hit.used = true;
        return { ...d, step, approved: hit ? hit.id : null };
      });
    },
    unused() {
      return own.filter((e) => !e.used).map((e) => e.id);
    },
  };
}

/** The diffs no expectation approved. The verdict of a sequence is computed from the full output of apply, never from a display. */
export function unapproved(diffs) {
  return diffs.filter((d) => d.approved === null || d.approved === undefined);
}

/** A type-tagged key of JSON data with Bound (a Bound never collides with a string that looks like its display text). */
function keyOf(v) {
  const k = kindOf(v);
  if (k === "array") return `[${v.map(keyOf).join(",")}]`;
  if (k === "object") return `{${Object.keys(v).sort(compareText).map((x) => `${JSON.stringify(x)}:${keyOf(v[x])}`).join(",")}}`;
  if (k === "bound") return `B${JSON.stringify([v.name, v.template])}`;
  if (k === "string") return JSON.stringify(v);
  return `${k}:${Object.is(v, -0) ? "-0" : String(v)}`;
}

/** For DISPLAY only: drops a diff identical to an earlier one (path, values, both flags, approved), then cuts to cap. { shown, more }. */
export function summarizeDiffs(diffs, cap = 50) {
  const seen = new Set();
  const unique = [];
  for (const d of diffs) {
    const key = keyOf([d.path, d.old, d.new, d.oldAbsent === true, d.newAbsent === true, d.approved === undefined ? null : d.approved]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(d);
  }
  const shown = unique.slice(0, cap);
  return { shown, more: unique.length - shown.length };
}

// -------------------------------------------------------------------------------------------------------------- effects

function jsonData(v, ancestors, done) {
  if (v === null) return true;
  const t = typeof v;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(v);
  if (t !== "object") return false;
  if (done.has(v)) return true;
  if (ancestors.has(v)) return false; // a cycle
  const array = Array.isArray(v);
  if (!array && !isPlain(v)) return false;
  ancestors.add(v);
  let ok = true;
  if (array) {
    for (let i = 0; i < v.length && ok; i++) ok = Object.hasOwn(v, i) && jsonData(v[i], ancestors, done);
  } else if (Object.getOwnPropertySymbols(v).length > 0) {
    ok = false;
  } else {
    for (const k of Object.keys(v)) if (!jsonData(v[k], ancestors, done)) { ok = false; break; }
  }
  ancestors.delete(v);
  if (ok) done.add(v);
  return ok;
}

/** null when the effects projection is well formed, the fixed text "effects malformed" otherwise (never throws, never hangs on a cycle). */
export function validateEffects(effects, seenCalls) {
  try {
    if (!isPlain(effects)) return MALFORMED;
    if (Object.keys(effects).sort().join(",") !== "calls,jobs,rows") return MALFORMED;
    const { rows, calls, jobs } = effects;
    if (!isPlain(rows)) return MALFORMED;
    for (const table of Object.keys(rows)) {
      if (!Array.isArray(rows[table])) return MALFORMED;
      for (let i = 0; i < rows[table].length; i++) if (!isPlain(rows[table][i])) return MALFORMED;
    }
    if (!Number.isInteger(seenCalls) || seenCalls < 0) return MALFORMED;
    if (!Array.isArray(calls) || calls.length < seenCalls) return MALFORMED;
    for (let i = 0; i < calls.length; i++) if (!isPlain(calls[i])) return MALFORMED;
    if (!Array.isArray(jobs)) return MALFORMED;
    for (let i = 0; i < jobs.length; i++) if (!isPlain(jobs[i])) return MALFORMED;
    return jsonData(effects, new Set(), new WeakSet()) ? null : MALFORMED;
  } catch {
    return MALFORMED;
  }
}
