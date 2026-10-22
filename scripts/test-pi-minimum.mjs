import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const temporaryPrefix = "power-copilot-pi-minimum-";
const dependencies = [
  "@earendil-works/pi-ai@0.87.1",
  "@earendil-works/pi-coding-agent@0.87.1",
];
const testFiles = [
  "test/anthropic-auth.test.ts",
  "test/auth.test.ts",
  "test/catalog.test.ts",
  "test/context-window.test.ts",
  "test/oauth.test.ts",
];

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) {
    console.error(result.error);
    return 1;
  }
  if (result.signal) {
    console.error(`Child process terminated by ${result.signal}`);
    return result.signal === "SIGINT" ? 130 : result.signal === "SIGTERM" ? 143 : 1;
  }
  return result.status ?? 1;
}

async function main() {
  const temporaryParent = await realpath(tmpdir());
  const temporary = await mkdtemp(join(temporaryParent, temporaryPrefix));
  const createdRealPath = await realpath(temporary);
  let exitCode = 0;
  try {
    console.log(`Pi minimum-version test project: ${createdRealPath}`);
    // Do not copy the workspace manifest, lockfile, node_modules, or development overrides.
    await writeFile(join(temporary, "package.json"), JSON.stringify({
      name: "power-copilot-pi-minimum-test", private: true, type: "module",
    }, null, 2) + "\n");
    await cp(join(repository, "src"), join(temporary, "src"), { recursive: true });
    await mkdir(join(temporary, "test"));
    for (const file of testFiles) await cp(join(repository, file), join(temporary, file));

    const agentDirectory = join(temporary, "agent");
    const homeDirectory = join(temporary, "home");
    const appData = join(homeDirectory, "AppData", "Roaming");
    const localAppData = join(homeDirectory, "AppData", "Local");
    await Promise.all([agentDirectory, appData, localAppData].map(path => mkdir(path, { recursive: true })));

    // Downloads are the only permitted network activity. No package install scripts run.
    const installArgs = ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...dependencies];
    exitCode = process.platform === "win32"
      ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm ${installArgs.join(" ")}`], temporary, process.env)
      : run("npm", installArgs, temporary, process.env);
    if (exitCode !== 0) return exitCode;

    // Each test supplies synthetic credentials and mocks fetch. Reject accidental real I/O.
    await writeFile(join(temporary, "network-guard.mjs"), `import net from "node:net";
const deny = () => { throw new Error("Pi minimum-version tests must not access the network"); };
globalThis.fetch = deny;
net.Socket.prototype.connect = deny;
`);
    const testEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDirectory,
      HOME: homeDirectory,
      USERPROFILE: homeDirectory,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      XDG_CONFIG_HOME: join(homeDirectory, ".config"),
      NODE_OPTIONS: "",
    };
    // Do not pass actual provider secrets into the isolated test process.
    for (const name of Object.keys(testEnv)) {
      if (/(?:TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL)/i.test(name)) delete testEnv[name];
    }
    console.log(`Run original Pi tests against ${dependencies.join(" and ")}`);
    exitCode = run(process.execPath, [
      "--experimental-strip-types", "--import", "./network-guard.mjs", "--test", ...testFiles,
    ], temporary, testEnv);
    return exitCode;
  } catch (error) {
    console.error(error);
    return exitCode || 1;
  } finally {
    try {
      // Resolve and verify the exact mkdtemp target before any recursive deletion.
      const target = await realpath(temporary);
      if (target !== createdRealPath || dirname(target) !== temporaryParent
        || !basename(target).startsWith(temporaryPrefix) || target === resolve(repository)) {
        throw new Error(`Refusing to remove an unexpected temporary path: ${target}`);
      }
      console.log(`Remove verified temporary test project: ${target}`);
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      console.error(error);
      // A cleanup failure must fail an otherwise successful run without hiding a test exit code.
      process.exitCode = exitCode || 1;
    }
  }
}

const exitCode = await main();
process.exitCode = process.exitCode || exitCode;
