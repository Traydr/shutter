import { SELF } from "cloudflare:test";
import { faviconIcoResponse, faviconSvgResponse } from "@shutter/assets";
import { expect, it } from "vitest";

it("serves shared favicons from the Worker without origin authentication", async () => {
  const svg = await SELF.fetch("https://edge.test/favicon.svg");
  expect(svg.status).toBe(200);
  expect(svg.headers.get("content-type")).toBe("image/svg+xml");
  expect(await svg.text()).toBe(await faviconSvgResponse().text());
  const ico = await SELF.fetch("https://edge.test/favicon.ico");
  expect(ico.status).toBe(200);
  expect(ico.headers.get("content-type")).toBe("image/x-icon");
  expect(await ico.arrayBuffer()).toEqual(await faviconIcoResponse().arrayBuffer());
});
