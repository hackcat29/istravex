import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MUXED_ID, problem, verdictLabel, type Row } from '../content';
import { Title, VerdictMark } from '../components/ui';

const CYCLE_MS = 7000;

/** What `Number()` does to a uint64 — computed live, not hard-coded. */
const lossy = String(Number(MUXED_ID));

function Digits({ value, against }: { value: string; against: string }) {
  return (
    <>
      {[...value].map((ch, i) => (
        <span key={i} className={ch !== against[i] ? 'bg-coral/15 text-coral' : undefined}>
          {ch}
        </span>
      ))}
    </>
  );
}

export function Problem() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-20% 0px' });
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(true);
  const c = problem.cases[active];

  useEffect(() => {
    if (!auto || !inView || reduce) return;
    const id = setTimeout(() => setActive((a) => (a + 1) % problem.cases.length), CYCLE_MS);
    return () => clearTimeout(id);
  }, [active, auto, inView, reduce]);

  const indexer: Row[] = useMemo(
    () =>
      c.indexer ?? c.ledger.map(([k, v]): Row => [k, k === 'id' ? lossy : v]),
    [c],
  );

  return (
    <section id="problem" className="relative border-t border-line py-28 sm:py-36">
      <div className="wrap">
        <Title lines={problem.title} />

        <div ref={ref} className="mt-14 sm:mt-20">
          <div role="tablist" aria-label="Failure cases" className="flex w-full gap-1 overflow-x-auto rounded-full border border-line bg-ink-2 p-1 sm:w-fit">
            {problem.cases.map((pc, i) => (
              <button
                key={pc.id}
                role="tab"
                id={`tab-${pc.id}`}
                aria-selected={i === active}
                aria-controls={`panel-${pc.id}`}
                onClick={() => {
                  setActive(i);
                  setAuto(false);
                }}
                className={`relative h-10 flex-1 shrink-0 whitespace-nowrap rounded-full px-4 text-[14px] transition-colors sm:flex-none sm:px-5 ${i === active ? 'text-ink' : 'text-mute hover:text-fg'}`}
              >
                {i === active && (
                  <motion.span layoutId="problem-pill" className="absolute inset-0 overflow-hidden rounded-full bg-fg" transition={{ type: 'spring', bounce: 0.15, duration: 0.6 }}>
                    {auto && inView && !reduce && (
                      <motion.span
                        key={active}
                        className="absolute inset-y-0 left-0 bg-lime"
                        initial={{ width: '0%' }}
                        animate={{ width: '100%' }}
                        transition={{ duration: CYCLE_MS / 1000, ease: 'linear' }}
                      />
                    )}
                  </motion.span>
                )}
                <span className="relative">{pc.tab}</span>
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`panel-${c.id}`}
            aria-labelledby={`tab-${c.id}`}
            className="mt-6 grid gap-3 lg:grid-cols-[1fr_120px_1fr] lg:gap-0"
          >
            <Column title={c.ledgerTitle} cap={c.cap} rows={c.ledger} keyId={c.id} />
            <Flow verdict={c.verdict} keyId={c.id} />
            <Column
              title={c.indexerTitle}
              rows={indexer}
              against={c.ledger}
              verdict={c.verdict}
              keyId={c.id}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function Column({
  title,
  cap,
  rows,
  against,
  verdict,
  keyId,
}: {
  title: string;
  cap?: string;
  rows: Row[];
  against?: Row[];
  verdict?: 'correct' | 'incorrect' | 'dropped';
  keyId: string;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="flex h-14 items-center justify-between border-b border-line px-5 sm:px-6">
        <span className="text-[15px] font-medium">{title}</span>
        <AnimatePresence mode="wait">
          <motion.span
            key={keyId}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.08em] text-mute"
          >
            {verdict ? (
              <>
                <VerdictMark v={verdict} />
                <span className={verdict === 'incorrect' ? 'text-coral' : 'text-fg'}>{verdictLabel[verdict]}</span>
              </>
            ) : (
              cap
            )}
          </motion.span>
        </AnimatePresence>
      </div>
      <AnimatePresence mode="wait">
        <motion.dl key={keyId} className="divide-y divide-line font-mono text-[13px] sm:text-[14px]">
          {rows.map(([k, v], i) => {
            const ref = against?.[i]?.[1];
            const wrong = ref !== undefined && ref !== v;
            const missing = wrong && v === '—';
            return (
              <motion.div
                key={k}
                initial={{ opacity: 0, x: against ? 12 : -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={{ delay: 0.15 + i * 0.09 + (against ? 0.35 : 0), duration: 0.5 }}
                className="grid grid-cols-[110px_1fr] items-center gap-3 px-5 py-4 sm:grid-cols-[130px_1fr] sm:px-6"
              >
                <dt className="text-mute">{k}</dt>
                <dd className="relative min-w-0 break-all">
                  {missing ? (
                    <span className="relative inline-block px-2 py-0.5 text-mute">
                      <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
                        <rect x="0.5" y="0.5" width="100%" height="100%" rx="4" fill="none" stroke="#8d8b85" strokeDasharray="4 4" className="march" style={{ width: 'calc(100% - 1px)', height: 'calc(100% - 1px)' }} />
                      </svg>
                      not indexed
                    </span>
                  ) : wrong && ref && /^\d+$/.test(v) ? (
                    <Digits value={v} against={ref} />
                  ) : (
                    <span className={wrong ? 'bg-coral/15 text-coral' : undefined}>{v}</span>
                  )}
                </dd>
              </motion.div>
            );
          })}
        </motion.dl>
      </AnimatePresence>
    </div>
  );
}

/** Animated packets travelling from ledger to indexer. */
function Flow({ verdict, keyId }: { verdict: 'correct' | 'incorrect' | 'dropped'; keyId: string }) {
  const reduce = useReducedMotion();
  const fill = verdict === 'incorrect' ? '#ff5c49' : verdict === 'dropped' ? 'transparent' : '#d4ff3f';
  return (
    <div className="relative hidden items-center justify-center lg:flex" aria-hidden>
      <div className="absolute inset-x-3 top-1/2 h-px bg-line-2" />
      {!reduce &&
        [0, 1, 2].map((i) => (
          <motion.span
            key={`${keyId}-${i}`}
            className="absolute top-1/2 size-2.5 -translate-y-1/2"
            style={{ background: fill, outline: verdict === 'dropped' ? '1.4px dashed #8d8b85' : undefined }}
            initial={{ left: '8%', opacity: 0 }}
            animate={{ left: ['8%', '88%'], opacity: [0, 1, 1, verdict === 'dropped' ? 0 : 1, 0] }}
            transition={{ duration: 2.2, delay: i * 0.73, repeat: Infinity, ease: 'linear' }}
          />
        ))}
    </div>
  );
}
