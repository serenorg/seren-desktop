// ABOUTME: ESM re-export shim for qrcode CJS package.
// ABOUTME: Fixes Vite dynamic import interop in Thirdweb's WalletConnect QR overlay.

// qrcode/lib/browser.js is pure CJS — it only assigns to `exports.<name>`,
// never `module.exports = X`, so there is no synthesizable default export.
// Vite 8 / Rolldown is strict about this and refuses to fake a default,
// which white-screens the dev build (#1476). Use a namespace import instead
// and re-export both the named members and a synthetic default object.
//
// The `qrcode` alias in vite.config.ts uses an exact-match regex (^qrcode$)
// so this subpath specifier resolves to the real package and Vite's
// optimizeDeps prebundles the CJS for browser ESM consumption.
// @ts-expect-error subpath import has no types
import * as qrcode from "qrcode/lib/browser.js";

export const create = qrcode.create;
export const toCanvas = qrcode.toCanvas;
export const toDataURL = qrcode.toDataURL;
export const toStr = qrcode.toString;
export default {
  create: qrcode.create,
  toCanvas: qrcode.toCanvas,
  toDataURL: qrcode.toDataURL,
  toString: qrcode.toString,
};
