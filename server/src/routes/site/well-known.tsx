import { Hono } from "hono";
import { RootLayout } from "../../views/layouts/RootLayout";

// Root + well-known files. Open, no auth.
//
// `/` is a deliberately tiny landing page — the admin panel is auth-gated
// and we don't want to expose its existence at the root. `favicon.ico` is
// a 204 placeholder until real brand work; browsers handle that fine and
// stop re-requesting. `sitemap.xml` is an empty-but-valid stub; Phase 7
// populates it from the DB.
const wellKnown = new Hono();

wellKnown.get("/", (c) =>
  c.html(
    <RootLayout title="loom-clone">
      <main style="padding: 2rem; font-family: system-ui;">
        <h1>loom-clone</h1>
        <p>Personal video host.</p>
      </main>
    </RootLayout>,
  ),
);

wellKnown.get("/robots.txt", (c) =>
  c.text("User-agent: *\nDisallow: /admin\nDisallow: /api\n", 200, {
    "content-type": "text/plain; charset=utf-8",
  }),
);

// 204 No Content is a valid response. Browsers cache it and stop asking,
// without us having to ship a binary placeholder.
wellKnown.get("/favicon.ico", (c) => c.body(null, 204));

wellKnown.get("/sitemap.xml", (c) =>
  c.body(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n`,
    200,
    { "content-type": "application/xml; charset=utf-8" },
  ),
);

export default wellKnown;
