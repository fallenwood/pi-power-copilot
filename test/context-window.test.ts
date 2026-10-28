import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createModels,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Credential,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  CredentialSynchronizationError,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { applyContextWindows, ContextWindowError, readContextWindows } from "../src/context-window.ts";
import { parseModelCatalog } from "../src/catalog.ts";
import extension from "../src/index.ts";

function configFile(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "power-copilot-context-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "power-copilot.json") };
}

function registeredProvider(
  directory: string,
  sessionHandlers: Array<(context: ExtensionContext) => Promise<unknown>> = [],
): Provider {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    let provider: Provider | undefined;
    extension({
      on(event: "session_start", handler: (event: { type: "session_start" }, context: ExtensionContext) => Promise<unknown>) {
        assert.equal(event, "session_start");
        sessionHandlers.push(async (context) => handler({ type: "session_start" }, context));
        return () => {};
      },
      registerProvider(registered: Provider) {
        provider = registered;
      },
    } as ExtensionAPI);
    assert.ok(provider);
    return provider;
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function catalogModel(id: string, endpoint = "/responses", maximum = 400000) {
  return {
    id,
    name: id,
    capabilities: {
      type: "chat",
      limits: { max_context_window_tokens: maximum, max_output_tokens: 128000 },
    },
    supported_endpoints: [endpoint],
  };
}

test("reads optional per-model context windows without presets or step sizes", (t) => {
  const { path } = configFile(t);
  assert.equal(readContextWindows(path).size, 0);
  for (const config of [{}, { contextWindows: {} }]) {
    writeFileSync(path, JSON.stringify(config));
    assert.equal(readContextWindows(path).size, 0);
  }
  const originals = [
    { id: "one", contextWindow: 400000, maxTokens: 128000 },
    { id: "unconfigured", contextWindow: 200000, maxTokens: 8192 },
  ];
  for (const value of [1, 123457, 399999]) {
    writeFileSync(path, JSON.stringify({ contextWindows: { one: value, unavailable: 42 } }));
    const windows = readContextWindows(path);
    const models = applyContextWindows(originals, windows);
    assert.deepEqual(models[0], { ...originals[0], contextWindow: value });
    assert.equal(models[1], originals[1]);
    assert.equal(originals[0].contextWindow, 400000);
    assert.equal(windows.get("unavailable"), 42);
  }
});

test("rejects malformed files, unsupported fields, and invalid token counts explicitly", (t) => {
  const { directory, path } = configFile(t);
  for (const text of [
    "{", "null", "[]", "42", '{"contextWindow": 123}',
    '{"contextWindows": null}', '{"contextWindows": []}', '{"contextWindows": 1}',
    ...[0, -1, 1.5, "123", null, true, {}, [], Number.MAX_SAFE_INTEGER + 1].map(
      (value) => JSON.stringify({ contextWindows: { one: value } }),
    ),
    '{"contextWindows": {"": 1}}',
    '{"contextWindows": {"   ": 1}}',
    '{"contextWindows": {"one": 1e400}}',
  ]) {
    writeFileSync(path, text);
    assert.throws(() => readContextWindows(path), /Power-Copilot configuration/);
  }
  assert.throws(() => readContextWindows(directory), /could not read configuration/);
});

test("validates each override against its own model maximum, including equality", (t) => {
  const { path } = configFile(t);
  for (const value of [400000, 400001, Number.MAX_SAFE_INTEGER]) {
    writeFileSync(path, JSON.stringify({ contextWindows: { one: value } }));
    assert.throws(
      () => applyContextWindows([{ id: "one", contextWindow: 400000 }], readContextWindows(path)),
      /contextWindows\["one"\].*less than.*400000/,
    );
  }
  writeFileSync(path, '{"contextWindows":{"one":123457,"two":200000}}');
  assert.throws(
    () => applyContextWindows(
      [{ id: "one", contextWindow: 400000 }, { id: "two", contextWindow: 200000 }],
      readContextWindows(path),
    ),
    /contextWindows\["two"\].*200000/,
  );
});

const credentials: Credential[] = [
  { type: "api_key", key: "api-key" },
  { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 9_000_000_000_000 },
];

for (const credential of credentials) {
  test(`${credential.type} discovery applies overrides to all APIs and keeps raw cached limits`, async (t) => {
    const { directory, path } = configFile(t);
    writeFileSync(path, '{"contextWindows":{"responses":123457,"messages":1,"completions":399999}}');
    const store = new InMemoryModelsStore();
    const auth = new InMemoryCredentialStore();
    await auth.modify("power-copilot", async () => credential);
    const runtime = createModels({ credentials: auth, modelsStore: store });
    const provider = registeredProvider(directory);
    runtime.setProvider(provider);
    const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
      data: [
        catalogModel("responses"),
        catalogModel("messages", "/messages"),
        catalogModel("completions", "/chat/completions"),
        catalogModel("unconfigured"),
      ],
    })));

    assert.equal((await runtime.refresh()).errors.size, 0);
    const expected = [123457, 1, 399999, 400000];
    assert.deepEqual(provider.getModels().map((model) => model.contextWindow), expected);
    assert.deepEqual(runtime.getModels().map((model) => model.contextWindow), expected);
    assert.deepEqual((await runtime.getAvailable()).map((model) => model.contextWindow), expected);
    assert.ok(runtime.getModels().every((model) => model.maxTokens === 128000));
    assert.ok((await store.read(provider.id))?.models.every((model) => "contextWindow" in model && model.contextWindow === 400000));
    assert.equal(fetchMock.mock.callCount(), 1);

    // Raising and removing overrides must work from the same cached service limits.
    for (const value of [234567, undefined]) {
      if (value === undefined) unlinkSync(path);
      else writeFileSync(path, JSON.stringify({ contextWindows: { responses: value } }));
      const next = createModels({ credentials: auth, modelsStore: store });
      next.setProvider(registeredProvider(directory));
      assert.equal((await next.refresh({ allowNetwork: false })).errors.size, 0);
      assert.deepEqual(
        next.getModels().map((model) => model.contextWindow),
        [value ?? 400000, 400000, 400000, 400000],
      );
    }
    assert.equal(fetchMock.mock.callCount(), 1);
  });
}

test("invalid overrides are surfaced by refresh for network and cached catalogs", async (t) => {
  const { directory, path } = configFile(t);
  writeFileSync(path, '{"contextWindows":{"one":399999}}');
  const auth = new InMemoryCredentialStore();
  await auth.modify("power-copilot", async () => credentials[0]);
  const store = new InMemoryModelsStore();
  const runtime = createModels({ credentials: auth, modelsStore: store });
  runtime.setProvider(registeredProvider(directory));
  let maximum = 400000;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    data: [catalogModel("one", "/responses", maximum)],
  })));
  assert.equal((await runtime.refresh()).errors.size, 0);

  maximum = 300000;
  assert.match((await runtime.refresh()).errors.get("power-copilot")?.message ?? "", /less than.*300000/);
  assert.equal(runtime.getModels()[0]?.contextWindow, 399999);
  assert.equal((await store.read("power-copilot"))?.models.filter((model) => "contextWindow" in model)[0]?.contextWindow, 400000);

  writeFileSync(path, '{"contextWindows":{"one":400000}}');
  const offline = createModels({ credentials: auth, modelsStore: store });
  const provider = registeredProvider(directory);
  offline.setProvider(provider);
  assert.match(
    (await offline.refresh({ allowNetwork: false })).errors.get("power-copilot")?.message ?? "",
    /less than.*400000/,
  );
  assert.deepEqual(provider.getModels(), []);
});

test("malformed configuration fails provider registration rather than silently using defaults", (t) => {
  const { directory, path } = configFile(t);
  writeFileSync(path, '{"contextWindows":{"one":0}}');
  assert.throws(() => registeredProvider(directory), /positive safe integer/);
});

for (const type of ["api_key", "oauth"] as const) {
  test(`${type} login reports invalid cached windows before prompting or committing credentials`, async (t) => {
    const { directory, path } = configFile(t);
    writeFileSync(path, '{"contextWindows":{"gpt-6.1-sol":4000000}}');
    const store = new InMemoryModelsStore();
    await store.write("power-copilot", {
      models: parseModelCatalog({
        data: [catalogModel("gpt-6.1-sol", "/responses", 1050000)],
      }).map((model) => ({ ...model, provider: "power-copilot", baseUrl: "https://api.githubcopilot.com" })),
    });
    const auth = new InMemoryCredentialStore();
    const original: Credential = { type: "api_key", key: "previous-key" };
    await auth.modify("power-copilot", async () => original);
    const runtime = await ModelRuntime.create({
      credentials: auth, modelsStore: store, modelsPath: null, refreshOnCreate: false,
    });
    const sessionHandlers: Array<(context: ExtensionContext) => Promise<unknown>> = [];
    runtime.registerNativeProvider(registeredProvider(directory, sessionHandlers));
    const fetchMock = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("Invalid cached configuration must not start authentication or fetch models");
    });
    const context = {
      modelRegistry: {
        refresh: (options) => {
          assert.deepEqual(options, { allowNetwork: false, providers: ["power-copilot"] });
          return runtime.refresh(options);
        },
      },
    } as ExtensionContext;
    function isActionableError(error: unknown): boolean {
      assert.ok(error instanceof ContextWindowError);
      assert.ok(!(error instanceof CredentialSynchronizationError));
      assert.ok(error.message.includes(path));
      assert.match(error.message, /contextWindows\["gpt-6.1-sol"\]/);
      assert.match(error.message, /1050000 tokens.*received 4000000/);
      assert.match(error.message, /remove this entry.*restart Pi/);
      assert.doesNotMatch(error.message, /local synchronization failed/);
      return true;
    }
    assert.equal(sessionHandlers.length, 1);
    await assert.rejects(sessionHandlers[0](context), isActionableError);
    await assert.rejects(
      runtime.login("power-copilot", type, {
        signal: new AbortController().signal,
        prompt: async () => assert.fail("Invalid configuration must be reported before a login prompt"),
        notify: () => assert.fail("Invalid configuration must not start device authorization"),
      }),
      isActionableError,
    );
    assert.deepEqual(await auth.read("power-copilot"), original);
    assert.equal(fetchMock.mock.callCount(), 0);

    writeFileSync(path, '{"contextWindows":{"gpt-6.1-sol":400000}}');
    const correctedHandlers: Array<(context: ExtensionContext) => Promise<unknown>> = [];
    runtime.registerNativeProvider(registeredProvider(directory, correctedHandlers));
    await correctedHandlers[0](context);
    assert.equal(runtime.getModel("power-copilot", "gpt-6.1-sol")?.contextWindow, 400000);
    const credential = await runtime.login("power-copilot", "api_key", {
      signal: new AbortController().signal,
      prompt: async (prompt) => prompt.type === "select" ? "api-key" : "new-key",
      notify: () => {},
    });
    assert.deepEqual(credential, { type: "api_key", key: "new-key" });
    assert.deepEqual(await auth.read("power-copilot"), credential);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}
