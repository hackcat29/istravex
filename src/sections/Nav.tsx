import { AnimatePresence, motion, useMotionValueEvent, useScroll } from 'motion/react';
import { useEffect, useState } from 'react';
import { nav, navCta, REPO_URL } from '../content';
import { Arrow, GitHubMark, Logo } from '../components/ui';

export function Nav() {
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useMotionValueEvent(scrollY, 'change', (y) => setScrolled(y > 24));

  useEffect(() => {
    document.documentElement.style.overflow = open ? 'hidden' : '';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className="fixed inset-x-0 top-0 z-50">
      <div
        className={`border-b transition-colors duration-500 ${scrolled || open ? 'border-line bg-ink/85 backdrop-blur-xl' : 'border-transparent'}`}
      >
        <nav className="wrap flex h-16 items-center justify-between" aria-label="Primary">
          <a href="#top" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight">
            <Logo className="size-7 text-fg" />
            Istravex
          </a>
          <ul className="hidden items-center gap-1 md:flex">
            {nav.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  className="rounded-full px-3.5 py-2 text-[14px] text-mute transition-colors hover:bg-ink-3 hover:text-fg"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Istravex on GitHub"
              className="hidden size-9 place-items-center rounded-full text-mute transition-colors hover:bg-ink-3 hover:text-fg sm:grid"
            >
              <GitHubMark className="size-[18px]" />
            </a>
            <a
              href={navCta.href}
              className="hidden h-9 items-center gap-2 rounded-full bg-fg px-4 text-[14px] font-medium text-ink transition-colors hover:bg-lime sm:inline-flex"
            >
              {navCta.label} <Arrow className="size-3.5" />
            </a>
            <button
              type="button"
              className="relative grid size-10 place-items-center rounded-full md:hidden"
              aria-label={open ? 'Close menu' : 'Open menu'}
              aria-expanded={open}
              aria-controls="mobile-menu"
              onClick={() => setOpen((o) => !o)}
            >
              <span className={`absolute h-[1.5px] w-5 bg-fg transition-transform duration-300 ${open ? 'rotate-45' : '-translate-y-[4px]'}`} />
              <span className={`absolute h-[1.5px] w-5 bg-fg transition-transform duration-300 ${open ? '-rotate-45' : 'translate-y-[4px]'}`} />
            </button>
          </div>
        </nav>
      </div>
      <AnimatePresence>
        {open && (
          <motion.div
            id="mobile-menu"
            className="fixed inset-x-0 bottom-0 top-16 bg-ink md:hidden"
            initial={{ clipPath: 'inset(0 0 100% 0)' }}
            animate={{ clipPath: 'inset(0 0 0% 0)' }}
            exit={{ clipPath: 'inset(0 0 100% 0)' }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <ul className="wrap flex flex-col pt-6">
              {[navCta, ...nav, { href: REPO_URL, label: 'GitHub' }].map((l, i) => (
                <motion.li
                  key={l.href}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.08 + i * 0.04, duration: 0.5 }}
                  className="border-b border-line"
                >
                  <a
                    href={l.href}
                    onClick={() => setOpen(false)}
                    className="flex items-center justify-between py-5 text-[28px] font-medium tracking-tight"
                  >
                    {l.label}
                    <Arrow className="size-5 text-mute" />
                  </a>
                </motion.li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
