// Export the hardening guide for developers.stellar.org (Docusaurus).
//
// The guide is written for Mintlify (docs/guide). This turns each page into
// plain Docusaurus Markdown: Mintlify callouts become admonitions, card groups
// become link lists, accordions become <details>, generated snippet tables are
// inlined, links to other guide pages become relative and links elsewhere in
// the docs become absolute. Output: build/guide/ with a _category_.json.
//
//   node kit/guide/export.mjs [--out build/guide]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT } from '../lib/fixture.mjs';

const { values: opt } = parseArgs({ options: { out: { type: 'string', default: join(ROOT, 'build', 'guide') } } });
const OUT = resolve(opt.out);
const DOCS = join(ROOT, 'docs');
const SITE = 'https://docs.istravex.com';
const review = JSON.parse(readFileSync(join(ROOT, 'kit', 'guide', 'review.json'), 'utf8'));

const nav = JSON.parse(readFileSync(join(DOCS, 'docs.json'), 'utf8')).navigation.tabs.find((t) => t.tab === 'Hardening guide');
const pages = nav.groups.flatMap((g) => g.pages);
const slugs = new Set(pages.map((p) => p.replace(/^guide\//, '')));

const admonition = { Check: 'tip', Tip: 'tip', Note: 'note', Info: 'info', Warning: 'warning' };

function convert(src) {
  const fm = src.match(/^---\n([\s\S]*?)\n---\n/);
  const meta = Object.fromEntries(fm[1].split('\n').map((l) => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
  let body = src.slice(fm[0].length);

  // Snippets: inline each imported table (dropping its generated-file comment).
  const imports = new Map();
  body = body.replace(/^import (\w+) from '\/snippets\/([\w-]+)\.mdx';\n/gm, (_, name, file) => {
    imports.set(name, readFileSync(join(DOCS, 'snippets', `${file}.mdx`), 'utf8').replace(/^\{\/\*[\s\S]*?\*\/\}\n+/, '').trim());
    return '';
  });
  for (const [name, table] of imports) body = body.replaceAll(`<${name} />`, table);

  // Callouts → admonitions.
  body = body.replace(/<(Check|Tip|Note|Info|Warning)>\n?([\s\S]*?)\n?<\/\1>/g, (_, kind, inner) => `:::${admonition[kind]}\n\n${inner.trim()}\n\n:::`);
  // Card groups → link lists.
  body = body.replace(/<CardGroup[^>]*>([\s\S]*?)<\/CardGroup>/g, (_, inner) =>
    [...inner.matchAll(/<Card title="([^"]+)"(?:[^>]*?href="([^"]+)")?[^>]*>([\s\S]*?)<\/Card>/g)]
      .map(([, title, href, text]) => `- ${href ? `[${title}](${href})` : `**${title}**`}: ${text.trim().replace(/\s+/g, ' ')}`)
      .join('\n'),
  );
  // Accordions → <details>.
  body = body.replace(/<\/?AccordionGroup>\n?/g, '');
  body = body.replace(/<Accordion title="([^"]+)">\n?([\s\S]*?)<\/Accordion>/g, (_, title, inner) => `<details>\n<summary>${title}</summary>\n\n${inner.trim()}\n\n</details>`);
  // Code groups → plain code blocks with Docusaurus titles.
  body = body.replace(/<\/?CodeGroup>\n?/g, '');
  body = body.replace(/^```(\w+) ([^\n]+)$/gm, (_, lang, title) => `\`\`\`${lang} title="${title.trim()}"`);
  // Links: guide pages relative, the rest of the docs absolute.
  body = body.replace(/\]\((\/[^)\s]*)\)/g, (_, href) => {
    const [path, hash = ''] = href.split('#');
    const slug = path.replace(/^\/guide\//, '');
    if (path.startsWith('/guide/') && slugs.has(slug)) return `](./${slug}.md${hash ? `#${hash}` : ''})`;
    return `](${SITE}${href})`;
  });
  return { meta, body: body.trim() + '\n' };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
pages.forEach((page, i) => {
  const slug = page.replace(/^guide\//, '');
  const { meta, body } = convert(readFileSync(join(DOCS, `${page}.mdx`), 'utf8'));
  const front = [
    '---',
    `title: ${JSON.stringify(meta.title)}`,
    meta.sidebarTitle && `sidebar_label: ${JSON.stringify(meta.sidebarTitle)}`,
    `sidebar_position: ${i + 1}`,
    meta.description && `description: ${JSON.stringify(meta.description)}`,
    '---',
  ].filter(Boolean);
  // Until the review the RFP gates publication on is recorded, every page says so.
  const banner = review.status === 'reviewed' ? '' : `:::warning Draft, not reviewed\n\nThis page has not yet been reviewed by a stellar-core or platform engineer and is not ready to publish.${review.request ? ` Review requested in ${review.request}.` : ''}\n\n:::\n\n`;
  writeFileSync(join(OUT, `${slug}.md`), `${front.join('\n')}\n\n${banner}${body}`);
});
writeFileSync(join(OUT, '_category_.json'), JSON.stringify({ label: 'Indexer hardening guide', position: 1, link: { type: 'doc', id: 'overview' } }, null, 2) + '\n');
// Nothing Mintlify-specific may survive.
const leftovers = pages.flatMap((p) => {
  const text = readFileSync(join(OUT, `${p.replace(/^guide\//, '')}.md`), 'utf8');
  return [...text.matchAll(/<(CardGroup|Card|Check|Tip|Note|Info|Warning|CodeGroup|Accordion|Tabs|Tab|Steps|ResponseField)\b/g)].map((m) => `${p}: <${m[1]}>`);
});
if (leftovers.length) {
  console.error(`Mintlify components left in the export:\n${leftovers.join('\n')}`);
  process.exit(1);
}
console.log(`exported ${pages.length} pages to ${OUT}`);
