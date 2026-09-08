import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createPdfExecutorApp } from "../../executor-pdf/src/app.js";
import { createVideoExecutorApp } from "../../executor-video/src/app.js";
import { createControlApp } from "./app.js";

const control = createControlApp({
  logger: { emit() {}, async shutdown() {} },
  originAuthToken: () => undefined,
  imgproxyConfig: () => undefined,
  fetch,
});
const services = [control, createVideoExecutorApp(), createPdfExecutorApp()];

describe("shared service favicons", () => {
  it("advertises the SVG on admin pages and permits it through CSP", async () => {
    const page = await control.request("/admin");
    expect(page.headers.get("content-security-policy")).toContain("img-src 'self'");
    expect(await page.text()).toContain(
      '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    );
  });

  it("serves the canonical SVG and ICO without service credentials", async () => {
    const svg = await readFile(new URL("../../../assets/favicon.svg", import.meta.url), "utf8");
    const ico = await readFile(new URL("../../../assets/favicon.ico", import.meta.url));
    for (const app of services) {
      const vector = await app.request("/favicon.svg");
      expect(vector.status).toBe(200);
      expect(vector.headers.get("content-type")).toBe("image/svg+xml");
      expect(await vector.text()).toBe(svg);
      const fallback = await app.request("/favicon.ico");
      expect(fallback.status).toBe(200);
      expect(fallback.headers.get("content-type")).toBe("image/x-icon");
      expect(new Uint8Array(await fallback.arrayBuffer())).toEqual(new Uint8Array(ico));
      expect([...ico.subarray(0, 6)]).toEqual([0, 0, 1, 0, 3, 0]);
      const head = await app.request("/favicon.svg", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }
  });
});
