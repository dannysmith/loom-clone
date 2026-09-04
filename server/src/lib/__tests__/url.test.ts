import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { absoluteUrl, activeRawFilename, getPublicBaseUrl, urlsForVideo } from "../url";

describe("activeRawFilename", () => {
  test("returns the presentation master for an unedited video", () => {
    expect(activeRawFilename({ lastEditedAt: null, height: 1080 })).toBe("1080p.mp4");
  });

  test("returns the same master for an edited video — editing doesn't rename it", () => {
    expect(activeRawFilename({ lastEditedAt: "2026-04-30T12:00:00Z", height: 1080 })).toBe(
      "1080p.mp4",
    );
  });

  test("falls back to source.mp4 when the height isn't cached yet", () => {
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
  // Everything we publish names video.mp4 rather than a concrete rendition, so a
  // link survives a re-encode or a change of resolution. The player is the
  // exception and gets concrete URLs (see resolve.ts).
  test("points raw at the redirecting video.mp4 entry point", () => {
    const urls = urlsForVideo({ slug: "my-video", lastEditedAt: null, height: 1080 });
    expect(urls.raw).toBe("/my-video/raw/video.mp4");
  });

  test("points raw at video.mp4 for an edited video too", () => {
    const urls = urlsForVideo({
      slug: "my-video",
      lastEditedAt: "2026-04-30T12:00:00Z",
      height: 1080,
    });
    expect(urls.raw).toBe("/my-video/raw/video.mp4");
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
