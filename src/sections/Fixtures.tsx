import { AnimatePresence, motion } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { fixtures } from '../content';
import { Reveal, Title } from '../components/ui';

function Json({ value, indent = 0 }: { value: unknown; indent?: number }): ReactNode {
  const pad = '  '.repeat(indent + 1);
  const end = '  '.repeat(indent);
  if (Array.isArray(value))
    return (
      <>
        <span className="text-dim">[</span>
        {value.map((v, i) => (
          <span key={i}>
            <Json value={v} indent={indent} />
            {i < value.length - 1 && <span className="text-dim">, </span>}
          </span>
        ))}
        <span className="text-dim">]</span>
      </>
    );
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return (
      <>
        <span className="text-dim">{'{'}</span>
        {'\n'}
        {entries.map(([k, v], i) => (
          <span key={k}>
            {pad}
            <span className="text-mute">"{k}"</span>
            <span className="text-dim">: </span>
            <Json value={v} indent={indent + 1} />
            {i < entries.length - 1 && <span className="text-dim">,</span>}
            {'\n'}
          </span>
        ))}
        {end}
        <span className="text-dim">{'}'}</span>
      </>
    );
  }
  if (typeof value === 'boolean') return <span className="text-amber">{String(value)}</span>;
  return <span className="text-fg">"{String(value)}"</span>;
}

export function Fixtures() {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const f = fixtures.items[active];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(f.manifest, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <section id="fixtures" className="relative border-t border-line py-28 sm:py-36">
      <div className="wrap">
        <Title lines={[fixtures.title]} accentLast={false} />
        <Reveal className="mt-14 grid gap-3 sm:mt-20 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <ul className="flex flex-col gap-3">
            {fixtures.items.map((it, i) => (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => setActive(i)}
                  aria-pressed={i === active}
                  className={`card relative w-full overflow-hidden p-6 text-left transition-colors duration-300 sm:p-7 ${i === active ? 'border-fg' : 'hover:border-line-2'}`}
                >
                  <div className="flex items-center justify-between font-mono text-[12px]">
                    <span className={i === active ? 'text-lime' : 'text-mute'}>{it.cap}</span>
                    <motion.span
                      animate={{ rotate: i === active ? 45 : 0 }}
                      className="text-[18px] leading-none text-mute"
                      aria-hidden
                    >
                      +
                    </motion.span>
                  </div>
                  <h3 className="mt-4 text-[22px] font-medium tracking-tight">{it.name}</h3>
                  <AnimatePresence initial={false}>
                    {i === active && (
                      <motion.p
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                        className="overflow-hidden text-[15px] leading-relaxed text-mute"
                      >
                        <span className="block pt-2">{it.expect}</span>
                      </motion.p>
                    )}
                  </AnimatePresence>
                </button>
              </li>
            ))}
          </ul>

          <div className="card relative flex min-h-[420px] flex-col overflow-hidden">
            <div className="flex h-12 items-center justify-between border-b border-line pl-5 pr-2">
              <span className="font-mono text-[12px] text-mute">manifest.json</span>
              <button
                type="button"
                onClick={copy}
                className="h-8 rounded-md px-3 font-mono text-[12px] text-mute transition-colors hover:bg-ink-3 hover:text-fg"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <AnimatePresence mode="wait">
              <motion.pre
                key={f.id}
                initial={{ opacity: 0, filter: 'blur(6px)' }}
                animate={{ opacity: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, filter: 'blur(6px)' }}
                transition={{ duration: 0.3 }}
                className="flex-1 overflow-x-auto p-5 font-mono text-[12px] leading-[1.85] sm:p-6 sm:text-[13px]"
              >
                <code>
                  <Json value={f.manifest} />
                </code>
              </motion.pre>
            </AnimatePresence>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
