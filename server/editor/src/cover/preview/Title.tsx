import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type Props = {
  text: string;
  mediaEnabled: boolean;
};

const MAX_FONT_SIZE = 128;
const MIN_FONT_SIZE = 24;
// Ratios from the original spec (line-height 140/128, letter-spacing
// -0.08rem at 128px → -0.01 × font-size).
const LINE_HEIGHT_RATIO = 140 / 128;
const LETTER_SPACING_RATIO = -0.01;
const HEIGHT = 460;

// Title region. Widens when the media slot is disabled. Font size scales
// down (binary search) so the text always fits within the available box.
export function Title({ text, mediaEnabled }: Props) {
  const width = mediaEnabled ? 920 : 1385;

  const ref = useRef<HTMLDivElement>(null);
  const [fontSize, setFontSize] = useState(MAX_FONT_SIZE);
  // Re-fit once webfonts load — measurements taken against fallback fonts
  // would otherwise be wrong on first render.
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) {
      setFontsReady(true);
      return;
    }
    document.fonts.ready.then(() => setFontsReady(true));
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const apply = (size: number) => {
      el.style.fontSize = `${size}px`;
      el.style.lineHeight = `${size * LINE_HEIGHT_RATIO}px`;
      el.style.letterSpacing = `${size * LETTER_SPACING_RATIO}px`;
    };
    const fits = () => el.scrollHeight <= HEIGHT && el.scrollWidth <= width;

    apply(MAX_FONT_SIZE);
    if (fits()) {
      setFontSize(MAX_FONT_SIZE);
      return;
    }

    let lo = MIN_FONT_SIZE;
    let hi = MAX_FONT_SIZE;
    let best = MIN_FONT_SIZE;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      apply(mid);
      if (fits()) {
        best = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    setFontSize(best);
  }, [text, width, fontsReady]);

  return (
    <foreignObject
      x={80}
      y={200}
      width={width}
      height={HEIGHT}
      overflow="visible"
      pointerEvents="none"
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <div
          ref={ref}
          style={{
            width: '100%',
            color: '#ffffff',
            fontFamily: 'Inter, sans-serif',
            fontSize: `${fontSize}px`,
            fontWeight: 800,
            lineHeight: `${fontSize * LINE_HEIGHT_RATIO}px`,
            letterSpacing: `${fontSize * LETTER_SPACING_RATIO}px`,
            textTransform: 'uppercase',
            wordBreak: 'break-word',
            whiteSpace: 'pre-line',
          }}
        >
          {text}
        </div>
      </div>
    </foreignObject>
  );
}
