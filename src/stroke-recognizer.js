const MIN_POINTS = 16;
const MAX_POINTS_PER_STROKE = 4096;
const MAX_STROKES = 16;
const MAX_ABSOLUTE_COORDINATE = 1_000_000;
const EPSILON = 1e-9;
const MIN_CLOUD_RADIAL_DEVIATION = 0.11;
const MIN_CLOUD_RECTANGLE_EDGE_ERROR = 0.06;

export const RECOGNITION_INTENTS = Object.freeze({
  circle: "router",
  rectangle: "switch",
  "horizontal-rectangle": "switch",
  "vertical-rectangle": "server",
  cloud: "cloud",
  cylinder: "storage",
  "storage/database": "storage",
  "stick-figure": "user",
  "user/client": "user",
});

function invalidResult(reason, status = "unrecognized", confidence = 0) {
  return { status, category: null, confidence, reason };
}

function boundsOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function groupBounds(strokes) {
  return boundsOf(strokes.flat());
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) length += distance(points[index - 1], points[index]);
  return length;
}

function countRadialPeaks(radii) {
  if (radii.length < 5) return 0;
  let peaks = 0;
  for (let index = 1; index < radii.length - 1; index += 1) {
    if (radii[index] > radii[index - 1] && radii[index] >= radii[index + 1]) peaks += 1;
  }
  return peaks;
}

function geometryScores(points, bounds) {
  const width = Math.max(bounds.width, EPSILON);
  const height = Math.max(bounds.height, EPSILON);
  const center = { x: bounds.minX + width / 2, y: bounds.minY + height / 2 };
  const normalized = points.slice(0, -1).map((point) => ({
    x: (point.x - bounds.minX) / width,
    y: (point.y - bounds.minY) / height,
  }));

  const edgeError = normalized.reduce((sum, point) => (
    sum + Math.min(point.x, 1 - point.x, point.y, 1 - point.y)
  ), 0) / normalized.length;
  const rectangle = Math.max(0, Math.min(1, 1 - edgeError * 7));

  const radii = points.slice(0, -1).map((point) => distance(point, center));
  const meanRadius = radii.reduce((sum, value) => sum + value, 0) / radii.length;
  const radialDeviation = radii.reduce((sum, value) => sum + Math.abs(value - meanRadius), 0) /
    radii.length / Math.max(meanRadius, EPSILON);
  const radialRoughness = radii.reduce((sum, value, index) => {
    const previous = radii[(index - 1 + radii.length) % radii.length];
    const next = radii[(index + 1) % radii.length];
    return sum + Math.abs(previous - 2 * value + next);
  }, 0) / radii.length / Math.max(meanRadius, EPSILON);
  const peaks = countRadialPeaks(radii);
  const circle = Math.max(0, Math.min(1,
    1 - radialDeviation * 3.4 - radialRoughness * 0.4 - Math.abs(width / height - 1) * 0.15,
  ));
  // Peak count alone promotes shallow wobble, so clouds also need radial amplitude and weak rectangle-edge adherence.
  const hasProminentCloudLobes = radialDeviation >= MIN_CLOUD_RADIAL_DEVIATION &&
    edgeError >= MIN_CLOUD_RECTANGLE_EDGE_ERROR;
  const cloudDeviationFit = Math.max(0, 1 - Math.abs(radialDeviation - 0.122) * 5);
  const cloudPeakFit = Math.max(0, 1 - Math.abs(peaks - 5) * 0.12);
  const cloud = hasProminentCloudLobes
    ? Math.max(0, Math.min(1, 0.15 + cloudDeviationFit * 0.55 + cloudPeakFit * 0.28))
    : 0;
  return { circle, rectangle, cloud };
}

function normalizedClosure(stroke, referenceBounds) {
  const diagonal = Math.max(Math.hypot(referenceBounds.width, referenceBounds.height), EPSILON);
  return distance(stroke[0], stroke.at(-1)) / diagonal;
}

function describeStroke(stroke) {
  const bounds = boundsOf(stroke);
  return {
    stroke,
    bounds,
    centerX: bounds.minX + bounds.width / 2,
    centerY: bounds.minY + bounds.height / 2,
    closed: stroke.length >= MIN_POINTS && normalizedClosure(stroke, bounds) <= 0.18,
  };
}

function classifyCylinder(descriptors, bounds) {
  if (bounds.height <= bounds.width * 1.02) return null;
  const loops = descriptors.filter(({ closed, bounds: strokeBounds, centerY }) => (
    closed &&
    strokeBounds.width >= strokeBounds.height * 1.35 &&
    centerY <= bounds.minY + bounds.height * 0.38
  ));
  if (loops.length === 0) return null;

  const top = loops.sort((a, b) => a.centerY - b.centerY)[0];
  const body = descriptors.filter((descriptor) => descriptor !== top).flatMap(({ stroke }) => stroke);
  if (body.length < 3) return null;
  const normalizedBody = body.map((point) => ({
    x: (point.x - bounds.minX) / bounds.width,
    y: (point.y - bounds.minY) / bounds.height,
  }));
  const lower = normalizedBody.filter(({ y }) => y >= 0.42);
  const hasLeftSide = lower.some(({ x }) => x <= 0.28);
  const hasRightSide = lower.some(({ x }) => x >= 0.72);
  const hasBase = lower.some(({ y }) => y >= 0.88) &&
    lower.some(({ x, y }) => y >= 0.75 && x <= 0.35) &&
    lower.some(({ x, y }) => y >= 0.75 && x >= 0.65);
  if (!hasLeftSide || !hasRightSide || !hasBase) return null;

  const topWidthCoverage = top.bounds.width / bounds.width;
  const confidence = topWidthCoverage >= 0.72 && lower.length >= 6 ? 0.93 : 0.78;
  return { status: "recognized", category: "storage", confidence, reason: null };
}

function classifyStickFigure(descriptors, bounds) {
  const headCandidates = descriptors.filter(({ closed, bounds: strokeBounds, centerY }) => {
    const ratio = strokeBounds.width / Math.max(strokeBounds.height, EPSILON);
    return closed && ratio >= 0.58 && ratio <= 1.55 && centerY <= bounds.minY + bounds.height * 0.3;
  });
  if (headCandidates.length === 0) return null;
  const head = headCandidates.sort((a, b) => a.centerY - b.centerY)[0];
  if (bounds.height < Math.max(head.bounds.height, head.bounds.width) * 2.4) return null;

  const nonHead = descriptors.filter((descriptor) => descriptor !== head).flatMap(({ stroke }) => stroke);
  if (nonHead.length < 8) return null;
  const points = nonHead.map((point) => ({
    x: (point.x - bounds.minX) / bounds.width,
    y: (point.y - bounds.minY) / bounds.height,
  }));
  const center = (head.centerX - bounds.minX) / bounds.width;
  const hasTorso = points.some(({ x, y }) => Math.abs(x - center) <= 0.16 && y >= 0.3 && y <= 0.7);
  const hasLeftArm = points.some(({ x, y }) => x <= center - 0.2 && y >= 0.3 && y <= 0.67);
  const hasRightArm = points.some(({ x, y }) => x >= center + 0.2 && y >= 0.3 && y <= 0.67);
  const hasLeftLeg = points.some(({ x, y }) => x <= center - 0.12 && y >= 0.78);
  const hasRightLeg = points.some(({ x, y }) => x >= center + 0.12 && y >= 0.78);
  if (!hasTorso || !hasLeftArm || !hasRightArm || !hasLeftLeg || !hasRightLeg) return null;

  const confidence = head.bounds.width / bounds.width >= 0.2 && descriptors.length >= 4 ? 0.92 : 0.78;
  return { status: "recognized", category: "user", confidence, reason: null };
}

export function validateRecognitionStroke(stroke) {
  if (!Array.isArray(stroke) || stroke.length < 2) return "degenerate-stroke";
  if (stroke.length > MAX_POINTS_PER_STROKE) return "stroke-overflow";
  for (const point of stroke) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return "non-finite-coordinate";
    if (Math.abs(point.x) > MAX_ABSOLUTE_COORDINATE || Math.abs(point.y) > MAX_ABSOLUTE_COORDINATE) {
      return "out-of-range";
    }
  }
  const bounds = boundsOf(stroke);
  return bounds.width <= EPSILON && bounds.height <= EPSILON ? "degenerate-stroke" : null;
}

function validateStrokeGroup(strokes) {
  if (!Array.isArray(strokes) || strokes.length === 0) return "empty-group";
  if (strokes.length > MAX_STROKES) return "too-many-strokes";
  for (const stroke of strokes) {
    const invalidReason = validateRecognitionStroke(stroke);
    if (invalidReason) return invalidReason;
  }
  const bounds = groupBounds(strokes);
  if (bounds.width <= EPSILON || bounds.height <= EPSILON) return "degenerate-group";
  return null;
}

function recognizeSingleStroke(points, { legacyRectangle = false } = {}) {
  if (points.length < MIN_POINTS) return invalidResult("insufficient-points");
  const bounds = boundsOf(points);
  const diagonal = Math.hypot(bounds.width, bounds.height);
  if (distance(points[0], points.at(-1)) / diagonal > 0.18) return invalidResult("open-stroke");
  if (pathLength(points) / diagonal > 4.2) return invalidResult("unsupported-complexity");

  const resolved = resolveCandidateScores(geometryScores(points, bounds));
  if (resolved.status === "ambiguous") return resolved;
  if (resolved.status !== "recognized" || resolved.confidence <= 0.4) return invalidResult("unsupported-geometry");
  if (resolved.category === "rectangle") {
    if (legacyRectangle) return { ...resolved, category: "rectangle" };
    const ratio = bounds.width / bounds.height;
    if (ratio >= 1.25) return { ...resolved, category: "switch" };
    if (ratio <= 0.8) return { ...resolved, category: "server" };
    return invalidResult("rectangle-orientation", "ambiguous", resolved.confidence);
  }
  if (legacyRectangle) return resolved;
  const category = RECOGNITION_INTENTS[resolved.category];
  return category ? { ...resolved, category } : invalidResult("unsupported-geometry");
}

function recognizeStrokeGroupCore(strokes, options) {
  const invalidReason = validateStrokeGroup(strokes);
  if (invalidReason) return invalidResult(invalidReason);
  if (strokes.length === 1) return recognizeSingleStroke(strokes[0], options);

  const bounds = groupBounds(strokes);
  const descriptors = strokes.map(describeStroke);
  return classifyCylinder(descriptors, bounds) ??
    classifyStickFigure(descriptors, bounds) ??
    invalidResult("unsupported-group");
}

export function resolveCandidateScores(candidateScores) {
  const entries = Object.entries(candidateScores)
    .filter(([, score]) => Number.isFinite(score) && score >= 0 && score <= 1)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return invalidResult("no-candidates");
  if (entries.length > 1 && Math.abs(entries[0][1] - entries[1][1]) <= Number.EPSILON) {
    return { status: "ambiguous", category: null, confidence: entries[0][1], reason: "exact-tie" };
  }
  return { status: "recognized", category: entries[0][0], confidence: entries[0][1], reason: null };
}

export function recognizeStrokeGroup(strokes) {
  return recognizeStrokeGroupCore(strokes, { legacyRectangle: false });
}

export function recognizeStroke(points) {
  if (!Array.isArray(points) || points.length < MIN_POINTS) return invalidResult("insufficient-points");
  if (points.length > MAX_POINTS_PER_STROKE) return invalidResult("stroke-overflow");
  if (points.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return invalidResult("non-finite-coordinate");
  }
  if (points.some(({ x, y }) => x < 0 || x > 1 || y < 0 || y > 1)) return invalidResult("out-of-range");
  return recognizeStrokeGroupCore([points], { legacyRectangle: true });
}

export const RECOGNITION_LIMITS = Object.freeze({
  minimumPoints: MIN_POINTS,
  maxPointsPerStroke: MAX_POINTS_PER_STROKE,
  maxStrokes: MAX_STROKES,
  maxAbsoluteCoordinate: MAX_ABSOLUTE_COORDINATE,
});
