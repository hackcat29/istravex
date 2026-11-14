import { motion, useInView, useReducedMotion } from 'motion/react';
import { useRef, type ReactNode } from 'react';

const ease = [0.16, 1, 0.3, 1] as const;

/** Section heading: each line rises out of a mask. Last line is muted. */
export function Title({
  lines,
  as: Tag = 'h2',
  className = 'h-section',
  accentLast = true,
}: {
  lines: readonly string[];
  as?: 'h1' | 'h2';
  className?: string;
  accentLast?: boolean;
}) {
  const reduce = useReducedMotion();
  // Observe the heading itself: the masked lines start clipped, so they can't be observed.
  const ref = useRef<HTMLHeadingElement>(null);
  const inView = useInView(ref, { once: true, margin: '0px 0px -10% 0px' });
  const show = inView || !!reduce;
  return (
    <Tag ref={ref} className={className}>
      {lines.map((line, i) => (
        <span key={line} className="block overflow-hidden pb-[0.08em]">
          <motion.span
            className={`block ${accentLast && i === lines.length - 1 && lines.length > 1 ? 'text-mute' : ''}`}
            initial={reduce ? false : { y: '110%' }}
            animate={show ? { y: '0%' } : undefined}
            transition={{ duration: 1, ease, delay: i * 0.08 }}
          >
            {line}
          </motion.span>
        </span>
      ))}
    </Tag>
  );
}

export function Reveal({
  children,
  delay = 0,
  className,
  y = 24,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  y?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-8% 0px' }}
      transition={{ duration: 0.9, ease, delay }}
    >
      {children}
    </motion.div>
  );
}

export function Arrow({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={`size-4 ${className}`}>
      <path d="M3 8h9M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  );
}

export function Button({
  href,
  children,
  variant = 'primary',
  external,
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'ghost';
  external?: boolean;
}) {
  const base =
    'group relative inline-flex h-12 items-center gap-3 overflow-hidden rounded-full pl-6 pr-5 text-[15px] font-medium transition-colors duration-300';
  const look =
    variant === 'primary'
      ? 'bg-lime text-ink hover:bg-fg'
      : 'border border-line-2 text-fg hover:border-fg';
  return (
    <a
      href={href}
      className={`${base} ${look}`}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
    >
      <span>{children}</span>
      <span className="relative block size-4 overflow-hidden">
        <Arrow className="absolute inset-0 transition-transform duration-500 ease-out-expo group-hover:translate-x-5" />
        <Arrow className="absolute inset-0 -translate-x-5 transition-transform duration-500 ease-out-expo group-hover:translate-x-0" />
      </span>
    </a>
  );
}

export function VerdictMark({ v, className = '' }: { v: 'correct' | 'incorrect' | 'dropped'; className?: string }) {
  if (v === 'dropped')
    return (
      <svg viewBox="0 0 10 10" aria-hidden className={`size-2.5 ${className}`}>
        <rect x="1" y="1" width="8" height="8" fill="none" stroke="#8d8b85" strokeWidth="1.4" strokeDasharray="2 2" />
      </svg>
    );
  return (
    <span
      aria-hidden
      className={`inline-block size-2.5 ${v === 'correct' ? 'bg-lime' : 'bg-coral'} ${className}`}
    />
  );
}

export function GitHubMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={`size-4 ${className}`} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function Logo({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" aria-hidden className={className}>
      <circle cx="14" cy="14" r="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray="5.2 2.4" />
      <rect x="10" y="10" width="8" height="8" fill="#d4ff3f" />
    </svg>
  );
}
