// Deployment owners may replace only this source-owned list before publication.
// Runtime and user-controlled values are never consulted.
export const DEPLOYMENT_ICON_LIBRARIES = Object.freeze([]);

export const MAX_EXTERNAL_LIBRARIES = 5;
export const MAX_URL_BYTES = 2048;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const CONFIG_FIELDS = Object.freeze(["manifestUrl", "sha256"]);
const utf8 = new TextEncoder();

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasMalformedPercentEncoding(value) {
  return /%(?![0-9a-fA-F]{2})/.test(value);
}

function containsEncodedTraversal(pathname) {
  for (const originalSegment of pathname.split("/")) {
    let segment = originalSegment;
    for (let pass = 0; pass <= pathname.length; pass += 1) {
      let decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw new TypeError("external URL contains malformed percent encoding");
      }
      if (decoded === segment) break;
      segment = decoded;
    }
    if (segment.split(/[\\/]/).some((part) => part === "." || part === "..")) return true;
  }
  return false;
}

export function normalizeExternalUrl(value) {
  if (typeof value !== "string" || value.length === 0 || utf8.encode(value).byteLength > MAX_URL_BYTES) {
    throw new TypeError("external URL is missing or too long");
  }
  if (!value.startsWith("https://") || value.includes("#") || value.includes("\\") || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new TypeError("external URL must be a direct absolute HTTPS URL");
  }
  if (hasMalformedPercentEncoding(value)) throw new TypeError("external URL contains malformed percent encoding");
  const authorityEnd = value.indexOf("/", "https://".length);
  const rawPath = authorityEnd === -1 ? "/" : value.slice(authorityEnd).split("?", 1)[0];
  if (containsEncodedTraversal(rawPath)) throw new TypeError("external URL contains an encoded traversal segment");

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("external URL is malformed");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new TypeError("external URL contains forbidden authority or fragment data");
  }
  if (utf8.encode(parsed.href).byteLength > MAX_URL_BYTES) throw new TypeError("normalized external URL is too long");
  return parsed.href;
}

export function validateDeploymentDigest(value) {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError("deployment digest must be lowercase SHA-256 hex");
  }
  return value;
}

export function validateLibraryConfig(value) {
  if (!Array.isArray(value) || value.length > MAX_EXTERNAL_LIBRARIES) {
    throw new TypeError("external library configuration must contain zero through five entries");
  }

  const manifestUrls = new Set();
  const entries = value.map((entry) => {
    if (!isRecord(entry)) throw new TypeError("external library configuration entries must be plain records");
    const fields = Object.keys(entry).sort();
    if (fields.length !== CONFIG_FIELDS.length || fields.some((field, index) => field !== CONFIG_FIELDS[index])) {
      throw new TypeError("external library configuration entry fields are incomplete or unknown");
    }
    const manifestUrl = normalizeExternalUrl(entry.manifestUrl);
    if (manifestUrls.has(manifestUrl)) throw new TypeError("external library manifest URLs must be unique");
    manifestUrls.add(manifestUrl);
    const normalized = {
      manifestUrl,
      sha256: validateDeploymentDigest(entry.sha256),
    };
    return Object.freeze(normalized);
  });

  return Object.freeze(entries);
}
