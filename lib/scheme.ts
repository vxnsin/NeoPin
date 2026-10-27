// Light or dark, as the phone wants it right now.
export type Scheme = "light" | "dark";

export type SchemeSource = {
  // Asks the phone, never a cache.
  read: () => Scheme;
  // Tells about a change while the app is in front.
  onChange: (listener: (scheme: Scheme) => void) => () => void;
  // Fires whenever the app comes to the front.
  onForeground: (listener: () => void) => () => void;
};

export type SchemeStore = {
  get: () => Scheme;
  subscribe: (listener: () => void) => () => void;
};

// React Native only hears about a theme change while the app is in front. The location service
// keeps the process alive on Android, so the phone can switch to dark with the app "closed", and
// the next time it opens, React Native still answers from before. So the phone is asked again
// every time the app comes to the front.
export function createSchemeStore(source: SchemeSource): SchemeStore {
  let scheme: Scheme | null = null;
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;

  const set = (next: Scheme) => {
    if (next === scheme) return;
    scheme = next;
    listeners.forEach((listener) => listener());
  };

  return {
    get: () => scheme ?? (scheme = source.read()),
    subscribe(listener) {
      listeners.add(listener);
      if (!stop) {
        const stopChanges = source.onChange(set);
        const stopForeground = source.onForeground(() => set(source.read()));
        stop = () => {
          stopChanges();
          stopForeground();
        };
        // The first listener gets the current value without a change being announced.
        if (scheme === null) scheme = source.read();
        else set(source.read());
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stop) {
          stop();
          stop = null;
        }
      };
    },
  };
}
