import { z } from "zod";
import { createConfig, type ConfigFile } from "../src/config.js";
import { Git } from "../src/lib/git.js";
import { RepoPaths } from "../src/lib/paths.js";
import type { ToolContext, ToolDefinition } from "../src/tools/tool.js";

export async function createContext(
  repo: string,
  options: { file?: ConfigFile; allowRunTests?: boolean } = {},
): Promise<ToolContext> {
  const config = await createConfig({ repo, ...options });
  return { config, paths: new RepoPaths(config), git: new Git(config.repoRoot) };
}

/** The raw (pre-validation) input type a client would send to a tool. */
export type ToolInput<T> =
  T extends ToolDefinition<infer In, z.ZodRawShape> ? z.input<z.ZodObject<In>> : never;

/** Validates raw input against the tool's schema (as the MCP server would), then runs it. */
export function callTool<In extends z.ZodRawShape, Out extends z.ZodRawShape>(
  tool: ToolDefinition<In, Out>,
  input: z.input<z.ZodObject<In>>,
  context: ToolContext,
): Promise<z.output<z.ZodObject<Out>>> {
  return tool.run(z.object(tool.inputSchema).parse(input), context);
}
