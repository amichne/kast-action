import * as actionsExec from "@actions/exec";
import * as core from "@actions/core";
import * as fs from "fs";
import * as io from "@actions/io";
import * as os from "os";
import * as path from "path";
import * as tc from "@actions/tool-cache";

const TOOL_NAME = "kast-headless-agent";
const PLATFORM_ID = "linux-x64";

export interface InstallOptions {
  version: string;
  token: string;
  installRoot: string;
  workspace: string;
  skipCopilotExtension: boolean;
}

export interface InstallResult {
  installRoot: string;
  binDir: string;
  kastBin: string;
  configHome: string;
}

export interface InstallerDependencies {
  findTool(toolName: string, version: string): string;
  downloadTool(url: string, dest?: string, auth?: string, headers?: Record<string, string>): Promise<string>;
  extractZip(archivePath: string): Promise<string>;
  cacheDir(sourceDir: string, toolName: string, version: string): Promise<string>;
  exec(tool: string, args: string[], options?: actionsExec.ExecOptions): Promise<number>;
  mkdirP(target: string): Promise<void>;
  existsSync(target: string): boolean;
  homedir(): string;
  cwd(): string;
  env: NodeJS.ProcessEnv;
}

export async function installKast(
  options: InstallOptions,
  dependencies: InstallerDependencies = defaultDependencies(),
): Promise<InstallResult> {
  const { version, token, skipCopilotExtension } = options;
  const installRoot = resolveUserPath(
    options.installRoot || path.join(dependencies.homedir(), ".kast-agent"),
    dependencies.homedir(),
  );
  const workspace = resolveUserPath(
    options.workspace || dependencies.env.GITHUB_WORKSPACE || dependencies.cwd(),
    dependencies.homedir(),
  );

  let bundleDir = dependencies.findTool(TOOL_NAME, stripLeadingV(version));
  if (!bundleDir) {
    core.info(`Kast ${version} not found in tool cache, downloading...`);
    bundleDir = await downloadAndCache(version, token, dependencies);
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
  version: string,
  token: string,
  dependencies: InstallerDependencies = defaultDependencies(),
): Promise<string> {
  const assetName = `kast-headless-agent-${version}-${PLATFORM_ID}.zip`;
  const downloadUrl = `https://github.com/amichne/kast/releases/download/${version}/${assetName}`;
  const auth = token ? `token ${token}` : undefined;

  core.info(`Downloading: ${downloadUrl}`);
  const archivePath = await dependencies.downloadTool(downloadUrl, undefined, auth, {
    accept: "application/octet-stream",
  });

  core.info("Extracting bundle...");
  const extractedDir = await dependencies.extractZip(archivePath);
  const cachedDir = await dependencies.cacheDir(extractedDir, TOOL_NAME, stripLeadingV(version));
  core.info(`Cached Kast ${version} in tool cache at ${cachedDir}`);

  return cachedDir;
}

export function stripLeadingV(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
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

function defaultDependencies(): InstallerDependencies {
  return {
    findTool: tc.find,
    downloadTool: tc.downloadTool,
    extractZip: tc.extractZip,
    cacheDir: tc.cacheDir,
    exec: actionsExec.exec,
    mkdirP: io.mkdirP,
    existsSync: fs.existsSync,
    homedir: os.homedir,
    cwd: process.cwd,
    env: process.env,
  };
}
