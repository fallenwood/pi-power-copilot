import assert from "node:assert/strict";
import test from "node:test";
import { credentialKey, credentialRef, type CredentialKey, type CredentialProvider, type CredentialRecord } from "@deepseek-ai/dsh-credentials";
import type { AuthorizationNotice, AuthorizationPrompt, AuthorizationSession } from "@deepseek-ai/dsh-authorization";
import { createModels, type Credential, type OAuthCredential } from "@earendil-works/pi-ai";
import { HARNESS_CREDENTIAL_KEY, harnessCredentialStore, harnessInteraction, toCredential, toRecord } from "../src/harness-auth.ts";
import { createHarnessRuntime } from "../src/harness.ts";

const ID = "power-copilot";

/** Model the credential seam's read-modify-write lock and undefined-means-no-write contract. */
function backingStore() {
  const records = new Map<CredentialKey, CredentialRecord>();
  const touched: { method: string; key: CredentialKey }[] = [];
  const references = new Map<string, string>();
  const resolvedRefs: string[] = [];
  const chains = new Map<CredentialKey, Promise<unknown>>();
  const methods = {
    async readRecord(key: CredentialKey) {
      touched.push({ method: "read", key });
      return structuredClone(records.get(key));
    },
    async describeRecord(key: CredentialKey) {
      touched.push({ method: "describe", key });
      const record = records.get(key);
      return { configured: record !== undefined, writable: true, ...(record ? { kind: record.kind } : {}) };
    },
    async modifyRecord(key: CredentialKey, mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      touched.push({ method: "modify", key });
      const next = (chains.get(key) ?? Promise.resolve()).then(async () => {
        const changed = await mutate(structuredClone(records.get(key)));
        if (changed !== undefined) records.set(key, structuredClone(changed));
        return structuredClone(records.get(key));
      });
      chains.set(key, next.catch(() => {}));
      return next;
    },
    async deleteRecord(key: CredentialKey) {
      touched.push({ method: "delete", key });
      records.delete(key);
    },
    async resolve(ref: string) {
      resolvedRefs.push(ref);
      const value = references.get(ref);
      return value ? { value, source: "fixture" } : undefined;
    },
  };
  return { records, touched, references, resolvedRefs, credentials: methods as unknown as CredentialProvider };
}

test.beforeEach((t) => {
  assert.ok("mock" in t);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request: auth tests are offline"); });
});

test("API-key record conversion preserves optional fields and copies environment maps", () => {
  assert.equal(toCredential(undefined), undefined);
  const env = { FIXTURE_PROFILE: "profile-a" };
  const record: CredentialRecord = { kind: "api-key", key: "synthetic-key", env };
  const credential = toCredential(record);
  assert.deepEqual(credential, { type: "api_key", key: "synthetic-key", env });
  assert.ok(credential?.type === "api_key");
  assert.notEqual(credential.env, env);
  const converted = toRecord(credential);
  assert.deepEqual(converted, record);
  assert.ok(converted.kind === "api-key");
  assert.notEqual(converted.env, credential.env);
  assert.deepEqual(toCredential({ kind: "api-key" }), { type: "api_key" });
  assert.deepEqual(toRecord({ type: "api_key" }), { kind: "api-key" });
});

test("OAuth grant conversion persists provider metadata as lossless JSON, omitting undefined", () => {
  const credential: OAuthCredential = {
    type: "oauth", authMethod: "github-oauth", refresh: "synthetic-refresh", access: "synthetic-access", expires: 1234,
    enterpriseUrl: "company.ghe.com", availableModelIds: ["dynamic-model"], transient: undefined,
    nested: { retained: true, dropped: undefined },
  };
  const { transient: _transient, ...expected } = credential;
  const record = toRecord(credential);
  assert.equal(record.kind, "grant");
  assert.deepEqual(record, { kind: "grant", payload: { ...expected, nested: { retained: true } } });
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  assert.deepEqual(toCredential(record), { ...expected, nested: { retained: true } });
});

test("Harness credential adapter uses only its scoped key and never enumerates or touches another owner's records", async () => {
  const backing = backingStore();
  const foreign = credentialKey("llm-pi-ai", "power-copilot");
  const foreignRecord: CredentialRecord = { kind: "api-key", key: "another-plugin-secret" };
  backing.records.set(foreign, foreignRecord);
  const store = harnessCredentialStore(backing.credentials);
  assert.equal(String(HARNESS_CREDENTIAL_KEY), "power-copilot/power-copilot");
  assert.equal(await store.read(ID), undefined);
  assert.deepEqual(await store.list(), []);
  const credential: Credential = { type: "api_key", key: "synthetic-owned-key" };
  assert.deepEqual(await store.modify(ID, async (current) => { assert.equal(current, undefined); return credential; }), credential);
  assert.deepEqual(await store.read(ID), credential);
  assert.deepEqual(await store.list(), [{ providerId: ID, type: "api_key" }]);
  await store.delete(ID);
  assert.equal(await store.read(ID), undefined);
  assert.deepEqual(backing.records.get(foreign), foreignRecord);
  assert.ok(backing.touched.every(({ key }) => key === HARNESS_CREDENTIAL_KEY));
});

test("Harness credential adapter rejects foreign provider IDs before any credential service operation", async () => {
  const backing = backingStore();
  const store = harnessCredentialStore(backing.credentials, credentialRef("FIXTURE_KEY"));
  for (const id of ["github-copilot", "anthropic", "llm-pi-ai/power-copilot", "", "power-copilot/other"]) {
    await assert.rejects(store.read(id), /cannot access another provider/);
    await assert.rejects(store.modify(id, async () => ({ type: "api_key", key: "should-not-write" })), /cannot access another provider/);
    await assert.rejects(store.delete(id), /cannot access another provider/);
  }
  assert.deepEqual(backing.touched, []);
  assert.deepEqual(backing.resolvedRefs, []);
});

test("Harness modify preserves the current record when mutation declines and keeps serialized updates", async () => {
  const backing = backingStore();
  const store = harnessCredentialStore(backing.credentials);
  const initial: OAuthCredential = { type: "oauth", refresh: "fixture-refresh", access: "old", expires: 1, count: 0 };
  await store.modify(ID, async () => initial);
  assert.deepEqual(await store.modify(ID, async () => undefined), initial);
  await Promise.all(Array.from({ length: 4 }, () => store.modify(ID, async (current) => {
    assert.ok(current?.type === "oauth");
    await Promise.resolve();
    return { ...current, count: Number(current.count) + 1 };
  })));
  assert.deepEqual(await store.read(ID), { ...initial, count: 4 });
  assert.deepEqual(await store.list(), [{ providerId: ID, type: "oauth" }]);
  const previous = backing.records.get(HARNESS_CREDENTIAL_KEY);
  await assert.rejects(store.modify(ID, async () => { throw new Error("fixture failed mutation"); }), /failed mutation/);
  assert.deepEqual(backing.records.get(HARNESS_CREDENTIAL_KEY), previous);
});

test("credential-reference fallback is read per operation and never persisted or preferred over a saved grant", async () => {
  const backing = backingStore();
  const ref = credentialRef("FIXTURE_COPILOT_KEY");
  const store = harnessCredentialStore(backing.credentials, ref);
  assert.equal(await store.read(ID), undefined);
  backing.references.set(ref, "ambient-key-one");
  assert.deepEqual(await store.read(ID), { type: "api_key", key: "ambient-key-one" });
  backing.references.set(ref, "ambient-key-two");
  assert.deepEqual(await store.read(ID), { type: "api_key", key: "ambient-key-two" });
  assert.equal(backing.records.size, 0, "reading an environment/reference key does not save a credential record");
  const grant: OAuthCredential = { type: "oauth", refresh: "saved-fixture-grant", access: "saved-fixture-access", expires: 1 };
  await store.modify(ID, async () => grant);
  const fallbackReads = backing.resolvedRefs.length;
  assert.deepEqual(await store.read(ID), grant, "even an expired stored grant belongs to Pi's refresh path, not ambient auth");
  assert.equal(backing.resolvedRefs.length, fallbackReads);
  await store.delete(ID);
  assert.deepEqual(await store.read(ID), { type: "api_key", key: "ambient-key-two" });
  assert.equal(backing.records.size, 0);
});

test("a stored API key or ambient-auth marker takes precedence over reference fallback", async () => {
  const backing = backingStore();
  const ref = credentialRef("FIXTURE_COPILOT_KEY");
  backing.references.set(ref, "ambient-key");
  const store = harnessCredentialStore(backing.credentials, ref);
  await store.modify(ID, async () => ({ type: "api_key", key: "stored-key" }));
  assert.deepEqual(await store.read(ID), { type: "api_key", key: "stored-key" });
  await store.modify(ID, async () => ({ type: "api_key" }));
  assert.deepEqual(await store.read(ID), { type: "api_key" });
  assert.deepEqual(backing.resolvedRefs, []);
});

test("real Pi OAuth auto-refresh persists through the Harness record bridge and is reused by another collection", async (t) => {
  const backing = backingStore();
  const foreign = credentialKey("llm-pi-ai", "power-copilot");
  backing.records.set(foreign, { kind: "api-key", key: "foreign-do-not-use" });
  const original: OAuthCredential = { type: "oauth", authMethod: "github-oauth", refresh: "fixture-github-grant", access: "expired", expires: 1, enterpriseUrl: "company.ghe.com" };
  const store = harnessCredentialStore(backing.credentials);
  await store.modify(ID, async () => original);
  const provider = createHarnessRuntime(store).provider;
  const one = createModels({ credentials: store });
  const two = createModels({ credentials: harnessCredentialStore(backing.credentials) });
  one.setProvider(provider);
  two.setProvider(provider);
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://api.company.ghe.com/copilot_internal/v2/token");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-github-grant");
    return new Response(JSON.stringify({ token: "renewed-fixture-access", expires_at: expiry }), { headers: { "content-type": "application/json" } });
  });
  const auth = await Promise.all([one.getAuth(ID), two.getAuth(ID)]);
  assert.deepEqual(auth.map((value) => value?.auth.apiKey), ["renewed-fixture-access", "renewed-fixture-access"]);
  assert.equal(fetchMock.mock.callCount(), 1, "separate collections share the Harness credential-record lock");
  assert.deepEqual(backing.records.get(HARNESS_CREDENTIAL_KEY), { kind: "grant", payload: { ...original, access: "renewed-fixture-access", expires: expiry * 1000 - 300000 } });
  const next = createModels({ credentials: harnessCredentialStore(backing.credentials) });
  next.setProvider(provider);
  assert.equal((await next.getAuth(ID))?.auth.apiKey, "renewed-fixture-access");
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(backing.records.get(foreign), { kind: "api-key", key: "foreign-do-not-use" });
});

test("Harness interaction maps text, secret, and select prompts without losing per-prompt cancellation", async () => {
  const prompts: AuthorizationPrompt[] = [];
  const signal = new AbortController().signal;
  const promptSignal = new AbortController().signal;
  const session: AuthorizationSession = {
    method: "oauth", signal, async commit() {}, notify() {},
    async prompt(value) { prompts.push(value); return value.kind === "select" ? "enterprise" : "synthetic-answer"; },
  };
  const interaction = harnessInteraction(session);
  assert.equal(interaction.signal, signal);
  assert.equal(await interaction.prompt({ type: "text", message: "GitHub domain", placeholder: "company.ghe.com" }), "synthetic-answer");
  assert.equal(await interaction.prompt({ type: "secret", message: "API key", signal: promptSignal }), "synthetic-answer");
  const options = [{ id: "enterprise", label: "Enterprise", description: "Company account" }];
  assert.equal(await interaction.prompt({ type: "select", message: "Account", options, signal: promptSignal }), "enterprise");
  assert.deepEqual(prompts, [
    { kind: "text", message: "GitHub domain", placeholder: "company.ghe.com" },
    { kind: "secret", message: "API key", placeholder: undefined, signal: promptSignal },
    { kind: "select", message: "Account", options, signal: promptSignal },
  ]);
});

test("Harness authorization notices expose device code/action URLs and progress but not credential fields", () => {
  const notices: AuthorizationNotice[] = [];
  const session: AuthorizationSession = { method: "oauth", signal: new AbortController().signal, async commit() {}, async prompt() { return ""; }, notify(notice) { notices.push(notice); } };
  const interaction = harnessInteraction(session);
  interaction.notify({ type: "device_code", verificationUri: "https://github.com/login/device", userCode: "FAKE-CODE", expiresInSeconds: 60, intervalSeconds: 0 });
  interaction.notify({ type: "auth_url", url: "https://github.com/login/oauth/authorize", instructions: "Use this account" });
  interaction.notify({ type: "auth_url", url: "https://github.com/continue" });
  interaction.notify({ type: "progress", message: "Waiting for authorization" });
  assert.deepEqual(notices, [
    { message: "Enter this code on the verification page to sign in to Power Copilot.", url: "https://github.com/login/device", code: "FAKE-CODE" },
    { message: "Use this account", url: "https://github.com/login/oauth/authorize" },
    { message: "Open this page to continue signing in.", url: "https://github.com/continue" },
    { message: "Waiting for authorization" },
  ]);
  assert.ok(notices.every((notice) => Object.keys(notice).every((key) => ["message", "url", "code"].includes(key))));
});

test("Harness interaction forwards prompt rejection and does not turn cancellation into an answer", async () => {
  const controller = new AbortController();
  const failure = new Error("fixture prompt withdrawn");
  controller.abort(failure);
  const session: AuthorizationSession = { method: "api-key", signal: controller.signal, async commit() {}, notify() {}, async prompt() { throw failure; } };
  const interaction = harnessInteraction(session);
  assert.equal(interaction.signal.reason, failure);
  await assert.rejects(interaction.prompt({ type: "secret", message: "API key" }), (error) => error === failure);
});
