// Usage: npm run chaos -- <mode> [latencyMs=N] [rate=0.5] [remaining=N]
//        npm run chaos                (prints the current config)
//        npm run chaos -- wipe        (deletes all server reports and images)
const base = process.env.SERVER_URL ?? 'http://localhost:4000';
const [mode, ...rest] = process.argv.slice(2);

const res = await (async () => {
  if (!mode) {
    return fetch(`${base}/__chaos`, { headers: { accept: 'application/json' } });
  }
  if (mode === 'wipe') {
    return fetch(`${base}/__admin/reports`, { method: 'DELETE' });
  }
  const body = { mode, latencyMs: 0, rate: 1, remaining: null };
  for (const arg of rest) {
    const [k, v] = arg.split('=');
    body[k] = v;
  }
  return fetch(`${base}/__chaos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
})();
console.log(res.status, await res.text());
