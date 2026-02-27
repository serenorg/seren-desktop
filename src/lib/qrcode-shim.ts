// ABOUTME: ESM re-export shim for qrcode CJS package.
// ABOUTME: Fixes Vite dynamic import interop in Thirdweb's WalletConnect QR overlay.

// Import from the real CJS file path to avoid circular alias resolution.
// @ts-expect-error direct path import has no types
import qrcode from "../../node_modules/qrcode/lib/browser.js";

export const create = qrcode.create;
export const toCanvas = qrcode.toCanvas;
export const toDataURL = qrcode.toDataURL;
export const toStr = qrcode.toString;
export default qrcode;
