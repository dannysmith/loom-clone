import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { formatFileSize, listVideoFiles } from "../files";
import { createVideo } from "../store";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

describe("listVideoFiles", () => {
  test("lists files in a video directory", async () => {
    const v = await createVideo();
    const dir = join("data", v.id);
    await writeFile(join(dir, "stream.m3u8"), "content");
    await writeFile(join(dir, "init.mp4"), "content");

    const files = await listVideoFiles(v.id);
    const names = files.filter((f) => !f.isDirectory).map((f) => f.name);
    expect(names).toContain("stream.m3u8");
    expect(names).toContain("init.mp4");
  });

  test("includes subdirectories and their files", async () => {
    const v = await createVideo();
    const dir = join("data", v.id);
    await mkdir(join(dir, "derivatives"), { recursive: true });
    await writeFile(join(dir, "derivatives", "source.mp4"), "content");

    const files = await listVideoFiles(v.id);
    const dirEntries = files.filter((f) => f.isDirectory);
    expect(dirEntries.some((f) => f.name === "derivatives")).toBe(true);

    const fileEntries = files.filter((f) => !f.isDirectory);
    expect(fileEntries.some((f) => f.path === "derivatives/source.mp4")).toBe(true);
  });

  test("returns file sizes", async () => {
    const v = await createVideo();
    const dir = join("data", v.id);
    await writeFile(join(dir, "test.txt"), "hello world");

    const files = await listVideoFiles(v.id);
    const testFile = files.find((f) => f.name === "test.txt");
    expect(testFile).toBeDefined();
    expect(testFile!.size).toBe(11);
  });

  test("returns empty array for nonexistent video", async () => {
    const files = await listVideoFiles("nonexistent-id");
    expect(files).toEqual([]);
  });

  test("returns entries sorted by path", async () => {
    const v = await createVideo();
    const dir = join("data", v.id);
    await writeFile(join(dir, "z-file"), "a");
    await writeFile(join(dir, "a-file"), "b");

    const files = await listVideoFiles(v.id);
    const names = files.filter((f) => !f.isDirectory).map((f) => f.name);
    expect(names.indexOf("a-file")).toBeLessThan(names.indexOf("z-file"));
  });
});

describe("formatFileSize", () => {
  test("formats bytes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(500)).toBe("500 B");
  });

  test("formats kilobytes", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(10240)).toBe("10 KB");
  });

  test("formats megabytes", () => {
    expect(formatFileSize(1048576)).toBe("1.0 MB");
    expect(formatFileSize(5242880)).toBe("5.0 MB");
  });

  test("formats gigabytes", () => {
    expect(formatFileSize(1073741824)).toBe("1.0 GB");
  });
});
