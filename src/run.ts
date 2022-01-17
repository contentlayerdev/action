import { exec } from "@actions/exec";
import * as github from "@actions/github";
import fs from "fs-extra";
import { getPackages, Package } from "@manypkg/get-packages";
import path from "path";
import * as semver from "semver";
import { getChangelogEntry, execWithOutput } from "./utils";
import * as gitUtils from "./gitUtils";
import readChangesetState from "./readChangesetState";
import resolveFrom from "resolve-from";
import crypto from "crypto";

const md5 = (str: string) => crypto.createHash("md5").update(str).digest("hex");

async function getLatestChangelogEntry(filePath: string) {
  const changelog = await fs.readFile(filePath, "utf8");
  const versionHeader = /^## \d+\.\d+\.\d+/gm;

  // we leverage statefulness of `g` regex here for the second `exec` to start of the `lastIndex` from the first match
  const start = versionHeader.exec(changelog)!.index;
  // can't use optional chaining for now because GitHub Actions run on node12, see https://github.com/actions/github-script/pull/182#issuecomment-903966153
  const endExecResult = versionHeader.exec(changelog);
  const end = endExecResult ? endExecResult.index : changelog.length;

  const latestChangelogEntry = changelog.slice(start, end);
  const [match, version] = latestChangelogEntry.match(/## (.+)\s*$/m)!;

  return {
    version,
    content: latestChangelogEntry.slice(match.length).trim(),
  };
}

function getPullFrontmatterData(pullBody: string) {
  const frontmatterMatch = pullBody.match(/\s*---([^]*?)\n\s*---\s*\n/);

  if (!frontmatterMatch) {
    return null;
  }

  const [, frontmatterContent] = frontmatterMatch;
  let draftId = null;
  let checksum = null;
  // TODO: replace with js-yaml
  for (const line of frontmatterContent.split("\n")) {
    const draftIdMatch = line.match(/^draft_id:(.+)/);
    if (draftIdMatch) {
      draftId = parseInt(draftIdMatch[1].trim());
      continue;
    }
    const checksumMatch = line.match(/^checksum:(.+)/);
    if (checksumMatch) {
      checksum = checksumMatch[1].trim();
      continue;
    }
  }

  return {
    draftId:
      typeof draftId === "number" && !Number.isNaN(draftId) ? draftId : null,
    checksum,
  };
}

function createPullFrontmatter({
  draftId,
  checksum,
}: {
  draftId: number;
  checksum: string;
}) {
  return `---\ndraft_id: ${draftId}\nchecksum: ${checksum}\n---`;
}

const createRelease = async (
  octokit: ReturnType<typeof github.getOctokit>,
  { pkg, tagName }: { pkg: Package; tagName: string }
) => {
  try {
    let changelogFileName = path.join(pkg.dir, "CHANGELOG.md");

    let changelog = await fs.readFile(changelogFileName, "utf8");

    let changelogEntry = getChangelogEntry(changelog, pkg.packageJson.version);
    if (!changelogEntry) {
      // we can find a changelog but not the entry for this version
      // if this is true, something has probably gone wrong
      throw new Error(
        `Could not find changelog entry for ${pkg.packageJson.name}@${pkg.packageJson.version}`
      );
    }

    await octokit.repos.createRelease({
      name: tagName,
      tag_name: tagName,
      body: changelogEntry.content,
      prerelease: pkg.packageJson.version.includes("-"),
      ...github.context.repo,
    });
  } catch (err) {
    // if we can't find a changelog, the user has probably disabled changelogs
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
};

type PublishOptions = {
  script: string;
  githubToken: string;
  cwd?: string;
};

type PublishedPackage = { name: string; version: string };

type PublishResult =
  | {
      published: true;
      publishedPackages: PublishedPackage[];
    }
  | {
      published: false;
    };

export async function runPublish({
  script,
  githubToken,
  cwd = process.cwd(),
}: PublishOptions): Promise<PublishResult> {
  let octokit = github.getOctokit(githubToken);
  let [publishCommand, ...publishArgs] = script.split(/\s+/);

  let changesetPublishOutput = await execWithOutput(
    publishCommand,
    publishArgs,
    { cwd }
  );

  await gitUtils.pushTags();

  let { packages, tool } = await getPackages(cwd);
  let releasedPackages: Package[] = [];

  if (tool !== "root") {
    let newTagRegex = /New tag:\s+(@[^/]+\/[^@]+|[^/]+)@([^\s]+)/;
    let packagesByName = new Map(packages.map((x) => [x.packageJson.name, x]));

    for (let line of changesetPublishOutput.stdout.split("\n")) {
      let match = line.match(newTagRegex);
      if (match === null) {
        continue;
      }
      let pkgName = match[1];
      let pkg = packagesByName.get(pkgName);
      if (pkg === undefined) {
        throw new Error(
          `Package "${pkgName}" not found.` +
            "This is probably a bug in the action, please open an issue"
        );
      }
      releasedPackages.push(pkg);
    }

    if (releasedPackages.length) {
      const commit = await gitUtils.getLatestChangesetVersionCommit();
      if (commit) {
        const {
          data: pulls,
        } = await octokit.repos.listPullRequestsAssociatedWithCommit({
          ...github.context.repo,
          commit_sha: commit,
        });
        const pull =
          pulls.sort((a, b) => {
            // sorting algorithm taken from:
            // https://github.com/changesets/changesets/blob/ce637e57ea12cdfbd62ccde1735e1ae2e5f72364/packages/get-github-info/src/index.ts#L179-L192
            if (a.merged_at === null && b.merged_at === null) {
              return 0;
            }
            if (a.merged_at === null) {
              return 1;
            }
            if (b.merged_at === null) {
              return -1;
            }
            const mergedAtA = new Date(a.merged_at);
            const mergedAtB = new Date(b.merged_at);
            return mergedAtA > mergedAtB ? 1 : mergedAtA < mergedAtB ? -1 : 0;
          })[0] || null;
        if (pull) {
          console.log(`Found pull ${pull.id} as the latest versioning PR.`);
          const frontmatterData = getPullFrontmatterData(pull.body || "");
          if (frontmatterData && frontmatterData.draftId) {
            await octokit.repos.updateRelease({
              ...github.context.repo,
              release_id: frontmatterData.draftId,

              // "promote" this release to a published one
              draft: false,
            });
          } else {
            console.log(
              `The PR associated with ${commit} commit doesn't have draft_id.`
            );
          }
        } else {
          console.log(
            `Couldn't find a pull request associated with the ${commit} commit.`
          );
        }
      }
    }
  } else {
    if (packages.length === 0) {
      throw new Error(
        `No package found.` +
          "This is probably a bug in the action, please open an issue"
      );
    }
    let pkg = packages[0];
    let newTagRegex = /New tag:/;

    for (let line of changesetPublishOutput.stdout.split("\n")) {
      let match = line.match(newTagRegex);

      if (match) {
        releasedPackages.push(pkg);
        await createRelease(octokit, {
          pkg,
          tagName: `v${pkg.packageJson.version}`,
        });
        break;
      }
    }
  }

  if (releasedPackages.length) {
    return {
      published: true,
      publishedPackages: releasedPackages.map((pkg) => ({
        name: pkg.packageJson.name,
        version: pkg.packageJson.version,
      })),
    };
  }

  return { published: false };
}

const requireChangesetsCliPkgJson = (cwd: string) => {
  try {
    return require(resolveFrom(cwd, "@changesets/cli/package.json"));
  } catch (err) {
    if (err && err.code === "MODULE_NOT_FOUND") {
      throw new Error(
        `Have you forgotten to install \`@changesets/cli\` in "${cwd}"?`
      );
    }
    throw err;
  }
};

type VersionOptions = {
  script?: string;
  githubToken: string;
  cwd?: string;
  prTitle?: string;
  commitMessage?: string;
  hasPublishScript?: boolean;
};

export async function runVersion({
  script,
  githubToken,
  cwd = process.cwd(),
  prTitle = "Version Packages",
  commitMessage = "Version Packages",
  hasPublishScript = false,
}: VersionOptions) {
  let repo = `${github.context.repo.owner}/${github.context.repo.repo}`;
  let branch = github.context.ref.replace("refs/heads/", "");
  let versionBranch = `changeset-release/${branch}`;
  let octokit = github.getOctokit(githubToken);
  let { preState } = await readChangesetState(cwd);

  await gitUtils.switchToMaybeExistingBranch(versionBranch);
  await gitUtils.reset(github.context.sha);

  if (script) {
    let [versionCommand, ...versionArgs] = script.split(/\s+/);
    await exec(versionCommand, versionArgs, { cwd });
  } else {
    let changesetsCliPkgJson = requireChangesetsCliPkgJson(cwd);
    let cmd = semver.lt(changesetsCliPkgJson.version, "2.0.0")
      ? "bump"
      : "version";
    await exec("node", [resolveFrom(cwd, "@changesets/cli/bin.js"), cmd], {
      cwd,
    });
  }

  let searchQuery = `repo:${repo}+state:open+head:${versionBranch}+base:${branch}`;
  let searchResultPromise = octokit.search.issuesAndPullRequests({
    q: searchQuery,
  });

  const latestChangelogEntry = await getLatestChangelogEntry(
    path.join(cwd, "CHANGELOG.md")
  );

  let prBodyPromise = (async () => {
    return (
      `This PR was opened by the [Changesets release](https://github.com/changesets/action) GitHub action. When you're ready to do a release, you can merge this and ${
        hasPublishScript
          ? `the packages will be published to npm automatically`
          : `publish to npm yourself or [setup this action to publish automatically](https://github.com/changesets/action#with-publishing)`
      }. If you're not ready to do a release yet, that's fine, whenever you add more changesets to ${branch}, this PR will be updated.
${
  !!preState
    ? `
⚠️⚠️⚠️⚠️⚠️⚠️

\`${branch}\` is currently in **pre mode** so this branch has prereleases rather than normal releases. If you want to exit prereleases, run \`changeset pre exit\` on \`${branch}\`.

⚠️⚠️⚠️⚠️⚠️⚠️
`
    : ""
}
# Releases
` + latestChangelogEntry.content
    );
  })();

  const finalPrTitle = `${prTitle}${!!preState ? ` (${preState.tag})` : ""}`;

  // project with `commit: true` setting could have already committed files
  if (!(await gitUtils.checkIfClean())) {
    // remove the Contentlayer CHANGELOG since we don't want to keep it in git
    await fs.unlink(path.join(cwd, "CHANGELOG.md"));

    const finalCommitMessage = `${commitMessage}${
      !!preState ? ` (${preState.tag})` : ""
    }`;
    await gitUtils.commitAll(finalCommitMessage);
  }

  await gitUtils.push(versionBranch, { force: true });

  let searchResult = await searchResultPromise;
  console.log(JSON.stringify(searchResult.data, null, 2));
  if (searchResult.data.items.length === 0) {
    const { data: draftRelease } = await octokit.repos.createRelease({
      ...github.context.repo,
      draft: true,
      name: `v${latestChangelogEntry.version}`,
      // note that this won't create this tag immediately since we are creating a draft
      tag_name: `v${latestChangelogEntry.version}`,
      body: latestChangelogEntry.content,
    });
    console.log("creating pull request");
    prBodyPromise = prBodyPromise.then(
      (body) =>
        `${createPullFrontmatter({
          draftId: draftRelease.id,
          checksum: md5(draftRelease.body),
        })}\n\n${body}`
    );
    await octokit.pulls.create({
      base: branch,
      head: versionBranch,
      title: finalPrTitle,
      body: await prBodyPromise,
      ...github.context.repo,
    });
  } else {
    const pull = searchResult.data.items[0];
    console.log("pull request found");

    const frontmatterData = getPullFrontmatterData(pull.body || "");

    if (
      frontmatterData &&
      frontmatterData.draftId &&
      frontmatterData.checksum
    ) {
      const { draftId, checksum } = frontmatterData;
      const { data: draftRelease } = await octokit.repos.getRelease({
        ...github.context.repo,
        release_id: draftId,
      });
      const releaseContentHash = md5(draftRelease.body);
      if (releaseContentHash === checksum) {
        const { data: updatedRelease } = await octokit.repos.updateRelease({
          ...github.context.repo,
          release_id: draftId,

          draft: true,
          name: `v${latestChangelogEntry.version}`,
          // note that this won't create this tag immediately since we are updating a draft
          tag_name: `v${latestChangelogEntry.version}`,
          body: latestChangelogEntry.content,
        });
        prBodyPromise = prBodyPromise.then(
          (body) =>
            `${createPullFrontmatter({
              draftId,
              checksum: md5(updatedRelease.body),
            })}\n\n${body}`
        );
      } else {
        // preserve whatever there is so the next run of the action can also bail out on the checksum mismatch
        prBodyPromise = prBodyPromise.then(
          (body) => `${createPullFrontmatter({ draftId, checksum })}\n\n${body}`
        );
      }
    } else {
      // we could try preserve the existing frontmatter but if it's missing we can also just ignore it and it shouldn't do much hurm
      console.log("frontmatter not found (or incomplete) in the PR body");
    }

    await octokit.pulls.update({
      pull_number: pull.number,
      title: finalPrTitle,
      body: await prBodyPromise,
      ...github.context.repo,
    });
  }
}
