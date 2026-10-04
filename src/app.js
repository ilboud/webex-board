import { CONFIDENCE_CONFIG } from "./confidence-config.js";
import { createDrawingSurface, DRAWING_TOOLS } from "./drawing-surface.js";
import { createExternalIconLibrary } from "./external-icon-library.js";
import { productionIconCatalog } from "./icon-catalog.js";
import { DEPLOYMENT_ICON_LIBRARIES } from "./library-config.js";
import { recognizeStrokeGroup } from "./stroke-recognizer.js";

const elements = Object.freeze({
  canvas: document.querySelector("#drawing-canvas"),
  surface: document.querySelector("#drawing-surface"),
  undoButton: document.querySelector("#undo"),
  clearButton: document.querySelector("#clear"),
  colorInput: document.querySelector("#stroke-color"),
  deleteButton: document.querySelector("#delete-icon"),
  labelButton: document.querySelector("#edit-label"),
  labelInput: document.querySelector("#icon-label-input"),
  drawer: document.querySelector("#icon-drawer"),
  drawerToggle: document.querySelector("#drawer-toggle"),
  workspace: document.querySelector(".workspace"),
  search: document.querySelector("#icon-search"),
  filters: document.querySelector("#library-filters"),
  status: document.querySelector("#library-status"),
  grid: document.querySelector("#icon-grid"),
});

const whiteboard = createDrawingSurface({
  ...elements,
  toolButtons: {
    [DRAWING_TOOLS.NORMAL]: document.querySelector("#tool-normal"),
    [DRAWING_TOOLS.MAGIC]: document.querySelector("#tool-magic"),
    [DRAWING_TOOLS.SELECT]: document.querySelector("#tool-select"),
  },
  recognizer: recognizeStrokeGroup,
  confidenceConfig: CONFIDENCE_CONFIG,
  catalog: productionIconCatalog,
});

const externalLibraries = createExternalIconLibrary();
let externalSnapshot = externalLibraries.getSnapshot();
let selectedScope = "all";
let destroyed = false;

function libraryScope(library) {
  return `external:${library.configIndex}`;
}

function libraryName(library) {
  return library.label || `External library ${library.configIndex + 1}`;
}

function allDrawerItems() {
  const builtIns = productionIconCatalog.list().map((descriptor) => ({
    key: `built-in:${descriptor.id}`,
    scope: "built-in",
    descriptor,
    usable: true,
  }));
  const external = externalSnapshot.libraries.flatMap((library) => [
    ...library.icons.map((descriptor) => ({
      key: `external:${descriptor.libraryId}:${descriptor.id}`,
      scope: libraryScope(library),
      descriptor,
      usable: true,
    })),
    ...library.iconErrors.map((error) => ({
      key: `external-error:${library.configIndex}:${error.id}`,
      scope: libraryScope(library),
      descriptor: { id: error.id, label: `Unavailable icon ${error.id}`, keywords: [], src: "", aspectRatio: 1 },
      usable: false,
    })),
  ]);
  return [...builtIns, ...external];
}

function matchesQuery(descriptor, query) {
  if (!query) return true;
  const values = [descriptor.label, ...(descriptor.keywords ?? [])];
  return values.some((value) => value.normalize("NFKC").toLocaleLowerCase().includes(query));
}

function controlIcon(filename) {
  const image = document.createElement("img");
  image.src = `./assets/heroicons/controls/${filename}`;
  image.alt = "";
  return image;
}

function renderFilters() {
  elements.filters.replaceChildren();
  const scopes = [
    { id: "all", label: "All Icons" },
    { id: "built-in", label: "Built-in" },
    ...externalSnapshot.libraries.map((library) => ({ id: libraryScope(library), label: libraryName(library) })),
  ];
  if (!scopes.some(({ id }) => id === selectedScope)) selectedScope = "all";
  for (const scope of scopes) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = scope.label;
    button.dataset.scope = scope.id;
    button.setAttribute("aria-pressed", String(scope.id === selectedScope));
    button.addEventListener("click", () => {
      selectedScope = scope.id;
      renderDrawer();
    });
    elements.filters.append(button);
  }
}

function renderStatus() {
  const messages = externalSnapshot.libraries.map((library) => `${libraryName(library)}: ${library.status}. ${library.message}`);
  elements.status.textContent = messages.join(" ");
}

function renderTiles() {
  elements.grid.replaceChildren();
  const query = elements.search.value.normalize("NFKC").trim().toLocaleLowerCase();
  const items = allDrawerItems().filter((item) => (
    (selectedScope === "all" || item.scope === selectedScope) && matchesQuery(item.descriptor, query)
  ));
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-results";
    empty.textContent = "No icons found.";
    elements.grid.append(empty);
    return;
  }
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-tile";
    button.dataset.iconKey = item.key;
    button.disabled = !item.usable;
    if (item.usable) {
      const image = document.createElement("img");
      image.src = item.descriptor.renderSrc ?? item.descriptor.src;
      image.alt = "";
      button.append(image);
      button.addEventListener("click", () => whiteboard.insertIcon(item.descriptor));
    }
    const label = document.createElement("span");
    label.textContent = item.descriptor.label;
    button.append(label);
    elements.grid.append(button);
  }
}

function renderDrawer() {
  if (destroyed) return;
  renderFilters();
  renderStatus();
  renderTiles();
}

function toggleDrawer() {
  const collapsed = elements.workspace.classList.toggle("drawer-collapsed");
  elements.drawerToggle.setAttribute("aria-expanded", String(!collapsed));
  elements.drawerToggle.setAttribute("aria-label", collapsed ? "Expand icon drawer" : "Collapse icon drawer");
  elements.drawerToggle.replaceChildren(controlIcon(collapsed ? "chevron-right.svg" : "chevron-left.svg"));
  whiteboard.resize();
}

elements.drawerToggle.addEventListener("click", toggleDrawer);
elements.search.addEventListener("input", renderTiles);
const unsubscribe = externalLibraries.subscribe((snapshot) => {
  externalSnapshot = snapshot;
  renderDrawer();
});
renderDrawer();
externalLibraries.replace(DEPLOYMENT_ICON_LIBRARIES).catch(() => {
  // The loader publishes bounded per-library failures. An empty configuration settles without error.
});

function destroy() {
  if (destroyed) return;
  destroyed = true;
  unsubscribe();
  window.removeEventListener("pagehide", destroy);
  elements.drawerToggle.removeEventListener("click", toggleDrawer);
  elements.search.removeEventListener("input", renderTiles);
  whiteboard.destroy();
  elements.grid.replaceChildren();
  elements.filters.replaceChildren();
  elements.status.replaceChildren();
  externalSnapshot = Object.freeze({ generation: externalSnapshot.generation, destroyed: true, reservedBytes: 0, retainedBytes: 0, libraries: Object.freeze([]) });
  externalLibraries.destroy();
}

window.addEventListener("pagehide", destroy, { once: true });
// Read-only state and lifecycle controls support deterministic local verification.
window.__whiteboardDebug = Object.freeze({
  snapshot: whiteboard.snapshot,
  externalSnapshot: () => externalSnapshot,
  destroy,
});
