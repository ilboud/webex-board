import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { confidenceBand, DEFAULT_CONFIDENCE, validateConfidenceConfig } from "../../src/confidence-config.js";
import { planReplacement } from "../../src/drawing-surface.js";
import { createIconCatalog, productionIconCatalog } from "../../src/icon-catalog.js";
import { recognizeStroke, resolveCandidateScores } from "../../src/stroke-recognizer.js";

const corpus = JSON.parse(readFileSync(new URL("../fixtures/recognition-corpus.json", import.meta.url)));
const fixture = (id) => corpus.fixtures.find((item) => item.id === id);
const bandOf = (result) => confidenceBand(result.confidence, DEFAULT_CONFIDENCE);

test("clean recognition corpus", () => {
  for (const category of ["circle", "rectangle", "cloud"]) {
    const result = recognizeStroke(fixture(`clean-${category}-64`).points);
    assert.equal(result.category, category);
    assert.equal(bandOf(result), "high");
  }
});

test("seeded medium recognition corpus", () => {
  for (const [category, seed] of [["circle", 104729], ["rectangle", 104759], ["cloud", 104761]]) {
    const points = fixture(`distorted-${category}-seed-${seed}`).points;
    const first = recognizeStroke(points);
    const second = recognizeStroke(points);
    assert.deepEqual(second, first);
    assert.equal(first.category, category);
    assert.equal(bandOf(first), "medium");
  }
});

test("open recognition corpus", () => {
  for (const category of ["circle", "rectangle", "cloud"]) {
    const result = recognizeStroke(fixture(`open-${category}`).points);
    assert.ok(result.status === "unrecognized" || bandOf(result) === "low");
  }
});

test("exact recognition tie", () => {
  const result = resolveCandidateScores(fixture("exact-circle-rectangle-tie").candidateScores);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.category, null);
  assert.equal(result.confidence, 0.9);
});

test("unsupported recognition corpus", () => {
  for (const id of ["triangle", "scribble"]) {
    const result = recognizeStroke(fixture(id).points);
    assert.ok(result.status === "unrecognized" || bandOf(result) === "low");
  }
});

test("malformed recognition corpus", () => {
  for (const id of ["empty", "one-point", "non-finite-coordinate", "out-of-range-coordinate"]) {
    const result = recognizeStroke(fixture(id).points);
    assert.equal(result.status, "unrecognized");
    assert.equal(result.category, null);
  }
});

test("minimum point boundary", () => {
  assert.equal(recognizeStroke(fixture("fifteen-point").points).status, "unrecognized");
  assert.equal(recognizeStroke(fixture("sixteen-point-circle").points).category, "circle");
});

test("default confidence boundaries", () => {
  for (const expectation of corpus.confidencePolicy) {
    assert.equal(confidenceBand(expectation.score), expectation.band);
  }
});

test("alternate confidence thresholds", () => {
  const alternate = validateConfidenceConfig({ mediumThreshold: 0.4, highThreshold: 0.7 });
  assert.deepEqual(alternate, { mediumThreshold: 0.4, highThreshold: 0.7 });
  assert.equal(confidenceBand(0.4, alternate), "low");
  assert.equal(confidenceBand(0.4000001, alternate), "medium");
  assert.equal(confidenceBand(0.7, alternate), "medium");
  assert.equal(confidenceBand(0.7000001, alternate), "high");
});

test("invalid confidence thresholds", () => {
  for (const config of [
    { mediumThreshold: -1, highThreshold: 0.8 },
    { mediumThreshold: 0.9, highThreshold: 0.8 },
    { mediumThreshold: 0.8, highThreshold: 0.8 },
    { mediumThreshold: 0.6, highThreshold: 1.1 },
    { mediumThreshold: "0.6", highThreshold: 0.8 },
    { mediumThreshold: Number.NaN, highThreshold: 0.8 },
  ]) assert.equal(validateConfidenceConfig(config), null);
});

test("icon catalog substitution", () => {
  const sourceStroke = [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }];
  const fixtureCatalog = createIconCatalog({ circle: { id: "fixture-router", src: "./fixture.svg", aspectRatio: 2 } });
  assert.equal(planReplacement(productionIconCatalog, "circle", sourceStroke).icon.id, "router");
  assert.deepEqual(planReplacement(fixtureCatalog, "circle", sourceStroke), {
    category: "circle",
    icon: { id: "fixture-router", src: "./fixture.svg", aspectRatio: 2 },
    sourcePoints: sourceStroke,
  });
  assert.equal(fixtureCatalog.lookup("cloud"), null);
});

test("missing icon mapping", () => {
  const sourceStroke = [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }];
  const original = structuredClone(sourceStroke);
  const fixtureCatalog = createIconCatalog({});
  assert.equal(planReplacement(fixtureCatalog, "circle", sourceStroke), null);
  assert.deepEqual(sourceStroke, original);
});
