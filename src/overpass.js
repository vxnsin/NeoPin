import { config } from "./config.js";

// One door to the Overpass API for places and transit lines. Public Overpass servers want
// one request at a time from each client, so every query waits for the previous one.

export const LOOKUP_TIMEOUT_MS = 8_000;

let queue = Promise.resolve();

export const userAgent = () => `NeoPin/${config.version} (self-hosted location sharing)`;

export const overpassEnabled = () => Boolean(config.placeLookupUrl);

// Sends a query and resolves to its elements. Rejects when Overpass is off, busy or down.
export function askOverpass(query) {
  const run = queue.then(async () => {
    if (!config.placeLookupUrl) throw new Error("Overpass is turned off");
    const res = await fetch(config.placeLookupUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent() },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
    return (await res.json()).elements ?? [];
  });
  queue = run.catch(() => {});
  return run;
}

export function resetOverpass() {
  queue = Promise.resolve();
}
