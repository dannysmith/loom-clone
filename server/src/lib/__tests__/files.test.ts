import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { formatFileSize, getVideoDirSize, getVideosDirSizes, listVideoFiles } from "../files";
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

describe("getVideoDirSize", () => {
  test("returns total size of files in directory", async () => {
    const v = await createVideo();
    const dir = join("data", v.id);
    await writeFile(join(dir, "a.txt"), "hello"); // 5 bytes
    await writeFile(join(dir, "b.txt"), "world!"); // 6 bytes

    const size = await getVideoDirSize(v.id);
    expect(size).toBe(11);
  });

  test("includes subdirectory files in total", async () => {
    const v = await createVideo();
    const dir = join("data", v.id);
    await mkdir(join(dir, "derivatives"), { recursive: true });
    await writeFile(join(dir, "top.txt"), "abc"); // 3 bytes
    await writeFile(join(dir, "derivatives", "deep.txt"), "defgh"); // 5 bytes

    const size = await getVideoDirSize(v.id);
    expect(size).toBe(8);
  });

  test("returns 0 for nonexistent video", async () => {
    const size = await getVideoDirSize("nonexistent-id");
    expect(size).toBe(0);
  });
});

describe("getVideosDirSizes", () => {
  test("returns sizes for multiple videos in parallel", async () => {
    const v1 = await createVideo();
    const v2 = await createVideo();
    await writeFile(join("data", v1.id, "a.txt"), "hello"); // 5
    await writeFile(join("data", v2.id, "b.txt"), "hi"); // 2

    const sizes = await getVideosDirSizes([v1.id, v2.id]);
    expect(sizes[v1.id]).toBe(5);
    expect(sizes[v2.id]).toBe(2);
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
