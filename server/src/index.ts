import { createApp } from "./app";
import { initDb } from "./db/client";

await initDb();
console.log("[db] ready at data/app.db");

const app = createApp();

console.log("Server running at http://localhost:3000");

export default {
  port: 3000,
  fetch: app.fetch,
};
