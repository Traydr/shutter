import type { AdminSpaceDetail, ResolverTestResultWire } from "@shutter/admin-api";
import type { SourceResolverPolicy } from "@shutter/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AppHeader } from "../../components/header";
import { HINTS } from "../../components/hints";
import {
  Button,
  Code,
  ErrorNotice,
  Field,
  Hint,
  INPUT_CLASS,
  Input,
  Notice,
  Panel,
  PanelHead,
  Pill,
} from "../../components/ui";
import { describeFailure, describeThrown } from "../../server/failure";
import {
  emptyResolverFields,
  exampleDeliveryUrl,
  FormInputError,
  type ResolverFields,
  type ResolverKind,
  referenceSegments,
  resolverBody,
  resolverFields,
} from "./forms";
import { spaceKeys } from "./spaces-queries";
import { createResolver, removeResolver, replaceResolver, testResolver } from "./spaces-service";

export type EditorMode =
  | { kind: "new"; resolverKind: ResolverKind; preset?: "uploadthing" | undefined }
  | { kind: "edit"; resolver: SourceResolverPolicy };

function initialFields(mode: EditorMode): ResolverFields | undefined {
  return mode.kind === "new"
    ? emptyResolverFields(mode.resolverKind, mode.preset)
    : resolverFields(mode.resolver);
}

const TEXTAREA_CLASS = `${INPUT_CLASS} min-h-[52px] resize-y font-mono text-[12px] leading-normal`;

export function ResolverEditor({
  detail,
  mode,
  generation,
}: {
  detail: AdminSpaceDetail;
  mode: EditorMode;
  /** From the URL after a save, so the page can confirm the generation it produced. */
  generation: number | undefined;
}) {
  const spaceId = detail.space.policy.id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [fields, setFields] = useState<ResolverFields | undefined>(() => initialFields(mode));
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [testResult, setTestResult] = useState<ResolverTestResultWire | undefined>(undefined);
  const [reference, setReference] = useState("");
  const [confirm, setConfirm] = useState("");

  const credential = detail.resolverCredentials.find(
    (candidate) => mode.kind === "edit" && candidate.resolverId === mode.resolver.id,
  );

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof resolverBody>) =>
      mode.kind === "new"
        ? createResolver({ data: { spaceId, body } })
        : replaceResolver({ data: { spaceId, resolverId: mode.resolver.id, body } }),
    onError: (cause) => setError(describeThrown(cause)),
    onSuccess: async (result) => {
      if (!result.ok) return setError(describeFailure(result.failure));
      await queryClient.invalidateQueries({ queryKey: spaceKeys.all });
      const resolverId = fields?.id.trim() ?? "";
      if (mode.kind === "new") {
        await navigate({
          to: "/spaces/$spaceId/resolvers/$resolverId",
          params: { spaceId, resolverId },
          search: { generation: result.value.generation },
        });
        return;
      }
      setNotice(`The registry is now at generation ${result.value.generation}.`);
      setFields((current) =>
        current === undefined ? current : { ...current, accessKeyId: "", secretAccessKey: "" },
      );
    },
  });

  const test = useMutation({
    mutationFn: (segments: readonly string[]) =>
      mode.kind === "edit"
        ? testResolver({
            data: { spaceId, resolverId: mode.resolver.id, body: { reference: [...segments] } },
          })
        : Promise.reject(new Error("save the resolver before testing it")),
    onError: (cause) => setError(describeThrown(cause)),
    onSuccess: (result) => {
      if (!result.ok) return setError(describeFailure(result.failure));
      setTestResult(result.value);
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      mode.kind === "edit"
        ? removeResolver({ data: { spaceId, resolverId: mode.resolver.id } })
        : Promise.reject(new Error("nothing to remove")),
    onError: (cause) => setError(describeThrown(cause)),
    onSuccess: async (result) => {
      if (!result.ok) return setError(describeFailure(result.failure));
      await queryClient.invalidateQueries({ queryKey: spaceKeys.all });
      await navigate({
        to: "/spaces/$spaceId",
        params: { spaceId },
        search: { generation: result.value.generation },
        hash: "resolvers",
      });
    },
  });

  if (fields === undefined) {
    return (
      <>
        <AppHeader crumb={spaceId} />
        <main className="mx-auto max-w-[32rem] px-4 py-10">
          <ErrorNotice>The retired UploadThing kind has no editor.</ErrorNotice>
        </main>
      </>
    );
  }

  const set = <Name extends keyof ResolverFields>(name: Name, value: ResolverFields[Name]) =>
    setFields({ ...fields, [name]: value });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setNotice(undefined);
    try {
      save.mutate(resolverBody(fields ?? emptyResolverFields("template")));
    } catch (cause) {
      setError(cause instanceof FormInputError ? cause.message : "The form could not be read.");
    }
  }

  function runTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setTestResult(undefined);
    try {
      test.mutate(referenceSegments(reference));
    } catch (cause) {
      setError(
        cause instanceof FormInputError ? cause.message : "The reference could not be read.",
      );
    }
  }

  const title = mode.kind === "new" ? `New ${fields.kind} resolver` : mode.resolver.id;
  const example =
    mode.kind === "edit"
      ? exampleDeliveryUrl(
          detail.edgeBaseUrl,
          spaceId,
          mode.resolver,
          detail.space.policy.defaultQuality,
        )
      : undefined;

  return (
    <>
      <AppHeader crumb={spaceId} />
      <main className="mx-auto grid max-w-[900px] gap-3.5 px-4 pb-10 pt-3.5">
        {generation !== undefined && generation === detail.generation && notice === undefined ? (
          <Notice>The registry is now at generation {generation}.</Notice>
        ) : null}
        {notice === undefined ? null : <Notice>{notice}</Notice>}
        {error === undefined ? null : <ErrorNotice>{error}</ErrorNotice>}

        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            to="/spaces/$spaceId"
            params={{ spaceId }}
            hash="resolvers"
            className="text-brand-ink hover:underline"
          >
            ← {spaceId}
          </Link>
          <h1 className="m-0 font-mono text-[17px] font-semibold [overflow-wrap:anywhere]">
            {title}
          </h1>
          <span className="inline-block rounded border border-rule px-1.5 py-[3px] font-mono text-[10.5px] font-semibold uppercase leading-none tracking-[.04em] text-ink-2">
            {fields.kind}
          </span>
        </div>

        <Panel>
          <form onSubmit={submit}>
            <PanelHead
              title={mode.kind === "new" ? "Definition" : "Definition"}
              aside={
                mode.kind === "new" ? (
                  <>
                    identifier is permanent
                    <Hint text={HINTS.resolverId} />
                  </>
                ) : (
                  "identifier and kind are fixed"
                )
              }
            >
              <span className="text-ink-3">saving → generation {detail.generation + 1}</span>
              <Button tone="primary" small type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : mode.kind === "new" ? "Create resolver" : "Save"}
              </Button>
            </PanelHead>
            <div className="grid gap-2.5 p-2.5 sm:grid-cols-2">
              <Field label="Identifier" hint={HINTS.resolverId}>
                <Input
                  name="resolverId"
                  required
                  pattern="[a-z0-9][a-z0-9_-]*"
                  maxLength={64}
                  disabled={mode.kind === "edit"}
                  value={fields.id}
                  onChange={(event) => set("id", event.target.value)}
                />
              </Field>
              {fields.kind === "template" ? (
                <>
                  <Field label="URL template" hint={HINTS.templateUrl} wide>
                    <Input
                      name="url"
                      required
                      placeholder="https://{project}.ufs.sh/f/{file}"
                      className="font-mono"
                      value={fields.url}
                      onChange={(event) => set("url", event.target.value)}
                    />
                  </Field>
                  <Field
                    label="Allowed values"
                    hint={HINTS.allowed}
                    wide
                    note="One name=value,value line per restricted placeholder."
                  >
                    <textarea
                      name="allowed"
                      rows={3}
                      className={TEXTAREA_CLASS}
                      placeholder={"project=abc123,def456"}
                      value={fields.allowed}
                      onChange={(event) => set("allowed", event.target.value)}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Endpoint" hint={HINTS.s3Endpoint}>
                    <Input
                      name="endpoint"
                      required
                      placeholder="https://<account>.r2.cloudflarestorage.com"
                      className="font-mono"
                      value={fields.endpoint}
                      onChange={(event) => set("endpoint", event.target.value)}
                    />
                  </Field>
                  <Field label="Bucket">
                    <Input
                      name="bucket"
                      required
                      className="font-mono"
                      value={fields.bucket}
                      onChange={(event) => set("bucket", event.target.value)}
                    />
                  </Field>
                  <Field label="Region" note="auto for R2.">
                    <Input
                      name="region"
                      value={fields.region}
                      onChange={(event) => set("region", event.target.value)}
                    />
                  </Field>
                  <Field label="Key template" hint={HINTS.keyTemplate}>
                    <Input
                      name="keyTemplate"
                      required
                      className="font-mono"
                      value={fields.keyTemplate}
                      onChange={(event) => set("keyTemplate", event.target.value)}
                    />
                  </Field>
                  <label className="col-span-full flex items-center gap-2 text-[12px]">
                    <input
                      type="checkbox"
                      name="pathStyle"
                      checked={fields.pathStyle}
                      onChange={(event) => set("pathStyle", event.target.checked)}
                    />
                    Path-style addressing (keep on for R2 and Railway buckets)
                  </label>
                  <Field
                    label="Access key ID"
                    hint={HINTS.credential}
                    note={
                      credential === undefined
                        ? undefined
                        : `Stored: ${credential.accessKeyId}. Leave both empty to keep it.`
                    }
                  >
                    <Input
                      name="accessKeyId"
                      autoComplete="off"
                      className="font-mono"
                      value={fields.accessKeyId}
                      onChange={(event) => set("accessKeyId", event.target.value)}
                    />
                  </Field>
                  <Field label="Secret access key">
                    <Input
                      name="secretAccessKey"
                      type="password"
                      autoComplete="new-password"
                      className="font-mono"
                      value={fields.secretAccessKey}
                      onChange={(event) => set("secretAccessKey", event.target.value)}
                    />
                  </Field>
                </>
              )}
            </div>
          </form>
        </Panel>

        {mode.kind === "edit" ? (
          <>
            <Panel>
              <PanelHead title="Example Delivery URL" />
              <div className="p-2.5">
                <Code>{example}</Code>
              </div>
            </Panel>

            <Panel>
              <form onSubmit={runTest}>
                <PanelHead
                  title={
                    <>
                      Test
                      <Hint text={HINTS.testResolver} />
                    </>
                  }
                  aside="resolves and fetches one byte"
                />
                <div className="grid grid-cols-[1fr_auto] items-center gap-2 px-2.5 py-2">
                  <Input
                    name="reference"
                    required
                    placeholder="reference, one segment per placeholder, joined with /"
                    aria-label="Sample reference"
                    className="font-mono"
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                  />
                  <Button type="submit" disabled={test.isPending}>
                    {test.isPending ? "Testing…" : "Test"}
                  </Button>
                </div>
                {testResult === undefined ? null : <TestResultBox result={testResult} />}
              </form>
            </Panel>

            <Panel className="border-red-rule">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setError(undefined);
                  remove.mutate();
                }}
              >
                <div className="flex flex-wrap items-center gap-2.5 border-b border-[#f0d9d9] bg-panel-2 px-2.5 py-1.5">
                  <h2 className="m-0 text-[13px] font-semibold text-red">Remove resolver</h2>
                  <span className="text-ink-3">
                    orphans its cached bytes; Source Purge removes them
                  </span>
                </div>
                <div className="grid grid-cols-[minmax(0,320px)_auto] items-center gap-2 px-2.5 py-2">
                  <Input
                    name="confirm"
                    required
                    placeholder={`Type ${mode.resolver.id} to confirm`}
                    aria-label="Type the resolver identifier to confirm"
                    autoComplete="off"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                  />
                  <Button
                    tone="danger"
                    type="submit"
                    disabled={remove.isPending || confirm !== mode.resolver.id}
                  >
                    Remove
                  </Button>
                </div>
              </form>
            </Panel>
          </>
        ) : null}
      </main>
    </>
  );
}

function TestResultBox({ result }: { result: ResolverTestResultWire }) {
  return (
    <div className="grid gap-1.5 border-t border-rule-2 px-2.5 py-2 text-[12.5px]">
      <div className="flex items-center gap-2">
        {result.outcome === "ok" ? <Pill tone="ok">ok</Pill> : <Pill tone="warn">failed</Pill>}
        <span>{result.message}</span>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1">
        {result.sourceId === undefined ? null : (
          <>
            <dt className="text-ink-3">Source ID</dt>
            <dd className="m-0 font-mono [overflow-wrap:anywhere]">{result.sourceId}</dd>
          </>
        )}
        {result.host === undefined ? null : (
          <>
            <dt className="text-ink-3">Host</dt>
            <dd className="m-0 font-mono">{result.host}</dd>
          </>
        )}
        {result.status === undefined ? null : (
          <>
            <dt className="text-ink-3">Status</dt>
            <dd className="m-0 num">{result.status}</dd>
          </>
        )}
        {result.contentType === undefined ? null : (
          <>
            <dt className="text-ink-3">Content type</dt>
            <dd className="m-0">{result.contentType}</dd>
          </>
        )}
        {result.contentLength === undefined ? null : (
          <>
            <dt className="text-ink-3">Size</dt>
            <dd className="m-0 num">{result.contentLength.toLocaleString("en-US")} bytes</dd>
          </>
        )}
      </dl>
    </div>
  );
}
