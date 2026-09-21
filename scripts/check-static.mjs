import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const text = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const html = await text("index.html");
const app = await text("src/app.js");
const drawing = await text("src/drawing-surface.js");
const recognizer = await text("src/stroke-recognizer.js");
const catalog = await text("src/icon-catalog.js");
const config = await text("src/confidence-config.js");
const workflow = await text(".github/workflows/pages.yml");
const readme = await text("README.md");
const notices = await text("THIRD_PARTY_NOTICES.md");
const exemplars = await text("docs/recognition-exemplars.md");
const corpusText = await text("tests/fixtures/recognition-corpus.json");
const corpus = JSON.parse(corpusText);

assert.match(html, /<script type="module" src="\.\/src\/app\.js"><\/script>/, "entry point must load the static ES module");
assert.doesNotMatch(html, /(?:src|href)="\/(?!\/)/, "browser-loaded local paths must be repository-subpath safe");
for (const localPath of ["styles.css", "src/app.js", "src/drawing-surface.js", "src/stroke-recognizer.js", "src/confidence-config.js", "src/icon-catalog.js"]) {
  await readFile(new URL(`../${localPath}`, import.meta.url));
}

const indexButtons = [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((match) => match[1].trim()).sort();
assert.deepEqual(indexButtons, ["Clear", "Undo"], "only Undo and Clear may be persistent controls");
const createdButtonLabels = [...drawing.matchAll(/\.textContent = "([^"]+)"/g)].map((match) => match[1]).sort();
assert.deepEqual(createdButtonLabels, ["Accept", "Dismiss"], "only Accept and Dismiss may be contextual controls");
assert.doesNotMatch(html, /settings|threshold|catalog|upload|import|export|collaboration|plugin/i, "unapproved product control found");

for (const [name, source] of [["app", app], ["drawing", drawing], ["recognizer", recognizer], ["catalog", catalog]]) {
  assert.doesNotMatch(source, /mediumThreshold\s*:/, `${name} duplicates confidence values`);
  assert.doesNotMatch(source, /(?:URLSearchParams|location\.search|localStorage|sessionStorage|indexedDB|caches\.|document\.cookie)/, `${name} adds runtime configuration or persistence`);
}
assert.match(config, /mediumThreshold:\s*0\.65/);
assert.match(config, /highThreshold:\s*0\.85/);
assert.match(config, /mediumThreshold\s*>=\s*highThreshold/);

for (const source of [app, drawing, recognizer, catalog, config]) {
  assert.doesNotMatch(source, /tests\/fixtures|recognition-corpus/, "production source imports the fixture oracle");
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|xapi|webex)\b/i, "client source contains an external-service call surface");
}
assert.equal(corpus.schemaVersion, 1);
assert.ok(corpus.fixtures.every((fixture) => Array.isArray(fixture.points)), "fixture points must be literal arrays");
for (const id of ["clean-circle-64", "clean-rectangle-64", "clean-cloud-64", "distorted-circle-seed-104729", "distorted-rectangle-seed-104759", "distorted-cloud-seed-104761"]) {
  assert.ok(corpus.fixtures.some((fixture) => fixture.id === id), `missing frozen fixture ${id}`);
}
assert.ok(corpusText.length > 50_000, "fixture corpus unexpectedly lacks literal point data");

assert.match(workflow, /^on:\n  workflow_dispatch:\s*$/m, "workflow_dispatch must be present");
assert.doesNotMatch(workflow, /^  (?:push|pull_request|pull_request_target|schedule|workflow_run|workflow_call):/m, "automatic workflow event found");
assert.doesNotMatch(workflow, /secrets\s*[.[]/i, "workflow must not reference secrets");
const permissionBlock = workflow.match(/permissions:\n((?:  [^\n]+\n){3})/);
assert.ok(permissionBlock, "expected exact workflow permission block");
assert.deepEqual(permissionBlock[1].trim().split("\n").map((line) => line.trim()).sort(), ["contents: read", "id-token: write", "pages: write"].sort());

const approvedActions = [
  "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
  "actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b",
  "actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa",
  "actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e",
].sort();
const actionRefs = [...workflow.matchAll(/(?:uses:\s*(?:>-\s*)?\n?\s*)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40})/g)].map((match) => match[1]).sort();
assert.deepEqual(actionRefs, approvedActions, "workflow action references differ from the approved immutable set");
assert.equal([...workflow.matchAll(/\buses:/g)].length, 4, "workflow must contain exactly four actions");

const stagedSources = [...workflow.matchAll(/^\s+cp\s+(.+?)\s+_site(?:\/[^\s]*)?\s*$/gm)]
  .flatMap((match) => match[1].trim().split(/\s+/)).sort();
const expectedStagedSources = [
  "index.html", "styles.css", "THIRD_PARTY_NOTICES.md",
  "src/app.js", "src/drawing-surface.js", "src/stroke-recognizer.js", "src/confidence-config.js", "src/icon-catalog.js",
  "assets/material-symbols/router.svg", "assets/material-symbols/lan.svg", "assets/material-symbols/cloud.svg",
  "LICENSES/Apache-2.0.txt",
].sort();
assert.deepEqual(stagedSources, expectedStagedSources, "Pages staging allowlist changed");

for (const required of ["Google Material Symbols", "Apache License", "asset-manifest.json", "LICENSES/Apache-2.0.txt"]) {
  assert.ok(`${readme}\n${notices}`.includes(required), `documentation missing ${required}`);
}
assert.match(readme, /Run locally/);
assert.match(readme, /Desk Pro Web App/);
assert.match(readme, /recognition-exemplars\.md/);
assert.doesNotMatch(`${readme}\n${notices}\n${exemplars}`, /native Webex Whiteboard|Magic Pen/i, "documentation makes a forbidden integration claim");
for (const id of ["clean-circle-64", "clean-rectangle-64", "clean-cloud-64", "distorted-circle-seed-104729", "distorted-rectangle-seed-104759", "distorted-cloud-seed-104761"]) {
  assert.ok(exemplars.includes(`\`${id}\``), `exemplar guide missing ${id}`);
}
for (const guidance of ["Start at", "clockwise", "top-left", "five", "stroke order", "Accept", "Dismiss"]) {
  assert.match(exemplars, new RegExp(guidance, "i"), `exemplar guide missing human guidance: ${guidance}`);
}

const runtimeFiles = await readdir(new URL("../src", import.meta.url));
assert.deepEqual(runtimeFiles.sort(), ["app.js", "confidence-config.js", "drawing-surface.js", "icon-catalog.js", "stroke-recognizer.js"]);
console.log("static entry point, boundaries, documentation, fixtures, and inert Pages workflow verified");
