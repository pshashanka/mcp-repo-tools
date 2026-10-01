import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConfig, type Config } from "../../src/config.js";
import { createServer } from "../../src/server.js";
import { serveHttp, type RunningHttpServer } from "../../src/transports/http.js";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/fixture-repo.js";

const TOKEN = "test-token";

let repo: FixtureRepo;
let config: Config;

beforeAll(async () => {
  repo = await createFixtureRepo();
  config = await createConfig({ repo: repo.root });
});

afterAll(async () => {
  await repo.cleanup();
});

const start = (authToken?: string) =>
  serveHttp({ host: "127.0.0.1", port: 0, authToken, createServer: () => createServer(config) });

/** Raw request, so tests can send headers fetch won't let us set (like Host). */
function rawRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; path?: string } = {},
): Promise<number> {
  const target = new URL(url);
  const method = options.method ?? "POST";
  const body = method === "POST" ? "{}" : "";
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: options.path ?? target.pathname,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
          ...options.headers,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("Streamable HTTP transport", () => {
  let http: RunningHttpServer;

  beforeAll(async () => {
    http = await start();
  });

  afterAll(async () => {
    await http.close();
  });

  it("serves tools to an MCP client", async () => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));

    const { tools } = await client.listTools();
    const result = (await client.callTool({
      name: "list_changed_files",
      arguments: { base: "main" },
    })) as CallToolResult;
    await client.close();

    expect(tools).toHaveLength(4);
    expect(result.structuredContent).toMatchObject({ head: repo.headSha });
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    await expect(rawRequest(http.url, { headers: { Host: "evil.example:80" } })).resolves.toBe(403);
  });

  it("rejects a foreign Origin", async () => {
    await expect(
      rawRequest(http.url, { headers: { Origin: "https://evil.example" } }),
    ).resolves.toBe(403);
  });

  it("only serves POST /mcp", async () => {
    await expect(rawRequest(http.url, { method: "GET" })).resolves.toBe(405);
    await expect(rawRequest(http.url, { path: "/other" })).resolves.toBe(404);
  });
});

describe("Streamable HTTP transport with a token", () => {
  let http: RunningHttpServer;

  beforeAll(async () => {
    http = await start(TOKEN);
  });

  afterAll(async () => {
    await http.close();
  });

  it("rejects requests without the token", async () => {
    await expect(rawRequest(http.url)).resolves.toBe(401);
    await expect(
      rawRequest(http.url, { headers: { Authorization: "Bearer wrong" } }),
    ).resolves.toBe(401);
  });

  it("accepts requests with the token", async () => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(http.url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.length).toBeGreaterThan(0);
  });
});

describe("binding", () => {
  it("refuses a non-loopback address without a token", async () => {
    await expect(
      serveHttp({ host: "0.0.0.0", port: 0, createServer: () => createServer(config) }),
    ).rejects.toThrow(/without a token/);
  });
});
