const INSERTION_LONG_SIDE = 128;
const MIN_ICON_DIMENSION = 48;
const MAX_VIEWPORT_FRACTION = 0.4;
const RESIZE_HANDLE_SIZE = 44;
const LABEL_TEXT_SIZE = 16;
const MAX_LABEL_SCALARS = 64;
const RESIZE_CORNERS = Object.freeze(["northwest", "northeast", "southeast", "southwest"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const SCENE_GEOMETRY = Object.freeze({
  insertionLongSide: INSERTION_LONG_SIDE,
  minIconDimension: MIN_ICON_DIMENSION,
  maxViewportFraction: MAX_VIEWPORT_FRACTION,
  resizeHandleSize: RESIZE_HANDLE_SIZE,
  labelTextSize: LABEL_TEXT_SIZE,
  resizeCorners: RESIZE_CORNERS,
});

export const ICON_LABEL_POLICY = Object.freeze({ maxScalars: MAX_LABEL_SCALARS });

export function isValidIconLabel(value) {
  if (typeof value !== "string") return false;
  let scalars = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    if (codePoint >= 0xD800 && codePoint <= 0xDFFF) return false;
    scalars += 1;
    if (scalars > MAX_LABEL_SCALARS) return false;
  }
  return true;
}

function clonePlain(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("numeric data must be finite");
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) throw new TypeError("data must be acyclic plain data");

  seen.add(value);
  let clone;
  if (Array.isArray(value)) {
    clone = value.map((item) => clonePlain(item, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("data objects must be plain");
    clone = {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new TypeError("reserved object key");
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !("value" in property)) throw new TypeError("data properties must not be accessors");
      clone[key] = clonePlain(property.value, seen);
    }
  }
  seen.delete(value);
  return clone;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function applied(fields = {}) {
  return Object.freeze({ status: "applied", ...fields });
}

function rejected(reason) {
  return Object.freeze({ status: "rejected", reason });
}

function noOp(reason) {
  return Object.freeze({ status: "no-op", reason });
}

function validPoint(point) {
  return Boolean(point && typeof point === "object" && !Array.isArray(point)
    && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function validViewport(viewport) {
  return Boolean(viewport && typeof viewport === "object" && !Array.isArray(viewport)
    && Number.isFinite(viewport.width) && viewport.width > 0
    && Number.isFinite(viewport.height) && viewport.height > 0);
}

function copyViewport(viewport) {
  return { width: viewport.width, height: viewport.height };
}

function validElementId(id) {
  return (typeof id === "string" && id.length > 0)
    || (Number.isSafeInteger(id) && id >= 0);
}

function sameId(first, second) {
  return first === second;
}

function cloneElements(elements) {
  return clonePlain(elements);
}

function pointInside(box, point) {
  return point.x >= box.left && point.x <= box.left + box.width
    && point.y >= box.top && point.y <= box.top + box.height;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function clampBox(box, viewport) {
  return {
    left: clamp(box.left, 0, Math.max(0, viewport.width - box.width)),
    top: clamp(box.top, 0, Math.max(0, viewport.height - box.height)),
    width: box.width,
    height: box.height,
  };
}

function boxesEqual(first, second) {
  return first.left === second.left && first.top === second.top
    && first.width === second.width && first.height === second.height;
}

function maxLongSide(viewport) {
  return Math.min(viewport.width, viewport.height) * MAX_VIEWPORT_FRACTION;
}

function artworkDimensionsForLongSide(aspectRatio, longSide) {
  return aspectRatio >= 1
    ? { width: longSide, height: longSide / aspectRatio }
    : { width: longSide * aspectRatio, height: longSide };
}

function boxDimensionsForArtwork(artwork) {
  return {
    width: Math.max(MIN_ICON_DIMENSION, artwork.width),
    height: Math.max(MIN_ICON_DIMENSION, artwork.height),
  };
}

function centeredBox(centerX, centerY, dimensions, viewport) {
  return clampBox({
    left: centerX - dimensions.width / 2,
    top: centerY - dimensions.height / 2,
    ...dimensions,
  }, viewport);
}

function containedArtworkDimensions(box, aspectRatio) {
  return box.width / box.height >= aspectRatio
    ? { width: box.height * aspectRatio, height: box.height }
    : { width: box.width, height: box.width / aspectRatio };
}

function validateDescriptor(descriptor) {
  let copy;
  try {
    copy = clonePlain(descriptor);
  } catch {
    return null;
  }
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) return null;
  if (typeof copy.id !== "string" || copy.id.length === 0) return null;
  if (typeof copy.label !== "string" || typeof copy.src !== "string") return null;
  if (!Number.isFinite(copy.aspectRatio) || copy.aspectRatio <= 0) return null;
  if (copy.width !== undefined || copy.height !== undefined) {
    if (!Number.isFinite(copy.width) || copy.width <= 0 || !Number.isFinite(copy.height) || copy.height <= 0) return null;
    const intrinsicRatio = copy.width / copy.height;
    if (Math.abs(intrinsicRatio - copy.aspectRatio) > 1e-12 * Math.max(1, intrinsicRatio)) return null;
  }
  return copy;
}

function validateStroke(stroke) {
  let copy;
  try {
    copy = clonePlain(stroke);
  } catch {
    return null;
  }
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) return null;
  if (!validElementId(copy.id) || (copy.type !== undefined && copy.type !== "stroke")) return null;
  if (!Array.isArray(copy.points) || copy.points.length === 0 || !copy.points.every(validPoint)) return null;
  copy.type = "stroke";
  return copy;
}

function sourceBounds(strokes) {
  const points = strokes.flatMap((stroke) => stroke.points);
  if (points.length === 0 || !points.every(validPoint)) return null;
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

// This is the accepted POC source-centered 80%-bounds artwork policy.
// The selectable box wraps that artwork independently to enforce both minima.
function replacementBox(strokes, aspectRatio, viewport) {
  const source = sourceBounds(strokes);
  const maximum = maxLongSide(viewport);
  if (!source || maximum < MIN_ICON_DIMENSION) return null;

  let fitWidth = source.width * 0.8;
  let fitHeight = source.height * 0.8;
  if (fitWidth < MIN_ICON_DIMENSION || fitHeight < MIN_ICON_DIMENSION) {
    fitWidth = MIN_ICON_DIMENSION;
    fitHeight = MIN_ICON_DIMENSION;
  }
  let artwork = { width: fitWidth, height: fitWidth / aspectRatio };
  if (artwork.height > fitHeight) artwork = { width: fitHeight * aspectRatio, height: fitHeight };

  const artworkLongSide = Math.max(artwork.width, artwork.height);
  if (artworkLongSide > maximum) artwork = artworkDimensionsForLongSide(aspectRatio, maximum);

  const centerX = source.minX + source.width / 2;
  const centerY = source.minY + source.height / 2;
  return centeredBox(centerX, centerY, boxDimensionsForArtwork(artwork), viewport);
}

function insertionBox(aspectRatio, position, viewport) {
  const maximum = maxLongSide(viewport);
  if (maximum < MIN_ICON_DIMENSION) return null;
  const artwork = artworkDimensionsForLongSide(aspectRatio, Math.min(INSERTION_LONG_SIDE, maximum));
  return centeredBox(position.x, position.y, boxDimensionsForArtwork(artwork), viewport);
}

function resizeBox(active, point, viewport) {
  const { corner, originalBox, aspectRatio } = active;
  const west = corner === "northwest" || corner === "southwest";
  const north = corner === "northwest" || corner === "northeast";
  const horizontalDirection = west ? -1 : 1;
  const verticalDirection = north ? -1 : 1;
  const anchorX = west ? originalBox.left + originalBox.width : originalBox.left;
  const anchorY = north ? originalBox.top + originalBox.height : originalBox.top;
  const availableWidth = west ? anchorX : viewport.width - anchorX;
  const availableHeight = north ? anchorY : viewport.height - anchorY;

  const pointerDeltaX = horizontalDirection * (point.x - active.startPoint.x);
  const pointerDeltaY = verticalDirection * (point.y - active.startPoint.y);
  const projectedArtworkWidthDelta = (
    pointerDeltaX + pointerDeltaY / aspectRatio
  ) / (1 + 1 / (aspectRatio * aspectRatio));
  const originalArtwork = containedArtworkDimensions(originalBox, aspectRatio);
  const originalArtworkLongSide = Math.max(originalArtwork.width, originalArtwork.height);
  const requestedLongSide = originalArtworkLongSide + (aspectRatio >= 1
    ? projectedArtworkWidthDelta
    : projectedArtworkWidthDelta / aspectRatio);
  const anchoredMaximum = aspectRatio >= 1
    ? Math.min(maxLongSide(viewport), availableWidth, availableHeight * aspectRatio)
    : Math.min(maxLongSide(viewport), availableHeight, availableWidth / aspectRatio);
  const artworkLongSide = clamp(requestedLongSide, MIN_ICON_DIMENSION, anchoredMaximum);
  const dimensions = anchoredMaximum >= MIN_ICON_DIMENSION
    ? boxDimensionsForArtwork(artworkDimensionsForLongSide(aspectRatio, artworkLongSide))
    : {
      width: originalBox.width * anchoredMaximum / Math.max(originalBox.width, originalBox.height),
      height: originalBox.height * anchoredMaximum / Math.max(originalBox.width, originalBox.height),
    };
  return {
    left: west ? anchorX - dimensions.width : anchorX,
    top: north ? anchorY - dimensions.height : anchorY,
    ...dimensions,
  };
}

function reframeElements(elements, viewport) {
  for (const element of elements) {
    if (element.type !== "icon") continue;
    const longSide = Math.max(element.box.width, element.box.height);
    const maximum = maxLongSide(viewport);
    let box = element.box;
    if (longSide > maximum) {
      if (maximum >= MIN_ICON_DIMENSION) {
        const artwork = artworkDimensionsForLongSide(element.descriptor.aspectRatio, maximum);
        box = { left: box.left, top: box.top, ...boxDimensionsForArtwork(artwork) };
      } else {
        const scale = maximum / longSide;
        box = { left: box.left, top: box.top, width: box.width * scale, height: box.height * scale };
      }
    }
    element.box = clampBox(box, viewport);
  }
}

function snapshotElement(element) {
  const copy = clonePlain(element);
  if (copy.type === "icon") {
    copy.artworkFit = { mode: "contain", aspectRatio: copy.descriptor.aspectRatio };
    copy.labelTextSize = LABEL_TEXT_SIZE;
    copy.resizeHandleSize = RESIZE_HANDLE_SIZE;
    copy.labelPosition = {
      x: copy.box.left + copy.box.width / 2,
      y: copy.box.top + copy.box.height,
    };
  }
  return copy;
}

export function createScene({ viewport } = {}) {
  if (!validViewport(viewport)) throw new TypeError("scene viewport must have finite positive dimensions");

  let currentViewport = copyViewport(viewport);
  let elements = [];
  let selectedIconId = null;
  let activeGesture = null;
  let nextIconId = 1;
  const history = [];

  function elementIndex(id, type) {
    return elements.findIndex((element) => sameId(element.id, id) && (!type || element.type === type));
  }

  function idExists(id) {
    return elements.some((element) => sameId(element.id, id));
  }

  function freshIconId() {
    let id;
    do {
      id = `scene-icon-${nextIconId}`;
      nextIconId += 1;
    } while (idExists(id));
    return id;
  }

  function stateBefore() {
    return { elements: cloneElements(elements), selectedIconId };
  }

  function restore(before) {
    elements = cloneElements(before.elements);
    selectedIconId = before.selectedIconId;
  }

  function record(kind, before, details = {}) {
    history.push({ kind, before, ...details });
  }

  function activeRejection() {
    return activeGesture ? rejected("an icon gesture is active") : null;
  }

  function bringToFront(index) {
    if (index === elements.length - 1) return elements[index];
    const [element] = elements.splice(index, 1);
    elements.push(element);
    return element;
  }

  function beginGesture(kind, iconId, point, corner = null) {
    if (activeGesture) return rejected("a gesture is already active");
    if (!validPoint(point)) return rejected("gesture point must be finite");
    if (!validElementId(iconId)) return rejected("icon ID is invalid");
    const index = elementIndex(iconId, "icon");
    if (index < 0) return rejected("icon does not exist");
    if (kind === "move" && !pointInside(elements[index].box, point)) {
      return rejected("move must begin inside the icon");
    }
    if (kind === "resize" && !RESIZE_CORNERS.includes(corner)) return rejected("resize corner is invalid");

    const before = stateBefore();
    const icon = bringToFront(index);
    selectedIconId = icon.id;
    const token = Object.freeze(Object.create(null));
    activeGesture = {
      token,
      kind,
      iconId: icon.id,
      corner,
      startPoint: { x: point.x, y: point.y },
      originalBox: clonePlain(icon.box),
      aspectRatio: icon.descriptor.aspectRatio,
      before,
    };
    return applied({ token, gesture: kind });
  }

  function validCurrentToken(token) {
    return activeGesture && token === activeGesture.token;
  }

  function rollbackActive() {
    const active = activeGesture;
    if (!active) return false;
    activeGesture = null;
    restore(active.before);
    return true;
  }

  function snapshot() {
    return deepFreeze({
      elements: elements.map(snapshotElement),
      selectedIconId,
      activeGesture: activeGesture ? {
        kind: activeGesture.kind,
        iconId: activeGesture.iconId,
        ...(activeGesture.corner ? { corner: activeGesture.corner } : {}),
      } : null,
      hasActiveGesture: Boolean(activeGesture),
      viewport: copyViewport(currentViewport),
      historyDepth: history.filter((action) => !action.provisional).length,
      resizeHandleSize: RESIZE_HANDLE_SIZE,
      labelTextSize: LABEL_TEXT_SIZE,
    });
  }

  function appendStroke(stroke, provisional) {
    const blocked = activeRejection();
    if (blocked) return blocked;
    const validated = validateStroke(stroke);
    if (!validated) return rejected("stroke is malformed");
    if (idExists(validated.id)) return rejected("element ID already exists");
    const before = stateBefore();
    elements.push(validated);
    record("stroke", before, provisional ? { elementId: validated.id, provisional: true } : {});
    return applied({ elementId: validated.id });
  }

  function addStroke(stroke) {
    return appendStroke(stroke, false);
  }

  // A Magic candidate must hold its input position without becoming scene Undo history until finalization.
  function addProvisionalStroke(stroke) {
    return appendStroke(stroke, true);
  }

  function commitProvisionalStrokes(strokeIds) {
    const blocked = activeRejection();
    if (blocked) return blocked;
    if (!Array.isArray(strokeIds) || strokeIds.length === 0 || !strokeIds.every(validElementId)) {
      return rejected("provisional stroke IDs are malformed");
    }
    if (new Set(strokeIds).size !== strokeIds.length) return rejected("provisional stroke IDs contain duplicates");
    const actions = strokeIds.map((id) => history.find((action) => action.provisional && sameId(action.elementId, id)));
    if (actions.some((action) => !action)) return rejected("provisional stroke does not exist");
    if (strokeIds.some((id) => elementIndex(id, "stroke") < 0)) return rejected("provisional stroke is not in the scene");
    for (const action of actions) action.provisional = false;
    return applied({ count: actions.length });
  }

  function discardProvisionalStroke(strokeId) {
    const blocked = activeRejection();
    if (blocked) return blocked;
    if (!validElementId(strokeId)) return rejected("provisional stroke ID is invalid");
    const actionIndex = history.findIndex((action) => action.provisional && sameId(action.elementId, strokeId));
    const strokeIndex = elementIndex(strokeId, "stroke");
    if (actionIndex < 0 || strokeIndex < 0) return rejected("provisional stroke does not exist");

    elements.splice(strokeIndex, 1);
    history.splice(actionIndex, 1);
    for (const action of history) {
      action.before.elements = action.before.elements.filter((element) => !sameId(element.id, strokeId));
    }
    return applied({ elementId: strokeId });
  }

  function insertIcon(descriptor, position) {
    const blocked = activeRejection();
    if (blocked) return blocked;
    const validated = validateDescriptor(descriptor);
    if (!validated) return rejected("icon descriptor is invalid");
    if (!validPoint(position)) return rejected("insertion position must be finite");
    const box = insertionBox(validated.aspectRatio, position, currentViewport);
    if (!box) return rejected("viewport cannot fit the minimum icon box");

    const before = stateBefore();
    const id = freshIconId();
    elements.push({ id, type: "icon", descriptor: validated, box, label: "", provenance: null });
    selectedIconId = id;
    record("insert", before);
    return applied({ elementId: id });
  }

  function replaceStrokes(strokeIds, descriptor) {
    const blocked = activeRejection();
    if (blocked) return blocked;
    const validated = validateDescriptor(descriptor);
    if (!validated) return rejected("icon descriptor is invalid");
    if (!Array.isArray(strokeIds) || strokeIds.length === 0 || !strokeIds.every(validElementId)) {
      return rejected("source stroke provenance is malformed");
    }
    if (new Set(strokeIds).size !== strokeIds.length) return rejected("source stroke provenance contains duplicates");

    const sourceIndexes = strokeIds.map((id) => elementIndex(id, "stroke"));
    if (sourceIndexes.some((index) => index < 0)) return rejected("source stroke does not exist");
    if (sourceIndexes.some((index, position) => position > 0 && index <= sourceIndexes[position - 1])) {
      return rejected("source stroke IDs are not in scene order");
    }
    const sourceStrokes = sourceIndexes.map((index) => clonePlain(elements[index]));
    const box = replacementBox(sourceStrokes, validated.aspectRatio, currentViewport);
    if (!box) return rejected("source stroke geometry is malformed");

    const before = stateBefore();
    const id = freshIconId();
    const insertAt = sourceIndexes[0];
    for (let index = sourceIndexes.length - 1; index >= 0; index -= 1) elements.splice(sourceIndexes[index], 1);
    elements.splice(insertAt, 0, {
      id,
      type: "icon",
      descriptor: validated,
      box,
      label: "",
      provenance: {
        kind: "recognized-replacement",
        strokeIds: clonePlain(strokeIds),
        sourceStrokes,
        sourceIndexes: clonePlain(sourceIndexes),
      },
    });
    record("replacement", before);
    return applied({ elementId: id });
  }

  function selectAt(point) {
    const blocked = activeRejection();
    if (blocked) return blocked;
    if (!validPoint(point)) return rejected("selection point must be finite");
    let index = -1;
    for (let candidate = elements.length - 1; candidate >= 0; candidate -= 1) {
      if (elements[candidate].type === "icon" && pointInside(elements[candidate].box, point)) {
        index = candidate;
        break;
      }
    }
    if (index < 0) {
      if (selectedIconId === null) return noOp("selection is already clear");
      selectedIconId = null;
      return applied({ selectedIconId: null });
    }
    const selected = elements[index];
    const changed = !sameId(selectedIconId, selected.id) || index !== elements.length - 1;
    bringToFront(index);
    selectedIconId = selected.id;
    return changed ? applied({ selectedIconId: selected.id }) : noOp("icon is already selected and frontmost");
  }

  function clearSelection() {
    const blocked = activeRejection();
    if (blocked) return blocked;
    if (selectedIconId === null) return noOp("selection is already clear");
    selectedIconId = null;
    return applied({ selectedIconId: null });
  }

  function beginMove(iconId, point) {
    return beginGesture("move", iconId, point);
  }

  function beginResize(iconId, corner, point) {
    return beginGesture("resize", iconId, point, corner);
  }

  function updateGesture(token, point) {
    if (!validCurrentToken(token)) return rejected("gesture token is stale");
    if (!validPoint(point)) return rejected("gesture point must be finite");
    const index = elementIndex(activeGesture.iconId, "icon");
    if (index < 0) return rejected("gesture icon no longer exists");
    const icon = elements[index];
    let nextBox;
    if (activeGesture.kind === "move") {
      nextBox = clampBox({
        ...activeGesture.originalBox,
        left: activeGesture.originalBox.left + point.x - activeGesture.startPoint.x,
        top: activeGesture.originalBox.top + point.y - activeGesture.startPoint.y,
      }, currentViewport);
    } else {
      nextBox = resizeBox(activeGesture, point, currentViewport);
    }
    if (boxesEqual(icon.box, nextBox)) return noOp("gesture preview is unchanged");
    icon.box = nextBox;
    return applied({ gesture: activeGesture.kind });
  }

  function commitGesture(token) {
    if (!validCurrentToken(token)) return rejected("gesture token is stale");
    const active = activeGesture;
    const icon = elements[elementIndex(active.iconId, "icon")];
    const original = active.before.elements.find((element) => sameId(element.id, active.iconId) && element.type === "icon");
    if (!icon || !original) {
      rollbackActive();
      return rejected("gesture icon no longer exists");
    }
    if (boxesEqual(icon.box, original.box)) {
      rollbackActive();
      return noOp("gesture made no geometry change");
    }
    activeGesture = null;
    record(active.kind, active.before);
    return applied({ action: active.kind });
  }

  function cancelGesture(token) {
    if (!validCurrentToken(token)) return rejected("gesture token is stale");
    rollbackActive();
    return applied({ action: "rollback" });
  }

  function setViewport(viewportValue) {
    const blocked = activeRejection();
    if (blocked) return blocked;
    if (!validViewport(viewportValue)) return rejected("viewport must have finite positive dimensions");
    if (viewportValue.width === currentViewport.width && viewportValue.height === currentViewport.height) {
      return noOp("viewport is unchanged");
    }
    currentViewport = copyViewport(viewportValue);
    reframeElements(elements, currentViewport);
    for (const action of history) reframeElements(action.before.elements, currentViewport);
    return applied();
  }

  function setLabel(iconId, text) {
    const blocked = activeRejection();
    if (blocked) return blocked;
    if (!validElementId(iconId)) return rejected("icon ID is invalid");
    if (!isValidIconLabel(text)) return rejected("label must be well-formed plain text of at most 64 Unicode scalars");
    const index = elementIndex(iconId, "icon");
    if (index < 0) return rejected("icon does not exist");
    if (elements[index].label === text) return noOp("label is unchanged");
    elements[index].label = text;
    // Label edits are deliberately not history actions, so later Undo must not erase them.
    for (const action of history) {
      const historical = action.before.elements.find((element) => element.type === "icon" && sameId(element.id, iconId));
      if (historical) historical.label = text;
    }
    return applied({ elementId: iconId });
  }

  function deleteSelected() {
    const blocked = activeRejection();
    if (blocked) return blocked;
    if (selectedIconId === null) return noOp("no icon is selected");
    const index = elementIndex(selectedIconId, "icon");
    if (index < 0) {
      selectedIconId = null;
      return rejected("selected icon does not exist");
    }
    const before = stateBefore();
    const deletedId = selectedIconId;
    elements.splice(index, 1);
    selectedIconId = null;
    record("delete", before);
    return applied({ elementId: deletedId });
  }

  function undo() {
    if (activeGesture) {
      rollbackActive();
      return applied({ action: "rollback", historyConsumed: false });
    }
    const action = history.pop();
    if (!action) return noOp("history is empty");
    restore(action.before);
    return applied({ action: action.kind, historyConsumed: true });
  }

  function clear() {
    const hadContent = elements.length > 0 || history.length > 0 || selectedIconId !== null || Boolean(activeGesture);
    if (activeGesture) rollbackActive();
    elements = [];
    selectedIconId = null;
    history.length = 0;
    return hadContent ? applied() : noOp("scene is already clear");
  }

  return Object.freeze({
    snapshot,
    addStroke,
    addProvisionalStroke,
    commitProvisionalStrokes,
    discardProvisionalStroke,
    insertIcon,
    replaceStrokes,
    selectAt,
    clearSelection,
    beginMove,
    beginResize,
    updateGesture,
    commitGesture,
    cancelGesture,
    setViewport,
    setLabel,
    deleteSelected,
    undo,
    clear,
  });
}
