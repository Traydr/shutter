/**
 * The mutations a Space page can run, each reporting one outcome: a notice,
 * a one-time secret, or a failure. The queries refresh after a success so
 * every page reads the Space as Control now holds it.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ControlFailure, describeFailure, describeThrown } from "../../server/failure";
import { type PolicyFields, policyUpdateBody } from "./forms";
import { spaceKeys } from "./spaces-queries";
import {
  addCapabilityKey,
  decommissionSpace,
  disableCapabilityKey,
  issueApiToken,
  revokeApiToken,
  updateSpacePolicy,
} from "./spaces-service";

export interface Secret {
  label: string;
  value: string;
}

export interface Outcome {
  saved?: boolean | undefined;
  secret?: Secret | undefined;
  error?: string | undefined;
}

export type Report = (outcome: Outcome) => void;

function useReporting(report: Report) {
  const queryClient = useQueryClient();
  return {
    refresh: () => queryClient.invalidateQueries({ queryKey: spaceKeys.all }),
    failed: (failure: ControlFailure) => report({ error: describeFailure(failure) }),
    rejected: (cause: unknown) => report({ error: describeThrown(cause) }),
  };
}

export function useAccessMutations(spaceId: string, report: Report) {
  const { refresh, failed, rejected } = useReporting(report);
  return {
    issueToken: useMutation({
      mutationFn: (label: string) => issueApiToken({ data: { spaceId, body: { label } } }),
      onError: rejected,
      onSuccess: async (result) => {
        if (!result.ok) return failed(result.failure);
        // The secret comes from this response alone; the refetch below may fail and it stays.
        report({ secret: { label: "New API token", value: result.value.secret } });
        await refresh();
      },
    }),
    revokeToken: useMutation({
      mutationFn: (tokenId: number) => revokeApiToken({ data: { spaceId, tokenId } }),
      onError: rejected,
      onSuccess: async (result) => {
        if (!result.ok) return failed(result.failure);
        report({ saved: true });
        await refresh();
      },
    }),
    addKey: useMutation({
      mutationFn: (keyId: string) => addCapabilityKey({ data: { spaceId, body: { keyId } } }),
      onError: rejected,
      onSuccess: async (result) => {
        if (!result.ok) return failed(result.failure);
        report({ secret: { label: "New Capability Key", value: result.value.secret } });
        await refresh();
      },
    }),
    disableKey: useMutation({
      mutationFn: (keyId: string) => disableCapabilityKey({ data: { spaceId, keyId } }),
      onError: rejected,
      onSuccess: async (result) => {
        if (!result.ok) return failed(result.failure);
        report({ saved: true });
        await refresh();
      },
    }),
  };
}

export function useSettingsMutations(spaceId: string, report: Report) {
  const { refresh, failed, rejected } = useReporting(report);
  return {
    savePolicy: useMutation({
      mutationFn: (fields: PolicyFields) =>
        updateSpacePolicy({ data: { spaceId, body: policyUpdateBody(fields) } }),
      onError: rejected,
      onSuccess: async (result) => {
        if (!result.ok) return failed(result.failure);
        report({ saved: true });
        await refresh();
      },
    }),
    decommission: useMutation({
      mutationFn: () => decommissionSpace({ data: { spaceId } }),
      onError: rejected,
    }),
  };
}
