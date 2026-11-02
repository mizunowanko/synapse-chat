/**
 * What the MCP server knows on its own, on top of the grant: which apps are
 * browsers (the approval screen warns about them; they are otherwise treated
 * like any granted app), and that coordinates are in the last screenshot's pixels.
 */
import type { HelperScreenshot } from "./contract.js";

/**
 * Browsers. Since 0.12.0 a granted browser takes input like any other app
 * (syn-9); this list only marks the request (`DesktopAppRequest.browser`) so
 * the approval screen can warn that a browser reaches everything the user is
 * signed in to. Whether it is screenshot-only is the approval's call (`readOnly`).
 */
export const BROWSER_BUNDLE_IDS: readonly string[] = [
  "com.apple.Safari",
  "com.apple.SafariTechnologyPreview",
  "com.google.Chrome",
  "com.google.Chrome.beta",
  "com.google.Chrome.dev",
  "com.google.Chrome.canary",
  "org.chromium.Chromium",
  "company.thebrowser.Browser",
  "company.thebrowser.dia",
  "org.mozilla.firefox",
  "org.mozilla.firefoxdeveloperedition",
  "org.mozilla.nightly",
  "com.microsoft.edgemac",
  "com.microsoft.edgemac.Beta",
  "com.microsoft.edgemac.Dev",
  "com.microsoft.edgemac.Canary",
  "com.brave.Browser",
  "com.brave.Browser.beta",
  "com.brave.Browser.nightly",
  "com.operasoftware.Opera",
  "com.operasoftware.OperaGX",
  "com.vivaldi.Vivaldi",
  "app.zen-browser.zen",
  "com.kagi.kagimacOS",
  "net.waterfox.waterfox",
  "org.torproject.torbrowser",
  "ai.perplexity.comet",
];

const BROWSERS = new Set(BROWSER_BUNDLE_IDS.map((b) => b.toLowerCase()));

export function isBrowser(bundleId: string): boolean {
  return BROWSERS.has(bundleId.toLowerCase());
}

/** Where a screenshot lies on the screen: enough to turn its pixels into global points and back. */
export type ScreenGeometry = Pick<HelperScreenshot, "width" | "height" | "originX" | "originY" | "pointWidth" | "pointHeight">;

/** Screenshot pixel → global point. Throws when the pixel is outside the screenshot. */
export function toPoint(g: ScreenGeometry, x: number, y: number): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= g.width || y >= g.height) {
    throw new RangeError(`(${x}, ${y}) is outside the screenshot (${g.width}x${g.height})`);
  }
  return { x: g.originX + (x * g.pointWidth) / g.width, y: g.originY + (y * g.pointHeight) / g.height };
}

/** Global point → screenshot pixel (may fall outside the screenshot). */
export function toPixel(g: ScreenGeometry, x: number, y: number): { x: number; y: number } {
  return { x: Math.round(((x - g.originX) * g.width) / g.pointWidth), y: Math.round(((y - g.originY) * g.height) / g.pointHeight) };
}

/** A pixel rectangle `[x0, y0, x1, y1]` of the screenshot → a rectangle in global points. */
export function toPointRect(g: ScreenGeometry, r: readonly number[]): { x: number; y: number; width: number; height: number } {
  if (r.length !== 4 || !r.every(Number.isFinite)) throw new RangeError("region must be [x0, y0, x1, y1]");
  const [x0, y0, x1, y1] = r as [number, number, number, number];
  if (x1 <= x0 || y1 <= y0) throw new RangeError("region must have x1 > x0 and y1 > y0");
  const cx = (v: number) => Math.min(Math.max(v, 0), g.width);
  const cy = (v: number) => Math.min(Math.max(v, 0), g.height);
  const sx = g.pointWidth / g.width;
  const sy = g.pointHeight / g.height;
  return {
    x: g.originX + cx(x0) * sx,
    y: g.originY + cy(y0) * sy,
    width: (cx(x1) - cx(x0)) * sx,
    height: (cy(y1) - cy(y0)) * sy,
  };
}
