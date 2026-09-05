// Integration tests for the presentation master: committing an edit, reverting
// it, reprocessing without losing it, regenerating a single artifact from it,
// and the staged swap's failure behaviour. ffmpeg-gated.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { getDb } from "../../../db/client";
import { videos } from "../../../db/schema";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../../test-utils";
import { probeDuration } from "../../derivatives";
import { DATA_DIR } from "../../paths";
import { createVideo, getTranscript, getVideo, upsertTranscript } from "../../store";
import { _drainInFlight, scheduleEdit, scheduleReprocess } from "../pipeline";
import { type StepContext, stepByKind } from "../registry";
import { getStepStates, markStepReady } from "../steps-store";

const ffmpegAvailable = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await teardownTestEnv(env);
});

// 3-second 1080p source with audio → the presentation master is 1080p.mp4 plus a
// 720p variant, so the staged swap moves multiple files.
async function write1080pSource(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
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
      "testsrc=duration=3:size=1920x1080:rate=15",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3:sample_rate=48000",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      join(dir, "source.mp4"),
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`source fixture failed: ${stderr}`);
}

// A silent source of arbitrary length and size, for threshold cases where the
// content doesn't matter but the duration does.
async function writeSource(dir: string, seconds: number): Promise<void> {
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
      `testsrc=duration=${seconds}:size=640x360:rate=10`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${seconds}:sample_rate=48000`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      join(dir, "source.mp4"),
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`source fixture failed: ${stderr}`);
}

const TRIM_EDL = JSON.stringify({
  version: 1,
  source: "source.mp4",
  edits: [{ type: "trim", startTime: 0.5, endTime: 2.5 }],
});

const EMPTY_EDL = JSON.stringify({ version: 1, source: "source.mp4", edits: [] });

// A `ready` recorded video with a real 1080p source.mp4, cached dims, and a
// saved EDL — the state the editor commit hands off.
async function readyEditable(edl: string = TRIM_EDL): Promise<{ id: string; dir: string }> {
  const video = await createVideo();
  const dir = join(DATA_DIR, video.id, "derivatives");
  await write1080pSource(dir);
  await Bun.write(join(dir, "edits.json"), edl);
  await markStepReady(video.id, "source");
  await markStepReady(video.id, "metadata");
  await getDb()
    .update(videos)
    .set({ status: "ready", width: 1920, height: 1080, durationSeconds: 3 })
    .where(eq(videos.id, video.id));
  return { id: video.id, dir };
}

describe("presentation master", () => {
  test.skipIf(!ffmpegAvailable)(
    "an edit commit produces the cut master + variant, flips to edited, settles ready",
    async () => {
      const { id, dir } = await readyEditable();

      scheduleEdit(id, "recorded");
      await _drainInFlight();

      // Master (source resolution) + downscaled variant landed; staging gone.
      expect(await Bun.file(join(dir, "1080p.mp4")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "720p.mp4")).exists()).toBe(true);
      expect(await Bun.file(join(dir, ".staging")).exists()).toBe(false);

      const updated = await getVideo(id);
      expect(updated?.status).toBe("ready");
      expect(updated?.lastEditedAt).not.toBeNull();
      // Trim 0.5–2.5 → ~2s presentation duration, cached from the master's probe.
      expect(updated?.durationSeconds ?? 0).toBeGreaterThan(1.5);
      expect(updated?.durationSeconds ?? 0).toBeLessThan(2.5);

      const steps = await getStepStates(id);
      expect(steps.get("presentation")?.state).toBe("ready");
      expect(steps.get("variant_720")?.state).toBe("ready");
      // source.mp4 is preserved, pristine, and its row stays ready.
      expect(steps.get("source")?.state).toBe("ready");
      expect(await Bun.file(join(dir, "source.mp4")).exists()).toBe(true);
      expect((await probeDuration(join(dir, "source.mp4"))) ?? 0).toBeGreaterThan(2.5);
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "committing an empty EDL reverts to the full source and clears the edited flag",
    async () => {
      const { id, dir } = await readyEditable();
      scheduleEdit(id, "recorded");
      await _drainInFlight();
      expect((await getVideo(id))?.lastEditedAt).not.toBeNull();

      // The revert path: remove every edit in the editor, commit again.
      await Bun.write(join(dir, "edits.json"), EMPTY_EDL);
      scheduleEdit(id, "recorded");
      await _drainInFlight();

      const reverted = await getVideo(id);
      expect(reverted?.status).toBe("ready");
      expect(reverted?.lastEditedAt).toBeNull();
      // Back to the full 3s source length.
      expect(reverted?.durationSeconds ?? 0).toBeGreaterThan(2.5);
      const masterDuration = (await probeDuration(join(dir, "1080p.mp4"))) ?? 0;
      expect(masterDuration).toBeGreaterThan(2.5);
    },
    90_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "a reprocess regenerates the committed edit rather than discarding it",
    async () => {
      const { id, dir } = await readyEditable();
      scheduleEdit(id, "recorded");
      await _drainInFlight();
      const editedDuration = (await getVideo(id))?.durationSeconds ?? 0;

      // "Re-run post-processing" — a `present` run, with the EDL still on disk.
      scheduleReprocess(id, { source: "recorded", intent: "present" });
      await _drainInFlight();

      const after = await getVideo(id);
      expect(after?.status).toBe("ready");
      expect(after?.lastEditedAt).not.toBeNull();
      expect(Math.abs((after?.durationSeconds ?? 0) - editedDuration)).toBeLessThan(0.3);
      const masterDuration = (await probeDuration(join(dir, "1080p.mp4"))) ?? 0;
      expect(masterDuration).toBeLessThan(2.5);
    },
    90_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "a single-artifact regen rebuilds a variant from the presentation master",
    async () => {
      const { id, dir } = await readyEditable();
      scheduleEdit(id, "recorded");
      await _drainInFlight();

      const editedDuration = (await getVideo(id))?.durationSeconds ?? 0;
      expect(editedDuration).toBeGreaterThan(1.5);
      expect(editedDuration).toBeLessThan(2.5);

      // Drop the variant and regenerate it standalone (the "↻" path).
      await rm(join(dir, "720p.mp4"), { force: true });
      scheduleReprocess(id, { source: "recorded", intent: "only", kind: "variant_720" });
      await _drainInFlight();

      // The regenerated variant matches the MASTER's duration (~2s), proving it
      // was cut from the edited 1080p.mp4 rather than the full 3s source.mp4.
      expect(await Bun.file(join(dir, "720p.mp4")).exists()).toBe(true);
      const variantDuration = (await probeDuration(join(dir, "720p.mp4"))) ?? 0;
      expect(Math.abs(variantDuration - editedDuration)).toBeLessThan(0.6);

      const after = await getVideo(id);
      expect(after?.status).toBe("ready");
      expect(after?.lastEditedAt).not.toBeNull();
      expect((await getStepStates(id)).get("presentation")?.state).toBe("ready");
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "a failed rebuild restores ready and leaves the served output byte-untouched",
    async () => {
      const { id, dir } = await readyEditable();
      // Simulate an already-served master (marker content) with its ledger row
      // and lastEditedAt set.
      await Bun.write(join(dir, "1080p.mp4"), "PRIOR-PRESENTATION");
      await markStepReady(id, "presentation");
      await getDb()
        .update(videos)
        .set({ lastEditedAt: new Date().toISOString() })
        .where(eq(videos.id, id));

      // An EDL that removes everything → the presentation step throws before any
      // swap can happen.
      await Bun.write(
        join(dir, "edits.json"),
        JSON.stringify({
          version: 1,
          source: "source.mp4",
          edits: [{ type: "cut", startTime: 0, endTime: 3 }],
        }),
      );

      scheduleEdit(id, "recorded");
      await _drainInFlight();

      expect((await getVideo(id))?.status).toBe("ready");
      expect(await Bun.file(join(dir, ".staging")).exists()).toBe(false);
      // The previously-served master is byte-for-byte untouched.
      expect(await Bun.file(join(dir, "1080p.mp4")).text()).toBe("PRIOR-PRESENTATION");
    },
    60_000,
  );
});

describe("artifacts that stop applying are removed, not left stale", () => {
  test.skipIf(!ffmpegAvailable)(
    "a regenerate of a step that no longer applies clears what it left behind",
    async () => {
      // The editor storyboard needs at least 5 seconds of source. Regenerating
      // it for a 2-second video means the step no longer applies at all — it
      // never runs, so it can't report "skipped". Whatever is on disk describes
      // a video that no longer exists, and leaving it is worse than having none.
      const video = await createVideo();
      const dir = join(DATA_DIR, video.id, "derivatives");
      await mkdir(dir, { recursive: true });
      await writeSource(dir, 2);
      await Bun.write(
        join(dir, "editor-storyboard.vtt"),
        "WEBVTT\n\n00:00:00.000 --> 00:01:10.000\n",
      );
      await markStepReady(video.id, "editor_storyboard");
      await markStepReady(video.id, "source");
      await markStepReady(video.id, "metadata");
      await getDb()
        .update(videos)
        .set({ status: "ready", width: 640, height: 360, durationSeconds: 2 })
        .where(eq(videos.id, video.id));

      scheduleReprocess(video.id, {
        source: "recorded",
        intent: "only",
        kind: "editor_storyboard",
      });
      await _drainInFlight();

      expect(await Bun.file(join(dir, "editor-storyboard.vtt")).exists()).toBe(false);
      expect((await getStepStates(video.id)).get("editor_storyboard")?.state).toBe("skipped");
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "a staged run that fails leaves an invalidated artifact alone",
    async () => {
      // Invalidation deletes from the LIVE directory. A staged run promises the
      // previous outputs survive a failure, so it has to wait for the swap —
      // otherwise a rebuild that aborts still takes the file with it.
      const { id, dir } = await readyEditable();
      await Bun.write(join(dir, "suggested-edits.json"), '{"version":1,"edits":[]}');
      await markStepReady(id, "suggested_edits");
      // An edited video: suggested_edits stops applying, so an intake (which
      // forces every step) would invalidate it. Make the run fail after that
      // point by removing the HLS it needs to re-stitch.
      await getDb()
        .update(videos)
        .set({ lastEditedAt: new Date().toISOString() })
        .where(eq(videos.id, id));

      scheduleReprocess(id, { source: "recorded", intent: "intake" });
      await _drainInFlight();

      // The run failed (no segments to stitch), so the file it had invalidated
      // is still there — as the "previous outputs kept" message claims.
      expect(await Bun.file(join(dir, "suggested-edits.json")).exists()).toBe(true);
      expect((await getVideo(id))?.status).toBe("ready");
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "a short edit still gets a storyboard — there is no duration threshold",
    async () => {
      // The case that used to orphan one: a 70s video trimmed to 50s. With the
      // threshold gone the storyboard is simply regenerated for the new
      // timeline, so nothing viewer-facing appears or disappears with an edit.
      const video = await createVideo();
      const dir = join(DATA_DIR, video.id, "derivatives");
      await mkdir(dir, { recursive: true });
      await writeSource(dir, 70);
      await Bun.write(
        join(dir, "edits.json"),
        JSON.stringify({
          version: 1,
          source: "source.mp4",
          edits: [{ type: "trim", startTime: 0, endTime: 50 }],
        }),
      );
      await markStepReady(video.id, "source");
      await markStepReady(video.id, "metadata");
      await getDb()
        .update(videos)
        .set({ status: "ready", width: 640, height: 360, durationSeconds: 70 })
        .where(eq(videos.id, video.id));

      scheduleEdit(video.id, "recorded");
      await _drainInFlight();

      expect((await probeDuration(join(dir, "360p.mp4"))) ?? 0).toBeLessThan(55);
      expect(await Bun.file(join(dir, "storyboard.vtt")).exists()).toBe(true);
      expect((await getStepStates(video.id)).get("storyboard")?.state).toBe("ready");
      // Cues describe the EDITED timeline, not the 70s original.
      const vtt = await Bun.file(join(dir, "storyboard.vtt")).text();
      expect(vtt).not.toContain("00:01:0");
    },
    90_000,
  );
});

describe("invalidation never takes a file another step owns", () => {
  test.skipIf(!ffmpegAvailable)(
    "a 1080p source keeps its master, which shares a name with the 1080p variant",
    async () => {
      // variant_1080 needs height > 1080, so on a 1080p source it never applies
      // — but its artifact path is `1080p.mp4`, exactly where the master lives.
      // Treating that as a stale artifact deletes the master the run just built.
      const { id, dir } = await readyEditable();

      scheduleEdit(id, "recorded");
      await _drainInFlight();
      expect(await Bun.file(join(dir, "1080p.mp4")).exists()).toBe(true);

      // Second run: this is where it bit, because the master now exists when the
      // non-applicable variant step looks for "its" stale file.
      scheduleReprocess(id, { source: "recorded", intent: "present" });
      await _drainInFlight();

      expect(await Bun.file(join(dir, "1080p.mp4")).exists()).toBe(true);
      expect((await getStepStates(id)).get("presentation")?.state).toBe("ready");
    },
    90_000,
  );
});

describe("the master is validated against the EDL, not against itself", () => {
  test.skipIf(!ffmpegAvailable)(
    "a master that came out the wrong length fails validation",
    async () => {
      // The expectation used to be a probe of the file being validated, so the
      // comparison could only ever pass — a render that produced a fraction of
      // what the EDL asked for would validate, land, and serve. It now comes
      // from the kept-segment sum, which is computed from the EDL.
      const dir = join(DATA_DIR, "validate-check", "derivatives");
      await mkdir(dir, { recursive: true });
      await writeSource(dir, 3);
      // Stand the 3-second fixture in as the "master" and check it against what
      // a 20-second cut would have expected.
      await Bun.write(join(dir, "1080p.mp4"), await Bun.file(join(dir, "source.mp4")).bytes());

      const step = stepByKind("presentation")!;
      const ctx = { dir, height: 1080, scratch: {} } as unknown as StepContext;

      ctx.scratch.expectedPresentationDuration = 20;
      expect(await step.validate!(ctx)).toBe(false);

      ctx.scratch.expectedPresentationDuration = 3;
      expect(await step.validate!(ctx)).toBe(true);
    },
    60_000,
  );
});

describe("a corrupt EDL fails loudly rather than un-editing the video", () => {
  test.skipIf(!ffmpegAvailable)(
    "a malformed edits.json keeps the previous master instead of replacing it",
    async () => {
      // Degrading to "no edits" would be the damaging outcome: the run would
      // succeed and the swap would put an UNCUT master in front of viewers,
      // quietly restoring whatever the user had trimmed out.
      const { id, dir } = await readyEditable();
      await Bun.write(join(dir, "1080p.mp4"), "PREVIOUS-EDITED-MASTER");
      await markStepReady(id, "presentation");
      await Bun.write(join(dir, "edits.json"), "{ this is not json");

      scheduleEdit(id, "recorded");
      await _drainInFlight();

      // Previous master untouched, video still serving, status restored.
      expect(await Bun.file(join(dir, "1080p.mp4")).text()).toBe("PREVIOUS-EDITED-MASTER");
      expect((await getVideo(id))?.status).toBe("ready");
    },
    60_000,
  );
});

describe("the audio chain is an enhancement, not a precondition", () => {
  test.skipIf(!ffmpegAvailable)(
    "a recording with no audio stream still gets a master",
    async () => {
      // A screen recording made with the mic off. The chain declines (nothing to
      // process) and the master is produced by remuxing — a video that can't be
      // enhanced must still be servable.
      const video = await createVideo();
      const dir = join(DATA_DIR, video.id, "derivatives");
      await mkdir(dir, { recursive: true });
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
          "testsrc=duration=2:size=1280x720:rate=15",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-movflags",
          "+faststart",
          "-f",
          "mp4",
          join(dir, "source.mp4"),
        ],
        { stderr: "pipe", stdout: "pipe" },
      );
      if ((await proc.exited) !== 0) throw new Error("silent fixture failed");
      await markStepReady(video.id, "source");
      await markStepReady(video.id, "metadata");
      await getDb()
        .update(videos)
        .set({ status: "ready", width: 1280, height: 720, durationSeconds: 2 })
        .where(eq(videos.id, video.id));

      scheduleReprocess(video.id, { source: "recorded", intent: "present" });
      await _drainInFlight();

      expect(await Bun.file(join(dir, "720p.mp4")).exists()).toBe(true);
      expect((await getStepStates(video.id)).get("presentation")?.state).toBe("ready");
      expect((await getVideo(video.id))?.status).toBe("ready");
    },
    60_000,
  );
});

describe("captions follow the presentation timeline", () => {
  test.skipIf(!ffmpegAvailable)(
    "an edit re-derives the transcript from words.json",
    async () => {
      const { id, dir } = await readyEditable();
      // Word timings spanning the source; only those inside the 0.5–2.5 trim survive.
      await Bun.write(
        join(dir, "words.json"),
        JSON.stringify([
          { word: "alpha", start: 0.0, end: 0.4 }, // dropped (before trim)
          { word: "bravo", start: 1.0, end: 1.4 }, // kept
          { word: "charlie", start: 2.0, end: 2.4 }, // kept
        ]),
      );
      await Bun.write(
        join(dir, "captions.original.srt"),
        "1\n00:00:00,000 --> 00:00:03,000\nalpha bravo charlie\n",
      );
      await markStepReady(id, "transcript");
      await upsertTranscript(id, "srt", "alpha bravo charlie");

      scheduleEdit(id, "recorded");
      await _drainInFlight();

      expect((await getTranscript(id))?.plainText).toBe("bravo charlie");
      expect(await Bun.file(join(dir, "captions.srt")).text()).toContain("bravo");
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "with no edits the Mac's own captions are copied through verbatim",
    async () => {
      const { id, dir } = await readyEditable(EMPTY_EDL);
      const original = "1\n00:00:00,000 --> 00:00:03,000\nalpha bravo charlie\n";
      await Bun.write(join(dir, "captions.original.srt"), original);
      await markStepReady(id, "transcript");

      scheduleEdit(id, "recorded");
      await _drainInFlight();

      // Verbatim: the Mac's cue segmentation survives rather than being
      // re-derived from word timings.
      expect(await Bun.file(join(dir, "captions.srt")).text()).toBe(original);
      expect((await getStepStates(id)).get("captions")?.state).toBe("ready");
    },
    60_000,
  );

  test.skipIf(!ffmpegAvailable)(
    "an edited video with no words.json loses its captions rather than serving desynced ones",
    async () => {
      const { id, dir } = await readyEditable();
      await Bun.write(
        join(dir, "captions.original.srt"),
        "1\n00:00:00,000 --> 00:00:03,000\nalpha\n",
      );
      await Bun.write(join(dir, "captions.srt"), "1\n00:00:00,000 --> 00:00:03,000\nalpha\n");
      await markStepReady(id, "transcript");

      scheduleEdit(id, "recorded");
      await _drainInFlight();

      // No word timings means the cut can't be remapped — better no subtitles
      // than ones describing the uncut timeline.
      expect(await Bun.file(join(dir, "captions.srt")).exists()).toBe(false);
      expect(await Bun.file(join(dir, "captions.original.srt")).exists()).toBe(true);
      expect((await getStepStates(id)).get("captions")?.state).toBe("skipped");
    },
    60_000,
  );
});
