import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type ExecFileOptions } from "node:child_process";
import test, { type TestContext } from "node:test";
import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import {
  loginPowerCopilotWithGitHubCli,
  readGitHubCliToken,
  refreshPowerCopilotWithGitHubCli,
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

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json" },
  });
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

for (const [domain, hostname, enterpriseUrl] of [
  ["", "github.com", undefined],
  ["github.com", "github.com", undefined],
  ["https://company.ghe.com/", "company.ghe.com", "company.ghe.com"],
] as const) {
  test(`CLI login exchanges a token for ${domain || "the default GitHub host"} without device login or discovery`, async (t) => {
    const githubToken = "opaque-private-github-token";
    const calls = mockCommand(t, ({ callback }) => callback(null, `${githubToken}\n`, ""));
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      assert.equal(url, `https://api.${hostname}/copilot_internal/v2/token`);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${githubToken}`);
      assert.ok(init?.signal instanceof AbortSignal);
      return response({ token: "copilot-access", expires_at: 2_000_000_000 });
    });
    const { value, prompts, notices } = interaction(domain);
    const saved = await loginPowerCopilotWithGitHubCli(value);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["auth", "token", "--hostname", hostname]);
    assert.deepEqual(prompts.map((prompt) => prompt.type), ["text"]);
    assert.ok(notices.some((notice) => notice.type === "progress"));
    assert.equal(saved.type, "oauth");
    assert.equal(saved.authMethod, "github-cli");
    assert.equal(saved.refresh, "github-cli");
    assert.equal(saved.access, "copilot-access");
    assert.equal(saved.expires, 2_000_000_000_000 - 5 * 60 * 1000);
    assert.equal(saved.enterpriseUrl, enterpriseUrl);
    assert.ok(!JSON.stringify(saved).includes(githubToken));
    assert.equal(requests.length, 1);
  });
}

test("explains a denied CLI token exchange without exposing the CLI token or response body", async (t) => {
  const secret = "opaque-private-exchange-secret";
  mockCommand(t, ({ callback }) => callback(null, secret, ""));
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requests.push(String(input));
    return response({ message: `Denied ${secret}` }, 403);
  });
  await assert.rejects(loginPowerCopilotWithGitHubCli(interaction().value), (error: unknown) => {
    assertPrivateError(error, secret);
    assert.match(error.message, /403/);
    assert.match(error.message, /Copilot/i);
    assert.match(error.message, /GitHub OAuth/i);
    return true;
  });
  assert.deepEqual(requests, ["https://api.github.com/copilot_internal/v2/token"]);
});

for (const enterpriseUrl of [undefined, "company.ghe.com"]) {
  test(`CLI renewal rereads gh and preserves metadata for ${enterpriseUrl ?? "github.com"}`, async (t) => {
    const hostname = enterpriseUrl ?? "github.com";
    let commandCount = 0;
    const calls = mockCommand(t, ({ callback }) => callback(null, `private-gh-token-${++commandCount}\n`, ""));
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      assert.equal(url, `https://api.${hostname}/copilot_internal/v2/token`);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer private-gh-token-${requests.length}`);
      return response({ token: `renewed-copilot-${requests.length}`, expires_at: 2_000_000_000 + requests.length });
    });
    const original: OAuthCredential = {
      type: "oauth", authMethod: "github-cli", refresh: "github-cli", access: "expired", expires: 1,
      ...(enterpriseUrl ? { enterpriseUrl } : {}),
      availableModelIds: ["previous-model"], customMetadata: { retained: true },
    };
    const first = await refreshPowerCopilotWithGitHubCli(original, new AbortController().signal);
    const second = await refreshPowerCopilotWithGitHubCli(first, new AbortController().signal);
    assert.equal(calls.length, 2);
    for (const call of calls) assert.deepEqual(call.args, ["auth", "token", "--hostname", hostname]);
    for (const saved of [first, second]) {
      assert.equal(saved.type, "oauth");
      assert.equal(saved.authMethod, "github-cli");
      assert.equal(saved.refresh, "github-cli");
      assert.equal(saved.enterpriseUrl, enterpriseUrl);
      assert.deepEqual(saved.availableModelIds, original.availableModelIds);
      assert.deepEqual(saved.customMetadata, original.customMetadata);
      assert.ok(!JSON.stringify(saved).includes("private-gh-token-"));
    }
    assert.equal(first.access, "renewed-copilot-1");
    assert.equal(second.access, "renewed-copilot-2");
    assert.equal(second.expires, 2_000_000_002_000 - 5 * 60 * 1000);
    assert.equal(original.access, "expired");
    assert.equal(original.expires, 1);
    assert.equal(requests.length, 2);
  });
}

test("pre-cancelled CLI renewal neither runs gh nor calls GitHub", async (t) => {
  const controller = new AbortController();
  const reason = new Error("Renewal cancelled");
  controller.abort(reason);
  const commands = mockCommand(t, () => { throw new Error("Cancelled renewal must not spawn"); });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Cancelled renewal must not fetch"); });
  await assert.rejects(refreshPowerCopilotWithGitHubCli({
    type: "oauth", authMethod: "github-cli", refresh: "github-cli", access: "expired", expires: 1,
  }, controller.signal), (error) => error === reason);
  assert.equal(commands.length, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("a failed CLI renewal leaves the supplied credential unchanged", async (t) => {
  mockCommand(t, ({ callback }) => callback(null, "private-github-token", ""));
  t.mock.method(globalThis, "fetch", async () => response({ message: "private-github-token" }, 503));
  const original: OAuthCredential = {
    type: "oauth", authMethod: "github-cli", refresh: "github-cli", access: "expired", expires: 1,
    availableModelIds: ["old-model"], customMetadata: "preserved",
  };
  const snapshot = structuredClone(original);
  await assert.rejects(refreshPowerCopilotWithGitHubCli(original, new AbortController().signal), (error: unknown) => {
    assertPrivateError(error, "private-github-token");
    return true;
  });
  assert.deepEqual(original, snapshot);
});

// This suite intentionally uses the public helpers rather than real user auth.json or gh state.
// Provider/runtime compatibility and locked persistence are covered in auth.test.ts.
