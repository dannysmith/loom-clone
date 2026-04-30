// Lucide icons (https://lucide.dev) — ISC license.
// Inlined as JSX SVG for zero-dependency server rendering.
// Visibility helper at the bottom maps visibility strings to icons.

type IconProps = {
  size?: number;
  class?: string;
  style?: string;
};

function Svg({ size = 18, class: className, style, children }: IconProps & { children: unknown }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={className}
      style={style}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconDashboard(props: IconProps) {
  return (
    <Svg {...props}>
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </Svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Svg>
  );
}

export function IconGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </Svg>
  );
}

export function IconList(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 5h.01" />
      <path d="M3 12h.01" />
      <path d="M3 19h.01" />
      <path d="M8 5h13" />
      <path d="M8 12h13" />
      <path d="M8 19h13" />
    </Svg>
  );
}

export function IconUpload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3v12" />
      <path d="m17 8-5-5-5 5" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </Svg>
  );
}

export function IconExternalLink(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Svg>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 15V3" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
    </Svg>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Svg>
  );
}

export function IconDuplicate(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="15" x2="15" y1="12" y2="18" />
      <line x1="12" x2="18" y1="15" y2="15" />
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Svg>
  );
}

export function IconGlobe(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </Svg>
  );
}

export function IconLink(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Svg>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </Svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </Svg>
  );
}

export function IconEllipsis(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </Svg>
  );
}

export function IconEye(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function IconShuffle(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22" />
      <path d="m18 2 4 4-4 4" />
      <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
      <path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" />
      <path d="m18 14 4 4-4 4" />
    </Svg>
  );
}

export function IconWand(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 4V2" />
      <path d="M15 16v-2" />
      <path d="M8 9h2" />
      <path d="M20 9h2" />
      <path d="M17.8 11.8 19 13" />
      <path d="M15 9h.01" />
      <path d="M17.8 6.2 19 5" />
      <path d="m3 21 9-9" />
      <path d="M12.2 6.2 11 5" />
    </Svg>
  );
}

// --- Helpers ---

// --- File type icons ---
// All share the same dog-eared file outline with distinct internal details.

function FileBase({ children }: { children?: unknown }) {
  return (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      {children}
    </>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Svg>
  );
}

export function IconFile(props: IconProps) {
  return (
    <Svg {...props}>
      <FileBase />
    </Svg>
  );
}

export function IconFileVideo(props: IconProps) {
  return (
    <Svg {...props}>
      <FileBase>
        <path d="m10 11 5 3-5 3v-6Z" />
      </FileBase>
    </Svg>
  );
}

export function IconFileText(props: IconProps) {
  return (
    <Svg {...props}>
      <FileBase>
        <path d="M9 13h6" />
        <path d="M9 17h4" />
      </FileBase>
    </Svg>
  );
}

export function IconFileCode(props: IconProps) {
  return (
    <Svg {...props}>
      <FileBase>
        <path d="m10 14-2 1 2 1" />
        <path d="m14 14 2 1-2 1" />
      </FileBase>
    </Svg>
  );
}

export function IconFileImage(props: IconProps) {
  return (
    <Svg {...props}>
      <FileBase>
        <circle cx="10" cy="13" r="1.5" />
        <path d="m18 18-2.5-3-2 2-3-4L7 18" />
      </FileBase>
    </Svg>
  );
}

export function IconFileAudio(props: IconProps) {
  return (
    <Svg {...props}>
      <FileBase>
        <circle cx="11" cy="17" r="2" />
        <path d="M13 17V11l4-2" />
      </FileBase>
    </Svg>
  );
}

export function IconFileSegment(props: IconProps) {
  return (
    <Svg {...props}>
      <FileBase>
        <rect x="8" y="11" width="3" height="3" rx="0.5" />
        <rect x="13" y="11" width="3" height="3" rx="0.5" />
        <rect x="8" y="16" width="3" height="3" rx="0.5" />
        <rect x="13" y="16" width="3" height="3" rx="0.5" />
      </FileBase>
    </Svg>
  );
}

export function IconFileCog(props: IconProps) {
  return (
    <Svg {...props}>
      <FileBase>
        <circle cx="12" cy="15" r="2" />
        <path d="M12 11v2" />
        <path d="M12 17v2" />
        <path d="m9.17 13-1.73-1" />
        <path d="m14.56 16 1.73 1" />
        <path d="m9.17 17-1.73 1" />
        <path d="m14.56 14 1.73-1" />
      </FileBase>
    </Svg>
  );
}

export function IconCalendar(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
    </Svg>
  );
}

export function IconCamera(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </Svg>
  );
}

export function IconMic(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </Svg>
  );
}

export function IconRuler(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z" />
      <path d="m14.5 12.5 2-2" />
      <path d="m11.5 9.5 2-2" />
      <path d="m8.5 6.5 2-2" />
      <path d="m17.5 15.5 2-2" />
    </Svg>
  );
}

export function IconHardDrive(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="22" x2="2" y1="12" y2="12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      <line x1="6" x2="6.01" y1="16" y2="16" />
      <line x1="10" x2="10.01" y1="16" y2="16" />
    </Svg>
  );
}

export function IconAlertTriangle(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Svg>
  );
}

export function IconUploadCloud(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M12 12v9" />
      <path d="m16 16-4-4-4 4" />
    </Svg>
  );
}

export function IconCode(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </Svg>
  );
}

export function IconScissors(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" />
      <line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </Svg>
  );
}

// Map filenames/extensions to icon + color
export function FileTypeIcon({ path, isDirectory }: { path: string; isDirectory: boolean }) {
  if (isDirectory) return <IconFolder size={16} style="color: var(--tag-blue)" />;

  const name = path.split("/").pop() ?? path;
  const ext = name.substring(name.lastIndexOf(".")).toLowerCase();

  // Specific filenames first
  if (name === "recording.json") return <IconFileCog size={16} style="color: var(--tag-orange)" />;
  if (name === "init.mp4")
    return <IconFileSegment size={16} style="color: var(--color-fg-muted)" />;

  // By extension
  switch (ext) {
    case ".mp4":
    case ".mov":
      return <IconFileVideo size={16} style="color: var(--tag-indigo)" />;
    case ".m4s":
      return <IconFileSegment size={16} style="color: var(--tag-purple)" />;
    case ".m3u8":
      return <IconFileText size={16} style="color: var(--tag-green)" />;
    case ".json":
      return <IconFileCode size={16} style="color: var(--tag-yellow)" />;
    case ".jpg":
    case ".jpeg":
    case ".png":
    case ".webp":
      return <IconFileImage size={16} style="color: var(--tag-teal)" />;
    case ".mp3":
    case ".aac":
    case ".wav":
      return <IconFileAudio size={16} style="color: var(--tag-pink)" />;
    case ".txt":
    case ".md":
    case ".log":
      return <IconFileText size={16} style="color: var(--color-fg-muted)" />;
    default:
      return <IconFile size={16} style="color: var(--color-fg-muted)" />;
  }
}

function visibilityIcon(visibility: string, size: number) {
  switch (visibility) {
    case "public":
      return <IconGlobe size={size} />;
    case "unlisted":
      return <IconLink size={size} />;
    case "private":
      return <IconEyeOff size={size} />;
    default:
      return null;
  }
}

export function VisibilityBadge({
  visibility,
  iconSize = 12,
}: {
  visibility: string;
  iconSize?: number;
}) {
  return (
    <span class={`badge badge--${visibility}`}>
      {visibilityIcon(visibility, iconSize)}
      {visibility}
    </span>
  );
}
