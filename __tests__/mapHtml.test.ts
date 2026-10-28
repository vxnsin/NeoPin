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

test("a ride's stops are drawn as dots in the line's colour", () => {
  const html = buildMapHtml(false, 0);
  expect(html).toContain('dot.className = "tstop"');
  expect(html).toContain("dot.style.background = s.color");
});

test("the online ring only animates opacity, which never repaints the map", () => {
  const html = buildMapHtml(true, 0);
  expect(html).toContain("@keyframes breathe { 0%, 100% { opacity: 0; } 45% { opacity: .85; } }");
  expect(html).not.toContain("pulse-ring");
});
