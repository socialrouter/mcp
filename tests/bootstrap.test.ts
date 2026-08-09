import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { bootstrap, DEFAULT_BASE_URL, fail, readVersion, resolveBaseUrl } from "../src/bootstrap.js";
import { RAW_CATALOG } from "./fixtures.js";

/**
 * The startup path: the only code that can stop the server from existing at
 * all, and the only failure a user sees before any tool is callable.
 */

const PKG_URL = new URL("../package.json", import.meta.url);
const PKG = JSON.parse(readFileSync(PKG_URL, "utf8")) as {
  version: string;
  bin: Record<string, string>;
};

/** URL of a module living where the built entry point does. */
const ENTRY_URL = pathToFileURL(new URL("../src/bootstrap.ts", import.meta.url).pathname).href;

let urls: string[];

function stubFetch(handler: (url: string) => Response | Promise<Response> = catalogue) {
  vi.stubGlobal("fetch", (url: string) => {
    urls.push(url);
    return Promise.resolve(handler(url));
  });
}

const catalogue = () => new Response(JSON.stringify({ data: RAW_CATALOG }), { status: 200 });

describe("bootstrap", () => {
  beforeEach(() => {
    urls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refuses to start without an API key", async () => {
    stubFetch();
    await expect(bootstrap({}, ENTRY_URL)).rejects.toThrow(
      "SOCIALROUTER_API_KEY environment variable is required",
    );
    // The key is checked before anything is spent or reached for.
    expect(urls).toEqual([]);
  });

  it("refuses to start when the catalogue cannot be loaded", async () => {
    // A server that boots without a catalogue would advertise no service and
    // reject every call — better to die with a message naming the host.
    stubFetch(() => new Response("nope", { status: 503 }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      bootstrap({ SOCIALROUTER_API_KEY: "sr_test", SOCIALROUTER_BASE_URL: "https://api.test" }, ENTRY_URL),
    ).rejects.toThrow(/could not load the service catalog from https:\/\/api\.test/);
  });

  it("boots against the production API by default", async () => {
    stubFetch();
    await bootstrap({ SOCIALROUTER_API_KEY: "sr_test" }, ENTRY_URL);
    expect(urls).toEqual([`${DEFAULT_BASE_URL}/v1/services`]);
  });

  it("strips a trailing slash from the configured base URL", async () => {
    // "https://api.test/" + "/v1/services" would request a double slash, which
    // some hosts 404 outright.
    stubFetch();
    await bootstrap(
      { SOCIALROUTER_API_KEY: "sr_test", SOCIALROUTER_BASE_URL: "https://api.test/" },
      ENTRY_URL,
    );
    expect(urls).toEqual(["https://api.test/v1/services"]);
  });

  it("resolves the base URL from the environment, slash or not", () => {
    expect(resolveBaseUrl({})).toBe(DEFAULT_BASE_URL);
    expect(resolveBaseUrl({ SOCIALROUTER_BASE_URL: "http://localhost:3000/" })).toBe(
      "http://localhost:3000",
    );
    expect(resolveBaseUrl({ SOCIALROUTER_BASE_URL: "http://localhost:3000" })).toBe(
      "http://localhost:3000",
    );
  });

  it("hands the server the key and the mcp client tag", async () => {
    // Attribution and auth both come from here; a bootstrap that dropped
    // either would still list services and only fail on the first run.
    const headers: Record<string, string>[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
      urls.push(url);
      headers.push((init.headers ?? {}) as Record<string, string>);
      return Promise.resolve(
        url.includes("/v1/account/")
          ? new Response(JSON.stringify({ balance: 1, currency: "USD" }), { status: 200 })
          : catalogue(),
      );
    });

    const server = await bootstrap(
      { SOCIALROUTER_API_KEY: "sr_live_key", SOCIALROUTER_BASE_URL: "https://api.test" },
      ENTRY_URL,
    );
    const client = new Client({ name: "test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: "get_account", arguments: {} });

    const authed = headers.find((h) => h.Authorization);
    expect(authed?.Authorization).toBe("Bearer sr_live_key");
    expect(authed?.["X-SocialRouter-Client"]).toBe("mcp");
  });

  it("advertises the published version at handshake", async () => {
    stubFetch();
    const server = await bootstrap({ SOCIALROUTER_API_KEY: "sr_test" }, ENTRY_URL);
    const client = new Client({ name: "test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    expect(client.getServerVersion()).toMatchObject({
      name: "socialrouter",
      version: PKG.version,
    });
  });

  /*
   * The version is read as `../package.json` relative to the entry module, so
   * it only works while the entry sits exactly one level under the package
   * root. Get that wrong and the binary throws ENOENT on launch, for every
   * user, before a single tool is listed.
   *
   * This pins the half that is declared rather than built: `bin` must point
   * one level down. Moving the entry deeper (a `rootDir` change emitting
   * `dist/src/index.js`) forces `bin` to follow, and that is what fails here.
   * Moving it and *not* updating `bin` breaks the package outright and is
   * caught by launching it, not by this.
   */
  it("keeps package.json one level above the published bin", () => {
    const binPath = new URL(`../${Object.values(PKG.bin)[0]}`, import.meta.url).pathname;
    expect(readVersion(pathToFileURL(binPath).href)).toBe(PKG.version);
  });

  it("reports a fatal startup problem on stderr and exits 1", () => {
    // The host (Claude Desktop, an IDE) shows stderr and reads the code; a
    // zero exit would read as a clean shutdown.
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    fail("boom");

    expect(stderr).toHaveBeenCalledWith("boom");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
