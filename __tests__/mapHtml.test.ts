import { buildMapHtml } from "../lib/mapHtml";

// The map runs inside a WebView, so a typo in the inline script only shows up on a device.
test("the inline map script is valid JavaScript in both themes", () => {
  for (const dark of [false, true]) {
    const html = buildMapHtml(dark, 0);
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const code of scripts) expect(() => new Function(code)).not.toThrow();
  }
});

test("the pulse ring is drawn by the map and not by a DOM animation", () => {
  const html = buildMapHtml(true, 0);
  expect(html).toContain('id: "pulse-ring"');
  expect(html).not.toContain(".online.avatar::after");
});
