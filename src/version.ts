import * as core from "@actions/core";
import * as github from "@actions/github";

export function normalizeVersion(requested: string): string {
  const trimmed = requested.trim();
  if (!trimmed) {
    throw new Error("Kast version must not be empty");
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export async function resolveActionVersion(
  requested: string,
  token: string,
  bundleUrl: string,
): Promise<string> {
  if (bundleUrl.trim()) {
    if (requested === "latest") {
      throw new Error("bundle-url requires a pinned Kast version; set version to vX.Y.Z");
    }
    return normalizeVersion(requested);
  }

  return resolveVersion(requested, token);
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
