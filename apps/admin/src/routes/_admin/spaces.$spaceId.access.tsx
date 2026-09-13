import type { AdminSpaceDetail } from "@shutter/admin-api";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ControlErrorView } from "../../components/error-view";
import { HINTS } from "../../components/hints";
import {
  Ago,
  Button,
  cx,
  Day,
  Input,
  List,
  Mono,
  Notice,
  PageTitle,
  Row,
  SecretReveal,
  SectionTitle,
  StateLine,
} from "../../components/ui";
import { type Outcome, useAccessMutations } from "../../features/spaces/space-mutations";
import { spaceQuery } from "../../features/spaces/spaces-queries";
import { keyRotation } from "../../features/spaces/summaries";

export const Route = createFileRoute("/_admin/spaces/$spaceId/access")({
  errorComponent: ControlErrorView,
  head: ({ params }) => ({ meta: [{ title: `Access · ${params.spaceId} · Shutter admin` }] }),
  component: AccessPage,
});

function AccessPage() {
  const { spaceId } = Route.useParams();
  const detail = useSuspenseQuery(spaceQuery(spaceId)).data;
  const active = detail.space.status === "active";
  const [outcome, setOutcome] = useState<Outcome>({});
  const report = (next: Outcome) =>
    setOutcome((current) => ({ ...current, ...next, error: next.error }));
  const mutations = useAccessMutations(spaceId, report);

  return (
    <main className="mx-auto grid max-w-[1080px] gap-7 px-6 pb-20 pt-10">
      <div className="flex flex-wrap items-baseline gap-4">
        <PageTitle>Access</PageTitle>
        <span className="text-fg-2">
          Applications call Control with a token and sign image requests with a key.
        </span>
      </div>

      {outcome.error === undefined ? null : <Notice tone="error">{outcome.error}</Notice>}
      {outcome.secret === undefined ? null : (
        <SecretReveal label={outcome.secret.label} value={outcome.secret.value} />
      )}

      <section className="grid gap-3">
        <div>
          <SectionTitle>API tokens</SectionTitle>
          <p className="mt-1 text-[13.5px] text-fg-2">{HINTS.apiTokens}</p>
        </div>
        <Tokens detail={detail} active={active} mutations={mutations} report={report} />
      </section>

      <section className="grid gap-3">
        <div>
          <SectionTitle>Capability Keys</SectionTitle>
          <p className="mt-1 text-[13.5px] text-fg-2">{HINTS.capabilityKeys}</p>
        </div>
        <Keys detail={detail} active={active} mutations={mutations} report={report} />
      </section>
    </main>
  );
}

type Mutations = ReturnType<typeof useAccessMutations>;

function Tokens({
  detail,
  active,
  mutations,
  report,
}: {
  detail: AdminSpaceDetail;
  active: boolean;
  mutations: Mutations;
  report: (outcome: Outcome) => void;
}) {
  return (
    <>
      {detail.apiTokens.length === 0 ? (
        <p className="text-fg-2">
          No API tokens.{active ? " Issue one so the application can call Control." : ""}
        </p>
      ) : (
        <List>
          {detail.apiTokens.map((token) => {
            const live = token.revokedAt === undefined;
            return (
              <Row key={token.id} className={cx(!live && "opacity-50")}>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2 font-medium">
                    <span className="[overflow-wrap:anywhere]">{token.label}</span>
                    <Mono className="text-fg-3">{token.displayPrefix}…</Mono>
                  </div>
                  <div className="mt-0.5 text-[13px] text-fg-2">
                    {token.revokedAt !== undefined ? (
                      <>
                        Revoked <Day value={token.revokedAt} />
                      </>
                    ) : token.lastUsedAt === undefined ? (
                      <>
                        Issued <Day value={token.createdAt} />, never used
                      </>
                    ) : (
                      <>
                        Last used <Ago value={token.lastUsedAt} /> · issued{" "}
                        <Day value={token.createdAt} />
                      </>
                    )}
                  </div>
                </div>
                {live && active ? (
                  <Button
                    tone="ghost"
                    size="sm"
                    type="button"
                    disabled={mutations.revokeToken.isPending}
                    onClick={() => mutations.revokeToken.mutate(token.id)}
                  >
                    Revoke
                  </Button>
                ) : (
                  <span />
                )}
              </Row>
            );
          })}
        </List>
      )}
      {active ? (
        <InlineForm
          name="label"
          placeholder="Label for a new token, e.g. production deploy"
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
    </>
  );
}

function Keys({
  detail,
  active,
  mutations,
  report,
}: {
  detail: AdminSpaceDetail;
  active: boolean;
  mutations: Mutations;
  report: (outcome: Outcome) => void;
}) {
  const rotation = keyRotation(detail);
  return (
    <>
      <StateLine tone={rotation.tone} className="text-[13.5px] text-fg-2 [overflow-wrap:anywhere]">
        {rotation.text}
      </StateLine>
      {detail.capabilityKeys.length === 0 ? null : (
        <List>
          {detail.capabilityKeys.map((key) => {
            const live = key.disabledAt === undefined;
            return (
              <Row key={key.id} className={cx(!live && "opacity-50")}>
                <div className="min-w-0">
                  <Mono className="font-medium [overflow-wrap:anywhere]">{key.keyId}</Mono>
                  <div className="mt-0.5 text-[13px] text-fg-2">
                    Accepted since <Day value={key.acceptedAt} />
                    {key.disabledAt === undefined ? null : (
                      <>
                        {" "}
                        · disabled <Day value={key.disabledAt} />
                      </>
                    )}
                  </div>
                </div>
                {live && active ? (
                  <Button
                    tone="ghost"
                    size="sm"
                    type="button"
                    disabled={mutations.disableKey.isPending}
                    onClick={() => mutations.disableKey.mutate(key.keyId)}
                  >
                    Disable
                  </Button>
                ) : (
                  <span />
                )}
              </Row>
            );
          })}
        </List>
      )}
      {active ? (
        <>
          <p className="text-[13px] text-fg-2">
            To rotate: add a key, install it in the application, wait 24 hours, then disable the old
            one. Disable a compromised key immediately.
          </p>
          <InlineForm
            name="keyId"
            placeholder="Identifier for a new key, e.g. k-2026-11"
            ariaLabel="New key identifier"
            maxLength={64}
            pattern="[A-Za-z0-9_-]+"
            action="Add key"
            pending={mutations.addKey.isPending}
            onSubmit={(keyId) => {
              report({ error: undefined });
              mutations.addKey.mutate(keyId);
            }}
          />
        </>
      ) : null}
    </>
  );
}

/** One input, one action, on a single line. */
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
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (value.trim().length === 0) return;
    onSubmit(value.trim());
    setValue("");
  }
  return (
    <form className="flex max-w-[560px] gap-2.5" onSubmit={submit}>
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
