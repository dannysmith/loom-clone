import { useEffect, useRef, useState } from 'react';
import { addToThumbnails } from './api';
import {
  dataUrlToBlob,
  downloadDataUrl,
  exportJpeg,
  exportPng,
  exportSvg,
} from './export';
import {
  MEDIA_DEFAULTS,
  QR_DEFAULTS,
  qrDefaultsFor,
  titleDefaultFor,
  urlDefaultFor,
  type CoverState,
  type VideoInputs,
} from './state';

type Props = {
  inputs: VideoInputs;
  state: CoverState;
  setState: React.Dispatch<React.SetStateAction<CoverState>>;
  svgRef: React.RefObject<SVGSVGElement | null>;
};

export function Editor({ inputs, state, setState, svgRef }: Props) {
  // Export panel — local UI state.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [working, setWorking] = useState<null | 'preview' | 'png' | 'jpeg' | 'svg' | 'upload'>(
    null,
  );
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  const showToast = (kind: 'success' | 'error', message: string) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToast({ kind, message });
    toastTimeoutRef.current = setTimeout(() => setToast(null), 3500);
  };

  const withSvg = async <T,>(fn: (svg: SVGSVGElement) => Promise<T>): Promise<T | null> => {
    const svg = svgRef.current;
    if (!svg) return null;
    return fn(svg);
  };

  const refreshPreview = async () => {
    setWorking('preview');
    try {
      const url = await withSvg(exportPng);
      if (url) setPreviewUrl(url);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setWorking(null);
    }
  };

  const downloadAs = async (kind: 'png' | 'jpeg' | 'svg') => {
    setWorking(kind);
    try {
      const url = await withSvg(kind === 'png' ? exportPng : kind === 'jpeg' ? exportJpeg : exportSvg);
      if (!url) return;
      const ext = kind === 'jpeg' ? 'jpg' : kind;
      downloadDataUrl(url, `cover.${ext}`);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : `${kind.toUpperCase()} export failed`);
    } finally {
      setWorking(null);
    }
  };

  const addToThumbnailsClick = async () => {
    setWorking('upload');
    try {
      const url = await withSvg(exportJpeg);
      if (!url) return;
      const blob = await dataUrlToBlob(url);
      await addToThumbnails(inputs.videoId, blob);
      showToast('success', 'Added to thumbnails ✓');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setWorking(null);
    }
  };

  const onMediaFile = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : null;
      if (!dataUrl) return;
      setState((s) => ({ ...s, media: { ...s.media, imageSrc: dataUrl } }));
    };
    reader.readAsDataURL(file);
  };

  const resetMediaTransform = () => {
    setState((s) => ({ ...s, media: { ...s.media, ...MEDIA_DEFAULTS } }));
  };

  const resetQrTransform = () => {
    setState((s) => ({ ...s, qr: { ...s.qr, ...QR_DEFAULTS } }));
  };

  return (
    <aside className="editor">
      <h1>Components</h1>

      <div className="field">
        <div className="field-header">
          <span className="field-label">Avatar</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={state.avatar.enabled}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  avatar: { ...s.avatar, enabled: e.target.checked },
                }))
              }
            />
            <span className="slider" />
          </label>
        </div>
      </div>

      <div className="field">
        <div className="field-header">
          <label className="field-label" htmlFor="title-text">
            Title
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={state.title.enabled}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  title: { ...s.title, enabled: e.target.checked },
                }))
              }
            />
            <span className="slider" />
          </label>
        </div>
        {state.title.enabled && (
          <>
            <textarea
              id="title-text"
              rows={2}
              value={state.title.text}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  title: { ...s.title, text: e.target.value },
                }))
              }
            />
            <button
              type="button"
              className="ghost"
              onClick={() =>
                setState((s) => ({
                  ...s,
                  title: { ...s.title, text: titleDefaultFor(inputs) },
                }))
              }
            >
              Reset
            </button>
          </>
        )}
      </div>

      <div className="field">
        <div className="field-header">
          <label className="field-label" htmlFor="url-text">
            URL
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={state.url.enabled}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  url: { ...s.url, enabled: e.target.checked },
                }))
              }
            />
            <span className="slider" />
          </label>
        </div>
        {state.url.enabled && (
          <>
            <input
              id="url-text"
              type="text"
              value={state.url.text}
              onChange={(e) =>
                setState((s) => ({ ...s, url: { ...s.url, text: e.target.value } }))
              }
            />
            <button
              type="button"
              className="ghost"
              onClick={() =>
                setState((s) => ({
                  ...s,
                  url: { ...s.url, text: urlDefaultFor(inputs) },
                }))
              }
            >
              Reset
            </button>
          </>
        )}
      </div>

      <div className="field">
        <div className="field-header">
          <span className="field-label">@dannysmith</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={state.attribution.enabled}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  attribution: { ...s.attribution, enabled: e.target.checked },
                }))
              }
            />
            <span className="slider" />
          </label>
        </div>
      </div>

      <div className="field">
        <div className="field-header">
          <span className="field-label">Copyright</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={state.copyright.enabled}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  copyright: { ...s.copyright, enabled: e.target.checked },
                }))
              }
            />
            <span className="slider" />
          </label>
        </div>
      </div>

      <div className="field">
        <div className="field-header">
          <span className="field-label">Media (image)</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={state.media.enabled}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  media: { ...s.media, enabled: e.target.checked },
                }))
              }
            />
            <span className="slider" />
          </label>
        </div>

        {state.media.enabled && (
          <>
            <div className="check-row">
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={state.media.framed}
                  onChange={(e) =>
                    setState((s) => ({ ...s, media: { ...s.media, framed: e.target.checked } }))
                  }
                />
                <span>Frame</span>
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  disabled={!state.media.framed}
                  checked={state.media.videoOverlay}
                  onChange={(e) =>
                    setState((s) => ({
                      ...s,
                      media: { ...s.media, videoOverlay: e.target.checked },
                    }))
                  }
                />
                <span>Video overlay</span>
              </label>
            </div>

            <label className="file-input">
              <span>Upload image</span>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => onMediaFile(e.target.files?.[0] ?? null)}
              />
            </label>

            <Slider
              label="X"
              min={-200}
              max={1745}
              step={1}
              value={state.media.x}
              onChange={(v) => setState((s) => ({ ...s, media: { ...s.media, x: v } }))}
            />
            <Slider
              label="Y"
              min={-200}
              max={1069}
              step={1}
              value={state.media.y}
              onChange={(v) => setState((s) => ({ ...s, media: { ...s.media, y: v } }))}
            />
            <Slider
              label="Scale"
              min={0.2}
              max={2.5}
              step={0.01}
              value={state.media.scale}
              onChange={(v) => setState((s) => ({ ...s, media: { ...s.media, scale: v } }))}
            />
            <Slider
              label="Rotation"
              min={-45}
              max={45}
              step={0.5}
              value={state.media.rotation}
              onChange={(v) => setState((s) => ({ ...s, media: { ...s.media, rotation: v } }))}
              suffix="°"
            />

            <button type="button" className="ghost" onClick={resetMediaTransform}>
              Reset transform
            </button>
          </>
        )}
      </div>

      <div className="field">
        <div className="field-header">
          <span className="field-label">QR code</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={state.qr.enabled}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  qr: { ...s.qr, enabled: e.target.checked },
                }))
              }
            />
            <span className="slider" />
          </label>
        </div>

        {state.qr.enabled && (
          <>
            <input
              type="text"
              placeholder="https://…"
              value={state.qr.url}
              onChange={(e) =>
                setState((s) => ({ ...s, qr: { ...s.qr, url: e.target.value } }))
              }
            />

            <label className="inline-check">
              <input
                type="checkbox"
                checked={state.qr.includeAvatar}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    qr: { ...s.qr, includeAvatar: e.target.checked },
                  }))
                }
              />
              <span>Avatar in centre</span>
            </label>

            <Slider
              label="X"
              min={-200}
              max={1745}
              step={1}
              value={state.qr.x}
              onChange={(v) => setState((s) => ({ ...s, qr: { ...s.qr, x: v } }))}
            />
            <Slider
              label="Y"
              min={-200}
              max={1069}
              step={1}
              value={state.qr.y}
              onChange={(v) => setState((s) => ({ ...s, qr: { ...s.qr, y: v } }))}
            />
            <Slider
              label="Scale"
              min={0.2}
              max={3.0}
              step={0.01}
              value={state.qr.scale}
              onChange={(v) => setState((s) => ({ ...s, qr: { ...s.qr, scale: v } }))}
            />
            <Slider
              label="Rotation"
              min={-45}
              max={45}
              step={0.5}
              value={state.qr.rotation}
              onChange={(v) => setState((s) => ({ ...s, qr: { ...s.qr, rotation: v } }))}
              suffix="°"
            />

            <div className="check-row">
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  setState((s) => ({ ...s, qr: { ...s.qr, ...qrDefaultsFor(inputs) } }))
                }
              >
                Reset
              </button>
              <button type="button" className="ghost" onClick={resetQrTransform}>
                Reset transform
              </button>
            </div>
          </>
        )}
      </div>

      <div className="field">
        <div className="field-header">
          <span className="field-label">Export</span>
        </div>
        <button
          type="button"
          className="ghost"
          onClick={refreshPreview}
          disabled={working === 'preview'}
        >
          {working === 'preview' ? 'Generating…' : previewUrl ? 'Refresh preview' : 'Generate preview'}
        </button>
        {previewUrl && (
          <div className="export-preview" title="Drag to your desktop to save">
            <img src={previewUrl} alt="Export preview" draggable />
          </div>
        )}
        <div className="check-row">
          <button
            type="button"
            className="ghost"
            onClick={() => downloadAs('png')}
            disabled={working === 'png'}
          >
            {working === 'png' ? '…' : 'PNG'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => downloadAs('jpeg')}
            disabled={working === 'jpeg'}
          >
            {working === 'jpeg' ? '…' : 'JPEG'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => downloadAs('svg')}
            disabled={working === 'svg'}
          >
            {working === 'svg' ? '…' : 'SVG'}
          </button>
        </div>
        <button
          type="button"
          className="ghost"
          onClick={addToThumbnailsClick}
          disabled={working === 'upload'}
        >
          {working === 'upload' ? 'Adding…' : 'Add to thumbnails'}
        </button>
        {toast && (
          <span className={`toast toast--${toast.kind}`} role="status">
            {toast.message}
          </span>
        )}
      </div>
    </aside>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  suffix,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div className="slider-row">
      <span className="slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="slider-value">
        {Number.isInteger(step) ? Math.round(value) : value.toFixed(2)}
        {suffix ?? ''}
      </span>
    </div>
  );
}
