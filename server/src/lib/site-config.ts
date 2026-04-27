// Centralised site-level metadata. Used by feeds, oEmbed, viewer meta tags,
// JSON-LD structured data, and attribution links. Edit values here —
// everything downstream reads from this object.
//
// Admin-only strings (sidebar brand "LC", title suffix " · Admin") are
// intentionally not included — they're UI concerns on a private surface.

export const siteConfig = {
  name: "Danny's Videos",
  tagline: "Screen recordings and video messages by Danny Smith.",
  authorName: "Danny Smith",
  authorUrl: "https://danny.is",
  defaultOgEmbedDimensions: { width: 1280, height: 720 },
  defaultVideoTitle: (slug: string) => `Video ${slug}`,
} as const;
