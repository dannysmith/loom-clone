// Centralised site-level metadata. Used by feeds, oEmbed, viewer meta tags,
// JSON-LD structured data, and attribution links. Edit values here —
// everything downstream reads from this object.
//
// Admin-only strings (sidebar brand "LC", title suffix " · Admin") are
// intentionally not included — they're UI concerns on a private surface.

// Social profiles surfaced in viewer footers, feed metadata, etc.
// Order here is the order they render. Use null to hide a row entirely.
// Replace the placeholders below with real URLs — values are linked from
// every public viewer page.
export const socials = [
  { id: "website", label: "danny.is", url: "https://danny.is" },
  { id: "bluesky", label: "Bluesky", url: "https://bsky.app/profile/danny.is" },
  { id: "linkedin", label: "LinkedIn", url: "https://www.linkedin.com/in/dannysmith" },
  { id: "github", label: "GitHub", url: "https://github.com/dannysmith" },
  { id: "youtube", label: "YouTube", url: "https://www.youtube.com/@dannysmith" },
] as const;

export type SocialId = (typeof socials)[number]["id"];

export const siteConfig = {
  name: "Danny's Videos",
  tagline: "Screen recordings and video messages by Danny Smith.",
  authorName: "Danny Smith",
  authorUrl: "https://danny.is",
  authorAvatar: "/static/images/avatar.jpg",
  defaultOgEmbedDimensions: { width: 1280, height: 720 },
  defaultVideoTitle: (slug: string) => `Video ${slug}`,
  socials,
} as const;
