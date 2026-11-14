// Fetch stellar-core's golden LedgerCloseMeta (test-lcm-current/, the data its
// CI checks with `stellar-core test --check-lcm`) at the pinned core commit.
// Sparse, shallow checkout into .cache/stellar-core (~75 MB).
//   node kit/goldens/fetch.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/fixture.mjs';

export const REPO = 'https://github.com/stellar/stellar-core';
export const COMMIT = JSON.parse(readFileSync(join(ROOT, 'kit', 'capture', 'core-pin.json'), 'utf8')).commit;
export const DIR = join(ROOT, '.cache', 'stellar-core');
export const GOLDENS = join(DIR, 'test-lcm-current');

export function fetchGoldens() {
  const git = (args) => execFileSync('git', args, { cwd: DIR, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (!existsSync(join(DIR, '.git'))) {
    mkdirSync(DIR, { recursive: true });
    git(['init', '-q']);
    git(['remote', 'add', 'origin', REPO]);
    git(['sparse-checkout', 'set', '--no-cone', '/test-lcm-current/']);
  }
  const head = existsSync(GOLDENS) ? git(['rev-parse', 'HEAD']).trim() : '';
  if (head !== COMMIT) {
    git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', COMMIT]);
    git(['checkout', '-q', '--force', COMMIT]);
  }
  return GOLDENS;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(fetchGoldens());
