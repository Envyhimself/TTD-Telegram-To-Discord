// TTD Watchdog — standalone Cloudflare Worker that every 5 minutes checks each
// relay Worker's /health via service bindings and kicks any unhealthy relay
// with /wd-kick so it runs a fresh sync and self-recovers. Safety net against
// any future silent outage: if a relay stops recording runs, the watchdog
// revives it within 5 minutes.

const RELAYS = [
  { name: 'warroom', binding: 'WARROOM', url: 'https://warroom.amoaaa.workers.dev' },
  { name: 'warroom-second', binding: 'WARROOM_SECOND', url: 'https://warroom-second.amoaaa.workers.dev' },
  { name: 'hamburger', binding: 'HAMBURGER', url: 'https://hamburger.amoaaa.workers.dev' }
];

function timeoutFetch(env, relay, path, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const binding = env[relay.binding];
  const req = new Request(relay.url + path, { signal: controller.signal });
  return binding.fetch(req).finally(() => clearTimeout(timer));
}

async function checkRelay(env, relay) {
  const out = { name: relay.name, healthy: false, reason: 'unreachable' };
  // Retry up to 4 times: the service-binding DNS (1101) is occasionally flaky,
  // and a transient failure must not make the watchdog falsely believe a relay
  // is down and fire an unnecessary recovery kick.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await timeoutFetch(env, relay, '/health', 20000);
      if (res.ok || res.status === 503) {
        const h = await res.json();
        out.healthy = Boolean(h.healthy);
        out.reason = h.reason;
        out.lastRun = h.lastScheduledRun ? h.lastScheduledRun.time : null;
        return out;
      }
      out.reason = 'http-' + res.status;
    } catch (err) {
      out.reason = 'unreachable';
      out.error = String(err).slice(0, 120);
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
  }
  return out;
}

async function runChecks(env) {
  const results = [];
  for (const relay of RELAYS) {
    const result = await checkRelay(env, relay);
    if (!result.healthy) {
      // A wedged relay has no active run (lock gone or broken by the stale
      // break), so /wd-kick starts a clean sync that self-recovers.
      let kick = { kicked: false };
      try {
        const res = await timeoutFetch(env, relay, '/wd-kick', 90000);
        kick = { kicked: true, status: res.status };
      } catch (err) {
        kick = { kicked: false, error: String(err).slice(0, 120) };
      }
      result.kick = kick;
      const after = await checkRelay(env, relay);
      result.healthyAfterKick = after.healthy;
      result.reasonAfterKick = after.reason;
    }
    results.push(result);
  }
  const entry = { time: new Date().toISOString(), results };
  if (env.WATCHDOG_LOG) {
    let log = [];
    try { log = JSON.parse(await env.WATCHDOG_LOG.get('LOG') || '[]'); } catch { /* corrupt */ }
    log.push(entry);
    await env.WATCHDOG_LOG.put('LOG', JSON.stringify(log.slice(-50)));
  }
  return { status: 'ok', allHealthy: results.every(r => r.healthy), ...entry };
}

export default {
  async scheduled(_event, env, _ctx) {
    try {
      await runChecks(env);
    } catch (err) {
      console.error('watchdog run error:', err);
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run' || url.pathname === '/health') {
      return Response.json(await runChecks(env));
    }
    if (url.pathname === '/status') {
      let log = [];
      if (env.WATCHDOG_LOG) {
        try { log = JSON.parse(await env.WATCHDOG_LOG.get('LOG') || '[]'); } catch { /* corrupt */ }
      }
      return Response.json({ status: 'ok', lastCheck: log.length ? log[log.length - 1] : null, recent: log.slice(-5) });
    }
    return new Response('TTD Watchdog is running.', { status: 200 });
  }
};
