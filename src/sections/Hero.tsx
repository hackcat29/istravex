import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { hero, RFP_URL, type Verdict, verdictLabel } from '../content';
import { SceneMount } from '../components/SceneMount';
import { Button, Title, VerdictMark } from '../components/ui';
import type { SceneContext } from '../scenes/types';

const verdicts: Verdict[] = ['correct', 'incorrect', 'dropped'];

export function Hero() {
  const reduce = useReducedMotion();
  const counts = useRef<Record<Verdict, number>>({ correct: 0, incorrect: 0, dropped: 0 });
  const [shown, setShown] = useState(counts.current);

  useEffect(() => {
    const id = setInterval(() => setShown({ ...counts.current }), 220);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(
    (ctx: SceneContext) =>
      import('../scenes/hero').then((m) =>
        m.createHeroScene(ctx, { onVerdict: (v) => void counts.current[v]++ }),
      ),
    [],
  );

  return (
    <section id="top" className="relative overflow-hidden">
      <SceneMount
        load={load}
        label="Fixtures stream through the replay harness and resolve to correct, incorrect or dropped"
        className="absolute inset-0 max-lg:opacity-75"
      />

      <div className="wrap relative z-10 flex min-h-[100svh] flex-col pb-8 pt-28 sm:pt-32 lg:max-h-[1000px] lg:justify-center lg:pb-24 lg:pt-16">
        <motion.a
          href={RFP_URL}
          target="_blank"
          rel="noreferrer"
          initial={reduce ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="mb-8 inline-flex w-fit items-center gap-2.5 rounded-full border border-line-2 bg-ink/70 py-1.5 pl-2.5 pr-4 font-mono text-[12px] uppercase tracking-[0.08em] text-mute backdrop-blur transition-colors hover:border-fg hover:text-fg"
        >
          <span className="caret size-2 bg-lime" aria-hidden />
          {hero.badge}
        </motion.a>

        <Title
          as="h1"
          lines={hero.title}
          className="h-display max-w-[13ch] text-[clamp(2.9rem,13.4vw,7.4rem)] lg:text-[clamp(2.9rem,8.4vw,7.4rem)]"
        />

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.45 }}
          className="mt-auto flex flex-col gap-3 pt-10 sm:flex-row lg:mt-10 lg:pt-0"
        >
          <Button href={hero.primary.href}>{hero.primary.label}</Button>
          <Button href={hero.secondary.href} variant="ghost">
            {hero.secondary.label}
          </Button>
        </motion.div>

        <dl className="mt-8 flex flex-wrap gap-x-6 gap-y-2 font-mono text-[12px] sm:gap-x-10 lg:absolute lg:bottom-10 lg:right-0 lg:mt-0 lg:w-[60%] lg:justify-center">
          {verdicts.map((v) => (
            <div key={v} className="flex items-center gap-2.5">
              <VerdictMark v={v} />
              <dt className="uppercase tracking-[0.08em] text-mute">{verdictLabel[v]}</dt>
              <dd className="min-w-[4ch] tabular-nums text-fg">{shown[v].toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
