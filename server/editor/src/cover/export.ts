import { toPng, toJpeg } from 'html-to-image';
import { CANVAS } from './preview/constants';

// html-to-image's types are written for HTMLElement but at runtime the
// implementation handles SVGSVGElement fine. Cast at the boundary.
type Rasterizable = Parameters<typeof toPng>[0];

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const PIXEL_RATIO = 2;

const GOOGLE_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Fira+Code:wght@300;400&family=Inter:wght@200;300;700;800;900&display=swap';

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
    backgroundColor: '#2f3437',
    cacheBust: true,
  });
}

// SVG — clone the live element, inline+dedupe images, embed fonts so the
// file is fully self-contained when opened standalone.
export async function exportSvg(svg: SVGSVGElement): Promise<string> {
  const cloned = svg.cloneNode(true) as SVGSVGElement;
  cloned.setAttribute('xmlns', SVG_NS);
  cloned.setAttribute('xmlns:xlink', XLINK_NS);
  cloned.setAttribute('width', String(CANVAS.width));
  cloned.setAttribute('height', String(CANVAS.height));
  stripEditorAttributes(cloned);

  await inlineImagesWithDedup(cloned);

  // Embed fonts as a <style> at the top of the SVG.
  const fontsCss = await buildEmbeddedFontsCss();
  const styleEl = document.createElementNS(SVG_NS, 'style');
  styleEl.setAttribute('type', 'text/css');
  styleEl.textContent = fontsCss;
  cloned.insertBefore(styleEl, cloned.firstChild);

  const serialized = new XMLSerializer().serializeToString(cloned);
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' + serialized;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
}

// Strip attributes that exist only to support editing/interaction — they
// don't belong in the exported artifact.
//   - class="preview-svg" on the root
//   - cursor / touch-action inline styles (set on draggable groups)
//   - pointer-events="none" (set on non-draggable layers to let drags
//     through; meaningless once the SVG is static)
function stripEditorAttributes(root: SVGSVGElement) {
  root.removeAttribute('class');

  const all: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of all) {
    if (el.getAttribute('pointer-events') === 'none') {
      el.removeAttribute('pointer-events');
    }
    const style = el.getAttribute('style');
    if (!style) continue;
    const filtered = style
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^(cursor|touch-action)\s*:/i.test(s));
    if (filtered.length === 0) {
      el.removeAttribute('style');
    } else {
      el.setAttribute('style', filtered.join('; '));
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
  const images = Array.from(svg.querySelectorAll('image')) as SVGImageElement[];

  // Fetch unique external URLs once.
  const dataUrls = new Map<string, string>();
  for (const img of images) {
    const href =
      img.getAttribute('href') || img.getAttributeNS(XLINK_NS, 'href') || '';
    if (!href || href.startsWith('data:')) continue;
    if (!dataUrls.has(href)) dataUrls.set(href, '');
  }
  await Promise.all(
    [...dataUrls.keys()].map(async (href) => {
      try {
        dataUrls.set(href, await fetchAsDataUrl(href));
      } catch (err) {
        console.warn('Failed to inline image during SVG export:', href, err);
      }
    })
  );

  // Substitute the data URL into each <image> element.
  for (const img of images) {
    const href =
      img.getAttribute('href') || img.getAttributeNS(XLINK_NS, 'href') || '';
    if (!href || href.startsWith('data:')) continue;
    const dataUrl = dataUrls.get(href);
    if (dataUrl) {
      img.setAttribute('href', dataUrl);
      // Strip any legacy xlink:href so the file doesn't carry two hrefs.
      img.removeAttributeNS(XLINK_NS, 'href');
    }
  }
}

// Fetch Google Fonts CSS, keep only the latin @font-face blocks (covers
// basic English + common punctuation), then base64-encode each WOFF2 and
// inline it into the CSS. Returns a self-contained CSS string ready to drop
// into a <style> element. Falls back to a remote @import if anything fails
// so the SVG still renders (with network).
async function buildEmbeddedFontsCss(): Promise<string> {
  const fallback = `@import url('${GOOGLE_FONTS_HREF}');`;

  let css: string;
  try {
    const res = await fetch(GOOGLE_FONTS_HREF);
    if (!res.ok) return fallback;
    css = await res.text();
  } catch {
    return fallback;
  }

  // Pull out the individual @font-face blocks. unicode-range is what tells
  // us which subset each block represents; we only want latin.
  const blocks = css.match(/@font-face\s*\{[^}]+\}/g) ?? [];
  const latin = blocks.filter((block) => {
    const range = /unicode-range\s*:\s*([^;]+);/i.exec(block)?.[1] ?? '';
    // The "latin" subset starts at U+0000. Blocks without a unicode-range
    // (rare here) are kept too since they cover everything.
    return range === '' || /U\+0000/.test(range);
  });

  if (latin.length === 0) return fallback;

  // Fetch each unique WOFF2 url once and base64-encode it.
  const urls = new Set<string>();
  for (const block of latin) {
    for (const m of block.matchAll(/url\((https?:[^)]+\.woff2[^)]*)\)/g)) {
      if (m[1]) urls.add(m[1]);
    }
  }
  const urlToData = new Map<string, string>();
  await Promise.all(
    [...urls].map(async (url) => {
      try {
        urlToData.set(url, await fetchAsDataUrl(url));
      } catch (err) {
        console.warn('Failed to embed font url:', url, err);
      }
    })
  );

  // If we couldn't fetch any, fall back rather than ship a broken CSS.
  if (urlToData.size === 0) return fallback;

  // Substitute every url(...) reference with its data URL.
  const embedded = latin.map((block) => {
    let out = block;
    for (const [url, data] of urlToData) {
      out = out.split(url).join(data);
    }
    return out;
  });

  return embedded.join('\n');
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
  const a = document.createElement('a');
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
