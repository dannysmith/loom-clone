// Image media slot — an uploaded image, optionally wrapped in a 16:9 white
// frame. Independent X/Y/scale/rotation transform.
export type MediaSlot = {
  enabled: boolean;
  imageSrc: string | null;
  framed: boolean;
  // Only meaningful when framed=true. Adds a dark overlay + play button.
  videoOverlay: boolean;
  x: number;
  y: number;
  scale: number;
  rotation: number;
};

// QR code slot — generates a QR pointing to its own URL, optionally with the
// avatar embedded in the centre. Independent X/Y/scale/rotation transform.
export type QrSlot = {
  enabled: boolean;
  url: string;
  includeAvatar: boolean;
  x: number;
  y: number;
  scale: number;
  rotation: number;
};

export type CoverState = {
  title: {
    enabled: boolean;
    text: string;
  };
  attribution: {
    enabled: boolean;
  };
  url: {
    enabled: boolean;
    text: string;
  };
  copyright: {
    enabled: boolean;
  };
  avatar: {
    enabled: boolean;
  };
  media: MediaSlot;
  qr: QrSlot;
};

// Inputs sourced from the video record (passed in by main-cover.tsx via
// data-* attributes on #cover-root). These drive the initial state and the
// per-field Reset buttons.
export type VideoInputs = {
  videoId: string;
  slug: string;
  title: string;
  publicUrl: string;
  currentThumbnailUrl: string;
};

// Placeholder shown when the video has no title set in the DB.
export const TITLE_PLACEHOLDER = 'Untitled video';

// Base widths for each kind at scale=1.0 (in viewBox px).
export const MEDIA_BASE_WIDTH = {
  unframed: 500,
  framed: 640,
};

export const QR_BASE_SIZE = 220;

// Defaults applied when a slot is reset.
export const MEDIA_DEFAULTS: Omit<MediaSlot, 'enabled' | 'imageSrc' | 'framed' | 'videoOverlay'> = {
  x: 1280,
  y: 435,
  scale: 1.0,
  rotation: 0,
};

export const QR_DEFAULTS: Omit<QrSlot, 'enabled' | 'url' | 'includeAvatar'> = {
  x: 1380,
  y: 620,
  scale: 1.0,
  rotation: 0,
};

// Content defaults derived from the video record — what the Reset buttons
// should restore. Title falls back to the placeholder for untitled videos.
export function titleDefaultFor(inputs: VideoInputs): string {
  return inputs.title.trim() || TITLE_PLACEHOLDER;
}

export function urlDefaultFor(inputs: VideoInputs): string {
  return inputs.publicUrl;
}

export function qrDefaultsFor(inputs: VideoInputs): Pick<QrSlot, 'url' | 'includeAvatar'> {
  return {
    url: inputs.publicUrl,
    includeAvatar: true,
  };
}

export function buildInitialState(inputs: VideoInputs): CoverState {
  return {
    title: {
      enabled: true,
      text: titleDefaultFor(inputs),
    },
    attribution: {
      enabled: true,
    },
    url: {
      enabled: false,
      text: urlDefaultFor(inputs),
    },
    copyright: {
      enabled: true,
    },
    avatar: {
      enabled: true,
    },
    media: {
      enabled: true,
      imageSrc: inputs.currentThumbnailUrl,
      framed: true,
      videoOverlay: false,
      ...MEDIA_DEFAULTS,
    },
    qr: {
      enabled: false,
      ...qrDefaultsFor(inputs),
      ...QR_DEFAULTS,
    },
  };
}
