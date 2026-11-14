import { motion, useReducedMotion } from 'motion/react';
import { openSource } from '../content';
import { Title } from '../components/ui';

export function OpenSource() {
  const reduce = useReducedMotion();
  return (
    <section id="open-source" className="relative border-t border-line py-28 sm:py-36">
      <div className="wrap">
        <Title lines={openSource.title} />
        <dl className="mt-14 grid grid-cols-2 border-l border-t border-line sm:mt-20 lg:grid-cols-4">
          {openSource.stats.map((s, i) => (
            <motion.div
              key={s.label}
              initial={reduce ? false : 'hidden'}
              whileInView="shown"
              variants={{ hidden: { opacity: 0 }, shown: { opacity: 1 } }}
              viewport={{ once: true, margin: '-10% 0px' }}
              transition={{ duration: 0.8, delay: i * 0.08 }}
              className="group relative flex min-h-[180px] flex-col justify-between overflow-hidden border-b border-r border-line p-5 sm:min-h-[240px] sm:p-7"
            >
              <span className="absolute inset-0 origin-bottom scale-y-0 bg-lime transition-transform duration-500 ease-out-expo group-hover:scale-y-100" aria-hidden />
              <dt className="relative font-mono text-[12px] uppercase tracking-[0.08em] text-mute transition-colors duration-300 group-hover:text-ink">
                {s.label}
              </dt>
              <dd className="relative overflow-hidden">
                <motion.span
                  className="block text-[clamp(2.2rem,5.4vw,4.4rem)] font-medium leading-none tracking-[-0.04em] transition-colors duration-300 group-hover:text-ink"
                  variants={{ hidden: { y: '100%' }, shown: { y: '0%' } }}
                  transition={{ duration: 1, ease: [0.16, 1, 0.3, 1], delay: 0.15 + i * 0.08 }}
                >
                  {s.value}
                </motion.span>
              </dd>
            </motion.div>
          ))}
        </dl>
      </div>
    </section>
  );
}
