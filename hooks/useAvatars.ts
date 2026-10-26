import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAvatar } from "@/lib/avatar";
import type { Device } from "@/lib/devices";
import type { StoredCredentials } from "@/lib/socket";

// The URL carries the picture's version, so a loaded picture never goes stale.
const loaded = new Map<string, string>();
const loading = new Set<string>();

// Loads the profile pictures of the given devices and returns a lookup from
// avatarUrl to a data URI the list and the map can show.
export function useAvatars(devices: Device[], creds: StoredCredentials | null) {
  const [, setVersion] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!creds) return;
    for (const device of devices) {
      const url = device.avatarUrl;
      if (!url || loaded.has(url) || loading.has(url)) continue;
      loading.add(url);
      fetchAvatar(creds, url)
        .then((dataUri) => {
          loaded.set(url, dataUri);
          if (mounted.current) setVersion((v) => v + 1);
        })
        .catch((error) => console.warn("Could not load a profile picture:", error?.message))
        .finally(() => loading.delete(url));
    }
  }, [devices, creds]);

  return useCallback((url?: string | null) => (url ? loaded.get(url) ?? null : null), []);
}
