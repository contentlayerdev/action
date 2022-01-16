import fs from "fs";
import path from "path";
import { exec } from "@actions/exec";
import { execWithOutput } from "./utils";

export const setupUser = async () => {
  await exec("git", ["config", "user.name", `"github-actions[bot]"`]);
  await exec("git", [
    "config",
    "user.email",
    `"github-actions[bot]@users.noreply.github.com"`,
  ]);
};

export const pullBranch = async (branch: string) => {
  await exec("git", ["pull", "origin", branch]);
};

export const push = async (
  branch: string,
  { force }: { force?: boolean } = {}
) => {
  await exec(
    "git",
    ["push", "origin", `HEAD:${branch}`, force && "--force"].filter<string>(
      Boolean as any
    )
  );
};

export const pushTags = async () => {
  await exec("git", ["push", "origin", "--tags"]);
};

export const switchToMaybeExistingBranch = async (branch: string) => {
  let { stderr } = await execWithOutput("git", ["checkout", branch], {
    ignoreReturnCode: true,
  });
  let isCreatingBranch = !stderr
    .toString()
    .includes(`Switched to a new branch '${branch}'`);
  if (isCreatingBranch) {
    await exec("git", ["checkout", "-b", branch]);
  }
};

export const reset = async (
  pathSpec: string,
  mode: "hard" | "soft" | "mixed" = "hard"
) => {
  await exec("git", ["reset", `--${mode}`, pathSpec]);
};

export const commitAll = async (message: string) => {
  await exec("git", ["add", "."]);
  await exec("git", ["commit", "-m", message]);
};

export const checkIfClean = async (): Promise<boolean> => {
  const { stdout } = await execWithOutput("git", ["status", "--porcelain"]);
  return !stdout.length;
};

export const getLatestChangesetVersionCommit = async (): Promise<
  string | null
> => {
  while (true) {
    const commitHash = (
      await execWithOutput("git", [
        "log",
        "--max-count=1",
        "--diff-filter=D",
        "--pretty=format:%h",
        "--",
        ".changeset/*.md",
      ])
    ).stdout.trim();

    if (commitHash) {
      return commitHash;
    }

    if (!(await isRepoShallow({ cwd: process.cwd() }))) {
      return null;
    }

    await deepenCloneBy({ by: 50, cwd: process.cwd() });
  }
};

export async function isRepoShallow({ cwd }: { cwd: string }) {
  const isShallowRepoOutput = (
    await execWithOutput("git", ["rev-parse", "--is-shallow-repository"], {
      cwd,
    })
  ).stdout.trim();

  if (isShallowRepoOutput === "--is-shallow-repository") {
    // We have an old version of Git (<2.15) which doesn't support `rev-parse --is-shallow-repository`
    // In that case, we'll test for the existence of .git/shallow.

    // Firstly, find the .git folder for the repo; note that this will be relative to the repo dir
    const gitDir = (
      await execWithOutput("git", ["rev-parse", "--git-dir"], { cwd })
    ).stdout.trim();

    const fullGitDir = path.resolve(cwd, gitDir);

    // Check for the existence of <gitDir>/shallow
    return fs.existsSync(path.join(fullGitDir, "shallow"));
  } else {
    // We have a newer Git which supports `rev-parse --is-shallow-repository`. We'll use
    // the output of that instead of messing with .git/shallow in case that changes in the future.
    return isShallowRepoOutput === "true";
  }
}

export async function deepenCloneBy({ by, cwd }: { by: number; cwd: string }) {
  await exec("git", ["fetch", `--deepen=${by}`], { cwd });
}
