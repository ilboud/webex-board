import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const corpus = JSON.parse(readFileSync(new URL("../fixtures/recognition-corpus.json", import.meta.url)));
const pointsFor = (id) => corpus.fixtures.find((fixture) => fixture.id === id).points;

async function snapshot(page) {
  return page.evaluate(() => window.__whiteboardDebug.snapshot());
}

async function drawPoints(page, points, options = {}) {
  const { pointerId = 1, pointerType = "mouse", scale = 1, offsetX = 0, offsetY = 0, ending = "pointerup" } = options;
  await page.locator("#drawing-canvas").evaluate((canvas, input) => {
    const rect = canvas.getBoundingClientRect();
    const cssScale = input.scale * Math.min(rect.width, rect.height);
    const eventFor = (type, point) => new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: input.pointerId,
      pointerType: input.pointerType,
      isPrimary: true,
      buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
      clientX: rect.left + input.offsetX * rect.width + point.x * cssScale,
      clientY: rect.top + input.offsetY * rect.height + point.y * cssScale,
    });
    canvas.dispatchEvent(eventFor("pointerdown", input.points[0]));
    for (const point of input.points.slice(1, -1)) canvas.dispatchEvent(eventFor("pointermove", point));
    canvas.dispatchEvent(eventFor(input.ending, input.points.at(-1)));
  }, { points, pointerId, pointerType, scale, offsetX, offsetY, ending });
}

async function drawFixture(page, id, options) {
  await drawPoints(page, pointsFor(id), options);
}

async function mountHarness(page, { confidenceConfig = { mediumThreshold: 0.65, highThreshold: 0.85 }, result = null } = {}) {
  await page.goto("./tests/browser/harness.html");
  await page.evaluate(async ({ confidenceConfig, result }) => {
    const [{ createDrawingSurface }, { createIconCatalog }] = await Promise.all([
      import("../../src/drawing-surface.js"),
      import("../../src/icon-catalog.js"),
    ]);
    window.__testCalls = 0;
    const recognizer = () => {
      window.__testCalls += 1;
      return result || { status: "unrecognized", category: null, confidence: 0 };
    };
    const whiteboard = createDrawingSurface({
      canvas: document.querySelector("#drawing-canvas"),
      surface: document.querySelector("#drawing-surface"),
      undoButton: document.querySelector("#undo"),
      clearButton: document.querySelector("#clear"),
      recognizer,
      confidenceConfig,
      catalog: createIconCatalog({ circle: { id: "router", label: "Router", src: "../../assets/material-symbols/router.svg", aspectRatio: 1 } }),
    });
    window.__whiteboardDebug = Object.freeze({ snapshot: whiteboard.snapshot });
  }, { confidenceConfig, result });
}

async function clear(page) {
  await page.locator("#clear").click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("./index.html");
  await expect(page.locator("#drawing-canvas")).toBeVisible();
});

test("invalid confidence disables recognition", async ({ page }) => {
  await mountHarness(page, { confidenceConfig: { mediumThreshold: 0.9, highThreshold: 0.8 } });
  await drawFixture(page, "clean-circle-64");
  expect(await page.evaluate(() => window.__testCalls)).toBe(0);
});

test("invalid confidence preserves drawing", async ({ page }) => {
  await mountHarness(page, { confidenceConfig: null });
  await drawFixture(page, "clean-circle-64");
  expect((await snapshot(page)).elements).toHaveLength(1);
  expect((await snapshot(page)).elements[0].type).toBe("stroke");
});

test("invalid confidence preserves undo", async ({ page }) => {
  await mountHarness(page, { confidenceConfig: null });
  await drawFixture(page, "open-circle", { offsetX: -0.05, scale: 0.5 });
  await drawFixture(page, "open-rectangle", { pointerId: 2, offsetX: 0.45, scale: 0.5 });
  const before = await snapshot(page);
  await page.locator("#undo").click();
  const after = await snapshot(page);
  expect(before.elements).toHaveLength(2);
  expect(after.elements).toEqual([before.elements[0]]);
});

test("invalid confidence preserves clear", async ({ page }) => {
  await mountHarness(page, { confidenceConfig: null });
  await drawFixture(page, "open-circle");
  await clear(page);
  expect((await snapshot(page)).elements).toHaveLength(0);
});

test("ordinary stroke undo", async ({ page }) => {
  await drawFixture(page, "open-circle", { scale: 0.5 });
  await drawFixture(page, "open-rectangle", { pointerId: 2, scale: 0.5, offsetX: 0.5 });
  const before = await snapshot(page);
  await page.locator("#undo").click();
  expect((await snapshot(page)).elements).toEqual([before.elements[0]]);
});

test("recognition waits for completion", async ({ page }) => {
  const points = pointsFor("clean-circle-64");
  await page.locator("#drawing-canvas").evaluate((canvas, points) => {
    const rect = canvas.getBoundingClientRect();
    const emit = (type, point) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "pen", isPrimary: true, buttons: 1, clientX: rect.left + point.x * rect.width, clientY: rect.top + point.y * rect.height }));
    emit("pointerdown", points[0]);
    for (const point of points.slice(1, 20)) emit("pointermove", point);
  }, points);
  expect((await snapshot(page)).recognitionCalls).toBe(0);
  expect((await snapshot(page)).active).not.toBeNull();
});

test("pointercancel preserves ink", async ({ page }) => {
  await drawFixture(page, "clean-circle-64", { ending: "pointercancel" });
  const state = await snapshot(page);
  expect(state.recognitionCalls).toBe(0);
  expect(state.active).toBeNull();
  expect(state.elements[0].type).toBe("stroke");
  expect(state.elements[0].points.length).toBeGreaterThan(1);
});

test("lost capture preserves ink", async ({ page }) => {
  const points = pointsFor("clean-circle-64").slice(0, 20);
  await drawPoints(page, points, { ending: "lostpointercapture" });
  const state = await snapshot(page);
  expect(state.recognitionCalls).toBe(0);
  expect(state.active).toBeNull();
  expect(state.elements[0].points.length).toBeGreaterThan(1);
});

test("competing pointers", async ({ page }) => {
  await page.locator("#drawing-canvas").evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    const emit = (type, pointerId, x, y, isPrimary) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, pointerType: "touch", isPrimary, buttons: type === "pointerup" ? 0 : 1, clientX: rect.left + x, clientY: rect.top + y }));
    emit("pointerdown", 1, 100, 100, true);
    emit("pointerdown", 2, 300, 300, false);
    emit("pointermove", 2, 350, 350, false);
    emit("pointerup", 2, 400, 400, false);
    emit("pointermove", 1, 120, 120, true);
    emit("pointerup", 1, 140, 140, true);
  });
  const state = await snapshot(page);
  expect(state.elements).toHaveLength(1);
  expect(state.elements[0].points.every(({ x, y }) => x < 200 && y < 200)).toBeTruthy();
  expect(state.recognitionCalls).toBe(1);
});

test("unmatched pointer events", async ({ page }) => {
  const before = await snapshot(page);
  await page.locator("#drawing-canvas").dispatchEvent("pointermove", { pointerId: 8, pointerType: "mouse", isPrimary: true, clientX: 20, clientY: 20 });
  await page.locator("#drawing-canvas").dispatchEvent("pointerup", { pointerId: 8, pointerType: "mouse", isPrimary: true, clientX: 30, clientY: 30 });
  expect(await snapshot(page)).toEqual(before);
});

test("non-finite pointer coordinates", async ({ page }) => {
  await page.locator("#drawing-canvas").evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    const start = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "pen", isPrimary: true, clientX: rect.left + 50, clientY: rect.top + 50 });
    canvas.dispatchEvent(start);
    const bad = new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "pen", isPrimary: true });
    Object.defineProperty(bad, "clientX", { value: Number.NaN });
    Object.defineProperty(bad, "clientY", { value: 80 });
    canvas.dispatchEvent(bad);
    canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "pen", isPrimary: true, clientX: rect.left + 90, clientY: rect.top + 90 }));
  });
  const state = await snapshot(page);
  expect(state.recognitionCalls).toBe(0);
  expect(state.active).toBeNull();
  expect(state.elements[0].points.length).toBeGreaterThan(0);
});

test("bounded extreme stroke", async ({ page }) => {
  await page.locator("#drawing-canvas").evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    const emit = (type, index) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "pen", isPrimary: true, buttons: type === "pointerup" ? 0 : 1, clientX: rect.left + 20 + index % 300, clientY: rect.top + 20 + index % 200 }));
    emit("pointerdown", 0);
    for (let index = 1; index <= 4097; index += 1) emit("pointermove", index);
    emit("pointerup", 4098);
  });
  const state = await snapshot(page);
  expect(state.elements[0].points).toHaveLength(4096);
  expect(state.recognitionCalls).toBe(0);
  expect(state.active).toBeNull();
});

test("pointer lifecycle recovery", async ({ page }) => {
  let pointerId = 20;
  const proveRecovery = async () => {
    const callsBefore = (await snapshot(page)).recognitionCalls;
    pointerId += 1;
    await drawFixture(page, "clean-circle-64", { pointerId });
    const recovered = await snapshot(page);
    expect(recovered.active).toBeNull();
    expect(recovered.recognitionCalls).toBe(callsBefore + 1);
    expect(recovered.elements.some((element) => element.type === "icon")).toBeTruthy();
    await clear(page);
  };

  await drawFixture(page, "clean-circle-64", { pointerId: 1, ending: "pointercancel" });
  await proveRecovery();
  await drawPoints(page, pointsFor("clean-circle-64").slice(0, 20), { pointerId: 2, ending: "lostpointercapture" });
  await proveRecovery();
  await page.locator("#drawing-canvas").evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 3, pointerType: "pen", isPrimary: true, clientX: rect.left + 20, clientY: rect.top + 20 }));
    const bad = new PointerEvent("pointermove", { bubbles: true, pointerId: 3, pointerType: "pen", isPrimary: true });
    Object.defineProperty(bad, "clientX", { value: Number.NaN });
    canvas.dispatchEvent(bad);
    canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 3, pointerType: "pen", isPrimary: true, clientX: rect.left + 30, clientY: rect.top + 30 }));
  });
  await proveRecovery();
  await page.locator("#drawing-canvas").evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    const emit = (type, id, isPrimary) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: "touch", isPrimary, clientX: rect.left + id * 10, clientY: rect.top + id * 10 }));
    emit("pointerdown", 4, true);
    emit("pointerdown", 5, false);
    emit("pointermove", 5, false);
    emit("pointerup", 5, false);
    emit("pointerup", 4, true);
  });
  await proveRecovery();
  await page.locator("#drawing-canvas").dispatchEvent("pointerup", { pointerId: 99, pointerType: "mouse", isPrimary: true, clientX: 10, clientY: 10 });
  await proveRecovery();
  await page.locator("#drawing-canvas").evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    const emit = (type, index) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 6, pointerType: "pen", isPrimary: true, clientX: rect.left + index % 200, clientY: rect.top + index % 100 }));
    emit("pointerdown", 0);
    for (let index = 1; index <= 4097; index += 1) emit("pointermove", index);
    emit("pointerup", 4098);
  });
  await proveRecovery();
});

test("real CSS geometry wide-canvas mapping", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 950 });
  const canvas = await page.locator("#drawing-canvas").boundingBox();
  expect(canvas.width / canvas.height).toBeGreaterThan(2);

  for (const [fixture, icon] of [["clean-circle-64", "router"], ["clean-rectangle-64", "lan"], ["clean-cloud-64", "cloud"]]) {
    await drawFixture(page, fixture, { scale: 0.75, offsetX: 0.1, offsetY: 0.05 });
    const state = await snapshot(page);
    expect(state.elements).toHaveLength(1);
    expect(state.elements[0].type).toBe("icon");
    expect(state.elements[0].icon.id).toBe(icon);
    expect(state.suggestion).toBeNull();
    await clear(page);
  }
});

test("high-confidence replacement mapping", async ({ page }) => {
  for (const [fixture, icon] of [["clean-circle-64", "router"], ["clean-rectangle-64", "lan"], ["clean-cloud-64", "cloud"]]) {
    await drawFixture(page, fixture);
    const state = await snapshot(page);
    expect(state.elements.at(-1).type).toBe("icon");
    expect(state.elements.at(-1).icon.id).toBe(icon);
    expect(state.suggestion).toBeNull();
    await clear(page);
  }
});

test("automatic replacement undo", async ({ page }) => {
  for (const fixture of ["clean-circle-64", "clean-rectangle-64", "clean-cloud-64"]) {
    await drawFixture(page, fixture);
    const source = (await snapshot(page)).elements[0].sourcePoints;
    await page.locator("#undo").click();
    expect((await snapshot(page)).elements[0].points).toEqual(source);
    await clear(page);
  }
});

test("medium suggestion preserves source", async ({ page }) => {
  await drawFixture(page, "distorted-circle-seed-104729");
  const state = await snapshot(page);
  expect(state.suggestion).not.toBeNull();
  expect(state.elements[0].points).toEqual(state.suggestion.sourcePoints);
});

test("single pending suggestion", async ({ page }) => {
  await drawFixture(page, "distorted-circle-seed-104729");
  await drawFixture(page, "distorted-cloud-seed-104761", { pointerId: 2 });
  expect(await page.locator(".suggestion").count()).toBe(1);
  expect((await snapshot(page)).suggestion.category).toBe("cloud");
});

test("medium suggestion accepts", async ({ page }) => {
  for (const [fixture, icon] of [["distorted-circle-seed-104729", "router"], ["distorted-rectangle-seed-104759", "lan"], ["distorted-cloud-seed-104761", "cloud"]]) {
    await drawFixture(page, fixture);
    expect((await snapshot(page)).elements[0].type).toBe("stroke");
    await page.locator('[data-action="accept"]').click();
    expect((await snapshot(page)).elements[0].icon.id).toBe(icon);
    await clear(page);
  }
});

test("accepted replacement undo", async ({ page }) => {
  for (const fixture of ["distorted-circle-seed-104729", "distorted-rectangle-seed-104759", "distorted-cloud-seed-104761"]) {
    await drawFixture(page, fixture);
    const source = (await snapshot(page)).elements[0].points;
    await page.locator('[data-action="accept"]').click();
    await page.locator("#undo").click();
    expect((await snapshot(page)).elements[0].points).toEqual(source);
    await clear(page);
  }
});

test("medium suggestion dismisses", async ({ page }) => {
  await drawFixture(page, "distorted-circle-seed-104729");
  const source = (await snapshot(page)).elements[0].points;
  await page.locator('[data-action="dismiss"]').click();
  const state = await snapshot(page);
  expect(state.suggestion).toBeNull();
  expect(state.elements[0].points).toEqual(source);
});

test("new stroke dismisses suggestion", async ({ page }) => {
  await drawFixture(page, "distorted-circle-seed-104729");
  const source = (await snapshot(page)).elements[0].points;
  await page.locator("#drawing-canvas").dispatchEvent("pointerdown", { pointerId: 2, pointerType: "touch", isPrimary: true, clientX: 40, clientY: 80 });
  const state = await snapshot(page);
  expect(state.suggestion).toBeNull();
  expect(state.elements[0].points).toEqual(source);
});

test("undo dismisses suggestion", async ({ page }) => {
  await drawFixture(page, "distorted-circle-seed-104729");
  const before = (await snapshot(page)).elements;
  await page.locator("#undo").click();
  const state = await snapshot(page);
  expect(state.suggestion).toBeNull();
  expect(state.elements).toEqual(before);
});

test("clear canvas content", async ({ page }) => {
  await drawFixture(page, "clean-circle-64");
  await clear(page);
  expect((await snapshot(page)).elements).toHaveLength(0);
  expect(await page.locator(".replacement-icon").count()).toBe(0);
});

test("clear pending suggestion", async ({ page }) => {
  await drawFixture(page, "distorted-circle-seed-104729");
  await clear(page);
  expect((await snapshot(page)).suggestion).toBeNull();
  expect(await page.locator(".suggestion").count()).toBe(0);
});

test("low confidence preserves ink", async ({ page }) => {
  await drawFixture(page, "triangle");
  const state = await snapshot(page);
  expect(state.elements[0].type).toBe("stroke");
  expect(state.suggestion).toBeNull();
});

test("ambiguous input preserves ink", async ({ page }) => {
  await mountHarness(page, { result: { status: "ambiguous", category: null, confidence: 0.9 } });
  await drawFixture(page, "clean-circle-64");
  expect((await snapshot(page)).elements[0].type).toBe("stroke");
});

test("unrecognized input preserves ink", async ({ page }) => {
  await drawFixture(page, "scribble");
  expect((await snapshot(page)).elements[0].type).toBe("stroke");
  expect((await snapshot(page)).suggestion).toBeNull();
});

test("replacement center", async ({ page }) => {
  await drawFixture(page, "clean-rectangle-64");
  const icon = (await snapshot(page)).elements[0];
  expect(Math.abs(icon.layout.centerX - (icon.layout.source.minX + icon.layout.source.maxX) / 2)).toBeLessThan(0.01);
  expect(Math.abs(icon.layout.centerY - (icon.layout.source.minY + icon.layout.source.maxY) / 2)).toBeLessThan(0.01);
});

test("replacement aspect fit", async ({ page }) => {
  await drawFixture(page, "clean-rectangle-64");
  const { layout } = (await snapshot(page)).elements[0];
  expect(layout.width / layout.height).toBeCloseTo(1, 5);
  expect(layout.width).toBeLessThanOrEqual(layout.source.width * 0.8 + 0.01);
  expect(layout.height).toBeLessThanOrEqual(layout.source.height * 0.8 + 0.01);
});

test("minimum replacement size", async ({ page }) => {
  await drawFixture(page, "clean-circle-64", { scale: 0.02, offsetX: 0.45, offsetY: 0.45 });
  const { layout } = (await snapshot(page)).elements[0];
  expect(layout.width).toBeGreaterThanOrEqual(48);
  expect(layout.height).toBeGreaterThanOrEqual(48);
});

test("suggestion distance", async ({ page }) => {
  await drawFixture(page, "distorted-circle-seed-104729");
  const state = await snapshot(page);
  const geometry = await page.locator(".suggestion").evaluate((element) => {
    const group = element.getBoundingClientRect();
    const canvas = document.querySelector("#drawing-canvas").getBoundingClientRect();
    return { left: group.left - canvas.left, right: group.right - canvas.left, top: group.top - canvas.top, bottom: group.bottom - canvas.top };
  });
  const source = state.suggestion.sourcePoints;
  const minX = Math.min(...source.map(({ x }) => x));
  const maxX = Math.max(...source.map(({ x }) => x));
  const minY = Math.min(...source.map(({ y }) => y));
  const maxY = Math.max(...source.map(({ y }) => y));
  const horizontal = geometry.left > maxX ? geometry.left - maxX : minX > geometry.right ? minX - geometry.right : 0;
  const vertical = geometry.top > maxY ? geometry.top - maxY : minY > geometry.bottom ? minY - geometry.bottom : 0;
  expect(Math.hypot(horizontal, vertical)).toBeLessThanOrEqual(16.01);
});

test("suggestion edge clamp", async ({ page }) => {
  const edgePositions = [
    { offsetX: 0, offsetY: 0.4 },
    { offsetX: 0.84, offsetY: 0.4 },
    { offsetX: 0.4, offsetY: 0 },
    { offsetX: 0.4, offsetY: 0.84 },
  ];
  for (const position of edgePositions) {
    await drawFixture(page, "distorted-circle-seed-104729", { scale: 0.15, ...position });
    const contained = await page.locator(".suggestion").evaluate((element) => {
      const group = element.getBoundingClientRect();
      const canvas = document.querySelector("#drawing-canvas").getBoundingClientRect();
      return group.left >= canvas.left && group.top >= canvas.top && group.right <= canvas.right && group.bottom <= canvas.bottom;
    });
    expect(contained).toBeTruthy();
    await clear(page);
  }
});

test("touch targets and viewports", async ({ page }) => {
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(viewport);
    await clear(page);
    await drawFixture(page, "distorted-circle-seed-104729");
    for (const selector of ["#undo", "#clear", '[data-action="accept"]', '[data-action="dismiss"]']) {
      const box = await page.locator(selector).boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
});

test("pointer types", async ({ page }) => {
  for (const [index, pointerType] of ["mouse", "touch", "pen"].entries()) {
    await drawFixture(page, "clean-circle-64", { pointerId: index + 1, pointerType });
    expect((await snapshot(page)).elements[0].type).toBe("icon");
    await clear(page);
  }
});

test("unaltered production assets", async ({ page }) => {
  await drawFixture(page, "clean-circle-64");
  const appearance = await page.locator(".replacement-icon").evaluate((image) => {
    const style = getComputedStyle(image);
    return { src: image.getAttribute("src"), filter: style.filter, mask: style.maskImage, html: image.outerHTML };
  });
  expect(appearance.src).toBe("./assets/material-symbols/router.svg");
  expect(appearance.filter).toBe("none");
  expect(appearance.mask).toBe("none");
  expect(appearance.html).not.toContain("<path");
});

test("no content transmission", async ({ page }) => {
  await page.evaluate(() => {
    window.__outboundCalls = 0;
    const count = () => { window.__outboundCalls += 1; };
    window.fetch = new Proxy(window.fetch, { apply(target, thisArg, args) { count(); return Reflect.apply(target, thisArg, args); } });
    navigator.sendBeacon = new Proxy(navigator.sendBeacon, { apply(target, thisArg, args) { count(); return Reflect.apply(target, thisArg, args); } });
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (...args) { count(); return originalOpen.apply(this, args); };
  });
  await drawFixture(page, "distorted-circle-seed-104729");
  await page.locator('[data-action="accept"]').click();
  await page.locator("#undo").click();
  await clear(page);
  expect(await page.evaluate(() => window.__outboundCalls)).toBe(0);
});

test("no persistence", async ({ page }) => {
  await page.evaluate(() => {
    window.__persistenceWrites = 0;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (...args) { window.__persistenceWrites += 1; return original.apply(this, args); };
    const originalIndexedDbOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = function (...args) { window.__persistenceWrites += 1; return originalIndexedDbOpen(...args); };
    const originalCacheOpen = caches.open.bind(caches);
    caches.open = function (...args) { window.__persistenceWrites += 1; return originalCacheOpen(...args); };
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (cookie?.set) Object.defineProperty(document, "cookie", { configurable: true, set(value) { window.__persistenceWrites += 1; return cookie.set.call(document, value); } });
  });
  await drawFixture(page, "distorted-circle-seed-104729");
  await page.locator('[data-action="dismiss"]').click();
  await clear(page);
  expect(await page.evaluate(() => window.__persistenceWrites)).toBe(0);
});

test("no native service calls", async ({ page }) => {
  await page.evaluate(() => {
    window.__nativeCalls = 0;
    window.xapi = new Proxy({}, { get() { window.__nativeCalls += 1; return () => {}; } });
    window.webex = new Proxy({}, { get() { window.__nativeCalls += 1; return () => {}; } });
  });
  await drawFixture(page, "clean-circle-64");
  await page.locator("#undo").click();
  await clear(page);
  expect(await page.evaluate(() => window.__nativeCalls)).toBe(0);
});
