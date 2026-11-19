import { motion, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { corpus, kit, lintFindings, lintRules, pilotRef, type Verdict } from '../content';
import { Arrow, Reveal, Title, VerdictMark } from '../components/ui';

const ease = [0.16, 1, 0.3, 1] as const;

export function Kit() {
  const [corpus, replay, runner, linter, pilot] = kit.parts;
  return (
    <section id="kit" className="relative border-t border-line py-28 sm:py-36">
      <div className="wrap">
        <Title lines={kit.title} />
        <div className="mt-14 grid grid-cols-1 gap-3 sm:mt-20 md:grid-cols-6">
          <Card part={corpus} className="md:col-span-3" delay={0}>
            <CorpusVisual />
          </Card>
          <Card part={replay} className="md:col-span-3" delay={0.06}>
            <ReplayVisual />
          </Card>
          <Card part={runner} className="md:col-span-2" delay={0}>
            <RunnerVisual />
          </Card>
          <Card part={linter} className="md:col-span-2" delay={0.06}>
            <LintVisual />
          </Card>
          <Card part={pilot} className="md:col-span-2" delay={0.12} tall>
            <PilotVisual />
          </Card>
        </div>
      </div>
    </section>
  );
}

function Card({
  part,
  className = '',
  delay,
  tall = false,
  children,
}: {
  part: (typeof kit.parts)[number];
  className?: string;
  delay: number;
  tall?: boolean;
  children: ReactNode;
}) {
  return (
    <Reveal delay={delay} className={className}>
      <article
        id={`kit-${part.id}`}
        className="card group flex h-full flex-col overflow-hidden transition-colors duration-500 hover:border-line-2"
      >
        <div className={`relative flex-1 border-b border-line bg-ink ${tall ? 'min-h-[372px] sm:min-h-[356px]' : 'min-h-[330px] sm:min-h-[300px]'}`}>{children}</div>
        <div className="flex gap-5 p-6 sm:p-7">
          <span className="font-mono text-[13px] text-dim">{part.n}</span>
          <div>
            <h3 className="text-[20px] font-medium tracking-tight">{part.title}</h3>
            <p className="mt-2 max-w-[52ch] text-[15px] leading-relaxed text-mute">{part.body}</p>
            <a
              href={part.docs}
              className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-medium text-fg transition-colors hover:text-lime"
            >
              Docs <Arrow className="size-3.5" />
            </a>
          </div>
        </div>
      </article>
    </Reveal>
  );
}

/* ── 01 Corpus: the CAP audit. One cell per XDR-changing live CAP ────── */
const xdrCaps = corpus.coverage.xdr_caps;
const sample = corpus.fixtures.find((f) => f.pattern === 'muxed-payment')!.manifest;
const manifestLines: [string, string][] = [
  ['id', `"${sample.id}"`],
  ['cap_ids', JSON.stringify(sample.cap_ids)],
  ['protocol_version', String(sample.protocol_version)],
  ['sha256', `"${sample.sha256.slice(0, 16)}…"`],
];

function CorpusVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-15% 0px' });
  const reduce = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);
  const h = hover !== null ? xdrCaps[hover] : null;
  const coveredCount = xdrCaps.filter((c) => c.covered).length;

  return (
    <div ref={ref} className="absolute inset-0 flex flex-col justify-between p-6 sm:p-7">
      <div>
        <div className="grid grid-cols-[repeat(20,minmax(0,1fr))] gap-[3px]" role="list" aria-label={`${coveredCount} of ${xdrCaps.length} XDR-changing CAPs have fixtures`}>
          {xdrCaps.map((c, i) => (
            <motion.button
              key={c.cap}
              type="button"
              role="listitem"
              aria-label={`${c.cap} ${c.title}: ${c.covered ? 'covered' : 'gap'}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              initial={reduce ? false : { opacity: 0, scale: 0.4 }}
              animate={inView ? { opacity: 1, scale: 1 } : undefined}
              transition={{ delay: 0.15 + i * 0.015, duration: 0.4, ease }}
              className={`aspect-square rounded-[2px] border transition-colors ${c.covered ? 'border-lime bg-lime' : hover === i ? 'border-fg bg-ink-3' : 'border-line bg-ink-2'}`}
            />
          ))}
        </div>
        <p className="mt-3 h-4 truncate font-mono text-[11.5px] text-mute">
          {h ? (
            <>
              <span className={h.covered ? 'text-lime' : 'text-fg'}>{h.cap}</span> · {h.title}
            </>
          ) : (
            <>
              <span className="text-lime">{coveredCount}</span>/{xdrCaps.length} XDR-changing CAPs
            </>
          )}
        </p>
      </div>
      <pre className="mt-5 overflow-hidden font-mono text-[11.5px] leading-[1.85] sm:text-[12.5px]">
        <span className="text-dim">{'{'}</span>
        {manifestLines.map(([k, v], i) => (
          <motion.div
            key={k}
            initial={reduce ? false : { opacity: 0, x: -8 }}
            animate={inView ? { opacity: 1, x: 0 } : undefined}
            transition={{ delay: 0.3 + i * 0.1, duration: 0.6, ease }}
            className="truncate pl-4"
          >
            <span className="text-mute">"{k}"</span>
            <span className="text-dim">: </span>
            <span className={/^\d+$/.test(v) ? 'text-lime' : 'text-fg'}>{v}</span>
          </motion.div>
        ))}
        <span className="text-dim">{'}'}</span>
      </pre>
    </div>
  );
}

/* ── 02 Replay: ledgers pass through stages and resolve to verdicts ─────── */
const stages = ['getLedgers', 'adapter', 'compare'];
const replayRows = corpus.replay;

function ReplayVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-15% 0px' });
  const reduce = useReducedMotion();
  const [tick, setTick] = useState(reduce ? replayRows.length - 1 : 0);
  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => setTick((t) => t + 1), 1100);
    return () => clearInterval(id);
  }, [inView, reduce]);
  const log = Array.from({ length: 4 }, (_, i) => {
    const n = tick - i;
    if (n < 0) return null;
    const r = replayRows[n % replayRows.length];
    return { key: n, ledger: r.ledger, indexer: r.indexer, cap: r.cap, v: r.verdict as Verdict };
  }).filter(Boolean) as { key: number; ledger: number; indexer: string; cap: string; v: Verdict }[];

  return (
    <div ref={ref} className="absolute inset-0 flex flex-col justify-between gap-6 p-6 sm:p-7">
      <div className="relative grid grid-cols-3 gap-2">
        {stages.map((s, i) => (
          <div
            key={s}
            className={`relative rounded-lg border px-2 py-3 text-center font-mono text-[11px] transition-colors duration-300 sm:text-[12px] ${tick % 3 === i && inView && !reduce ? 'border-fg text-fg' : 'border-line text-mute'}`}
          >
            {s}
          </div>
        ))}
      </div>
      <ul className="space-y-1.5 font-mono text-[12px] sm:text-[13px]">
        {log.map((r, i) => (
          <motion.li
            key={r.key}
            layout
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1 - i * 0.17, y: 0 }}
            transition={{ duration: 0.45, ease }}
            className="flex items-center justify-between rounded-md border border-line bg-ink-2 px-3 py-2"
          >
            <span className="truncate text-mute">
              <span className="text-fg">{r.indexer}</span> · L{r.ledger.toLocaleString('en-US')}
            </span>
            <span className="flex items-center gap-2">
              <VerdictMark v={r.v} />
              <span className={r.v === 'incorrect' ? 'text-coral' : r.v === 'dropped' ? 'text-mute' : 'text-fg'}>{r.v}</span>
            </span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

/* ── 03 Runner: real SDK × check results; hover/tap any cell ─────────── */
const checkKeys = ['decode', 'reencode', 'native'] as const;
const checkLabel = { decode: 'decode', reencode: 're-encode', native: 'native' };
const sdkLabel: Record<string, string> = { javascript: 'JS', go: 'Go', rust: 'Rust', python: 'Py', 'python-xdr': 'PyX', java: 'Java', php: 'PHP' };
const pkgShort = (p: string) => p.split('/').pop()!;
const cells = checkKeys.flatMap((c) =>
  corpus.sdks.map((s) => {
    // 'n/a': re-encoding bytes a decoder must refuse doesn't apply.
    const applicable = s.results.filter((r) => (r.checks as Record<string, string>)[c] !== 'n/a');
    const pass = applicable.filter((r) => (r.checks as Record<string, string>)[c] === 'pass').length;
    return { check: c, sdk: s, pass, total: applicable.length };
  }),
);

function RunnerVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-15% 0px' });
  const reduce = useReducedMotion();
  const total = cells.length;
  const [sweep, setSweep] = useState(reduce ? total : 0);
  const [focus, setFocus] = useState<number | null>(null);
  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => setSweep((s) => (s > total + 6 ? 0 : s + 1)), 380);
    return () => clearInterval(id);
  }, [inView, reduce, total]);
  const shown = focus ?? Math.min(sweep, total) - 1;
  const cell = shown >= 0 ? cells[shown] : null;

  return (
    <div ref={ref} className="absolute inset-0 flex flex-col justify-between p-6 sm:p-7">
      <div className="grid gap-1.5 font-mono text-[11px]" style={{ gridTemplateColumns: `58px repeat(${corpus.sdks.length}, minmax(0, 1fr))` }}>
        <span />
        {corpus.sdks.map((s) => (
          <span key={s.sdk} className="pb-1 text-center text-mute">{sdkLabel[s.sdk]}</span>
        ))}
        {checkKeys.map((c, row) => (
          <Row key={c} label={checkLabel[c]}>
            {corpus.sdks.map((s, col) => {
              const i = row * corpus.sdks.length + col;
              const x = cells[i];
              const ok = x.pass === x.total;
              const done = i < sweep;
              return (
                <button
                  key={s.sdk}
                  type="button"
                  aria-label={`${s.package} ${s.version} ${checkLabel[c]}: ${x.pass} of ${x.total} fixtures pass`}
                  onMouseEnter={() => setFocus(i)}
                  onMouseLeave={() => setFocus(null)}
                  onFocus={() => setFocus(i)}
                  onBlur={() => setFocus(null)}
                  onClick={() => setFocus(i)}
                  className={`grid aspect-[1.35] place-items-center rounded-md border text-[10.5px] tabular-nums transition-all duration-300 ${focus === i ? 'border-fg bg-fg text-ink' : done ? (ok ? 'border-lime bg-lime text-ink' : 'border-coral bg-coral text-ink') : 'border-line bg-ink-2 text-transparent'}`}
                >
                  {x.total ? x.pass : '–'}
                </button>
              );
            })}
          </Row>
        ))}
      </div>
      <p className="mt-5 h-5 truncate font-mono text-[12px] text-mute">
        {cell && (
          <>
            <span className="text-fg">{pkgShort(cell.sdk.package)}</span> {cell.sdk.version} · {checkLabel[cell.check]} · <span className={cell.pass === cell.total ? 'text-lime' : 'text-coral'}>{cell.pass}/{cell.total}</span>
          </>
        )}
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="self-center text-mute">{label}</span>
      {children}
    </>
  );
}

/* ── 04 Linter: the real finding in wallet-backend, at its real line ─── */
function LintVisual() {
  const [rule, setRule] = useState<number | null>(null);
  const f = lintFindings[0];
  const counts = lintRules.map((r) => lintFindings.filter((x) => x.rule === r.id).length);
  return (
    <div className="absolute inset-0 flex flex-col justify-between p-5 sm:p-6">
      {f ? (
        <pre className="overflow-hidden font-mono text-[10.5px] leading-[1.75] sm:text-[11px]">
          {f.snippet.lines.map((line, i) => {
            const n = f.snippet.from + i;
            const hot = n === f.line;
            return (
              <div key={n} className={`flex gap-3 transition-opacity duration-300 ${rule !== null && lintRules[rule].id !== f.rule ? 'opacity-35' : ''}`}>
                <span className="w-5 shrink-0 text-right text-dim">{n}</span>
                <span className={`whitespace-pre ${hot ? 'text-fg underline decoration-coral decoration-wavy underline-offset-4' : 'text-mute'}`}>{line.replace(/\t/g, '  ')}</span>
              </div>
            );
          })}
        </pre>
      ) : (
        <p className="font-mono text-[12px] text-mute">No findings.</p>
      )}
      <div>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {lintRules.map((lr, i) => (
            <button
              key={lr.id}
              type="button"
              onMouseEnter={() => setRule(i)}
              onMouseLeave={() => setRule(null)}
              onFocus={() => setRule(i)}
              onBlur={() => setRule(null)}
              onClick={() => setRule((cur) => (cur === i ? null : i))}
              aria-pressed={rule === i}
              className={`rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${rule === i ? 'border-coral bg-coral text-ink' : counts[i] ? 'border-line-2 text-fg' : 'border-line text-dim hover:text-fg'}`}
            >
              {lr.id} · {counts[i]}
            </button>
          ))}
        </div>
        <p className="mt-2 h-4 truncate font-mono text-[11px] text-mute">
          {rule !== null ? (
            lintRules[rule].label
          ) : f ? (
            <a href={f.url} target="_blank" rel="noreferrer" className="hover:text-fg">
              {f.file.split('/').pop()}:{f.line} · {f.status} ↗
            </a>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/* ── 05 Pilots: three SDF indexers' scores; wallet-backend per pattern ── */
const pilotResults = corpus.pilot.results;
const handWritten = pilotResults.filter((x) => x.pattern !== 'tx');
const setCover = pilotResults.filter((x) => x.pattern === 'tx');
const pilotScores = [
  ['wallet-backend', corpus.stats.pilot_correct, corpus.stats.pilot_fixtures],
  ['Horizon', corpus.stats.horizon_correct, corpus.stats.horizon_fixtures],
  ['stellar-etl', corpus.stats.etl_correct, corpus.stats.etl_fixtures],
] as const;
const patternName: Record<string, string> = {
  'fee-bump': 'Fee-bump',
  'muxed-payment': 'Muxed ID',
  'muxed-max-id': 'Max muxed',
  'muxed-soroban-source': 'Muxed src',
  'signed-payload-signer': 'Signer',
  'sac-trust': 'SAC trust',
  'max-amount': 'Max amount',
};
const netTag: Record<string, string> = { pubnet: 'main', testnet: 'test', local: 'core' };

function PilotVisual() {
  const [pick, setPick] = useState(0);
  const r = handWritten[pick];
  const setCoverOk = setCover.filter((x) => x.verdict === 'correct').length;
  return (
    <div className="absolute inset-0 flex flex-col justify-between gap-3 p-5 sm:p-6">
      <div className="grid grid-cols-3 gap-1.5 font-mono text-[10.5px]">
        {pilotScores.map(([name, ok, n]) => (
          <div key={name} className="rounded-lg border border-line px-2 py-1.5">
            <div className="truncate text-mute">{name}</div>
            <div className={`tabular-nums ${ok === n ? 'text-lime' : 'text-amber'}`}>{ok}/{n}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {handWritten.map((x, i) => (
          <button
            key={x.fixture}
            type="button"
            onClick={() => setPick(i)}
            onMouseEnter={() => setPick(i)}
            aria-pressed={pick === i}
            className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-left font-mono text-[10.5px] transition-colors ${pick === i ? 'border-fg text-fg' : 'border-line text-mute hover:text-fg'}`}
          >
            <VerdictMark v={x.verdict as Verdict} />
            <span className="truncate">
              {patternName[x.pattern] ?? x.pattern} <span className="text-dim">{netTag[x.network] ?? x.network}</span>
            </span>
          </button>
        ))}
        <div className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5 font-mono text-[10.5px] text-mute">
          <VerdictMark v={setCoverOk === setCover.length ? 'correct' : 'incorrect'} />
          <span className="truncate">+{setCover.length} tx <span className="text-dim">{setCoverOk === setCover.length ? 'all' : setCoverOk}</span></span>
        </div>
      </div>
      <div className="font-mono text-[10.5px]">
        <p className="truncate text-mute" title={r.checks.map((c) => c.field).join(', ')}>
          {r.checks.map((c, i) => (
            <span key={c.field}>
              {i ? <span className="text-dim"> · </span> : null}
              <span className={c.ok ? 'text-fg' : 'text-coral'}>{c.ok ? '✓' : '✗'} {c.field}</span>
            </span>
          ))}
        </p>
        <a href={`${corpus.pilot.repo}/tree/${corpus.pilot.ref}`} target="_blank" rel="noreferrer" className="mt-1.5 block truncate text-dim hover:text-fg">
          wallet-backend@{pilotRef} ↗
        </a>
      </div>
    </div>
  );
}
