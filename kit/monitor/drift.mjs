// Upstream drift: every pinned upstream against its newest release.
//
// Reads each pin from the file that sets it, asks the package registry (or
// GitHub) for the newest release, and prints one JSON line per dependency:
//   { "dep", "pinned", "latest", "newer", "where", "url" }
// .github/workflows/monitor.yml runs it weekly and opens one issue per newer
// release, with the checklist for moving the pin.
//
//   node kit/monitor/drift.mjs [--json]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/fixture.mjs';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));
const get = async (url, as = 'json') => {
  const headers = { 'user-agent': 'istravex-drift-monitor' };
  if (url.startsWith('https://api.github.com') && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return as === 'json' ? r.json() : r.text();
};
const ghLatest = async (repo) => (await get(`https://api.github.com/repos/${repo}/releases/latest`)).tag_name;
const req = (file, name) => read(file).match(new RegExp(`^${name}==(.+)$`, 'm'))[1].trim();

/** Numeric version compare; pre-releases sort before their release. */
function newer(latest, pinned) {
  const parse = (v) => {
    const [main, pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map(Number), pre };
  };
  const a = parse(latest);
  const b = parse(pinned);
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d) return d > 0;
  }
  if (a.pre && !b.pre) return false;
  if (!a.pre && b.pre) return true;
  return false;
}

const deps = [
  {
    dep: '@stellar/stellar-sdk',
    where: 'package.json',
    pinned: json('package.json').dependencies['@stellar/stellar-sdk'],
    latest: async () => (await get('https://registry.npmjs.org/@stellar/stellar-sdk/latest')).version,
    url: 'https://www.npmjs.com/package/@stellar/stellar-sdk',
  },
  {
    dep: 'go-stellar-sdk',
    where: 'kit/go/go.mod',
    pinned: read('kit/go/go.mod').match(/github\.com\/stellar\/go-stellar-sdk (v[\d.]+)/)[1],
    latest: async () => (await get('https://proxy.golang.org/github.com/stellar/go-stellar-sdk/@latest')).Version,
    url: 'https://pkg.go.dev/github.com/stellar/go-stellar-sdk',
  },
  {
    dep: 'stellar-xdr (Rust)',
    where: 'kit/runners/rust/Cargo.toml',
    pinned: read('kit/runners/rust/Cargo.toml').match(/stellar-xdr = \{ version = "=([\d.]+)"/)[1],
    latest: async () => (await get('https://crates.io/api/v1/crates/stellar-xdr')).crate.max_stable_version,
    url: 'https://crates.io/crates/stellar-xdr',
  },
  {
    dep: 'stellar-sdk (Python)',
    where: 'kit/runners/python/requirements.txt',
    pinned: req('kit/runners/python/requirements.txt', 'stellar-sdk'),
    latest: async () => (await get('https://pypi.org/pypi/stellar-sdk/json')).info.version,
    url: 'https://pypi.org/project/stellar-sdk/',
  },
  {
    dep: 'stellar-xdr (Python)',
    where: 'kit/runners/python/requirements.txt',
    pinned: req('kit/runners/python/requirements.txt', 'stellar-xdr'),
    latest: async () => (await get('https://pypi.org/pypi/stellar-xdr/json')).info.version,
    url: 'https://pypi.org/project/stellar-xdr/',
  },
  {
    dep: 'java-stellar-sdk',
    where: 'kit/runners/java/jars.json',
    pinned: json('kit/runners/java/jars.json').sdk_version,
    latest: async () => (await get('https://repo1.maven.org/maven2/network/lightsail/stellar-sdk/maven-metadata.xml', 'text')).match(/<release>([^<]+)<\/release>/)[1],
    url: 'https://central.sonatype.com/artifact/network.lightsail/stellar-sdk',
  },
  {
    dep: 'stellar-php-sdk',
    where: 'kit/runners/php/composer.json',
    pinned: json('kit/runners/php/composer.json').require['soneso/stellar-php-sdk'],
    latest: async () => ghLatest('Soneso/stellar-php-sdk'),
    url: 'https://github.com/Soneso/stellar-php-sdk/releases',
  },
  {
    dep: 'stellar-core',
    where: 'kit/capture/core-pin.json',
    pinned: json('kit/capture/core-pin.json').version,
    latest: async () => ghLatest('stellar/stellar-core'),
    url: 'https://github.com/stellar/stellar-core/releases',
  },
  {
    dep: 'stellar-etl',
    where: 'kit/pilot/stellar-etl/refs.json',
    pinned: json('kit/pilot/stellar-etl/refs.json').ref,
    latest: async () => ghLatest('stellar/stellar-etl'),
    url: 'https://github.com/stellar/stellar-etl/releases',
  },
];

const rows = [];
for (const d of deps) {
  let latest;
  try {
    latest = await d.latest();
  } catch (err) {
    rows.push({ dep: d.dep, pinned: d.pinned, latest: null, newer: false, where: d.where, url: d.url, error: String(err.message) });
    continue;
  }
  rows.push({ dep: d.dep, pinned: d.pinned, latest, newer: newer(latest, d.pinned), where: d.where, url: d.url });
}
// wallet-backend is pinned to a commit on main: report how far main has moved.
try {
  const { ref } = json('kit/pilot/wallet-backend/refs.json').current;
  const cmp = await get(`https://api.github.com/repos/stellar/wallet-backend/compare/${ref}...main`);
  rows.push({ dep: 'wallet-backend (main)', pinned: ref.slice(0, 7), latest: cmp.commits.at(-1)?.sha.slice(0, 7) ?? ref.slice(0, 7), newer: cmp.ahead_by > 0, ahead_by: cmp.ahead_by, where: 'kit/pilot/wallet-backend/refs.json', url: 'https://github.com/stellar/wallet-backend/commits/main' });
} catch (err) {
  rows.push({ dep: 'wallet-backend (main)', error: String(err.message) });
}
for (const r of rows) console.log(JSON.stringify(r));
