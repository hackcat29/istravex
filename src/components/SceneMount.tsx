import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useReducedMotion } from 'motion/react';
import type { SceneContext, SceneHandle } from '../scenes/types';

type Props<H extends SceneHandle> = {
  /** Dynamic-import a scene factory. Called once, when the host nears the viewport. */
  load: (ctx: SceneContext) => Promise<H>;
  onReady?: (handle: H) => void;
  label: string;
  className?: string;
  canvasClassName?: string;
  children?: ReactNode;
};

/**
 * Lazily mounts a GPU scene: loads near the viewport, renders only while
 * visible, and disposes on unmount. Exposes the active backend on
 * `data-backend` (webgpu | webgl2 | canvas2d) for tests and agents.
 */
export function SceneMount<H extends SceneHandle>({
  load,
  onReady,
  label,
  className,
  canvasClassName,
  children,
}: Props<H>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loadRef = useRef(load);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const reducedMotion = !!useReducedMotion();
  const [state, setState] = useState<'idle' | 'ready' | 'failed'>('idle');
  const [backend, setBackend] = useState<string>('');

  useEffect(() => {
    const host = hostRef.current!;
    const canvas = canvasRef.current!;
    let handle: H | null = null;
    let visible = false;
    let cancelled = false;

    const start = () => {
      loadRef
        .current({ canvas, reducedMotion })
        .then((h) => {
          if (cancelled) return h.dispose();
          handle = h;
          setBackend(h.backend);
          setState('ready');
          readyRef.current?.(h);
          h.setActive(visible && !document.hidden);
        })
        .catch((err) => {
          console.warn(`[scene] ${label} failed`, err);
          if (!cancelled) setState('failed');
        });
    };

    const near = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          near.disconnect();
          start();
        }
      },
      { rootMargin: '400px 0px' },
    );
    const seen = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      handle?.setActive(visible && !document.hidden);
    });
    const onVis = () => handle?.setActive(visible && !document.hidden);

    near.observe(host);
    seen.observe(host);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      near.disconnect();
      seen.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      handle?.dispose();
    };
  }, [label, reducedMotion]);

  return (
    <div ref={hostRef} className={className} data-backend={backend} data-state={state}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        className={`h-full w-full transition-opacity duration-1000 ${state === 'ready' ? 'opacity-100' : 'opacity-0'} ${canvasClassName ?? ''}`}
      />
      {children}
    </div>
  );
}
