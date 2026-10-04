import { normalizeExternalUrl, validateLibraryConfig } from "./library-config.js";

export const EXTERNAL_LIBRARY_LIMITS = Object.freeze({
  manifestBytes: 256 * 1024,
  imageBytes: 512 * 1024,
  aggregateBytes: 10 * 1024 * 1024,
  maxIcons: 50,
  maxDimension: 2048,
  imageConcurrency: 4,
  requestDeadlineMs: 10_000,
});

const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MANIFEST_FIELDS = Object.freeze(["icons", "id", "label", "schemaVersion"]);
const ICON_REQUIRED_FIELDS = Object.freeze(["byteLength", "id", "label", "mediaType", "sha256", "src"]);
const ICON_OPTIONAL_FIELDS = Object.freeze(["keywords"]);
const SAFE_ID = /^[a-z0-9](?:[a-z0-9_-]{0,63})$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const decoder = new TextDecoder("utf-8", { fatal: true });

const ERROR_MESSAGES = Object.freeze({
  "aggregate-limit": "The external library cannot fit in the session image budget.",
  cancelled: "External library loading was cancelled.",
  "configuration-invalid": "The external library configuration is invalid.",
  "decode-failed": "An external icon could not be decoded.",
  "duplicate-library-id": "The external library identifier is already in use.",
  "image-http": "An external icon request failed.",
  "image-network": "An external icon could not be downloaded.",
  "image-redirect": "An external icon redirect was rejected.",
  "image-timeout": "An external icon request timed out.",
  "image-validation": "External icon bytes failed validation.",
  "manifest-content-type": "The external library response is not UTF-8 JSON.",
  "manifest-http": "The external library request failed.",
  "manifest-network": "The external library could not be downloaded.",
  "manifest-timeout": "The external library request timed out.",
  "manifest-validation": "The external library failed validation.",
});

class LoadFault extends Error {
  constructor(reasonCode, scope, cause) {
    super(ERROR_MESSAGES[reasonCode] ?? ERROR_MESSAGES[scope === "icon" ? "image-validation" : "manifest-validation"]);
    this.name = "LoadFault";
    this.reasonCode = reasonCode;
    this.scope = scope;
    if (cause !== undefined) this.cause = cause;
  }
}

function fault(reasonCode, scope, cause) {
  return new LoadFault(reasonCode, scope, cause);
}

function ownFields(value, required, optional = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw fault("manifest-validation", "library");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw fault("manifest-validation", "library");
  const keys = Object.keys(value).sort();
  if (keys.some((key) => RESERVED_KEYS.has(key))) throw fault("manifest-validation", "library");
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw fault("manifest-validation", "library");
  }
  return keys;
}

function scalarLength(value) {
  if (typeof value !== "string" || /[\ud800-\udfff]/u.test(value)) return -1;
  return Array.from(value).length;
}

function safeText(value, minimum, maximum) {
  const length = scalarLength(value);
  return length >= minimum && length <= maximum && !/[\u0000-\u001f<>]/u.test(value);
}

function safeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function safeDigest(value) {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function exactFields(value, expected) {
  const keys = ownFields(value, expected);
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function jsonParser(source) {
  let index = 0;
  const fail = () => { throw fault("manifest-validation", "library"); };
  const whitespace = () => { while (source[index] === " " || source[index] === "\t" || source[index] === "\n" || source[index] === "\r") index += 1; };

  function string() {
    const start = index;
    if (source[index] !== '"') fail();
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index += 1;
        try { return JSON.parse(source.slice(start, index)); } catch { fail(); }
      }
      if (character === "\\") {
        index += 1;
        const escape = source[index];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(index + 1, index + 5))) fail();
          index += 5;
          continue;
        }
        if (!['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape)) fail();
      } else {
        if (character.charCodeAt(0) < 0x20) fail();
      }
      index += 1;
    }
    fail();
  }

  function number() {
    const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) fail();
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail();
    return value;
  }

  function array() {
    index += 1;
    const result = [];
    whitespace();
    if (source[index] === "]") { index += 1; return result; }
    while (true) {
      result.push(value());
      whitespace();
      if (source[index] === "]") { index += 1; return result; }
      if (source[index] !== ",") fail();
      index += 1;
      whitespace();
    }
  }

  function object() {
    index += 1;
    const result = Object.create(null);
    const seen = new Set();
    whitespace();
    if (source[index] === "}") { index += 1; return result; }
    while (true) {
      if (source[index] !== '"') fail();
      const key = string();
      if (seen.has(key) || RESERVED_KEYS.has(key)) fail();
      seen.add(key);
      whitespace();
      if (source[index] !== ":") fail();
      index += 1;
      result[key] = value();
      whitespace();
      if (source[index] === "}") { index += 1; return result; }
      if (source[index] !== ",") fail();
      index += 1;
      whitespace();
    }
  }

  function value() {
    whitespace();
    const character = source[index];
    if (character === '"') return string();
    if (character === "{") return object();
    if (character === "[") return array();
    if (source.startsWith("true", index)) { index += 4; return true; }
    if (source.startsWith("false", index)) { index += 5; return false; }
    if (source.startsWith("null", index)) { index += 4; return null; }
    return number();
  }

  const result = value();
  whitespace();
  if (index !== source.length) fail();
  return result;
}

export function parseJsonWithoutDuplicateMembers(bytesOrText) {
  let source;
  try {
    source = typeof bytesOrText === "string" ? bytesOrText : decoder.decode(bytesOrText);
  } catch (error) {
    throw fault("manifest-validation", "library", error);
  }
  return jsonParser(source);
}

export function requireManifestContentType(value) {
  if (typeof value !== "string") throw fault("manifest-content-type", "library");
  const match = value.match(/^\s*application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i);
  if (!match) throw fault("manifest-content-type", "library");
  return true;
}

function normalizeKeywords(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 20) throw fault("manifest-validation", "library");
  let aggregate = 0;
  const keywords = value.map((keyword) => {
    const length = scalarLength(keyword);
    if (length < 1 || length > 50 || !safeText(keyword, 1, 50)) throw fault("manifest-validation", "library");
    aggregate += length;
    return keyword;
  });
  if (aggregate > 500) throw fault("manifest-validation", "library");
  return Object.freeze(keywords);
}

export function normalizeExternalManifest(value, manifestUrl) {
  if (!exactFields(value, MANIFEST_FIELDS) || value.schemaVersion !== 1 || !safeId(value.id) || !safeText(value.label, 1, 100)) {
    throw fault("manifest-validation", "library");
  }
  if (!Array.isArray(value.icons) || value.icons.length > EXTERNAL_LIBRARY_LIMITS.maxIcons) {
    throw fault("manifest-validation", "library");
  }
  const origin = new URL(normalizeExternalUrl(manifestUrl)).origin;
  const iconIds = new Set();
  const icons = value.icons.map((icon) => {
    const fields = ownFields(icon, ICON_REQUIRED_FIELDS, ICON_OPTIONAL_FIELDS);
    const expectedLength = ICON_REQUIRED_FIELDS.length + (Object.hasOwn(icon, "keywords") ? 1 : 0);
    if (fields.length !== expectedLength || !safeId(icon.id) || iconIds.has(icon.id) || !safeText(icon.label, 1, 100)) {
      throw fault("manifest-validation", "library");
    }
    if (!safeDigest(icon.sha256) || !Number.isInteger(icon.byteLength) || icon.byteLength < 1 || icon.byteLength > EXTERNAL_LIBRARY_LIMITS.imageBytes || !MEDIA_TYPES.has(icon.mediaType)) {
      throw fault("manifest-validation", "library");
    }
    const provenanceUrl = normalizeExternalUrl(icon.src);
    if (new URL(provenanceUrl).origin !== origin) throw fault("manifest-validation", "library");
    iconIds.add(icon.id);
    return Object.freeze({
      id: icon.id,
      label: icon.label,
      keywords: normalizeKeywords(icon.keywords),
      provenanceUrl,
      sha256: icon.sha256,
      byteLength: icon.byteLength,
      mediaType: icon.mediaType,
    });
  });
  return Object.freeze({ schemaVersion: 1, id: value.id, label: value.label, icons: Object.freeze(icons) });
}

function uint32be(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function inspectPng(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((byte, index) => bytes[index] !== byte) || uint32be(bytes, 8) !== 13 || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") {
    throw fault("image-validation", "library");
  }
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const validDepths = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (!validDepths[colorType]?.includes(bitDepth) || bytes[26] !== 0 || bytes[27] !== 0 || ![0, 1].includes(bytes[28])) {
    throw fault("image-validation", "library");
  }
  return { width: uint32be(bytes, 16), height: uint32be(bytes, 20) };
}

function inspectJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw fault("image-validation", "library");
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (startOfFrame.has(marker)) {
      const components = bytes[offset + 7];
      if (![8, 12].includes(bytes[offset + 2]) || !Number.isInteger(components) || components < 1 || components > 4 || length !== 8 + components * 3) break;
      return { width: (bytes[offset + 5] << 8) | bytes[offset + 6], height: (bytes[offset + 3] << 8) | bytes[offset + 4] };
    }
    offset += length;
  }
  throw fault("image-validation", "library");
}

function inspectWebp(bytes) {
  if (bytes.length < 21 || String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP") {
    throw fault("image-validation", "library");
  }
  const riffLength = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
  const kind = String.fromCharCode(...bytes.slice(12, 16));
  const chunkLength = (bytes[16] | (bytes[17] << 8) | (bytes[18] << 16) | (bytes[19] << 24)) >>> 0;
  if (riffLength + 8 !== bytes.length || 20 + chunkLength + (chunkLength % 2) > bytes.length) throw fault("image-validation", "library");
  if (kind === "VP8X" && chunkLength >= 10) {
    return {
      width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
      height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
    };
  }
  if (kind === "VP8 " && chunkLength >= 10 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
  }
  if (kind === "VP8L" && chunkLength >= 5 && bytes[20] === 0x2f) {
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  throw fault("image-validation", "library");
}

export function inspectRasterHeader(bytes, mediaType) {
  if (!(bytes instanceof Uint8Array)) throw fault("image-validation", "library");
  let dimensions;
  if (mediaType === "image/png") dimensions = inspectPng(bytes);
  else if (mediaType === "image/jpeg") dimensions = inspectJpeg(bytes);
  else if (mediaType === "image/webp") dimensions = inspectWebp(bytes);
  else throw fault("image-validation", "library");
  if (!Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > EXTERNAL_LIBRARY_LIMITS.maxDimension || dimensions.height > EXTERNAL_LIBRARY_LIMITS.maxDimension) {
    throw fault("image-validation", "library");
  }
  return Object.freeze(dimensions);
}

export async function readBoundedResponseBody(response, maximumBytes, signal) {
  if (!response?.body || typeof response.body.getReader !== "function") throw fault("manifest-network", "library");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? fault("cancelled", "library");
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw fault("manifest-network", "library");
      length += value.byteLength;
      if (length > maximumBytes) {
        reader.cancel("decoded body limit exceeded").catch(() => {});
        throw fault("manifest-validation", "library");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function defaultDigest(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function defaultDecode(blob) {
  if (typeof createImageBitmap !== "function") throw new Error("native raster decoder unavailable");
  return createImageBitmap(blob);
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) ?? null;
}

function fixedError(reasonCode) {
  return Object.freeze({ reasonCode, message: ERROR_MESSAGES[reasonCode] ?? "The external library failed validation." });
}

function freezeIconError(id, reasonCode) {
  return Object.freeze({ id, status: "error", ...fixedError(reasonCode) });
}

function freezeLibraryState(state) {
  return Object.freeze({
    configIndex: state.configIndex,
    status: state.status,
    label: state.label,
    reasonCode: state.reasonCode,
    message: state.message,
    icons: Object.freeze([...state.icons]),
    iconErrors: Object.freeze([...state.iconErrors]),
    reservedBytes: state.reservedBytes,
    retainedBytes: state.retainedBytes,
  });
}

function linkController(generation, libraryController) {
  const controller = new AbortController();
  const abort = (event) => controller.abort(event?.target?.reason);
  generation.controller.signal.addEventListener("abort", abort, { once: true });
  libraryController?.signal.addEventListener("abort", abort, { once: true });
  generation.controllers.add(controller);
  return {
    controller,
    dispose() {
      generation.controller.signal.removeEventListener("abort", abort);
      libraryController?.signal.removeEventListener("abort", abort);
      generation.controllers.delete(controller);
    },
  };
}

function deadlineRace(promise, expiresAt, monotonicNow, controller, generation, timeoutFault, token) {
  let timer;
  let rejectOnAbort;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      token.active = false;
      controller.abort(timeoutFault);
      reject(timeoutFault);
    }, Math.max(0, expiresAt - monotonicNow()));
  });
  const aborted = new Promise((resolve, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason ?? fault("cancelled", "library"));
    if (controller.signal.aborted) rejectOnAbort();
    else controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  return Promise.race([promise, timeout, aborted, generation.cancelPromise]).finally(() => {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", rejectOnAbort);
  });
}

function classifyFetchError(error, kind) {
  if (error instanceof LoadFault) return error;
  if (error?.name === "AbortError") return fault(kind === "image" ? "image-network" : "manifest-network", kind === "image" ? "icon" : "library", error);
  return fault(kind === "image" ? "image-network" : "manifest-network", kind === "image" ? "icon" : "library", error);
}

function createGeneration(id, entries) {
  let cancel;
  const cancelPromise = new Promise((resolve, reject) => { cancel = reject; });
  cancelPromise.catch(() => {});
  return {
    id,
    active: true,
    controller: new AbortController(),
    controllers: new Set(),
    cancel,
    cancelPromise,
    reservedBytes: 0,
    retainedBytes: 0,
    urls: new Set(),
    libraries: entries.map((entry, configIndex) => ({
      configIndex,
      config: entry,
      status: "loading",
      label: `External library ${configIndex + 1}`,
      reasonCode: null,
      message: "Loading external library.",
      icons: [],
      iconErrors: [],
      reservedBytes: 0,
      retainedBytes: 0,
      urls: new Set(),
    })),
  };
}

export function createExternalIconLibrary(options = {}) {
  const adapters = Object.freeze({
    fetch: options.fetch ?? globalThis.fetch?.bind(globalThis),
    digest: options.digest ?? defaultDigest,
    decode: options.decode ?? defaultDecode,
    createObjectURL: options.createObjectURL ?? URL.createObjectURL.bind(URL),
    revokeObjectURL: options.revokeObjectURL ?? URL.revokeObjectURL.bind(URL),
    Blob: options.Blob ?? Blob,
    deadlineMs: options.deadlineMs ?? EXTERNAL_LIBRARY_LIMITS.requestDeadlineMs,
    monotonicNow: options.now ?? globalThis.performance?.now?.bind(globalThis.performance),
  });
  if ([adapters.fetch, adapters.digest, adapters.decode, adapters.createObjectURL, adapters.revokeObjectURL, adapters.monotonicNow].some((adapter) => typeof adapter !== "function") || typeof adapters.Blob !== "function" || !Number.isFinite(adapters.deadlineMs) || adapters.deadlineMs <= 0) {
    throw new TypeError("external library adapters are invalid");
  }

  let sequence = 0;
  let current = null;
  let destroyed = false;
  const listeners = new Set();

  const snapshotOf = (generation = current) => Object.freeze({
    generation: generation?.id ?? sequence,
    destroyed,
    reservedBytes: generation?.reservedBytes ?? 0,
    retainedBytes: generation?.retainedBytes ?? 0,
    libraries: Object.freeze(generation ? generation.libraries.map(freezeLibraryState) : []),
  });

  const publish = (generation) => {
    if (generation !== current || !generation.active || destroyed) return;
    const snapshot = snapshotOf(generation);
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* A caller cannot break resource cleanup. */ }
    }
  };

  const releaseIconReservation = (generation, library, bytes) => {
    library.reservedBytes -= bytes;
    generation.reservedBytes -= bytes;
  };

  const revokeLibraryUrls = (generation, library) => {
    for (const url of library.urls) {
      if (generation.urls.delete(url)) adapters.revokeObjectURL(url);
    }
    library.urls.clear();
  };

  const rejectLibrary = (generation, library, reasonCode) => {
    revokeLibraryUrls(generation, library);
    generation.reservedBytes -= library.reservedBytes;
    generation.retainedBytes -= library.retainedBytes;
    library.reservedBytes = 0;
    library.retainedBytes = 0;
    library.icons = [];
    library.iconErrors = [];
    library.status = "error";
    Object.assign(library, fixedError(reasonCode));
  };

  const stopGeneration = (generation, reasonCode = "cancelled") => {
    if (!generation?.active) return;
    generation.active = false;
    const error = fault(reasonCode, "library");
    generation.controller.abort(error);
    for (const controller of generation.controllers) controller.abort(error);
    generation.controllers.clear();
    generation.cancel(error);
    for (const url of generation.urls) adapters.revokeObjectURL(url);
    generation.urls.clear();
    generation.reservedBytes = 0;
    generation.retainedBytes = 0;
    for (const library of generation.libraries) {
      library.reservedBytes = 0;
      library.retainedBytes = 0;
      library.urls.clear();
      library.icons = [];
      library.iconErrors = [];
      library.status = "error";
      Object.assign(library, fixedError(reasonCode));
    }
  };

  const ensureCurrent = (generation, token) => {
    if (generation !== current || !generation.active || destroyed || !token.active) throw fault("cancelled", "library");
  };

  async function fetchManifest(generation, library) {
    const linked = linkController(generation);
    const token = { active: true };
    const expiresAt = adapters.monotonicNow() + adapters.deadlineMs;
    const operation = (async () => {
      let response;
      try {
        response = await adapters.fetch(library.config.manifestUrl, { credentials: "omit", redirect: "error", signal: linked.controller.signal });
      } catch (error) {
        throw classifyFetchError(error, "manifest");
      }
      if (!response?.ok) throw fault("manifest-http", "library");
      requireManifestContentType(responseHeader(response, "content-type"));
      let bytes;
      try {
        bytes = await readBoundedResponseBody(response, EXTERNAL_LIBRARY_LIMITS.manifestBytes, linked.controller.signal);
      } catch (error) {
        if (error instanceof LoadFault) throw error;
        throw fault("manifest-network", "library", error);
      }
      ensureCurrent(generation, token);
      if (await adapters.digest(bytes) !== library.config.sha256) throw fault("manifest-validation", "library");
      ensureCurrent(generation, token);
      return normalizeExternalManifest(parseJsonWithoutDuplicateMembers(bytes), library.config.manifestUrl);
    })();
    try {
      return await deadlineRace(operation, expiresAt, adapters.monotonicNow, linked.controller, generation, fault("manifest-timeout", "library"), token);
    } finally {
      token.active = false;
      linked.dispose();
    }
  }

  async function fetchImage(generation, library, manifest, icon, libraryController, admitIcon) {
    const linked = linkController(generation, libraryController);
    const token = { active: true };
    const timeoutError = fault("image-timeout", "icon");
    const expiresAt = adapters.monotonicNow() + adapters.deadlineMs;
    const checkDeadline = () => {
      ensureCurrent(generation, token);
      if (adapters.monotonicNow() >= expiresAt) {
        token.active = false;
        linked.controller.abort(timeoutError);
        throw timeoutError;
      }
    };
    const operation = (async () => {
      let response;
      try {
        response = await adapters.fetch(icon.provenanceUrl, { credentials: "omit", redirect: "error", signal: linked.controller.signal });
      } catch (error) {
        throw classifyFetchError(error, "image");
      }
      if (!response?.ok) throw fault("image-http", "icon");
      let bytes;
      try {
        bytes = await readBoundedResponseBody(response, Math.min(icon.byteLength, EXTERNAL_LIBRARY_LIMITS.imageBytes), linked.controller.signal);
      } catch (error) {
        if (error instanceof LoadFault && error.reasonCode === "manifest-validation") throw fault("image-validation", "library", error);
        throw error;
      }
      ensureCurrent(generation, token);
      if (bytes.byteLength !== icon.byteLength || await adapters.digest(bytes) !== icon.sha256) throw fault("image-validation", "library");
      const dimensions = inspectRasterHeader(bytes, icon.mediaType);
      ensureCurrent(generation, token);
      const blob = new adapters.Blob([bytes], { type: icon.mediaType });
      if (blob.type !== icon.mediaType) throw fault("image-validation", "library");
      let decoded;
      let decodedClosed = false;
      const closeDecoded = (result = decoded) => {
        if (decodedClosed) return;
        decodedClosed = true;
        result?.close?.();
      };
      try {
        const decodePromise = Promise.resolve(adapters.decode(blob, { signal: linked.controller.signal, inspected: dimensions }));
        decodePromise.then((lateResult) => {
          if (!token.active || generation !== current || !generation.active) closeDecoded(lateResult);
        }, () => {});
        decoded = await decodePromise;
      } catch (error) {
        throw fault("decode-failed", "icon", error);
      }
      try {
        checkDeadline();
        const decodedWidth = decoded?.width ?? decoded?.naturalWidth;
        checkDeadline();
        const decodedHeight = decoded?.height ?? decoded?.naturalHeight;
        checkDeadline();
        if (decodedWidth !== dimensions.width || decodedHeight !== dimensions.height) {
          throw fault("image-validation", "library");
        }
        checkDeadline();
        closeDecoded();
        checkDeadline();
      } catch (error) {
        closeDecoded();
        throw error;
      }

      let renderSrc;
      let registered = false;
      let accounted = false;
      const rollbackAdmission = () => {
        if (accounted) {
          library.retainedBytes -= bytes.byteLength;
          generation.retainedBytes -= bytes.byteLength;
          accounted = false;
        }
        if (registered) {
          library.urls.delete(renderSrc);
          generation.urls.delete(renderSrc);
          registered = false;
        }
        if (typeof renderSrc === "string") {
          adapters.revokeObjectURL(renderSrc);
          renderSrc = null;
        }
      };

      try {
        checkDeadline();
        renderSrc = adapters.createObjectURL(blob);
        if (typeof renderSrc !== "string" || !renderSrc.startsWith("blob:")) {
          if (typeof renderSrc === "string") adapters.revokeObjectURL(renderSrc);
          renderSrc = null;
          throw fault("image-validation", "library");
        }
        checkDeadline();

        checkDeadline();
        generation.urls.add(renderSrc);
        library.urls.add(renderSrc);
        registered = true;
        checkDeadline();

        checkDeadline();
        library.retainedBytes += bytes.byteLength;
        generation.retainedBytes += bytes.byteLength;
        accounted = true;
        checkDeadline();

        checkDeadline();
        const descriptor = Object.freeze({
          namespace: "external",
          identity: Object.freeze([manifest.id, icon.id]),
          libraryId: manifest.id,
          id: icon.id,
          label: icon.label,
          keywords: icon.keywords,
          mediaType: icon.mediaType,
          byteLength: icon.byteLength,
          width: dimensions.width,
          height: dimensions.height,
          aspectRatio: dimensions.width / dimensions.height,
          provenanceUrl: icon.provenanceUrl,
          renderSrc,
          status: "ready",
        });
        checkDeadline();

        checkDeadline();
        admitIcon(descriptor);
        checkDeadline();
      } catch (error) {
        rollbackAdmission();
        throw error;
      }
    })();
    try {
      return await deadlineRace(operation, expiresAt, adapters.monotonicNow, linked.controller, generation, timeoutError, token);
    } finally {
      token.active = false;
      linked.dispose();
    }
  }

  async function loadImages(generation, library, manifest) {
    const libraryController = new AbortController();
    const outcomes = new Array(manifest.icons.length);
    let next = 0;
    let fatalError = null;

    const worker = async () => {
      while (fatalError === null) {
        const index = next;
        next += 1;
        if (index >= manifest.icons.length) return;
        const icon = manifest.icons[index];
        try {
          await fetchImage(generation, library, manifest, icon, libraryController, (descriptor) => {
            outcomes[index] = { icon: descriptor };
          });
        } catch (error) {
          const failure = error instanceof LoadFault ? error : fault("image-network", "icon", error);
          if (failure.reasonCode === "cancelled") throw failure;
          if (failure.scope === "library") {
            fatalError = failure;
            libraryController.abort(failure);
            return;
          }
          releaseIconReservation(generation, library, icon.byteLength);
          outcomes[index] = { error: freezeIconError(icon.id, failure.reasonCode) };
        }
      }
    };

    const workers = Array.from({ length: Math.min(EXTERNAL_LIBRARY_LIMITS.imageConcurrency, manifest.icons.length) }, () => worker());
    await Promise.all(workers);
    if (fatalError) throw fatalError;
    ensureCurrent(generation, { active: true });
    library.icons = outcomes.filter((outcome) => outcome?.icon).map((outcome) => outcome.icon);
    library.iconErrors = outcomes.filter((outcome) => outcome?.error).map((outcome) => outcome.error);
    library.status = library.iconErrors.length === 0 ? "ready" : "ready-with-errors";
    library.reasonCode = null;
    library.message = library.status === "ready" ? "External library ready." : "External library ready with unavailable icons.";
  }

  async function processGeneration(generation) {
    const libraryIds = new Set();
    let exhausted = false;
    for (const library of generation.libraries) {
      if (generation !== current || !generation.active || destroyed) break;
      if (exhausted) {
        rejectLibrary(generation, library, "aggregate-limit");
        publish(generation);
        continue;
      }
      try {
        const manifest = await fetchManifest(generation, library);
        ensureCurrent(generation, { active: true });
        library.label = manifest.label;
        if (libraryIds.has(manifest.id)) {
          rejectLibrary(generation, library, "duplicate-library-id");
          publish(generation);
          continue;
        }
        libraryIds.add(manifest.id);
        const declaredTotal = manifest.icons.reduce((sum, icon) => sum + icon.byteLength, 0);
        if (declaredTotal > EXTERNAL_LIBRARY_LIMITS.aggregateBytes - generation.reservedBytes) {
          exhausted = true;
          rejectLibrary(generation, library, "aggregate-limit");
          publish(generation);
          continue;
        }
        generation.reservedBytes += declaredTotal;
        library.reservedBytes = declaredTotal;
        await loadImages(generation, library, manifest);
      } catch (error) {
        const failure = error instanceof LoadFault ? error : fault("manifest-validation", "library", error);
        if (failure.reasonCode === "cancelled" || generation !== current || !generation.active || destroyed) break;
        rejectLibrary(generation, library, failure.reasonCode);
      }
      publish(generation);
    }
    return snapshotOf(generation);
  }

  return Object.freeze({
    replace(configuration) {
      if (destroyed) throw new Error("external library loader is destroyed");
      let entries;
      try {
        entries = validateLibraryConfig(configuration);
      } catch (error) {
        throw fault("configuration-invalid", "library", error);
      }
      if (current) stopGeneration(current);
      const generation = createGeneration(++sequence, entries);
      current = generation;
      publish(generation);
      return processGeneration(generation);
    },
    getSnapshot() {
      return snapshotOf();
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      listeners.add(listener);
      listener(snapshotOf());
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (current) stopGeneration(current);
      current = null;
      listeners.clear();
    },
  });
}
