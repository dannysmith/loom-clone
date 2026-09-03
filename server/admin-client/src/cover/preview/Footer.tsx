import type { Author } from "../state";
import { FONTS } from "./constants";

type Props = {
  author: Author;
  showAttribution: boolean;
  showUrl: boolean;
  urlText: string;
  showCopyright: boolean;
};

// Footer layout:
//   When URL is off: single line of "@handle • Copyright © {year} {name}"
//   When URL is on:  URL on its own line, with "@handle • Copyright …" below it
//
// Content is top-aligned in a fixed foreignObject, so when the URL row is
// added it pushes the wordmark row down rather than the wordmark row staying
// put and the URL appearing above the canvas.
export function Footer({ author, showAttribution, showUrl, urlText, showCopyright }: Props) {
  if (!showAttribution && !showUrl && !showCopyright) return null;

  const year = new Date().getFullYear();
  const showWordmarkRow = showAttribution || showCopyright;

  return (
    <foreignObject x={70} y={720} width={1400} height={140} overflow="visible" pointerEvents="none">
      <div
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: "20px",
          fontFamily: FONTS.sans,
          lineHeight: 1,
        }}
      >
        {showUrl && (
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              whiteSpace: "nowrap",
              transform: "translateY(-6px)",
            }}
          >
            <UrlText text={urlText} />
          </div>
        )}
        {showWordmarkRow && (
          <div style={{ display: "flex", alignItems: "baseline", whiteSpace: "nowrap" }}>
            {showAttribution && <Attribution handle={author.handle} />}
            {showAttribution && showCopyright && <Bullet />}
            {showCopyright && <CopyrightText year={year} name={author.name} />}
          </div>
        )}
      </div>
    </foreignObject>
  );
}

function Attribution({ handle }: { handle: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline" }}>
      <span
        style={{
          color: "#ff7369",
          WebkitTextFillColor: "#ff7369",
          fontSize: "24px",
          fontWeight: 900,
          transform: "translateY(-4px)",
        }}
      >
        @
      </span>
      <span
        style={{
          color: "#ffffff",
          fontSize: "36px",
          fontWeight: 700,
          marginLeft: "2px",
        }}
      >
        {handle}
      </span>
    </span>
  );
}

function UrlText({ text }: { text: string }) {
  return (
    <span
      style={{
        color: "#ffd5d5",
        WebkitTextFillColor: "#ffd5d5",
        fontFamily: FONTS.mono,
        fontSize: "33px",
        fontWeight: 300,
      }}
    >
      {text}
    </span>
  );
}

function CopyrightText({ year, name }: { year: number; name: string }) {
  return (
    <span
      style={{
        color: "#ffffff",
        opacity: 0.5,
        fontSize: "24px",
        fontWeight: 200,
      }}
    >
      Copyright © {year} {name}
    </span>
  );
}

function Bullet() {
  return (
    <span
      style={{
        color: "#ffffff",
        opacity: 0.5,
        fontSize: "24px",
        fontWeight: 200,
        margin: "0 0.4em",
        transform: "translateY(-3px)",
      }}
    >
      •
    </span>
  );
}
