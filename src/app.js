import { CONFIDENCE_CONFIG } from "./confidence-config.js";
import { createDrawingSurface } from "./drawing-surface.js";
import { productionIconCatalog } from "./icon-catalog.js";
import { recognizeStroke } from "./stroke-recognizer.js";

const whiteboard = createDrawingSurface({
  canvas: document.querySelector("#drawing-canvas"),
  surface: document.querySelector("#drawing-surface"),
  undoButton: document.querySelector("#undo"),
  clearButton: document.querySelector("#clear"),
  recognizer: recognizeStroke,
  confidenceConfig: CONFIDENCE_CONFIG,
  catalog: productionIconCatalog,
});

// Read-only state supports deterministic local verification without changing the interaction contract.
window.__whiteboardDebug = Object.freeze({ snapshot: whiteboard.snapshot });
