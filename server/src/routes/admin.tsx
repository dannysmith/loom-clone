import { Hono } from "hono";
import { AdminHome } from "../views/admin/AdminHome";

const admin = new Hono();

admin.get("/", (c) => c.html(<AdminHome />));

export default admin;
