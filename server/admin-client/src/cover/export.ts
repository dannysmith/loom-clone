import firaCodeWoff2 from "@fontsource-variable/fira-code/files/fira-code-latin-wght-normal.woff2?url";
import interWoff2 from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import { toJpeg, toPng } from "html-to-image";
import { CANVAS } from "./preview/constants";

// html-to-image's types are written for HTMLElement but at runtime the
// implementation handles SVGSVGElement fine. Cast at the boundary.
type Rasterizable = Parameters<typeof toPng>[0];

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const PIXEL_RATIO = 2;

// The fonts the canvas renders in, for embedding into an exported SVG. Family
// names and weight ranges match what @fontsource declares for the variable
// builds imported in main.tsx; the latin subset covers the Latin-1 range,
// which is what covers are titled in.
const EMBEDDED_FONTS = [
  { family: "Inter Variable", weight: "100 900", url: interWoff2 },
  { family: "Fira Code Variable", weight: "300 700", url: firaCodeWoff2 },
];

// PNG — html-to-image rasterizes via canvas. Returns a data URL.
export async function exportPng(svg: SVGSVGElement): Promise<string> {
  return toPng(svg as unknown as Rasterizable, {
    width: CANVAS.width,
    height: CANVAS.height,
    pixelRatio: PIXEL_RATIO,
    cacheBust: true,
  });
}

// JPEG — same pipeline; pick a background colour because JPEG can't be
// transparent. We use the cover's own dark background so the JPEG matches.
export async function exportJpeg(svg: SVGSVGElement): Promise<string> {
  return toJpeg(svg as unknown as Rasterizable, {
    width: CANVAS.width,
    height: CANVAS.height,
    pixelRatio: PIXEL_RATIO,
    quality: 0.95,
    backgroundColor: "#2f3437",
    cacheBust: true,
  });
}

// SVG — clone the live element, inline+dedupe images, embed fonts so the
// file is fully self-contained when opened standalone.
export async function exportSvg(svg: SVGSVGElement): Promise<string> {
  const cloned = svg.cloneNode(true) as SVGSVGElement;
  cloned.setAttribute("xmlns", SVG_NS);
  cloned.setAttribute("xmlns:xlink", XLINK_NS);
  cloned.setAttribute("width", String(CANVAS.width));
  cloned.setAttribute("height", String(CANVAS.height));
  stripEditorAttributes(cloned);

  await inlineImagesWithDedup(cloned);

  // Embed fonts as a <style> at the top of the SVG.
  const fontsCss = await buildEmbeddedFontsCss();
  const styleEl = document.createElementNS(SVG_NS, "style");
  styleEl.setAttribute("type", "text/css");
  styleEl.textContent = fontsCss;
  cloned.insertBefore(styleEl, cloned.firstChild);

  const serialized = new XMLSerializer().serializeToString(cloned);
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${serialized}`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
}

// Strip attributes that exist only to support editing/interaction — they
// don't belong in the exported artifact.
//   - class="preview-svg" on the root
//   - cursor / touch-action inline styles (set on draggable groups)
//   - pointer-events="none" (set on non-draggable layers to let drags
//     through; meaningless once the SVG is static)
function stripEditorAttributes(root: SVGSVGElement) {
  root.removeAttribute("class");

  const all: Element[] = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const el of all) {
    if (el.getAttribute("pointer-events") === "none") {
      el.removeAttribute("pointer-events");
    }
    const style = el.getAttribute("style");
    if (!style) continue;
    const filtered = style
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^(cursor|touch-action)\s*:/i.test(s));
    if (filtered.length === 0) {
      el.removeAttribute("style");
    } else {
      el.setAttribute("style", filtered.join("; "));
    }
  }
}

// Inline every external <image href> as a data URL. Each unique URL is
// fetched only once (so we don't pay the network cost for shared images),
// but each occurrence gets its own inline data URL — no <use>/<symbol>
// indirection. The previous dedup attempt rendered incorrectly across
// several viewers when the same symbol was instantiated at different
// sizes; inlining directly is universally reliable.
async function inlineImagesWithDedup(svg: SVGSVGElement) {
  const images = Array.from(svg.querySelectorAll("image")) as SVGImageElement[];

  // Fetch unique external URLs once.
  const dataUrls = new Map<string, string>();
  for (const img of images) {
    const href = img.getAttribute("href") || img.getAttributeNS(XLINK_NS, "href") || "";
    if (!href || href.startsWith("data:")) continue;
    if (!dataUrls.has(href)) dataUrls.set(href, "");
  }
  await Promise.all(
    [...dataUrls.keys()].map(async (href) => {
      try {
        dataUrls.set(href, await fetchAsDataUrl(href));
      } catch (err) {
        console.warn("Failed to inline image during SVG export:", href, err);
      }
    }),
  );

  // Substitute the data URL into each <image> element.
  for (const img of images) {
    const href = img.getAttribute("href") || img.getAttributeNS(XLINK_NS, "href") || "";
    if (!href || href.startsWith("data:")) continue;
    const dataUrl = dataUrls.get(href);
    if (dataUrl) {
      img.setAttribute("href", dataUrl);
      // Strip any legacy xlink:href so the file doesn't carry two hrefs.
      img.removeAttributeNS(XLINK_NS, "href");
    }
  }
}

// Base64-inline the webfonts as @font-face rules so an exported SVG renders
// correctly when opened standalone, with no network at all. A font that fails
// to fetch is skipped rather than failing the export — the SVG still opens,
// just in fallback fonts.
async function buildEmbeddedFontsCss(): Promise<string> {
  const faces = await Promise.all(
    EMBEDDED_FONTS.map(async ({ family, weight, url }) => {
      try {
        const data = await fetchAsDataUrl(url);
        return `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weight}; src: url(${data}) format("woff2-variations"); }`;
      } catch (err) {
        console.warn("Failed to embed font during SVG export:", url, err);
        return "";
      }
    }),
  );
  return faces.filter(Boolean).join("\n");
}

async function fetchAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Trigger a browser download for a data URL.
export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// Convert a data URL back into a Blob — useful for uploading.
export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}
