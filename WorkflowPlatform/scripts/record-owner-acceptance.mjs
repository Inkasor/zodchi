import fs from "node:fs";
import path from "node:path";
import { recordOwnerAcceptance } from "../src/owner-acceptance.mjs";

function argsObject(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) if (argv[index].startsWith("--")) {
    const key = argv[index].slice(2), next = argv[index + 1];
    result[key] = next === undefined || next.startsWith("--") ? true : argv[++index];
  }
  return result;
}

const args = argsObject(process.argv.slice(2));
if (!args.db || !args.record) throw new Error("Usage: node scripts/record-owner-acceptance.mjs --db <workflow.sqlite> --record <owner-record.json>");
const record = JSON.parse(fs.readFileSync(path.resolve(String(args.record)), "utf8"));
process.stdout.write(`${JSON.stringify(recordOwnerAcceptance(path.resolve(String(args.db)), record), null, 2)}\n`);
