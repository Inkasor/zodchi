#!/usr/bin/env node
// A synthetic product for the incident-triage fixtures: `node product.mjs <command> [arg]`, run from a case folder.
// It answers from data/<command>[-<arg>].<ext> of that folder:
//   .txt      printed on stdout, exit 0
//   .refused  printed on stderr, exit 13 (a read the caller may not do)
//   .fail     printed on stderr, exit 2
//   .hang     never ends (the operation's time limit stops it)
// Anything else: "no such record" on stderr, exit 1.
import fs from 'node:fs'

const [cmd = '', arg = ''] = process.argv.slice(2)
if (!/^[a-z-]+$/.test(cmd) || (arg && !/^[A-Za-z0-9-]+$/.test(arg))) {
  process.stderr.write(`usage: product.mjs <command> [arg]; got ${JSON.stringify(process.argv.slice(2))}\n`)
  process.exit(64)
}
const base = `data/${cmd}${arg ? `-${arg}` : ''}`
const read = (ext) => fs.existsSync(base + ext) ? fs.readFileSync(base + ext, 'utf8') : null
let t
if ((t = read('.txt')) !== null) { process.stdout.write(t); process.exit(0) }
if ((t = read('.refused')) !== null) { process.stderr.write(t); process.exit(13) }
if ((t = read('.fail')) !== null) { process.stderr.write(t); process.exit(2) }
if (read('.hang') !== null) setInterval(() => {}, 1000)
else { process.stderr.write(`no such record: ${base}\n`); process.exit(1) }
