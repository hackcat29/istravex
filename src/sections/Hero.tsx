import { motion, useReducedMotion } from 'motion/react';
import { useCallback } from 'react';
import { hero, heroStats, RFP_URL } from '../content';
import { SceneMount } from '../components/SceneMount';
import { Button, Title } from '../components/ui';
import type { SceneContext } from '../scenes/types';

export function Hero() {
  const reduce = useReducedMotion();
  const load = useCallback(
    (ctx: SceneContext) => import('../scenes/hero').then((m) => m.createHeroScene(ctx)),
    [],
  );

  return (
    <section id="top" className="relative overflow-hidden">
      <SceneMount
        load={load}
        label="Fixtures stream through the replay harness and resolve to correct, incorrect or dropped"
        className="absolute inset-0 max-lg:opacity-75"
      />

      <div className="wrap relative z-10 flex min-h-[100svh] flex-col pb-8 pt-28 sm:pt-32 lg:justify-center lg:pb-16 lg:pt-28">
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
          className="h-display max-w-[13ch] text-[clamp(2.9rem,13.4vw,7.4rem)] lg:text-[clamp(2.9rem,7.2vw,6.6rem)]"
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

        <motion.dl
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.9, delay: 0.7 }}
          className="mt-10 grid grid-cols-2 gap-x-6 gap-y-5 sm:flex sm:gap-12 lg:mt-12"
        >
          {heroStats.map((s) => (
            <div key={s.label} className="flex flex-col-reverse gap-1.5">
              <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-mute">{s.label}</dt>
              <dd className="text-[28px] font-medium leading-none tracking-tight tabular-nums sm:text-[32px]">{s.value}</dd>
            </div>
          ))}
        </motion.dl>
      </div>
    </section>
  );
}
