import { Hono } from "hono";
import { DashboardPage } from "../../views/admin/pages/DashboardPage";
import { LoginPage } from "../../views/admin/pages/LoginPage";
import { SettingsPage } from "../../views/admin/pages/SettingsPage";
import { TrashBinPage } from "../../views/admin/pages/TrashBinPage";
import { VideoDetailPage } from "../../views/admin/pages/VideoDetailPage";

const admin = new Hono();

admin.get("/", (c) => c.html(<DashboardPage />));
admin.get("/videos/:id", (c) => c.html(<VideoDetailPage id={c.req.param("id")} />));
admin.get("/settings", (c) => c.html(<SettingsPage />));
admin.get("/trash", (c) => c.html(<TrashBinPage />));
admin.get("/login", (c) => c.html(<LoginPage />));

export default admin;
