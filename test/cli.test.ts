import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_TOKEN_LENGTH, USAGE, httpRefusal, keyFrom, main, parseArgs, tokenFrom } from "../src/cli.js";
import { VERSION } from "../src/version.js";

afterEach(() => vi.restoreAllMocks());

describe("the command line", () => {
  it("serves over stdio by default", () => {
    expect(parseArgs([])).toEqual({ mode: "stdio" });
  });

  it("serves over HTTP behind a flag, on this machine by default", () => {
    expect(parseArgs(["--http"])).toEqual({ mode: "http", port: 8787, host: "127.0.0.1" });
    expect(parseArgs(["--http", "--port", "0"])).toEqual({ mode: "http", port: 0, host: "127.0.0.1" });
    expect(parseArgs(["--http", "--port", "9000", "--host", "0.0.0.0"])).toEqual({ mode: "http", port: 9000, host: "0.0.0.0" });
    expect(parseArgs(["--http", "--host", "0.0.0.0", "--allow-remote"])).toEqual({ mode: "http", port: 8787, host: "0.0.0.0", allowRemote: true });
  });

  it("will not listen on an address that is not this machine unless it is told to, and says why", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const host of ["0.0.0.0", "192.168.1.20", "::", "nooscape.example"]) {
      expect(await main(["--http", "--host", host], {}), host).toBe(2);
    }
    expect(out).not.toHaveBeenCalled();
    const said = err.mock.calls.map(call => String(call[0]));
    expect(said).toHaveLength(4);
    for (const line of said) {
      expect(line).toContain("--allow-remote");
      expect(line).toContain("no sign-in");
      expect(line).toContain("NOOSCAPE_MCP_TOKEN");
    }
  });

  it("will not listen off this machine with the flag alone: it also needs a token that is long enough", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const short = "x".repeat(MIN_TOKEN_LENGTH - 1);
    expect(await main(["--http", "--host", "0.0.0.0", "--allow-remote"], {})).toBe(2);
    expect(await main(["--http", "--host", "0.0.0.0", "--allow-remote"], { NOOSCAPE_MCP_TOKEN: "   " })).toBe(2);
    expect(await main(["--http", "--host", "0.0.0.0", "--allow-remote"], { NOOSCAPE_MCP_TOKEN: short })).toBe(2);
    // A token that is set must be long enough on this machine too, so a weak one is never used quietly.
    expect(await main(["--http"], { NOOSCAPE_MCP_TOKEN: short })).toBe(2);
    expect(out).not.toHaveBeenCalled();
    const said = err.mock.calls.map(call => String(call[0]));
    expect(said).toHaveLength(4);
    for (const line of said) expect(line).toContain("NOOSCAPE_MCP_TOKEN");
    expect(said.join("")).not.toContain(short);
  });

  it("decides what the HTTP mode may do from the address, the flag and the token", () => {
    const token = "t".repeat(MIN_TOKEN_LENGTH);
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(httpRefusal(host, false, undefined), host).toBeNull();
      expect(httpRefusal(host, false, token), host).toBeNull();
      expect(httpRefusal(host, true, token), host).toBeNull();
    }
    for (const host of ["0.0.0.0", "192.168.1.20", "::", "nooscape.example"]) {
      expect(httpRefusal(host, false, undefined), host).toContain("--allow-remote");
      expect(httpRefusal(host, true, undefined), host).toContain("NOOSCAPE_MCP_TOKEN");
      expect(httpRefusal(host, false, token), host).toContain("--allow-remote");
      expect(httpRefusal(host, true, token), host).toBeNull();
    }
    expect(httpRefusal("127.0.0.1", false, "x".repeat(MIN_TOKEN_LENGTH - 1))).toContain(`shorter than ${MIN_TOKEN_LENGTH}`);
    expect(httpRefusal("0.0.0.0", true, "x".repeat(MIN_TOKEN_LENGTH - 1))).toContain(`shorter than ${MIN_TOKEN_LENGTH}`);
  });

  it("starts the HTTP mode with the token, so a caller without it is turned away", async () => {
    const token = "t".repeat(MIN_TOKEN_LENGTH);
    const told: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      told.push(String(chunk));
      return true;
    });
    const before = new Set<unknown>([...process.rawListeners("SIGINT"), ...process.rawListeners("SIGTERM")]);
    const finished = main(["--http", "--port", "0"], { NOOSCAPE_MCP_TOKEN: token });
    let port = 0;
    for (let tries = 0; port === 0 && tries < 100; tries += 1) {
      port = Number(/listening on http:\/\/127\.0\.0\.1:([0-9]+)\/mcp/.exec(told.join(""))?.[1] ?? 0);
      if (port === 0) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(port).toBeGreaterThan(0);
    const call = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    try {
      expect((await call({})).status).toBe(401);
      expect((await call({ authorization: "Bearer not-the-token" })).status).toBe(401);
      expect((await call({ authorization: `Bearer ${token}` })).status).toBe(200);
    } finally {
      // The program waits for a signal. Run the listeners it added and none of the test runner's own.
      for (const name of ["SIGINT", "SIGTERM"] as const) for (const listener of process.rawListeners(name)) if (!before.has(listener)) (listener as () => void)();
    }
    expect(await finished).toBe(0);
    expect(told.join("")).not.toContain(token);
  });

  it("refuses what it does not know, and a port or host without the HTTP flag", () => {
    for (const args of [["--nope"], ["--http", "--port"], ["--http", "--port", "abc"], ["--http", "--port", "70000"], ["--http", "--port", "1.5"], ["--http", "--host"], ["--port", "80"], ["--host", "x"], ["--allow-remote"], ["extra"]]) {
      expect(parseArgs(args).mode, args.join(" ")).toBe("error");
    }
  });

  it("answers help and version", () => {
    expect(parseArgs(["--help"])).toEqual({ mode: "help" });
    expect(parseArgs(["-h"])).toEqual({ mode: "help" });
    expect(parseArgs(["--version"])).toEqual({ mode: "version" });
    expect(parseArgs(["-v"])).toEqual({ mode: "version" });
  });

  it("prints the help and the version to stdout and exits 0", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["--help"], {})).toBe(0);
    expect(await main(["--version"], {})).toBe(0);
    expect(write.mock.calls.map(call => String(call[0])).join("")).toContain(USAGE);
    expect(write.mock.calls.map(call => String(call[0])).join("")).toContain(`${VERSION}\n`);
  });

  it("explains a mistake on stderr and exits 2, with nothing on stdout", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["--bogus"], {})).toBe(2);
    expect(out).not.toHaveBeenCalled();
    expect(String(err.mock.calls[0]![0])).toContain("Unknown option --bogus.");
  });

  it("says how the key is given, and that it is never echoed", () => {
    expect(USAGE).toContain("NOOSCAPE_API_KEY");
    expect(USAGE).toContain("Never logged or echoed");
    expect(USAGE).toContain("--http");
    expect(USAGE).toContain("--allow-remote");
    expect(USAGE).toContain("NOOSCAPE_MCP_TOKEN");
    expect(USAGE).toContain(`at least ${MIN_TOKEN_LENGTH} characters`);
  });

  it("reads the key from NOOSCAPE_API_KEY, and treats empty or an unfilled placeholder as no key", () => {
    expect(keyFrom({ NOOSCAPE_API_KEY: "  nsk_abc  " })).toBe("nsk_abc");
    expect(keyFrom({})).toBeUndefined();
    expect(keyFrom({ NOOSCAPE_API_KEY: "" })).toBeUndefined();
    expect(keyFrom({ NOOSCAPE_API_KEY: "   " })).toBeUndefined();
    expect(keyFrom({ NOOSCAPE_API_KEY: "${user_config.api_key}" })).toBeUndefined();
  });

  it("reads the HTTP token from NOOSCAPE_MCP_TOKEN the same way, and never takes the API key for it", () => {
    expect(tokenFrom({ NOOSCAPE_MCP_TOKEN: "  abc  " })).toBe("abc");
    expect(tokenFrom({})).toBeUndefined();
    expect(tokenFrom({ NOOSCAPE_MCP_TOKEN: "" })).toBeUndefined();
    expect(tokenFrom({ NOOSCAPE_MCP_TOKEN: "   " })).toBeUndefined();
    expect(tokenFrom({ NOOSCAPE_MCP_TOKEN: "${user_config.token}" })).toBeUndefined();
    expect(tokenFrom({ NOOSCAPE_API_KEY: "nsk_abc" })).toBeUndefined();
    expect(keyFrom({ NOOSCAPE_MCP_TOKEN: "abc" })).toBeUndefined();
  });

  it("reports the version from package.json", () => {
    expect(VERSION).toMatch(/^[0-9]+[.][0-9]+[.][0-9]+/);
  });
});
