import * as actionsExec from "@actions/exec";
import * as core from "@actions/core";
import * as crypto from "crypto";
import * as fs from "fs";
import * as io from "@actions/io";
import * as os from "os";
import * as path from "path";
import * as tc from "@actions/tool-cache";

const TOOL_NAME = "kast-headless-agent";
const DEFAULT_PLATFORM_ID = "linux-x64";

export interface InstallOptions {
  version: string;
  token: string;
  installRoot: string;
  workspace: string;
  skipCopilotExtension: boolean;
  platform?: string;
  bundleUrl?: string;
  bundleSha256?: string;
}

export interface InstallResult {
  installRoot: string;
  binDir: string;
  kastBin: string;
  configHome: string;
}

export interface InstallerDependencies {
  findTool(toolName: string, version: string, arch?: string): string;
  downloadTool(url: string, dest?: string, auth?: string, headers?: Record<string, string>): Promise<string>;
  extractZip(archivePath: string): Promise<string>;
  cacheDir(sourceDir: string, toolName: string, version: string, arch?: string): Promise<string>;
  exec(tool: string, args: string[], options?: actionsExec.ExecOptions): Promise<number>;
  mkdirP(target: string): Promise<void>;
  existsSync(target: string): boolean;
  readFileSync(target: string): Buffer;
  homedir(): string;
  cwd(): string;
  env: NodeJS.ProcessEnv;
}

export interface DownloadOptions {
  version: string;
  token: string;
  platform?: string;
  bundleUrl?: string;
  bundleSha256?: string;
}

export async function installKast(
  options: InstallOptions,
  dependencies: InstallerDependencies = defaultDependencies(),
): Promise<InstallResult> {
  const { version, token, skipCopilotExtension } = options;
  const platform = normalizePlatform(options.platform);
  const bundleSha256 = normalizeOptionalSha256(options.bundleSha256);
  const cacheVersion = stripLeadingV(version);
  const cacheArch = cacheArchFor(platform, bundleSha256);
  const installRoot = resolveUserPath(
    options.installRoot || path.join(dependencies.homedir(), ".kast-agent"),
    dependencies.homedir(),
  );
  const workspace = resolveUserPath(
    options.workspace || dependencies.env.GITHUB_WORKSPACE || dependencies.cwd(),
    dependencies.homedir(),
  );

  let bundleDir = dependencies.findTool(TOOL_NAME, cacheVersion, cacheArch);
  if (!bundleDir) {
    core.info(`Kast ${version} not found in tool cache, downloading...`);
    bundleDir = await downloadAndCache(
      {
        version,
        token,
        platform,
        bundleUrl: options.bundleUrl,
        bundleSha256,
      },
      dependencies,
    );
  } else {
    core.info(`Kast ${version} found in tool cache`);
  }

  const installScript = path.join(bundleDir, "install.sh");
  if (!dependencies.existsSync(installScript)) {
    throw new Error(`install.sh not found in bundle at ${installScript}`);
  }

  await dependencies.mkdirP(installRoot);
  await dependencies.mkdirP(workspace);

  const gitDir = path.join(workspace, ".git");
  if (!dependencies.existsSync(gitDir)) {
    core.info(`Initializing git repo at ${workspace} (required by installer)`);
    await dependencies.exec("git", ["init", "-q"], { cwd: workspace });
  }

  const env: Record<string, string> = {
    ...definedEnv(dependencies.env),
    KAST_AGENT_INSTALL_ROOT: installRoot,
    KAST_AGENT_WORKSPACE: workspace,
    KAST_AGENT_VERSION: version,
    KAST_INSTALL_SOURCE: "action",
    HOME: dependencies.homedir(),
    SHELL: dependencies.env.SHELL || "/bin/bash",
  };

  if (skipCopilotExtension) {
    env.KAST_SKIP_COPILOT_EXTENSION = "true";
  }

  core.info(`Running installer: ${installScript}`);
  const exitCode = await dependencies.exec("bash", [installScript], {
    cwd: workspace,
    env,
  });

  if (exitCode !== 0) {
    throw new Error(`Kast installer exited with code ${exitCode}`);
  }

  const binDir = path.join(installRoot, "bin");
  const kastBin = path.join(binDir, "kast");
  const configHome = path.join(installRoot, "config");

  if (!dependencies.existsSync(kastBin)) {
    throw new Error(`kast binary not found at ${kastBin} after installation`);
  }

  await dependencies.exec(kastBin, ["--help"], { silent: true });
  return { installRoot, binDir, kastBin, configHome };
}

export async function downloadAndCache(
  options: DownloadOptions,
  dependencies: InstallerDependencies = defaultDependencies(),
): Promise<string> {
  const version = options.version;
  const token = options.token;
  const platform = normalizePlatform(options.platform);
  const bundleUrl = options.bundleUrl?.trim() || "";
  const bundleSha256 = normalizeOptionalSha256(options.bundleSha256);

  if (bundleUrl && version === "latest") {
    throw new Error("bundle-url requires a pinned Kast version; set version to vX.Y.Z");
  }
  if (bundleUrl && !bundleSha256) {
    throw new Error("bundle-sha256 is required when bundle-url is set");
  }

  const assetName = `kast-headless-agent-${version}-${platform}.zip`;
  const downloadUrl = bundleUrl || `https://github.com/amichne/kast/releases/download/${version}/${assetName}`;
  const auth = authForDownload(downloadUrl, token, bundleUrl.length > 0, dependencies);

  core.info(`Downloading: ${downloadUrl}`);
  const archivePath = await dependencies.downloadTool(downloadUrl, undefined, auth, {
    accept: "application/octet-stream",
  });

  if (bundleSha256) {
    verifySha256(archivePath, bundleSha256, dependencies);
  }

  core.info("Extracting bundle...");
  const extractedDir = await dependencies.extractZip(archivePath);
  const cachedDir = await dependencies.cacheDir(
    extractedDir,
    TOOL_NAME,
    stripLeadingV(version),
    cacheArchFor(platform, bundleSha256),
  );
  core.info(`Cached Kast ${version} in tool cache at ${cachedDir}`);

  return cachedDir;
}

export function stripLeadingV(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

export function normalizePlatform(platform: string | undefined): string {
  const normalized = platform?.trim() || DEFAULT_PLATFORM_ID;
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid platform identifier: ${platform}`);
  }
  return normalized;
}

export function normalizeOptionalSha256(input: string | undefined): string | undefined {
  const normalized = input?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("bundle-sha256 must be a 64-character hexadecimal SHA-256 digest");
  }
  return normalized;
}

export function resolveUserPath(input: string, homeDir: string): string {
  const trimmed = input.trim();
  const expanded = trimmed === "~"
    ? homeDir
    : trimmed.startsWith("~/")
      ? path.join(homeDir, trimmed.slice(2))
      : trimmed;
  return path.resolve(expanded);
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function cacheArchFor(platform: string, bundleSha256: string | undefined): string {
  return bundleSha256 ? `${platform}-${bundleSha256}` : platform;
}

function verifySha256(
  archivePath: string,
  expectedSha256: string,
  dependencies: InstallerDependencies,
): void {
  const actual = crypto
    .createHash("sha256")
    .update(dependencies.readFileSync(archivePath))
    .digest("hex");

  if (actual !== expectedSha256) {
    throw new Error(`Checksum mismatch for downloaded Kast bundle: expected ${expectedSha256}, got ${actual}`);
  }

  core.info("Verified bundle SHA-256");
}

function authForDownload(
  downloadUrl: string,
  token: string,
  isExplicitBundleUrl: boolean,
  dependencies: InstallerDependencies,
): string | undefined {
  if (!token) {
    return undefined;
  }
  if (!isExplicitBundleUrl) {
    return `token ${token}`;
  }

  const serverUrl = dependencies.env.GITHUB_SERVER_URL || "https://github.com";
  if (sameOrigin(downloadUrl, serverUrl)) {
    return `token ${token}`;
  }

  core.info("Not attaching GitHub token to bundle-url because it does not match GITHUB_SERVER_URL");
  return undefined;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function defaultDependencies(): InstallerDependencies {
  return {
    findTool: tc.find,
    downloadTool: tc.downloadTool,
    extractZip: tc.extractZip,
    cacheDir: tc.cacheDir,
    exec: actionsExec.exec,
    mkdirP: io.mkdirP,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    homedir: os.homedir,
    cwd: process.cwd,
    env: process.env,
  };
}
