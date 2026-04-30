import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  absoluteUrl,
  activeRawFilename,
  getPublicBaseUrl,
  urlsForSlug,
  urlsForVideo,
} from "../url";

describe("urlsForSlug", () => {
  test("returns all viewer-facing paths for a slug", () => {
    const urls = urlsForSlug("my-video");
    expect(urls.page).toBe("/my-video");
    expect(urls.raw).toBe("/my-video/raw/source.mp4");
    expect(urls.hls).toBe("/my-video/stream/stream.m3u8");
    expect(urls.poster).toBe("/my-video/poster.jpg");
  });

  test("handles single-character slug", () => {
    const urls = urlsForSlug("a");
    expect(urls.page).toBe("/a");
    expect(urls.raw).toBe("/a/raw/source.mp4");
  });
});

describe("activeRawFilename", () => {
  test("returns source.mp4 for unedited video", () => {
    expect(activeRawFilename({ lastEditedAt: null, height: 1080 })).toBe("source.mp4");
  });

  test("returns resolution file for edited video", () => {
    expect(activeRawFilename({ lastEditedAt: "2026-04-30T12:00:00Z", height: 1080 })).toBe(
      "1080p.mp4",
    );
  });

  test("returns source.mp4 if edited but height is null", () => {
    expect(activeRawFilename({ lastEditedAt: "2026-04-30T12:00:00Z", height: null })).toBe(
      "source.mp4",
    );
  });

  test("returns correct filename for different resolutions", () => {
    expect(activeRawFilename({ lastEditedAt: "2026-04-30T12:00:00Z", height: 1440 })).toBe(
      "1440p.mp4",
    );
    expect(activeRawFilename({ lastEditedAt: "2026-04-30T12:00:00Z", height: 720 })).toBe(
      "720p.mp4",
    );
  });
});

describe("urlsForVideo", () => {
  test("points raw at source.mp4 for unedited video", () => {
    const urls = urlsForVideo({ slug: "my-video", lastEditedAt: null, height: 1080 });
    expect(urls.raw).toBe("/my-video/raw/source.mp4");
  });

  test("points raw at resolution file for edited video", () => {
    const urls = urlsForVideo({
      slug: "my-video",
      lastEditedAt: "2026-04-30T12:00:00Z",
      height: 1080,
    });
    expect(urls.raw).toBe("/my-video/raw/1080p.mp4");
  });

  test("includes page, hls, and poster regardless of edit state", () => {
    const urls = urlsForVideo({
      slug: "my-video",
      lastEditedAt: "2026-04-30T12:00:00Z",
      height: 1080,
    });
    expect(urls.page).toBe("/my-video");
    expect(urls.hls).toBe("/my-video/stream/stream.m3u8");
    expect(urls.poster).toBe("/my-video/poster.jpg");
  });
});

describe("getPublicBaseUrl", () => {
  let origPublicUrl: string | undefined;
  let origHost: string | undefined;
  let origPort: string | undefined;

  beforeEach(() => {
    origPublicUrl = Bun.env.PUBLIC_URL;
    origHost = Bun.env.HOST;
    origPort = Bun.env.PORT;
  });

  afterEach(() => {
    if (origPublicUrl !== undefined) Bun.env.PUBLIC_URL = origPublicUrl;
    else delete Bun.env.PUBLIC_URL;
    if (origHost !== undefined) Bun.env.HOST = origHost;
    else delete Bun.env.HOST;
    if (origPort !== undefined) Bun.env.PORT = origPort;
    else delete Bun.env.PORT;
  });

  test("uses PUBLIC_URL when set", () => {
    Bun.env.PUBLIC_URL = "https://v.danny.is";
    expect(getPublicBaseUrl()).toBe("https://v.danny.is");
  });

  test("strips trailing slashes from PUBLIC_URL", () => {
    Bun.env.PUBLIC_URL = "https://v.danny.is///";
    expect(getPublicBaseUrl()).toBe("https://v.danny.is");
  });

  test("falls back to HOST:PORT when PUBLIC_URL is not set", () => {
    delete Bun.env.PUBLIC_URL;
    Bun.env.HOST = "0.0.0.0";
    Bun.env.PORT = "8080";
    expect(getPublicBaseUrl()).toBe("http://0.0.0.0:8080");
  });

  test("defaults to 127.0.0.1:3000 when nothing is set", () => {
    delete Bun.env.PUBLIC_URL;
    delete Bun.env.HOST;
    delete Bun.env.PORT;
    expect(getPublicBaseUrl()).toBe("http://127.0.0.1:3000");
  });
});

describe("absoluteUrl", () => {
  let origPublicUrl: string | undefined;

  beforeEach(() => {
    origPublicUrl = Bun.env.PUBLIC_URL;
    Bun.env.PUBLIC_URL = "https://v.danny.is";
  });

  afterEach(() => {
    if (origPublicUrl !== undefined) Bun.env.PUBLIC_URL = origPublicUrl;
    else delete Bun.env.PUBLIC_URL;
  });

  test("combines base URL with path", () => {
    expect(absoluteUrl("/my-video")).toBe("https://v.danny.is/my-video");
  });

  test("handles root path", () => {
    expect(absoluteUrl("/")).toBe("https://v.danny.is/");
  });
});
