import fs from 'node:fs';
import path from 'node:path';

export default function ({ scenario, world, repo, zodchi }) {
  const name = 'gateway-wait-keys-first-missing';
  scenario(name, 'reports the first missing wait key in argument order', async t => {
    const w = world(name);
    const cwd = await repo(t, w);
    const list = path.join(cwd, 'wait-keys-order.json');
    fs.writeFileSync(list, JSON.stringify({ jobs: [{ key: 'present' }] }));

    const cases = [
      { mode: '--any', keys: 'present,missing1,missing2,missing3', missing: 'missing1' },
      { mode: '--all', keys: 'missing3,present,missing2,missing1', missing: 'missing3' },
    ];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      for (const test of cases) {
        const result = await zodchi(t, w, [
          'wait', test.mode, '--list', list, '--keys', test.keys,
        ], { cwd });
        t.eq(result.code, 1, `${test.mode} attempt ${attempt + 1} exits 1`);
        t.ok(
          result.err.includes(`${list}: no entry for '${test.missing}'`),
          `${test.mode} attempt ${attempt + 1} reports ${test.missing}: ${result.err}`,
        );
      }
    }
  });
}
