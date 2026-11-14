import { motion, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { checks, kit, lintCode, lintRules, sdks, type Verdict } from '../content';
import { Reveal, Title, VerdictMark } from '../components/ui';

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
          <Card part={pilot} className="md:col-span-2" delay={0.12}>
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
  children,
}: {
  part: (typeof kit.parts)[number];
  className?: string;
  delay: number;
  children: ReactNode;
}) {
  return (
    <Reveal delay={delay} className={className}>
      <article
        id={`kit-${part.id}`}
        className="card group flex h-full flex-col overflow-hidden transition-colors duration-500 hover:border-line-2"
      >
        <div className="relative min-h-[330px] flex-1 border-b border-line bg-ink sm:min-h-[300px]">{children}</div>
        <div className="flex gap-5 p-6 sm:p-7">
          <span className="font-mono text-[13px] text-dim">{part.n}</span>
          <div>
            <h3 className="text-[20px] font-medium tracking-tight">{part.title}</h3>
            <p className="mt-2 max-w-[52ch] text-[15px] leading-relaxed text-mute">{part.body}</p>
          </div>
        </div>
      </article>
    </Reveal>
  );
}

/* ── 01 Corpus: manifest types itself, CAP chips light in sequence ──────── */
const caps = ['CAP-0015', 'CAP-0023', 'CAP-0027', 'CAP-0033', 'CAP-0035', 'CAP-0038', 'CAP-0040', 'CAP-0046', 'CAP-0067', 'CAP-0073'];
const manifestLines: [string, string][] = [
  ['id', '"muxed-payment-recipient-0001"'],
  ['cap_ids', '["CAP-0027"]'],
  ['xdr_type', '"TransactionEnvelope"'],
  ['source', '"captured ledger"'],
  ['synthetic', 'false'],
];

function CorpusVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-15% 0px' });
  const reduce = useReducedMotion();
  const [lit, setLit] = useState(reduce ? caps.length : 0);
  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => setLit((n) => (n >= caps.length + 6 ? 0 : n + 1)), 420);
    return () => clearInterval(id);
  }, [inView, reduce]);

  return (
    <div ref={ref} className="absolute inset-0 flex flex-col justify-between p-6 sm:p-7">
      <div className="flex flex-wrap gap-1.5">
        {caps.map((c, i) => (
          <span
            key={c}
            className={`rounded-md border px-2 py-1 font-mono text-[11px] transition-all duration-500 ${i < lit ? 'border-lime bg-lime text-ink' : 'border-line text-dim'}`}
          >
            {c}
          </span>
        ))}
      </div>
      <pre className="mt-6 overflow-hidden font-mono text-[12px] leading-[1.9] sm:text-[13px]">
        <span className="text-dim">{'{'}</span>
        {manifestLines.map(([k, v], i) => (
          <motion.div
            key={k}
            initial={reduce ? false : { opacity: 0, x: -8 }}
            animate={inView ? { opacity: 1, x: 0 } : undefined}
            transition={{ delay: 0.3 + i * 0.12, duration: 0.6, ease }}
            className="pl-4"
          >
            <span className="text-mute">"{k}"</span>
            <span className="text-dim">: </span>
            <span className={v === 'false' ? 'text-amber' : 'text-fg'}>{v}</span>
          </motion.div>
        ))}
        <span className="text-dim">{'}'}</span>
      </pre>
    </div>
  );
}

/* ── 02 Replay: ledgers pass through stages and resolve to verdicts ─────── */
const stages = ['getLedgers', 'adapter', 'compare'];
const replaySeq: Verdict[] = ['correct', 'correct', 'incorrect', 'correct', 'dropped', 'correct', 'correct', 'correct'];

function ReplayVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-15% 0px' });
  const reduce = useReducedMotion();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => setTick((t) => t + 1), 900);
    return () => clearInterval(id);
  }, [inView, reduce]);
  const log = Array.from({ length: 5 }, (_, i) => {
    const n = tick - i;
    return n < 0 ? null : { seq: 51_204_310 + n, v: replaySeq[n % replaySeq.length] };
  }).filter(Boolean) as { seq: number; v: Verdict }[];

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
            key={r.seq}
            layout
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1 - i * 0.17, y: 0 }}
            transition={{ duration: 0.45, ease }}
            className="flex items-center justify-between rounded-md border border-line bg-ink-2 px-3 py-2"
          >
            <span className="text-mute">ledger {r.seq.toLocaleString('en-US')}</span>
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

/* ── 03 Runner: SDK × check matrix sweeps; hover/tap any cell ─────────── */
function RunnerVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-15% 0px' });
  const reduce = useReducedMotion();
  const total = sdks.length * checks.length;
  const [sweep, setSweep] = useState(reduce ? total : 0);
  const [focus, setFocus] = useState<number | null>(null);
  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => setSweep((s) => (s > total + 4 ? 0 : s + 1)), 380);
    return () => clearInterval(id);
  }, [inView, reduce, total]);
  const shown = focus ?? Math.min(sweep, total) - 1;

  return (
    <div ref={ref} className="absolute inset-0 flex flex-col justify-between p-6 sm:p-7">
      <div className="grid grid-cols-[72px_repeat(3,1fr)] gap-1.5 font-mono text-[11px]">
        <span />
        {sdks.map((s) => (
          <span key={s} className="pb-1 text-center text-mute">{s === 'JavaScript' ? 'JS' : s}</span>
        ))}
        {checks.map((c, row) => (
          <Row key={c} label={c}>
            {sdks.map((s, col) => {
              const i = row * sdks.length + col;
              const done = i < sweep;
              return (
                <button
                  key={s}
                  type="button"
                  aria-label={`${s} ${c}`}
                  onMouseEnter={() => setFocus(i)}
                  onMouseLeave={() => setFocus(null)}
                  onFocus={() => setFocus(i)}
                  onBlur={() => setFocus(null)}
                  onClick={() => setFocus(i)}
                  className={`aspect-[1.6] rounded-md border transition-all duration-300 ${focus === i ? 'border-fg bg-fg' : done ? 'border-lime bg-lime' : 'border-line bg-ink-2'}`}
                />
              );
            })}
          </Row>
        ))}
      </div>
      <p className="mt-5 h-5 font-mono text-[12px] text-mute">
        {shown >= 0 && (
          <>
            <span className="text-fg">{sdks[shown % sdks.length]}</span> · {checks[Math.floor(shown / sdks.length)]}
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

/* ── 04 Linter: three rules, hover a rule to find its line ────────────── */
function LintVisual() {
  const [rule, setRule] = useState<number | null>(null);
  return (
    <div className="absolute inset-0 flex flex-col justify-between p-5 sm:p-6">
      <pre className="overflow-hidden font-mono text-[10.5px] leading-[1.75] sm:text-[11.5px]">
        {lintCode.map((line, i) => {
          const r = lintRules.findIndex((lr) => lr.line === i + 1);
          const hot = r >= 0 && (rule === null || rule === r);
          return (
            <div key={i} className={`flex gap-3 transition-opacity duration-300 ${rule !== null && rule !== r ? 'opacity-35' : ''}`}>
              <span className="w-4 shrink-0 text-right text-dim">{i + 1}</span>
              <span className={`whitespace-pre ${r >= 0 ? 'underline decoration-wavy underline-offset-4' : ''} ${hot ? 'decoration-coral text-fg' : 'decoration-transparent text-mute'}`}>
                {line}
              </span>
            </div>
          );
        })}
      </pre>
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
            title={lr.label}
            aria-pressed={rule === i}
            className={`rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${rule === i ? 'border-coral bg-coral text-ink' : 'border-line text-mute hover:text-fg'}`}
          >
            {lr.id}
          </button>
        ))}
      </div>
      <p className="mt-2 h-4 font-mono text-[11px] text-mute">{rule !== null ? lintRules[rule].label : ''}</p>
    </div>
  );
}

/* ── 05 Pilot: a finding card that flips between expected and observed ── */
function PilotVisual() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-15% 0px' });
  const [observed, setObserved] = useState(false);
  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => setObserved((o) => !o), 2600);
    return () => clearInterval(id);
  }, [inView, reduce]);

  const rows: [string, string][] = [
    ['component', 'wallet-backend'],
    ['fixture', 'cap73-sac-trustline-0001'],
    ['cap', 'CAP-0073'],
    ['severity', 'high'],
  ];
  return (
    <div ref={ref} className="absolute inset-0 flex flex-col justify-between p-5 sm:p-6">
      <dl className="space-y-2 font-mono text-[11.5px] sm:text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-line pb-2">
            <dt className="text-dim">{k}</dt>
            <dd className={`truncate ${k === 'severity' ? 'text-coral' : 'text-fg'}`}>{v}</dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        onClick={() => setObserved((o) => !o)}
        className="mt-4 grid grid-cols-2 overflow-hidden rounded-lg border border-line text-left font-mono text-[11.5px]"
        aria-label="Toggle expected and observed"
      >
        {(['expected', 'observed'] as const).map((side) => {
          const on = (side === 'observed') === observed;
          return (
            <span key={side} className={`relative px-3 py-3 transition-colors duration-500 ${on ? (side === 'observed' ? 'bg-coral text-ink' : 'bg-lime text-ink') : 'text-dim'}`}>
              <span className="block uppercase tracking-[0.08em]">{side}</span>
              <span className="mt-1 block">{side === 'expected' ? 'trustline created' : 'no record'}</span>
            </span>
          );
        })}
      </button>
    </div>
  );
}
