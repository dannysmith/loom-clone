// The file half of the presentation-master migration, and the safety properties
// it has to hold. These are requirements, not nice-to-haves: this runs once
// against the only copy of a video library that can't be re-recorded.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../../db/client";
import { videos } from "../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { migrateVideo, planMigration } from "../migrate-presentation";
import { DATA_DIR } from "../paths";
import { getStepStates } from "../processing/steps-store";
import { createVideo, getVideo } from "../store";

const ffmpegAvailable = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

async function writeRealMp4(path: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=2:size=640x360:rate=10",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      path,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  if ((await proc.exited) !== 0) throw new Error("fixture failed");
}

// A video as it existed before the restructure: a source.mp4 carrying the audio
// chain, cached dimensions, and no presentation master.
async function legacyVideo(opts: { height?: number; edited?: boolean } = {}) {
  const video = await createVideo();
  const dir = join(DATA_DIR, video.id, "derivatives");
  await mkdir(dir, { recursive: true });
  await writeRealMp4(join(dir, "source.mp4"));
  await getDb()
    .update(videos)
    .set({
      status: "ready",
      width: 640,
      height: opts.height ?? 360,
      durationSeconds: 2,
      sourcePristine: false,
    })
    .where(eq(videos.id, video.id));
  return { id: video.id, dir };
}

async function planFor(id: string) {
  const plan = await planMigration();
  const found = plan.videos.find((v) => v.id === id);
  if (!found) throw new Error("video missing from plan");
  return found;
}

describe("migration planning", () => {
  test.skipIf(!ffmpegAvailable)("plans a master named for the video's height", async () => {
    const { id } = await legacyVideo({ height: 360 });
    const plan = await planFor(id);
    expect(plan.masterAction).toBe("create");
    expect(plan.masterFile).toBe("360p.mp4");
    expect(plan.projectedBytes).toBeGreaterThan(0);
  });

  test.skipIf(!ffmpegAvailable)("an edited video already has its master", async () => {
    // Its {H}p.mp4 IS the presentation master — the 0015 migration re-keyed the
    // receipt that says so, and there is nothing to produce.
    const { id, dir } = await legacyVideo({ height: 360 });
    await writeRealMp4(join(dir, "360p.mp4"));
    const plan = await planFor(id);
    expect(plan.masterAction).toBe("already-present");
    expect(plan.projectedBytes).toBe(0);
  });

  test("a video with no source.mp4 is left alone", async () => {
    const video = await createVideo();
    const plan = await planFor(video.id);
    expect(plan.masterAction).toBe("no-source");
    expect(plan.projectedBytes).toBe(0);
  });

  test.skipIf(!ffmpegAvailable)("planning writes nothing", async () => {
    const { id, dir } = await legacyVideo();
    await planMigration();
    const entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir }));
    expect(entries.sort()).toEqual(["source.mp4"]);
    expect((await getVideo(id))?.sourcePristine).toBe(false);
  });
});

describe("migration application", () => {
  test.skipIf(!ffmpegAvailable)(
    "creates the master and leaves the pristine source untouched",
    async () => {
      const { id, dir } = await legacyVideo({ height: 360 });
      const sourceBefore = await Bun.file(join(dir, "source.mp4")).arrayBuffer();

      const result = await migrateVideo(await planFor(id));
      expect(result.error).toBeUndefined();
      expect(result.mastersCreated).toBe(1);

      expect(await Bun.file(join(dir, "360p.mp4")).exists()).toBe(true);
      // The one file that can't be regenerated is byte-for-byte as it was.
      const sourceAfter = await Bun.file(join(dir, "source.mp4")).arrayBuffer();
      expect(sourceAfter.byteLength).toBe(sourceBefore.byteLength);
      // And the ledger now says the master is servable.
      expect((await getStepStates(id)).get("presentation")?.state).toBe("ready");
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "is idempotent — a second pass does nothing",
    async () => {
      const { id } = await legacyVideo();
      const first = await migrateVideo(await planFor(id));
      expect(first.mastersCreated).toBe(1);

      const second = await migrateVideo(await planFor(id));
      expect(second.error).toBeUndefined();
      expect(second.mastersCreated).toBe(0);
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "leaves source_pristine false — a copied master carries the baked-in chain",
    async () => {
      // Getting this wrong would mean a future audio reprocess running the chain
      // over audio that already has it.
      const { id } = await legacyVideo();
      await migrateVideo(await planFor(id));
      expect((await getVideo(id))?.sourcePristine).toBe(false);
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "seeds captions.original.srt from the served captions",
    async () => {
      const { id, dir } = await legacyVideo();
      const srt = "1\n00:00:00,000 --> 00:00:02,000\nhello\n";
      await Bun.write(join(dir, "captions.srt"), srt);

      const result = await migrateVideo(await planFor(id));
      expect(result.captionsSeeded).toBe(1);
      expect(await Bun.file(join(dir, "captions.original.srt")).text()).toBe(srt);
      // The served copy is untouched — it's already correct for an unedited video.
      expect(await Bun.file(join(dir, "captions.srt")).text()).toBe(srt);
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "does not re-seed captions that already have an original",
    async () => {
      const { id, dir } = await legacyVideo();
      await Bun.write(join(dir, "captions.srt"), "served");
      await Bun.write(join(dir, "captions.original.srt"), "pristine");

      await migrateVideo(await planFor(id));
      expect(await Bun.file(join(dir, "captions.original.srt")).text()).toBe("pristine");
    },
    30_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "an unplayable source is reported, not turned into a broken master",
    async () => {
      const video = await createVideo();
      const dir = join(DATA_DIR, video.id, "derivatives");
      await mkdir(dir, { recursive: true });
      await Bun.write(join(dir, "source.mp4"), "definitely not an mp4");
      await getDb()
        .update(videos)
        .set({ status: "ready", width: 640, height: 360 })
        .where(eq(videos.id, video.id));

      const result = await migrateVideo(await planFor(video.id));
      expect(result.error).toContain("playability");
      // Nothing half-written left where the serving gate looks for a master.
      expect(await Bun.file(join(dir, "360p.mp4")).exists()).toBe(false);
      expect(await Bun.file(join(dir, "360p.mp4.migrating")).exists()).toBe(false);
    },
  );
});
