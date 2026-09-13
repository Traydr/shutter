import type { AdminSpaceDetail, ResolverTestResultWire } from "@shutter/admin-api";
import type { SourceResolverPolicy } from "@shutter/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { HINTS } from "../../components/hints";
import {
  Button,
  Card,
  CardFooter,
  Field,
  Input,
  Mono,
  Notice,
  PageTitle,
  StateLine,
  Template,
  TextLink,
} from "../../components/ui";
import { describeFailure, describeThrown } from "../../server/failure";
import {
  allowedFor,
  emptyResolverFields,
  FormInputError,
  hostnamePlaceholders,
  placeholderNames,
  type ResolverFields,
  type ResolverKind,
  referenceSegments,
  requestPattern,
  resolverBody,
  resolverFields,
  withAllowed,
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

const KIND_LABEL = { template: "URL template", s3: "S3 bucket" } as const;

export function SourceEditor({
  detail,
  mode,
  saved,
}: {
  detail: AdminSpaceDetail;
  mode: EditorMode;
  /** From the URL after a create, so the page can confirm the save it landed from. */
  saved: boolean;
}) {
  const spaceId = detail.space.policy.id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [fields, setFields] = useState<ResolverFields | undefined>(() => initialFields(mode));
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(
    saved ? "Saved. The Edge picks it up within a minute." : undefined,
  );
  const [testResult, setTestResult] = useState<ResolverTestResultWire | undefined>(undefined);
  const [reference, setReference] = useState("");
  const [removing, setRemoving] = useState(false);
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
          to: "/spaces/$spaceId/sources/$resolverId",
          params: { spaceId, resolverId },
          search: { saved: true },
        });
        return;
      }
      setNotice("Saved. The Edge picks it up within a minute.");
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
        : Promise.reject(new Error("save the source before testing it")),
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
      await navigate({ to: "/spaces/$spaceId/sources", params: { spaceId } });
    },
  });

  if (fields === undefined) {
    return (
      <main className="mx-auto max-w-[680px] px-6 py-10">
        <Notice tone="error">The retired UploadThing kind has no editor.</Notice>
      </main>
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

  const editing = mode.kind === "edit";
  const title = editing ? mode.resolver.id : `New ${KIND_LABEL[fields.kind]}`;
  const names = placeholderNames(fields.kind === "template" ? fields.url : fields.keyTemplate);
  const inHostname = fields.kind === "template" ? hostnamePlaceholders(fields.url) : [];

  return (
    <main className="mx-auto grid max-w-[680px] gap-7 px-6 pb-20 pt-10">
      <div>
        <TextLink to="/spaces/$spaceId/sources" params={{ spaceId }} className="text-[13.5px]">
          ← Sources
        </TextLink>
        <PageTitle>
          <span className={editing ? "mt-2 block font-mono" : "mt-2 block"}>{title}</span>
        </PageTitle>
        <p className="mt-1.5 text-fg-2 [overflow-wrap:anywhere]">
          {KIND_LABEL[fields.kind]} · requests look like <Template value={requestPattern(fields)} />
        </p>
      </div>

      {notice === undefined ? null : <Notice>{notice}</Notice>}
      {error === undefined ? null : <Notice tone="error">{error}</Notice>}

      <form onSubmit={submit}>
        <Card className="grid gap-6 p-6">
          <Field
            label="Identifier"
            help={editing ? "Fixed: it is part of every Source ID." : HINTS.resolverId}
          >
            <Input
              mono
              name="resolverId"
              required
              pattern="[a-z0-9][a-z0-9_-]*"
              maxLength={64}
              disabled={editing}
              placeholder="uploads"
              value={fields.id}
              onChange={(event) => set("id", event.target.value)}
            />
          </Field>
          {fields.kind === "template" ? (
            <>
              <Field label="Fetch from" help={HINTS.templateUrl}>
                <Input
                  mono
                  name="url"
                  required
                  placeholder="https://{project}.ufs.sh/f/{file}"
                  value={fields.url}
                  onChange={(event) => set("url", event.target.value)}
                />
              </Field>
              {names.map((name) => {
                const required = inHostname.includes(name);
                return (
                  <Field
                    key={name}
                    label={
                      <>
                        Allowed values for <Mono>{`{${name}}`}</Mono>
                      </>
                    }
                    help={
                      required
                        ? "Required, because it is part of the hostname. Comma-separated."
                        : "Optional for a path segment. Leave empty to accept any value."
                    }
                  >
                    <Input
                      mono
                      required={required}
                      placeholder={required ? "value, value" : "Any value"}
                      value={allowedFor(fields.allowed, name)}
                      onChange={(event) =>
                        set("allowed", withAllowed(fields.allowed, name, event.target.value))
                      }
                    />
                  </Field>
                );
              })}
            </>
          ) : (
            <>
              <Field label="Endpoint" help={HINTS.s3Endpoint}>
                <Input
                  mono
                  name="endpoint"
                  required
                  placeholder="https://<account>.r2.cloudflarestorage.com"
                  value={fields.endpoint}
                  onChange={(event) => set("endpoint", event.target.value)}
                />
              </Field>
              <div className="grid gap-6 sm:grid-cols-[1fr_140px]">
                <Field label="Bucket">
                  <Input
                    mono
                    name="bucket"
                    required
                    value={fields.bucket}
                    onChange={(event) => set("bucket", event.target.value)}
                  />
                </Field>
                <Field label="Region" help="auto for R2.">
                  <Input
                    mono
                    name="region"
                    value={fields.region}
                    onChange={(event) => set("region", event.target.value)}
                  />
                </Field>
              </div>
              <Field label="Key template" help={HINTS.keyTemplate}>
                <Input
                  mono
                  name="keyTemplate"
                  required
                  value={fields.keyTemplate}
                  onChange={(event) => set("keyTemplate", event.target.value)}
                />
              </Field>
              <label className="flex items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  name="pathStyle"
                  checked={fields.pathStyle}
                  onChange={(event) => set("pathStyle", event.target.checked)}
                />
                Path-style addressing (keep on for R2 and Railway buckets)
              </label>
              <div className="grid gap-6 border-t border-line pt-6 sm:grid-cols-2">
                <Field
                  label="Access key ID"
                  help={
                    credential === undefined
                      ? HINTS.credential
                      : `Stored: ${credential.accessKeyId}. Leave both empty to keep it.`
                  }
                >
                  <Input
                    mono
                    name="accessKeyId"
                    autoComplete="off"
                    value={fields.accessKeyId}
                    onChange={(event) => set("accessKeyId", event.target.value)}
                  />
                </Field>
                <Field label="Secret access key">
                  <Input
                    mono
                    name="secretAccessKey"
                    type="password"
                    autoComplete="new-password"
                    value={fields.secretAccessKey}
                    onChange={(event) => set("secretAccessKey", event.target.value)}
                  />
                </Field>
              </div>
            </>
          )}
          <CardFooter>
            <span>The Edge picks changes up within a minute.</span>
            <Button tone="primary" type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : editing ? "Save" : "Create source"}
            </Button>
          </CardFooter>
        </Card>
      </form>

      {editing ? (
        <>
          <form onSubmit={runTest}>
            <Card className="grid gap-4 p-6">
              <div>
                <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Try it</h2>
                <p className="mt-1 text-[13.5px] text-fg-2">{HINTS.testResolver}</p>
              </div>
              <div className="flex gap-2.5">
                <Input
                  mono
                  name="reference"
                  required
                  placeholder="one segment per placeholder, joined with /"
                  aria-label="Sample reference"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                />
                <Button type="submit" disabled={test.isPending}>
                  {test.isPending ? "Running…" : "Run"}
                </Button>
              </div>
              {testResult === undefined ? null : <TestResult result={testResult} />}
            </Card>
          </form>

          {removing ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setError(undefined);
                remove.mutate();
              }}
            >
              <Card className="grid gap-4 border-red/40 p-6">
                <div>
                  <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-red-fg">
                    Remove {mode.resolver.id}
                  </h2>
                  <p className="mt-1 text-[13.5px] text-fg-2">
                    Requests for this source stop. Cached images stay until a Source Purge removes
                    them. Type the identifier to confirm.
                  </p>
                </div>
                <div className="flex gap-2.5">
                  <Input
                    mono
                    name="confirm"
                    required
                    placeholder={mode.resolver.id}
                    aria-label="Type the source identifier to confirm"
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
                  <Button type="button" tone="ghost" onClick={() => setRemoving(false)}>
                    Cancel
                  </Button>
                </div>
              </Card>
            </form>
          ) : (
            <p className="text-[13px] text-fg-2">
              Need to retire this source?{" "}
              <button
                type="button"
                className="cursor-pointer text-accent-fg hover:underline"
                onClick={() => setRemoving(true)}
              >
                Remove {mode.resolver.id}
              </button>
              . Cached images stay until a purge.
            </p>
          )}
        </>
      ) : null}
    </main>
  );
}

function TestResult({ result }: { result: ResolverTestResultWire }) {
  const facts = [
    result.status === undefined ? undefined : String(result.status),
    result.contentType,
    result.contentLength === undefined
      ? undefined
      : `${result.contentLength.toLocaleString("en-US")} bytes`,
  ].filter((fact) => fact !== undefined);
  return (
    <div className="grid gap-1.5 text-[13.5px] text-fg-2">
      <StateLine tone={result.outcome === "ok" ? "ok" : "warn"}>
        {result.message}
        {result.host === undefined ? "" : ` · ${result.host}`}
        {facts.length === 0 ? "" : ` · ${facts.join(" · ")}`}
      </StateLine>
      {result.sourceId === undefined ? null : (
        <span className="pl-4 [overflow-wrap:anywhere]">
          Source ID <Mono>{result.sourceId}</Mono>
        </span>
      )}
    </div>
  );
}
