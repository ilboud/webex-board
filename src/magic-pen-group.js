import { confidenceBand, DEFAULT_CONFIDENCE, validateConfidenceConfig } from "./confidence-config.js";
import { MAGIC_PEN_CALIBRATION, MAGIC_PEN_GROUP_LIMITS, magicGroupMargin } from "./magic-pen-config.js";
import { RECOGNITION_LIMITS, validateRecognitionStroke } from "./stroke-recognizer.js";

const INVALID_REASONS = new Set(["cancelled", "malformed", "overflow", "group-count-overflow", "lost-capture"]);

function clonePoint({ x, y }) {
  return { x, y };
}

function cloneStroke(stroke) {
  return stroke.map(clonePoint);
}

function freezeStroke(stroke) {
  return Object.freeze(stroke.map((point) => Object.freeze(clonePoint(point))));
}

function freezeStrokes(strokes) {
  return Object.freeze(strokes.map(freezeStroke));
}

function boundsOfStrokes(strokes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const { x, y } of stroke) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return Object.freeze({ minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY });
}

function isFinitePoint(point) {
  return Boolean(point) && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isBoundedPoint(point) {
  return isFinitePoint(point) &&
    Math.abs(point.x) <= RECOGNITION_LIMITS.maxAbsoluteCoordinate &&
    Math.abs(point.y) <= RECOGNITION_LIMITS.maxAbsoluteCoordinate;
}

function ordinaryCapturedInk(points) {
  if (!Array.isArray(points)) return Object.freeze([]);
  return freezeStroke(points.filter(isBoundedPoint).slice(0, RECOGNITION_LIMITS.maxPointsPerStroke));
}

function pointInsideExpandedBounds(point, bounds) {
  const margin = magicGroupMargin(bounds);
  return margin !== null &&
    point.x >= bounds.minX - margin && point.x <= bounds.maxX + margin &&
    point.y >= bounds.minY - margin && point.y <= bounds.maxY + margin;
}

function defaultTokenFactory() {
  let sequence = 0;
  return (kind) => Object.freeze({ kind, generation: ++sequence });
}

function freezePlan(kind, sourceStrokes, result) {
  const base = { kind, sourceStrokes, result: Object.freeze({ ...result }) };
  if (kind === "replace") return Object.freeze({ ...base, category: result.category });
  if (kind === "suggest") return Object.freeze({ ...base, category: result.category, actions: Object.freeze(["accept", "dismiss"]) });
  return Object.freeze(base);
}

export function createMagicPenGroup({
  recognize,
  clock = () => Date.now(),
  tokenFactory = defaultTokenFactory(),
  confidenceConfig = DEFAULT_CONFIDENCE,
} = {}) {
  if (typeof recognize !== "function" || typeof clock !== "function" || typeof tokenFactory !== "function") {
    throw new TypeError("recognize, clock, and tokenFactory functions are required");
  }
  const validConfidenceConfig = validateConfidenceConfig(confidenceConfig);
  if (!validConfidenceConfig) throw new TypeError("confidenceConfig is invalid");

  const state = {
    strokes: [],
    bounds: null,
    deadline: null,
    timerToken: null,
    active: null,
    destroyed: false,
  };

  function now(value) {
    const timestamp = value === undefined ? clock() : value;
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function cancelTimer(effects) {
    if (state.timerToken === null) return;
    effects.push(Object.freeze({ type: "cancel-timer", token: state.timerToken }));
    state.timerToken = null;
    state.deadline = null;
  }

  function scheduleTimer(at, effects) {
    const token = tokenFactory("timer");
    state.timerToken = token;
    state.deadline = at + MAGIC_PEN_CALIBRATION.inactivityTimeoutMs;
    effects.push(Object.freeze({ type: "schedule-timer", token, deadline: state.deadline }));
  }

  function clearGroup() {
    state.strokes = [];
    state.bounds = null;
    state.deadline = null;
    state.timerToken = null;
  }

  function finalize(effects, trigger) {
    if (state.strokes.length === 0) return;
    const sourceStrokes = freezeStrokes(state.strokes);
    clearGroup();
    let result;
    try {
      result = recognize(sourceStrokes);
    } catch {
      result = null;
    }
    const validRecognizedResult = result?.status === "recognized" &&
      typeof result.category === "string" && result.category.length > 0 &&
      Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1;
    const safeResult = result && typeof result === "object" && (result.status === "ambiguous" || result.status === "unrecognized" || validRecognizedResult)
      ? {
          status: result.status,
          category: validRecognizedResult ? result.category : null,
          confidence: Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1 ? result.confidence : 0,
          reason: typeof result.reason === "string" ? result.reason : null,
        }
      : { status: "unrecognized", category: null, confidence: 0, reason: "invalid-recognizer-result" };
    const band = validRecognizedResult ? confidenceBand(safeResult.confidence, validConfidenceConfig) : "low";
    const kind = band === "high" ? "replace" : band === "medium" ? "suggest" : "preserve";
    effects.push(Object.freeze({ type: "finalized", trigger, plan: freezePlan(kind, sourceStrokes, safeResult) }));
  }

  function startStroke({ pointerId, point, at } = {}) {
    if (state.destroyed || state.active || pointerId === undefined || !isFinitePoint(point)) return Object.freeze([]);
    const timestamp = now(at);
    if (timestamp === null) return Object.freeze([]);
    const effects = [];
    let joinsGroup = false;

    if (state.strokes.length > 0) {
      const beforeDeadline = timestamp < state.deadline;
      const inside = beforeDeadline && pointInsideExpandedBounds(point, state.bounds);
      if (inside) {
        joinsGroup = true;
        cancelTimer(effects);
      } else {
        cancelTimer(effects);
        finalize(effects, beforeDeadline ? "outside-start" : "late-start");
      }
    }

    const inputToken = tokenFactory("input");
    state.active = { pointerId, inputToken, joinsGroup };
    effects.push(Object.freeze({ type: "capture-started", pointerId, inputToken, joinsGroup }));
    return Object.freeze(effects);
  }

  function completeStroke({ pointerId, inputToken, points, at } = {}) {
    if (state.destroyed || !state.active || state.active.pointerId !== pointerId || state.active.inputToken !== inputToken) {
      return Object.freeze([]);
    }
    const invalidReason = validateRecognitionStroke(points);
    if (invalidReason) {
      const reason = invalidReason === "stroke-overflow" ? "overflow" : "malformed";
      return invalidStroke({ pointerId, inputToken, points, at, reason });
    }
    const timestamp = now(at);
    if (timestamp === null) return invalidStroke({ pointerId, inputToken, points, reason: "malformed" });
    if (state.active.joinsGroup && state.strokes.length >= MAGIC_PEN_GROUP_LIMITS.maxAdmittedStrokes) {
      return invalidStroke({ pointerId, inputToken, points, at: timestamp, reason: "group-count-overflow" });
    }
    const effects = [];
    state.strokes.push(cloneStroke(points));
    state.bounds = boundsOfStrokes(state.strokes);
    state.active = null;
    scheduleTimer(timestamp, effects);
    effects.unshift(Object.freeze({ type: "stroke-admitted", stroke: freezeStroke(points), bounds: state.bounds }));
    return Object.freeze(effects);
  }

  function invalidStroke({ pointerId, inputToken, points, at, reason = "malformed" } = {}) {
    if (state.destroyed || !state.active || state.active.pointerId !== pointerId || state.active.inputToken !== inputToken) {
      return Object.freeze([]);
    }
    const timestamp = now(at);
    if (timestamp === null || !INVALID_REASONS.has(reason)) return Object.freeze([]);
    const retainedGroup = state.active.joinsGroup && state.strokes.length > 0;
    state.active = null;
    const effects = [Object.freeze({ type: "preserve-ordinary-ink", reason, stroke: ordinaryCapturedInk(points) })];
    if (retainedGroup) scheduleTimer(timestamp, effects);
    return Object.freeze(effects);
  }

  function timerFired(token) {
    if (state.destroyed || token === null || token !== state.timerToken || state.active) return Object.freeze([]);
    const effects = [];
    state.timerToken = null;
    state.deadline = null;
    finalize(effects, "inactivity");
    return Object.freeze(effects);
  }

  function undoActiveGroup({ at } = {}) {
    if (state.destroyed || state.active || state.strokes.length === 0) return Object.freeze([]);
    const timestamp = now(at);
    if (timestamp === null) return Object.freeze([]);
    const effects = [];
    cancelTimer(effects);
    const removed = freezeStroke(state.strokes.pop());
    effects.push(Object.freeze({ type: "group-stroke-removed", stroke: removed, consumeSceneHistory: false }));
    if (state.strokes.length === 0) {
      clearGroup();
      return Object.freeze(effects);
    }
    state.bounds = boundsOfStrokes(state.strokes);
    scheduleTimer(timestamp, effects);
    return Object.freeze(effects);
  }

  function cancelGroup({ reason = "tool-change", partialPoints = [] } = {}) {
    if (state.destroyed || typeof reason !== "string" || reason.length === 0) return Object.freeze([]);
    const effects = [];
    cancelTimer(effects);
    const strokes = state.strokes.map(cloneStroke);
    const partial = ordinaryCapturedInk(partialPoints);
    if (partial.length > 0) strokes.push(partial.map(clonePoint));
    if (strokes.length > 0) effects.push(Object.freeze({
      type: "preserve-ordinary-strokes",
      reason,
      strokes: freezeStrokes(strokes),
    }));
    state.active = null;
    clearGroup();
    return Object.freeze(effects);
  }

  function preserveForToolChange(partialPoints = []) {
    return cancelGroup({ reason: "tool-change", partialPoints });
  }

  function clear() {
    if (state.destroyed) return Object.freeze([]);
    const effects = [];
    cancelTimer(effects);
    if (state.strokes.length > 0 || state.active) effects.push(Object.freeze({ type: "group-cancelled", reason: "clear" }));
    state.active = null;
    clearGroup();
    effects.push(Object.freeze({ type: "clear-scene" }));
    return Object.freeze(effects);
  }

  function destroy() {
    if (state.destroyed) return Object.freeze([]);
    const effects = [];
    cancelTimer(effects);
    state.active = null;
    clearGroup();
    state.destroyed = true;
    effects.push(Object.freeze({ type: "cleanup" }));
    return Object.freeze(effects);
  }

  function snapshot() {
    return Object.freeze({
      strokes: freezeStrokes(state.strokes),
      bounds: state.bounds && Object.freeze({ ...state.bounds }),
      deadline: state.deadline,
      timerToken: state.timerToken,
      active: state.active && Object.freeze({ ...state.active }),
      destroyed: state.destroyed,
    });
  }

  return Object.freeze({
    startStroke,
    completeStroke,
    invalidStroke,
    timerFired,
    undoActiveGroup,
    cancelGroup,
    preserveForToolChange,
    clear,
    destroy,
    snapshot,
  });
}

export const MAGIC_GROUP_LIMITS = Object.freeze({
  maxPointsPerStroke: RECOGNITION_LIMITS.maxPointsPerStroke,
  maxAdmittedStrokes: MAGIC_PEN_GROUP_LIMITS.maxAdmittedStrokes,
});
