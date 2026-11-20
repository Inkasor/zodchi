// The comparison core of the differential oracle (domains/web-apps/scripts/oracle/compare.mjs, docs/rewrite-with-oracle.md), proved in
// memory: the path grammar, the exact diff with presence, the expectations (one step, one path, one old and one new value, presence
// included), binding at declared locations only, the request substitution, the loopback-only target URL and the effects check. The
// scenario builds views in memory, makes no request and starts no process.
import path from "node:path";
import { pathToFileURL } from "node:url";

export default function register({ scenario, ROOT }) {
  scenario("oracle-compare", "compare.mjs of the differential oracle: paths, differences, expectations, binding, substitute, targetUrl and validateEffects, all in memory", async (t) => {
    const C = await import(pathToFileURL(path.join(ROOT, "domains", "web-apps", "scripts", "oracle", "compare.mjs")).href);
    const J = JSON.stringify;
    const throws = (fn) => {
      try { fn(); } catch (e) { return e; }
      return null;
    };
    const AT = String.fromCharCode(64);
    const MARKER = { $absent: true };
    const heading = (text) => t.log(`--- ${text}`);
    const diffs = (o, n) => C.diffViews(o, n);
    const view = (response, effects) => ({ response: { status: 200, headers: {}, body: null, ...response }, effects: { rows: {}, calls: [], jobs: [], ...effects } });

    // ------------------------------------------------------------------------------------------------------------------ paths
    heading("paths");
    for (const text of ["", "a", "a.b", "a\\.b", "a\\[0\\]", "a\\]b", "a\\\\b", "0", "[0]", "a[0]", "a[0][1].b", "a[*]", "[*].x", "[0][*]", "a.b[2].c\\.d"]) {
      t.eq(C.formatPath(C.parsePath(text)), text, `round trip of the canonical path ${J(text)}`);
    }
    t.eq(C.parsePath("a\\.b"), [{ key: "a.b" }], "a\\.b is ONE key");
    t.eq(C.parsePath("a.b"), [{ key: "a" }, { key: "b" }], "a.b is TWO keys");
    t.eq(C.parsePath("a[0]"), [{ key: "a" }, { index: 0 }], "a[0] is a key and an index");
    t.eq(C.parsePath("a\\[0\\]"), [{ key: "a[0]" }], "a\\[0\\] is one key");
    t.eq(C.parsePath("0"), [{ key: "0" }], "0 is the key 0");
    t.eq(C.parsePath("[0]"), [{ index: 0 }], "[0] is the index 0");
    t.eq(C.parsePath("a[*]"), [{ key: "a" }, { any: true }], "[*] is the any segment");
    t.eq(C.parsePath(""), [], "the empty text is the root");
    const texts = [C.formatPath([{ key: "a.b" }]), C.formatPath([{ key: "a" }, { key: "b" }]), C.formatPath([{ key: "a" }, { index: 0 }]), C.formatPath([{ key: "a[0]" }]), C.formatPath([{ key: "0" }]), C.formatPath([{ index: 0 }])];
    t.eq(new Set(texts).size, texts.length, "six different typed segment lists give six different texts");
    t.eq([C.formatPath([{ key: "0" }]), C.formatPath([{ index: 0 }])], ["0", "[0]"], "typed key 0 and typed index 0 format differently");
    t.eq(C.formatPath([{ key: "a" }, { any: true }, { key: "b" }]), "a[*].b", "formatPath writes an any segment");
    t.ok(throws(() => C.formatPath([{ key: "" }])), "the empty key has no text: formatPath throws");
    t.ok(throws(() => C.formatPath([{ index: -1 }])) && throws(() => C.formatPath([{ index: 1.5 }])), "an index segment is a non-negative integer");
    t.ok(throws(() => C.formatPath([{ key: "a", index: 1 }])), "a segment with two kinds throws");
    for (const bad of ["a..b", ".a", "a.", "a[", "a[x]", "a[01]", "a[-1]", "a[]", "a[0]b", "a]", "a\\", "a.[0]", "a[1.5]", "a[ 1]"]) {
      const e = throws(() => C.parsePath(bad));
      t.ok(e instanceof Error && e.message.includes(J(bad)), `parsePath throws an Error naming the text for ${J(bad)}`);
    }
    t.ok(throws(() => C.parsePath(5)), "parsePath of a non-text throws");

    const expand = C.readPaths({ a: [{ b: 1 }, { b: 2 }, { c: 3 }] }, "a[*].b");
    t.eq(expand, [{ path: "a[0].b", value: 1 }, { path: "a[1].b", value: 2 }], "[*] expands to concrete indices and skips elements without the key");
    t.eq(C.readPaths({ a: [10, 20] }, "a[1]"), [{ path: "a[1]", value: 20 }], "an index reads an array element");
    t.eq(C.readPaths({ a: [10, 20] }, [{ key: "a" }, { index: 0 }]), [{ path: "a[0]", value: 10 }], "readPaths takes typed segments too");
    t.eq(C.readPaths({ a: { b: 1 } }, "a.zz"), [], "a missing key gives no entry");
    t.eq(C.readPaths({ a: [1] }, "a[5]"), [], "an index past the end gives no entry");
    t.eq(C.readPaths({ a: { 0: "x" } }, "a[0]"), [], "an index reads only an array: an object with the key 0 is not an array");
    t.eq(C.readPaths({ a: ["x"] }, "a.0"), [], "a key reads only an object: the key 0 does not read an array element");
    t.eq([C.readPaths({}, "toString"), C.readPaths({}, "constructor"), C.readPaths({}, "__proto__")], [[], [], []], "a key reads only an own property, never an inherited one");
    t.eq(C.readPaths({ a: 1 }, ""), [{ path: "", value: { a: 1 } }], "the root path reads the whole view");
    const dotted = { "a.b": 1 };
    const nested = { a: { b: 1 } };
    t.eq(C.readPaths(dotted, "a\\.b"), [{ path: "a\\.b", value: 1 }], "the literal key a.b is found by a\\.b");
    t.eq(C.readPaths(dotted, "a.b"), [], "the nested path a.b does not find the literal key a.b");
    t.eq(C.readPaths(nested, "a.b"), [{ path: "a.b", value: 1 }], "the nested a then b is found by a.b");
    t.eq(C.readPaths(nested, "a\\.b"), [], "a\\.b does not find the nested a then b");
    t.eq(C.readPaths({ "a[0]": 1, a: [2] }, "a\\[0\\]"), [{ path: "a\\[0\\]", value: 1 }], "a\\[0\\] finds only the literal key a[0]");
    t.eq(C.readPaths({ "a[0]": 1, a: [2] }, "a[0]"), [{ path: "a[0]", value: 2 }], "a[0] finds only the array element");

    // ------------------------------------------------------------------------------------------------------------- differences
    heading("differences");
    t.eq(diffs({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }), [], "key order never matters");
    t.eq(diffs({ x: [1, 2] }, { x: [2, 1] }).map((d) => d.path), ["x[0]", "x[1]"], "array order is significant");
    t.eq(diffs({ x: [1, 2] }, { x: [1, 2, 3] }), [{ path: "x", old: [1, 2], new: [1, 2, 3], oldAbsent: false, newAbsent: false }], "arrays of different length are ONE diff at the array path holding both arrays");
    t.eq(diffs({ x: [{ a: 1 }] }, { x: [] }).length, 1, "a shorter array is one diff, not a diff per element");
    t.eq(diffs({ x: 1 }, { x: "1" }), [{ path: "x", old: 1, new: "1", oldAbsent: false, newAbsent: false }], "a type change (number to string) is a diff");
    t.eq(diffs({ x: {} }, { x: [] }).length, 1, "an object against an array is a diff");
    t.eq(diffs({ x: null }, { x: 0 }).length, 1, "null against 0 is a diff");
    t.eq(diffs({ x: 1, y: "s", z: true, n: null }, { x: 1, y: "s", z: true, n: null }), [], "equal scalars give no diff");
    const absentToMarker = diffs({}, { x: MARKER });
    const markerToAbsent = diffs({ x: MARKER }, {});
    const markerToOne = diffs({ x: MARKER }, { x: 1 });
    t.eq(absentToMarker, [{ path: "x", old: null, new: MARKER, oldAbsent: true, newAbsent: false }], "absent to the marker object: old absent, new the marker");
    t.eq(markerToAbsent, [{ path: "x", old: MARKER, new: null, oldAbsent: false, newAbsent: true }], "the marker object to absent: new absent");
    t.eq(markerToOne, [{ path: "x", old: MARKER, new: 1, oldAbsent: false, newAbsent: false }], "the marker object to 1: both present");
    t.eq(new Set([J(absentToMarker), J(markerToAbsent), J(markerToOne)]).size, 3, "the three presence cases are three different diff records");
    t.eq(diffs({ x: null }, {}), [{ path: "x", old: null, new: null, oldAbsent: false, newAbsent: true }], "a present null against an absent key is a diff (flags tell them apart)");
    t.eq(diffs({}, { x: null }), [{ path: "x", old: null, new: null, oldAbsent: true, newAbsent: false }], "an absent key against a present null is a diff");
    t.eq(diffs({ "a.b": 1 }, { a: { b: 1 } }).map((d) => d.path), ["a", "a\\.b"], "the literal key a.b against the nested a then b: diffs at two different canonical paths");
    t.eq(diffs({ "a.b": 1 }, { "a.b": 2 }).map((d) => d.path), ["a\\.b"], "a changed literal key a.b is reported at a\\.b");
    t.eq(diffs({ a: { b: 1 } }, { a: { b: 2 } }).map((d) => d.path), ["a.b"], "a changed nested a then b is reported at a.b");
    const wide = (n) => Array.from({ length: 11 }, (_, i) => i * n);
    t.eq(diffs({ x: wide(1) }, { x: wide(2) }).map((d) => d.path), ["x[1]", "x[2]", "x[3]", "x[4]", "x[5]", "x[6]", "x[7]", "x[8]", "x[9]", "x[10]"], "indices come in numeric order (x[2] before x[10])");
    const o1 = { z: 1, a: 1, m: 1, "\u{1F600}": 1, "￿": 1 };
    const o2 = { z: 2, a: 2, m: 2, "\u{1F600}": 2, "￿": 2 };
    t.eq(diffs(o1, o2).map((d) => d.path), ["a", "m", "z", "￿", "\u{1F600}"], "keys come in code-point order (U+FFFF before U+1F600, which the UTF-16 sort would reverse)");
    t.eq(J(diffs(o1, o2)), J(diffs({ "￿": 1, "\u{1F600}": 1, m: 1, a: 1, z: 1 }, { m: 2, z: 2, "\u{1F600}": 2, a: 2, "￿": 2 })), "the output does not depend on the key order of the inputs");
    const bad = diffs({ x: { y: 1 } }, { x: { y: 2 } });
    t.ok(bad.length === 1 && bad[0].old === 1, "the diff holds plain values");
    const src = { x: { y: [1] } };
    const out = diffs(src, { x: { y: [1, 2] } });
    out[0].old.push(99);
    t.eq(src, { x: { y: [1] } }, "a diff value is a copy: changing it does not change the input view");

    // ----------------------------------------------------------------------------------------------------------- expectations
    heading("expectations");
    const exp = (o) => ({ id: "e1", scenario: "s", step: "A", at: "response.status", old: 200, new: 201, ...o });
    const statusDiff = () => diffs(view({ status: 200 }), view({ status: 201 }));
    const approvedBy = (expectation, d = statusDiff(), step = "A") => C.createTracker([expectation], "s").apply(d, step)[0].approved;
    t.eq(statusDiff().map((d) => d.path), ["response.status"], "the test diff is one diff at response.status");
    t.eq(approvedBy(exp({})), "e1", "an exact expectation approves its diff");

    const tr1 = C.createTracker([exp({})], "s");
    const stepA = tr1.apply(statusDiff(), "A");
    const stepB = tr1.apply(statusDiff(), "B");
    t.eq([stepA[0].approved, stepA[0].step], ["e1", "A"], "(1) the expectation for step A approves the diff of step A");
    t.eq([stepB[0].approved, stepB[0].step], [null, "B"], "(1) the same diff at step B is NOT approved by the expectation of step A");
    t.eq(C.unapproved([...stepA, ...stepB]).length, 1, "(1) the unapproved diff of the whole output is not empty");
    t.eq(tr1.unused(), [], "(1) the expectation was used, so unused() is empty although step B has an unapproved diff");
    const tr2 = C.createTracker([exp({}), exp({ id: "e2", step: "B" })], "s");
    const both = [...tr2.apply(statusDiff(), "A"), ...tr2.apply(statusDiff(), "B")];
    t.eq(both.map((d) => d.approved), ["e1", "e2"], "(1) an expectation for A and one for B approve both steps");
    t.eq([C.unapproved(both), tr2.unused()], [[], []], "(1) nothing unapproved and nothing unused then");

    t.eq(approvedBy(exp({ old: 199 })), null, "(2) a wrong old value approves nothing");
    t.eq(approvedBy(exp({ new: 202 })), null, "(2) a wrong new value approves nothing");
    t.eq(approvedBy(exp({ step: "B" })), null, "(2) an expectation of another step approves nothing");
    t.eq(approvedBy(exp({ scenario: "other" })), null, "(2) an expectation of another scenario approves nothing");
    t.eq(approvedBy(exp({ at: "response" })), null, "(2) the parent path does not approve a child diff");
    t.eq(approvedBy(exp({ at: "response.status.x" })), null, "(2) a child path does not approve a diff at the parent");
    t.eq(approvedBy(exp({ oldAbsent: true })), null, "(2) a wrong presence flag approves nothing");
    t.eq(approvedBy(exp({ old: "200" })), null, "(2) the string 200 is not the number 200");
    const parentDiff = diffs({ x: [1] }, { x: [1, 2] });
    const childDiff = diffs({ x: [1] }, { x: [2] });
    t.eq([parentDiff[0].path, childDiff[0].path], ["x", "x[0]"], "(2) the parent and the child diff used below sit at x and x[0]");
    t.eq(approvedBy(exp({ at: "x[0]", old: 1, new: 2 }), parentDiff), null, "(2) an expectation at x[0] does not approve the diff of the whole array x");
    t.eq(approvedBy(exp({ at: "x", old: [1], new: [2] }), childDiff), null, "(2) an expectation at x does not approve the diff of the element x[0]");
    t.eq(approvedBy(exp({ at: "x", old: [1], new: [1, 2] }), parentDiff), "e1", "(2) an expectation at x with both arrays approves the array diff");

    const markerTracker = C.createTracker([{ id: "m1", scenario: "s", step: "s1", at: "x", oldAbsent: true, new: MARKER }], "s");
    const m = [markerTracker.apply(diffs({}, { x: MARKER }), "s1"), markerTracker.apply(diffs({ x: MARKER }, {}), "s2"), markerTracker.apply(diffs({ x: MARKER }, { x: 1 }), "s3")].map((r) => r[0].approved);
    t.eq(m, ["m1", null, null], "(3) { oldAbsent: true, new: marker } approves only absent-to-marker, not marker-to-absent nor marker-to-1");
    const markerTracker2 = C.createTracker(
      [{ id: "m2", scenario: "s", step: "s2", at: "x", old: MARKER, new: 1 }, { id: "m3", scenario: "s", step: "s1", at: "x", old: MARKER, new: 1 }, { id: "m4", scenario: "s", step: "s3", at: "x", old: MARKER, new: 1 }],
      "s",
    );
    const m2 = [markerTracker2.apply(diffs({}, { x: MARKER }), "s1"), markerTracker2.apply(diffs({ x: MARKER }, { x: 1 }), "s2"), markerTracker2.apply(diffs({ y: MARKER }, { y: 1 }), "s3")].map((r) => r[0].approved);
    t.eq(m2, [null, "m2", null], "(3) an expectation for marker-to-1 approves neither absent-to-marker nor a change of another field");
    t.eq(approvedBy({ id: "m5", scenario: "s", step: "A", at: "x", old: null, new: 1 }, diffs({}, { x: 1 })), null, "(3) an expectation with old null does not approve a diff whose old side is absent");
    t.eq(approvedBy({ id: "m6", scenario: "s", step: "A", at: "x", oldAbsent: true, old: null, new: 1 }, diffs({}, { x: 1 })), "m6", "(3) the absent side written with oldAbsent and null approves absent-to-1");

    const lit = () => diffs({ x: { "a.b": 1 } }, { x: { "a.b": 2 } });
    const nest = () => diffs({ x: { a: { b: 1 } } }, { x: { a: { b: 2 } } });
    const dotExp = (at) => ({ id: "d1", scenario: "s", step: "A", at, old: 1, new: 2 });
    t.eq([approvedBy(dotExp("x.a\\.b"), lit()), approvedBy(dotExp("x.a\\.b"), nest())], ["d1", null], "(4) an expectation at x.a\\.b approves only the literal-key diff");
    t.eq([approvedBy(dotExp("x.a.b"), lit()), approvedBy(dotExp("x.a.b"), nest())], [null, "d1"], "(4) an expectation at x.a.b approves only the nested diff");

    const trUnused = C.createTracker([exp({ id: "u1", step: "never" }), exp({ id: "u2", at: "response.nothing" }), exp({ id: "u3" }), exp({ id: "u4", scenario: "other" })], "s");
    t.eq(trUnused.unused(), ["u1", "u2", "u3"], "(5) before any apply all expectations of the scenario are unused, in list order, other scenarios left out");
    trUnused.apply(statusDiff(), "A");
    t.eq(trUnused.unused(), ["u1", "u2"], "(5) an expectation of a step never applied and one that matched nothing are unused");
    t.ok(throws(() => trUnused.apply([], "A")), "(5) a second apply of the same step throws");
    t.ok(!throws(() => trUnused.apply([], "B")), "(5) another step can be applied");
    t.ok(throws(() => C.createTracker([exp({}), exp({})], "s")), "(5) a duplicate id throws");
    t.ok(throws(() => C.createTracker([exp({}), exp({ scenario: "other" })], "s")), "(5) a duplicate id throws even across scenarios");
    t.ok(throws(() => C.createTracker([exp({ at: "a[" })], "s")), "(5) a bad at throws");
    t.ok(throws(() => C.createTracker([exp({ at: "a[*].b" })], "s")), "(5) an at with [*] throws");
    const twin = C.createTracker([exp({})], "s").apply([...statusDiff(), ...statusDiff()], "A");
    t.eq(twin.map((d) => d.approved), ["e1", null], "(5) one expectation approves at most one diff");
    const trInput = statusDiff();
    const applied = C.createTracker([exp({})], "s").apply(trInput, "A");
    t.ok(applied !== trInput && trInput[0].approved === undefined && applied.length === 1, "(5) apply returns new diffs and leaves its input alone");
    t.eq(C.createTracker([], "s").apply([], "A"), [], "(5) a tracker with no expectation approves nothing and returns an empty list for an empty step");
    t.eq(C.createTracker(undefined, "s").unused(), [], "(5) no expectations at all is allowed");

    const oldWide = { extra: 0 };
    const newWide = { extra: 1 };
    const wideExp = [];
    for (let i = 0; i < 60; i++) {
      oldWide[`k${String(i).padStart(2, "0")}`] = 0;
      newWide[`k${String(i).padStart(2, "0")}`] = 1;
      wideExp.push({ id: `w${i}`, scenario: "s", step: "A", at: `k${String(i).padStart(2, "0")}`, old: 0, new: 1 });
    }
    const wideTracker = C.createTracker(wideExp, "s");
    const wideAll = wideTracker.apply(diffs(oldWide, newWide), "A");
    const sum = C.summarizeDiffs(wideAll);
    t.eq([wideAll.length, sum.shown.length, sum.more], [61, 50, 11], "(6) 61 diffs: the display shows 50 and says 11 more");
    t.eq(C.unapproved(wideAll).map((d) => d.path), ["extra"], "(6) the unapproved diff beyond the cap is still found in the full output");
    t.eq(wideTracker.unused(), [], "(6) every expectation was used although the display cut the list");
    t.eq(C.summarizeDiffs(wideAll, 3).shown.length, 3, "(6) the cap is a parameter");
    const base = { path: "p", old: 1, new: 2, oldAbsent: false, newAbsent: false, step: "s1" };
    const mixed = C.summarizeDiffs([{ ...base, approved: "e" }, { ...base, approved: null }]);
    t.eq([mixed.shown.length, mixed.more], [2, 0], "(6) an approved and an unapproved diff with the same path and values both survive");
    const repeated = C.summarizeDiffs([{ ...base, approved: null }, { ...base, approved: null, step: "s2" }, { ...base, approved: null, step: "s3" }]);
    t.eq([repeated.shown.length, repeated.more, repeated.shown[0].step], [1, 0, "s1"], "(6) a repeated identical diff is shown once and the first keeps its step");
    t.eq(C.summarizeDiffs([{ ...base, approved: null }, { ...base, new: 3, approved: null }, { ...base, oldAbsent: true, approved: null }]).shown.length, 3, "(6) a differing value or flag is a different diff");
    const dupExp = C.createTracker([exp({})], "s");
    const dupAll = dupExp.apply([...statusDiff(), ...statusDiff()], "A");
    t.eq([C.summarizeDiffs(dupAll).shown.length, C.unapproved(dupAll).length], [2, 1], "(6) the unapproved copy of a repeated diff is not merged into the approved one, and counts in the verdict");

    // ---------------------------------------------------------------------------------------------------------------- binding
    heading("binding");
    const ID = "n_[0-9a-f]{8}";
    const engine = (id) => {
      const step1 = view(
        { status: 201, headers: { location: `/notes/${id}` }, body: { id, title: "T" } },
        { rows: { notes: [{ id, title: "T" }] }, calls: [{ method: "POST", path: "/notify", body: { noteId: id } }] },
      );
      const step2 = view(
        { status: 200, body: { id, state: "archived" } },
        { rows: { notes: [{ id, title: "T", state: "archived" }] }, calls: [{ method: "POST", path: "/notify", body: { noteId: id, event: "note.archived" } }] },
      );
      return { step1, step2 };
    };
    const decl1 = {
      bind: { noteId: { at: "response.body.id", pattern: ID } },
      refs: [
        { at: "response.headers.location", to: "noteId", template: "/notes/{value}" },
        { at: "effects.rows.notes[*].id", to: "noteId", persist: true },
        { at: "effects.calls[0].body.noteId", to: "noteId" },
      ],
    };
    const decl2 = { refs: [{ at: "response.body.id", to: "noteId" }, { at: "effects.calls[0].body.noteId", to: "noteId" }] };
    const normalizedPair = (idOld, idNew) => {
      const result = {};
      for (const [which, id] of [["old", idOld], ["new", idNew]]) {
        const st = C.newState();
        const e = engine(id);
        result[which] = { s1: C.normalizeView(e.step1, decl1, st), s2: C.normalizeView(e.step2, decl2, st), state: st };
      }
      return result;
    };
    const pair = normalizedPair("n_aaaa1111", "n_bbbb2222");
    t.eq([pair.old.s1.violations, pair.old.s2.violations, pair.new.s1.violations, pair.new.s2.violations], [[], [], [], []], "two engines with different ids: the declared bind and refs raise no violation");
    t.eq([diffs(pair.old.s1.view, pair.new.s1.view), diffs(pair.old.s2.view, pair.new.s2.view)], [[], []], "two engines with different ids and the same declared binds give NO diff in either step (id, Location, call body, persisted row)");
    t.ok(C.isBound(pair.old.s1.view.response.body.id) && C.isBound(pair.old.s1.view.response.headers.location) && C.isBound(pair.old.s1.view.effects.calls[0].body.noteId), "the id, the Location and the call body are bound references");
    t.ok(C.isBound(pair.new.s2.view.effects.rows.notes[0].id), "the persisted row ref bound the id of the cumulative row in the second step");
    t.eq([pair.old.s1.view.response.headers.location.template, J(pair.old.s1.view.response.headers.location)], ["/notes/{value}", J("<bound:noteId:/notes/{value}>")], "a composite ref keeps its template; the display text names it");
    t.eq(J(pair.old.s1.view.response.body.id), J("<bound:noteId>"), "a default template displays as <bound:NAME>");
    t.eq([pair.old.state.bound, pair.new.state.bound], [{ noteId: "n_aaaa1111" }, { noteId: "n_bbbb2222" }], "each engine's state keeps its own produced id");
    t.eq(pair.old.state.persisted.length, 1, "the persisted ref was recorded once");
    t.eq(pair.old.s1.view.response.body.title, "T", "an undeclared field stays as it is");

    const e1 = engine("n_aaaa1111");
    const frozen = J(e1.step1);
    const nz = C.normalizeView(e1.step1, decl1, C.newState());
    t.ok(J(e1.step1) === frozen && nz.view !== e1.step1 && nz.view.response !== e1.step1.response && nz.view.effects.rows.notes !== e1.step1.effects.rows.notes, "the input view is not mutated and the result is a deep copy");
    t.eq(e1.step1.response.body.id, "n_aaaa1111", "the raw id is still in the input view");

    // each violation kind, with nothing stored or replaced at the failing location
    const norm = (v, step, st = C.newState()) => ({ ...C.normalizeView(v, step, st), st });
    const body = (b, extra) => view({ body: b }, extra);
    let r = norm(body({}), { bind: { noteId: { at: "response.body.id", pattern: ID } } });
    t.eq([r.violations, r.st.bound, r.view.response.body], [[{ kind: "bind-missing", name: "noteId", at: "response.body.id" }], {}, {}], "bind-missing: no value at the location, nothing stored");
    r = norm(body({ id: 7 }), { bind: { noteId: { at: "response.body.id", pattern: "[0-9]" } } });
    t.eq([r.violations.map((v) => v.kind), r.st.bound, r.view.response.body.id], [["bind-missing"], {}, 7], "bind-missing: a number is not a string, kept raw");
    r = norm(body({ id: "zzz" }), { bind: { noteId: { at: "response.body.id", pattern: ID } } });
    t.eq([r.violations, r.st.bound, r.view.response.body.id], [[{ kind: "bind-pattern", name: "noteId", at: "response.body.id" }], {}, "zzz"], "bind-pattern: the value does not match, kept raw, nothing stored");
    r = norm(body({ id: "n_aaaa1111x" }), { bind: { noteId: { at: "response.body.id", pattern: ID } } });
    t.eq([r.violations.map((v) => v.kind), r.view.response.body.id], [["bind-pattern"], "n_aaaa1111x"], "bind-pattern: the pattern must match the FULL string");
    r = norm(body({ id: "n_1x" }), { bind: { noteId: { at: "response.body.id", pattern: "n_1|n_2" } } });
    t.eq([r.violations.map((v) => v.kind), r.st.bound], [["bind-pattern"], {}], "bind-pattern: an alternation is anchored as a whole (n_1x does not match n_1|n_2)");
    const st = C.newState();
    C.normalizeView(body({ id: "n_aaaa1111" }), { bind: { noteId: { at: "response.body.id", pattern: ID } } }, st);
    r = norm(body({ id: "n_bbbb2222" }), { bind: { noteId: { at: "response.body.id", pattern: ID } } }, st);
    t.eq([r.violations, r.st.bound, r.view.response.body.id], [[{ kind: "bind-rebound", name: "noteId", at: "response.body.id" }], { noteId: "n_aaaa1111" }, "n_bbbb2222"], "bind-rebound: a name bound already keeps its first value and the new location stays raw");
    r = norm(body({ a: "n_aaaa1111", b: "n_aaaa1111" }), { bind: { first: { at: "response.body.a", pattern: ID }, second: { at: "response.body.b", pattern: ID } } });
    t.eq([r.violations, r.st.bound, C.isBound(r.view.response.body.a), r.view.response.body.b], [[{ kind: "bind-not-unique", name: "second", at: "response.body.b" }], { first: "n_aaaa1111" }, true, "n_aaaa1111"], "bind-not-unique: the same value under another name is refused, kept raw, nothing stored for it");
    const st2 = C.newState();
    C.normalizeView(body({ a: "n_aaaa1111" }), { bind: { first: { at: "response.body.a", pattern: ID } } }, st2);
    r = norm(body({ b: "n_aaaa1111" }), { bind: { second: { at: "response.body.b", pattern: ID } } }, st2);
    t.eq(r.violations.map((v) => v.kind), ["bind-not-unique"], "bind-not-unique: a value bound in an earlier step counts too");
    r = norm(body({ a: "n_aaaa1111", b: "n_aaaa1111" }), { bind: { first: { at: "response.body.a", pattern: ID }, second: { at: "response.body.b", pattern: ID, unique: false } } });
    t.eq([r.violations, r.st.bound], [[], { first: "n_aaaa1111", second: "n_aaaa1111" }], "unique: false allows a repeated value");
    r = norm(body({ a: "n_aaaa1111", b: "n_aaaa1111" }), { bind: { first: { at: "response.body.a", pattern: ID, unique: false }, second: { at: "response.body.b", pattern: ID } } });
    t.eq(r.violations.map((v) => v.kind), ["bind-not-unique"], "unique: false on the first bind does not excuse the second one");

    const withId = (extra) => norm(body({ id: "n_aaaa1111", ...extra }), null);
    const declId = { bind: { noteId: { at: "response.body.id", pattern: ID } } };
    r = norm(body({ id: "n_aaaa1111", loc: "/notes/n_aaaa1111" }), { ...declId, refs: [{ at: "response.body.loc", to: "noteId", template: "/notes/" }] });
    t.eq([r.violations, r.view.response.body.loc], [[{ kind: "ref-template", name: "noteId", at: "response.body.loc" }], "/notes/n_aaaa1111"], "ref-template: a template with no {value} is refused, location kept raw");
    r = norm(body({ id: "n_aaaa1111", loc: "x" }), { ...declId, refs: [{ at: "response.body.loc", to: "noteId", template: "{value}{value}" }, { at: "response.body.loc", to: "noteId", template: 5 }] });
    t.eq(r.violations.map((v) => v.kind), ["ref-template", "ref-template"], "ref-template: two {value} and a non-text template are refused");
    r = norm(body({ loc: "n_aaaa1111" }), { refs: [{ at: "response.body.loc", to: "noteId" }] });
    t.eq([r.violations, r.view.response.body.loc], [[{ kind: "ref-unbound", name: "noteId", at: "response.body.loc" }], "n_aaaa1111"], "ref-unbound: the name is not bound, the location stays raw");
    r = norm(body({ id: "n_aaaa1111" }), { ...declId, refs: [{ at: "response.body.nowhere", to: "noteId" }] });
    t.eq(r.violations, [{ kind: "ref-missing", name: "noteId", at: "response.body.nowhere" }], "ref-missing: no value at the location");
    r = norm(body({ id: "n_aaaa1111", list: [] }), { ...declId, refs: [{ at: "response.body.list[*]", to: "noteId" }] });
    t.eq(r.violations.map((v) => v.kind), ["ref-missing"], "ref-missing: [*] over an empty array matches nothing");
    r = norm(body({ id: "n_aaaa1111", loc: "n_bbbb2222" }), { ...declId, refs: [{ at: "response.body.loc", to: "noteId" }] });
    t.eq([r.violations, r.view.response.body.loc], [[{ kind: "ref-mismatch", name: "noteId", at: "response.body.loc" }], "n_bbbb2222"], "ref-mismatch: another value, kept raw");
    r = norm(body({ id: "n_aaaa1111", list: ["n_aaaa1111", "nope", "n_aaaa1111"] }), { ...declId, refs: [{ at: "response.body.list[*]", to: "noteId" }] });
    t.eq([r.violations, C.isBound(r.view.response.body.list[0]), r.view.response.body.list[1], C.isBound(r.view.response.body.list[2])], [[{ kind: "ref-mismatch", name: "noteId", at: "response.body.list[1]" }], true, "nope", true], "[*] checks every element: only the wrong one is a violation, at its own index");

    for (const [label, value] of [["a suffix", "/notes/n_aaaa1111x"], ["a longer path", "/notes/n_aaaa1111/extra"], ["a prefix", "x/notes/n_aaaa1111"], ["the id without the template", "n_aaaa1111"]]) {
      r = norm(body({ id: "n_aaaa1111", loc: value }), { ...declId, refs: [{ at: "response.body.loc", to: "noteId", template: "/notes/{value}" }] });
      t.eq([r.violations.map((v) => v.kind), r.view.response.body.loc], [["ref-mismatch"], value], `a partial reference (${label}) is ref-mismatch and stays raw`);
    }
    r = norm(body({ id: "n_aaaa1111", text: "see n_aaaa1111 now" }), { ...declId, refs: [{ at: "response.body.text", to: "noteId" }] });
    t.eq([r.violations.map((v) => v.kind), r.view.response.body.text], [["ref-mismatch"], "see n_aaaa1111 now"], "the id inside a longer text under the default template is ref-mismatch (never contains)");
    const pOld = norm(body({ id: "n_aaaa1111", loc: "/notes/n_aaaa1111x" }), { ...declId, refs: [{ at: "response.body.loc", to: "noteId", template: "/notes/{value}" }] });
    const pNew = norm(body({ id: "n_bbbb2222", loc: "/notes/n_bbbb2222x" }), { ...declId, refs: [{ at: "response.body.loc", to: "noteId", template: "/notes/{value}" }] });
    t.eq(diffs(pOld.view, pNew.view).map((d) => d.path), ["response.body.loc"], "a partial reference stays a diff between the two engines");

    const oldEcho = norm(body({ id: "n_aaaa1111", echo: "n_aaaa1111" }), declId);
    const newEcho = norm(body({ id: "n_bbbb2222", echo: "n_bbbb2222" }), declId);
    t.eq([oldEcho.violations, newEcho.violations], [[], []], "the declared id binds in both engines");
    t.eq(diffs(oldEcho.view, newEcho.view), [{ path: "response.body.echo", old: "n_aaaa1111", new: "n_bbbb2222", oldAbsent: false, newAbsent: false }], "an UNRELATED undeclared field holding each engine's own bound id stays a diff with the raw values");

    const bound = norm(body({ id: "n_aaaa1111" }), declId).view;
    const literal = C.normalizeView(body({ id: "<bound:noteId>" }), null, C.newState()).view;
    t.eq(diffs(bound, literal).length, 1, "a literal string <bound:noteId> in one view against a Bound in the other is a diff");
    t.eq(diffs(literal, bound).length, 1, "... in either direction");
    t.eq(diffs(literal, C.normalizeView(body({ id: "<bound:noteId>" }), null, C.newState()).view), [], "equal literal strings are not a diff");
    t.ok(!C.isBound("<bound:noteId>") && !C.isBound({ name: "noteId", template: "{value}" }) && C.isBound(bound.response.body.id), "isBound accepts only a normalized reference");
    const otherName = norm(body({ id: "n_aaaa1111" }), { bind: { other: { at: "response.body.id", pattern: ID } } }).view;
    t.eq(diffs(bound, otherName).length, 1, "two references with different names are a diff");
    const otherTemplate = norm(body({ id: "n_aaaa1111", loc: "/x/n_aaaa1111" }), { ...declId, refs: [{ at: "response.body.loc", to: "noteId", template: "/x/{value}" }] }).view;
    const defaultTemplate = norm(body({ id: "n_aaaa1111", loc: "n_aaaa1111" }), { ...declId, refs: [{ at: "response.body.loc", to: "noteId" }] }).view;
    t.eq(diffs(otherTemplate, defaultTemplate).map((d) => d.path), ["response.body.loc"], "two references to one name with different templates are a diff");
    t.eq(diffs(bound, norm(body({ id: "n_cccc3333" }), declId).view), [], "two references with the same name and template are equal whatever the raw values");
    t.eq(C.summarizeDiffs([{ path: "p", old: bound.response.body.id, new: 1, oldAbsent: false, newAbsent: false, approved: null }, { path: "p", old: "<bound:noteId>", new: 1, oldAbsent: false, newAbsent: false, approved: null }]).shown.length, 2, "the display deduplication never merges a Bound with a string that looks like its display text");

    r = norm(body({ id: "n_aaaa1111", other: "n_deadbeef" }), declId);
    t.ok(!C.isBound(r.view.response.body.other) && r.view.response.body.other === "n_deadbeef", "a value that merely looks like an id (right pattern, not bound) is not replaced");
    r = norm(body({ id: "n_aaaa1111", copy: "n_aaaa1111" }), declId);
    t.ok(!C.isBound(r.view.response.body.copy), "a value equal to the bound id at an undeclared location is not replaced");
    t.ok(throws(() => C.normalizeView(body({ id: "n_aaaa1111" }), { bind: { noteId: { at: "response.body[*].id", pattern: ID } } }, C.newState())), "a bind at a path with [*] is refused");
    t.ok(throws(() => C.normalizeView(body({ id: "n_aaaa1111" }), { bind: { noteId: { at: "other.id", pattern: ID } } }, C.newState())), "a bind outside response and effects is refused");
    t.ok(throws(() => C.normalizeView(body({ id: "n_aaaa1111" }), { bind: { "Bad name": { at: "response.body.id", pattern: ID } } }, C.newState())), "a bind name outside the grammar is refused");
    t.eq(withId({}).violations, [], "a step with no declaration changes and reports nothing");

    // ---------------------------------------------------------------------------------------------------------------- substitute
    heading("substitute");
    const boundNames = { noteId: "n_1", other: "X" };
    const request = {
      method: "POST",
      path: "/notes/{{noteId}}/archive",
      headers: { "x-note": "{{noteId}}", "{{noteId}}": "key-kept" },
      body: { "{{noteId}}": "key", list: ["{{noteId}}", { deep: "pre-{{noteId}}-{{other}}-post" }], count: 1 },
    };
    const frozenRequest = J(request);
    const sub = C.substitute(request, boundNames);
    t.eq(sub.path, "/notes/n_1/archive", "the path is replaced");
    t.eq(sub.headers["x-note"], "n_1", "a header value is replaced");
    t.eq(sub.body.list, ["n_1", { deep: "pre-n_1-X-post" }], "strings in nested body arrays and objects are replaced");
    t.eq([Object.keys(sub.headers), Object.keys(sub.body)], [["x-note", "{{noteId}}"], ["{{noteId}}", "list", "count"]], "keys are never replaced");
    t.eq([sub.method, sub.body.count], ["POST", 1], "other fields stay");
    t.ok(J(request) === frozenRequest && sub !== request, "the request is not mutated");
    t.eq(C.substitute({ path: "/x", body: "{{noteId}}" }, boundNames).body, "n_1", "a body that is itself a string is replaced");
    t.ok(throws(() => C.substitute({ path: "/{{missing}}" }, boundNames)), "an unbound name in the path throws");
    t.ok(throws(() => C.substitute({ path: "/x", headers: { h: "{{missing}}" } }, boundNames)), "an unbound name in a header throws");
    t.ok(throws(() => C.substitute({ path: "/x", body: { a: [{ b: "{{missing}}" }] } }, boundNames)), "an unbound name deep in the body throws");
    t.ok(throws(() => C.substitute({ path: "/{{toString}}" }, {})), "a name that only exists on Object.prototype is unbound");
    t.eq(C.substitute({ path: "/{{ x }}/{{Bad}}/{{noteId/{{9a}}" }, boundNames).path, "/{{ x }}/{{Bad}}/{{noteId/{{9a}}", "text that is not of the grammar is left alone");
    t.eq(C.substitute({ path: "/{{a}}" }, { a: "{{b}}", b: "X" }).path, "/{{b}}", "the replaced text is not scanned again");
    const long = `${"a".repeat(31)}`;
    t.eq(C.substitute({ path: `/{{${long}}}` }, { [long]: "X" }).path, `/{{${long}}}`, "a name longer than 30 characters is not of the grammar");

    // ---------------------------------------------------------------------------------------------------------------- targetUrl
    heading("targetUrl");
    t.eq(C.targetUrl("http://127.0.0.1:4010", "/notes/n_1?x=1"), "http://127.0.0.1:4010/notes/n_1?x=1", "a loopback base and a path give exactly the loopback URL");
    t.eq(C.targetUrl("http://127.0.0.1:4010/", "/a/b"), "http://127.0.0.1:4010/a/b", "a trailing slash on the base is allowed");
    t.eq(C.targetUrl("http://127.0.0.1:65535", "/"), "http://127.0.0.1:65535/", "port 65535 is allowed");
    t.eq(C.targetUrl("http://127.0.0.1:1", "/x#f"), "http://127.0.0.1:1/x#f", "port 1 is allowed");
    for (const p of ["//example.invalid/x", "/\\example.invalid/x", "http://example.invalid/", "", "notes", "/\t/example.invalid/x", "///example.invalid", "\\\\example.invalid\\x"]) {
      t.ok(throws(() => C.targetUrl("http://127.0.0.1:4010", p)), `targetUrl refuses the path ${J(p)}`);
    }
    t.ok(throws(() => C.targetUrl("http://127.0.0.1:4010", undefined)) && throws(() => C.targetUrl("http://127.0.0.1:4010", 5)), "targetUrl refuses a path that is not text");
    for (const b of [
      "http://example.invalid:80", "http://localhost:4010", "https://127.0.0.1:4010", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:65536",
      "http://127.0.0.1:04010", "http://127.0.0.1:4010/x", "http://127.0.0.1:4010?x=1", "http://127.0.0.1:4010#f", `http://user${AT}127.0.0.1:4010`, `http://127.0.0.1:4010${AT}example.invalid`,
      "http://[::1]:4010", "http://0.0.0.0:4010", "http://127.0.0.2:4010", " http://127.0.0.1:4010", "HTTP://127.0.0.1:4010", "", undefined,
    ]) {
      t.ok(throws(() => C.targetUrl(b, "/x")), `targetUrl refuses the base ${J(b)}`);
    }

    // ------------------------------------------------------------------------------------------------------------ validateEffects
    heading("validateEffects");
    const good = () => ({ rows: { notes: [{ id: "a", tags: ["x", { deep: [1, null, true] }] }], empty: [] }, calls: [{ method: "POST" }], jobs: [{ kind: "index" }] });
    t.eq(C.validateEffects(good(), 0), null, "a good projection gives null");
    t.eq(C.validateEffects(good(), 1), null, "calls with exactly seenCalls entries are fine");
    t.eq(C.validateEffects({ rows: {}, calls: [], jobs: [] }, 0), null, "an empty projection is well formed");
    t.eq(C.validateEffects({ rows: { t: [Object.assign(Object.create(null), { a: 1 })] }, calls: [], jobs: [] }, 0), null, "an object without a prototype is a plain object");
    const shared = { v: 1 };
    t.eq(C.validateEffects({ rows: { t: [{ a: shared, b: shared }] }, calls: [], jobs: [] }, 0), null, "a value reached twice (not a cycle) is well formed");
    const M = "effects malformed";
    const malformed = (label, effects, seen = 0) => t.eq(C.validateEffects(effects, seen), M, `malformed: ${label}`);
    malformed("rows of { notes: 5 }", { ...good(), rows: { notes: 5 } });
    malformed("rows of { notes: [1] }", { ...good(), rows: { notes: [1] } });
    malformed("rows of { notes: [[]] }", { ...good(), rows: { notes: [[]] } });
    malformed("rows of { notes: [null] }", { ...good(), rows: { notes: [null] } });
    malformed("rows an array", { ...good(), rows: [] });
    malformed("rows null", { ...good(), rows: null });
    malformed("calls not an array", { ...good(), calls: {} });
    malformed("calls shorter than seenCalls", { ...good(), calls: [] }, 1);
    malformed("calls with a non-object element", { ...good(), calls: [1] });
    malformed("calls with an array element", { ...good(), calls: [[]] });
    malformed("jobs an object", { ...good(), jobs: {} });
    malformed("jobs with a non-object element", { ...good(), jobs: ["x"] });
    malformed("an extra key", { ...good(), extra: [] });
    malformed("a missing key (jobs)", { rows: {}, calls: [] });
    malformed("a missing key (rows)", { calls: [], jobs: [] });
    malformed("an undefined value", { ...good(), rows: { notes: [{ id: undefined }] } });
    malformed("NaN", { ...good(), rows: { notes: [{ id: NaN }] } });
    malformed("Infinity", { ...good(), jobs: [{ n: Infinity }] });
    malformed("a function", { ...good(), rows: { notes: [{ id: () => 1 }] } });
    malformed("a bigint", { ...good(), rows: { notes: [{ id: 1n }] } });
    malformed("a symbol", { ...good(), rows: { notes: [{ id: Symbol("s") }] } });
    malformed("a Date row", { ...good(), rows: { notes: [new Date(0)] } });
    malformed("a Map value", { ...good(), jobs: [{ m: new Map() }] });
    malformed("a class instance", { ...good(), jobs: [new (class Job {})()] });
    malformed("a hole in an array", { ...good(), rows: { notes: [{ tags: [1, , 3] }] } }); // eslint-disable-line no-sparse-arrays
    malformed("a symbol key", { ...good(), jobs: [{ [Symbol("k")]: 1 }] });
    malformed("a non-integer seenCalls", good(), 0.5);
    malformed("a negative seenCalls", good(), -1);
    malformed("a null effects", null);
    malformed("an array effects", []);
    malformed("a text effects", "x");
    const cyc = { id: "c" };
    cyc.self = cyc;
    malformed("a cycle in a row", { ...good(), rows: { notes: [cyc] } });
    const cycJob = { x: [] };
    cycJob.x.push(cycJob);
    malformed("a cycle through an array in a job", { ...good(), jobs: [cycJob] });
    const cycTop = good();
    cycTop.rows.notes[0].back = cycTop;
    malformed("a cycle back to the projection", cycTop);
    let deep = {};
    const rootDeep = deep;
    for (let i = 0; i < 200000; i++) deep = deep.n = {};
    let deepResult = "threw";
    try { deepResult = C.validateEffects({ rows: { t: [rootDeep] }, calls: [], jobs: [] }, 0); } catch { /* checked below */ }
    t.ok(deepResult === null || deepResult === M, "a very deep value does not throw out of validateEffects");
    const badBoth = { rows: { notes: [1] }, calls: [], jobs: [] };
    t.eq(diffs(badBoth, badBoth), [], "the same malformed projection from both engines gives no diff");
    t.eq([C.validateEffects(badBoth, 0), C.validateEffects(badBoth, 0)], [M, M], "but it is still malformed for each engine, so a runner can not count it as equal");
    t.ok(C.validateEffects({ rows: { notes: [{ id: C.normalizeView(body({ id: "n_aaaa1111" }), declId, C.newState()).view.response.body.id }] }, calls: [], jobs: [] }, 0) === M, "a normalized reference is not JSON data: a projection must be validated before normalizing");
  });
}
