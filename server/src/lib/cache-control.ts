// Cache-Control values for agent-facing text resources: llms.txt, the RSS /
// JSON feeds, the sitemap, and the per-video / per-tag `.md` and `.json`
// representations. Without an explicit header BunnyCDN applies its 30-day
// default to these, so a freshly published or edited video can stay missing
// from the index for weeks. A short max-age (under the 3600s threshold agents
// expect for index resources) keeps the edge and any agent caches current.

// `private` for non-public videos/tags so shared caches (the CDN) never store
// them; `public` otherwise. Feeds/sitemap/llms.txt are always public — call
// with no argument.
export function agentTextCacheControl(visibility?: string): string {
  const scope = !visibility || visibility === "public" ? "public" : "private";
  return `${scope}, max-age=300, stale-while-revalidate=3600`;
}
