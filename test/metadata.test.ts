import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { NooscapeClient } from "../src/client.js";
import { createNooscapeServer } from "../src/server.js";
import { VERSION } from "../src/version.js";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const serverJson = JSON.parse(read("server.json"));
const manifest = JSON.parse(read("manifest.json"));
const readme = read("README.md");

describe("the files a registry reads", () => {
  it("agree on the name and the version", () => {
    expect(pkg.version).toBe(VERSION);
    expect(serverJson.version).toBe(pkg.version);
    expect(serverJson.packages[0].version).toBe(pkg.version);
    expect(serverJson.packages[0].identifier).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.name).toBe(pkg.name);
    expect(serverJson.name).toBe(pkg.mcpName);
    expect(manifest.license).toBe(pkg.license);
  });

  it("fit the registry's limits and say the key is optional and secret", () => {
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
    const key = serverJson.packages[0].environmentVariables.find((item: { name: string }) => item.name === "NOOSCAPE_API_KEY");
    expect(key).toMatchObject({ isRequired: false, isSecret: true });
    expect(serverJson.packages[0].transport.type).toBe("stdio");
    expect(manifest.user_config.api_key).toMatchObject({ sensitive: true, required: false });
    expect(manifest.server.mcp_config.env.NOOSCAPE_API_KEY).toBe("${user_config.api_key}");
  });

  it("leave the tools out of the manifest and say they are generated, so Smithery's publish accepts the bundle", async () => {
    // Smithery copies a manifest's tools into a server card in which every tool needs an inputSchema, and an MCPB manifest cannot hold one
    // (the official validator refuses the key). So the tools are not listed here, and the server tells a client what it has with tools/list.
    expect(manifest.tools).toBeUndefined();
    expect(manifest.tools_generated).toBe(true);
    const server = createNooscapeServer(new NooscapeClient({ userAgent: "test" }));
    const client = new Client({ name: "t", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const real = (await client.listTools()).tools.map(tool => tool.name).sort();
    await client.close();
    for (const name of real) expect(readme).toContain(name);
  });

  it("build with LF line endings, so the shebang line of the program works on Linux and macOS when it is built on Windows", () => {
    expect(read("tsconfig.json")).toContain('"newLine": "lf"');
  });

  it("publish only what they should: the build, the manifests, the readme and the license", () => {
    expect(pkg.files.slice().sort()).toEqual(["LICENSE", "README.md", "dist", "manifest.json", "server.json"]);
    expect(pkg.bin["nooscape-mcp"]).toBe("dist/cli.js");
    expect(manifest.server.entry_point).toBe("dist/cli.js");
  });
});

describe("what the readme promises", () => {
  it("says there is no wallet, no payment made, and where a key comes from", () => {
    expect(readme).toContain("holds no wallet and does not sign or send payments");
    expect(readme).toContain("NOOSCAPE_API_KEY");
    expect(readme).toContain("nooscape.si/developers/keys");
  });

  it("carries the no paid influence line and the data attribution", () => {
    expect(readme).toContain("Nothing a caller pays buys a listing, a tier or an evidence level.");
    expect(readme).toContain("Data from Nooscape (https://nooscape.si).");
    expect(readme).toContain("nooscape.si/terms");
  });

  it("gives install snippets for Claude Desktop and Cursor with npx", () => {
    expect(readme).toContain("### Claude Desktop");
    expect(readme).toContain("### Cursor");
    expect(readme.match(/"args": \["-y", "nooscape-mcp"\]/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("says the package is on npm and in the official registry, and does not say it is unpublished", () => {
    expect(readme).toContain("The package is on npm and in the official MCP registry");
    expect(readme).not.toContain("has not been published");
  });

  it("shows how to stay on one release, with the release that is current", () => {
    expect(readme).toContain(`nooscape-mcp@${pkg.version}`);
  });

  it("uses no long dashes", () => {
    for (const text of [readme, JSON.stringify(serverJson), JSON.stringify(manifest)]) expect(text).not.toMatch(/[–—]/);
  });
});
