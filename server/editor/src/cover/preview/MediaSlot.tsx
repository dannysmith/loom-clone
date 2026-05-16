import { useEffect, useId, useState } from 'react';
import type { MediaSlot as MediaSlotType } from '../state';
import { MEDIA_BASE_WIDTH } from '../state';
import { useSvgDrag } from './useSvgDrag';

type Props = {
  slot: MediaSlotType;
  onMove: (x: number, y: number) => void;
};

// Image media slot. Renders the image either bare (preserving its natural
// aspect ratio) or inside a 16:9 white matte frame. Transform is applied
// around the slot's center so x/y mean "where the slot sits" regardless of
// scale or rotation.
//
// useId() makes clipPath/filter ids unique per instance so multiple slots
// (or remounts) can't collide.
export function MediaSlot({ slot, onMove }: Props) {
  const uid = useId().replace(/:/g, '');
  const clipId = `media-clip-${uid}`;
  const shadowId = `media-shadow-${uid}`;

  const drag = useSvgDrag({ x: slot.x, y: slot.y, onMove });

  const [naturalAspect, setNaturalAspect] = useState<number | null>(null);

  useEffect(() => {
    if (!slot.imageSrc) {
      setNaturalAspect(null);
      return;
    }
    const img = new Image();
    img.onload = () => setNaturalAspect(img.naturalWidth / img.naturalHeight);
    img.src = slot.imageSrc;
  }, [slot.imageSrc]);

  if (!slot.enabled || !slot.imageSrc) return null;

  const transform = `translate(${slot.x} ${slot.y}) rotate(${slot.rotation}) scale(${slot.scale})`;

  if (slot.framed) {
    // White matte frame around a 16:9 image. The frame's overall width is
    // MEDIA_BASE_WIDTH.framed; the image is inset by `pad` on all sides
    // while preserving 16:9, so frame height grows to accommodate it.
    const base = MEDIA_BASE_WIDTH.framed;
    const pad = 12;
    const outerRadius = 14;
    const w = base;
    const innerW = w - 2 * pad;
    const innerH = (innerW * 9) / 16;
    const h = innerH + 2 * pad;
    const innerRadius = Math.max(0, outerRadius - pad);
    return (
      <g
        transform={transform}
        {...drag.handlers}
        style={{ cursor: drag.isDragging ? 'grabbing' : 'grab', touchAction: 'none' }}
      >
        <defs>
          <clipPath id={clipId}>
            <rect
              x={-innerW / 2}
              y={-innerH / 2}
              width={innerW}
              height={innerH}
              rx={innerRadius}
            />
          </clipPath>
          <filter
            id={shadowId}
            x="-30%"
            y="-30%"
            width="160%"
            height="160%"
            colorInterpolationFilters="sRGB"
          >
            <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#000" floodOpacity="0.22" />
            <feDropShadow dx="0" dy="24" stdDeviation="40" floodColor="#000" floodOpacity="0.32" />
          </filter>
        </defs>
        <g filter={`url(#${shadowId})`}>
          <rect
            x={-w / 2}
            y={-h / 2}
            width={w}
            height={h}
            rx={outerRadius}
            fill="#ffffff"
          />
          <image
            href={slot.imageSrc}
            x={-innerW / 2}
            y={-innerH / 2}
            width={innerW}
            height={innerH}
            preserveAspectRatio="xMidYMid slice"
            clipPath={`url(#${clipId})`}
          />
          {slot.videoOverlay && (
            <VideoOverlay
              innerW={innerW}
              innerH={innerH}
              clipPathId={clipId}
            />
          )}
        </g>
      </g>
    );
  }

  // Unframed image. Wait until we know the natural aspect so we can size
  // height correctly — SVG <image> needs both width and height set.
  if (naturalAspect === null) return null;
  const base = MEDIA_BASE_WIDTH.unframed;
  const w = base;
  const h = w / naturalAspect;
  return (
    <g
      transform={transform}
      {...drag.handlers}
      style={{ cursor: drag.isDragging ? 'grabbing' : 'grab', touchAction: 'none' }}
    >
      <image
        href={slot.imageSrc}
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        preserveAspectRatio="xMidYMid meet"
      />
    </g>
  );
}

// Video-preview overlay rendered on top of a framed image: a darkening
// layer (clipped to the image's rounded rect) plus a centered play button
// (white circle with a dark right-pointing triangle).
function VideoOverlay({
  innerW,
  innerH,
  clipPathId,
}: {
  innerW: number;
  innerH: number;
  clipPathId: string;
}) {
  const buttonRadius = 56;
  // Inscribed right-pointing triangle, nudged slightly right of geometric
  // center so it looks optically balanced inside the circle.
  const tw = buttonRadius * 0.85;
  const th = buttonRadius * 1.0;
  const tx = buttonRadius * 0.18;
  const triangle = [
    `M ${-tw / 2 + tx} ${-th / 2}`,
    `L ${-tw / 2 + tx} ${th / 2}`,
    `L ${tw / 2 + tx} 0`,
    'Z',
  ].join(' ');
  return (
    <>
      <rect
        x={-innerW / 2}
        y={-innerH / 2}
        width={innerW}
        height={innerH}
        fill="rgba(0, 0, 0, 0.4)"
        clipPath={`url(#${clipPathId})`}
      />
      <circle cx={0} cy={0} r={buttonRadius} fill="rgba(255, 255, 255, 0.95)" />
      <path d={triangle} fill="#1a1a1a" />
    </>
  );
}
