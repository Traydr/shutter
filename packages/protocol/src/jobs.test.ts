import { describe, expect, it } from "vitest";
import {
  createFailedJobRepresentation,
  parseExecutorClaim,
  parseExecutorCompleteRequest,
  parseExecutorFailRequest,
  parseExecutorHeartbeatRequest,
  parsePreviewJobSubmission,
} from "./jobs.js";

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

  it("parses executor claim, heartbeat, complete, and fail bodies", () => {
    const claim = {
      spaceId: "pane-view",
      sourceId: "source-1",
      kind: "video",
      locator: "https://t3.storageapi.dev/balanced-wrap-ocyiwwexhao/a.mp4",
      outputKey: "masters/v1/pane-view/fp/video.webp",
      processingToken: "token",
      executionCycle: 0,
      attemptNumber: 1,
    };
    expect(parseExecutorClaim(claim)).toEqual(claim);
    expect(parseExecutorHeartbeatRequest({ processingToken: "token" })).toEqual({
      processingToken: "token",
    });
    expect(
      parseExecutorCompleteRequest({
        processingToken: "token",
        masterKey: "masters/v1/pane-view/fp/video.webp",
        width: 1920,
        height: 1080,
        format: "webp",
        objectEtag: '"etag"',
      }),
    ).toMatchObject({ format: "webp", width: 1920 });
    expect(
      parseExecutorFailRequest({
        processingToken: "token",
        retryable: true,
        code: "source_missing",
      }),
    ).toEqual({
      processingToken: "token",
      retryable: true,
      code: "source_missing",
    });
    expect(() => parseExecutorCompleteRequest({ processingToken: "token" })).toThrow();
    expect(() =>
      parseExecutorFailRequest({ processingToken: "token", retryable: true, code: "nope" }),
    ).toThrow();
  });
});
