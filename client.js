window.__ModuleLoader__.load({
  id: 'pi-power-copilot-provider',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'power-copilot-ui';
    const PATH = '/api/power-copilot';
    const en = {
      signedOut: 'Not signed in', signedIn: 'Signed in with GitHub', keyReady: 'API key configured',
      referenceReady: 'Using the configured API-key reference',
      github: 'Sign in with GitHub', apiKey: 'Use API key', keyLabel: 'Power Copilot API key',
      saveKey: 'Save API key', logout: 'Sign out', refresh: 'Refresh models', cancel: 'Cancel sign-in',
      enterprise: 'GitHub Enterprise (optional)', domain: 'Enterprise domain',
      deviceInstructions: 'Open the GitHub verification page and enter this code. This card will update automatically.',
      openGitHub: 'Open verification page', signingIn: 'Waiting for GitHub authorization…',
      cancelled: 'Sign-in cancelled', working: 'Working…',
      authorizationFailed: 'Sign-in failed. Please retry and check your GitHub/Copilot access.',
      modelsUnavailable: 'Could not refresh models. Check your connection and credentials, then retry.',
      operationFailed: 'Operation failed. Please retry.', alreadyRunning: 'A sign-in is already in progress.',
      staleAttempt: 'This sign-in has already changed. Refresh the card and try again.',
      invalidInput: 'Enter a valid API key or Enterprise domain.',
    };
    const zh = {
      signedOut: '未登录', signedIn: '已通过 GitHub 登录', keyReady: '已配置 API key',
      referenceReady: '正在使用已配置的 API-key 引用',
      github: '使用 GitHub 登录', apiKey: '使用 API key', keyLabel: 'Power Copilot API key',
      saveKey: '保存 API key', logout: '退出登录', refresh: '刷新模型', cancel: '取消登录',
      enterprise: 'GitHub Enterprise（可选）', domain: 'Enterprise 域名',
      deviceInstructions: '打开 GitHub 验证页面并输入以下设备码。授权完成后，此卡片会自动更新。',
      openGitHub: '打开验证页面', signingIn: '正在等待 GitHub 授权…',
      cancelled: '已取消登录', working: '处理中…',
      authorizationFailed: '登录失败，请重试并检查 GitHub / Copilot 访问权限。',
      modelsUnavailable: '无法刷新模型，请检查网络和凭据后重试。',
      operationFailed: '操作失败，请重试。', alreadyRunning: '已有登录流程正在进行。',
      staleAttempt: '此登录流程已变更，请刷新卡片后重试。',
      invalidInput: '请输入有效的 API key 或 Enterprise 域名。',
    };
    const css = `
.pc-provider{display:flex;flex-direction:column;gap:12px;min-width:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.pc-provider p{margin:0}.pc-provider .pc-muted{color:var(--dsw-alias-label-secondary)}
.pc-provider .pc-error{color:var(--dsw-alias-state-error-primary)}
.pc-provider .pc-ready{color:var(--dsw-alias-state-success-primary)}
.pc-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.pc-provider button{box-sizing:border-box;height:36px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.pc-provider button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.pc-provider button:disabled{opacity:.5;cursor:default}
.pc-provider button:focus-visible,.pc-provider input:focus-visible,.pc-provider summary:focus-visible,.pc-provider a:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.pc-provider details{min-width:0}.pc-provider summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}
.pc-field{display:flex;flex-direction:column;gap:6px;max-width:440px;margin-top:8px}
.pc-provider input{box-sizing:border-box;width:100%;height:36px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
.pc-device{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.pc-device code{padding:4px 8px;font-size:20px;letter-spacing:2px;user-select:all;overflow-wrap:anywhere}
.pc-provider a{color:var(--dsw-alias-brand-primary);overflow-wrap:anywhere}
`;
    async function call(body, signal) {
      const response = await fetch(PATH, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'operation-failed');
      return result;
    }
    function errorKey(code) {
      return ({ 'authorization-failed': 'authorizationFailed', 'models-unavailable': 'modelsUnavailable',
        'already-running': 'alreadyRunning', 'stale-attempt': 'staleAttempt', 'invalid-input': 'invalidInput' })[code] || 'operationFailed';
    }
    return {
      inject: ['slots', 'locale', 'remote'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }));
        const lifetime = new AbortController();
        ctx.effect(() => () => lifetime.abort());
        // The namespace is a Loader entry identity, not necessarily the provider route id.
        let initial;
        const t = ctx.locale.bind(NS);
        function ProviderCard({ provider }) {
          const [snapshot, setSnapshot] = React.useState(initial);
          const [busy, setBusy] = React.useState(false);
          const [failure, setFailure] = React.useState('');
          const [apiKey, setApiKey] = React.useState('');
          const [domain, setDomain] = React.useState('');
          const mounted = React.useRef(false);
          const ownedAttempt = React.useRef(null);
          const generation = React.useRef(0);
          const local = React.useRef(null);
          React.useSyncExternalStore((fn) => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
          const accept = (value, ticket) => {
            if (!mounted.current || ticket !== generation.current) return;
            if (value.attempt?.status !== 'pending') ownedAttempt.current = null;
            setSnapshot(value);
          };
          const readStatus = () => {
            const ticket = ++generation.current;
            return call(undefined, local.current?.signal).then((value) => accept(value, ticket));
          };
          React.useEffect(() => {
            mounted.current = true;
            const controller = new AbortController();
            local.current = controller;
            const refresh = () => { void readStatus().catch(() => {
              if (mounted.current && !controller.signal.aborted) setFailure('operation-failed');
            }); };
            refresh();
            const disposers = [ctx.remote.$on('credentials/record-updated', (key) => {
              if (key === 'power-copilot/power-copilot') refresh();
            }), ctx.remote.$on('credentials/reference-updated', refresh), ctx.on('connection/reset', refresh)];
            return () => {
              mounted.current = false;
              controller.abort();
              for (const dispose of disposers) dispose();
              if (ownedAttempt.current) void call({ action: 'cancel', attemptId: ownedAttempt.current }).catch(() => {});
            };
          }, []);
          const pending = snapshot.attempt?.status === 'pending';
          React.useEffect(() => {
            if (!pending) return;
            let stopped = false;
            let timer;
            const poll = async () => {
              try { await readStatus(); }
              catch { if (!stopped && mounted.current && !local.current.signal.aborted) setFailure('operation-failed'); }
              if (!stopped) timer = setTimeout(poll, 1000);
            };
            timer = setTimeout(poll, 500);
            return () => { stopped = true; clearTimeout(timer); };
          }, [pending, snapshot.attempt?.id]);
          async function action(body) {
            setBusy(true);
            setFailure('');
            const ticket = ++generation.current;
            try {
              const value = await call(body);
              if (body.action === 'begin' && value.attempt?.status === 'pending') {
                if (!mounted.current) { await call({ action: 'cancel', attemptId: value.attempt.id }); return; }
                ownedAttempt.current = value.attempt.id;
              }
              accept(value, ticket);
              if (mounted.current && value.warning) setFailure(value.warning);
              // A pushed credential event may supersede this response; always reconcile after a write.
              if (mounted.current) await readStatus();
            } catch (error) {
              if (mounted.current) setFailure(error.message);
            } finally { if (mounted.current) setBusy(false); }
          }
          if (provider.provider !== 'power-copilot') return null;
          const disabled = busy || pending;
          const notice = snapshot.attempt?.notice;
          const statusKey = !snapshot.configured ? 'signedOut' : snapshot.credentialSource === 'reference'
            ? 'referenceReady' : snapshot.authType === 'oauth' ? 'signedIn' : 'keyReady';
          const problem = failure || snapshot.attempt?.error;
          const button = (label, onClick, inactive = disabled) => h('button', { type: 'button', disabled: inactive, onClick }, t(label));
          return h('section', { className: 'pc-provider', 'aria-label': 'Power Copilot' },
            h('style', null, css),
            h('p', { role: 'status', 'aria-live': 'polite', className: snapshot.configured ? 'pc-ready' : 'pc-muted' }, t(statusKey)),
            h('div', { className: 'pc-actions' },
              button('github', () => { void action({ action: 'begin', method: 'oauth', enterpriseDomain: domain }); }),
              snapshot.configured ? button('refresh', () => { void action({ action: 'refresh' }); }) : null,
              snapshot.configured ? button('logout', () => { void action({ action: 'logout' }); }) : null,
              busy ? h('span', { className: 'pc-muted', role: 'status' }, t('working')) : null),
            pending ? h('div', { className: 'pc-device' },
              h('p', null, t(notice?.code ? 'deviceInstructions' : snapshot.attempt.method === 'api-key' ? 'working' : 'signingIn')),
              notice?.code ? h('code', null, notice.code) : null,
              notice?.url ? h('a', { href: notice.url, target: '_blank', rel: 'noopener noreferrer' }, t('openGitHub')) : null,
              button('cancel', () => { void action({ action: 'cancel', attemptId: snapshot.attempt.id }); }, busy)) : null,
            snapshot.attempt?.status === 'cancelled' ? h('p', { className: 'pc-muted' }, t('cancelled')) : null,
            h('details', null, h('summary', null, t('apiKey')),
              h('form', { className: 'pc-field', onSubmit: (event) => {
                event.preventDefault();
                const key = apiKey; setApiKey('');
                void action({ action: 'begin', method: 'api-key', apiKey: key });
              } }, h('label', null, t('keyLabel'), h('input', { type: 'password', autoComplete: 'off',
                value: apiKey, disabled, onChange: (event) => setApiKey(event.target.value), required: true })),
              h('div', { className: 'pc-actions' }, h('button', { type: 'submit', disabled: disabled || !apiKey.trim() }, t('saveKey'))))),
            h('details', null, h('summary', null, t('enterprise')),
              h('label', { className: 'pc-field' }, t('domain'), h('input', { type: 'text',
                placeholder: 'github.example.com', value: domain, disabled,
                onChange: (event) => setDomain(event.target.value) }))),
            problem ? h('p', { role: 'alert', className: 'pc-error' }, t(errorKey(problem))) : null);
        }
        let installed = false;
        let booting = false;
        let retries = 0;
        let retryTimer;
        async function bootstrap() {
          if (installed || booting || lifetime.signal.aborted) return;
          clearTimeout(retryTimer);
          booting = true;
          try {
            const value = await call(undefined, lifetime.signal);
            if (lifetime.signal.aborted) return;
            initial = value;
            ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
              name: 'settings.models.provider-card', key: initial.settingsNs,
            }, ProviderCard));
            installed = true;
          } catch {
            if (!lifetime.signal.aborted && retries < 5) {
              // Bounded startup retries cover Host mount ordering and transient HTTP failures.
              retryTimer = setTimeout(() => { void bootstrap(); }, Math.min(250 * 2 ** retries++, 4000));
            } else if (!lifetime.signal.aborted) {
              console.error('Power Copilot provider UI could not connect; waiting for reconnection.');
            }
          } finally { booting = false; }
        }
        const reconnect = () => { retries = 0; void bootstrap(); };
        ctx.on('connection/reset', reconnect);
        ctx.effect(() => ctx.remote.$on('llm/adapters-updated', reconnect));
        ctx.effect(() => () => clearTimeout(retryTimer));
        void bootstrap();
      },
    };
  },
});
