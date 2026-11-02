import { config } from "./config.js";

// One door to the Overpass API for places and transit lines. Public Overpass servers want
// one request at a time from each client, so every query waits for the previous one.

export const LOOKUP_TIMEOUT_MS = 8_000;

let queue = Promise.resolve();

export const userAgent = () => `NeoPin/${config.version} (self-hosted location sharing)`;

export const overpassEnabled = () => Boolean(config.placeLookupUrl);

// Sends a query and resolves to its elements. Rejects when Overpass is off, busy or down. The
// road tiles (roads/fetch.js) bring their own server and a longer timeout, bigger answers.
export function askOverpass(query, { url = config.placeLookupUrl, timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  const run = queue.then(async () => {
    if (!url) throw new Error("Overpass is turned off");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent() },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
    const body = await res.json();
    // A query that ran out of time or memory still answers 200, with what it had so far.
    if (/runtime error/i.test(body.remark ?? "")) throw new Error(`Overpass: ${body.remark}`);
    return body.elements ?? [];
  });
  queue = run.catch(() => {});
  return run;
}

export function resetOverpass() {
  queue = Promise.resolve();
}
