import { DEFAULT_CONFIDENCE, validateConfidenceConfig } from "./confidence-config.js";
import { createMagicPenGroup } from "./magic-pen-group.js";
import { createScene, ICON_LABEL_POLICY, isValidIconLabel } from "./scene-model.js";

const MAX_POINTS = 4096;

function clonePoints(points) {
  return points.map(({ x, y }) => ({ x, y }));
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function boundsOf(points) {
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

export function planReplacement(catalog, category, sourcePoints) {
  const icon = catalog.lookup(category);
  if (!icon) return null;
  return { category, icon, sourcePoints: clonePoints(sourcePoints) };
}

export function replacementLayout(points, aspectRatio = 1) {
  const source = boundsOf(points);
  let boxWidth = source.width * 0.8;
  let boxHeight = source.height * 0.8;
  if (boxWidth < 48 || boxHeight < 48) {
    boxWidth = 48;
    boxHeight = 48;
  }
  let width = boxWidth;
  let height = width / aspectRatio;
  if (height > boxHeight) {
    height = boxHeight;
    width = height * aspectRatio;
  }
  const centerX = source.minX + source.width / 2;
  const centerY = source.minY + source.height / 2;
  return { left: centerX - width / 2, top: centerY - height / 2, width, height, centerX, centerY, source };
}

export const DRAWING_LIMITS = Object.freeze({ maxPoints: MAX_POINTS });

const TOOLS = Object.freeze({ NORMAL: "normal", MAGIC: "magic", SELECT: "select" });
const DEFAULT_STROKE_COLOR = "#17324d";

function productionScheduler() {
  return Object.freeze({
    now: () => Date.now(),
    set: (callback, delay) => window.setTimeout(callback, delay),
    clear: (handle) => window.clearTimeout(handle),
  });
}

function iconSource(descriptor) {
  return descriptor.renderSrc ?? descriptor.src;
}

function sceneDescriptor(descriptor) {
  const src = iconSource(descriptor);
  return {
    id: descriptor.id,
    label: descriptor.label,
    src,
    aspectRatio: descriptor.aspectRatio,
    ...(descriptor.width ? { width: descriptor.width, height: descriptor.height } : {}),
    namespace: descriptor.namespace ?? "built-in",
    ...(descriptor.libraryId ? { libraryId: descriptor.libraryId } : {}),
  };
}

function createIntegratedDrawingSurface(options) {
  const {
    canvas,
    surface,
    undoButton,
    clearButton,
    recognizer,
    confidenceConfig,
    catalog,
    toolButtons,
    colorInput,
    deleteButton,
    labelButton,
    labelInput,
    scheduler = productionScheduler(),
  } = options;
  const context = canvas.getContext("2d");
  const validConfidenceConfig = validateConfidenceConfig(confidenceConfig);
  let destroyed = false;
  let selectedTool = TOOLS.MAGIC;
  let active = null;
  let nextStrokeId = 1;
  let recognitionCalls = 0;
  let suggestion = null;
  let candidateRecords = [];
  let timerHandle = null;
  let timerToken = null;
  let labelEditing = false;
  let labelEditorIconId = null;
  let acceptedLabelValue = "";
  const listeners = [];
  const scene = createScene({ viewport: viewport() });
  const magic = createMagicPenGroup({
    recognize(strokes) {
      if (!validConfidenceConfig) return { status: "unrecognized", category: null, confidence: 0 };
      recognitionCalls += 1;
      return recognizer(strokes);
    },
    clock: scheduler.now,
    confidenceConfig: validConfidenceConfig ?? DEFAULT_CONFIDENCE,
  });

  function viewport() {
    const rect = canvas.getBoundingClientRect();
    return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  }

  function listen(target, type, callback, optionsValue) {
    target?.addEventListener(type, callback, optionsValue);
    listeners.push(() => target?.removeEventListener(type, callback, optionsValue));
  }

  function pointFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  }

  function releaseCapture(pointerId, target = active?.captureTarget) {
    try {
      if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      if (surface.hasPointerCapture?.(pointerId)) surface.releasePointerCapture(pointerId);
      if (canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId);
    } catch { /* Capture may already have been released by the browser. */ }
  }

  function capture(event) {
    if (active) active.captureTarget = event.currentTarget;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic events need no capture. */ }
  }

  function addSceneStroke(points, color, complete = true, provisional = false) {
    if (!Array.isArray(points) || points.length === 0) return null;
    const id = `stroke-${nextStrokeId++}`;
    const operation = provisional ? scene.addProvisionalStroke : scene.addStroke;
    const result = operation({ id, points, color, complete });
    return result.status === "applied" ? id : null;
  }

  function clearScheduledTimer(token = timerToken) {
    if (timerHandle !== null && (token === timerToken || token === undefined)) {
      scheduler.clear(timerHandle);
      timerHandle = null;
      timerToken = null;
    }
  }

  function flushCandidateRecords(records = candidateRecords) {
    for (const record of records) {
      if (!record.sceneId) record.sceneId = addSceneStroke(record.points, record.color, true, true);
    }
    return records.map((record) => record.sceneId).filter(Boolean);
  }

  function commitCandidateRecords(records = candidateRecords) {
    const strokeIds = flushCandidateRecords(records);
    if (strokeIds.length === records.length && strokeIds.length > 0) scene.commitProvisionalStrokes(strokeIds);
    return strokeIds;
  }

  function dismissSuggestion() {
    suggestion = null;
    render();
  }

  function applyFinalPlan(plan, records) {
    const strokeIds = commitCandidateRecords(records);
    if (plan.kind === "replace") {
      const descriptor = catalog.lookup(plan.category);
      if (descriptor && strokeIds.length === records.length) scene.replaceStrokes(strokeIds, sceneDescriptor(descriptor));
    } else if (plan.kind === "suggest") {
      const descriptor = catalog.lookup(plan.category);
      if (descriptor && strokeIds.length === records.length) {
        suggestion = {
          category: plan.category,
          icon: descriptor,
          strokeIds,
          sourcePoints: records.flatMap((record) => record.points),
        };
      }
    }
  }

  function processMagicEffects(effects, completedRecord = null) {
    for (const effect of effects) {
      if (effect.type === "cancel-timer") clearScheduledTimer(effect.token);
      if (effect.type === "schedule-timer") {
        clearScheduledTimer();
        const scheduledToken = effect.token;
        timerToken = scheduledToken;
        const delay = Math.max(0, effect.deadline - scheduler.now());
        timerHandle = scheduler.set(() => {
          if (destroyed || timerToken !== scheduledToken) return;
          timerHandle = null;
          timerToken = null;
          processMagicEffects(magic.timerFired(scheduledToken));
          render();
        }, delay);
      }
      if (effect.type === "stroke-admitted" && completedRecord) {
        candidateRecords.push({ points: clonePoints(completedRecord.points), color: completedRecord.color });
      }
      if (effect.type === "preserve-ordinary-ink" && effect.stroke.length > 0) {
        flushCandidateRecords();
        addSceneStroke(effect.stroke, completedRecord?.color ?? active?.color ?? DEFAULT_STROKE_COLOR, false);
      }
      if (effect.type === "group-stroke-removed") {
        const removed = candidateRecords.pop();
        if (removed?.sceneId) scene.discardProvisionalStroke(removed.sceneId);
      }
      if (effect.type === "finalized") {
        const records = candidateRecords;
        candidateRecords = [];
        applyFinalPlan(effect.plan, records);
      }
    }
  }

  function acceptSuggestion() {
    if (!suggestion || destroyed) return;
    const current = suggestion;
    suggestion = null;
    scene.replaceStrokes(current.strokeIds, sceneDescriptor(current.icon));
    render();
  }

  function drawStroke(stroke) {
    if (!stroke.points?.length) return;
    context.strokeStyle = stroke.color || DEFAULT_STROKE_COLOR;
    context.beginPath();
    context.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
    if (stroke.points.length === 1) context.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y);
    context.stroke();
  }

  function renderSuggestion() {
    surface.querySelector(".suggestion")?.remove();
    if (!suggestion) return;
    const group = document.createElement("div");
    group.className = "suggestion ui-control";
    group.role = "group";
    group.ariaLabel = `${suggestion.icon.label} suggestion`;
    for (const [action, label, icon] of [["accept", "Accept", "check.svg"], ["dismiss", "Dismiss", "x-mark.svg"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      const image = document.createElement("img");
      image.src = `./assets/heroicons/controls/${icon}`;
      image.alt = "";
      const text = document.createElement("span");
      text.textContent = label;
      button.append(image, text);
      button.addEventListener("click", action === "accept" ? acceptSuggestion : dismissSuggestion);
      group.append(button);
    }
    surface.append(group);
    const source = boundsOf(suggestion.sourcePoints);
    const groupRect = group.getBoundingClientRect();
    const size = viewport();
    let left = source.maxX + 12;
    if (left + groupRect.width > size.width) left = source.minX - groupRect.width - 12;
    group.style.left = `${Math.max(0, Math.min(left, size.width - groupRect.width))}px`;
    group.style.top = `${Math.max(0, Math.min(source.minY, size.height - groupRect.height))}px`;
  }

  function rectanglesOverlap(first, second) {
    return first.left < second.right && first.right > second.left
      && first.top < second.bottom && first.bottom > second.top;
  }

  function positionLabel(label, object, element, layer) {
    const width = label.offsetWidth;
    const height = label.offsetHeight;
    const layerRect = layer.getBoundingClientRect();
    const bounds = { width: layer.clientWidth, height: layer.clientHeight };
    const clearance = 26;
    const obstacles = [
      ...object.querySelectorAll(".resize-handle"),
      ...surface.querySelectorAll("#edit-label:not([hidden]), #delete-icon:not([hidden]), #icon-label-input:not([hidden])"),
    ].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left - layerRect.left,
        top: rect.top - layerRect.top,
        right: rect.right - layerRect.left,
        bottom: rect.bottom - layerRect.top,
      };
    });
    const centeredLeft = element.box.left + (element.box.width - width) / 2;
    const clampLeft = (left) => Math.max(0, Math.min(left, bounds.width - width));

    function candidate(placement) {
      const top = placement === "below"
        ? element.box.top + element.box.height + clearance
        : element.box.top - clearance - height;
      const bottom = top + height;
      if (top < 0 || bottom > bounds.height) return null;
      const verticalObstacles = obstacles.filter((obstacle) => top < obstacle.bottom && bottom > obstacle.top);
      const leftOptions = [centeredLeft];
      for (const obstacle of verticalObstacles) {
        leftOptions.push(obstacle.left - width - 4, obstacle.right + 4);
      }
      const candidates = [...new Set(leftOptions.map(clampLeft))]
        .sort((first, second) => Math.abs(first - centeredLeft) - Math.abs(second - centeredLeft));
      const left = candidates.find((value) => verticalObstacles.every((obstacle) => !rectanglesOverlap(
        { left: value, top, right: value + width, bottom },
        obstacle,
      )));
      return left === undefined ? null : { left, top, placement };
    }

    const placed = candidate("below") ?? candidate("above");
    if (!placed) return;
    label.classList.toggle("above-icon", placed.placement === "above");
    Object.assign(label.style, {
      left: `${placed.left - element.box.left}px`,
      top: `${placed.top - element.box.top}px`,
      bottom: "auto",
      transform: "none",
    });
  }

  function renderIcons(snapshotValue) {
    surface.querySelector(".scene-layer")?.remove();
    const layer = document.createElement("div");
    layer.className = "scene-layer";
    surface.append(layer);
    const size = { width: layer.clientWidth, height: layer.clientHeight };
    for (const element of snapshotValue.elements) {
      if (element.type !== "icon") continue;
      const object = document.createElement("div");
      object.className = "icon-object" + (element.id === snapshotValue.selectedIconId ? " selected" : "");
      object.dataset.elementId = String(element.id);
      object.setAttribute("role", "group");
      object.setAttribute("aria-label", `${element.descriptor.label}${element.label ? `: ${element.label}` : ""}`);
      object.setAttribute("aria-current", element.id === snapshotValue.selectedIconId ? "true" : "false");
      Object.assign(object.style, {
        left: `${element.box.left}px`, top: `${element.box.top}px`,
        width: `${element.box.width}px`, height: `${element.box.height}px`,
      });
      const image = document.createElement("img");
      image.className = "replacement-icon";
      image.alt = element.descriptor.label;
      image.src = element.descriptor.src;
      image.draggable = false;
      object.append(image);
      let label = null;
      if (element.label !== "") {
        label = document.createElement("span");
        label.className = "icon-label";
        label.textContent = element.label;
        object.append(label);
      }
      if (element.id === snapshotValue.selectedIconId) {
        const handleRadius = 22;
        const rightSpace = size.width - element.box.left - element.box.width;
        const bottomSpace = size.height - element.box.top - element.box.height;
        const offsets = {
          northwest: { left: Math.max(-handleRadius, -element.box.left), top: Math.max(-handleRadius, -element.box.top) },
          northeast: { right: Math.max(-handleRadius, -rightSpace), top: Math.max(-handleRadius, -element.box.top) },
          southeast: { right: Math.max(-handleRadius, -rightSpace), bottom: Math.max(-handleRadius, -bottomSpace) },
          southwest: { left: Math.max(-handleRadius, -element.box.left), bottom: Math.max(-handleRadius, -bottomSpace) },
        };
        for (const corner of ["northwest", "northeast", "southeast", "southwest"]) {
          const handle = document.createElement("button");
          handle.type = "button";
          handle.className = `resize-handle ${corner}`;
          handle.dataset.corner = corner;
          handle.ariaLabel = `Resize ${corner}`;
          Object.assign(handle.style, Object.fromEntries(
            Object.entries(offsets[corner]).map(([side, value]) => [side, `${value}px`]),
          ));
          object.append(handle);
        }
      }
      layer.append(object);
      if (label) positionLabel(label, object, element, layer);
    }
  }

  function renderSelectionControls(snapshotValue) {
    const selected = snapshotValue.selectedIconId !== null;
    if (deleteButton) deleteButton.hidden = !selected;
    if (labelButton) labelButton.hidden = !selected;
    if (!labelInput) return;
    labelInput.hidden = !selected || !labelEditing;
    if (!selected || !labelEditing) return;
    const icon = snapshotValue.elements.find((element) => element.id === snapshotValue.selectedIconId);
    if (labelEditorIconId !== snapshotValue.selectedIconId) {
      labelEditorIconId = snapshotValue.selectedIconId;
      acceptedLabelValue = icon?.label ?? "";
      labelInput.value = acceptedLabelValue;
    } else if (document.activeElement !== labelInput) {
      acceptedLabelValue = icon?.label ?? "";
      labelInput.value = acceptedLabelValue;
    }
  }

  function render() {
    if (destroyed) return;
    const size = viewport();
    context.clearRect(0, 0, size.width, size.height);
    context.lineWidth = 4;
    context.lineCap = "round";
    context.lineJoin = "round";
    const snapshotValue = scene.snapshot();
    for (const element of snapshotValue.elements) if (element.type === "stroke") drawStroke(element);
    for (const record of candidateRecords) if (!record.sceneId) drawStroke(record);
    if (active?.kind === "pen") drawStroke(active);
    renderSelectionControls(snapshotValue);
    renderIcons(snapshotValue);
    surface.querySelector(".magic-group-boundary")?.remove();
    const groupSnapshot = magic.snapshot();
    if (groupSnapshot.bounds) {
      const boundary = document.createElement("div");
      boundary.className = "magic-group-boundary";
      Object.assign(boundary.style, {
        left: `${groupSnapshot.bounds.minX}px`, top: `${groupSnapshot.bounds.minY}px`,
        width: `${Math.max(1, groupSnapshot.bounds.width)}px`, height: `${Math.max(1, groupSnapshot.bounds.height)}px`,
      });
      surface.append(boundary);
    }
    renderSuggestion();
  }

  function resizeCanvas() {
    if (destroyed) return;
    if (active?.kind === "gesture") {
      const current = active;
      active = null;
      scene.cancelGesture(current.token);
      releaseCapture(current.pointerId, current.captureTarget);
    }
    const size = viewport();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(size.width * ratio));
    canvas.height = Math.max(1, Math.round(size.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    scene.setViewport(size);
    render();
  }

  function preserveActivePen() {
    if (!active || active.kind !== "pen") return;
    const current = active;
    active = null;
    releaseCapture(current.pointerId, current.captureTarget);
    if (current.tool === TOOLS.NORMAL) addSceneStroke(current.points, current.color, false);
    else {
      const effects = magic.preserveForToolChange(current.points);
      clearScheduledTimer();
      commitCandidateRecords(candidateRecords);
      candidateRecords = [];
      if (current.points.length) addSceneStroke(current.points, current.color, false);
      processMagicEffects(effects.filter((effect) => effect.type !== "preserve-ordinary-strokes"));
    }
  }

  function cancelActiveOperation(reason = "cancel", pointerId = active?.pointerId) {
    if (!active || pointerId !== active.pointerId) return;
    const current = active;
    active = null;
    releaseCapture(current.pointerId, current.captureTarget);
    if (current.kind === "pen") {
      if (current.tool === TOOLS.NORMAL) addSceneStroke(current.points, current.color, false);
      else {
        const effects = magic.invalidStroke({
          pointerId: current.pointerId,
          inputToken: current.inputToken,
          points: current.points,
          at: scheduler.now(),
          reason: reason === "lost-capture" ? "lost-capture" : "cancelled",
        });
        processMagicEffects(effects, current);
      }
    } else if (current.kind === "gesture") scene.cancelGesture(current.token);
    render();
  }

  function setTool(tool) {
    if (destroyed || !Object.values(TOOLS).includes(tool) || tool === selectedTool) return;
    preserveActivePen();
    if (active?.kind === "gesture") cancelActiveOperation("tool-change");
    if (selectedTool === TOOLS.MAGIC) {
      clearScheduledTimer();
      commitCandidateRecords(candidateRecords);
      candidateRecords = [];
      processMagicEffects(magic.cancelGroup({ reason: "tool-change" }).filter((effect) => effect.type !== "preserve-ordinary-strokes"));
    }
    suggestion = null;
    selectedTool = tool;
    for (const [name, button] of Object.entries(toolButtons)) {
      const isSelected = name === tool;
      button.setAttribute("aria-pressed", String(isSelected));
      button.classList.toggle("selected", isSelected);
    }
    canvas.dataset.tool = tool;
    render();
  }

  function onPointerDown(event) {
    if (destroyed || active || !event.isPrimary || event.button > 0) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    suggestion = null;
    if (selectedTool === TOOLS.SELECT) {
      const corner = event.target.closest?.("[data-corner]")?.dataset.corner;
      let result;
      if (corner) {
        const selectedId = scene.snapshot().selectedIconId;
        result = scene.beginResize(selectedId, corner, point);
      } else {
        scene.selectAt(point);
        const selectedId = scene.snapshot().selectedIconId;
        if (selectedId !== null) result = scene.beginMove(selectedId, point);
      }
      if (result?.status === "applied") {
        active = { kind: "gesture", pointerId: event.pointerId, token: result.token };
        capture(event);
      }
      return render();
    }
    const color = colorInput?.value || DEFAULT_STROKE_COLOR;
    active = { kind: "pen", tool: selectedTool, pointerId: event.pointerId, points: [point], color, malformed: false, overflow: false };
    if (selectedTool === TOOLS.MAGIC) {
      const effects = magic.startStroke({ pointerId: event.pointerId, point, at: scheduler.now() });
      const captureEffect = effects.find((effect) => effect.type === "capture-started");
      active.inputToken = captureEffect?.inputToken;
      processMagicEffects(effects);
      if (!captureEffect) { active = null; return render(); }
    }
    capture(event);
    render();
  }

  function onPointerMove(event) {
    if (destroyed || !active || event.pointerId !== active.pointerId) return;
    const point = pointFromEvent(event);
    event.preventDefault();
    if (!point) {
      if (active.kind === "pen") active.malformed = true;
      return;
    }
    if (active.kind === "gesture") scene.updateGesture(active.token, point);
    else if (active.points.length >= MAX_POINTS) active.overflow = true;
    else active.points.push(point);
    render();
  }

  function onPointerUp(event) {
    if (destroyed || !active || event.pointerId !== active.pointerId) return;
    const current = active;
    active = null;
    const point = pointFromEvent(event);
    if (current.kind === "gesture") {
      if (point) scene.updateGesture(current.token, point);
      scene.commitGesture(current.token);
    } else {
      if (!point) current.malformed = true;
      else if (current.points.length < MAX_POINTS) {
        const previous = current.points.at(-1);
        if (!previous || previous.x !== point.x || previous.y !== point.y) current.points.push(point);
      } else current.overflow = true;
      if (current.tool === TOOLS.NORMAL) addSceneStroke(current.points, current.color);
      else {
        const effects = current.malformed || current.overflow
          ? magic.invalidStroke({ pointerId: current.pointerId, inputToken: current.inputToken, points: current.points, at: scheduler.now(), reason: current.overflow ? "overflow" : "malformed" })
          : magic.completeStroke({ pointerId: current.pointerId, inputToken: current.inputToken, points: current.points, at: scheduler.now() });
        processMagicEffects(effects, current);
      }
    }
    releaseCapture(current.pointerId, current.captureTarget);
    render();
  }

  function undo() {
    if (destroyed) return;
    if (suggestion) return dismissSuggestion();
    const groupEffects = magic.undoActiveGroup({ at: scheduler.now() });
    if (groupEffects.some((effect) => effect.type === "group-stroke-removed")) processMagicEffects(groupEffects);
    else scene.undo();
    render();
  }

  function clear() {
    if (destroyed) return;
    if (active) cancelActiveOperation("clear");
    clearScheduledTimer();
    magic.clear();
    candidateRecords = [];
    suggestion = null;
    labelEditing = false;
    labelEditorIconId = null;
    acceptedLabelValue = "";
    scene.clear();
    render();
  }

  function insertIcon(descriptor) {
    flushCandidateRecords();
    const size = viewport();
    const result = scene.insertIcon(sceneDescriptor(descriptor), { x: size.width / 2, y: size.height / 2 });
    if (result.status === "applied") {
      setTool(TOOLS.SELECT);
      render();
    }
    return result;
  }

  for (const [tool, button] of Object.entries(toolButtons)) listen(button, "click", () => setTool(tool));
  listen(canvas, "pointerdown", onPointerDown);
  listen(surface, "pointerdown", (event) => {
    if (event.target === canvas || event.target.closest?.(".ui-control")) return;
    if (event.target.closest?.(".resize-handle") && selectedTool !== TOOLS.SELECT) {
      event.preventDefault();
      return;
    }
    onPointerDown(event);
  });
  listen(surface, "pointermove", onPointerMove);
  listen(surface, "pointerup", onPointerUp);
  listen(surface, "pointercancel", (event) => cancelActiveOperation("cancelled", event.pointerId));
  listen(surface, "lostpointercapture", (event) => cancelActiveOperation("lost-capture", event.pointerId));
  listen(undoButton, "click", undo);
  listen(clearButton, "click", clear);
  listen(deleteButton, "click", () => {
    scene.deleteSelected();
    labelEditing = false;
    labelEditorIconId = null;
    acceptedLabelValue = "";
    render();
  });
  listen(labelButton, "click", () => {
    const snapshotValue = scene.snapshot();
    labelEditing = true;
    labelEditorIconId = snapshotValue.selectedIconId;
    acceptedLabelValue = snapshotValue.elements.find((element) => element.id === labelEditorIconId)?.label ?? "";
    if (labelInput) labelInput.value = acceptedLabelValue;
    render();
    labelInput?.focus();
  });
  listen(labelInput, "input", () => {
    const snapshotValue = scene.snapshot();
    const id = snapshotValue.selectedIconId;
    if (id === null) return;
    const candidate = labelInput.value;
    if (!isValidIconLabel(candidate)) {
      labelInput.value = acceptedLabelValue;
      return;
    }
    const result = scene.setLabel(id, candidate);
    if (result.status === "rejected") {
      acceptedLabelValue = snapshotValue.elements.find((element) => element.id === id)?.label ?? "";
      labelInput.value = acceptedLabelValue;
      return;
    }
    labelEditorIconId = id;
    acceptedLabelValue = candidate;
    render();
  });
  if (labelInput) labelInput.dataset.maxScalars = String(ICON_LABEL_POLICY.maxScalars);
  const resizeObserver = new ResizeObserver(resizeCanvas);
  resizeObserver.observe(canvas);
  canvas.dataset.tool = selectedTool;
  for (const [tool, button] of Object.entries(toolButtons)) {
    button.setAttribute("aria-pressed", String(tool === selectedTool));
    button.classList.toggle("selected", tool === selectedTool);
  }
  resizeCanvas();

  return Object.freeze({
    undo,
    clear,
    insertIcon,
    setTool,
    acceptSuggestion,
    dismissSuggestion,
    resize: resizeCanvas,
    snapshot() {
      const sceneState = scene.snapshot();
      const provisionalIds = new Set(candidateRecords.map((record) => record.sceneId).filter(Boolean));
      const elements = sceneState.elements.filter((element) => !provisionalIds.has(element.id)).map((element) => {
        if (element.type !== "icon") return element;
        const legacyCategory = { router: "circle", switch: "rectangle", cloud: "cloud" }[element.descriptor.id] ?? element.descriptor.id;
        return {
          ...element,
          icon: { ...element.descriptor, src: element.descriptor.src },
          category: legacyCategory,
          layout: { ...element.box, centerX: element.box.left + element.box.width / 2, centerY: element.box.top + element.box.height / 2, source: element.provenance?.sourceStrokes ? boundsOf(element.provenance.sourceStrokes.flatMap((stroke) => stroke.points)) : undefined },
          sourcePoints: element.provenance?.sourceStrokes?.flatMap((stroke) => stroke.points),
        };
      });
      return deepFreeze(structuredClone({
        ...sceneState,
        elements,
        tool: selectedTool,
        suggestion,
        active: active && { kind: active.kind, pointerId: active.pointerId, pointCount: active.points?.length ?? 0 },
        recognitionCalls,
        magicGroup: magic.snapshot(),
        candidateStrokes: candidateRecords.map(({ points, color }) => ({ points, color })),
        timerPending: timerHandle !== null,
        destroyed,
      }));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (active?.kind === "gesture") scene.cancelGesture(active.token);
      releaseCapture(active?.pointerId, active?.captureTarget);
      active = null;
      clearScheduledTimer();
      magic.destroy();
      suggestion = null;
      candidateRecords = [];
      scene.clear();
      resizeObserver.disconnect();
      for (const remove of listeners.splice(0)) remove();
      surface.querySelectorAll(".scene-layer, .suggestion, .magic-group-boundary").forEach((node) => node.remove());
    },
  });
}

export function createDrawingSurface(options) {
  return createIntegratedDrawingSurface(options);
}

export const DRAWING_TOOLS = TOOLS;
export const DRAWING_COLORS = Object.freeze({ default: DEFAULT_STROKE_COLOR });
