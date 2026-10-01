import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];
const WILDCARD_HOSTNAMES = ["0.0.0.0", "[::]"];
const MCP_PATH = "/mcp";

export interface HttpOptions {
  host: string;
  port: number;
  /** If set, every request must carry `Authorization: Bearer <authToken>`. */
  authToken?: string | undefined;
  /**
   * Extra hostnames (no port) accepted in the Host/Origin check, compared
   * case-insensitively. Required when `host` is a wildcard bind address.
   */
  allowedHosts?: readonly string[] | undefined;
  /** Called per request. Stateless mode needs a fresh server for each one. */
  createServer: () => McpServer;
}

export interface RunningHttpServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Serves MCP over Streamable HTTP in stateless mode at `/mcp`.
 *
 * Binds to loopback by default. Binding anywhere else requires a token. The
 * Host and Origin headers must name an expected hostname, which blocks DNS
 * rebinding (a web page making a browser call a local server).
 */
export async function serveHttp(options: HttpOptions): Promise<RunningHttpServer> {
  const normalizedHost = normalizeHostname(options.host);
  const normalizedAllowedHosts = (options.allowedHosts ?? []).map(normalizeHostname);
  const isLoopback = LOOPBACK_HOSTNAMES.includes(normalizedHost);
  const isWildcard = WILDCARD_HOSTNAMES.includes(normalizedHost);
  if (!isLoopback && options.authToken === undefined) {
    throw new Error(
      `Refusing to listen on ${options.host} without a token; set MCP_REPO_TOOLS_TOKEN.`,
    );
  }
  if (isWildcard && normalizedAllowedHosts.length === 0) {
    throw new Error(
      `Binding to ${options.host} accepts any Host header; pass --allowed-host <name> for each name clients use.`,
    );
  }
  const allowedHostnames = isLoopback
    ? [...LOOPBACK_HOSTNAMES, ...normalizedAllowedHosts]
    : isWildcard
      ? normalizedAllowedHosts
      : [normalizedHost, ...normalizedAllowedHosts];
  const checkToken = options.authToken === undefined ? null : tokenChecker(options.authToken);

  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error("[mcp-repo-tools] HTTP request failed:", error);
      if (!res.headersSent) reply(res, 500, "Internal server error");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostnameAllowed(req.headers.host, allowedHostnames)) {
      reply(res, 403, "Host not allowed");
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !hostnameAllowed(origin, allowedHostnames)) {
      reply(res, 403, "Origin not allowed");
      return;
    }
    if (new URL(req.url ?? "/", "http://placeholder").pathname !== MCP_PATH) {
      reply(res, 404, "Not found");
      return;
    }
    if (checkToken !== null && !checkToken(req.headers.authorization)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      reply(res, 401, "Unauthorized");
      return;
    }
    // Stateless: no sessions, so no server-initiated GET streams and nothing to DELETE.
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      reply(res, 405, "Method not allowed");
      return;
    }

    const server = options.createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, resolve);
  });

  const { port } = httpServer.address() as AddressInfo;
  const urlHost = options.host.includes(":") ? `[${options.host}]` : options.host;
  return {
    url: `http://${urlHost}:${port}${MCP_PATH}`,
    close: () =>
      new Promise((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

/** Accepts a Host header ("host:port") or an Origin ("scheme://host:port"). */
function hostnameAllowed(value: string | undefined, allowed: readonly string[]): boolean {
  if (value === undefined) return false;
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    return allowed.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Normalizes a hostname to the lowercase, bracketed form `URL#hostname`
 * produces for IPv6 (e.g. `::1` and `[::1]` both become `[::1]`), so bind
 * addresses and `allowedHosts` entries compare correctly against it.
 */
function normalizeHostname(host: string): string {
  const lower = host.toLowerCase();
  return lower.includes(":") && !lower.startsWith("[") ? `[${lower}]` : lower;
}

/** Compares digests so the check takes the same time whatever the input. */
function tokenChecker(token: string): (header: string | undefined) => boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${token}`);
  return (header) => header !== undefined && timingSafeEqual(digest(header), expected);
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}
