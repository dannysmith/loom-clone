import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readEditsLenient } from "../edl";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "edl-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (content: string) => Bun.write(join(dir, "edits.json"), content);

describe("readEditsLenient", () => {
  test("returns [] when the file is missing", async () => {
    expect(await readEditsLenient(dir)).toEqual([]);
  });

  test("returns the edits from a valid file", async () => {
    const edits = [
      { type: "trim", startTime: 0, endTime: 3 },
      { type: "cut", startTime: 10, endTime: 12.5 },
    ];
    await write(JSON.stringify({ version: 1, source: "source.mp4", edits }));
    expect(await readEditsLenient(dir)).toEqual(edits as never);
  });

  test("degrades to [] on malformed JSON", async () => {
    await write("{not json");
    expect(await readEditsLenient(dir)).toEqual([]);
  });

  test("degrades to [] when edits is not an array", async () => {
    await write(JSON.stringify({ edits: "nope" }));
    expect(await readEditsLenient(dir)).toEqual([]);
  });

  // Entry-level garbage must not leak into kept-segment arithmetic — the
  // serving paths call it with no try/catch of their own.
  test("degrades to [] on a null entry", async () => {
    await write(JSON.stringify({ edits: [{ type: "cut", startTime: 1, endTime: 2 }, null] }));
    expect(await readEditsLenient(dir)).toEqual([]);
  });

  test("degrades to [] on an unknown edit type", async () => {
    await write(JSON.stringify({ edits: [{ type: "splice", startTime: 1, endTime: 2 }] }));
    expect(await readEditsLenient(dir)).toEqual([]);
  });

  test("degrades to [] on non-finite times", async () => {
    await write(JSON.stringify({ edits: [{ type: "cut", startTime: "1", endTime: 2 }] }));
    expect(await readEditsLenient(dir)).toEqual([]);
    await write(JSON.stringify({ edits: [{ type: "cut", startTime: 1 }] }));
    expect(await readEditsLenient(dir)).toEqual([]);
  });
});
