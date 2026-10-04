import { RECOGNITION_LIMITS } from "./stroke-recognizer.js";

export const MAGIC_PEN_CALIBRATION = Object.freeze({
  inactivityTimeoutMs: 1200,
  marginRatio: 0.15,
  minimumMarginPx: 48,
  maximumMarginPx: 96,
});

export const MAGIC_PEN_GROUP_LIMITS = Object.freeze({
  maxAdmittedStrokes: RECOGNITION_LIMITS.maxStrokes,
});

export function magicGroupMargin(bounds) {
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width < 0 || bounds.height < 0) {
    return null;
  }
  const { marginRatio, minimumMarginPx, maximumMarginPx } = MAGIC_PEN_CALIBRATION;
  return Math.min(maximumMarginPx, Math.max(minimumMarginPx, Math.max(bounds.width, bounds.height) * marginRatio));
}
