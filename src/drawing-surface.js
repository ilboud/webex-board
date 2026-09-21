import { confidenceBand, validateConfidenceConfig } from "./confidence-config.js";

const MAX_POINTS = 4096;
let nextElementId = 1;

function clonePoints(points) {
  return points.map(({ x, y }) => ({ x, y }));
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

export function createDrawingSurface({ canvas, surface, undoButton, clearButton, recognizer, confidenceConfig, catalog }) {
  const context = canvas.getContext("2d");
  const validConfidenceConfig = validateConfidenceConfig(confidenceConfig);
  const state = {
    elements: [],
    history: [],
    suggestion: null,
    active: null,
    recognitionCalls: 0,
  };

  function canvasSize() {
    const rect = canvas.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  function resizeCanvas() {
    const { width, height } = canvasSize();
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    render();
  }

  function drawStroke(element) {
    if (element.points.length === 0) return;
    context.beginPath();
    context.moveTo(element.points[0].x, element.points[0].y);
    for (const point of element.points.slice(1)) context.lineTo(point.x, point.y);
    if (element.points.length === 1) context.lineTo(element.points[0].x + 0.01, element.points[0].y);
    context.stroke();
  }

  function render() {
    const { width, height } = canvasSize();
    context.clearRect(0, 0, width, height);
    context.lineWidth = 4;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#17324d";
    for (const element of state.elements) {
      if (element.type === "stroke") drawStroke(element);
    }
    for (const oldIcon of surface.querySelectorAll(".replacement-icon")) oldIcon.remove();
    for (const element of state.elements) {
      if (element.type !== "icon") continue;
      const image = document.createElement("img");
      image.className = "replacement-icon";
      image.alt = element.icon.label;
      image.src = element.icon.src;
      Object.assign(image.style, {
        left: `${element.layout.left}px`,
        top: `${element.layout.top}px`,
        width: `${element.layout.width}px`,
        height: `${element.layout.height}px`,
      });
      image.dataset.elementId = String(element.id);
      surface.append(image);
    }
    renderSuggestion();
  }

  function renderSuggestion() {
    surface.querySelector(".suggestion")?.remove();
    if (!state.suggestion) return;
    const group = document.createElement("div");
    group.className = "suggestion";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", `${state.suggestion.icon.label} suggestion`);
    const accept = document.createElement("button");
    accept.type = "button";
    accept.textContent = "Accept";
    accept.dataset.action = "accept";
    accept.addEventListener("click", acceptSuggestion);
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.dataset.action = "dismiss";
    dismiss.addEventListener("click", dismissSuggestion);
    group.append(accept, dismiss);
    surface.append(group);

    const source = boundsOf(state.suggestion.sourcePoints);
    const canvasRect = canvas.getBoundingClientRect();
    const groupRect = group.getBoundingClientRect();
    let left = source.maxX + 12;
    if (left + groupRect.width > canvasRect.width) left = source.minX - groupRect.width - 12;
    left = Math.max(0, Math.min(left, canvasRect.width - groupRect.width));
    const top = Math.max(0, Math.min(source.minY, canvasRect.height - groupRect.height));
    group.style.left = `${left}px`;
    group.style.top = `${top}px`;
  }

  function pointFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function dismissSuggestion() {
    state.suggestion = null;
    render();
  }

  function replaceStroke(stroke, category, icon) {
    const index = state.elements.findIndex((element) => element.id === stroke.id && element.type === "stroke");
    if (index < 0) return false;
    const sourcePoints = clonePoints(stroke.points);
    const replacement = {
      id: nextElementId++,
      type: "icon",
      category,
      icon,
      sourcePoints,
      layout: replacementLayout(sourcePoints, icon.aspectRatio || 1),
    };
    state.elements.splice(index, 1, replacement);
    state.history.push({ kind: "replacement", replacementId: replacement.id, index, stroke: { ...stroke, points: sourcePoints } });
    state.suggestion = null;
    render();
    return true;
  }

  function acceptSuggestion() {
    if (!state.suggestion) return;
    const { strokeId, category, icon } = state.suggestion;
    const stroke = state.elements.find((element) => element.id === strokeId && element.type === "stroke");
    if (!stroke) return dismissSuggestion();
    replaceStroke(stroke, category, icon);
  }

  function undo() {
    if (state.suggestion) return dismissSuggestion();
    const action = state.history.pop();
    if (!action) return;
    if (action.kind === "add") {
      const index = state.elements.findIndex((element) => element.id === action.elementId);
      if (index >= 0) state.elements.splice(index, 1);
    } else if (action.kind === "replacement") {
      const index = state.elements.findIndex((element) => element.id === action.replacementId);
      if (index >= 0) state.elements.splice(index, 1, { ...action.stroke, points: clonePoints(action.stroke.points) });
    }
    render();
  }

  function clear() {
    state.elements.length = 0;
    state.history.length = 0;
    state.suggestion = null;
    state.active = null;
    render();
  }

  function onPointerDown(event) {
    if (state.active || !event.isPrimary) return;
    const point = pointFromEvent(event);
    if (!point) return;
    dismissSuggestion();
    event.preventDefault();
    try { canvas.setPointerCapture(event.pointerId); } catch {}
    const stroke = { id: nextElementId++, type: "stroke", points: [point], complete: false };
    state.elements.push(stroke);
    state.history.push({ kind: "add", elementId: stroke.id });
    state.active = { pointerId: event.pointerId, stroke, malformed: false, overflow: false };
    render();
  }

  function onPointerMove(event) {
    if (!state.active || event.pointerId !== state.active.pointerId) return;
    event.preventDefault();
    if (state.active.stroke.points.length >= MAX_POINTS) {
      state.active.overflow = true;
      return;
    }
    const point = pointFromEvent(event);
    if (!point) {
      state.active.malformed = true;
      return;
    }
    const previous = state.active.stroke.points.at(-1);
    state.active.stroke.points.push(point);
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function normalized(points) {
    const { width, height } = canvasSize();
    return points.map(({ x, y }) => ({ x: x / width, y: y / height }));
  }

  function completeActive(event) {
    if (!state.active || event.pointerId !== state.active.pointerId) return;
    const active = state.active;
    const finalPoint = pointFromEvent(event);
    if (!finalPoint) active.malformed = true;
    else if (active.stroke.points.length >= MAX_POINTS) active.overflow = true;
    else {
      const previous = active.stroke.points.at(-1);
      if (!previous || previous.x !== finalPoint.x || previous.y !== finalPoint.y) active.stroke.points.push(finalPoint);
    }
    active.stroke.complete = true;
    state.active = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch {}
    if (active.malformed || active.overflow || !validConfidenceConfig) return render();

    state.recognitionCalls += 1;
    const result = recognizer(normalized(active.stroke.points));
    if (!result || result.status !== "recognized") return render();
    const band = confidenceBand(result.confidence, validConfidenceConfig);
    if (band === "low" || band === "disabled") return render();
    const plan = planReplacement(catalog, result.category, active.stroke.points);
    if (!plan) return render();
    if (band === "high") replaceStroke(active.stroke, plan.category, plan.icon);
    else {
      state.suggestion = {
        strokeId: active.stroke.id,
        ...plan,
      };
      render();
    }
  }

  function abandonActive(event) {
    if (!state.active || event.pointerId !== state.active.pointerId) return;
    state.active.stroke.complete = false;
    state.active = null;
    render();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", completeActive);
  canvas.addEventListener("pointercancel", abandonActive);
  canvas.addEventListener("lostpointercapture", abandonActive);
  undoButton.addEventListener("click", undo);
  clearButton.addEventListener("click", clear);
  const resizeObserver = new ResizeObserver(resizeCanvas);
  resizeObserver.observe(canvas);
  resizeCanvas();

  return Object.freeze({
    undo,
    clear,
    acceptSuggestion,
    dismissSuggestion,
    resize: resizeCanvas,
    snapshot() {
      return structuredClone({
        elements: state.elements,
        suggestion: state.suggestion,
        active: state.active && {
          pointerId: state.active.pointerId,
          pointCount: state.active.stroke.points.length,
          malformed: state.active.malformed,
          overflow: state.active.overflow,
        },
        recognitionCalls: state.recognitionCalls,
      });
    },
    destroy() {
      resizeObserver.disconnect();
    },
  });
}

export const DRAWING_LIMITS = Object.freeze({ maxPoints: MAX_POINTS });
