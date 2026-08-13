import { describe, expect, it } from "vitest";
import {
  createFailedJobRepresentation,
  parseExecutorClaim,
  parseExecutorCompleteRequest,
  parseExecutorFailRequest,
  parsePreviewJobSubmission,
} from "./jobs.js";

describe("job protocol", () => {
  it("locks failure actions and rejects malformed wire bodies", () => {
    expect(createFailedJobRepresentation("source_expired")).toEqual({
      status: "failed",
      failure: { code: "source_expired", action: "renew_capability" },
    });
    expect(createFailedJobRepresentation("attempts_exhausted")).toEqual({
      status: "failed",
      failure: { code: "attempts_exhausted", action: "retry" },
    });

    expect(() => parsePreviewJobSubmission({ sourceCapability: "opaque", extra: true })).toThrow();
    expect(() => parseExecutorCompleteRequest({ processingToken: "token" })).toThrow();
    expect(() =>
      parseExecutorFailRequest({ processingToken: "token", retryable: true, code: "nope" }),
    ).toThrow();
    expect(
      parseExecutorClaim({
        spaceId: "example-private",
        sourceId: "source",
        kind: "video",
        locator: "https://sources.example.com/source",
        outputKey: "masters/output.webp",
        processingToken: "processing",
        executionCycle: 0,
        attemptNumber: 1,
        allowedSourceOrigins: [{ origin: "https://sources.example.com" }],
      }).allowedSourceOrigins,
    ).toEqual([{ origin: "https://sources.example.com" }]);
  });
});
