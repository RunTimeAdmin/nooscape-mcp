#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NooscapeClient } from "./client.js";
import { isLoopback, startHttp } from "./http.js";
import { createNooscapeServer } from "./server.js";
import { VERSION } from "./version.js";

export const USAGE = `nooscape-mcp ${VERSION}

An MCP server for Nooscape: what is on record about an AI agent, a wallet or an endpoint, with dates.
It reads the public Nooscape API (https://nooscape.si/api/v1) and nothing else.

Usage:
  nooscape-mcp                      Serve over stdio (Claude Desktop, Cursor, and other MCP clients).
  nooscape-mcp --http [options]     Serve over Streamable HTTP at /mcp instead (stateless; no sign-in unless NOOSCAPE_MCP_TOKEN is set).

Options for --http:
  --port <number>    Port to listen on. Default 8787.
  --host <address>   Address to bind. Default 127.0.0.1 (this machine only).
  --allow-remote     Allow a --host that is not this machine. It also needs NOOSCAPE_MCP_TOKEN, and something in
                     front of it that adds TLS, because the token is sent in the clear otherwise.

Environment:
  NOOSCAPE_API_KEY   Optional. An API key, sent as a bearer token. A free key unlocks get_agent_history;
                     the check needs a Pro key. Never logged or echoed.
  NOOSCAPE_MCP_TOKEN For --http only. A secret of at least 24 characters that every caller must send as
                     "Authorization: Bearer <secret>". Needed with --allow-remote, optional on this machine.
                     Never logged or echoed. Make one with: openssl rand -hex 24

Other:
  --help, -h         Show this help.
  --version, -v      Show the version.
`;

export type Parsed = { mode: "stdio" } | { mode: "http"; port: number; host: string; allowRemote?: boolean } | { mode: "help" } | { mode: "version" } | { mode: "error"; message: string };

export function parseArgs(argv: string[]): Parsed {
  let http = false;
  let port = 8787;
  let host = "127.0.0.1";
  let allowRemote = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") return { mode: "help" };
    if (arg === "--version" || arg === "-v") return { mode: "version" };
    if (arg === "--http") {
      http = true;
    } else if (arg === "--allow-remote") {
      allowRemote = true;
    } else if (arg === "--port" || arg === "--host") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { mode: "error", message: `${arg} needs a value.` };
      index += 1;
      if (arg === "--host") {
        host = value;
      } else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return { mode: "error", message: "--port must be a whole number from 0 to 65535." };
        port = parsed;
      }
    } else {
      return { mode: "error", message: `Unknown option ${arg}.` };
    }
  }
  if (!http && (argv.includes("--port") || argv.includes("--host") || allowRemote)) return { mode: "error", message: "--port, --host and --allow-remote belong with --http." };
  return http ? { mode: "http", port, host, ...(allowRemote ? { allowRemote } : {}) } : { mode: "stdio" };
}

/**
 * A secret from the environment, or undefined. An empty value is none, and so is a placeholder that a host passed through unfilled
 * (a bundle's `${user_config.api_key}` for a setting the user left blank).
 */
const secretIn = (value: string | undefined): string | undefined => {
  const raw = value?.trim();
  return raw && !raw.startsWith("${") ? raw : undefined;
};

/** The API key from the environment, or undefined. */
export function keyFrom(env: NodeJS.ProcessEnv): string | undefined {
  return secretIn(env.NOOSCAPE_API_KEY);
}

/** The HTTP mode's shared secret from the environment, or undefined. */
export function tokenFrom(env: NodeJS.ProcessEnv): string | undefined {
  return secretIn(env.NOOSCAPE_MCP_TOKEN);
}

export const MIN_TOKEN_LENGTH = 24;

/**
 * Why the HTTP mode may not start with these settings, or null. A secret that is set must be long enough wherever it is used. An address
 * that is not this machine needs the flag and a secret, because anyone who can reach it would use the server's one API key.
 */
export function httpRefusal(host: string, allowRemote: boolean, token: string | undefined): string | null {
  if (token !== undefined && token.length < MIN_TOKEN_LENGTH) return `NOOSCAPE_MCP_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters. Make a longer one, for example with: openssl rand -hex 24`;
  if (isLoopback(host) || (allowRemote && token !== undefined)) return null;
  return `Without a shared secret the HTTP mode has no sign-in, so it listens on this machine only, and ${host} is not this machine. To listen on it anyway, add --allow-remote and set NOOSCAPE_MCP_TOKEN to a secret of at least ${MIN_TOKEN_LENGTH} characters, which every caller then sends as "Authorization: Bearer <secret>". Make one with: openssl rand -hex 24. Put TLS in front of it.`;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.mode === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.mode === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.mode === "error") {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`);
    return 2;
  }

  const client = new NooscapeClient({ apiKey: keyFrom(env), userAgent: `nooscape-mcp/${VERSION}` });

  if (parsed.mode === "http") {
    const token = tokenFrom(env);
    const refusal = httpRefusal(parsed.host, parsed.allowRemote === true, token);
    if (refusal !== null) {
      process.stderr.write(`${refusal}\n`);
      return 2;
    }
    if (!isLoopback(parsed.host)) process.stderr.write("Warning: this address is not local. Everyone who has the token uses this server's API key, and the token is sent in the clear unless something in front of this adds TLS.\n");
    const running = await startHttp({ port: parsed.port, host: parsed.host, makeServer: () => createNooscapeServer(client), token });
    process.stderr.write(`nooscape-mcp ${VERSION} listening on http://${parsed.host}:${running.port}/mcp\n`);
    await new Promise<void>(done => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
    await running.close();
    return 0;
  }

  // stdout belongs to the protocol in this mode: everything else goes to stderr.
  const server = createNooscapeServer(client);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`nooscape-mcp ${VERSION} running on stdio${client.hasKey ? " (with an API key)" : ""}\n`);
  await new Promise<void>(done => {
    process.stdin.once("end", done);
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await server.close();
  return 0;
}

/** True when this file is the program being run (also through the symlink npx makes), and not when a test imports it. */
function isMain(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2), process.env).then(
    code => process.exit(code),
    () => {
      process.stderr.write("nooscape-mcp stopped because of an unexpected error.\n");
      process.exit(1);
    },
  );
}
