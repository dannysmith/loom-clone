import { CANVAS, COLORS } from './constants';

export function Background() {
  return (
    <rect
      x={0}
      y={0}
      width={CANVAS.width}
      height={CANVAS.height}
      fill={COLORS.background}
      pointerEvents="none"
    />
  );
}
