// Run the Java conformance runner (kit/runners/java/Run.java) against the
// corpus: fetch the pinned jars from Maven Central into .cache/java (each
// checked against its sha256 in jars.json), then run the single source file.
// Needs a JDK 17 or later.
//   node kit/runners/java/run.mjs        → corpus/results/java.json
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
    const res = await fetch(`https://repo1.maven.org/maven2/${path}`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (sha(bytes) !== sha256) throw new Error(`${path}: sha256 ${sha(bytes)}, pinned ${sha256}`);
    writeFileSync(file, bytes);
  }
  jars.push(file);
}
execFileSync('java', [`-Distravex.sdkVersion=${spec.sdk_version}`, '-cp', jars.join(':'), join(ROOT, 'kit', 'runners', 'java', 'Run.java'), CORPUS], { stdio: 'inherit' });
