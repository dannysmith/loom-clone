import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { searchVideoIds } from "../../../lib/search";
import { DATA_DIR, getTranscript } from "../../../lib/store";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import videos from "../videos";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

async function createVideoViaApi(): Promise<{ id: string; slug: string }> {
  const res = await videos.request("/", { method: "POST" });
  expect(res.status).toBe(200);
  return res.json();
}

const SAMPLE_SRT = `1
00:00:00,000 --> 00:00:03,000
Hello world, this is a test transcript.

2
00:00:03,000 --> 00:00:06,000
It has multiple cues for testing.
`;

describe("PUT /:id/transcript", () => {
  test("uploads SRT transcript and stores plain text", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/transcript`, {
      method: "PUT",
      headers: { "Content-Type": "application/x-subrip" },
      body: SAMPLE_SRT,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Check DB record
    const transcript = await getTranscript(id);
    expect(transcript).toBeTruthy();
    expect(transcript!.format).toBe("srt");
    expect(transcript!.plainText).toContain("Hello world");
    expect(transcript!.plainText).toContain("multiple cues");
    expect(transcript!.wordCount).toBeGreaterThan(0);
  });

  test("writes captions.srt to derivatives directory", async () => {
    const { id } = await createVideoViaApi();
    await videos.request(`/${id}/transcript`, {
      method: "PUT",
      headers: { "Content-Type": "application/x-subrip" },
      body: SAMPLE_SRT,
    });

    const file = Bun.file(join(DATA_DIR, id, "derivatives", "captions.srt"));
    expect(await file.exists()).toBe(true);
    const content = await file.text();
    expect(content).toBe(SAMPLE_SRT);
  });

  test("detects VTT format from content-type", async () => {
    const { id } = await createVideoViaApi();
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:03.000
Hello from VTT format.
`;
    const res = await videos.request(`/${id}/transcript`, {
      method: "PUT",
      headers: { "Content-Type": "text/vtt" },
      body: vtt,
    });
    expect(res.status).toBe(200);

    const transcript = await getTranscript(id);
    expect(transcript!.format).toBe("vtt");
    expect(transcript!.plainText).toContain("Hello from VTT");
  });

  test("detects VTT format from content body", async () => {
    const { id } = await createVideoViaApi();
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:03.000
Auto-detected VTT.
`;
    const res = await videos.request(`/${id}/transcript`, {
      method: "PUT",
      body: vtt,
    });
    expect(res.status).toBe(200);

    const transcript = await getTranscript(id);
    expect(transcript!.format).toBe("vtt");
  });

  test("is idempotent — re-uploading replaces transcript", async () => {
    const { id } = await createVideoViaApi();

    await videos.request(`/${id}/transcript`, {
      method: "PUT",
      body: SAMPLE_SRT,
    });

    const updatedSrt = `1
00:00:00,000 --> 00:00:03,000
Replaced transcript content.
`;
    await videos.request(`/${id}/transcript`, {
      method: "PUT",
      body: updatedSrt,
    });

    const transcript = await getTranscript(id);
    expect(transcript!.plainText).toBe("Replaced transcript content.");
  });

  test("returns 404 for non-existent video", async () => {
    const res = await videos.request("/nonexistent-id/transcript", {
      method: "PUT",
      body: SAMPLE_SRT,
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 for empty body", async () => {
    const { id } = await createVideoViaApi();
    const res = await videos.request(`/${id}/transcript`, {
      method: "PUT",
      body: "",
    });
    expect(res.status).toBe(400);
  });

  test("transcript is searchable via FTS", async () => {
    const { id } = await createVideoViaApi();
    await videos.request(`/${id}/transcript`, {
      method: "PUT",
      body: SAMPLE_SRT,
    });

    // Search for a word from the transcript
    const results = searchVideoIds("transcript");
    expect(results).toContain(id);

    // Search for a word NOT in the transcript
    const noResults = searchVideoIds("xyznonexistent");
    expect(noResults).not.toContain(id);
  });
});
