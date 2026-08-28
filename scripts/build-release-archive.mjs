import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createDeterministicZip } from "../tools/lib/zip.mjs";

function argumentsObject(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) if (argv[index].startsWith("--")) {
    const key = argv[index].slice(2), next = argv[index + 1];
    result[key] = next === undefined || next.startsWith("--") ? true : argv[++index];
  }
  return result;
}

const options = argumentsObject(process.argv.slice(2));
if (!options.root || !options.out) throw new Error("Usage: node scripts/build-release-archive.mjs --root <release-root> --out <zip> [--root-name Zodchi]");
const root = path.resolve(String(options.root)), output = path.resolve(String(options.out));
if (output === path.parse(output).root || output === root || output.startsWith(`${root}${path.sep}`)) throw new Error("RELEASE_ARCHIVE_PATH_INVALID");
if (fs.existsSync(output)) throw new Error(`RELEASE_ARCHIVE_EXISTS: ${output}`);
fs.mkdirSync(path.dirname(output), { recursive: true });
const archive = createDeterministicZip(root, { rootName: String(options["root-name"] ?? "Zodchi") });
const temporary = `${output}.tmp-${crypto.randomUUID()}`;
try {
  fs.writeFileSync(temporary, archive, { flag: "wx" });
  fs.renameSync(temporary, output);
} finally {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
}
process.stdout.write(`${JSON.stringify({ status: "built", output, bytes: archive.length, sha256: crypto.createHash("sha256").update(archive).digest("hex") })}\n`);
