import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const CLIENT_URL = new URL("../client.js", import.meta.url);
const PACKAGE_URL = new URL("../package.json", import.meta.url);
const SETTINGS_PATH = "/api/power-copilot";
const SLOT = "settings.models.provider-card";

type Dispose = () => void;
type Listener = () => void;
interface ClientContextFixture {
  effect(effect: () => Dispose): Dispose;
  on(event: string, listener: Listener): Dispose;
  locale: {
    register(namespace: string, values: Record<string, Record<string, string>>): Dispose;
    bind(namespace: string): (key: string) => string;
  };
  remote: { $on(event: string, listener: Listener): Dispose };
  slots: {
    inject(name: string, callback: () => Dispose): void;
    register(options: { name: string; key: string }, component: unknown): Dispose;
  };
}
interface ClientDefinition {
  inject: string[];
  apply(ctx: ClientContextFixture): void;
}
interface Handoff {
  id: string;
  factory(require: (name: string) => unknown): ClientDefinition;
}
interface FetchCall { path: string; init: RequestInit }
interface Registration { name: string; key: string; component: unknown }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function status(settingsNs = "include:fixture-power-copilot") {
  return Response.json({ settingsNs, configured: false, credentialSource: null, authType: null, attempt: null });
}
// Drain promise continuations only. All browser retry timers below are controlled fixtures.
function settle(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

/** Module/registration fixture only: never invokes the React component, hooks, DOM, or a real fetch. */
function fixture(respond: (call: FetchCall, count: number) => Response | Promise<Response>) {
  const required: string[] = [];
  const calls: FetchCall[] = [];
  const registrations: Registration[] = [];
  const active = new Set<Registration>();
  const errors: unknown[][] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const localListeners = new Map<string, Set<Listener>>();
  const remoteListeners = new Map<string, Set<Listener>>();
  const locales = new Map<string, Record<string, Record<string, string>>>();
  const disposers: Dispose[] = [];
  let handoff: Handoff | undefined;
  let timerId = 0;
  const forbiddenRender = () => assert.fail("This fixture must not render components or call React hooks");
  const react = new Proxy({ createElement: forbiddenRender }, {
    get(target, property) {
      if (property === "createElement") return target.createElement;
      assert.fail(`This fixture must not access React hooks: ${String(property)}`);
    },
  });
  runInNewContext(readFileSync(CLIENT_URL, "utf8"), {
    window: { __ModuleLoader__: { load(value: Handoff) { handoff = value; } } },
    AbortController,
    fetch: async (path: string, init: RequestInit) => {
      const call = { path, init };
      calls.push(call);
      return respond(call, calls.length);
    },
    setTimeout(callback: () => void, delay: number) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id: number | undefined) { if (id !== undefined) timers.delete(id); },
    console: { error: (...values: unknown[]) => { errors.push(values); } },
  }, { filename: CLIENT_URL.pathname });
  assert.ok(handoff, "the ordinary Client artifact must hand a lazy factory to the module loader");
  const definition = handoff.factory((name) => {
    required.push(name);
    assert.equal(name, "react", "the ordinary Client artifact uses only the baseline React import");
    return react;
  });
  function subscribe(target: Map<string, Set<Listener>>, event: string, listener: Listener): Dispose {
    let set = target.get(event);
    if (set === undefined) { set = new Set(); target.set(event, set); }
    set.add(listener);
    return () => { set.delete(listener); if (set.size === 0) target.delete(event); };
  }
  const ctx: ClientContextFixture = {
    effect(effect) { const dispose = effect(); disposers.push(dispose); return dispose; },
    on(event, listener) {
      const dispose = subscribe(localListeners, event, listener);
      disposers.push(dispose); // Cordis owns ctx.on listeners without an extra ctx.effect wrapper.
      return dispose;
    },
    locale: {
      register(namespace, values) {
        assert.equal(locales.has(namespace), false);
        locales.set(namespace, values);
        return () => { locales.delete(namespace); };
      },
      bind(namespace) { return (key) => locales.get(namespace)?.en?.[key] ?? key; },
    },
    remote: { $on: (event, listener) => subscribe(remoteListeners, event, listener) },
    slots: {
      inject(name, callback) {
        assert.equal(name, SLOT);
        disposers.push(callback()); // The slot is declared, so this fixture activates the registration immediately.
      },
      register(options, component) {
        const entry = { name: options.name, key: options.key, component };
        registrations.push(entry);
        active.add(entry);
        return () => { active.delete(entry); };
      },
    },
  };
  return {
    handoff, definition, required, calls, registrations, active, errors, timers,
    localListeners, remoteListeners, locales,
    start() { assert.equal(definition.apply(ctx), undefined, "bootstrap must not block plugin activation"); },
    emitLocal(event: string) { for (const listener of [...localListeners.get(event) ?? []]) listener(); },
    emitRemote(event: string) { for (const listener of [...remoteListeners.get(event) ?? []]) listener(); },
    runNextTimer() {
      const next = timers.entries().next().value;
      assert.ok(next, "a controlled startup retry must be scheduled");
      const [id, timer] = next;
      timers.delete(id);
      timer.callback();
      return timer.delay;
    },
    dispose() { for (const dispose of disposers.splice(0).reverse()) dispose(); },
  };
}

test("ordinary Client factory loads only React without fetching or rendering", () => {
  const f = fixture(() => assert.fail("factories must not fetch before apply"));
  assert.equal(f.handoff.id, "pi-power-copilot-provider");
  assert.deepEqual(f.required, ["react"]);
  assert.deepEqual(Array.from(f.definition.inject), ["slots", "locale", "remote"]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.registrations.length, 0);
  assert.equal(f.locales.size, 0);
});

test("a failed initial GET recovers on connection reset and registers the Host's exact namespace", async (t) => {
  const ns = "included:actual-loader-instance-not-the-route-id";
  const f = fixture((_call, count) => {
    if (count === 1) throw new Error("transient Host mount failure");
    return status(ns);
  });
  t.after(() => f.dispose());
  f.start();
  await settle();
  assert.equal(f.registrations.length, 0);
  assert.equal(f.timers.size, 1);
  f.emitLocal("connection/reset");
  await settle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.registrations.length, 1);
  assert.equal(f.registrations[0]?.name, SLOT);
  assert.equal(f.registrations[0]?.key, ns);
  assert.equal(typeof f.registrations[0]?.component, "function");
  assert.equal(f.timers.size, 0);
  for (const call of f.calls) {
    assert.equal(call.path, SETTINGS_PATH);
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.credentials, "same-origin");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.body, undefined);
    assert.ok(call.init.signal);
  }
  f.emitLocal("connection/reset");
  f.emitRemote("llm/adapters-updated");
  await settle();
  assert.equal(f.calls.length, 2, "an installed slot must not start an idle status-poll loop");
  f.dispose();
  assert.equal(f.active.size, 0);
  assert.equal(f.locales.size, 0);
  assert.equal(f.localListeners.size, 0);
  assert.equal(f.remoteListeners.size, 0);
  assert.ok(f.calls.every(call => call.init.signal?.aborted));
});

test("startup failures have five bounded retries and disposal cancels a later reconnect retry", async (t) => {
  const f = fixture(() => { throw new Error("offline fixture"); });
  t.after(() => f.dispose());
  f.start();
  await settle();
  const delays: number[] = [];
  for (let index = 0; index < 5; index++) {
    delays.push(f.runNextTimer());
    await settle();
  }
  assert.deepEqual(delays, [250, 500, 1000, 2000, 4000]);
  assert.equal(f.calls.length, 6);
  assert.equal(f.timers.size, 0);
  assert.equal(f.errors.length, 1);
  assert.equal(f.registrations.length, 0);
  f.emitLocal("connection/reset");
  await settle();
  assert.equal(f.calls.length, 7);
  assert.equal(f.timers.size, 1, "a reconnection starts a fresh bounded attempt series");
  f.dispose();
  assert.equal(f.timers.size, 0);
  f.emitLocal("connection/reset");
  f.emitRemote("llm/adapters-updated");
  await settle();
  assert.equal(f.calls.length, 7);
  assert.equal(f.localListeners.size, 0);
  assert.equal(f.remoteListeners.size, 0);
});

test("a native adapter event recovers bootstrap after startup retry exhaustion", async (t) => {
  const f = fixture((_call, count) => {
    if (count <= 6) throw new Error("offline fixture");
    return status("host:reconnected-provider-entry");
  });
  t.after(() => f.dispose());
  f.start();
  await settle();
  for (let index = 0; index < 5; index++) { f.runNextTimer(); await settle(); }
  assert.equal(f.timers.size, 0);
  f.emitRemote("llm/adapters-updated");
  await settle();
  assert.equal(f.calls.length, 7);
  assert.equal(f.registrations[0]?.key, "host:reconnected-provider-entry");
  assert.equal(f.active.size, 1);
  assert.equal(f.timers.size, 0);
});

test("disposing an in-flight bootstrap aborts its request and forbids late slot registration", async () => {
  const response = deferred<Response>();
  const f = fixture(() => response.promise); // Intentionally ignores abort to exercise the late-response guard.
  f.start();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.init.signal?.aborted, false);
  f.dispose();
  assert.equal(f.calls[0]?.init.signal?.aborted, true);
  response.resolve(status("must-never-register"));
  await settle();
  assert.equal(f.registrations.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.errors.length, 0);
  assert.equal(f.localListeners.size, 0);
  assert.equal(f.remoteListeners.size, 0);
});

test("reconnect notifications coalesce while the one bootstrap GET is in flight", async (t) => {
  const response = deferred<Response>();
  const f = fixture(() => response.promise);
  t.after(() => f.dispose());
  f.start();
  f.emitLocal("connection/reset");
  f.emitRemote("llm/adapters-updated");
  assert.equal(f.calls.length, 1);
  response.resolve(status("host:one-registration"));
  await settle();
  assert.equal(f.registrations.length, 1);
  assert.equal(f.registrations[0]?.key, "host:one-registration");
  assert.equal(f.timers.size, 0);
});

test("the manifest exports and ships its ordinary Web Client and localized display resources", () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_URL, "utf8"));
  assert.equal(manifest.exports["./client"], "./client.js");
  assert.ok(manifest.files.includes("client.js"));
  assert.equal(manifest.dsh.client.platform, "web");
  assert.equal(manifest.dsh.client.immediately, true);
  assert.ok(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings-models"));
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  assert.equal(manifest.exports["./pi"], "./src/index.ts");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  for (const locale of ["en", "zh"]) {
    const resource = manifest.exports["./locale/*.json"].replace("*", locale);
    const value = JSON.parse(readFileSync(new URL(resource, PACKAGE_URL), "utf8"));
    assert.equal(typeof value.meta.title, "string");
    assert.ok(value.meta.title.trim().length > 0);
    assert.equal(typeof value.meta.description, "string");
    assert.ok(value.meta.description.trim().length > 0);
  }
  const icon = readFileSync(new URL(manifest.exports["./icon"], PACKAGE_URL), "utf8");
  assert.match(icon, /<svg\b/);
  assert.match(icon, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(manifest.files.includes("icon.svg"));
  assert.ok(manifest.files.includes("locale/*.json"));
});
