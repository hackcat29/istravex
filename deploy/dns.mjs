// Upsert the VPS's DNS records in Cloudflare: api and rpc → the VPS, DNS-only
// (grey cloud) so the VPS's nginx terminates TLS and sees client addresses directly.
// Idempotent; run by .github/workflows/deploy.yml before the API deploy.
//
//   CLOUDFLARE_API_TOKEN  needs Zone:Read and DNS:Edit on the zone
//   ZONE                  e.g. istravex.com
//   VPS_IPV4              required
//   VPS_IPV6              optional; AAAA records are managed only when set
//   node deploy/dns.mjs

const { CLOUDFLARE_API_TOKEN: token, ZONE: zone, VPS_IPV4: ipv4, VPS_IPV6: ipv6 } = process.env;
if (!token || !zone || !ipv4) {
  console.error('CLOUDFLARE_API_TOKEN, ZONE and VPS_IPV4 are required');
  process.exit(2);
}
const HOSTS = ['api', 'rpc'];

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

for (const host of HOSTS) {
  const name = `${host}.${zone}`;
  const existing = await cf(`/zones/${z.id}/dns_records?name=${encodeURIComponent(name)}&per_page=100`);
  // A CNAME cannot coexist with address records at the same name.
  for (const r of existing.filter((r) => r.type === 'CNAME')) {
    await cf(`/zones/${z.id}/dns_records/${r.id}`, { method: 'DELETE' });
    console.log(`deleted CNAME ${name} → ${r.content}`);
  }
  for (const [type, content] of [['A', ipv4], ['AAAA', ipv6]]) {
    if (!content) continue;
    const want = { type, name, content, proxied: false, ttl: 1, comment: 'Istravex API (managed by deploy/dns.mjs)' };
    const same = existing.filter((r) => r.type === type);
    if (same.length === 0) {
      await cf(`/zones/${z.id}/dns_records`, { method: 'POST', body: JSON.stringify(want) });
      console.log(`created ${type} ${name} → ${content}`);
      continue;
    }
    const [keep, ...extra] = same;
    if (keep.content !== content || keep.proxied !== false) {
      await cf(`/zones/${z.id}/dns_records/${keep.id}`, { method: 'PUT', body: JSON.stringify(want) });
      console.log(`updated ${type} ${name} → ${content}`);
    } else {
      console.log(`ok      ${type} ${name} → ${content}`);
    }
    for (const r of extra) {
      await cf(`/zones/${z.id}/dns_records/${r.id}`, { method: 'DELETE' });
      console.log(`deleted extra ${type} ${name} → ${r.content}`);
    }
  }
}
