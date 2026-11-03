// Failure injection. Applies to the /reports API only, never to /__chaos itself.
//
// mode:
//   ok             behave normally
//   error          respond 500
//   refuse         respond 503 (server busy, retry later)
//   reject         respond 422 (permanent refusal; the client should not retry automatically)
//   hang           accept the request and never respond
//   drop           destroy the socket before handling the request
//   lose-response  handle the request fully, then destroy the socket instead of responding
// latencyMs: delay added before every request (combines with any mode)
// rate:      probability (0..1) that the mode applies to a given request
// remaining: apply the mode to only the next N requests, then go back to "ok" (null = forever)

export const MODES = [
  'ok',
  'error',
  'refuse',
  'reject',
  'hang',
  'drop',
  'lose-response',
];

const defaults = () => ({ mode: 'ok', latencyMs: 0, rate: 1, remaining: null });

export function createChaos(initial = {}) {
  let config = { ...defaults(), ...initial };

  function set(patch) {
    const next = { ...config, ...patch };
    if (!MODES.includes(next.mode)) {
      throw new Error(`unknown mode "${next.mode}", expected one of ${MODES}`);
    }
    next.latencyMs = Math.max(0, Number(next.latencyMs) || 0);
    next.rate = Math.min(1, Math.max(0, Number(next.rate ?? 1)));
    next.remaining =
      next.remaining === null || next.remaining === undefined || next.remaining === ''
        ? null
        : Math.max(0, Number(next.remaining));
    config = next;
    return config;
  }

  /** Decides what happens to the current request and uses up one "remaining" credit if the mode applies. */
  function draw() {
    if (config.mode === 'ok' || Math.random() >= config.rate) {
      return 'ok';
    }
    const mode = config.mode;
    if (config.remaining !== null) {
      config.remaining -= 1;
      if (config.remaining <= 0) {
        config = { ...config, mode: 'ok', remaining: null };
      }
    }
    return mode;
  }

  function middleware(req, res, next) {
    const mode = draw();
    const proceed = () => {
      switch (mode) {
        case 'ok':
          return next();
        case 'error':
          return res.status(500).json({ error: 'chaos: internal error' });
        case 'refuse':
          res.set('Retry-After', '5');
          return res.status(503).json({ error: 'chaos: service unavailable' });
        case 'reject':
          return res.status(422).json({ error: 'chaos: upload refused by server' });
        case 'hang':
          console.log(`[chaos] hanging ${req.method} ${req.path}`);
          return; // never respond
        case 'drop':
          console.log(`[chaos] dropping ${req.method} ${req.path}`);
          return req.socket.destroy();
        case 'lose-response':
          console.log(`[chaos] will lose response for ${req.method} ${req.path}`);
          // Let the real handler run to completion, then kill the socket instead of replying.
          res.writeHead = () => res;
          res.write = () => true;
          res.end = () => {
            req.socket.destroy();
            return res;
          };
          return next();
      }
    };
    if (config.latencyMs > 0) {
      setTimeout(proceed, config.latencyMs);
    } else {
      proceed();
    }
  }

  return { get: () => config, set, middleware };
}
