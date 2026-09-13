import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AppHeader } from "../../components/header";
import { HINTS } from "../../components/hints";
import {
  Button,
  Card,
  CardFooter,
  Field,
  INPUT_CLASS,
  Input,
  Notice,
  PageTitle,
  Textarea,
  TextLink,
} from "../../components/ui";
import { createSpaceBody, FormInputError } from "../../features/spaces/forms";
import { spaceKeys } from "../../features/spaces/spaces-queries";
import { createSpace } from "../../features/spaces/spaces-service";
import { describeFailure, describeThrown } from "../../server/failure";

export const Route = createFileRoute("/_admin/spaces/new")({
  head: () => ({ meta: [{ title: "New Space · Shutter admin" }] }),
  component: NewSpacePage,
});

function NewSpacePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | undefined>(undefined);
  const [fields, setFields] = useState({
    id: "",
    routeClass: "private",
    qualities: "60, 75, 90",
    defaultQuality: "75",
    allowedSourceOrigins: "",
  });
  const create = useMutation({
    mutationFn: async (body: ReturnType<typeof createSpaceBody>) => createSpace({ data: { body } }),
    onError: (cause) => setError(describeThrown(cause)),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(describeFailure(result.failure));
        return;
      }
      await queryClient.invalidateQueries({ queryKey: spaceKeys.all });
      await navigate({ to: "/spaces/$spaceId", params: { spaceId: result.value.space.policy.id } });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try {
      create.mutate(createSpaceBody(fields));
    } catch (cause) {
      setError(cause instanceof FormInputError ? cause.message : "The form could not be read.");
    }
  }

  return (
    <>
      <AppHeader crumbs={[{ label: "new" }]} />
      <main className="mx-auto grid max-w-[680px] gap-7 px-6 pb-20 pt-10">
        <div>
          <TextLink to="/" className="text-[13.5px]">
            ← Spaces
          </TextLink>
          <PageTitle>
            <span className="mt-2 block">New Space</span>
          </PageTitle>
          <p className="mt-1.5 text-fg-2">
            One application's images: where they come from and who may ask for them.
          </p>
        </div>
        <form onSubmit={submit}>
          <Card className="grid gap-6 p-6">
            <Field label="Identifier" help={HINTS.identifier}>
              <Input
                mono
                name="spaceId"
                required
                pattern="[a-z0-9][a-z0-9_-]*"
                maxLength={64}
                placeholder="my-app"
                value={fields.id}
                onChange={(event) => setFields({ ...fields, id: event.target.value })}
              />
            </Field>
            <Field label="Route class" help={HINTS.routeClass}>
              <select
                name="routeClass"
                className={INPUT_CLASS}
                value={fields.routeClass}
                onChange={(event) => setFields({ ...fields, routeClass: event.target.value })}
              >
                <option value="private">Private</option>
                <option value="public">Public</option>
              </select>
            </Field>
            <div className="grid gap-6 sm:grid-cols-[1fr_140px]">
              <Field label="Qualities" help={HINTS.qualities}>
                <Input
                  mono
                  name="qualities"
                  required
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
                placeholder={
                  "https://uploads.example.com\nhttps://account.r2.cloudflarestorage.com/bucket"
                }
                value={fields.allowedSourceOrigins}
                onChange={(event) =>
                  setFields({ ...fields, allowedSourceOrigins: event.target.value })
                }
              />
            </Field>
            {error === undefined ? null : <Notice tone="error">{error}</Notice>}
            <CardFooter>
              <span>Identifier and route class can't change later. Sources come next.</span>
              <Button tone="primary" type="submit" disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create Space"}
              </Button>
            </CardFooter>
          </Card>
        </form>
      </main>
    </>
  );
}
