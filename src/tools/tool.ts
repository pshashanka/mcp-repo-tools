import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { Config } from "../config.js";
import type { Git } from "../lib/git.js";
import type { RepoPaths } from "../lib/paths.js";

export interface ToolContext {
  config: Config;
  paths: RepoPaths;
  git: Git;
}

/**
 * A tool is pure data plus two functions, which keeps it testable without an
 * MCP server: `run` gets validated input and either returns structured output
 * or throws a ToolError; `render` turns that output into text for the model.
 */
export interface ToolDefinition<In extends z.ZodRawShape, Out extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: In;
  outputSchema: Out;
  annotations: ToolAnnotations;
  run(input: z.output<z.ZodObject<In>>, context: ToolContext): Promise<z.output<z.ZodObject<Out>>>;
  render(output: z.output<z.ZodObject<Out>>): string;
}

/** Identity function that exists for type inference. */
export function defineTool<In extends z.ZodRawShape, Out extends z.ZodRawShape>(
  definition: ToolDefinition<In, Out>,
): ToolDefinition<In, Out> {
  return definition;
}

/** Annotations shared by every tool that only reads. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
