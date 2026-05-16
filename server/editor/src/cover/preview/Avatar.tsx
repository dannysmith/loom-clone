import { useId } from 'react';

// Avatar: circular image in the top-left, left-aligned with the title.
// Sits above the title text and overlaps the top-left blob.
const AVATAR_SIZE = 120;
const AVATAR_X = 80; // left edge matches title's x
const AVATAR_Y = 60; // top edge — above the title region (y=200)
const BORDER_WIDTH = 6;

export function Avatar() {
  const uid = useId().replace(/:/g, '');
  const clipId = `avatar-clip-${uid}`;
  const cx = AVATAR_X + AVATAR_SIZE / 2;
  const cy = AVATAR_Y + AVATAR_SIZE / 2;
  const r = AVATAR_SIZE / 2;

  return (
    <g pointerEvents="none">
      <defs>
        <clipPath id={clipId}>
          <circle cx={cx} cy={cy} r={r} />
        </clipPath>
      </defs>
      <image
        href="/static/images/avatar.jpg"
        x={AVATAR_X}
        y={AVATAR_Y}
        width={AVATAR_SIZE}
        height={AVATAR_SIZE}
        preserveAspectRatio="xMidYMid slice"
        clipPath={`url(#${clipId})`}
      />
      <circle
        cx={cx}
        cy={cy}
        r={r - BORDER_WIDTH / 2}
        fill="none"
        stroke="#ffffff"
        strokeWidth={BORDER_WIDTH}
      />
    </g>
  );
}
