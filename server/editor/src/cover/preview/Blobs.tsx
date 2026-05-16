import { BLOB1_PATH, BLOB2_PATH, BLOB3_PATH, COLORS } from './constants';

export function Blobs() {
  return (
    <g clipRule="evenodd" fillRule="evenodd" pointerEvents="none">
      <path d={BLOB3_PATH} fill={COLORS.blob3} />
      <path d={BLOB2_PATH} fill={COLORS.blob2} />
      <path d={BLOB1_PATH} fill={COLORS.blob1} />
    </g>
  );
}
