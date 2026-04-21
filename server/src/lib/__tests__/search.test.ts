import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupTestEnv, type TestEnv, teardownTestEnv } from "../../test-utils";
import { searchVideoIds } from "../search";
import { createVideo, updateVideo } from "../store";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await teardownTestEnv(env);
});

describe("searchVideoIds", () => {
  test("returns empty array for blank query", async () => {
    expect(searchVideoIds("")).toEqual([]);
    expect(searchVideoIds("   ")).toEqual([]);
  });

  test("matches on title", async () => {
    const v = await createVideo();
    await updateVideo(v.id, { title: "Hello World Demo" });

    expect(searchVideoIds("hello")).toContain(v.id);
    expect(searchVideoIds("world")).toContain(v.id);
    expect(searchVideoIds("nonexistent")).toEqual([]);
  });

  test("matches on description", async () => {
    const v = await createVideo();
    await updateVideo(v.id, { description: "A tutorial about widgets" });

    expect(searchVideoIds("tutorial")).toContain(v.id);
    expect(searchVideoIds("widgets")).toContain(v.id);
  });

  test("matches on slug", async () => {
    const v = await createVideo();
    // Slugs are random hex — search for the slug value
    expect(searchVideoIds(v.slug)).toContain(v.id);
  });

  test("prefix matching works (typing partial words)", async () => {
    const v = await createVideo();
    await updateVideo(v.id, { title: "Introduction to Programming" });

    expect(searchVideoIds("intro")).toContain(v.id);
    expect(searchVideoIds("prog")).toContain(v.id);
  });

  test("multi-word search narrows results (implicit AND)", async () => {
    const v1 = await createVideo();
    await updateVideo(v1.id, { title: "Hello World" });
    const v2 = await createVideo();
    await updateVideo(v2.id, { title: "Hello Everyone" });

    const results = searchVideoIds("hello world");
    expect(results).toContain(v1.id);
    expect(results).not.toContain(v2.id);
  });

  test("special characters are stripped safely", async () => {
    const v = await createVideo();
    await updateVideo(v.id, { title: "Test Video" });

    // These should not throw FTS5 syntax errors
    expect(() => searchVideoIds('"quoted"')).not.toThrow();
    expect(() => searchVideoIds("(parens)")).not.toThrow();
    expect(() => searchVideoIds("col:on")).not.toThrow();
    expect(() => searchVideoIds("a^b~c!d")).not.toThrow();
    expect(() => searchVideoIds("OR AND NOT")).not.toThrow();
  });

  test("FTS index stays in sync after title update", async () => {
    const v = await createVideo();
    await updateVideo(v.id, { title: "Original Title" });
    expect(searchVideoIds("original")).toContain(v.id);

    await updateVideo(v.id, { title: "Changed Title" });
    expect(searchVideoIds("original")).not.toContain(v.id);
    expect(searchVideoIds("changed")).toContain(v.id);
  });
});
