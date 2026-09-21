# Network Icon Whiteboard

A build-free, client-side drawing proof of concept for desktop browsers and Cisco Desk Pro Web Apps. Draw one closed circle, rectangle, or cloud-like outline. A clear match becomes a network icon; an uncertain match offers Accept and Dismiss. Undo restores replacements to their exact source stroke, and Clear removes the board.

The application sends and stores no drawing content. It has no backend, account integration, analytics, or device-service calls. It is a standalone web application and does not modify a Cisco built-in whiteboard feature.

## Run locally

Serve the repository root over HTTP – ES modules do not run reliably from a `file:` URL:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/`. No build step is required.

## Add as a Desk Pro Web App

1. Publish the allowed static files at a stable HTTPS URL. GitHub Pages publication is a separate, manual owner action; the checked-in workflow cannot run automatically.
2. In the device web-app management UI, add a new Web App whose URL is the published repository-subpath URL.
3. Open the Web App on the Desk Pro and confirm that the complete toolbar and drawing surface load.
4. Follow the [recognition exemplar guide](./docs/recognition-exemplars.md) with a finger or stylus. Record the RoomOS version, `window.innerWidth`, `window.innerHeight`, and `window.devicePixelRatio` for device evidence.

The UI is touch-first. Undo, Clear, and contextual Accept/Dismiss controls have at least 44 by 44 CSS-pixel targets. Physical display pixels and CSS pixels are not assumed to be equal.

## Recognition behavior

Recognition runs only after normal completion of one pointer stroke. Cancelled, interrupted, malformed, open, unsupported, or over-4096-point input remains ink. High-confidence input is replaced automatically. Medium-confidence input remains visible with Accept and Dismiss. Low-confidence input remains ink without a suggestion.

Confidence thresholds are static deployment-time source values in `src/confidence-config.js`; there is no settings, URL, or storage override.

## Verification

```sh
npm install
npm run check:static
npm run test:unit
npm run verify:assets
npx playwright install chromium
npm run test:browser
```

The only direct development dependency is the exact lockfile-pinned Playwright test package. Browser tests start a loopback-only static server.

## Third-party material

The three icons are unmodified outlined [Google Material Symbols](https://github.com/google/material-design-icons) files pinned to commit [`27e9ef1dbeedc13d682fece4a58e1eda4cb0961a`](https://github.com/google/material-design-icons/tree/27e9ef1dbeedc13d682fece4a58e1eda4cb0961a). See the [digest and source manifest](./assets/material-symbols/asset-manifest.json), [third-party notices](./THIRD_PARTY_NOTICES.md), and included [Apache License 2.0](./LICENSES/Apache-2.0.txt).
