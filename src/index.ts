#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createConfig, loadConfigFile } from "./config.js";
import { SERVER_INFO, createServer } from "./server.js";
import { serveHttp } from "./transports/http.js";
import { serveStdio } from "./transports/stdio.js";

const USAGE = `Usage: mcp-repo-tools [options]

Serve a local git repository to MCP clients, read-only by default.

Options:
  --repo <path>        Repository to serve (default: current directory)
  --config <file>      JSON config file (path policy, limits, test targets)
  --allow-run-tests    Enable the run_tests tool (needs targets in --config)
  --transport <kind>   stdio (default) or http
  --host <host>        HTTP bind address (default: 127.0.0.1)
  --port <port>        HTTP port (default: 3333)
  --help               Show this help
  --version            Show the version

Environment:
  MCP_REPO_TOOLS_TOKEN  If set, HTTP requests must send "Authorization: Bearer <token>"
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", default: process.cwd() },
      config: { type: "string" },
      "allow-run-tests": { type: "boolean", default: false },
      transport: { type: "string", default: "stdio" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "3333" },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.version) {
    process.stdout.write(`${SERVER_INFO.version}\n`);
    return;
  }

  const config = await createConfig({
    repo: values.repo,
    allowRunTests: values["allow-run-tests"],
    ...(values.config === undefined ? {} : { file: await loadConfigFile(values.config) }),
  });
  if (config.runTests.enabled && Object.keys(config.runTests.targets).length === 0) {
    console.error("[mcp-repo-tools] --allow-run-tests has no effect: no targets in --config.");
  }

  switch (values.transport) {
    case "stdio": {
      await serveStdio(createServer(config));
      console.error(`[mcp-repo-tools] serving ${config.repoRoot} over stdio`);
      break;
    }
    case "http": {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error(`Invalid port: ${values.port}`);
      }
      const http = await serveHttp({
        host: values.host,
        port,
        authToken: process.env["MCP_REPO_TOOLS_TOKEN"] || undefined,
        createServer: () => createServer(config),
      });
      console.error(`[mcp-repo-tools] serving ${config.repoRoot} at ${http.url}`);
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => void http.close().then(() => process.exit(0)));
      }
      break;
    }
    default:
      throw new Error(`Unknown transport: ${values.transport} (expected stdio or http)`);
  }
}

main().catch((error: unknown) => {
  console.error(`[mcp-repo-tools] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
