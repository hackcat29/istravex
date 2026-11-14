import { useCallback } from 'react';
import { cta, footer, PROPOSAL_URL, RFP_URL } from '../content';
import { SceneMount } from '../components/SceneMount';
import { Button, Logo, Title } from '../components/ui';
import type { SceneContext } from '../scenes/types';

export function Cta() {
  const load = useCallback(
    (ctx: SceneContext) => import('../scenes/byteField').then((m) => m.createByteField(ctx)),
    [],
  );
  return (
      <section id="cta" className="relative overflow-hidden border-t border-line">
        <SceneMount
          load={load}
          label="Field of ledger bytes reacting to the pointer"
          className="absolute inset-0"
        />
        <div className="wrap pointer-events-none relative flex min-h-[640px] flex-col justify-center py-28 sm:min-h-[760px]">
          <Title lines={cta.title} className="h-display text-[clamp(3rem,10vw,9rem)]" />
          <div className="pointer-events-auto mt-12 flex flex-wrap gap-3">
            <Button href={cta.primary.href}>{cta.primary.label}</Button>
            <Button href={cta.secondary.href} variant="ghost" external>
              {cta.secondary.label}
            </Button>
          </div>
        </div>
      </section>
  );
}

export function Footer() {
  return (
      <footer className="border-t border-line">
        <div className="wrap flex flex-col gap-6 py-10 text-[13px] text-mute sm:flex-row sm:items-center sm:justify-between">
          <a href="#top" className="flex items-center gap-2.5 text-[15px] font-semibold text-fg">
            <Logo className="size-6" /> Istravex
          </a>
          <p>{footer.note}</p>
          <ul className="flex gap-5 font-mono text-[12px]">
            <li><a className="hover:text-fg" href={PROPOSAL_URL}>proposal.md</a></li>
            <li><a className="hover:text-fg" href="/llms.txt">llms.txt</a></li>
            <li><a className="hover:text-fg" href={RFP_URL} target="_blank" rel="noreferrer">SCF</a></li>
          </ul>
        </div>
      </footer>
  );
}
