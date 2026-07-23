export const CONTROL_HTTP_ROUTES = {
  healthz: "/healthz",
  masterRendition: "/internal/v1/master-rendition",
  spikeRendition: "/internal/v1/spike/rendition",
  sourcePurge: "/v1/spaces/:spaceId/sources/:sourceId/purge",
  previewJob: "/v1/spaces/:spaceId/sources/:sourceId/previews/:kind",
  executorClaim: "/internal/v1/executors/:kind/claim",
  executorHeartbeat: "/internal/v1/executors/:kind/jobs/:spaceId/:sourceId/heartbeat",
  executorComplete: "/internal/v1/executors/:kind/jobs/:spaceId/:sourceId/complete",
  executorFail: "/internal/v1/executors/:kind/jobs/:spaceId/:sourceId/fail",
} as const;

export type ControlHttpRoute = (typeof CONTROL_HTTP_ROUTES)[keyof typeof CONTROL_HTTP_ROUTES];
