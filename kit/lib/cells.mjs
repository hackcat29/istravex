// The XDR cells each corpus fixture exercises, from kit/go/cmd/shape-scan.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { CORPUS, ROOT } from './fixture.mjs';

/** [{ fixture, cap_ids, cells }] for every fixture in the corpus. */
export function corpusCells(corpus = CORPUS) {
  const out = execFileSync('go', ['run', './cmd/shape-scan', '-corpus', corpus], {
    cwd: join(ROOT, 'kit', 'go'),
    encoding: 'utf8',
    maxBuffer: 256 << 20,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out);
}

/** Every cell a ledger reader can meet (reachable from LedgerCloseMeta), and every cell in the XDR. */
export function universe() {
  const out = execFileSync('go', ['run', './cmd/shape-scan', '-universe'], { cwd: join(ROOT, 'kit', 'go'), encoding: 'utf8' });
  return JSON.parse(out);
}
