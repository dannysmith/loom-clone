import { Hono } from "hono";
import { CoverPage } from "../../views/admin/pages/CoverPage";
import { type AdminEnv, requireVideo } from "./helpers";

const cover = new Hono<AdminEnv>();

// --- Cover image generator page (serves the React shell) ---
cover.get("/:id/cover", async (c) => {
  const result = await requireVideo(c);
  if (result instanceof Response) return result;

  if (result.trashedAt) {
    return c.text("Cannot edit a trashed video", 400);
  }

  return c.html(<CoverPage video={result} />);
});

export default cover;
