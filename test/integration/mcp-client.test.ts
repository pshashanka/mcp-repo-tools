import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/fixture-repo.js";

const projectRoot = join(import.meta.dirname, "..", "..");

let repo: FixtureRepo;

beforeAll(async () => {
  repo = await createFixtureRepo();
});

afterAll(async () => {
  await repo.cleanup();
});

async function connect(options: { allowRunTests?: boolean } = {}) {
  const config = await createConfig({
    repo: repo.root,
    ...options,
    file: { runTests: { targets: { unit: { command: [process.execPath, "--test"] } } } },
  });
  const server = createServer(config, { onError: () => undefined });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "integration-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

describe("MCP server (in-memory transport)", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connect();
  });

  afterAll(async () => {
    await client.close();
  });

  it("advertises the read-only tools with input and output schemas", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual([
      "read_file",
      "search_code",
      "list_changed_files",
      "get_diff",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("gives clients instructions for a review workflow", () => {
    expect(client.getInstructions()).toContain("list_changed_files first");
  });

  it("reviews a change end to end: list, diff, read old and new, search", async () => {
    const listed = await call(client, "list_changed_files", { base: "main" });
    expect(listed.isError).toBeFalsy();
    const { files } = listed.structuredContent as { files: { path: string; isTest: boolean }[] };
    expect(files.filter((f) => f.isTest).map((f) => f.path)).toEqual(["test/math.test.js"]);

    const diff = await call(client, "get_diff", { base: "main", paths: ["src/math.js"] });
    expect(diff.content).toEqual([
      { type: "text", text: expect.stringContaining("+export const multiply") as unknown },
    ]);

    const before = await call(client, "read_file", { path: "src/math.js", ref: repo.baseSha });
    const after = await call(client, "read_file", { path: "src/math.js" });
    expect((before.structuredContent as { totalLines: number }).totalLines).toBe(1);
    expect((after.structuredContent as { totalLines: number }).totalLines).toBe(2);

    const search = await call(client, "search_code", { query: "multiply", pathGlobs: ["test/**"] });
    expect((search.structuredContent as { matches: unknown[] }).matches).toHaveLength(2);
  });

  it("returns policy violations as tool errors with a stable code", async () => {
    const result = await call(client, "read_file", { path: ".env" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: expect.stringMatching(/^PATH_DENIED: /) as unknown },
    ]);
  });

  it("rejects input that violates the schema", async () => {
    const result = await call(client, "read_file", { path: "src/math.js", startLine: 0 });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Input validation error");
  });
});

describe("run_tests over MCP", () => {
  it("is not listed unless enabled", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((t) => t.name)).not.toContain("run_tests");
  });

  it("is listed and runs when enabled", async () => {
    const client = await connect({ allowRunTests: true });
    const { tools } = await client.listTools();
    const result = await call(client, "run_tests", { target: "unit" });
    await client.close();

    expect(tools.find((t) => t.name === "run_tests")?.annotations?.destructiveHint).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ passed: true, exitCode: 0 });
  });
});

describe("CLI over stdio", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["build"], { cwd: projectRoot, stdio: "ignore" });
  }, 60_000);

  it("serves the repo to a client that launches it", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(projectRoot, "dist", "index.js"), "--repo", repo.root],
      stderr: "ignore",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport);

    const result = await call(client, "read_file", { path: "README.md", ref: "main" });
    await client.close();

    expect(result.structuredContent).toMatchObject({
      path: "README.md",
      ref: repo.mainSha,
      content: expect.stringContaining("Updated on main.") as unknown,
    });
  });
});
