import { motion, useReducedMotion, useScroll, useSpring } from 'motion/react';
import { useRef } from 'react';
import { milestones } from '../content';
import { Title } from '../components/ui';

export function Milestones() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 80%', 'end 60%'] });
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });

  return (
    <section id="milestones" className="relative border-t border-line py-28 sm:py-36">
      <div className="wrap">
        <Title lines={milestones.title} />
        <div ref={ref} className="relative mt-14 sm:mt-20">
          {/* progress rail: vertical on mobile, horizontal on desktop */}
          <div className="absolute bottom-0 left-[15px] top-0 w-px bg-line lg:bottom-auto lg:left-0 lg:right-0 lg:top-[15px] lg:h-px lg:w-auto" aria-hidden>
            <motion.div
              className="h-full w-full origin-top bg-lime lg:hidden"
              style={{ scaleY: reduce ? 1 : progress }}
            />
            <motion.div
              className="hidden h-full w-full origin-left bg-lime lg:block"
              style={{ scaleX: reduce ? 1 : progress }}
            />
          </div>

          <ol className="grid gap-12 lg:grid-cols-3 lg:gap-6">
            {milestones.items.map((m, i) => (
              <motion.li
                key={m.n}
                initial={reduce ? false : { opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-8% 0px' }}
                transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: i * 0.1 }}
                className="relative pl-12 lg:pl-0 lg:pt-14"
              >
                  <span className="absolute left-0 top-0 grid size-[31px] place-items-center rounded-full border border-line-2 bg-ink font-mono text-[11px] text-fg">
                    {m.n}
                  </span>
                  <h3 className="text-[26px] font-medium leading-tight tracking-tight sm:text-[30px]">{m.title}</h3>
                  <ul className="mt-6 flex flex-wrap gap-1.5">
                    {m.deliver.map((d) => (
                      <li key={d} className="rounded-full border border-line px-3 py-1.5 text-[13px] text-fg">
                        {d}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-6 border-t border-line pt-6 text-[15px] leading-relaxed text-mute">{m.accept}</p>
              </motion.li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
