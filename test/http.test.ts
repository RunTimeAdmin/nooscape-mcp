import { request, type IncomingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NooscapeClient } from "../src/client.js";
import { HEADERS_TIMEOUT_MS, MAX_CONNECTIONS, REQUEST_TIMEOUT_MS, isLoopback, startHttp } from "../src/http.js";
import { createNooscapeServer } from "../src/server.js";
import { AGENT } from "./fixtures.js";

const KEY = "nsk_" + "k".repeat(40);

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map(close => close()));
});

async function start(host = "127.0.0.1", token?: string) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(AGENT), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const api = new NooscapeClient({ userAgent: "nooscape-mcp/test", fetch: fetchImpl, apiKey: KEY });
  const http = await startHttp({ port: 0, host, makeServer: () => createNooscapeServer(api), token });
  running.push(http.close);
  return { http, url: `http://127.0.0.1:${http.port}/mcp`, fetchImpl };
}

/** A raw request, so the Host header can be chosen. */
function raw(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: options.method ?? "POST", path: options.path ?? "/mcp", headers: options.headers }, res => {
      let body = "";
      res.on("data", chunk => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const jsonHeaders = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });

describe("the Streamable HTTP mode", () => {
  it("serves the five tools to a real MCP client, and a tool call reaches the API", async () => {
    const { url, fetchImpl } = await start();
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(["check", "get_agent", "get_agent_history", "get_stats", "search_agents"]);
    const result = (await client.callTool({ name: "get_agent", arguments: { chain: "robinhood", id: "8865" } })) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("Agent #8865");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("keeps no session between requests", async () => {
    const { http } = await start();
    const a = await raw(http.port, { headers: jsonHeaders({ host: `127.0.0.1:${http.port}` }), body: rpc });
    const b = await raw(http.port, { headers: jsonHeaders({ host: `127.0.0.1:${http.port}` }), body: rpc });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(JSON.parse(a.body).result.tools).toHaveLength(5);
  });

  it("answers only POST to /mcp: a GET is 405 with what is allowed, anything else is 404", async () => {
    const { http } = await start();
    const get = await raw(http.port, { method: "GET", headers: { host: `127.0.0.1:${http.port}` } });
    expect(get.status).toBe(405);
    const other = await raw(http.port, { path: "/", headers: jsonHeaders({ host: `127.0.0.1:${http.port}` }), body: rpc });
    expect(other.status).toBe(404);
    const deep = await raw(http.port, { path: "/mcp/extra", headers: jsonHeaders({ host: `127.0.0.1:${http.port}` }), body: rpc });
    expect(deep.status).toBe(404);
  });

  it("refuses a request that carries an Origin header, which is what a web page sends", async () => {
    const { http } = await start();
    const result = await raw(http.port, { headers: jsonHeaders({ host: `127.0.0.1:${http.port}`, origin: "https://evil.example" }), body: rpc });
    expect(result.status).toBe(403);
    expect(result.body).toContain("Origin");
  });

  it("refuses a Host header that is not its own address (DNS rebinding)", async () => {
    const { http } = await start();
    for (const host of ["evil.example", `evil.example:${http.port}`, "127.0.0.1:1", "localhost"]) {
      const result = await raw(http.port, { headers: jsonHeaders({ host }), body: rpc });
      expect(result.status, host).toBe(403);
    }
    const local = await raw(http.port, { headers: jsonHeaders({ host: `localhost:${http.port}` }), body: rpc });
    expect(local.status).toBe(200);
  });

  it("refuses a body that is not JSON, and one that is too large", async () => {
    const { http } = await start();
    const headers = jsonHeaders({ host: `127.0.0.1:${http.port}` });
    const broken = await raw(http.port, { headers, body: "{ nope" });
    expect(broken.status).toBe(400);
    expect(JSON.parse(broken.body).error.code).toBe(-32700);
    const huge = await raw(http.port, { headers, body: JSON.stringify({ pad: "x".repeat(1_100_000) }) });
    expect(huge.status).toBe(413);
  });

  it("does not put the key in anything it answers", async () => {
    const { http } = await start();
    const headers = jsonHeaders({ host: `127.0.0.1:${http.port}` });
    const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_agent", arguments: { chain: "robinhood", id: "8865" } } });
    const answers = [await raw(http.port, { headers, body: call }), await raw(http.port, { headers, body: rpc }), await raw(http.port, { method: "GET", headers })];
    for (const answer of answers) expect(answer.body).not.toContain(KEY);
  });

  it("listens on this machine only unless it is told otherwise", async () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.5")).toBe(false);
    const { http } = await start();
    expect((http.server.address() as { address: string }).address).toBe("127.0.0.1");
  });
});

describe("the limits on a caller", () => {
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const open = (port: number) => new Promise<Socket>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => resolve(socket));
    socket.once("error", reject);
  });

  it("gives a request a short time to arrive, with Node's own defaults far looser", async () => {
    const { http } = await start();
    expect(http.server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(http.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    expect(HEADERS_TIMEOUT_MS).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("holds a bounded number of connections: one over the cap is dropped, and one is accepted again when a place is freed", async () => {
    const { http } = await start();
    expect(http.server.maxConnections).toBe(MAX_CONNECTIONS);
    const held = await Promise.all(Array.from({ length: MAX_CONNECTIONS }, () => open(http.port)));
    try {
      // The server counts a connection when it accepts it, a moment after the caller sees it open.
      for (let tries = 0; tries < 100; tries += 1) {
        const count = await new Promise<number>(resolve => http.server.getConnections((_error, number) => resolve(number)));
        if (count >= MAX_CONNECTIONS) break;
        await pause(20);
      }
      const headers = jsonHeaders({ host: `127.0.0.1:${http.port}` });
      await expect(raw(http.port, { headers, body: rpc })).rejects.toThrow();
      held.pop()!.destroy();
      let status = 0;
      for (let tries = 0; status !== 200 && tries < 100; tries += 1) {
        status = await raw(http.port, { headers, body: rpc }).then(result => result.status, () => 0);
        if (status !== 200) await pause(20);
      }
      expect(status).toBe(200);
    } finally {
      for (const socket of held) socket.destroy();
    }
  });
});

describe("the shared token", () => {
  const TOKEN = "s".repeat(32);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it("turns away a request that does not carry it, whatever it asks for, and says how to sign in", async () => {
    const { http } = await start("127.0.0.1", TOKEN);
    const host = `127.0.0.1:${http.port}`;
    const wrong = [{}, bearer("wrong"), bearer(TOKEN.slice(0, -1)), bearer(`${TOKEN}x`), bearer(""), { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` }];
    for (const extra of wrong) {
      const result = await raw(http.port, { headers: jsonHeaders({ host, ...extra }), body: rpc });
      expect(result.status, JSON.stringify(extra)).toBe(401);
      expect(result.headers["www-authenticate"]).toBe('Bearer realm="nooscape-mcp"');
      expect(JSON.parse(result.body).error.code).toBe(-32000);
    }
    // The token comes before the path and the method, so a caller without it cannot tell a real path from a made up one.
    expect((await raw(http.port, { path: "/", headers: jsonHeaders({ host }), body: rpc })).status).toBe(401);
    expect((await raw(http.port, { path: "/mcp/extra", headers: jsonHeaders({ host }), body: rpc })).status).toBe(401);
    expect((await raw(http.port, { method: "GET", headers: { host } })).status).toBe(401);
  });

  it("serves a request that carries it, however the scheme is written", async () => {
    const { http, fetchImpl } = await start("127.0.0.1", TOKEN);
    const host = `127.0.0.1:${http.port}`;
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      const result = await raw(http.port, { headers: jsonHeaders({ host, authorization: `${scheme} ${TOKEN}` }), body: rpc });
      expect(result.status, scheme).toBe(200);
      expect(JSON.parse(result.body).result.tools).toHaveLength(5);
    }
    const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_agent", arguments: { chain: "robinhood", id: "8865" } } });
    expect((await raw(http.port, { headers: jsonHeaders({ host, ...bearer(TOKEN) }), body: call })).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is sent by a real MCP client that was given it, and without it that client cannot connect", async () => {
    const { url } = await start("127.0.0.1", TOKEN);
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: bearer(TOKEN) } }));
    expect((await client.listTools()).tools).toHaveLength(5);
    await client.close();
    const stranger = new Client({ name: "http-test", version: "1.0.0" });
    await expect(stranger.connect(new StreamableHTTPClientTransport(new URL(url)))).rejects.toThrow();
  });

  it("keeps the Origin check on this machine ahead of it, so a web page is refused even with the token", async () => {
    const { http } = await start("127.0.0.1", TOKEN);
    const result = await raw(http.port, { headers: jsonHeaders({ host: `127.0.0.1:${http.port}`, origin: "https://evil.example", ...bearer(TOKEN) }), body: rpc });
    expect(result.status).toBe(403);
  });

  it("is not in anything it answers, and the key is not either", async () => {
    const { http } = await start("127.0.0.1", TOKEN);
    const host = `127.0.0.1:${http.port}`;
    const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_agent", arguments: { chain: "robinhood", id: "8865" } } });
    const answers = [await raw(http.port, { headers: jsonHeaders({ host }), body: rpc }), await raw(http.port, { headers: jsonHeaders({ host, ...bearer(TOKEN) }), body: call }), await raw(http.port, { headers: jsonHeaders({ host, ...bearer("wrong") }), body: rpc })];
    for (const answer of answers) {
      expect(answer.body).not.toContain(TOKEN);
      expect(answer.body).not.toContain(KEY);
      expect(JSON.stringify(answer.headers)).not.toContain(TOKEN);
    }
  });
});
