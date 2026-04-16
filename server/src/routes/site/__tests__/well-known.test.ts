import { describe, expect, test } from "bun:test";
import wellKnown from "../well-known";

describe("GET /", () => {
  test("returns 200 HTML landing page", async () => {
    const res = await wellKnown.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("loom-clone");
  });
});

describe("GET /robots.txt", () => {
  test("returns text/plain disallowing /admin and /api", async () => {
    const res = await wellKnown.request("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("Disallow: /admin");
    expect(body).toContain("Disallow: /api");
  });
});

describe("GET /favicon.ico", () => {
  test("returns 204 No Content", async () => {
    const res = await wellKnown.request("/favicon.ico");
    expect(res.status).toBe(204);
  });
});

describe("GET /sitemap.xml", () => {
  test("returns valid empty XML sitemap", async () => {
    const res = await wellKnown.request("/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const body = await res.text();
    expect(body).toContain('<?xml version="1.0"');
    expect(body).toContain("<urlset");
    expect(body).toContain("</urlset>");
  });
});
