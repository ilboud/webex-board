const CATEGORY_IDS = Object.freeze([
  "router",
  "switch",
  "firewall",
  "cloud",
  "server",
  "storage",
  "branch",
  "user",
  "load-balancer",
  "internet-wan",
]);

const LEGACY_INTENTS = Object.freeze({
  circle: "router",
  rectangle: "switch",
  cloud: "cloud",
});

const BUILT_IN_ICONS = [
  {
    id: "router",
    label: "Router",
    keywords: ["router", "network", "gateway"],
    sourceKind: "cisco-jpeg",
    src: "./assets/cisco-topology/router.jpg",
    width: 77,
    height: 52,
    aspectRatio: 77 / 52,
  },
  {
    id: "switch",
    label: "Switch",
    keywords: ["switch", "network", "lan"],
    sourceKind: "cisco-jpeg",
    src: "./assets/cisco-topology/workgroup switch.jpg",
    width: 102,
    height: 51,
    aspectRatio: 2,
  },
  {
    id: "firewall",
    label: "Firewall",
    keywords: ["firewall", "security", "network"],
    sourceKind: "cisco-jpeg",
    src: "./assets/cisco-topology/firewall.jpg",
    width: 31,
    height: 69,
    aspectRatio: 31 / 69,
  },
  {
    id: "cloud",
    label: "Cloud",
    keywords: ["cloud", "network", "service"],
    sourceKind: "cisco-jpeg",
    src: "./assets/cisco-topology/cloud.jpg",
    width: 172,
    height: 100,
    aspectRatio: 1.72,
  },
  {
    id: "server",
    label: "Server",
    keywords: ["server", "file", "host"],
    sourceKind: "cisco-jpeg",
    src: "./assets/cisco-topology/file server.jpg",
    width: 44,
    height: 58,
    aspectRatio: 44 / 58,
  },
  {
    id: "storage",
    label: "Storage / Database",
    keywords: ["storage", "database", "data"],
    sourceKind: "cisco-jpeg",
    src: "./assets/cisco-topology/relational database.jpg",
    width: 66,
    height: 53,
    aspectRatio: 66 / 53,
  },
  {
    id: "branch",
    label: "Branch / Site",
    keywords: ["branch", "site", "office"],
    sourceKind: "cisco-jpeg",
    src: "./assets/cisco-topology/branch office.jpg",
    width: 53,
    height: 77,
    aspectRatio: 53 / 77,
  },
  {
    id: "user",
    label: "User / Client",
    keywords: ["user", "client", "person"],
    sourceKind: "cisco-jpeg",
    src: "./assets/cisco-topology/androgenous person.jpg",
    width: 69,
    height: 80,
    aspectRatio: 69 / 80,
  },
  {
    id: "load-balancer",
    label: "Load Balancer",
    keywords: ["load balancer", "ace", "traffic"],
    sourceKind: "cisco-jpeg",
    src: "./assets/cisco-topology/ace.jpg",
    width: 91,
    height: 66,
    aspectRatio: 91 / 66,
  },
  {
    id: "internet-wan",
    label: "Internet / WAN",
    keywords: ["internet", "wan", "globe"],
    sourceKind: "heroicons-svg",
    src: "./assets/heroicons/topology/globe-alt.svg",
    width: 24,
    height: 24,
    aspectRatio: 1,
  },
];

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_SOURCE_KIND = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNSAFE_TEXT = /[\u0000-\u001f<>]/;
const DESCRIPTOR_FIELDS = Object.freeze([
  "aspectRatio",
  "height",
  "id",
  "keywords",
  "label",
  "sourceKind",
  "src",
  "width",
]);

function assertSafeText(value, name) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || UNSAFE_TEXT.test(value)) {
    throw new TypeError(`${name} must be non-empty safe text`);
  }
}

function assertLocalAssetSource(src) {
  assertSafeText(src, "descriptor src");
  if (!src.startsWith("./assets/") || src.includes("\\") || src.includes("?") || src.includes("#")) {
    throw new TypeError("descriptor src must be a repository-subpath-safe local asset URL");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    throw new TypeError("descriptor src must have valid URL encoding");
  }
  if (decoded.split("/").includes("..")) {
    throw new TypeError("descriptor src must not traverse directories");
  }
}

function validateDescriptor(entry) {
  if (!entry || Object.getPrototypeOf(entry) !== Object.prototype) {
    throw new TypeError("catalog descriptors must be plain objects");
  }
  const fields = Object.keys(entry).sort();
  if (fields.length !== DESCRIPTOR_FIELDS.length || fields.some((field, index) => field !== DESCRIPTOR_FIELDS[index])) {
    throw new TypeError("catalog descriptor fields are incomplete or unknown");
  }
  if (!SAFE_ID.test(entry.id)) throw new TypeError("descriptor id is invalid");
  assertSafeText(entry.label, "descriptor label");
  if (!Array.isArray(entry.keywords) || entry.keywords.length === 0) {
    throw new TypeError("descriptor keywords must be a non-empty array");
  }
  const keywords = entry.keywords.map((keyword) => {
    assertSafeText(keyword, "descriptor keyword");
    return keyword;
  });
  if (new Set(keywords).size !== keywords.length) throw new TypeError("descriptor keywords must be unique");
  if (typeof entry.sourceKind !== "string" || !SAFE_SOURCE_KIND.test(entry.sourceKind)) {
    throw new TypeError("descriptor sourceKind is invalid");
  }
  assertLocalAssetSource(entry.src);
  if (!Number.isInteger(entry.width) || entry.width <= 0 || !Number.isInteger(entry.height) || entry.height <= 0) {
    throw new TypeError("descriptor intrinsic dimensions must be positive integers");
  }
  if (!Number.isFinite(entry.aspectRatio) || entry.aspectRatio <= 0 || Math.abs(entry.aspectRatio - entry.width / entry.height) > 1e-12) {
    throw new TypeError("descriptor aspectRatio must match its intrinsic dimensions");
  }
  return Object.freeze({ ...entry, keywords: Object.freeze(keywords) });
}

export function createIconCatalog(entries, { aliases = {}, requiredIds = [] } = {}) {
  if (!Array.isArray(entries)) throw new TypeError("catalog entries must be an array");
  if (!aliases || Object.getPrototypeOf(aliases) !== Object.prototype || !Array.isArray(requiredIds)) {
    throw new TypeError("catalog options are invalid");
  }

  const byId = new Map();
  for (const entry of entries) {
    const descriptor = validateDescriptor(entry);
    if (byId.has(descriptor.id)) throw new TypeError(`duplicate catalog id: ${descriptor.id}`);
    byId.set(descriptor.id, descriptor);
  }

  for (const id of requiredIds) {
    if (!SAFE_ID.test(id)) throw new TypeError(`invalid required catalog id: ${id}`);
    if (!byId.has(id)) throw new TypeError(`missing required catalog id: ${id}`);
  }
  if (byId.size !== requiredIds.length && requiredIds.length > 0) {
    throw new TypeError("catalog contains an unexpected category");
  }

  const aliasMap = new Map();
  for (const [alias, id] of Object.entries(aliases)) {
    if (!SAFE_ID.test(alias) || !SAFE_ID.test(id) || !byId.has(id)) {
      throw new TypeError(`invalid catalog alias: ${alias}`);
    }
    if (byId.has(alias) && alias !== id) throw new TypeError(`catalog alias conflicts with category: ${alias}`);
    aliasMap.set(alias, id);
  }

  const listed = Object.freeze([...byId.values()]);
  return Object.freeze({
    lookup(intentOrCategory) {
      if (typeof intentOrCategory !== "string") return null;
      const id = aliasMap.get(intentOrCategory) ?? intentOrCategory;
      return byId.get(id) ?? null;
    },
    list() {
      return listed;
    },
  });
}

export const BUILT_IN_CATEGORY_IDS = CATEGORY_IDS;
export const productionIconCatalog = createIconCatalog(BUILT_IN_ICONS, {
  aliases: LEGACY_INTENTS,
  requiredIds: CATEGORY_IDS,
});
