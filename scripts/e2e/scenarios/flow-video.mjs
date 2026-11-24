import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export default function register({ scenario, world, zodchi, ROOT, scratch }) {
  const write = (file, value) => {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
    return file;
  };
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  let tool;
  function create(t, name) {
    const w = world(name);
    const dir = path.join(w.dir, "Video with spaces");
    fs.mkdirSync(dir);
    if (!tool) {
      tool = path.join(scratch, process.platform === "win32" ? "video-fixture.exe" : "video-fixture");
      const result = spawnSync("rustc", ["--edition=2021", path.join(ROOT, "scripts/e2e/fixtures/video-tool.rs"), "-o", tool],
        { windowsHide: true, encoding: "utf8" });
      t.eq([result.status, result.error?.message ?? result.stderr], [0, ""], "build the media fixture");
    }
    const trace = path.join(w.dir, "video.log");
    w.env.ZODCHI_FIXTURE_VIDEO_TRACE = trace;
    const frame = path.join(dir, "frame.png");
    fs.writeFileSync(frame, Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63e8a908f80f00053c02545f6c61f20000000049454e44ae426082", "hex"));
    w.env.ZODCHI_FIXTURE_VIDEO_FRAME = frame;
    const source = path.join(dir, "source.mp4");
    fs.writeFileSync(source, "fixture MP4");
    const edit = {
      proposed: { title: "An opening", description: "", prompt: "Make a short.", voiceText: "" },
      sources: [{ id: "screen", kind: "screen", path: source, sha256: null, note: "" }],
      segments: [{ id: "take", source: "screen", in: 0.0, out: 1.0, speed: 1.0, speedMarked: false,
        reason: "Show the result.", evidence: "A saved receipt.", model: "", effort: "" }],
      audio: [], costs: [], claims: [],
    };
    for (const file of ["brief.md", "scenario.md"]) fs.writeFileSync(path.join(dir, file), "Show how the field is filled.");
    const render = { program: tool, args: ["render", "{out}"] };
    const spec = { dir, id: "short", format: "short", title: "An opening", ffmpeg: tool, ffprobe: tool };
    const args = (extra) => write(path.join(w.dir, "args.json"), { ...spec, ...extra });
    const plan = { brief: "brief.md", variants: [{ id: "one", scenario: "scenario.md", edit, probe: render, final: render }] };
    const run = (argv, extra = {}) => zodchi(t, w, ["flow", ...argv], { cwd: w.home, env: { ...w.env, ...extra } });
    const file = (payload) => write(path.join(w.dir, "owner.json"), payload);
    const reply = (id, payload) => run(["reply", id, "--file", file(payload)]);
    const calls = () => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split(/\r?\n/) : [];
    const restart = (id) => run(["video", "--resume", id]);
    return { w, dir, source, frame, edit, args, plan, run, file, reply, calls, restart };
  }

  function accept(artifact, ownerWords) {
    return { decision: "accept", render: artifact.render, sha256: artifact.sha256, ownerWords };
  }

  scenario("flow-video-resume", "choose a scenario, recover after rendering, approve exact media and capture publication statistics", async t => {
    const v = create(t, "flow-video-resume");
    const listed = await v.run(["list"]);
    t.ok(listed.json.workflows.some(x => x.name === "video" && x.version === "1"), "catalog discovers the native workflow");
    const input = v.args(v.plan);
    const start = await v.run(["video", "--args", input]);
    const id = start.json?.runId;
    t.eq([start.code, start.json?.status, start.json?.video?.decision?.stage], [2, "waiting", "script"], "wait for the scenario");
    t.eq((await v.run(["status", id])).json?.video?.decision?.variants[0].id, "one", "a new CLI sees the scenario");
    t.eq((await v.reply(id, { decision: "choose", variant: "missing", ownerWords: "Use that one." })).code, 1, "refuse unknown variant");
    t.eq((await v.reply(id, { decision: "choose", variant: "one", ownerWords: "Use the first." })).code, 0, "record scenario");
    t.eq((await v.run(["video", "--resume", id], { ZODCHI_FLOW_CUT: "video probe exited" })).code, 75, "interrupt after a durable renderer exit");
    const probed = await v.restart(id);
    const probe = probed.json?.video?.decision?.artifact;
    t.eq([probed.code, probe?.render, probe?.decodeExit, v.calls().filter(x => x === "render").length], [2, "r1", 0, 1], "reuse the exact probe");
    t.eq((await v.reply(id, { ...accept(probe, "Use it."), sha256: "wrong" })).code, 1, "refuse a different probe digest");
    t.eq((await v.reply(id, accept(probe, "The probe works."))).code, 0, "accept exact probe");
    const done = await v.restart(id);
    const artifact = done.json.video.decision.artifact;
    t.eq([done.code, artifact.render, artifact.ffprobeExit, v.calls().filter(x => x === "render").length], [2, "r2", 0, 2], "render and verify one final");
    const length = v.calls().length;
    t.eq((await v.restart(id)).json.video.decision.artifact, artifact, "resume identifies the same artifact");
    t.eq(v.calls().length, length, "completed tool steps were not repeated");
    const publication = { render: artifact.render, sha256: artifact.sha256, publicationId: "clip-one",
      publishedAt: "2026-02-01T00:00:00Z", ownerWords: "I published this export." };
    t.eq((await v.run(["video", "publish", id, "--file", v.file(publication)])).code, 1, "publication requires the final decision");
    fs.appendFileSync(artifact.path, "tampered");
    t.eq((await v.reply(id, accept(artifact, "The final is ready."))).code, 1, "an altered MP4 cannot be accepted");
    fs.writeFileSync(artifact.path, "fixture MP4");
    t.eq((await v.reply(id, accept(artifact, "The final is ready."))).code, 0, "record exact final approval");
    t.eq((await v.restart(id)).json.verdict, "approved", "finish after the decision");
    t.eq((await v.run(["video", "publish", id, "--file", v.file(publication)])).json.publication.id, "clip-one", "record a separate publication receipt");
    const snapshot = { publicationId: "clip-one", capturedAt: "2026-02-02T00:00:00Z", views: 10000, stayedToWatchPercent: 67,
      retention: [{ second: 0, percent: 115 }, { second: 0.5, percent: 81 }] };
    const stats = await v.run(["video", "stats", id, "--file", v.file(snapshot)]);
    t.eq([stats.json.sample.elapsedSeconds, stats.json.sample.targetReached], [86400, true], "record actual age and target");
    t.eq((await v.run(["status", id])).json.video.latestStats.views, 10000, "another chat sees the last snapshot");
    const legacy = spawnSync(process.execPath, [path.join(ROOT, "scripts/e2e/fixtures/video-manifest-v1.mjs"), "video-check",
      JSON.stringify({ api: 1, dir: v.dir, verifyFiles: true })], { encoding: "utf8", windowsHide: true });
    const old = JSON.parse(legacy.stdout);
    t.eq([old.status, old.chosen, old.errors], ["published", "r2", []], "the manifest remains readable by the version-one helper");

    const second = path.join(v.w.dir, "Second video");
    fs.mkdirSync(second);
    const secondStart = await v.run(["video", "--args", v.args({ dir: second, id: "second", priorRuns: [id],
      adopt: { file: v.source, edit: v.edit } })]);
    const secondId = secondStart.json.runId;
    const copied = secondStart.json.video.decision.artifact;
    t.eq(copied.sha256, artifact.sha256, "adopt the existing file's bytes");
    await v.reply(secondId, accept(copied, "Use this cut."));
    const secondResult = (await v.restart(secondId)).json;
    t.eq(read(secondResult.priorStats)[0].samples[0].views, 10000, "freeze earlier evidence for the next brief");
    await v.run(["video", "publish", secondId, "--file", v.file({ ...publication, render: copied.render, publicationId: "clip-two" })]);
    const secondStats = await v.run(["video", "stats", secondId, "--file", v.file({ ...snapshot, views: 4000, publicationId: "clip-two" })]);
    t.eq(secondStats.json.comparisons[0].sample.views, 10000, "compare with the earlier video at the same elapsed age");
    t.eq(v.calls().filter(x => x === "render").length, 2, "adoption performs no render");
  });

  scenario("flow-youtube-publish-entry", "pin an accepted video for a private upload and require its exact approval", async t => {
    const v = create(t, "flow-youtube-publish-entry");
    const entries = await v.run(["list"]);
    t.ok(entries.json.workflows.some(entry => entry.name === "youtube-publish" && entry.domain === "video"), "the CLI exposes the publication workflow");
    const video = await v.run(["video", "--args", v.args({ adopt: { file: v.source, edit: v.edit } })]);
    const videoId = video.json.runId;
    const artifact = video.json.video.decision.artifact;
    const params = { videoRun: videoId, profile: "personal", channelId: "UC0000000000000000000000",
      title: "Private fixture", description: "A short description.", categoryId: "22", selfDeclaredMadeForKids: false };
    const start = (args = params) => v.run(["youtube-publish", "--args", v.file(args)]);
    t.eq((await start()).code, 2, "a video awaiting owner acceptance cannot enter publication");
    t.eq((await v.reply(videoId, accept(artifact, "Accept the MP4 for the fixture."))).code, 0, "accept the exact source");
    t.eq((await v.restart(videoId)).json.verdict, "approved", "use the accepted video result");
    t.eq((await start({ ...params, privacyStatus: "public" })).code, 2, "reject a public visibility argument");
    const pending = await start();
    const id = pending.json.runId;
    const shown = pending.json.youtube;
    t.eq([pending.code, pending.json.status, shown.plan.artifact.sha256, shown.plan.metadata.status.privacyStatus],
      [2, "waiting", artifact.sha256, "private"], "pin the accepted bytes and show private visibility before connecting");
    t.eq((await v.run(["status", id, "--handoff"])).json.youtube.planSha256, shown.planSha256, "another chat receives the same plan");
    const answer = { decision: "reject", planSha256: shown.planSha256, ownerWords: "Skip this fixture." };
    t.eq((await v.reply(id, { ...answer, planSha256: "wrong" })).code, 1, "refuse a reply for a different plan");
    t.eq((await v.reply(id, answer)).code, 0, "record the decision in the shared journal");
    const finished = await v.run(["youtube-publish", "--resume", id]);
    t.eq([finished.code, finished.json.runId, finished.json.verdict], [2, id, "cancelled"], "resume the same run without contacting YouTube");
  });

  scenario("flow-video-fable", "use the shared gateway for one-off Claude text and exact frames, without an implicit replacement", async t => {
    const v = create(t, "flow-video-fable");
    const fake = path.join(v.w.dir, "claude-fixture");
    fs.mkdirSync(path.join(fake, "answers"), { recursive: true });
    fs.writeFileSync(path.join(fake, "fake-auth.json"), "{}");
    fs.writeFileSync(path.join(fake, "answers", "look.json"), "Shown in the frame.");
    v.w.env.FAKE_CLAUDE_HOME = fake;
    v.w.env.ZODCHI_CLAUDE_BIN = path.join(ROOT, "scripts/e2e/fake-claude.mjs");
    v.w.env.ANTHROPIC_API_KEY = "fixture-only";
    fs.writeFileSync(path.join(v.dir, "look.md"), "Step: look (video)\nDescribe the frame.");
    const options = v.args({ adopt: { file: v.source, edit: v.edit }, experts: [{
      stage: "final", role: "ask", provider: "claude", model: "claude-fable-5-2", effort: "high", prompt: "look.md", frames: [0.25]
    }] });
    const unavailable = await v.run(["video", "--args", options]);
    const id = unavailable.json.runId;
    t.eq([unavailable.json.video.decision.stage, unavailable.json.video.decision.model], ["expert", "claude-fable-5-2"], "wait on disabled provider");
    t.ok(!fs.existsSync(path.join(fake, "calls.jsonl")), "disabled Claude sends no request");
    fs.writeFileSync(path.join(v.w.zhome, "flow.json"), '{"claudeExperts":true}');
    await v.reply(id, { decision: "replace", provider: "claude", model: "claude-fable-5-2", effort: "high", ownerWords: "Retry Fable." });
    const staged = await v.restart(id);
    const detail = staged.json.video.decision;
    t.eq([detail.stage, detail.experts[0].actualModels, read(detail.experts[0].answer).text], ["final", ["claude-fable-5-2"], "Shown in the frame."], "journal records the model and its answer");
    const logs = () => fs.readFileSync(path.join(fake, "calls.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse).filter(x => x.kind === "call");
    t.eq([logs().length, logs()[0].apiKey, logs()[0].images[0][0]], [1, false, "image/png"], "one subscription call receives the actual frame");
    t.ok(logs()[0].args.includes("--no-session-persistence"), "Claude invocation is ephemeral");
    const same = await v.restart(id);
    t.eq(same.json?.video?.decision?.artifact, detail.artifact, "reattach while the final decision is pending");
    t.eq(logs().length, 1, "resume spent no second model call");

    const gateway = (argv) => zodchi(t, v.w, [...argv, "--context", v.dir], { cwd: v.w.home });
    const args = ["--provider", "claude", "--model", "haiku", "--role", "ask",
      "--prompt", path.join(v.dir, "look.md"), "--image", v.frame, "--key", "oneoff-haiku"];
    t.eq((await gateway(["submit", ...args])).code, 0, "plain submit works outside Git");
    const job = (await gateway(["wait", "--key", "oneoff-haiku", "--wait-sec", "30"])).json.job;
    t.eq([job.status, job.provider, job.keepThread, job.threadId], ["succeeded", "claude", false, null], "ordinary wait holds an ephemeral Claude receipt");
    t.eq((await gateway(["submit", ...args])).json.created, false, "same key reattaches");
    t.eq(logs().length, 2, "two distinct expert jobs called the model once each");
    const haiku = logs()[1];
    t.eq(haiku.model, "haiku", "the direct job uses its requested model");
    t.eq(read(haiku.args[haiku.args.indexOf("--settings") + 1]), { disableAllHooks: true },
      "the gateway expert leaves the Haiku auto-compaction window to Claude Code");
  });

  scenario("flow-video-research", "replay searches, merge a follow-up capture and extend reviewed coverage without a fetch", async t => {
    const v = create(t, "flow-video-research");
    const a = "A1234567890", b = "B1234567890", c = "C1234567890";
    const query = (name, ids) => ({ query: name, url: "https://www.youtube.com/results", cards: ids.map(id => ({ id })) });
    const detail = (id, views) => ({ id, title: "Fixture", views, error: null });
    write(path.join(v.dir, "youtube-search.json"), { captured: "2026-02-01T01:00:00+01:00",
      searches: [query("first", [a, a, c]), { ...query("second", []), error: "collector temporarily unavailable" }] });
    write(path.join(v.dir, "youtube-watch.json"), [detail(a, "10000")]);
    write(path.join(v.dir, "follow-up.json"), { queries: [query("third", [a, b])], watch: [detail(b, "15000")] });
    const input = v.file({ dir: v.dir, supplements: ["follow-up.json"], reviews: [{ id: a, basis: "storyboard", evidence: "brief.md" }] });
    const first = await v.run(["video", "research", "--args", input]);
    t.eq(first.json.coverage, { queries: 3, failedQueries: 1, candidates: 3, verified: 2, reviewed: 1, viewsUnconfirmed: 1, pending: 1 }, "preserve scope and distinguish failed query");
    t.eq(first.json.pending, [b], "resume knows the exact pending card");
    const adopted = await v.run(["video", "--args", v.args({ research: first.json.file, adopt: { file: v.source, edit: v.edit } })]);
    v.file({ dir: v.dir, supplements: ["follow-up.json"], reviews: [{ id: b, basis: "video-and-audio", evidence: "scenario.md" }] });
    const next = await v.run(["video", "research", "--args", input]);
    t.eq([next.json.coverage.reviewed, next.json.pending], [2, []], "merge new evidence with the earlier review");
    const resumed = await v.restart(adopted.json.runId);
    t.eq([resumed.json.video.research.coverage.reviewed, resumed.json.video.decision.stage], [1, "final"],
      "an active video retains its report even as the next researcher records more coverage");
  });
}
