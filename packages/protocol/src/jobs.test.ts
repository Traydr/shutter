import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  createFailedJobRepresentation,
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

    expect(() =>
      Effect.runSync(parsePreviewJobSubmission({ sourceCapability: "opaque", extra: true })),
    ).toThrow();
    expect(() =>
      Effect.runSync(parseExecutorCompleteRequest({ processingToken: "token" })),
    ).toThrow();
    expect(() =>
      Effect.runSync(
        parseExecutorFailRequest({ processingToken: "token", retryable: true, code: "nope" }),
      ),
    ).toThrow();
  });
});
