import { describe, expect, it } from "vitest";
import {
  assertPublicHost,
  displayMediaType,
  isPrivateAddress,
  pinnedLookup,
} from "./address-guard.js";

describe("address guard", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::FFFF:A9FE:A9FE",
    "::127.0.0.1",
    "::a00:1",
    "not-an-ip",
  ])("treats %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "93.184.216.34",
    "172.32.0.1",
    "2606:2800:220:1:248:1893:25c8:1946",
    "::ffff:5db8:d822",
  ])("treats %s as public", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it("refuses loopback names, private literals, and names resolving to private addresses", async () => {
    await expect(assertPublicHost("localhost", async () => [])).rejects.toThrow("loopback");
    await expect(assertPublicHost("127.0.0.1", async () => [])).rejects.toThrow("private");
    await expect(assertPublicHost("[::1]", async () => [])).rejects.toThrow("private");
    await expect(
      assertPublicHost("objects.example.test", async () => ["93.184.216.34", "10.0.0.5"]),
    ).rejects.toThrow("private");
    await expect(assertPublicHost("nowhere.example.test", async () => [])).rejects.toThrow(
      "does not resolve",
    );
    await expect(
      assertPublicHost("objects.example.test", async () => ["93.184.216.34"]),
    ).resolves.toEqual(["93.184.216.34"]);
  });

  it("pins a connection's lookup to the validated address in both answer shapes", () => {
    const answers: unknown[][] = [];
    const record = (...answer: unknown[]) => answers.push(answer);
    pinnedLookup("93.184.216.34")("objects.example.test", {}, record);
    pinnedLookup("2606:2800::1")("objects.example.test", { all: true }, record);
    expect(answers).toEqual([
      [null, "93.184.216.34", 4],
      [null, [{ address: "2606:2800::1", family: 6 }]],
    ]);
  });

  it("shows only a bare, well-formed media type", () => {
    expect(displayMediaType('image/jpeg; source="https://secret.example/x?sig=1"')).toBe(
      "image/jpeg",
    );
    expect(displayMediaType("Video/MP4")).toBe("video/mp4");
    expect(displayMediaType("not a type")).toBeUndefined();
    expect(displayMediaType(null)).toBeUndefined();
  });
});
