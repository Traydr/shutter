import { describe, expect, it } from "vitest";
import { createFailedJobRepresentation, parsePreviewJobSubmission } from "./jobs.js";

describe("job protocol", () => {
  it("locks failure actions", () => {
    expect(createFailedJobRepresentation("source_expired")).toEqual({
      status: "failed",
      failure: { code: "source_expired", action: "renew_capability" },
    });
    expect(createFailedJobRepresentation("attempts_exhausted")).toEqual({
      status: "failed",
      failure: { code: "attempts_exhausted", action: "retry" },
    });
  });

  it("accepts only the strict submission body", () => {
    expect(parsePreviewJobSubmission({ sourceCapability: "opaque" })).toEqual({
      sourceCapability: "opaque",
    });
    expect(() => parsePreviewJobSubmission({ sourceCapability: "opaque", extra: true })).toThrow();
    expect(() => parsePreviewJobSubmission({ sourceCapability: "" })).toThrow();
    expect(() => parsePreviewJobSubmission(null)).toThrow();
  });
});
