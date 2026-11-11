const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { chmodSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const entry = join(__dirname, "../dist/index.js");

function launcher(t, script) {
  const path = mkdtempSync(join(tmpdir(), "kast-action-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const python = join(path, "python3");
  writeFileSync(python, script);
  chmodSync(python, 0o700);
  return { PATH: path, NODE: process.execPath };
}

test("Node returns the adapter's exit code", (t) => {
  const env = launcher(t, "#!/bin/sh\nexit 37\n");
  assert.equal(spawnSync(process.execPath, [entry], { env }).status, 37);
});

for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`Node forwards ${signal} to the installer process group`, { timeout: 5000 }, async (t) => {
    const probe = `
      process.on("${signal}", () => {
        process.stdout.write("received\\n", () => process.exit(0));
      });
      console.log(process.pid);
      setInterval(() => {}, 1000);
    `;
    const env = launcher(t, `#!/bin/sh
exec "$NODE" -e 'require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(probe)}], { stdio: "inherit" });'
`);
    const action = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "inherit"] });
    t.after(() => action.kill("SIGKILL"));
    let output = "";
    action.stdout.on("data", (chunk) => { output += chunk; });
    await once(action.stdout, "data");
    const descendant = Number(output.trim());
    assert.ok(Number.isInteger(descendant) && descendant > 0, output);
    let descendantAcknowledged = false;
    t.after(() => {
      if (descendantAcknowledged) return;
      try {
        process.kill(descendant, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    });
    const exited = once(action, "exit");
    const delivered = once(action.stdout, "data");
    assert.ok(action.kill(signal));
    assert.deepEqual(await exited, [status, null]);
    const acknowledgement = await Promise.race([
      delivered.then(([data]) => data.toString()),
      new Promise((resolve) => {
        const deadline = setTimeout(() => resolve("no signal reached the descendant"), 1000);
        deadline.unref();
        void delivered.then(() => clearTimeout(deadline));
      }),
    ]);
    assert.equal(acknowledgement, "received\n");
    descendantAcknowledged = true;
  });
}
