import type { Command } from "../context.js";
import { CliError } from "../io.js";

// A secret is shown once. It goes to stdout alone so `$(shutter token issue …)`
// captures exactly the secret; everything about it goes to stderr.

export async function issueToken(command: Command, spaceId: string): Promise<void> {
  const { client, output, flags } = command;
  if (flags.label === undefined) throw new CliError("--label is required");
  const issued = await client.issueApiToken(spaceId, { label: flags.label });
  if (flags.json) return output.out(JSON.stringify(issued, null, 2));
  output.err(`Issued API token #${issued.apiToken.id} (${issued.apiToken.label}). Shown once:`);
  output.out(issued.secret);
}

export async function revokeToken(command: Command, spaceId: string, id: string): Promise<void> {
  const { client, output, flags } = command;
  if (!/^[1-9]\d*$/u.test(id)) throw new CliError("the token id is the number `space get` shows");
  const revoked = await client.revokeApiToken(spaceId, Number(id));
  output.out(flags.json ? JSON.stringify(revoked, null, 2) : `Revoked API token #${id}.`);
}

export async function addKey(command: Command, spaceId: string, keyId: string): Promise<void> {
  const { client, output, flags } = command;
  const issued = await client.addCapabilityKey(spaceId, { keyId });
  if (flags.json) return output.out(JSON.stringify(issued, null, 2));
  output.err(`Added Capability Key ${issued.capabilityKey.keyId}. Shown once:`);
  output.out(issued.secret);
}

export async function disableKey(command: Command, spaceId: string, keyId: string): Promise<void> {
  const { client, output, flags } = command;
  if (!flags.yes) {
    throw new CliError(
      `every Source Capability minted with ${keyId} stops working at once; pass --yes to confirm`,
    );
  }
  const disabled = await client.disableCapabilityKey(spaceId, keyId);
  output.out(flags.json ? JSON.stringify(disabled, null, 2) : `Disabled Capability Key ${keyId}.`);
}
