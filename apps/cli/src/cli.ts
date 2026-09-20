#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { createAdminApiClient } from "@shutter/admin-api";
import { fileCredentialStore } from "./config.js";
import { processOutput, prompt } from "./io.js";
import { run } from "./main.js";

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  output: processOutput,
  credentials: fileCredentialStore(process.env),
  connect: ({ url, token }) => createAdminApiClient({ baseUrl: url, token }),
  readInput: (path) => (path === "-" ? text(process.stdin) : readFile(path, "utf8")),
  prompt,
});
