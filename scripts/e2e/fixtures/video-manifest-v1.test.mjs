import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { VIDEO_COMMANDS, lineSha } from "./video-manifest-v1.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const at = "2026-01-01T00:00:00.000Z";

function fixture(count) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "video-manifest-test-")));
  fs.mkdirSync(path.join(dir, "renders"));
  fs.writeFileSync(path.join(dir, "source.txt"), "source");
  const edit = {
    proposed: { title: "Title", description: "", prompt: "", voiceText: "" },
    sources: [{ id: "source", kind: "other", path: "source.txt", sha256: null, note: "" }],
    segments: [{ id: "segment", source: "source", in: 0, out: 1, speed: 1, speedMarked: true,
      reason: "cut", evidence: "visible", model: "", effort: "" }],
    audio: [], costs: [], claims: [],
  };
  const renders = [];
  const history = [{ at, event: "init", render: null, by: "helper", words: null }];
  for (let index = 1; index <= count; index++) {
    const id = `r${index}`;
    const relative = `renders/${id}/${id}.mp4`;
    const bytes = Buffer.from(`media-${id}`);
    fs.mkdirSync(path.join(dir, "renders", id));
    fs.writeFileSync(path.join(dir, relative), bytes);
    renders.push({ id, path: relative, purpose: "build", state: "built", createdAt: at, doneAt: at,
      bytes: bytes.length, sha256: sha(bytes), note: "", edit, editSha256: lineSha(edit) });
    history.push({ at, event: "render-new", render: id, by: "helper", words: null });
    history.push({ at, event: "render-done", render: id, by: "helper", words: null });
  }
  const manifest = { version: 1, id: "test-video", format: "short", status: "draft", ...edit,
    deliveryLimitBytes: 20971520, renders, chosen: null, publication: null, history };
  const manifestPath = path.join(dir, "manifest.json");
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(manifestPath, manifestBytes);
  return { dir, renders, manifestPath, manifestBytes };
}

function withFixture(count, run) {
  const data = fixture(count);
  try { run(data); }
  finally { fs.rmSync(data.dir, { recursive: true, force: true }); }
}

function systemError(code, syscall) {
  const error = new Error(`${code}: injected ${syscall} failure`);
  error.code = code;
  error.syscall = syscall;
  return error;
}

// Count mutation attempts as well as intercepting reads, and always restore fs.
function intercept(options, run) {
  const originals = {};
  const writes = [];
  for (const name of ["openSync", "readFileSync", "writeFileSync", "renameSync", "unlinkSync", "mkdirSync", "rmdirSync"]) {
    originals[name] = fs[name];
  }
  fs.openSync = function (file, flags, ...args) {
    if (flags !== "r") writes.push("openSync");
    if (options.open) options.open(file, flags);
    return originals.openSync.call(fs, file, flags, ...args);
  };
  fs.readFileSync = function (file, ...args) {
    if (options.readFile) options.readFile(file);
    return originals.readFileSync.call(fs, file, ...args);
  };
  for (const name of ["writeFileSync", "renameSync", "unlinkSync", "mkdirSync", "rmdirSync"]) {
    fs[name] = function (...args) {
      writes.push(name);
      return originals[name].apply(fs, args);
    };
  }
  try { run(writes); }
  finally {
    for (const [name, original] of Object.entries(originals)) fs[name] = original;
  }
}

function acceptance(dir, render = "r1") {
  return { dir, render, status: "accepted", ownerConfirmed: true, ownerWords: "Approved" };
}

for (const code of ["EACCES", "EBUSY", "EIO"]) {
  test(`video-check continues after ${code} and verifies the next render`, () => {
    withFixture(2, data => {
      const first = path.join(data.dir, data.renders[0].path);
      const second = path.join(data.dir, data.renders[1].path);
      fs.writeFileSync(second, Buffer.alloc(data.renders[1].bytes, "z"));
      const fault = systemError(code, "open");
      let attempts = 0;
      intercept({ open(file) {
        if (file === first) { attempts++; throw fault; }
      } }, writes => {
        const answer = VIDEO_COMMANDS["video-check"]({ dir: data.dir, verifyFiles: true });
        assert.equal(answer.ok, true);
        assert.deepEqual(answer.errors, []);
        assert.deepEqual(answer.notReady, [
          "manifest.renders[0].path: media file could not be verified",
          `manifest.renders[1].path: ${data.renders[1].path}: size or digest differs from recorded file`,
        ]);
        assert.equal(answer.manifestSha256, sha(data.manifestBytes));
        assert.equal(attempts, 1);
        assert.deepEqual(writes, []);
        assert.deepEqual(fs.readFileSync(data.manifestPath), data.manifestBytes);
      });
    });
  });
}

test("manifest read errors remain strict", () => {
  withFixture(2, data => {
    const fault = systemError("EIO", "read");
    intercept({ readFile(file) {
      if (file === data.manifestPath) throw fault;
    } }, writes => {
      assert.deepEqual(VIDEO_COMMANDS["video-check"]({ dir: data.dir, verifyFiles: true }),
        { ok: false, error: fault.message });
      assert.deepEqual(writes, []);
    });
    assert.deepEqual(fs.readFileSync(data.manifestPath), data.manifestBytes);
  });
});

test("selected render errors refuse acceptance without writing", () => {
  withFixture(2, data => {
    const selected = path.join(data.dir, data.renders[0].path);
    const fault = systemError("EIO", "open");
    let attempts = 0;
    intercept({ open(file) {
      if (file === selected) { attempts++; throw fault; }
    } }, writes => {
      assert.deepEqual(VIDEO_COMMANDS["video-set-status"](acceptance(data.dir)),
        { ok: false, error: fault.message });
      assert.equal(attempts, 1);
      assert.deepEqual(writes, []);
      assert.deepEqual(fs.readFileSync(data.manifestPath), data.manifestBytes);
    });
  });
});

for (const { label, fields, error } of [
  { label: "publicationId", fields: { publicationId: "video-123" },
    error: "publicationId: only allowed when status is published" },
  { label: "empty publicationId", fields: { publicationId: "" },
    error: "publicationId: only allowed when status is published" },
  { label: "snapshotAt", fields: { snapshotAt: at },
    error: "snapshotAt: only allowed when status is published" },
  { label: "empty snapshotAt", fields: { snapshotAt: "" },
    error: "snapshotAt: only allowed when status is published" },
  { label: "both publication fields", fields: { publicationId: "video-123", snapshotAt: at },
    error: "publicationId, snapshotAt: only allowed when status is published" },
  { label: "both empty publication fields", fields: { publicationId: "", snapshotAt: "" },
    error: "publicationId, snapshotAt: only allowed when status is published" },
]) {
  test(`acceptance refuses ${label} without writing`, () => {
    withFixture(1, data => {
      const spec = { ...acceptance(data.dir), ...fields };
      intercept({}, writes => {
        assert.deepEqual(VIDEO_COMMANDS["video-set-status"](spec), { ok: false, error });
        assert.deepEqual(writes, []);
        assert.deepEqual(fs.readFileSync(data.manifestPath), data.manifestBytes);
      });
    });
  });
}

test("healthy render can be accepted", () => {
  withFixture(2, data => {
    const answer = VIDEO_COMMANDS["video-set-status"](acceptance(data.dir));
    assert.equal(answer.ok, true);
    assert.equal(answer.status, "accepted");
    assert.equal(answer.chosen, "r1");
    const bytes = fs.readFileSync(data.manifestPath);
    assert.equal(answer.manifestSha256, sha(bytes));
    assert.equal(JSON.parse(bytes.toString("utf8")).status, "accepted");
  });
});

test("publication requires and retains publication metadata", () => {
  withFixture(1, data => {
    assert.equal(VIDEO_COMMANDS["video-set-status"](acceptance(data.dir)).ok, true);
    const acceptedBytes = fs.readFileSync(data.manifestPath);
    const base = { ...acceptance(data.dir), status: "published" };
    for (const { fields, error } of [
      { fields: { snapshotAt: at }, error: "publicationId: required" },
      { fields: { publicationId: " ", snapshotAt: at }, error: "publicationId: required" },
      { fields: { publicationId: "video-123" }, error: "snapshotAt: expected a UTC timestamp" },
      { fields: { publicationId: "video-123", snapshotAt: "not a timestamp" },
        error: "snapshotAt: expected a UTC timestamp" },
    ]) {
      intercept({}, writes => {
        assert.deepEqual(VIDEO_COMMANDS["video-set-status"]({ ...base, ...fields }), { ok: false, error });
        assert.deepEqual(writes, []);
        assert.deepEqual(fs.readFileSync(data.manifestPath), acceptedBytes);
      });
    }
    const answer = VIDEO_COMMANDS["video-set-status"]({ ...base, publicationId: "video-123", snapshotAt: at });
    assert.equal(answer.ok, true);
    assert.equal(answer.status, "published");
    const bytes = fs.readFileSync(data.manifestPath);
    assert.equal(answer.manifestSha256, sha(bytes));
    const manifest = JSON.parse(bytes.toString("utf8"));
    assert.equal(manifest.status, "published");
    assert.deepEqual(manifest.publication, { id: "video-123", snapshotAt: at });
  });
});

test("enumerable verifyFiles is rejected for writes", () => {
  withFixture(2, data => {
    const spec = { ...acceptance(data.dir), verifyFiles: true };
    intercept({}, writes => {
      assert.throws(() => VIDEO_COMMANDS["video-set-status"](spec), { message: "verifyFiles: unknown spec field" });
      assert.deepEqual(writes, []);
      assert.deepEqual(fs.readFileSync(data.manifestPath), data.manifestBytes);
    });
  });
});

test("non-enumerable verification on a write remains strict for another render", () => {
  withFixture(2, data => {
    const other = path.join(data.dir, data.renders[1].path);
    const spec = acceptance(data.dir);
    Object.defineProperty(spec, "verifyFiles", { value: true, enumerable: false });
    const fault = systemError("EIO", "open");
    let attempts = 0;
    intercept({ open(file) {
      if (file === other) { attempts++; throw fault; }
    } }, writes => {
      assert.deepEqual(VIDEO_COMMANDS["video-set-status"](spec), { ok: false, error: fault.message });
      assert.equal(attempts, 1);
      assert.deepEqual(writes, []);
      assert.deepEqual(fs.readFileSync(data.manifestPath), data.manifestBytes);
    });
  });
});

test("unrelated syscalls remain strict during video-check", () => {
  withFixture(2, data => {
    const first = path.join(data.dir, data.renders[0].path);
    const fault = systemError("EIO", "spawn");
    let attempts = 0;
    intercept({ open(file) {
      if (file === first) { attempts++; throw fault; }
    } }, writes => {
      assert.deepEqual(VIDEO_COMMANDS["video-check"]({ dir: data.dir, verifyFiles: true }),
        { ok: false, error: fault.message });
      assert.equal(attempts, 1);
      assert.deepEqual(writes, []);
      assert.deepEqual(fs.readFileSync(data.manifestPath), data.manifestBytes);
    });
  });
});

test("verification continues beyond the diagnostic limit", () => {
  withFixture(51, data => {
    const files = new Set(data.renders.map(render => path.join(data.dir, render.path)));
    const opened = [];
    intercept({ open(file) {
      if (files.has(file)) {
        opened.push(file);
        throw systemError("EIO", "open");
      }
    } }, writes => {
      const answer = VIDEO_COMMANDS["video-check"]({ dir: data.dir, verifyFiles: true });
      assert.equal(answer.ok, true);
      assert.deepEqual(answer.errors, []);
      assert.deepEqual(opened, data.renders.map(render => path.join(data.dir, render.path)));
      assert.deepEqual(answer.notReady, Array.from({ length: 50 }, (_, index) =>
        `manifest.renders[${index}].path: media file could not be verified`));
      assert.equal(answer.manifestSha256, sha(data.manifestBytes));
      assert.deepEqual(writes, []);
      assert.deepEqual(fs.readFileSync(data.manifestPath), data.manifestBytes);
    });
  });
});
