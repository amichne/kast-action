"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const child = (0, node_child_process_1.spawn)("python3", ["-I", (0, node_path_1.join)(__dirname, "..", "bin", "install-kast")], {
    detached: true,
    env: process.env,
    stdio: "inherit",
});
function forward(signal) {
    if (child.pid === undefined)
        return;
    try {
        process.kill(-child.pid, signal);
    }
    catch (error) {
        if (error.code !== "ESRCH")
            throw error;
    }
}
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("error", () => {
    console.error("Setup Kast needs Python 3.12 or 3.13 on PATH.");
    process.exitCode = 1;
});
child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === null ? 1 : 128 + node_os_1.constants.signals[signal]);
});
