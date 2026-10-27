import { createSchemeStore, type Scheme } from "../lib/scheme";

function fakePhone(initial: Scheme) {
  let scheme = initial;
  let change: ((s: Scheme) => void) | null = null;
  let foreground: (() => void) | null = null;
  const store = createSchemeStore({
    read: () => scheme,
    onChange: (listener) => {
      change = listener;
      return () => (change = null);
    },
    onForeground: (listener) => {
      foreground = listener;
      return () => (foreground = null);
    },
  });
  return {
    store,
    // The phone switches while the app is in front: React Native tells about it.
    switchInFront(next: Scheme) {
      scheme = next;
      change?.(next);
    },
    // The phone switches while the app is away, then the app comes back: nobody tells.
    switchAway(next: Scheme) {
      scheme = next;
    },
    comeBack() {
      foreground?.();
    },
    listening: () => change !== null && foreground !== null,
  };
}

test("the phone is asked again whenever the app comes to the front", () => {
  const phone = fakePhone("light");
  const seen: Scheme[] = [];
  phone.store.subscribe(() => seen.push(phone.store.get()));
  expect(phone.store.get()).toBe("light");

  phone.switchAway("dark");
  expect(phone.store.get()).toBe("light");
  phone.comeBack();
  expect(phone.store.get()).toBe("dark");
  expect(seen).toEqual(["dark"]);

  // Nothing changed: nobody is told.
  phone.comeBack();
  expect(seen).toEqual(["dark"]);
});

test("a change while the app is in front still counts", () => {
  const phone = fakePhone("dark");
  const seen: Scheme[] = [];
  phone.store.subscribe(() => seen.push(phone.store.get()));
  phone.switchInFront("light");
  expect(seen).toEqual(["light"]);
  expect(phone.store.get()).toBe("light");
});

test("the phone is only watched while somebody listens", () => {
  const phone = fakePhone("light");
  expect(phone.listening()).toBe(false);
  const stopA = phone.store.subscribe(() => {});
  const stopB = phone.store.subscribe(() => {});
  expect(phone.listening()).toBe(true);
  stopA();
  expect(phone.listening()).toBe(true);
  stopB();
  expect(phone.listening()).toBe(false);

  // Coming back after a pause reads the phone afresh.
  phone.switchAway("dark");
  phone.store.subscribe(() => {});
  expect(phone.store.get()).toBe("dark");
});
