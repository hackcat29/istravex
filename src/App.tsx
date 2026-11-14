import { Nav } from './sections/Nav';
import { Hero } from './sections/Hero';
import { Problem } from './sections/Problem';
import { Kit } from './sections/Kit';
import { Anatomy } from './sections/Anatomy';
import { Fixtures } from './sections/Fixtures';
import { Milestones } from './sections/Milestones';
import { OpenSource } from './sections/OpenSource';

export default function App() {
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-lime focus:px-4 focus:py-2 focus:text-ink">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Problem />
        <Kit />
        <Anatomy />
        <Fixtures />
        <Milestones />
        <OpenSource />
      </main>
    </>
  );
}
