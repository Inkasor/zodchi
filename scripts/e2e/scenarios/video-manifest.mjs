import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const init = { id: "demo", format: "short" };
const build = { purpose: "build", ext: "mp4" };
const media = Buffer.from("synthetic frames");
const different = Buffer.alloc(media.length, 42);
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function snapshot(dir) {
  const entries = [];
  function visit(full) {
    const info = fs.lstatSync(full);
    const name = path.relative(dir, full);
    if (info.isSymbolicLink()) entries.push([name, "link", fs.readlinkSync(full)]);
    else if (info.isDirectory()) {
      entries.push([name, "directory"]);
      for (const child of fs.readdirSync(full).sort()) visit(path.join(full, child));
    } else entries.push([name, info.mtimeMs, fs.readFileSync(full).toString("base64")]);
  }
  visit(dir);
  return entries;
}

export default function register({ scenario, ROOT }) {
  const helper = path.join(ROOT, "scripts/e2e/fixtures/video-manifest-v1.mjs");

  function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-manifest-"));
    t.cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, "video");
    fs.mkdirSync(dir);
    const file = path.join(dir, "manifest.json");
    const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
    const write = value => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
    function call(command, fields = {}, { code = 0, ok = true, fail = "", b64 = false, raw } = {}) {
      const before = snapshot(root);
      const json = JSON.stringify({ api: 1, dir, ...fields });
      const spec = raw ?? (b64 ? "b64:" + Buffer.from(json).toString("base64") : json);
      const args = command ? [helper, command, spec] : [helper];
      const result = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true,
        env: { ...process.env, ZODCHI_VIDEO_FAIL: fail } });
      if (result.error) throw result.error;
      t.log(`${command || "(missing command)"} exit ${result.status}\n${result.stdout}`);
      assert.equal(result.status, code, result.stderr || result.stdout);
      assert.match(result.stdout, /^\{[^\r\n]*\}\r?\n$/u);
      const answer = JSON.parse(result.stdout);
      assert.equal(answer.api, 1);
      assert.ok(!Object.hasOwn(answer, "plugin"));
      if (code === 0) {
        const { lineSha256, ...body } = answer;
        assert.equal(lineSha256, sha(JSON.stringify(body)));
        assert.equal(Object.keys(answer).at(-1), "lineSha256");
      } else assert.ok(!Object.hasOwn(answer, "lineSha256"));
      assert.equal(answer.ok, ok, result.stdout);
      if (!ok) assert.ok(typeof answer.error === "string" && answer.error.length);
      if (Object.hasOwn(answer, "manifestSha256")) assert.equal(answer.manifestSha256, sha(fs.readFileSync(file)));
      if (!ok || command === "video-check") assert.deepEqual(snapshot(root), before);
      return answer;
    }
    const refuse = (command, fields, options) => call(command, fields, { ...options, ok: false });
    const edit = change => { const draft = read(); change(draft); write(draft); };
    function addEditorial() {
      fs.mkdirSync(path.join(dir, "footage"));
      fs.writeFileSync(path.join(dir, "footage", "demo.mp4"), "source frames");
      edit(draft => {
        draft.sources.push({ id: "demo", kind: "screen", path: "footage/demo.mp4", sha256: null, note: "" });
        draft.segments.push({ id: "s3", source: "demo", in: 0, out: 405, speed: 1, speedMarked: false,
          reason: "Show the saved order", evidence: "A new order number appears", model: "", effort: "" });
        draft.audio.push({ id: "theme", role: "music", origin: "own", source: null,
          license: "Original composition", attribution: "Demo ensemble", licenseChecked: true });
        draft.claims.push({ id: "visible", text: "A new order exists", kind: "confirmed",
          segment: "s3", confirmation: "New number at 6:41 of s3", note: "" });
      });
    }
    function finish(render) {
      fs.writeFileSync(render.absolutePath, media, { flag: "wx" });
      return call("video-render-done", { render: render.render, ok: true });
    }
    return { root, dir, read, write, edit, call, refuse, addEditorial, finish };
  }

  scenario("video-manifest-init", "create once, distinguish refusals from usage, roll back a failed init", t => {
    const w = fixture(t);
    for (const fields of [{ ...init, id: "bad id" }, { ...init, format: "square" }]) w.refuse("video-init", fields);
    w.refuse("video-init", { format: "long" }, { code: 2 });
    w.refuse("video-init", { api: 2, extra: true }, { code: 3 });
    w.refuse(null, {}, { code: 2 });
    w.refuse("video-init", { ...init, extra: false }, { code: 2 });
    for (const raw of ["{", "[]", "b64:***"]) w.refuse("video-init", {}, { code: 2, raw });
    w.refuse("video-init", init, { fail: "rename" });
    const answer = w.call("video-init", { ...init, title: "Demo cut" }, { b64: true });
    assert.equal(answer.manifest, "manifest.json");
    assert.deepEqual(fs.readdirSync(w.dir).sort(), ["manifest.json", "renders"]);
    const m = w.read();
    assert.deepEqual([m.status, m.deliveryLimitBytes, m.proposed.title, m.history[0].event], ["draft", 20971520, "Demo cut", "init"]);
    w.refuse("video-init", init);
    const fresh = fixture(t);
    fs.mkdirSync(path.join(fresh.dir, "renders"));
    fresh.refuse("video-init", init, { fail: "write" });
    fresh.call("video-init", init);
  });

  scenario("video-manifest-check", "validate structure, readiness and warnings independently without writing", t => {
    const w = fixture(t);
    w.refuse("video-check");
    fs.writeFileSync(path.join(w.dir, "manifest.json"), "{");
    w.refuse("video-check");
    fs.unlinkSync(path.join(w.dir, "manifest.json"));
    w.call("video-init", init);
    assert.match(w.call("video-check").notReady[0], /segments/);
    w.addEditorial();
    const render = w.call("video-render-new", build);
    w.finish(render);
    const base = w.read();
    const checked = w.call("video-check", { verifyFiles: true });
    for (const key of ["errors", "notReady", "warnings"]) assert.deepEqual(checked[key], []);
    function problem(level, change, field) {
      const m = structuredClone(base);
      change(m);
      w.write(m);
      const result = w.call("video-check");
      for (const key of ["errors", "notReady", "warnings"]) {
        if (key === level) assert.ok(result[key].some(line => line.includes(field)), JSON.stringify(result[key]));
        else assert.deepEqual(result[key], []);
      }
    }
    for (const [change, field] of [
      [m => { m.proposed.extra = 1; }, "extra"], [m => m.sources.push(m.sources[0]), ".id"],
      [m => { m.segments[0].source = "gone"; }, ".source"], [m => { m.segments[0].in = 405; }, ".out"],
      [m => { m.renders[0].editSha256 = "0".repeat(64); }, ".editSha256"],
      [m => { m.claims[0].confirmation = ""; }, ".confirmation"], [m => { m.renders[0].bytes = null; }, ".bytes"],
      [m => { m.status = "accepted"; }, ".chosen"], [m => m.history.push(m.history[0]), ".history"],
      [m => { m.renders[0].path = "other.mp4"; }, ".path"],
      [m => {
        m.renders[0].edit.segments[0].source = "gone";
        m.renders[0].editSha256 = sha(JSON.stringify(m.renders[0].edit));
      }, ".edit.segments[0].source"],
      [m => m.history.reverse(), ".history"], [m => { m.history[0].by = "owner"; }, ".by"],
      [m => { m.segments = {}; }, ".segments"],
    ]) problem("errors", change, field);
    w.refuse("video-render-new", build);
    problem("notReady", m => { m.segments[0].speed = 2; }, "speedMarked");
    problem("notReady", m => { m.segments[0].reason = ""; }, ".reason");
    problem("notReady", m => { m.audio[0].attribution = ""; }, ".attribution");
    problem("notReady", m => { m.audio[0].license = ""; }, ".license");
    problem("warnings", m => { m.sources[0].path = "missing"; }, ".path");
    problem("warnings", m => { m.segments[0].evidence = ""; }, ".evidence");
    problem("warnings", m => Object.assign(m.audio[0], { role: "voice", origin: "synthetic", licenseChecked: false }), ".licenseChecked");
    problem("warnings", m => Object.assign(m.claims[0], { kind: "reported", confirmation: "" }), ".kind");
    fs.mkdirSync(path.join(w.dir, "renders", "r12"));
    problem("warnings", () => {}, "renders/r12");
    w.write([]);
    const malformed = w.call("video-check");
    assert.ok(malformed.errors.length);
    assert.deepEqual([malformed.status, malformed.chosen, malformed.renders], [null, null, []]);
    w.write({ ...base, renders: [null, [], 42, {}, { id: "r2" }] });
    assert.deepEqual(w.call("video-check").renders.map(row => row.id), ["r2"]);
  });

  scenario("video-manifest-renders", "reserve distinct paths, record final bytes and undo failed allocations", t => {
    const w = fixture(t);
    w.call("video-init", init);
    const first = w.call("video-render-new", build);
    const second = w.call("video-render-new", build);
    assert.equal(first.path, "renders/r1/r1.mp4");
    assert.equal(first.absolutePath, path.join(w.dir, first.path));
    assert.notEqual(first.absolutePath, second.absolutePath);
    assert.ok(!fs.existsSync(first.absolutePath));
    fs.rmdirSync(path.dirname(second.absolutePath));
    assert.equal(w.call("video-render-new", build).render, "r3");
    fs.mkdirSync(path.join(w.dir, "renders", "r7"));
    w.refuse("video-render-new", { ...build, ext: "wav" });
    for (const fail of ["write", "rename"]) w.refuse("video-render-new", build, { fail });
    const next = w.call("video-render-new", build);
    assert.equal(next.render, "r8");
    const done = { render: first.render, ok: true };
    w.refuse("video-render-done", done);
    fs.writeFileSync(first.absolutePath, "");
    w.refuse("video-render-done", done);
    fs.writeFileSync(first.absolutePath, media);
    const built = w.call("video-render-done", done);
    assert.deepEqual([built.state, built.bytes, built.sha256, built.overDeliveryLimit], ["built", media.length, sha(media), false]);
    assert.match(w.refuse("video-render-done", done).error, /final.*video-render-new/);
    w.edit(m => { m.deliveryLimitBytes = 1; });
    assert.equal(w.finish(next).overDeliveryLimit, true);
    const failed = w.call("video-render-done", { render: second.render, ok: false, note: "encoder stopped" });
    assert.equal(failed.state, "failed");
    const m = w.read();
    assert.deepEqual([m.renders[1].state, m.renders[1].note, m.renders[1].bytes, m.renders[1].sha256], ["failed", "encoder stopped", null, null]);
    assert.match(m.renders[1].doneAt, iso);
    assert.equal(m.history.filter(row => row.event === "render-done" && row.render === second.render).length, 1);
    w.refuse("video-render-done", { render: second.render, ok: false });
  });

  scenario("video-manifest-status", "relay owner decisions for the exact bytes and cuts the owner approved", t => {
    const w = fixture(t);
    w.call("video-init", init);
    w.addEditorial();
    const allocate = () => w.call("video-render-new", build);
    const first = allocate();
    const accept = { status: "accepted", render: first.render, ownerConfirmed: true, ownerWords: "I approve the first cut." };
    const publish = { ...accept, status: "published", ownerWords: "I published the first cut.", publicationId: "demo-release",
      snapshotAt: "2026-01-02T12:00:00Z" };
    const reject = fields => w.refuse("video-set-status", fields);
    reject(accept); // Still allocated.
    w.finish(first);
    reject({ ...accept, ownerConfirmed: undefined });
    reject({ ...accept, ownerConfirmed: "true" });
    reject({ ...accept, ownerWords: undefined });
    reject({ ...accept, ownerWords: " " });
    reject({ ...accept, ownerWords: "a".repeat(2001) });
    reject(publish);
    const original = w.read().renders[0];
    assert.equal(first.editSha256, sha(JSON.stringify(original.edit)));
    function changeCut(m) {
      m.segments[0].out = 300;
      m.audio[0].attribution = "Second ensemble";
    }
    w.edit(changeCut);
    const second = allocate();
    w.finish(second);
    assert.notEqual(second.editSha256, first.editSha256);
    assert.match(reject(accept).error, /draft changed.*new render/);
    const probe = w.call("video-render-new", { purpose: "probe", ext: "wav" });
    w.finish(probe);
    reject({ ...accept, render: probe.render });
    w.edit(m => { m.audio[0].attribution = ""; });
    const unready = allocate();
    w.finish(unready);
    reject({ ...accept, render: unready.render });
    w.edit(m => Object.assign(m, original.edit));
    fs.writeFileSync(first.absolutePath, different);
    reject(accept);
    assert.deepEqual(w.call("video-check").notReady, []);
    assert.deepEqual(w.call("video-check", { verifyFiles: false }).notReady, []);
    assert.match(w.call("video-check", { verifyFiles: true }).notReady[0], /renders\[0\]/);
    fs.writeFileSync(first.absolutePath, media);
    const accepted = w.call("video-set-status", accept);
    assert.deepEqual([accepted.status, accepted.chosen, accepted.editSha256], ["accepted", first.render, first.editSha256]);
    function ownerEntry(event, words) {
      const entry = w.read().history.at(-1);
      assert.deepEqual([entry.event, entry.render, entry.by, entry.words], [event, first.render, "owner", words]);
    }
    ownerEntry("accepted", accept.ownerWords);
    reject({ ...accept, render: second.render });
    reject({ ...accept, status: "draft" });
    w.edit(changeCut);
    w.finish(allocate());
    assert.deepEqual(w.read().renders[0], original);
    assert.deepEqual(fs.readFileSync(first.absolutePath), media);
    assert.equal(w.read().chosen, first.render);
    reject({ ...publish, render: second.render });
    reject({ ...publish, publicationId: undefined });
    reject({ ...publish, snapshotAt: "2026-02-30T12:00:00Z" });
    fs.writeFileSync(first.absolutePath, different);
    reject(publish);
    fs.writeFileSync(first.absolutePath, media);
    const published = w.call("video-set-status", publish);
    assert.deepEqual([published.status, published.chosen, published.editSha256], ["published", first.render, first.editSha256]);
    ownerEntry("published", publish.ownerWords);
    assert.deepEqual(w.read().publication, { id: publish.publicationId, snapshotAt: publish.snapshotAt });
    w.finish(allocate());
    assert.deepEqual(w.read().renders[0], original);
    assert.deepEqual(w.call("video-check", { verifyFiles: true }).errors, []);
  });

  scenario("video-manifest-paths", "confine helper files, refuse linked media, only stat source paths", t => {
    const w = fixture(t);
    for (const dir of ["relative", w.dir + "/../video", w.dir + "\\..\\video", path.join(w.dir, "missing")]) {
      w.refuse("video-init", { ...init, dir });
    }
    const outside = path.join(w.root, "outside");
    fs.mkdirSync(outside);
    const target = path.join(outside, "frames");
    fs.writeFileSync(target, media);
    const renders = path.join(w.dir, "renders");
    const linkDir = (from, to) => fs.symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
    linkDir(outside, renders);
    w.refuse("video-init", init);
    fs.unlinkSync(renders);
    w.call("video-init", init);
    fs.rmdirSync(renders);
    linkDir(outside, renders);
    w.refuse("video-render-new", build);
    fs.unlinkSync(renders);
    fs.mkdirSync(renders);
    w.addEditorial();
    w.edit(m => { m.sources[0].path = outside; }); // Reading this directory as a media file would fail.
    assert.deepEqual(w.call("video-check").warnings, []);
    w.edit(m => { m.sources[0].path = path.join(outside, "missing"); });
    assert.match(w.call("video-check").warnings[0], /source.*path/);
    const render = w.call("video-render-new", build);
    const folder = path.dirname(render.absolutePath);
    fs.rmdirSync(folder);
    linkDir(outside, folder);
    w.refuse("video-render-done", { render: render.render, ok: true });
    fs.unlinkSync(folder);
    fs.mkdirSync(folder);
    fs.symlinkSync(target, render.absolutePath, "file");
    w.refuse("video-render-done", { render: render.render, ok: true });
  });
}
