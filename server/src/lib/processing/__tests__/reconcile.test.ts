import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import { createVideo, getVideo, setVideoStatus } from "../../store";
import { reconcile } from "../reconcile";
import { markStepFailed, markStepReady } from "../steps-store";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

// reconcile only acts on videos already in the post-footage lifecycle, so put
// them in `processing` first (what markFootageComplete does).
async function processingVideo() {
  const video = await createVideo();
  await setVideoStatus(video.id, "processing");
  return video;
}

describe("reconcile", () => {
  test("mandatory steps ready → ready, completedAt stamped", async () => {
    const video = await processingVideo();
    await markStepReady(video.id, "source");
    await markStepReady(video.id, "metadata");

    await reconcile(video.id, { running: true });

    const updated = await getVideo(video.id);
    expect(updated?.status).toBe("ready");
    expect(updated?.completedAt).not.toBeNull();
  });

  test("mandatory step failed and run settled → processing_failed", async () => {
    const video = await processingVideo();
    await markStepReady(video.id, "source");
    await markStepFailed(video.id, "metadata", "ffprobe failed");

    await reconcile(video.id, { running: false });

    expect((await getVideo(video.id))?.status).toBe("processing_failed");
  });

  test("mandatory step failed but run still active → stays processing", async () => {
    const video = await processingVideo();
    await markStepReady(video.id, "source");
    await markStepFailed(video.id, "metadata", "transient");

    await reconcile(video.id, { running: true });

    expect((await getVideo(video.id))?.status).toBe("processing");
  });

  test("interrupted run (mandatory pending, not running) stays processing", async () => {
    const video = await processingVideo();
    await markStepReady(video.id, "source"); // metadata never produced

    await reconcile(video.id, { running: false });

    expect((await getVideo(video.id))?.status).toBe("processing");
  });

  test("does not touch healing (owned by /complete)", async () => {
    const video = await createVideo();
    await setVideoStatus(video.id, "healing");
    await markStepReady(video.id, "source");
    await markStepReady(video.id, "metadata");

    await reconcile(video.id, { running: false });

    expect((await getVideo(video.id))?.status).toBe("healing");
  });

  test("does not touch reprocessing (owned by the editor)", async () => {
    const video = await processingVideo();
    await markStepReady(video.id, "source");
    await markStepReady(video.id, "metadata");
    await reconcile(video.id, { running: false }); // → ready
    await setVideoStatus(video.id, "reprocessing");

    await reconcile(video.id, { running: false });

    expect((await getVideo(video.id))?.status).toBe("reprocessing");
  });

  test("completedAt is set-once across re-derivation", async () => {
    const video = await processingVideo();
    await markStepReady(video.id, "source");
    await markStepReady(video.id, "metadata");
    await reconcile(video.id, { running: false });
    const first = (await getVideo(video.id))?.completedAt;

    // Simulate a heal that drops back to processing then re-reaches ready.
    await setVideoStatus(video.id, "processing");
    await new Promise((r) => setTimeout(r, 5));
    await reconcile(video.id, { running: false });

    expect((await getVideo(video.id))?.completedAt).toBe(first ?? null);
  });
});
