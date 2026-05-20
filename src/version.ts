import * as core from "@actions/core";
import * as github from "@actions/github";

export function normalizeVersion(requested: string): string {
  return requested.startsWith("v") ? requested : `v${requested}`;
}

export async function resolveVersion(requested: string, token: string): Promise<string> {
  if (requested !== "latest") {
    return normalizeVersion(requested);
  }

  core.info("Resolving latest Kast release...");
  const octokit = github.getOctokit(token);
  const { data: release } = await octokit.rest.repos.getLatestRelease({
    owner: "amichne",
    repo: "kast",
  });

  core.info(`Latest release: ${release.tag_name}`);
  return release.tag_name;
}
