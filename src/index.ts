import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, cp, lstat, mkdir, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type InstallContext = {
  version: string;
  artifactUrl: string;
  artifactSha256: string;
  manifestUrl: string;
  authorizationHeader: string;
  artifactAuthorizationHeader: string;
  manifestAuthorizationHeader: string;
  installDir: string;
  gradleCacheUrl: string;
  gradleCacheSha256: string;
  gradleCacheAuthorizationHeader: string;
  failOnCacheMiss: boolean;
  strict: boolean;
  downloadAttempts: number;
  downloadRetryDelayMs: number;
  downloadTimeoutMs: number;
  home: string;
  cacheHome: string;
  configHome: string;
};

async function main(): Promise<void> {
  assertLinuxX64();
  await requireExternalTool("tar", "extract the Kast setup bundle");
  const context = readContext();
  const scratch = await makeScratch();
  try {
    const archive = join(scratch, "kast-setup-bundle.tar.gz");
    await download(context.artifactUrl, archive, context, {
      label: "setup bundle",
      authorizationHeader: context.artifactAuthorizationHeader || context.authorizationHeader,
    });
    await verifyChecksum(archive, context.artifactSha256, "setup bundle");
    const extracted = join(scratch, "bundle");
    await mkdir(extracted, { recursive: true });
    await execFileAsync("tar", ["-xzf", archive, "-C", extracted]);
    const bundle = await findSetupBundle(extracted);
    await execFileAsync(join(bundle, "bin", "kast"), ["setup", "--source", bundle], {
      env: {
        ...process.env,
        KAST_HOME: context.installDir,
        KAST_CACHE_HOME: context.cacheHome,
        KAST_CONFIG_HOME: context.configHome,
      },
    });
    const current = join(context.installDir, "current");
    await exportEnvironment(context, current);
    await installGradleCache(context, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function findSetupBundle(root: string): Promise<string> {
  for (const candidate of [root, ...await findDirectories(root, 2)]) {
    if (
      await lstat(join(candidate, "bin", "kast")).then((stat) => stat.isFile()).catch(() => false)
      && await lstat(join(candidate, "manifest.json")).then((stat) => stat.isFile()).catch(() => false)
    ) return candidate;
  }
  throw new Error("setup bundle must contain bin/kast and manifest.json");
}

function readContext(): InstallContext {
  const home = process.env.HOME && process.env.HOME.trim() ? process.env.HOME : process.cwd();
  assertSingleLineValue("HOME", home);
  const cacheHome = process.env.KAST_CACHE_HOME || join(home, ".cache", "kast");
  const configHome = process.env.KAST_CONFIG_HOME || join(home, ".config", "kast");
  assertSingleLineValue("KAST_CACHE_HOME", cacheHome);
  assertSingleLineValue("KAST_CONFIG_HOME", configHome);
  return {
    version: versionInput(),
    artifactUrl: requiredInput("artifact-url"),
    artifactSha256: requiredInput("artifact-sha256"),
    manifestUrl: optionalInput("manifest-url"),
    authorizationHeader: optionalInput("authorization-header"),
    artifactAuthorizationHeader: optionalInput("artifact-authorization-header"),
    manifestAuthorizationHeader: optionalInput("manifest-authorization-header"),
    installDir: optionalInput("install-dir") || "/opt/kast",
    gradleCacheUrl: optionalInput("gradle-ro-cache-url"),
    gradleCacheSha256: optionalInput("gradle-ro-cache-sha256"),
    gradleCacheAuthorizationHeader: optionalInput("gradle-ro-cache-authorization-header"),
    failOnCacheMiss: booleanInput("fail-on-cache-miss", false),
    strict: booleanInput("strict", true),
    downloadAttempts: numberInput("download-attempts", 3, 1, 10),
    downloadRetryDelayMs: numberInput("download-retry-delay-ms", 1000, 0, 60_000),
    downloadTimeoutMs: numberInput("download-timeout-ms", 120_000, 1000, 600_000),
    home,
    cacheHome,
    configHome,
  };
}

function versionInput(): string {
  const value = requiredInput("version");
  const identifier = "[0-9A-Za-z-]+";
  const dottedIdentifiers = `${identifier}(?:\\.${identifier})*`;
  const semverPattern = new RegExp(
    `^v?(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-${dottedIdentifiers})?(?:\\+${dottedIdentifiers})?$`,
  );
  if (!semverPattern.test(value)) {
    throw new Error(`input version must be a semver path segment like 1.2.3 or v1.2.3, got: ${value}`);
  }
  return value;
}

function inputEnvNames(name: string): string[] {
  const upper = name.toUpperCase();
  return [
    `INPUT_${upper}`,
    `INPUT_${upper.replace(/-/g, "_")}`,
  ];
}

function optionalInput(name: string): string {
  for (const envName of inputEnvNames(name)) {
    const value = process.env[envName];
    if (value !== undefined && value.trim() !== "") {
      assertSingleLineValue(`input ${name}`, value);
      return value.trim();
    }
  }
  return "";
}

function requiredInput(name: string): string {
  const value = optionalInput(name);
  if (!value) {
    throw new Error(`missing required input: ${name}`);
  }
  return value;
}

function booleanInput(name: string, defaultValue: boolean): boolean {
  const raw = optionalInput(name);
  if (!raw) return defaultValue;
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  throw new Error(`input ${name} must be true or false, got: ${raw}`);
}

function numberInput(name: string, defaultValue: number, min: number, max: number): number {
  const raw = optionalInput(name);
  if (!raw) return defaultValue;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`input ${name} must be an integer, got: ${raw}`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`input ${name} must be between ${min} and ${max}, got: ${value}`);
  }
  return value;
}

function assertSingleLineValue(label: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} must not contain line breaks`);
  }
}

function assertLinuxX64(): void {
  const runnerOs = (process.env.RUNNER_OS || process.platform).toLowerCase();
  const runnerArch = (process.env.RUNNER_ARCH || process.arch).toLowerCase();
  const linux = runnerOs === "linux";
  const x64 = runnerArch === "x64" || runnerArch === "x86_64";
  if (!linux || !x64) {
    throw new Error(`unsupported platform: ${runnerOs}/${runnerArch}; setup-kast currently supports linux/x64`);
  }
}

async function requireExternalTool(command: string, purpose: string): Promise<void> {
  try {
    await execFileAsync(command, ["--version"], { timeout: 10_000 });
  } catch (error) {
    throw new Error(`missing required tool '${command}' needed to ${purpose}; install ${command} before running setup-kast: ${messageOf(error)}`);
  }
}

async function installGradleCache(context: InstallContext, scratch: string): Promise<void> {
  if (!context.gradleCacheUrl) {
    return;
  }
  try {
    const archive = join(scratch, "gradle-ro-dep-cache.tar.zst");
    await download(context.gradleCacheUrl, archive, context, {
      label: "Gradle read-only cache",
      authorizationHeader: context.gradleCacheAuthorizationHeader || context.authorizationHeader,
    });
    if (context.gradleCacheSha256) {
      await verifyChecksum(archive, context.gradleCacheSha256, "Gradle read-only cache");
    }
    const extractDir = join(scratch, "gradle-cache-extract");
    await mkdir(extractDir, { recursive: true });
    await assertSafeTarArchive(archive);
    await execFileAsync("tar", ["--zstd", "-xf", archive, "-C", extractDir]);
    await assertNoSymbolicLinks(extractDir);
    const modulesDir = join(extractDir, "gradle-ro", "modules-2");
    await access(modulesDir).catch(() => {
      throw new Error("Gradle read-only cache archive must contain gradle-ro/modules-2");
    });
    await assertNoGradleCacheMetadata(modulesDir);
    const targetRoot = join(context.installDir, "cache", "gradle-ro");
    const preparedRoot = join(scratch, "gradle-cache-prepared");
    await rm(preparedRoot, { recursive: true, force: true });
    await mkdir(preparedRoot, { recursive: true });
    await cp(modulesDir, join(preparedRoot, "modules-2"), { recursive: true, force: true });
    await installTree(preparedRoot, targetRoot);
    await makeReadOnly(targetRoot);
    await mkdir(join(context.home, ".gradle"), { recursive: true });
    await appendGithubEnv("GRADLE_RO_DEP_CACHE", targetRoot);
    await appendGithubEnv("GRADLE_USER_HOME", join(context.home, ".gradle"));
    info(`Gradle read-only cache installed at ${targetRoot}`);
  } catch (error) {
    const message = `Gradle read-only cache was not installed: ${messageOf(error)}`;
    if (context.failOnCacheMiss) {
      throw new Error(message);
    }
    warn(message);
  }
}

async function assertSafeTarArchive(archive: string): Promise<void> {
  const { stdout: members } = await execFileAsync("tar", ["--zstd", "-tf", archive], {
    maxBuffer: 10 * 1024 * 1024,
  });
  for (const rawMember of members.split(/\r?\n/)) {
    const member = rawMember.trim();
    if (!member) continue;
    if (isUnsafeArchiveMember(member)) {
      throw new Error(`unsafe archive member: ${member}`);
    }
  }
  const { stdout: metadata } = await execFileAsync("tar", ["--zstd", "-tvf", archive], {
    maxBuffer: 10 * 1024 * 1024,
  });
  for (const rawLine of metadata.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line) continue;
    const type = line[0];
    if (type !== "-" && type !== "d") {
      throw new Error(`unsafe archive member type '${type}' in: ${line}`);
    }
  }
}

function isUnsafeArchiveMember(member: string): boolean {
  const normalized = member.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    return true;
  }
  return normalized.split("/").some((segment) => segment === "..");
}

async function assertNoSymbolicLinks(root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(directory, entry.name);
      const stats = await lstat(child);
      const relativeChild = child.startsWith(`${resolvedRoot}/`)
        ? child.slice(resolvedRoot.length + 1)
        : child;
      if (stats.isSymbolicLink()) {
        const target = await readlink(child).catch(() => "<unreadable>");
        throw new Error(`unsafe symbolic link in archive: ${relativeChild} -> ${target}`);
      }
      if (stats.isDirectory()) {
        await visit(child);
      }
    }
  }
  await visit(resolvedRoot);
}

async function assertNoGradleCacheMetadata(root: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.name.endsWith(".lock") || entry.name === "gc.properties") {
        throw new Error(`Gradle read-only cache archive contains mutable metadata: ${child}`);
      }
      if (entry.isDirectory()) {
        await visit(child);
      }
    }
  }
  await visit(root);
}

async function findDirectories(root: string, maxDepth: number): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(directory, entry.name);
      result.push(child);
      await visit(child, depth + 1);
    }
  }
  await visit(root, 1);
  return result;
}

async function installTree(source: string, target: string): Promise<void> {
  if (await canWriteManagedPath(dirname(target))) {
    await makeWritable(target).catch(() => undefined);
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
    return;
  }
  await requireSudo();
  await execFileAsync("sudo", ["rm", "-rf", target]);
  await execFileAsync("sudo", ["mkdir", "-p", dirname(target)]);
  await execFileAsync("sudo", ["cp", "-a", source, target]);
}

async function makeReadOnly(target: string): Promise<void> {
  if (await pathExists(target)) {
    if (await canWriteManagedPath(dirname(target))) {
      await execFileAsync("chmod", ["-R", "a-w", target]);
      return;
    }
    await requireSudo();
    await execFileAsync("sudo", ["chmod", "-R", "a-w", target]);
  }
}

async function makeWritable(target: string): Promise<void> {
  if (await pathExists(target)) {
    await execFileAsync("chmod", ["-R", "u+w", target]);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function canWriteManagedPath(directory: string): Promise<boolean> {
  try {
    await mkdir(directory, { recursive: true });
    const probe = join(directory, `.setup-kast-write-test-${process.pid}`);
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function requireSudo(): Promise<void> {
  try {
    await execFileAsync("sudo", ["-n", "true"]);
  } catch {
    throw new Error("install-dir is not writable and passwordless sudo is unavailable");
  }
}

async function exportEnvironment(context: InstallContext, current: string): Promise<void> {
  await mkdir(context.cacheHome, { recursive: true });
  await appendGithubPath(join(current, "bin"));
  await appendGithubEnv("KAST_INSTALL_ROOT", context.installDir);
  await appendGithubEnv("KAST_HOME", context.installDir);
  await appendGithubEnv("KAST_CACHE_HOME", context.cacheHome);
  await appendGithubEnv("KAST_CONFIG_HOME", context.configHome);
}

type DownloadOptions = {
  label: string;
  authorizationHeader: string;
};

async function download(
  source: string,
  destination: string,
  context: InstallContext,
  options: DownloadOptions,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= context.downloadAttempts; attempt += 1) {
    try {
      await downloadOnce(source, destination, context.downloadTimeoutMs, options);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === context.downloadAttempts) {
        break;
      }
      warn(`download attempt ${attempt} failed for ${options.label}: ${messageOf(error)}`);
      await sleep(context.downloadRetryDelayMs);
    }
  }
  throw new Error(`download failed for ${options.label} after ${context.downloadAttempts} attempts: ${messageOf(lastError)}`);
}

async function downloadOnce(
  source: string,
  destination: string,
  timeoutMs: number,
  options: DownloadOptions,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  if (source.startsWith("file://")) {
    await copyFile(fileURLToPath(source), destination);
    return;
  }
  if (/^\//.test(source)) {
    await copyFile(source, destination);
    return;
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`invalid URL for ${options.label}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL protocol for ${options.label}: ${url.protocol}`);
  }
  const headers = options.authorizationHeader
    ? { Authorization: options.authorizationHeader }
    : undefined;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("HTTP response did not include a body");
  }
  const temporaryDestination = `${destination}.download-${process.pid}-${Date.now()}`;
  try {
    const body = response.body as unknown as Parameters<typeof Readable.fromWeb>[0];
    await pipeline(
      Readable.fromWeb(body),
      createWriteStream(temporaryDestination, { flags: "w" }),
    );
    await rename(temporaryDestination, destination);
  } catch (error) {
    await rm(temporaryDestination, { force: true });
    throw error;
  }
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function verifyChecksum(path: string, expected: string, label: string): Promise<string> {
  const actual = await sha256File(path);
  const normalized = normalizeChecksum(expected);
  if (actual !== normalized) {
    throw new Error(`${label} checksum mismatch: expected ${normalized}, got ${actual}`);
  }
  return actual;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function normalizeChecksum(value: string): string {
  const token = value.trim().replace(/^sha256:/i, "").split(/\s+/)[0]?.toLowerCase() || "";
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error(`invalid SHA-256 digest: ${value}`);
  }
  return token;
}

async function appendGithubEnv(name: string, value: string): Promise<void> {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid GITHUB_ENV variable name: ${name}`);
  }
  const target = process.env.GITHUB_ENV;
  if (!target) {
    warn(`GITHUB_ENV is unset; cannot persist ${name}`);
    return;
  }
  const delimiter = githubEnvDelimiter(name, value);
  await appendLine(target, `${name}<<${delimiter}\n${value}\n${delimiter}`);
}

async function appendGithubPath(value: string): Promise<void> {
  assertSingleLineValue("GITHUB_PATH entry", value);
  const target = process.env.GITHUB_PATH;
  if (!target) {
    warn("GITHUB_PATH is unset; cannot persist PATH update");
    return;
  }
  await appendLine(target, value);
}

function githubEnvDelimiter(name: string, value: string): string {
  let attempt = 0;
  while (true) {
    const digest = createHash("sha256")
      .update(name)
      .update("\0")
      .update(value)
      .update("\0")
      .update(String(attempt))
      .digest("hex");
    const delimiter = `setup_kast_${digest}`;
    if (!value.includes(delimiter)) {
      return delimiter;
    }
    attempt += 1;
  }
}

async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${line}\n`, { flag: "a", encoding: "utf8" });
}

async function makeScratch(): Promise<string> {
  const root = resolve(tmpdir(), `setup-kast-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  return root;
}

function info(message: string): void {
  process.stderr.write(`${message}\n`);
}

function warn(message: string): void {
  process.stderr.write(`::warning::${message}\n`);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const details = [error.message];
    const commandError = error as Error & {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    const code = commandError.code;
    if (code !== undefined && code !== null) {
      details.push(`exit code: ${String(code)}`);
    }
    const stderr = outputSnippet(commandError.stderr);
    if (stderr) {
      details.push(`stderr:\n${stderr}`);
    }
    const stdout = outputSnippet(commandError.stdout);
    if (stdout) {
      details.push(`stdout:\n${stdout}`);
    }
    return details.join("\n");
  }
  return String(error);
}

function outputSnippet(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const limit = 4000;
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}\n... truncated ...`;
}

main().catch((error) => {
  process.stderr.write(`setup-kast failed: ${messageOf(error)}\n`);
  process.exitCode = 1;
});
