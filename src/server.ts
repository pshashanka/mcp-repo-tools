import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { Config } from "./config.js";
import { ToolError, toErrorResult } from "./lib/errors.js";
import { Git } from "./lib/git.js";
import { RepoPaths } from "./lib/paths.js";
import { getDiffTool } from "./tools/get-diff.js";
import { listChangedFilesTool } from "./tools/list-changed-files.js";
import { readFileTool } from "./tools/read-file.js";
import { createRunTestsTool } from "./tools/run-tests.js";
import { searchCodeTool } from "./tools/search-code.js";
import type { ToolContext, ToolDefinition } from "./tools/tool.js";

export { createConfig, loadConfigFile, type Config, type ConfigFile } from "./config.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

export const SERVER_INFO = { name: pkg.name, version: pkg.version };

const INSTRUCTIONS = `Read-only access to one local git repository.
For reviewing a change: call list_changed_files first (cheap), then get_diff for the files that matter, then read_file (with \`ref\` to see the old version) or search_code for surrounding context.
All paths are repo-relative. Errors start with a stable code such as PATH_DENIED or INVALID_REF.`;

type AnyTool = ToolDefinition<z.ZodRawShape, z.ZodRawShape>;

export interface ServerOptions {
  /** Called with unexpected (non-ToolError) failures. Defaults to stderr. */
  onError?: (toolName: string, error: unknown) => void;
}

/** Creates an MCP server exposing the repo described by `config`. Not yet connected to a transport. */
export function createServer(config: Config, options: ServerOptions = {}): McpServer {
  const onError =
    options.onError ??
    ((toolName: string, error: unknown) => {
      console.error(`[mcp-repo-tools] ${toolName} failed unexpectedly:`, error);
    });

  const context: ToolContext = {
    config,
    paths: new RepoPaths(config),
    git: new Git(config.repoRoot),
  };
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  const runTests = config.runTests.enabled ? createRunTestsTool(config) : null;
  // Each tool's run() is typed by its own schema, so the mixed list is widened here, once.
  const tools = [
    readFileTool,
    searchCodeTool,
    listChangedFilesTool,
    getDiffTool,
    ...(runTests === null ? [] : [runTests]),
  ] as unknown as AnyTool[];

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (input): Promise<CallToolResult> => {
        try {
          const output = await tool.run(input, context);
          return {
            content: [{ type: "text", text: tool.render(output) }],
            structuredContent: output,
          };
        } catch (error) {
          if (!(error instanceof ToolError)) onError(tool.name, error);
          return toErrorResult(error);
        }
      },
    );
  }

  return server;
}
