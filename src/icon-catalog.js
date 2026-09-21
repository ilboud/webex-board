const ICONS = Object.freeze({
  circle: Object.freeze({ id: "router", label: "Router", src: "./assets/material-symbols/router.svg", aspectRatio: 1 }),
  rectangle: Object.freeze({ id: "lan", label: "LAN", src: "./assets/material-symbols/lan.svg", aspectRatio: 1 }),
  cloud: Object.freeze({ id: "cloud", label: "Cloud", src: "./assets/material-symbols/cloud.svg", aspectRatio: 1 }),
});

export function createIconCatalog(entries) {
  const catalog = new Map(Object.entries(entries));
  return Object.freeze({
    lookup(category) {
      const icon = catalog.get(category);
      return icon ? Object.freeze({ ...icon }) : null;
    },
  });
}

export const productionIconCatalog = createIconCatalog(ICONS);
