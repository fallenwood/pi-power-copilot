import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type ExecFileOptions } from "node:child_process";
import test, { type TestContext } from "node:test";
import type { ApiKeyCredential, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import {
  isGitHubCliCredential,
  loginPowerCopilotWithGitHubCli,
  readGitHubCliToken,
  refreshPowerCopilotWithGitHubCli,
  resolveGitHubCliAuth,
  resolveLegacyGitHubCliAuth,
} from "../src/github-cli.ts";

type Command = {
  file: string;
  args: readonly string[];
  options: ExecFileOptions;
  callback: (error: Error | null, stdout: string, stderr: string) => void;
};

// Always intercept the executable boundary: these tests must never run the real gh.
function mockCommand(t: TestContext, complete: (command: Command) => void): Command[] {
  const calls: Command[] = [];
  t.mock.method(childProcess, "execFile", ((file: string, args: readonly string[],
    options: ExecFileOptions, callback: Command["callback"]) => {
    const command = { file, args, options, callback };
    calls.push(command);
    complete(command);
    return {} as ChildProcess;
  }) as unknown as typeof childProcess.execFile);
  return calls;
}

function interaction(domain = "", signal = new AbortController().signal) {
  const prompts: Array<{ type: string }> = [];
  const notices: Array<{ type: string }> = [];
  const value: ProviderAuthInteraction = {
    signal,
    async prompt(prompt) { prompts.push(prompt); return domain; },
    notify(event) { notices.push(event); },
  };
  return { value, prompts, notices };
}

function forbidFetch(t: TestContext) {
  return t.mock.method(globalThis, "fetch", async () => {
    assert.fail("CLI credentials must not call device, exchange, or catalog endpoints");
  });
}

function cliCredential(hostname?: string): ApiKeyCredential {
  return {
    type: "api_key",
    env: {
      POWER_COPILOT_AUTH_SOURCE: "github-cli",
      ...(hostname === undefined ? {} : { POWER_COPILOT_GITHUB_HOST: hostname }),
    },
  };
}

function assertPrivateError(error: unknown, secret: string): asserts error is Error {
  assert.ok(error instanceof Error);
  assert.ok(!error.message.includes(secret));
  assert.ok(!error.stack?.includes(secret));
  assert.ok(!JSON.stringify(error).includes(secret));
  assert.equal(error.cause, undefined);
}

test("reads gh token with fixed argv, a deadline, an output bound, and the caller signal", async (t) => {
  const signal = new AbortController().signal;
  const calls = mockCommand(t, ({ callback }) => callback(null, "gho_test-token\r\n", "ignored warning"));
  assert.equal(await readGitHubCliToken("github.com", signal), "gho_test-token");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "gh");
  assert.deepEqual(calls[0].args, ["auth", "token", "--hostname", "github.com"]);
  assert.equal(calls[0].options.encoding, "utf8");
  assert.equal(calls[0].options.timeout, 10000);
  assert.equal(calls[0].options.maxBuffer, 16384);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.signal, signal);
  assert.ok(!calls[0].options.shell);
});

for (const [label, output] of [
  ["empty", ""], ["whitespace", "  \r\n"], ["multiple lines", "token-one\ntoken-two"],
  ["internal whitespace", "token one"],
]) {
  test(`rejects ${label} CLI output without echoing it`, async (t) => {
    mockCommand(t, ({ callback }) => callback(null, output, "private stderr"));
    await assert.rejects(readGitHubCliToken("github.com", new AbortController().signal), (error: unknown) => {
      assertPrivateError(error, "private stderr");
      if (output.trim()) assert.ok(!error.message.includes(output.trim()));
      assert.match(error.message, /invalid|empty|token/i);
      return true;
    });
  });
}

for (const [label, details, diagnostic] of [
  ["missing executable", { code: "ENOENT" }, /gh|install|not found/i],
  ["nonzero exit", { code: 1 }, /gh|failed|login/i],
  ["timeout", { killed: true, signal: "SIGTERM", code: null }, /timed?\s*out|timeout/i],
] as const) {
  test(`sanitizes ${label} errors, stdout, stderr, and causes`, async (t) => {
    const secret = "private-unstructured-command-output";
    const original = Object.assign(new Error(secret), details, { stdout: secret, stderr: secret });
    mockCommand(t, ({ callback }) => callback(original, secret, secret));
    await assert.rejects(readGitHubCliToken("github.com", new AbortController().signal), (error: unknown) => {
      assertPrivateError(error, secret);
      assert.match(error.message, diagnostic);
      return true;
    });
  });
}

test("sanitizes a synchronous executable error", async (t) => {
  const secret = "synchronous-spawn-private-output";
  mockCommand(t, () => { throw Object.assign(new Error(secret), { code: "ENOENT", stderr: secret }); });
  await assert.rejects(readGitHubCliToken("github.com", new AbortController().signal), (error: unknown) => {
    assertPrivateError(error, secret);
    assert.match(error.message, /gh|install|not found/i);
    return true;
  });
});

test("pre-cancelled CLI reads preserve the reason and never spawn", async (t) => {
  const controller = new AbortController();
  const reason = new Error("User cancelled login");
  controller.abort(reason);
  const calls = mockCommand(t, () => { throw new Error("A cancelled operation must not spawn"); });
  await assert.rejects(readGitHubCliToken("github.com", controller.signal), (error) => error === reason);
  assert.equal(calls.length, 0);
});

test("in-flight cancellation preserves the reason rather than the child's stderr", async (t) => {
  const controller = new AbortController();
  const reason = new Error("User cancelled running command");
  const calls = mockCommand(t, ({ options, callback }) => {
    options.signal!.addEventListener("abort", () => {
      callback(Object.assign(new Error("private abort stderr"), { code: "ABORT_ERR" }), "private stdout", "private stderr");
    }, { once: true });
  });
  const pending = readGitHubCliToken("github.com", controller.signal);
  const rejected = assert.rejects(pending, (error) => error === reason);
  controller.abort(reason);
  await rejected;
  assert.equal(calls.length, 1);
});

test("recognizes exact CLI source markers while giving explicit keys priority", () => {
  assert.equal(isGitHubCliCredential(undefined), false);
  assert.equal(isGitHubCliCredential({ type: "api_key" }), false);
  for (const marker of ["", "github-oauth", "GitHub-CLI", "github-cli "]) {
    assert.equal(isGitHubCliCredential({ type: "api_key", env: { POWER_COPILOT_AUTH_SOURCE: marker } }), false);
  }
  assert.equal(isGitHubCliCredential(cliCredential()), true);
  for (const key of ["runtime-api-key", ""]) assert.equal(isGitHubCliCredential({ ...cliCredential(), key }), false);
});

for (const [domain, hostname] of [
  ["", "github.com"], ["github.com", "github.com"], ["https://company.ghe.com/", "company.ghe.com"],
]) {
  test(`CLI login validates gh for ${domain || "the default host"} and stores only non-secret API-key metadata`, async (t) => {
    const secret = "opaque-private-raw-github-token";
    const commands = mockCommand(t, ({ callback }) => callback(null, `${secret}\n`, ""));
    const fetchMock = forbidFetch(t);
    const { value, prompts, notices } = interaction(domain);
    const saved = await loginPowerCopilotWithGitHubCli(value);
    assert.deepEqual(saved, cliCredential(hostname));
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0].args, ["auth", "token", "--hostname", hostname]);
    assert.deepEqual(prompts.map(({ type }) => type), ["text"]);
    assert.ok(notices.some(({ type }) => type === "progress"));
    assert.ok(!JSON.stringify(saved).includes(secret));
    assert.ok(!JSON.stringify(notices).includes(secret));
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

test("invalid CLI login hostnames fail before command or network access", async (t) => {
  const commands = mockCommand(t, () => assert.fail("Invalid host must not spawn"));
  const fetchMock = forbidFetch(t);
  await assert.rejects(loginPowerCopilotWithGitHubCli(interaction("file:///private").value), /Invalid GitHub hostname/);
  assert.equal(commands.length, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
});

for (const hostname of [undefined, "github.com", "company.ghe.com"]) {
  test(`CLI resolution rereads raw gh output for ${hostname ?? "the default host"} without exchange`, async (t) => {
    let reads = 0;
    const commands = mockCommand(t, ({ callback }) => callback(null, `private-raw-token-${++reads}\n`, ""));
    const fetchMock = forbidFetch(t);
    const credential = cliCredential(hostname);
    const snapshot = structuredClone(credential);
    const signal = new AbortController().signal;
    for (let index = 1; index <= 2; index++) {
      assert.deepEqual(await resolveGitHubCliAuth(credential, signal), {
        auth: {
          apiKey: `private-raw-token-${index}`,
          baseUrl: hostname === "company.ghe.com" ? "https://api.enterprise.githubcopilot.com" : "https://api.githubcopilot.com",
        },
        source: "GitHub CLI",
      });
    }
    assert.equal(commands.length, 2);
    for (const command of commands) {
      assert.deepEqual(command.args, ["auth", "token", "--hostname", hostname ?? "github.com"]);
      assert.equal(command.options.signal, signal);
    }
    assert.deepEqual(credential, snapshot);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

test("raw CLI resolution retains the existing token proxy routing", async (t) => {
  const rawToken = "private-raw-token;proxy-ep=proxy.business.githubcopilot.com";
  mockCommand(t, ({ callback }) => callback(null, rawToken, ""));
  const fetchMock = forbidFetch(t);
  assert.deepEqual(await resolveGitHubCliAuth(cliCredential(), new AbortController().signal), {
    auth: { apiKey: rawToken, baseUrl: "https://api.business.githubcopilot.com" }, source: "GitHub CLI",
  });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("CLI login and resolution sanitize command failure, preserve input, and retry without fetching", async (t) => {
  const secret = "private-resolution-failure";
  let attempts = 0;
  const commands = mockCommand(t, ({ callback }) => {
    if (++attempts <= 2) callback(new Error(secret), secret, secret);
    else callback(null, "new-raw-github-token", "");
  });
  const fetchMock = forbidFetch(t);
  const credential = cliCredential("github.com");
  const snapshot = structuredClone(credential);
  for (const operation of [
    () => loginPowerCopilotWithGitHubCli(interaction().value),
    () => resolveGitHubCliAuth(credential, new AbortController().signal),
  ]) {
    await assert.rejects(operation(), (error: unknown) => { assertPrivateError(error, secret); return true; });
  }
  assert.deepEqual(credential, snapshot);
  assert.equal((await resolveGitHubCliAuth(credential, new AbortController().signal)).auth.apiKey, "new-raw-github-token");
  assert.equal(commands.length, 3);
  assert.deepEqual(credential, snapshot);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("pre-cancelled CLI login and resolution neither spawn nor mutate credentials", async (t) => {
  const controller = new AbortController();
  const reason = new Error("CLI operation cancelled");
  controller.abort(reason);
  const commands = mockCommand(t, () => assert.fail("Cancelled operation must not spawn"));
  const fetchMock = forbidFetch(t);
  const credential = cliCredential();
  const snapshot = structuredClone(credential);
  await assert.rejects(loginPowerCopilotWithGitHubCli(interaction("", controller.signal).value), (error) => error === reason);
  await assert.rejects(resolveGitHubCliAuth(credential, controller.signal), (error) => error === reason);
  assert.deepEqual(credential, snapshot);
  assert.equal(commands.length, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("in-flight resolution cancellation preserves its reason and the credential", async (t) => {
  const controller = new AbortController();
  const reason = new Error("Resolution cancelled");
  mockCommand(t, ({ options, callback }) => {
    options.signal!.addEventListener("abort", () => callback(new Error("private abort output"), "", "private stderr"), { once: true });
  });
  const fetchMock = forbidFetch(t);
  const credential = cliCredential();
  const snapshot = structuredClone(credential);
  const rejected = assert.rejects(resolveGitHubCliAuth(credential, controller.signal), (error) => error === reason);
  controller.abort(reason);
  await rejected;
  assert.deepEqual(credential, snapshot);
  assert.equal(fetchMock.mock.callCount(), 0);
});

for (const enterpriseUrl of [undefined, "company.ghe.com"]) {
  test(`legacy CLI refresh clears secrets and retains metadata for ${enterpriseUrl ?? "github.com"}`, async (t) => {
    let reads = 0;
    const commands = mockCommand(t, ({ callback }) => callback(null, `private-current-gh-token-${++reads}\n`, ""));
    const fetchMock = forbidFetch(t);
    const original: OAuthCredential = {
      type: "oauth", authMethod: "github-cli", refresh: "old-persisted-github-secret", access: "expired-copilot-secret", expires: 1,
      ...(enterpriseUrl ? { enterpriseUrl } : {}), availableModelIds: ["previous-model"], customMetadata: { retained: true },
    };
    const snapshot = structuredClone(original);
    const first = await refreshPowerCopilotWithGitHubCli(original, new AbortController().signal);
    const second = await refreshPowerCopilotWithGitHubCli(first, new AbortController().signal);
    for (const saved of [first, second]) {
      assert.deepEqual(saved, { ...original, refresh: "github-cli", access: "", expires: Number.MAX_SAFE_INTEGER });
      assert.ok(!JSON.stringify(saved).includes("private-current-gh-token-"));
      assert.ok(!JSON.stringify(saved).includes("old-persisted-github-secret"));
      assert.ok(!JSON.stringify(saved).includes("expired-copilot-secret"));
    }
    assert.deepEqual(original, snapshot);
    assert.equal(commands.length, 2);
    for (const command of commands) assert.deepEqual(command.args, ["auth", "token", "--hostname", enterpriseUrl ?? "github.com"]);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

test("valid legacy CLI credentials resolve current raw tokens rather than old persisted access", async (t) => {
  let reads = 0;
  mockCommand(t, ({ callback }) => callback(null, `raw-legacy-token-${++reads}`, ""));
  const fetchMock = forbidFetch(t);
  const original: OAuthCredential = {
    type: "oauth", authMethod: "github-cli", refresh: "github-cli", access: "old-access", expires: Number.MAX_SAFE_INTEGER,
  };
  const snapshot = structuredClone(original);
  for (let index = 1; index <= 2; index++) {
    const result = await resolveLegacyGitHubCliAuth(original, new AbortController().signal);
    assert.equal(result.auth.apiKey, `raw-legacy-token-${index}`);
    assert.equal(result.auth.baseUrl, "https://api.githubcopilot.com");
  }
  assert.deepEqual(original, snapshot);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("failed or pre-cancelled legacy CLI refresh preserves its saved credential", async (t) => {
  const secret = "private-legacy-command-error";
  const commands = mockCommand(t, ({ callback }) => callback(new Error(secret), secret, secret));
  const fetchMock = forbidFetch(t);
  const original: OAuthCredential = {
    type: "oauth", authMethod: "github-cli", refresh: "github-cli", access: "expired", expires: 1,
    availableModelIds: ["old-model"], customMetadata: "preserved",
  };
  const snapshot = structuredClone(original);
  await assert.rejects(refreshPowerCopilotWithGitHubCli(original, new AbortController().signal), (error: unknown) => {
    assertPrivateError(error, secret); return true;
  });
  const controller = new AbortController();
  const reason = new Error("Legacy refresh cancelled");
  controller.abort(reason);
  await assert.rejects(refreshPowerCopilotWithGitHubCli(original, controller.signal), (error) => error === reason);
  assert.deepEqual(original, snapshot);
  assert.equal(commands.length, 1);
  assert.equal(fetchMock.mock.callCount(), 0);
});

// These tests never invoke real gh or user credentials. Provider/runtime integration is covered separately.
