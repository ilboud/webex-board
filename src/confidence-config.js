export const DEFAULT_CONFIDENCE = Object.freeze({
  mediumThreshold: 0.65,
  highThreshold: 0.85,
});

export function validateConfidenceConfig(config) {
  if (!config || typeof config !== "object") return null;
  const { mediumThreshold, highThreshold } = config;
  if (
    !Number.isFinite(mediumThreshold) ||
    !Number.isFinite(highThreshold) ||
    mediumThreshold < 0 ||
    mediumThreshold >= highThreshold ||
    highThreshold > 1
  ) {
    return null;
  }
  return Object.freeze({ mediumThreshold, highThreshold });
}

export function confidenceBand(score, config = DEFAULT_CONFIDENCE) {
  const validConfig = validateConfidenceConfig(config);
  if (!validConfig || !Number.isFinite(score) || score < 0 || score > 1) return "disabled";
  if (score > validConfig.highThreshold) return "high";
  if (score > validConfig.mediumThreshold) return "medium";
  return "low";
}

export const CONFIDENCE_CONFIG = validateConfidenceConfig(DEFAULT_CONFIDENCE);
