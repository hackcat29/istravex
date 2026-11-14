// Clear the way for the site's Workers custom domains. Cloudflare refuses to
// attach a custom domain to a hostname that already has address records
// (error 100117), e.g. the registrar's parking records imported with the zone.
// This deletes A, AAAA and CNAME records at the site's hostnames unless
// Workers itself manages them. MX, TXT and every other type are left alone,
// as is every other hostname. Idempotent; run by .github/workflows/deploy.yml
// before `wrangler deploy`.
//
//   CLOUDFLARE_API_TOKEN  needs Zone:Read and DNS:Edit on the zone
//   ZONE                  e.g. istravex.com
//   SITE_HOSTS            comma-separated, e.g. istravex.com,www.istravex.com
//   node deploy/site-dns.mjs

const { CLOUDFLARE_API_TOKEN: token, ZONE: zone, SITE_HOSTS: hosts } = process.env;
if (!token || !zone || !hosts) {
  console.error('CLOUDFLARE_API_TOKEN, ZONE and SITE_HOSTS are required');
  process.exit(2);
}

async function cf(path, init = {}) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  });
  const body = await r.json();
  if (!body.success) throw new Error(`${init.method ?? 'GET'} ${path}: ${JSON.stringify(body.errors)}`);
  return body.result;
}

const [z] = await cf(`/zones?name=${encodeURIComponent(zone)}`);
if (!z) throw new Error(`zone ${zone} not found for this token`);

const managedByWorkers = (r) => Boolean(r.meta?.origin_worker_id || r.meta?.read_only);

for (const name of hosts.split(',').map((h) => h.trim()).filter(Boolean)) {
  if (name !== zone && !name.endsWith(`.${zone}`)) throw new Error(`${name} is not in zone ${zone}`);
  const records = await cf(`/zones/${z.id}/dns_records?name=${encodeURIComponent(name)}&per_page=100`);
  const address = records.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type));
  if (address.length === 0) console.log(`ok      ${name}: no address records`);
  for (const r of address) {
    if (managedByWorkers(r)) {
      console.log(`keep    ${r.type} ${name} → ${r.content} (managed by Workers)`);
      continue;
    }
    await cf(`/zones/${z.id}/dns_records/${r.id}`, { method: 'DELETE' });
    console.log(`deleted ${r.type} ${name} → ${r.content}`);
  }
}
