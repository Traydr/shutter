import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ControlErrorView } from "../../components/error-view";
import { HINTS } from "../../components/hints";
import {
  Button,
  Card,
  CardFooter,
  Field,
  Input,
  Notice,
  PageTitle,
  StateLine,
  Textarea,
} from "../../components/ui";
import {
  FormInputError,
  type PolicyFields,
  policyFields,
  policyUpdateBody,
} from "../../features/spaces/forms";
import { type Outcome, useSettingsMutations } from "../../features/spaces/space-mutations";
import { spaceKeys, spaceQuery } from "../../features/spaces/spaces-queries";
import { deployment } from "../../features/spaces/summaries";
import { describeFailure } from "../../server/failure";

export const Route = createFileRoute("/_admin/spaces/$spaceId/settings")({
  errorComponent: ControlErrorView,
  head: ({ params }) => ({ meta: [{ title: `Settings · ${params.spaceId} · Shutter admin` }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const { spaceId } = Route.useParams();
  const detail = useSuspenseQuery(spaceQuery(spaceId)).data;
  const { policy } = detail.space;
  const active = detail.space.status === "active";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome>({});
  const report = (next: Outcome) => setOutcome({ ...next });
  const mutations = useSettingsMutations(spaceId, report);
  const [fields, setFields] = useState<PolicyFields>(() => policyFields(policy));
  const [confirm, setConfirm] = useState("");
  const deployed = deployment(detail);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    report({});
    try {
      policyUpdateBody(fields);
    } catch (cause) {
      return report({ error: cause instanceof FormInputError ? cause.message : "Invalid form." });
    }
    mutations.savePolicy.mutate(fields);
  }

  async function decommission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirm !== policy.id) return report({ error: "Type the identifier exactly to confirm." });
    let result: Awaited<ReturnType<typeof mutations.decommission.mutateAsync>>;
    try {
      result = await mutations.decommission.mutateAsync();
    } catch {
      return; // onError reported it
    }
    if (!result.ok) return report({ error: describeFailure(result.failure) });
    await queryClient.invalidateQueries({ queryKey: spaceKeys.all });
    await navigate({ to: "/" });
  }

  return (
    <main className="mx-auto grid max-w-[680px] gap-7 px-6 pb-20 pt-10">
      <div className="flex flex-wrap items-baseline gap-4">
        <PageTitle>Settings</PageTitle>
        {active ? null : <StateLine tone="off">Decommissioned; read-only</StateLine>}
      </div>

      {outcome.saved === true ? (
        <Notice>Saved. The Edge picks it up within a minute.</Notice>
      ) : null}
      {outcome.error === undefined ? null : <Notice tone="error">{outcome.error}</Notice>}

      <Card className="grid gap-6 p-6">
        <Field
          label="Identifier"
          help="Fixed. It appears in every Delivery URL and is never reused."
        >
          <Input mono value={policy.id} disabled />
        </Field>
        <Field label="Route class" help={`${HINTS.routeClass} ${HINTS.fixed}`}>
          <Input value={policy.routeClass === "public" ? "Public" : "Private"} disabled />
        </Field>
      </Card>

      <form onSubmit={submit}>
        <Card className="grid gap-6 p-6">
          <div className="grid gap-6 sm:grid-cols-[1fr_140px]">
            <Field label="Qualities" help={HINTS.qualities}>
              <Input
                mono
                name="qualities"
                required
                disabled={!active}
                value={fields.qualities}
                onChange={(event) => setFields({ ...fields, qualities: event.target.value })}
              />
            </Field>
            <Field label="Default" help={HINTS.defaultQuality}>
              <Input
                mono
                name="defaultQuality"
                required
                inputMode="numeric"
                disabled={!active}
                value={fields.defaultQuality}
                onChange={(event) => setFields({ ...fields, defaultQuality: event.target.value })}
              />
            </Field>
          </div>
          <Field label="Where images may come from" help={HINTS.origins}>
            <Textarea
              mono
              name="allowedSourceOrigins"
              required
              rows={3}
              disabled={!active}
              value={fields.allowedSourceOrigins}
              onChange={(event) =>
                setFields({ ...fields, allowedSourceOrigins: event.target.value })
              }
            />
          </Field>
          <StateLine tone={deployed.tone} className="text-[13.5px] text-fg-2">
            {deployed.text}
          </StateLine>
          {active ? (
            <CardFooter>
              <span>The Edge picks changes up within a minute.</span>
              <Button tone="primary" type="submit" disabled={mutations.savePolicy.isPending}>
                {mutations.savePolicy.isPending ? "Saving…" : "Save"}
              </Button>
            </CardFooter>
          ) : null}
        </Card>
      </form>

      {active ? (
        <form onSubmit={decommission}>
          <Card className="grid gap-4 border-red/40 p-6">
            <div>
              <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-red-fg">
                Decommission
              </h2>
              <p className="mt-1 text-[13.5px] text-fg-2">{HINTS.decommission}</p>
            </div>
            <div className="flex gap-2.5">
              <Input
                mono
                name="confirm"
                required
                placeholder={`Type ${policy.id} to confirm`}
                aria-label="Type the identifier to confirm"
                autoComplete="off"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
              <Button
                tone="danger"
                type="submit"
                disabled={mutations.decommission.isPending || confirm !== policy.id}
              >
                Decommission
              </Button>
            </div>
          </Card>
        </form>
      ) : null}
    </main>
  );
}
