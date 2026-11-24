import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PagesDeployRequest } from "../../common/pages-deploy";
import type { PagesFetch } from "../../electron-main/cloudflare-pages";
import { createTestPagesDeployIpcBridge } from "./pages-deploy-client";

const TOKEN = "cf-test-token-0123456789abcdef0123456789abcdef";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API = "https://api.test/client/v4";

/** A Cloudflare API stand-in; `gate` holds the deployment call open until released. */
function fakeApi(gate?: Promise<void>): { fetchImpl: PagesFetch; authHeaders: string[] } {
  const authHeaders: string[] = [];
  const ok = (result: unknown) =>
    new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  const jwt = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url")}.s`;
  const fetchImpl: PagesFetch = async (input, init) => {
    authHeaders.push(new Headers(init.headers).get("authorization") ?? "");
    const route = input.replace(API, "");
    if (route.endsWith("/upload-token")) return ok({ jwt });
    if (route === "/pages/assets/check-missing") return ok([]);
    if (route === "/pages/assets/upsert-hashes") return ok(true);
    if (route.endsWith("/deployments")) {
      await gate;
      return ok({ id: "dep", url: "https://abc123.wudc2027.pages.dev" });
    }
    return ok(null);
  };
  return { fetchImpl, authHeaders };
}

describe("IpcPagesDeployer over the in-memory bridge", () => {
  const tempDirs: string[] = [];

  function makeSiteDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-publish-site-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Site</title>");
    return dir;
  }

  function makeRequest(dir: string): PagesDeployRequest {
    return { dir, accountId: ACCOUNT_ID, projectName: "wudc2027", branch: "main" };
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a deploy request and reply; the token stays on the electron-main side", async () => {
    const api = fakeApi();
    const bridge = createTestPagesDeployIpcBridge({
      getToken: async () => TOKEN,
      fetchImpl: api.fetchImpl,
      apiBase: API,
      sleep: async () => undefined,
      timeoutMs: 5000,
    });

    try {
      const result = await bridge.deployer.deploy(makeRequest(makeSiteDir()));
      expect(result).toEqual({
        ok: true,
        deploymentUrl: "https://abc123.wudc2027.pages.dev",
        durationMs: expect.any(Number),
      });
      expect(bridge.sentRequests).toHaveLength(1);
      expect(bridge.sentRequests[0]?.req.projectName).toBe("wudc2027");
      expect(bridge.receivedReplies).toHaveLength(1);
      expect(api.authHeaders).toContain(`Bearer ${TOKEN}`);
      expect(JSON.stringify(bridge.sentRequests)).not.toContain(TOKEN);
      expect(JSON.stringify(bridge.receivedReplies)).not.toContain(TOKEN);
    } finally {
      bridge.dispose();
    }
  });

  it("rejects a second publish while one is already running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = createTestPagesDeployIpcBridge({
      getToken: async () => TOKEN,
      fetchImpl: fakeApi(gate).fetchImpl,
      apiBase: API,
      sleep: async () => undefined,
      timeoutMs: 5000,
    });

    try {
      const siteDir = makeSiteDir();
      const first = bridge.deployer.deploy(makeRequest(siteDir));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const second = await bridge.deployer.deploy(makeRequest(siteDir));
      expect(second).toMatchObject({ ok: false, kind: "DEPLOY_FAILED" });
      if (!second.ok) {
        expect(second.error).toMatch(/already running/i);
      }

      release();
      await expect(first).resolves.toMatchObject({ ok: true });
    } finally {
      bridge.dispose();
    }
  });

  it("reports an unavailable IPC channel instead of throwing", async () => {
    const bridge = createTestPagesDeployIpcBridge({
      getToken: async () => TOKEN,
      fetchImpl: fakeApi().fetchImpl,
      apiBase: API,
    });
    bridge.dispose();

    const result = await bridge.deployer.deploy(makeRequest(makeSiteDir()));
    expect(result).toMatchObject({ ok: false, kind: "DEPLOY_FAILED" });
    if (!result.ok) {
      expect(result.error).toMatch(/disposed/i);
    }
  });
});
