import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useRef, useState } from 'react';
import { anatomy, type XdrNode } from '../content';
import { SceneMount } from '../components/SceneMount';
import { Reveal, Title } from '../components/ui';
import type { AnatomyHandle } from '../scenes/anatomy';
import type { SceneContext } from '../scenes/types';

const nodes = anatomy.nodes as XdrNode[];
const byId = new Map(nodes.map((n) => [n.id, n]));
const trail = (id: string) => {
  const out: XdrNode[] = [];
  for (let n = byId.get(id); n; n = n.parent ? byId.get(n.parent) : undefined) out.unshift(n);
  return out;
};

export function Anatomy() {
  const [selected, setSelected] = useState(anatomy.defaultNode);
  const labels = useRef(new Map<string, HTMLElement>());
  const handle = useRef<AnatomyHandle | null>(null);

  const load = useCallback(
    (ctx: SceneContext) =>
      import('../scenes/anatomy').then((m) =>
        m.createAnatomyScene(ctx, {
          nodes,
          initial: anatomy.defaultNode,
          onSelect: setSelected,
          getLabel: (id) => labels.current.get(id),
        }),
      ),
    [],
  );

  const choose = (id: string) => {
    setSelected(id);
    handle.current?.select(id);
  };

  const node = byId.get(selected)!;
  const path = trail(selected);

  return (
    <section id="anatomy" className="relative border-t border-line py-28 sm:py-36">
      <div className="wrap">
        <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <Title lines={anatomy.title} />
          <Reveal>
            <a href={anatomy.href} target="_blank" rel="noreferrer" className="font-mono text-[13px] text-mute transition-colors hover:text-fg">
              {anatomy.fixtureId} · L{anatomy.ledger.toLocaleString('en-US')} ↗
            </a>
          </Reveal>
        </div>

        <Reveal className="mt-14 sm:mt-20">
          <div className="card grid overflow-hidden lg:grid-cols-[1fr_380px]">
            <SceneMount<AnatomyHandle>
              load={load}
              onReady={(h) => (handle.current = h)}
              label="Three-dimensional XDR tree of a muxed payment fixture"
              className="relative h-[360px] border-b border-line sm:h-[560px] lg:h-[620px] lg:border-b-0 lg:border-r"
            >
              <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
                {nodes.map((n) => (
                  <span
                    key={n.id}
                    ref={(el) => {
                      if (el) labels.current.set(n.id, el);
                      else labels.current.delete(n.id);
                    }}
                    data-state="idle"
                    className="group absolute left-0 top-0 will-change-transform"
                    style={{ transform: 'translate3d(-999px,-999px,0)' }}
                  >
                    <span className="pointer-events-auto absolute left-3 top-0 -translate-y-1/2 cursor-pointer whitespace-nowrap rounded bg-ink-2/85 px-1.5 py-0.5 font-mono text-[11px] text-dim transition-colors group-data-[state=path]:text-fg group-data-[state=selected]:bg-lime group-data-[state=selected]:text-ink max-sm:hidden max-sm:group-data-[state=selected]:inline"
                      onClick={() => choose(n.id)}
                    >
                      {n.label}
                    </span>
                  </span>
                ))}
              </div>
            </SceneMount>

            <div className="flex flex-col">
              <div className="flex-1 p-6 sm:p-8">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={selected}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.35 }}
                  >
                    <p className="font-mono text-[12px] text-lime">{node.type}</p>
                    <h3 className="mt-3 break-all text-[34px] font-medium leading-none tracking-tight sm:text-[40px]">{node.label}</h3>
                    <ol className="mt-6 flex flex-wrap items-center gap-x-1 gap-y-1.5 font-mono text-[11.5px] text-mute" aria-label="XDR path">
                      {path.map((p, i) => (
                        <li key={p.id} className="flex items-center gap-1">
                          {i > 0 && <span className="text-dim">/</span>}
                          <button type="button" onClick={() => choose(p.id)} className={`rounded px-1 py-0.5 transition-colors hover:text-fg ${p.id === selected ? 'text-fg' : ''}`}>
                            {p.label}
                          </button>
                        </li>
                      ))}
                    </ol>
                    {node.value && (
                      <p className="mt-7 break-all rounded-lg border border-line bg-ink px-3 py-2.5 font-mono text-[13px] leading-relaxed text-fg">
                        {node.value}
                      </p>
                    )}
                    {node.expect && (
                      <p className="mt-6 border-l-2 border-lime pl-4 text-[17px] leading-snug">{node.expect}</p>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
              <div className="border-t border-line p-4 sm:p-6">
                <div className="flex flex-wrap gap-1.5" role="listbox" aria-label="XDR fields">
                  {nodes.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      role="option"
                      aria-selected={n.id === selected}
                      onClick={() => choose(n.id)}
                      className={`rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${n.id === selected ? 'border-lime bg-lime text-ink' : path.some((p) => p.id === n.id) ? 'border-line-2 text-fg' : 'border-line text-mute hover:text-fg'}`}
                    >
                      {n.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
