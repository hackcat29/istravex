// Run the Java conformance runner (kit/runners/java/Run.java) against the
// corpus: fetch the pinned jars from Maven Central into .cache/java (each
// checked against its sha256 in jars.json), then run the single source file.
// Needs a JDK 17 or later.
//   node kit/runners/java/run.mjs        → corpus/results/java.json
//   node kit/runners/java/run.mjs sweep <passphrase> <ledger files...>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CORPUS, ROOT } from '../../lib/fixture.mjs';

const spec = JSON.parse(readFileSync(join(ROOT, 'kit', 'runners', 'java', 'jars.json'), 'utf8'));
const dir = join(ROOT, '.cache', 'java');
mkdirSync(dir, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const jars = [];
for (const { path, sha256 } of spec.jars) {
  const file = join(dir, basename(path));
  if (!existsSync(file) || sha(readFileSync(file)) !== sha256) {
    // Maven Central rate-limits CI runners now and then (HTTP 429): back off and retry.
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`https://repo1.maven.org/maven2/${path}`);
      if (res.ok || attempt === 5 || ![429, 500, 502, 503, 504].includes(res.status)) break;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (sha(bytes) !== sha256) throw new Error(`${path}: sha256 ${sha(bytes)}, pinned ${sha256}`);
    writeFileSync(file, bytes);
  }
  jars.push(file);
}
// `node kit/runners/java/run.mjs sweep <passphrase> <files...>` runs the sweep instead.
const args = process.argv.slice(2).length ? process.argv.slice(2) : [CORPUS];
execFileSync('java', [`-Distravex.sdkVersion=${spec.sdk_version}`, '-cp', jars.join(':'), join(ROOT, 'kit', 'runners', 'java', 'Run.java'), ...args], { stdio: 'inherit' });
