import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { attestCSharpBuild, inspectUnityCSharpBoundary, runCSharpProvider } from "../src/csharp-provider.mjs";

const fakeProvider = fileURLToPath(new URL("./fixtures/fake-csharp-ls.mjs", import.meta.url));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-csharp-provider-")); fs.mkdirSync(path.join(root, "Assets"));
  fs.writeFileSync(path.join(root, "Assets", "Game.cs"), "public class Game { public int Value() => 1; }\n");
  fs.writeFileSync(path.join(root, "Game.csproj"), `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="Assets\\Game.cs" /></ItemGroup></Project>\n`);
  fs.writeFileSync(path.join(root, "Game.sln"), `Microsoft Visual Studio Solution File, Format Version 12.00\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Game", "Game.csproj", "{11111111-1111-1111-1111-111111111111}"\nEndProject\n`);
  execFileSync("git", ["init", "--quiet"], { cwd: root }); execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

test("Unity C# completeness is proven by an authoritative solution-to-source boundary", () => {
  const root = fixture();
  try {
    const solutionFile = path.join(root, "Game.sln"), buildEvidence = attestCSharpBuild({ solutionFile, command: [process.execPath, "-e", "process.exit(0)"] });
    const boundary = inspectUnityCSharpBoundary({ repoRoot: root, solutionFile, buildEvidence });
    assert.equal(boundary.completeness, "complete"); assert.equal(boundary.compiled_files, 1); assert.deepEqual(boundary.missing_files, []);
    fs.writeFileSync(path.join(root, "Assets", "Missing.cs"), "public class Missing {}\n"); execFileSync("git", ["add", "Assets/Missing.cs"], { cwd: root });
    const partial = inspectUnityCSharpBoundary({ repoRoot: root, solutionFile, buildEvidence });
    assert.equal(partial.completeness, "partial"); assert.deepEqual(partial.missing_files, ["Assets/Missing.cs"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("semantic anchors are observed but null caller hierarchy remains unknown", async () => {
  const root = fixture();
  try {
    const base = { repoRoot: root, solutionFile: path.join(root, "Game.sln"), providerCommand: [process.execPath, fakeProvider], buildCommand: [process.execPath, "-e", "process.exit(0)"] };
    const definition = await runCSharpProvider({ ...base, request: { type: "definitions", document: "Assets/Game.cs", line: 0, character: 17 } });
    assert.equal(definition.status, "observed"); assert.deepEqual(definition.anchors.map(item => item.path), ["Assets/Game.cs"]); assert.equal(definition.boundary.completeness, "complete");
    const callers = await runCSharpProvider({ ...base, request: { type: "callers", document: "Assets/Game.cs", line: 0, character: 17 } });
    assert.equal(callers.status, "unknown"); assert.equal(callers.reason, "caller_completeness_not_proven");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a missing Unity solution is unavailable and never falls back to lexical missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-csharp-unavailable-"));
  try {
    const result = await runCSharpProvider({ repoRoot: root, solutionFile: path.join(root, "Missing.sln"), providerCommand: [process.execPath, fakeProvider], request: { type: "definitions", document: "Missing.cs", line: 0, character: 0 } });
    assert.equal(result.status, "unavailable"); assert.equal(result.boundary.completeness, "unknown");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
