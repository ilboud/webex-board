const MIN_POINTS = 16;
const EPSILON = 1e-9;

function invalidResult(reason) {
  return { status: "unrecognized", category: null, confidence: 0, reason };
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
  const peaks = countRadialPeaks(radii);
  const circle = Math.max(0, Math.min(1, 1 - radialDeviation * 4.2 - Math.abs(width / height - 1) * 0.15));
  const cloudDeviationFit = Math.max(0, 1 - Math.abs(radialDeviation - 0.122) * 5);
  const cloudPeakFit = Math.max(0, 1 - Math.abs(peaks - 5) * 0.12);
  const cloud = Math.max(0, Math.min(1, 0.15 + cloudDeviationFit * 0.55 + cloudPeakFit * 0.28));
  return { circle, rectangle, cloud };
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

export function recognizeStroke(points) {
  if (!Array.isArray(points) || points.length < MIN_POINTS) return invalidResult("insufficient-points");
  if (points.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return invalidResult("non-finite-coordinate");
  }
  if (points.some(({ x, y }) => x < 0 || x > 1 || y < 0 || y > 1)) return invalidResult("out-of-range");

  const bounds = boundsOf(points);
  if (bounds.width <= EPSILON || bounds.height <= EPSILON) return invalidResult("degenerate");
  const diagonal = Math.hypot(bounds.width, bounds.height);
  if (distance(points[0], points.at(-1)) / diagonal > 0.18) return invalidResult("open-stroke");
  if (pathLength(points) / diagonal > 4.2) return invalidResult("unsupported-complexity");

  const resolved = resolveCandidateScores(geometryScores(points, bounds));
  if (resolved.status !== "recognized" || resolved.confidence <= 0.4) return invalidResult("unsupported-geometry");
  return resolved;
}

export const RECOGNITION_LIMITS = Object.freeze({ minimumPoints: MIN_POINTS });
