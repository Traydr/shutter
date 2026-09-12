import type { AdminSpaceDetail } from "@shutter/admin-api";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { ControlErrorView } from "../../components/error-view";
import { AppHeader } from "../../components/header";
import { HINTS } from "../../components/hints";
import {
  Button,
  Code,
  EmptyRow,
  ErrorNotice,
  Field,
  Hint,
  INPUT_CLASS,
  Input,
  Label,
  Notice,
  Panel,
  PanelHead,
  Pill,
  RouteClassChip,
  SecretReveal,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
  Time,
  TimeOrNever,
} from "../../components/ui";
import {
  FormInputError,
  type PolicyFields,
  policyFields,
  policyUpdateBody,
} from "../../features/spaces/forms";
import { spaceKeys, spaceQuery } from "../../features/spaces/spaces-queries";
import {
  addCapabilityKey,
  decommissionSpace,
  disableCapabilityKey,
  issueApiToken,
  revokeApiToken,
  updateSpacePolicy,
} from "../../features/spaces/spaces-service";
import { originPrefix, resolverSummary, withoutScheme } from "../../features/spaces/summaries";
import { type ControlFailure, describeFailure, describeThrown } from "../../server/failure";

export const Route = createFileRoute("/_admin/spaces/$spaceId/")({
  validateSearch: z.object({ generation: z.coerce.number().int().nonnegative().optional() }),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(spaceQuery(params.spaceId)),
  errorComponent: ControlErrorView,
  head: ({ params }) => ({ meta: [{ title: `${params.spaceId} · Shutter admin` }] }),
  component: SpacePage,
});

interface Secret {
  label: string;
  value: string;
}

/** Page-level state a mutation leaves behind: a notice, a one-time secret, or a failure. */
interface Outcome {
  generation?: number | undefined;
  secret?: Secret | undefined;
  error?: string | undefined;
}

function useSpaceMutations(spaceId: string, report: (outcome: Outcome) => void) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: spaceKeys.all });
  const failed = (failure: ControlFailure) => report({ error: describeFailure(failure) });
  const rejected = (cause: unknown) => report({ error: describeThrown(cause) });
  return {
    savePolicy: useMutation({
      mutationFn: (fields: PolicyFields) =>
        updateSpacePolicy({ data: { spaceId, body: policyUpdateBody(fields) } }),
      onError: rejected,
      onSuccess: async (result) => {
        if (!result.ok) return failed(result.failure);
        report({ generation: result.value.generation });
        await refresh();
      },
    }),
    issueToken: useMutation({
      mutationFn: (label: string) => issueApiToken({ data: { spaceId, body: { label } } }),
      onError: rejected,
      onSuccess: async (result) => {
        if (!result.ok) return failed(result.failure);
        // The secret comes from this response alone; the refetch below may fail and it stays.
        report({
          generation: result.value.generation,
          secret: { label: "New API token", value: result.value.secret },
        });
        await refresh();
      },
    }),
    revokeToken: useMutation({
      mutationFn: (tokenId: number) => revokeApiToken({ data: { spaceId, tokenId } }),
      onError: rejected,
      onSuccess: async (result) => {
        if (!result.ok) return failed(result.failure);
        report({ generation: result.value.generation });
        await refresh();
      },
    }),
    addKey: useMutation({
      mutationFn: (keyId: string) => addCapabilityKey({ data: { spaceId, body: { keyId } } }),
      onError: rejected,
      onSuccess: async (result) => {
        if (!result.ok) return failed(result.failure);
        report({
          generation: result.value.generation,
          secret: { label: "New Capability Key", value: result.value.secret },
        });
        await refresh();
      },
    }),
    disableKey: useMutation({
      mutationFn: (keyId: string) => disableCapabilityKey({ data: { spaceId, keyId } }),
      onError: rejected,
      onSuccess: async (result) => {
        if (!result.ok) return failed(result.failure);
        report({ generation: result.value.generation });
        await refresh();
      },
    }),
    decommission: useMutation({
      mutationFn: () => decommissionSpace({ data: { spaceId } }),
      onError: rejected,
    }),
  };
}

function SpacePage() {
  const { spaceId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detail = useSuspenseQuery(spaceQuery(spaceId)).data;
  const { policy } = detail.space;
  const active = detail.space.status === "active";

  const [outcome, setOutcome] = useState<Outcome>({});
  const report = (next: Outcome) =>
    setOutcome((current) => ({ ...current, ...next, error: next.error }));
  const mutations = useSpaceMutations(spaceId, report);

  const noticeGeneration = outcome.generation ?? search.generation;
  const activeTokens = detail.apiTokens.filter((token) => token.revokedAt === undefined).length;
  const acceptingKeys = detail.capabilityKeys.filter((key) => key.disabledAt === undefined).length;

  async function decommission(confirm: string) {
    if (confirm !== policy.id) return report({ error: "Type the identifier exactly to confirm." });
    let result: Awaited<ReturnType<typeof decommissionSpace>>;
    try {
      result = await mutations.decommission.mutateAsync();
    } catch {
      return; // onError reported it
    }
    if (!result.ok) return report({ error: describeFailure(result.failure) });
    await queryClient.invalidateQueries({ queryKey: spaceKeys.all });
    await navigate({ to: "/", search: { generation: result.value.generation } });
  }

  return (
    <>
      <AppHeader crumb={policy.id} />
      <main className="mx-auto grid max-w-[1240px] gap-3.5 px-4 pb-10 pt-3.5">
        {noticeGeneration !== undefined && noticeGeneration === detail.generation ? (
          <Notice>The registry is now at generation {noticeGeneration}.</Notice>
        ) : null}
        {outcome.error === undefined ? null : <ErrorNotice>{outcome.error}</ErrorNotice>}
        {outcome.secret === undefined ? null : (
          <SecretReveal label={outcome.secret.label} value={outcome.secret.value} />
        )}

        <div className="grid items-start gap-[18px] lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="grid gap-2 lg:sticky lg:top-3">
            <nav aria-label="Sections" className="jump grid gap-px text-[12.5px]">
              <a href="#policy">Policy</a>
              <a href="#resolvers">
                Resolvers<b>{policy.resolvers.length}</b>
              </a>
              <a href="#tokens">
                API tokens<b>{activeTokens}</b>
              </a>
              <a href="#keys">
                Capability Keys<b>{acceptingKeys}</b>
              </a>
              {active ? (
                <a href="#decommission" className="mt-2 text-red">
                  Decommission
                </a>
              ) : null}
            </nav>
            <Panel className="grid gap-1.5 px-3 py-2.5 text-[12px]">
              <dl className="m-0 grid gap-1.5">
                <SummaryRow
                  term={
                    <>
                      Route class
                      <Hint text={HINTS.routeClass} />
                    </>
                  }
                >
                  {policy.routeClass}
                </SummaryRow>
                <SummaryRow term="Status">
                  {active ? <Pill tone="ok">active</Pill> : <Pill>decommissioned</Pill>}
                </SummaryRow>
                <SummaryRow term="Registry generation">
                  <span className="num">{detail.generation}</span>
                </SummaryRow>
                <SummaryRow term="Created">
                  <Time value={detail.space.createdAt} />
                </SummaryRow>
                <SummaryRow term="Policy updated">
                  <Time value={detail.space.updatedAt} />
                </SummaryRow>
                {detail.space.decommissionedAt === undefined ? null : (
                  <SummaryRow term="Decommissioned">
                    <Time value={detail.space.decommissionedAt} />
                  </SummaryRow>
                )}
              </dl>
            </Panel>
            <Panel className="grid gap-1.5 px-3 py-2.5 text-[12px]">
              <Label>Rotation state</Label>
              <RotationState detail={detail} />
            </Panel>
            <Panel className="grid gap-1.5 px-3 py-2.5 text-[12px]">
              <Label>Deployment</Label>
              <DeploymentState detail={detail} />
            </Panel>
          </aside>

          <div className="grid min-w-0 gap-3.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="m-0 font-mono text-[17px] font-semibold [overflow-wrap:anywhere]">
                {policy.id}
              </h1>
              <RouteClassChip routeClass={policy.routeClass} />
              {active ? <Pill tone="ok">active</Pill> : <Pill>decommissioned</Pill>}
            </div>

            <PolicySection
              detail={detail}
              active={active}
              pending={mutations.savePolicy.isPending}
              onSave={(fields) => {
                report({ error: undefined });
                try {
                  policyUpdateBody(fields);
                } catch (cause) {
                  return report({
                    error: cause instanceof FormInputError ? cause.message : "Invalid form.",
                  });
                }
                mutations.savePolicy.mutate(fields);
              }}
            />

            <ResolversSection detail={detail} active={active} />

            <Panel id="tokens">
              <PanelHead
                title={
                  <>
                    API tokens
                    <Hint text={HINTS.apiTokens} />
                  </>
                }
                aside={
                  <span className="num">
                    {activeTokens} active · {detail.apiTokens.length - activeTokens} revoked
                  </span>
                }
              />
              {detail.apiTokens.length === 0 ? (
                <EmptyRow>
                  No API tokens.{active ? " Issue one so the application can call Control." : ""}
                </EmptyRow>
              ) : (
                <div className="overflow-x-auto">
                  <table className={TABLE_CLASS}>
                    <thead>
                      <tr>
                        <th className={TH_CLASS}>Label</th>
                        <th className={TH_CLASS}>Prefix</th>
                        <th className={TH_CLASS}>Created</th>
                        <th className={TH_CLASS}>Last used</th>
                        <th className={TH_CLASS} />
                      </tr>
                    </thead>
                    <tbody>
                      {detail.apiTokens.map((token) => {
                        const live = token.revokedAt === undefined;
                        return (
                          <tr key={token.id} className={live ? "" : "text-ink-3"}>
                            <td className={TD_CLASS}>{token.label}</td>
                            <td className={`${TD_CLASS} font-mono`}>{token.displayPrefix}…</td>
                            <td className={`${TD_CLASS} text-ink-2`}>
                              <Time value={token.createdAt} />
                            </td>
                            <td className={TD_CLASS}>
                              <TimeOrNever value={token.lastUsedAt} />
                            </td>
                            <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                              {live && active ? (
                                <Button
                                  tone="danger"
                                  small
                                  type="button"
                                  disabled={mutations.revokeToken.isPending}
                                  onClick={() => mutations.revokeToken.mutate(token.id)}
                                >
                                  Revoke
                                </Button>
                              ) : live ? null : (
                                <Pill>
                                  revoked <Time value={token.revokedAt ?? ""} />
                                </Pill>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {active ? (
                <InlineForm
                  name="label"
                  placeholder="New token label, e.g. production deploy"
                  ariaLabel="New token label"
                  maxLength={128}
                  action="Issue token"
                  pending={mutations.issueToken.isPending}
                  onSubmit={(label) => {
                    report({ error: undefined });
                    mutations.issueToken.mutate(label);
                  }}
                />
              ) : null}
            </Panel>

            <Panel id="keys">
              <PanelHead
                title={
                  <>
                    Capability Keys
                    <Hint text={HINTS.capabilityKeys} />
                  </>
                }
                aside={
                  <span className="num">
                    {acceptingKeys} accepting · {detail.capabilityKeys.length - acceptingKeys}{" "}
                    disabled
                  </span>
                }
              />
              {detail.capabilityKeys.length === 0 ? (
                <EmptyRow>
                  No Capability Keys.
                  {active
                    ? " The application cannot mint Source Capabilities until one exists."
                    : ""}
                </EmptyRow>
              ) : (
                <div className="overflow-x-auto">
                  <table className={TABLE_CLASS}>
                    <thead>
                      <tr>
                        <th className={TH_CLASS}>Key identifier</th>
                        <th className={TH_CLASS}>Accepted</th>
                        <th className={TH_CLASS}>Disabled</th>
                        <th className={TH_CLASS} />
                      </tr>
                    </thead>
                    <tbody>
                      {detail.capabilityKeys.map((key) => {
                        const live = key.disabledAt === undefined;
                        return (
                          <tr key={key.id} className={live ? "" : "text-ink-3"}>
                            <td className={`${TD_CLASS} font-mono`}>{key.keyId}</td>
                            <td className={`${TD_CLASS} text-ink-2`}>
                              <Time value={key.acceptedAt} />
                            </td>
                            <td className={TD_CLASS}>
                              <TimeOrNever value={key.disabledAt} />
                            </td>
                            <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                              {live && active ? (
                                <Button
                                  tone="danger"
                                  small
                                  type="button"
                                  disabled={mutations.disableKey.isPending}
                                  onClick={() => mutations.disableKey.mutate(key.keyId)}
                                >
                                  Disable now
                                </Button>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {active ? (
                <>
                  <div className="grid border-t border-rule-2 text-[11.5px] text-ink-2 sm:grid-cols-3">
                    <RotationStep n="1 · Add">Generate a new key identifier.</RotationStep>
                    <RotationStep n="2 · Install">
                      Make it the application's minting key, then wait 24 hours.
                    </RotationStep>
                    <RotationStep n="3 · Disable" last>
                      Disable the old key here. Disable a compromised key immediately.
                    </RotationStep>
                  </div>
                  <InlineForm
                    name="keyId"
                    placeholder="New key identifier, e.g. k-2026-11"
                    ariaLabel="New key identifier"
                    maxLength={64}
                    pattern="[A-Za-z0-9_-]+"
                    action="Generate key"
                    pending={mutations.addKey.isPending}
                    onSubmit={(keyId) => {
                      report({ error: undefined });
                      mutations.addKey.mutate(keyId);
                    }}
                  />
                </>
              ) : null}
            </Panel>

            {active ? (
              <DecommissionSection
                spaceId={policy.id}
                pending={mutations.decommission.isPending}
                onConfirm={decommission}
              />
            ) : null}
          </div>
        </div>
      </main>
    </>
  );
}

function SummaryRow({ term, children }: { term: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="flex items-center whitespace-nowrap text-[11px] text-ink-3">{term}</dt>
      <dd className="m-0 text-right [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function RotationStep({
  n,
  last = false,
  children,
}: {
  n: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`px-2.5 py-[7px] ${last ? "" : "border-b border-rule-2 sm:border-b-0 sm:border-r"}`}
    >
      <b className="mb-0.5 block text-[10.5px] font-semibold uppercase tracking-[.07em] text-ink-3">
        {n}
      </b>
      {children}
    </div>
  );
}

function RotationState({ detail }: { detail: AdminSpaceDetail }) {
  if (detail.space.status !== "active") {
    return <span className="text-ink-3">Keys are read-only records.</span>;
  }
  const accepting = detail.capabilityKeys.filter((key) => key.disabledAt === undefined);
  if (accepting.length === 0) {
    return (
      <>
        <Pill tone="warn">no key accepting</Pill>
        <span>The application cannot mint Source Capabilities until a key exists.</span>
      </>
    );
  }
  const [only] = accepting;
  if (accepting.length === 1 && only !== undefined) {
    return (
      <span>
        One key accepting: <Code>{only.keyId}</Code>, since <Time value={only.acceptedAt} />.
      </span>
    );
  }
  const newest = accepting.reduce((latest, key) =>
    key.acceptedAt > latest.acceptedAt ? key : latest,
  );
  return (
    <>
      <Pill tone="warn">rotation in progress</Pill>
      <span>
        {accepting.length} keys accepting. Once the application mints with{" "}
        <Code>{newest.keyId}</Code> and 24 hours have passed since{" "}
        <Time value={newest.acceptedAt} />, disable the older{" "}
        {accepting.length === 2 ? "key" : "keys"}.
      </span>
    </>
  );
}

function DeploymentState({ detail }: { detail: AdminSpaceDetail }) {
  if (detail.space.status !== "active") {
    return <span className="text-ink-3">Not part of the allowlist.</span>;
  }
  const { uncovered } = detail.coverage;
  if (uncovered.length === 0) return <Pill tone="ok">all origins deployed</Pill>;
  return (
    <>
      <Pill tone="warn">
        {uncovered.length} origin{uncovered.length === 1 ? "" : "s"} not deployed
      </Pill>
      <span className="[overflow-wrap:anywhere]">
        {uncovered.map((origin) => (
          <Code key={origin}>{withoutScheme(origin)}</Code>
        ))}
      </span>
      <Link to="/" hash="allowlist" className="text-brand-ink hover:underline">
        Open the allowlist
      </Link>
    </>
  );
}

function PolicySection({
  detail,
  active,
  pending,
  onSave,
}: {
  detail: AdminSpaceDetail;
  active: boolean;
  pending: boolean;
  onSave: (fields: PolicyFields) => void;
}) {
  const { policy } = detail.space;
  const [fields, setFields] = useState<PolicyFields>(() => policyFields(policy));

  if (!active) {
    return (
      <Panel id="policy">
        <PanelHead title="Policy">
          <span className="text-ink-3">read-only: this Space is decommissioned</span>
        </PanelHead>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 p-2.5 text-[12.5px]">
          <dt className="text-ink-3">Qualities</dt>
          <dd className="m-0">
            {policy.qualities.join(", ")} · default {policy.defaultQuality}
          </dd>
          <dt className="text-ink-3">Source origins</dt>
          <dd className="m-0 font-mono [overflow-wrap:anywhere]">
            {policy.allowedSourceOrigins.map((rule) => (
              <div key={originPrefix(rule)}>{originPrefix(rule)}</div>
            ))}
          </dd>
          <dt className="text-ink-3">Resolvers</dt>
          <dd className="m-0 font-mono [overflow-wrap:anywhere]">
            {policy.resolvers.length === 0
              ? "—"
              : policy.resolvers.map((resolver) => (
                  <div key={resolver.id}>
                    {resolver.id} · {resolver.type} · {resolverSummary(resolver)}
                  </div>
                ))}
          </dd>
        </dl>
      </Panel>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(fields);
  }

  return (
    <Panel id="policy">
      <form onSubmit={submit}>
        <PanelHead
          title="Policy"
          aside={
            <>
              identifier and class are fixed
              <Hint text={HINTS.fixed} />
            </>
          }
        >
          <span className="text-ink-3">saving → generation {detail.generation + 1}</span>
          <Button tone="primary" small type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save policy"}
          </Button>
        </PanelHead>
        <div className="grid gap-2.5 p-2.5 sm:grid-cols-2">
          <Field label="Allowed qualities" hint={HINTS.qualities}>
            <Input
              name="qualities"
              required
              value={fields.qualities}
              onChange={(event) => setFields({ ...fields, qualities: event.target.value })}
            />
          </Field>
          <Field label="Default quality" hint={HINTS.defaultQuality}>
            <Input
              name="defaultQuality"
              required
              inputMode="numeric"
              value={fields.defaultQuality}
              onChange={(event) => setFields({ ...fields, defaultQuality: event.target.value })}
            />
          </Field>
          <Field label="Allowed source origins" hint={HINTS.origins} wide>
            <textarea
              name="allowedSourceOrigins"
              required
              rows={3}
              className={`${INPUT_CLASS} min-h-[52px] resize-y font-mono text-[12px] leading-normal`}
              value={fields.allowedSourceOrigins}
              onChange={(event) =>
                setFields({ ...fields, allowedSourceOrigins: event.target.value })
              }
            />
          </Field>
        </div>
      </form>
    </Panel>
  );
}

function ResolversSection({ detail, active }: { detail: AdminSpaceDetail; active: boolean }) {
  const { policy } = detail.space;
  const spaceId = policy.id;
  return (
    <Panel id="resolvers">
      <PanelHead
        title={
          <>
            Resolvers
            <Hint text={HINTS.resolvers} />
          </>
        }
        aside={<span className="num">{policy.resolvers.length} configured</span>}
      >
        {active ? (
          <>
            <Link
              to="/spaces/$spaceId/resolvers/new"
              params={{ spaceId }}
              search={{ kind: "template" }}
              className="rounded-md border border-rule px-[7px] py-[3px] text-[11px] font-semibold"
            >
              + Template
            </Link>
            <Link
              to="/spaces/$spaceId/resolvers/new"
              params={{ spaceId }}
              search={{ kind: "template", preset: "uploadthing" }}
              className="rounded-md border border-rule px-[7px] py-[3px] text-[11px] font-semibold"
            >
              + UploadThing
            </Link>
            <Link
              to="/spaces/$spaceId/resolvers/new"
              params={{ spaceId }}
              search={{ kind: "s3" }}
              className="rounded-md border border-rule px-[7px] py-[3px] text-[11px] font-semibold"
            >
              + S3 bucket
            </Link>
          </>
        ) : null}
      </PanelHead>
      {policy.resolvers.length === 0 ? (
        <EmptyRow>
          No resolvers.
          {active ? " Add one so v2 Delivery URLs can reach this Space's sources." : ""}
        </EmptyRow>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th className={TH_CLASS}>Identifier</th>
                <th className={TH_CLASS}>Kind</th>
                <th className={TH_CLASS}>Location</th>
                <th className={TH_CLASS}>Credential</th>
                <th className={TH_CLASS} />
              </tr>
            </thead>
            <tbody>
              {policy.resolvers.map((resolver) => {
                const credential = detail.resolverCredentials.find(
                  (candidate) => candidate.resolverId === resolver.id,
                );
                const editable = resolver.type !== "uploadthing";
                return (
                  <tr key={resolver.id}>
                    <td className={`${TD_CLASS} font-mono text-[12.5px] font-medium`}>
                      {editable ? (
                        <Link
                          to="/spaces/$spaceId/resolvers/$resolverId"
                          params={{ spaceId, resolverId: resolver.id }}
                          className="text-brand-ink hover:underline"
                        >
                          {resolver.id}
                        </Link>
                      ) : (
                        resolver.id
                      )}
                    </td>
                    <td className={TD_CLASS}>
                      <span className="inline-block rounded border border-rule px-1.5 py-[3px] font-mono text-[10.5px] font-semibold uppercase leading-none tracking-[.04em] text-ink-2">
                        {resolver.type}
                      </span>
                    </td>
                    <td className={`${TD_CLASS} font-mono text-[12px]`}>
                      {resolverSummary(resolver)}
                    </td>
                    <td className={TD_CLASS}>
                      {resolver.type === "s3" ? (
                        credential === undefined ? (
                          <Pill tone="warn" small>
                            no credential
                          </Pill>
                        ) : (
                          <span className="font-mono">{credential.accessKeyId}</span>
                        )
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                      {editable ? (
                        <Link
                          to="/spaces/$spaceId/resolvers/$resolverId"
                          params={{ spaceId, resolverId: resolver.id }}
                          className="rounded-md border border-rule px-[7px] py-[3px] text-[11px] font-semibold"
                        >
                          Edit
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** A one-line form at the foot of a table: one input, one action. */
function InlineForm({
  name,
  placeholder,
  ariaLabel,
  maxLength,
  pattern,
  action,
  pending,
  onSubmit,
}: {
  name: string;
  placeholder: string;
  ariaLabel: string;
  maxLength: number;
  pattern?: string;
  action: string;
  pending: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="grid grid-cols-[1fr_auto] items-center gap-2 border-t border-rule-2 bg-panel-2 px-2.5 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim().length === 0) return;
        onSubmit(value.trim());
        setValue("");
      }}
    >
      <Input
        name={name}
        required
        maxLength={maxLength}
        pattern={pattern}
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" disabled={pending}>
        {action}
      </Button>
    </form>
  );
}

function DecommissionSection({
  spaceId,
  pending,
  onConfirm,
}: {
  spaceId: string;
  pending: boolean;
  onConfirm: (confirm: string) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState("");
  return (
    <Panel id="decommission" className="border-red-rule">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onConfirm(confirm);
        }}
      >
        <div className="flex flex-wrap items-center gap-2.5 border-b border-[#f0d9d9] bg-panel-2 px-2.5 py-1.5">
          <h2 className="m-0 text-[13px] font-semibold text-red">
            Decommission
            <Hint text={HINTS.decommission} />
          </h2>
          <span className="text-ink-3">
            blocks new work, keeps records, never frees the identifier
          </span>
        </div>
        <div className="grid grid-cols-[minmax(0,320px)_auto] items-center gap-2 px-2.5 py-2">
          <Input
            name="confirm"
            required
            pattern={spaceId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}
            placeholder={`Type ${spaceId} to confirm`}
            aria-label="Type the identifier to confirm"
            autoComplete="off"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
          <Button tone="danger" type="submit" disabled={pending || confirm !== spaceId}>
            Decommission Space
          </Button>
        </div>
      </form>
    </Panel>
  );
}
