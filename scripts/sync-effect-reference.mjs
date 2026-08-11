import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockfile = await readFile(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
const versions = new Set(
  [...lockfile.matchAll(/^ {2}effect@([^:\s(]+)(?:\([^)]*\))?:$/gmu)].map((match) => match[1]),
);

if (versions.size !== 1) {
  throw new Error(`expected exactly one Effect version in pnpm-lock.yaml, found ${versions.size}`);
}

const [effectVersion] = versions;
if (effectVersion === undefined) throw new Error("Effect version is missing from pnpm-lock.yaml");

const reposDirectory = join(repositoryRoot, "repos");
const targetDirectory = join(reposDirectory, "effect");
await mkdir(reposDirectory, { recursive: true });
const temporaryRoot = await mkdtemp(join(tmpdir(), "shutter-effect-reference-"));
const temporaryClone = join(temporaryRoot, "effect");

try {
  await new Promise((resolveClone, rejectClone) => {
    const child = spawn(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        `effect@${effectVersion}`,
        "https://github.com/Effect-TS/effect.git",
        temporaryClone,
      ],
      { stdio: "inherit" },
    );
    child.once("error", rejectClone);
    child.once("exit", (code) =>
      code === 0 ? resolveClone() : rejectClone(new Error(`git clone exited with code ${code}`)),
    );
  });
  await rm(targetDirectory, { recursive: true, force: true });
  await rename(temporaryClone, targetDirectory);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(`Effect reference synchronized to effect@${effectVersion}`);
