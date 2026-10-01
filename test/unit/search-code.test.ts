import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchCodeTool } from "../../src/tools/search-code.js";
import type { ToolContext } from "../../src/tools/tool.js";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/fixture-repo.js";
import { callTool, createContext, type ToolInput } from "../helpers.js";

let repo: FixtureRepo;
let context: ToolContext;

beforeAll(async () => {
  repo = await createFixtureRepo();
  context = await createContext(repo.root);
});

afterAll(async () => {
  await repo.cleanup();
});

const search = (input: ToolInput<typeof searchCodeTool>) =>
  callTool(searchCodeTool, input, context);

describe("search_code", () => {
  it("finds literal matches with paths and line numbers", async () => {
    const output = await search({ query: "multiply(" });

    expect(output).toEqual({
      ref: null,
      matches: [
        {
          path: "test/math.test.js",
          line: 6,
          text: 'test("multiply", () => assert.equal(multiply(2, 3), 6));',
        },
      ],
      truncated: false,
    });
  });

  it("treats the query literally unless regex is set", async () => {
    await expect(search({ query: "add|multiply" })).resolves.toMatchObject({ matches: [] });

    const output = await search({ query: "export const (add|multiply)", regex: true });
    expect(output.matches.map((m) => `${m.path}:${m.line}`)).toEqual([
      "src/math.js:1",
      "src/math.js:2",
    ]);
  });

  it("is case-insensitive by default", async () => {
    await expect(search({ query: "EXPORT CONST SHOUT" })).resolves.toMatchObject({
      matches: [{ path: "src/strings.js", line: 2 }],
    });
    await expect(
      search({ query: "EXPORT CONST SHOUT", caseSensitive: true }),
    ).resolves.toMatchObject({ matches: [] });
  });

  it("restricts the search to pathGlobs", async () => {
    const output = await search({ query: "add", pathGlobs: ["src/**"] });

    expect(new Set(output.matches.map((m) => m.path))).toEqual(new Set(["src/math.js"]));
  });

  it("searches a commit when ref is given", async () => {
    await expect(search({ query: "multiply", ref: repo.baseSha })).resolves.toEqual({
      ref: repo.baseSha,
      matches: [],
      truncated: false,
    });
    await expect(search({ query: "export const old", ref: repo.baseSha })).resolves.toMatchObject({
      matches: [{ path: "src/legacy.js", line: 1 }],
    });
  });

  it("never returns matches from denied files", async () => {
    await expect(search({ query: "do-not-leak" })).resolves.toMatchObject({ matches: [] });
    await expect(search({ query: "do-not-leak", pathGlobs: [".env"] })).resolves.toMatchObject({
      matches: [],
    });
    await expect(search({ query: "do-not-leak", ref: "HEAD" })).resolves.toMatchObject({
      matches: [],
    });
  });

  it("includes context lines when asked", async () => {
    const output = await search({ query: "multiply(", contextLines: 2 });

    expect(output.matches).toEqual([
      {
        path: "test/math.test.js",
        line: 6,
        text: 'test("multiply", () => assert.equal(multiply(2, 3), 6));',
        before: ["", 'test("add", () => assert.equal(add(2, 3), 5));'],
        after: [],
      },
    ]);
  });

  it("caps results at maxResults and reports truncation", async () => {
    const output = await search({ query: "export", maxResults: 1 });

    expect(output.matches).toHaveLength(1);
    expect(output.truncated).toBe(true);
  });

  it("caps results at the server limit even if the client asks for more", async () => {
    const strict = await createContext(repo.root, { file: { limits: { maxSearchResults: 2 } } });
    const output = await callTool(searchCodeTool, { query: "a", maxResults: 500 }, strict);

    expect(output.matches).toHaveLength(2);
    expect(output.truncated).toBe(true);
  });

  it("handles queries that look like options", async () => {
    await expect(search({ query: "--output=/tmp/x" })).resolves.toMatchObject({ matches: [] });
  });

  it.each([":(top)src", "/etc/*", "../*", "src/../../x"])("rejects the glob %j", async (glob) => {
    await expect(search({ query: "add", pathGlobs: [glob] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("renders grep-style text", async () => {
    const output = await search({ query: "multiply(", contextLines: 1 });

    expect(searchCodeTool.render(output)).toBe(
      'test/math.test.js-5-test("add", () => assert.equal(add(2, 3), 5));\n' +
        'test/math.test.js:6:test("multiply", () => assert.equal(multiply(2, 3), 6));',
    );
  });
});
