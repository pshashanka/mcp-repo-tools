import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** Serves over stdin/stdout. stdout carries protocol messages, so logs must go to stderr. */
export async function serveStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}
