import { Background } from './Background';
import { Blobs } from './Blobs';
import { Title } from './Title';
import { Footer } from './Footer';
import { MediaSlot } from './MediaSlot';
import { QrCode } from './QrCode';
import { Avatar } from './Avatar';
import { CANVAS } from './constants';
import type { CoverState } from '../state';

type Props = {
  state: CoverState;
  setState: React.Dispatch<React.SetStateAction<CoverState>>;
  svgRef: React.RefObject<SVGSVGElement | null>;
};

export function Preview({ state, setState, svgRef }: Props) {
  const onMediaMove = (x: number, y: number) =>
    setState((s) => ({ ...s, media: { ...s.media, x, y } }));
  const onQrMove = (x: number, y: number) =>
    setState((s) => ({ ...s, qr: { ...s.qr, x, y } }));

  return (
    <svg
      ref={svgRef}
      className="preview-svg"
      viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <clipPath id="canvas-clip">
          <rect x={0} y={0} width={CANVAS.width} height={CANVAS.height} />
        </clipPath>
      </defs>
      <g clipPath="url(#canvas-clip)">
        <Background />
        <Blobs />
        {state.avatar.enabled && <Avatar />}
        {state.title.enabled && (
          <Title text={state.title.text} mediaEnabled={state.media.enabled} />
        )}
        <MediaSlot slot={state.media} onMove={onMediaMove} />
        <QrCode slot={state.qr} onMove={onQrMove} />
        <Footer
          showAttribution={state.attribution.enabled}
          showUrl={state.url.enabled}
          urlText={state.url.text}
          showCopyright={state.copyright.enabled}
        />
      </g>
    </svg>
  );
}
